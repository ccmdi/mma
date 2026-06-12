//! Delta-chain version control for map snapshots.
//!
//! Each commit records a single Arrow delta file on disk
//! (`arrow/commits/<map_id>/<commit_id>.arrow`) holding the locations created and
//! removed relative to its parent; SQL's `commits` table only tracks the commit
//! graph. A commit's full state is materialized by replaying its ancestor deltas
//! from genesis forward (see [`crate::vcs_delta`]).

use crate::types::AppResult;
use rusqlite::params;
use tauri::State;

use crate::arrow_bridge;
use crate::storage;
use crate::location_store::StoreState;
use crate::types::Location;
use crate::util::{now_iso, sha256_hex};
use crate::vcs_delta;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Metadata for a single commit, returned to the frontend for the commit history UI.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub map_id: String,
    pub parent_id: Option<String>,
    pub message: Option<String>,
    pub tree_hash: Option<String>,
    pub added: u32,
    pub removed: u32,
    pub modified: u32,
    pub location_count: u32,
    pub created_at: String,
}

/// A commit's delta, returned to the frontend for the per-commit diff viewer.
/// An updated location appears in both `created` (new) and `removed` (old).
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitDelta {
    pub created: Vec<Location>,
    pub removed: Vec<Location>,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Create a new commit for a map.
///
/// 1. Finds the current HEAD commit (parent).
/// 2. Collects the current location state (overlay already baked by the caller).
/// 3. Diffs it against the materialized parent state to produce the delta.
/// 4. Writes the delta as an Arrow file, then records the commit row.
///
/// Returns the new commit ID.
#[tauri::command]
#[specta::specta]
pub fn store_create_commit(
    state: State<'_, StoreState>,
    map_id: String,
    message: Option<String>,
) -> AppResult<String> {
    let _t = std::time::Instant::now();
    let conn = storage::open_db()?;

    // 1. Parent = current HEAD commit.
    let parent_id: Option<String> = conn
        .query_row(
            "SELECT id FROM commits WHERE map_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1",
            params![map_id],
            |row| row.get(0),
        )
        .ok();

    // 2. Build the delta. Fast path: read it straight from the overlay -- the in-memory
    //    changeset since the last commit -- in O(changeset), no history replay. Fall back
    //    to a full parent-vs-current diff only when the overlay is clean (a post-checkout
    //    revert commit, or an empty no-op commit), which is rare and off the hot path.
    // The overlay fast path is only valid when the base file equals the parent commit's
    // state -- i.e. a parent exists. For genesis (no parent, e.g. an old map with
    // pre-existing data and no commits yet) the base is NOT a committed baseline, so we
    // must capture the full current state, not just the overlay changeset.
    let mut overlay_delta: Option<(Vec<Location>, Vec<Location>, u32, u32, u32)> = None;
    let mut current_fallback: Vec<Location> = Vec::new();
    let location_count: u32;
    {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_map(&map_id)?;
        location_count = store.alive_count as u32;
        if parent_id.is_some() && store.overlay.dirty {
            overlay_delta = Some(store.build_overlay_delta());
        } else {
            current_fallback = store.collect_all_locations();
        }
    }
    let (created, removed, added, removed_n, modified) = match overlay_delta {
        Some(d) => d,
        None => {
            let parent_state = match &parent_id {
                Some(p) => vcs_delta::materialize_commit(&conn, &map_id, p)?,
                None => std::collections::BTreeMap::new(),
            };
            vcs_delta::diff_states(&parent_state, &current_fallback)
        }
    };

    // 4. Commit id. A random nonce keeps empty/rapid commits sharing a parent and
    //    millisecond timestamp from colliding on the primary key.
    let now = now_iso();
    let nonce = uuid::Uuid::new_v4();
    let id = sha256_hex(
        format!("{}\n{}\n{}", parent_id.as_deref().unwrap_or(""), now, nonce).as_bytes(),
    );

    // 5. Write the delta file, then record the commit row.
    let batch = arrow_bridge::delta_to_batch(&created, &removed);
    let path = storage::commit_delta_path(&map_id, &id)?;
    storage::write_arrow_ipc(&path, &batch)?;

    conn.execute(
        "INSERT INTO commits (id, map_id, parent_id, message, location_count, created_at, tree_hash, added, removed, modified) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id, map_id, parent_id, message, location_count, now, Option::<String>::None, added, removed_n, modified],
    )?;

    log::info!(
        "[vcs] commit {} locs={} +{} -{} ~{} in {}ms",
        &id[..7],
        location_count,
        added,
        removed_n,
        modified,
        _t.elapsed().as_millis()
    );
    Ok(id)
}

/// Commit + bake in a single pass — the import/autocommit hot path.
///
/// `store_create_commit` followed by `store_bake_and_save` builds the Arrow batch
/// up to three times (collect+diff clones in the genesis fallback, then the bake)
/// and serializes `extra` JSON twice. This builds it ONCE (the bake) and derives the
/// commit delta by reusing the baked columns + an op column. Semantically identical:
/// genesis delta = full state (all created); non-genesis delta = the pre-bake overlay
/// changeset (captured before the bake clears it). Returns the new commit id.
#[tauri::command]
#[specta::specta]
pub fn store_commit_and_bake(
    state: State<'_, StoreState>,
    map_id: String,
    message: Option<String>,
) -> AppResult<String> {
    let _t = std::time::Instant::now();
    let conn = storage::open_db()?;

    let parent_id: Option<String> = conn
        .query_row(
            "SELECT id FROM commits WHERE map_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1",
            params![map_id],
            |row| row.get(0),
        )
        .ok();
    let genesis = parent_id.is_none();

    // Non-genesis delta is a small overlay changeset; genesis writes no separate delta
    // batch (it reuses the base file as a snapshot — see below).
    let (pre_bake, location_count) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_map(&map_id)?;
        let location_count = store.alive_count as u32;

        // The non-genesis overlay delta must be read BEFORE the bake folds it in.
        let pre_bake = if !genesis && store.overlay.dirty {
            Some(store.build_overlay_delta())
        } else {
            None
        };

        // Build the canonical full batch ONCE (bake), write the base, re-mmap, flush tags.
        crate::location_store::bake_and_save_inner(store, &map_id)?;

        store.edits.undo.clear();
        store.edits.redo.clear();

        (pre_bake, location_count)
    };

    let now = now_iso();
    let nonce = uuid::Uuid::new_v4();
    let id = sha256_hex(
        format!("{}\n{}\n{}", parent_id.as_deref().unwrap_or(""), now, nonce).as_bytes(),
    );

    let path = storage::commit_delta_path(&map_id, &id)?;
    let (added, removed_n, modified) = match pre_bake {
        Some((created, removed, a, r, m)) => {
            storage::write_arrow_ipc(&path, &arrow_bridge::delta_to_batch(&created, &removed))?;
            (a, r, m)
        }
        None => {
            // Genesis: the commit's full state == the base file we just wrote. Store the
            // delta as a snapshot by copying the base (one serialization, not two);
            // batch_to_delta reads a 12-column snapshot as all-created.
            let base_path = storage::arrow_path(&map_id)?;
            std::fs::copy(&base_path, &path)?;
            (location_count, 0, 0)
        }
    };

    conn.execute(
        "INSERT INTO commits (id, map_id, parent_id, message, location_count, created_at, tree_hash, added, removed, modified) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id, map_id, parent_id, message, location_count, now, Option::<String>::None, added, removed_n, modified],
    )?;
    conn.execute(
        "UPDATE maps SET location_count = ?1 WHERE id = ?2",
        params![location_count, map_id],
    )?;

    log::info!(
        "[vcs] commit+bake {} locs={} +{} -{} ~{} in {}ms",
        &id[..7], location_count, added, removed_n, modified, _t.elapsed().as_millis()
    );
    Ok(id)
}

/// List all commits for a map, newest first.
#[tauri::command]
#[specta::specta]
pub fn store_list_commits(
    map_id: String,
) -> AppResult<Vec<CommitInfo>> {
    let conn = storage::open_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, map_id, parent_id, message, tree_hash, added, removed, modified, location_count, created_at FROM commits WHERE map_id = ?1 ORDER BY created_at DESC, rowid DESC",
        )?;

    let rows = stmt
        .query_map(params![map_id], |row| {
            Ok(CommitInfo {
                id: row.get(0)?,
                map_id: row.get(1)?,
                parent_id: row.get(2)?,
                message: row.get(3)?,
                tree_hash: row.get(4)?,
                added: row.get(5)?,
                removed: row.get(6)?,
                modified: row.get(7)?,
                location_count: row.get(8)?,
                created_at: row.get(9)?,
            })
        })?;

    let mut commits = Vec::new();
    for row in rows {
        commits.push(row?);
    }
    Ok(commits)
}

/// Restore a map to the state captured by a previous commit.
///
/// Materializes the commit's full state by replaying its ancestor deltas, writes
/// it as the map's base Arrow file, and clears the uncommitted delta. The caller
/// (`checkoutCommit` in JS) reopens the map and clears undo/redo.
#[tauri::command]
#[specta::specta]
pub fn store_checkout_commit(
    map_id: String,
    commit_id: String,
) -> AppResult<()> {
    let conn = storage::open_db()?;
    let materialized = vcs_delta::materialize_commit(&conn, &map_id, &commit_id)?;
    // BTreeMap yields ascending id order, satisfying the sorted-id invariant the
    // base batch requires.
    let locs: Vec<Location> = materialized.into_values().collect();
    let batch = arrow_bridge::locations_to_batch(&locs);

    let path = storage::arrow_path(&map_id)?;
    storage::write_arrow_ipc(&path, &batch)?;
    let delta = storage::arrow_delta_path(&map_id)?;
    let _ = std::fs::remove_file(delta);

    log::info!(
        "[vcs] checkout {} on map {} ({} locs)",
        &commit_id[..7.min(commit_id.len())],
        map_id,
        locs.len()
    );
    Ok(())
}

/// Read a single commit's delta (created/removed locations) for the diff viewer.
#[tauri::command]
#[specta::specta]
pub fn store_get_commit_delta(
    map_id: String,
    commit_id: String,
) -> AppResult<CommitDelta> {
    let path = storage::commit_delta_path(&map_id, &commit_id)?;
    let batch = storage::read_arrow_ipc(&path)?;
    let (created, removed) = arrow_bridge::batch_to_delta(&batch);
    Ok(CommitDelta { created, removed })
}
