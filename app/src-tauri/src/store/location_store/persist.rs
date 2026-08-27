//! Everything that touches disk or SQLite for an open store: Arrow snapshots, msgpack deltas, edit history, the tag registry.

use super::*;
use crate::store::arrow_bridge;
use crate::store::storage;
use crate::types::{AppError, AppResult};
use crate::types::{Location, Tag};
use crate::util;
use arrow_array::RecordBatch;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::Instant;

/// Result of `store_save_dirty`: bytes written to the delta sidecar (0 = skipped).
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub saved_bytes: usize,
}

/// Load the uncommitted-delta sidecar. An unreadable delta is set aside as a
/// `.corrupt` sibling - never left in place where the next autosave would
/// overwrite it - and the user is warned via a `store-warning` event.
pub(crate) fn load_delta(delta_path: &Path) -> Option<Overlay> {
    if !delta_path.exists() {
        return None;
    }
    let parsed = fs::read(delta_path)
        .map_err(|e| e.to_string())
        .and_then(|d| rmp_serde::from_slice::<Overlay>(&d).map_err(|e| e.to_string()));
    match parsed {
        Ok(p) => Some(p),
        Err(e) => {
            let kept = delta_path.with_extension("corrupt");
            let _ = fs::remove_file(&kept);
            let moved = fs::rename(delta_path, &kept).is_ok();
            log::error!(
                "[store_open] unreadable delta ({e}), set aside (moved={moved}) at {kept:?}"
            );
            crate::emit_event(StoreWarning(
                "Uncommitted changes could not be read and were set aside as a .corrupt file. The map opened from its last committed state.".into(),
            ));
            None
        }
    }
}

pub(crate) fn flush_closed_store(map_id: &str, store: &Store) -> AppResult<()> {
    {
        if store.overlay.dirty {
            // Persist uncommitted edits to the delta sidecar. The base file stays pinned
            // at the last committed state -- it only advances on commit/checkout -- so the
            // overlay remains a faithful changeset-since-last-commit for the next commit.
            let bytes = overlay_delta_bytes(store)?;
            let path = storage::arrow_delta_path(map_id)?;
            storage::atomic_write(&path, |mut file| {
                use std::io::Write;
                file.write_all(&bytes).map_err(AppError::from)
            })?;
        }
        let count = store.alive_count;
        let conn = storage::open_db()?;
        storage::set_location_count(&conn, map_id, count)?;
        if store.tags.dirty {
            write_tags_json(&conn, map_id, &store.tags.all)?;
        }
        save_edit_history(map_id, &store.edits.undo, &store.edits.redo)?;
        log::debug!(
            "[close_map] {map_id} flushed: undo={} redo={}",
            store.edits.undo.len(),
            store.edits.redo.len()
        );
    }
    Ok(())
}

/// Msgpack-serialize the overlay (uncommitted changes) for the `.delta` sidecar.
/// This is what lets the base file stay pinned at the last commit: on next
/// `store_open_map` the blob is loaded straight back into the overlay, and a commit
/// bakes it into the base and deletes the file.
pub(crate) fn overlay_delta_bytes(store: &Store) -> AppResult<Vec<u8>> {
    rmp_serde::to_vec_named(&store.overlay).map_err(AppError::from)
}

/// Read a map's full current state from disk = base file + uncommitted delta sidecar.
/// Use this for consumers (e.g. export) that read a map's locations directly off disk,
/// since the base file alone is only the last committed state.
pub(crate) fn read_full_state_from_disk(map_id: &str) -> AppResult<Vec<Location>> {
    let path = storage::arrow_path(map_id)?;
    // The base file may not exist for a map with no commits -- its data then lives entirely
    // in the delta sidecar, so always apply the delta below regardless.
    let mut locs = if path.exists() {
        arrow_bridge::batch_to_locations(&storage::read_arrow_ipc(&path)?)
    } else {
        Vec::new()
    };

    let delta_path = storage::arrow_delta_path(map_id)?;
    if delta_path.exists() {
        if let Ok(data) = fs::read(&delta_path) {
            if let Ok(delta) = rmp_serde::from_slice::<Overlay>(&data) {
                delta.apply_to(&mut locs);
            }
        }
    }
    Ok(locs)
}

/// Write a map's dirty state: delta sidecar (if any), location count, and tags
/// JSON (if any). Sync core shared by `store_save_dirty` and cross-map copy.
pub(crate) fn persist_dirty(
    map_id: &str,
    delta_data: Option<Vec<u8>>,
    alive: usize,
    tags_json: Option<String>,
) -> AppResult<()> {
    if let Some(delta_data) = delta_data {
        let path = storage::arrow_delta_path(map_id)?;
        storage::atomic_write(&path, |mut file| {
            use std::io::Write;
            file.write_all(&delta_data).map_err(AppError::from)
        })?;
    }
    let conn = storage::open_db()?;
    storage::set_location_count(&conn, map_id, alive)?;
    if let Some(tags_json) = tags_json {
        conn.execute(
            "UPDATE maps SET tags = ?1 WHERE id = ?2",
            rusqlite::params![tags_json, map_id],
        )?;
    }
    Ok(())
}

/// Persist undo/redo stacks to SQLite as msgpack blobs, capped at MAX_UNDO_ENTRIES.
pub(super) fn save_edit_history(
    map_id: &str,
    undo: &[EditEntry],
    redo: &[EditEntry],
) -> AppResult<()> {
    let conn = storage::open_db()?;
    let undo_capped = if undo.len() > MAX_UNDO_ENTRIES {
        &undo[undo.len() - MAX_UNDO_ENTRIES..]
    } else {
        undo
    };
    let redo_capped = if redo.len() > MAX_UNDO_ENTRIES {
        &redo[redo.len() - MAX_UNDO_ENTRIES..]
    } else {
        redo
    };
    let undo_bytes = rmp_serde::to_vec_named(undo_capped)?;
    let redo_bytes = rmp_serde::to_vec_named(redo_capped)?;
    conn.execute(
        "INSERT OR REPLACE INTO edit_history (map_id, undo_stack, redo_stack) VALUES (?1, ?2, ?3)",
        rusqlite::params![map_id, undo_bytes, redo_bytes],
    )?;
    Ok(())
}

/// Highest location id referenced anywhere in the undo/redo stacks. Used to seed
/// `next_id` on map open so undo/redo replay can never collide with a fresh allocation.
pub(crate) fn history_max_id(undo: &[EditEntry], redo: &[EditEntry]) -> u32 {
    undo.iter()
        .chain(redo.iter())
        .flat_map(|e| e.created.iter().chain(e.removed.iter()))
        .map(|l| l.id)
        .max()
        .unwrap_or(0)
}

/// Open-time `next_id` seed. Must exceed every id the system can re-materialize:
/// base rows, uncommitted overlay adds, and ids replayable from persisted undo/redo
/// (replay resurrects locations with their original ids; re-allocating one would
/// create a duplicate and break the strictly-sorted bake invariant).
pub(crate) fn seed_next_id(
    base_max: u32,
    adds: &[Location],
    undo: &[EditEntry],
    redo: &[EditEntry],
) -> u32 {
    let max_add = adds.iter().map(|l| l.id).max().unwrap_or(0);
    base_max.max(max_add).max(history_max_id(undo, redo)) + 1
}

/// Load undo/redo stacks from SQLite. Returns empty stacks if no history exists.
pub(crate) fn load_edit_history(map_id: &str) -> AppResult<(Vec<EditEntry>, Vec<EditEntry>)> {
    let conn = storage::open_db()?;
    let result = conn.query_row(
        "SELECT undo_stack, redo_stack FROM edit_history WHERE map_id = ?1",
        [map_id],
        |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?)),
    );
    match result {
        Ok((undo_bytes, redo_bytes)) => {
            let undo: Vec<EditEntry> = rmp_serde::from_slice(&undo_bytes).unwrap_or_else(|e| {
                log::warn!("[load_edit_history] {map_id} undo stack deserialize failed: {e}");
                Vec::new()
            });
            let redo: Vec<EditEntry> = rmp_serde::from_slice(&redo_bytes).unwrap_or_else(|e| {
                log::warn!("[load_edit_history] {map_id} redo stack deserialize failed: {e}");
                Vec::new()
            });
            log::debug!(
                "[load_edit_history] {map_id} loaded: undo={} redo={}",
                undo.len(),
                redo.len()
            );
            Ok((undo, redo))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            log::debug!("[load_edit_history] {map_id} no row");
            Ok((Vec::new(), Vec::new()))
        }
        Err(e) => Err(e.into()),
    }
}

/// Write the current batch to disk as Arrow IPC and remove any stale delta file.
pub(crate) fn save_arrow(store: &Store, map_id: &str) -> AppResult<()> {
    if let Some(ref batch) = store.batch {
        let path = storage::arrow_path(map_id)?;
        storage::write_arrow_ipc(&path, batch)?;
        let delta = storage::arrow_delta_path(map_id)?;
        let _ = fs::remove_file(delta);
    }
    Ok(())
}

/// Bake the overlay into the base batch, write it to disk, re-mmap, and flush
/// location count + dirty tags. Used by `store_commit` so a commit builds
/// the batch only once.
pub(crate) fn bake_and_save(store: &mut Store, map_id: &str) -> AppResult<()> {
    let _t = Instant::now();
    store.bake_overlay();
    let t_bake = _t.elapsed();
    store.mmap_handle = None;
    save_arrow(store, map_id)?;
    let t_write = _t.elapsed();
    let path = storage::arrow_path(map_id)?;
    if path.exists() {
        let (batch, handle) = storage::read_arrow_ipc_mmap(&path)?;
        store.batch = Some(batch);
        store.mmap_handle = Some(handle);
    }
    let t_mmap = _t.elapsed();
    log::debug!(
        "[bake_and_save] bake={:.0}ms base-write={:.0}ms remmap={:.0}ms total={:.0}ms",
        t_bake.as_millis(),
        (t_write - t_bake).as_millis(),
        (t_mmap - t_write).as_millis(),
        _t.elapsed().as_millis()
    );
    let count = store.batch.as_ref().map_or(0, RecordBatch::num_rows);
    let conn = storage::open_db()?;
    storage::set_location_count(&conn, map_id, count)?;
    if store.tags.dirty {
        write_tags_json(&conn, map_id, &store.tags.all)?;
        store.tags.dirty = false;
    }
    Ok(())
}

/// Load tags from the SQLite `maps.tags` JSON column, keyed by string ID.
pub(crate) fn read_tags_json(conn: &rusqlite::Connection, map_id: &str) -> HashMap<u32, Tag> {
    let json: String = conn
        .query_row("SELECT tags FROM maps WHERE id = ?1", [map_id], |row| {
            row.get(0)
        })
        .unwrap_or_else(|_| "{}".into());
    let raw: HashMap<String, Tag> = serde_json::from_str(&json).unwrap_or_default();
    raw.into_iter()
        .filter_map(|(k, v)| k.parse::<u32>().ok().map(|id| (id, v)))
        .collect()
}

/// Reconcile the persisted tag registry against a location scan (map open): every
/// tag the scan found must exist and be visible -- commit checkout restores locations
/// without reviving their soft-deleted tags, so a counted/invisible pair is always a
/// desync. Returns (max tag id, whether any tag was revived and needs persisting).
pub(crate) fn reconcile_tag_registry(
    tags: &mut HashMap<u32, Tag>,
    tag_counts: &HashMap<u32, usize>,
) -> (u32, bool) {
    let mut max_tag_id: u32 = tags.keys().max().copied().unwrap_or(0);
    let mut healed = false;
    for &tid in tag_counts.keys() {
        max_tag_id = max_tag_id.max(tid);
        let tag = tags.entry(tid).or_insert_with(|| Tag {
            id: tid,
            name: format!("Tag {tid}"),
            color: util::color_for_name(&format!("Tag {tid}")),
            visible: true,
            order: None,
            doclinks: Vec::new(),
        });
        healed |= !tag.visible;
        tag.visible = true;
    }
    (max_tag_id, healed)
}

/// Serialize tags to JSON with string keys (SQLite stores them this way).
pub(crate) fn serialize_tags_json(tags: &HashMap<u32, Tag>) -> String {
    let as_str_keys: HashMap<String, &Tag> = tags.iter().map(|(k, v)| (k.to_string(), v)).collect();
    serde_json::to_string(&as_str_keys).unwrap_or_default()
}

/// Persist tags to the SQLite `maps.tags` JSON column.
pub(crate) fn write_tags_json(
    conn: &rusqlite::Connection,
    map_id: &str,
    tags: &HashMap<u32, Tag>,
) -> AppResult<()> {
    let json = serialize_tags_json(tags);
    conn.execute(
        "UPDATE maps SET tags = ?1 WHERE id = ?2",
        rusqlite::params![json, map_id],
    )?;
    Ok(())
}
