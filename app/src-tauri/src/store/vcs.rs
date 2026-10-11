//! Delta-chain version control for map snapshots.
//!
//! Each commit records a single Arrow delta file on disk
//! (`arrow/commits/<map_id>/<commit_id>.arrow`) holding the locations created and
//! removed relative to its parent; SQL's `commits` table only tracks the commit
//! graph. A commit's full state is materialized by replaying its ancestor deltas
//! from genesis forward (see [`crate::store::vcs::delta`]).

use crate::store::maps::MapMeta;
use crate::types::{AppError, AppResult, Location};
use rusqlite::params;
use tauri::State;

pub(crate) mod delta;

use crate::selections::Selector;
use crate::store::engine::{StoreManager, StoreState};
use crate::store::{arrow, engine, storage};
use crate::util::{now_iso, sha256_hex};
use mma_algebra::{Change, Counts, Id};
use std::fs;
use std::path::Path;
use std::time::Instant;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Metadata for a single commit.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: Id<CommitInfo, String>,
    pub map_id: Id<MapMeta, String>,
    pub parent_id: Option<Id<CommitInfo, String>>,
    pub message: Option<String>,
    pub tree_hash: Option<String>,
    #[serde(flatten)]
    pub diff: Counts,
    pub location_count: u32,
    pub created_at: String,
}

/// The new commit's ID and the resulting state update.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub id: Id<CommitInfo, String>,
    pub status: engine::Mutation,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Commit the map's uncommitted changes. Returns the new commit ID. Clears undo/redo.
// The only commit path: builds the canonical batch ONCE (the bake) and derives the commit
// delta three ways -- dirty overlay: the pre-bake changeset, O(changeset); genesis (no
// parent): a copy of the base just written (batch_to_delta reads it as all-created); clean
// overlay with a parent (checkout/revert): diff baked state against the materialized parent.
// async so the heavy bake/VCS work runs on a runtime worker -- a sync command here freezes
// the webview and stalls the queued render behind it.
#[tauri::command]
#[specta::specta]
pub async fn store_commit(
    state: State<'_, StoreState>,
    map_id: Id<MapMeta, String>,
    message: Option<String>,
) -> AppResult<CommitResult> {
    let _t = Instant::now();
    let files = state.lock()?.store_for_map(&map_id)?.files.clone();
    let _writing = files.lock().await;
    let conn = storage::open_db()?;

    let parent_id: Option<Id<CommitInfo, String>> = conn
        .query_row(
            "SELECT id FROM commits WHERE map_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1",
            params![map_id.raw()],
            |row| row.get::<_, String>(0).map(Id::new),
        )
        .ok();
    let genesis = parent_id.is_none();

    let (pre_bake, current_fallback, location_count, status) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_map(&map_id)?;
        let location_count = *store.alive_count as u32;

        // Read the changeset before the bake folds it in; a saved overlay still holds it.
        let pre_bake = if !genesis && !store.overlay.is_empty() {
            Some((
                store.overlay.to_delta(store.batch.as_ref()),
                store.overlay_diff_counts(),
            ))
        } else {
            None
        };

        // Build the canonical full batch ONCE (bake), write the base, re-mmap, flush tags.
        engine::bake_and_save(store, &map_id)?;

        store.edits.edit().clear();
        engine::save_edit_history(&conn, &map_id, &store.edits)?;
        store.edits.mark_saved();

        // Clean overlay + existing parent (checkout/revert commit): capture the current
        // baked state to diff against the parent below.
        let current_fallback = if pre_bake.is_none() && !genesis {
            store.collect(&crate::store::engine::Target::Map, &Selector::Everything)
        } else {
            Vec::new()
        };

        store.resolve_selection_membership();
        let status = store.finish_selection_change();
        (pre_bake, current_fallback, location_count, status)
    };
    let t_bake = _t.elapsed();

    let now = now_iso();
    let nonce = uuid::Uuid::new_v4();
    let id = Id::new(sha256_hex(
        format!(
            "{}\n{}\n{}",
            parent_id.as_ref().map(|id| id.raw().as_str()).unwrap_or(""),
            now,
            nonce
        )
        .as_bytes(),
    ));

    let path = storage::commit_delta_path(&map_id, &id)?;
    let counts = match pre_bake {
        Some((delta, counts)) => {
            arrow::write_arrow_ipc(&path, &delta)?;
            counts
        }
        None if genesis => {
            // The commit's full state == the base file we just wrote. Store the delta as a
            // snapshot by copying the base (one serialization, not two); batch_to_delta
            // reads a 12-column snapshot as all-created.
            let base_path = storage::arrow_path(&map_id)?;
            storage::atomic_copy(&base_path, &path)?;
            Counts {
                added: location_count,
                ..Counts::default()
            }
        }
        None => {
            // Clean overlay with a parent (revert/no-op commit): diff current vs parent.
            let parent_state =
                delta::materialize_commit(&conn, &map_id, parent_id.as_ref().unwrap())?;
            let change = delta::diff_states(&parent_state, &current_fallback);
            let (created, removed) = change.sides();
            arrow::write_arrow_ipc(&path, &arrow::delta_to_batch(&created, &removed))?;
            change.counts()
        }
    };

    let t_delta = _t.elapsed();

    conn.execute(
        "INSERT INTO commits (id, map_id, parent_id, message, location_count, created_at, tree_hash, added, removed, modified) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id.raw(), map_id.raw(), parent_id.as_ref().map(Id::raw), message, location_count, now, Option::<String>::None, counts.added, counts.removed, counts.updated],
    )?;
    storage::set_map_counts(&conn, &map_id, location_count as usize, Counts::default())?;

    log::info!(
        "[vcs] commit {} locs={} +{} -{} ~{} in {}ms (bake+base-write={:.0}ms delta-write={:.0}ms sqlite={:.0}ms genesis={})",
        &id.raw()[..7], location_count, counts.added, counts.removed, counts.updated, _t.elapsed().as_millis(),
        t_bake.as_millis(), (t_delta - t_bake).as_millis(), (_t.elapsed() - t_delta).as_millis(), genesis
    );
    Ok(CommitResult { id, status })
}

/// List all commits for a map, newest first.
#[tauri::command]
#[specta::specta]
pub async fn store_list_commits(map_id: Id<MapMeta, String>) -> AppResult<Vec<CommitInfo>> {
    storage::with_db(move |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, map_id, parent_id, message, tree_hash, added, removed, modified, location_count, created_at FROM commits WHERE map_id = ?1 ORDER BY created_at DESC, rowid DESC",
            )?;

        let rows = stmt.query_map(params![map_id.raw()], |row| {
            Ok(CommitInfo {
                id: Id::new(row.get(0)?),
                map_id: Id::new(row.get(1)?),
                parent_id: row.get::<_, Option<String>>(2)?.map(Id::new),
                message: row.get(3)?,
                tree_hash: row.get(4)?,
                diff: Counts {
                    added: row.get(5)?,
                    removed: row.get(6)?,
                    updated: row.get(7)?,
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
    })
    .await
}

/// Restore a map to a previous commit. An open map changes through its normal write path.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
#[specta::specta]
pub fn store_checkout_commit(
    label: engine::WindowLabel,
    state: State<'_, StoreState>,
    map_id: Id<MapMeta, String>,
    commit_id: Id<CommitInfo, String>,
) -> AppResult<engine::MutationResult> {
    let conn = storage::open_db()?;
    let materialized = delta::materialize_commit(&conn, &map_id, &commit_id)?;
    // BTreeMap yields ascending id order, satisfying the sorted-id invariant the
    // base batch requires.
    let locs: Vec<Location> = materialized.into_values().collect();

    let mut mgr = state.lock()?;
    if mgr
        .window_map
        .iter()
        .any(|(window, map)| map == &map_id && window != &label)
    {
        return Err(AppError(
            "close this map in every other window before restoring a version".into(),
        ));
    }
    if let Some(store) = mgr.stores.get_mut(&map_id) {
        return Ok(restore_rows(store, locs));
    }
    write_checkout(
        &mgr,
        &map_id,
        &locs,
        &storage::arrow_path(&map_id)?,
        &storage::arrow_delta_path(&map_id)?,
    )?;

    log::info!(
        "[vcs] checkout {} on map {} ({} locs)",
        &commit_id.raw()[..7.min(commit_id.raw().len())],
        map_id,
        locs.len()
    );
    Ok(engine::MutationResult {
        mutation: engine::Mutation {
            version: 0,
            keys: vec![],
        },
    })
}

fn restore_rows(store: &mut engine::Store, locs: Vec<Location>) -> engine::MutationResult {
    let current = store.collect(&engine::Target::Map, &Selector::Everything);
    store.next_id = store.next_id.max(Id::new(
        locs.iter()
            .map(|row| row.id.get())
            .max()
            .unwrap_or(0)
            .saturating_add(1),
    ));
    let before = store.selections.table();
    let selections = Change::at(&before, &Default::default(), before.keys().cloned());
    store.pending.clear();
    let edits = current
        .into_iter()
        .map(|row| mma_algebra::Op::Remove(row.id))
        .chain(locs.into_iter().map(mma_algebra::Op::Set));
    let mutation = store.write(
        edits,
        &mut None,
        engine::Entry {
            selections,
            ..Default::default()
        },
    );
    engine::MutationResult { mutation }
}

/// Replace a closed map's base with `locs` and drop its uncommitted delta.
fn write_checkout(
    mgr: &StoreManager,
    map_id: &Id<MapMeta, String>,
    locs: &[Location],
    base: &Path,
    delta: &Path,
) -> AppResult<()> {
    // window_map covers an open still in flight, whose store lands only when it finishes.
    if mgr.stores.contains_key(map_id) || mgr.window_map.values().any(|v| v == map_id) {
        return Err(AppError(
            "close this map in every other window before restoring a version".into(),
        ));
    }
    arrow::write_arrow_ipc(base, &arrow::locations_to_batch(locs))?;
    let _ = fs::remove_file(delta);
    Ok(())
}

pub(crate) fn read_commit_delta(
    map_id: &Id<MapMeta, String>,
    commit_id: &Id<CommitInfo, String>,
) -> AppResult<(Vec<Location>, Vec<Location>)> {
    let path = storage::commit_delta_path(map_id, commit_id)?;
    let batch = arrow::read_arrow_ipc(&path)?;
    Ok(arrow::batch_to_delta(&batch))
}

/// Read a single commit's change: the locations it added, removed and updated.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
#[specta::specta]
pub fn store_get_commit_delta(
    map_id: Id<MapMeta, String>,
    commit_id: Id<CommitInfo, String>,
) -> AppResult<engine::Change> {
    let (created, removed) = read_commit_delta(&map_id, &commit_id)?;
    Ok(engine::Change::from_sides(created, removed))
}

#[cfg(test)]
#[path = "vcs.test.rs"]
mod tests;
