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
use crate::location_store::StoreState;
use crate::storage;
use crate::types::Location;
use crate::util::{now_iso, sha256_hex};
use crate::vcs_delta;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitDiff {
    pub added: u32,
    pub removed: u32,
    pub modified: u32,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub map_id: String,
    pub parent_id: Option<String>,
    pub message: Option<String>,
    pub tree_hash: Option<String>,
    #[serde(flatten)]
    pub diff: CommitDiff,
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

/// Build a default commit message (`+a -r ~m`) from the diff counts; None when empty.
fn format_diff_message(added: u32, removed: u32, modified: u32) -> Option<String> {
    let mut parts = Vec::new();
    if added > 0 {
        parts.push(format!("+{added}"));
    }
    if removed > 0 {
        parts.push(format!("-{removed}"));
    }
    if modified > 0 {
        parts.push(format!("~{modified}"));
    }
    (!parts.is_empty()).then(|| parts.join(" "))
}

/// Create a commit and bake the overlay in a single pass — the only commit path.
///
/// Builds the canonical batch ONCE (the bake) and derives the commit delta three ways:
/// - dirty overlay (normal commit/import): the pre-bake overlay changeset, O(changeset).
/// - genesis (no parent): full state == the base file just written; stored by copying
///   the base (one serialization, not two; batch_to_delta reads it as all-created).
/// - clean overlay with a parent (a checkout/revert commit): diff the current baked
///   state against the materialized parent.
/// `message` is auto-formatted (`+a -r ~m`) when None. Returns the new commit id.
///
/// `async` so the heavy bake/VCS work runs on a runtime worker, not the main
/// (event-loop) thread — a sync command here freezes the webview and stalls the
/// queued render behind it.
#[tauri::command]
#[specta::specta]
pub async fn store_commit(
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

    let (pre_bake, current_fallback, location_count) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_map(&map_id)?;
        let location_count = store.alive_count as u32;

        // The overlay changeset must be read BEFORE the bake folds it in. Emptiness,
        // not `dirty`: an autosaved overlay is clean but still holds the changeset.
        let pre_bake = if !genesis && !store.overlay.is_empty() {
            Some(store.build_overlay_delta())
        } else {
            None
        };

        // Build the canonical full batch ONCE (bake), write the base, re-mmap, flush tags.
        crate::location_store::bake_and_save_inner(store, &map_id)?;

        store.edits.undo.clear();
        store.edits.redo.clear();

        // Clean overlay + existing parent (checkout/revert commit): capture the current
        // baked state to diff against the parent below.
        let current_fallback = if pre_bake.is_none() && !genesis {
            store.collect_all_locations()
        } else {
            Vec::new()
        };

        (pre_bake, current_fallback, location_count)
    };
    let t_bake = _t.elapsed();

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
        None if genesis => {
            // The commit's full state == the base file we just wrote. Store the delta as a
            // snapshot by copying the base (one serialization, not two); batch_to_delta
            // reads a 12-column snapshot as all-created.
            let base_path = storage::arrow_path(&map_id)?;
            std::fs::copy(&base_path, &path)?;
            (location_count, 0, 0)
        }
        None => {
            // Clean overlay with a parent (revert/no-op commit): diff current vs parent.
            let parent_state =
                vcs_delta::materialize_commit(&conn, &map_id, parent_id.as_ref().unwrap())?;
            let (created, removed, a, r, m) =
                vcs_delta::diff_states(&parent_state, &current_fallback);
            storage::write_arrow_ipc(&path, &arrow_bridge::delta_to_batch(&created, &removed))?;
            (a, r, m)
        }
    };

    let t_delta = _t.elapsed();

    // Auto-format a default message when the caller didn't supply one.
    let message = message.or_else(|| format_diff_message(added, removed_n, modified));

    conn.execute(
        "INSERT INTO commits (id, map_id, parent_id, message, location_count, created_at, tree_hash, added, removed, modified) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id, map_id, parent_id, message, location_count, now, Option::<String>::None, added, removed_n, modified],
    )?;
    conn.execute(
        "UPDATE maps SET location_count = ?1 WHERE id = ?2",
        params![location_count, map_id],
    )?;

    log::info!(
        "[vcs] commit {} locs={} +{} -{} ~{} in {}ms (bake+base-write={:.0}ms delta-write={:.0}ms sqlite={:.0}ms genesis={})",
        &id[..7], location_count, added, removed_n, modified, _t.elapsed().as_millis(),
        t_bake.as_millis(), (t_delta - t_bake).as_millis(), (_t.elapsed() - t_delta).as_millis(), genesis
    );
    Ok(id)
}

/// List all commits for a map, newest first.
#[tauri::command]
#[specta::specta]
pub fn store_list_commits(map_id: String) -> AppResult<Vec<CommitInfo>> {
    let conn = storage::open_db()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, map_id, parent_id, message, tree_hash, added, removed, modified, location_count, created_at FROM commits WHERE map_id = ?1 ORDER BY created_at DESC, rowid DESC",
        )?;

    let rows = stmt.query_map(params![map_id], |row| {
        Ok(CommitInfo {
            id: row.get(0)?,
            map_id: row.get(1)?,
            parent_id: row.get(2)?,
            message: row.get(3)?,
            tree_hash: row.get(4)?,
            diff: CommitDiff {
                added: row.get(5)?,
                removed: row.get(6)?,
                modified: row.get(7)?,
            },
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
pub fn store_checkout_commit(map_id: String, commit_id: String) -> AppResult<()> {
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
pub fn store_get_commit_delta(map_id: String, commit_id: String) -> AppResult<CommitDelta> {
    let path = storage::commit_delta_path(&map_id, &commit_id)?;
    let batch = storage::read_arrow_ipc(&path)?;
    let (created, removed) = arrow_bridge::batch_to_delta(&batch);
    Ok(CommitDelta { created, removed })
}
