//! Everything that touches disk or SQLite for an open store: Arrow snapshots, msgpack deltas, edit history, tag display metadata.

use super::*;
use crate::store::arrow;
use crate::store::storage;
use crate::types::Location;
use crate::types::{AppError, AppResult};
use arrow_array::RecordBatch;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::Instant;

/// Bytes written by a save; 0 when there was nothing to save.
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
            crate::emit_event(StoreWarning::DeltaSetAside);
            None
        }
    }
}

pub(crate) fn flush_closed_store(map_id: &str, store: &Store) -> AppResult<()> {
    {
        if store.overlay.is_unsaved() {
            // Persist uncommitted edits to the delta sidecar. The base file stays pinned
            // at the last committed state -- it only advances on commit/checkout -- so the
            // overlay remains a faithful changeset-since-last-commit for the next commit.
            let bytes = overlay_delta_bytes(&store.overlay)?;
            let path = storage::arrow_delta_path(map_id)?;
            storage::atomic_write_bytes(&path, &bytes)?;
        }
        let count = *store.alive_count;
        let conn = storage::open_db()?;
        storage::set_location_count(&conn, map_id, count)?;
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
pub(crate) fn overlay_delta_bytes(overlay: &Overlay) -> AppResult<Vec<u8>> {
    rmp_serde::to_vec_named(overlay).map_err(AppError::from)
}

/// Read a map's full current state from disk = base file + uncommitted delta sidecar.
/// Use this for consumers (e.g. export) that read a map's locations directly off disk,
/// since the base file alone is only the last committed state.
pub(crate) fn read_full_state_from_disk(map_id: &str) -> AppResult<Vec<Location>> {
    let path = storage::arrow_path(map_id)?;
    // The base file may not exist for a map with no commits -- its data then lives entirely
    // in the delta sidecar, so always apply the delta below regardless.
    let mut locs = if path.exists() {
        arrow::batch_to_locations(&arrow::read_arrow_ipc(&path)?)
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
        storage::atomic_write_bytes(&path, &delta_data)?;
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
        arrow::write_arrow_ipc(&path, batch)?;
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
        let (batch, handle) = arrow::read_arrow_ipc_mmap(&path)?;
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
    Ok(())
}

// ---------------------------------------------------------------------------
// Tag value records: the `maps.tags` JSON column
// ---------------------------------------------------------------------------
// The disk home of the `tags` field's interned-value records (`values.rs`). The engine's
// data-side tag concept is only the id-list column on locations; the piles live here.
// The format is the legacy per-tag object (`{"<id>": {name, color, ...}}`), so old maps
// read as-is; `id` and `visible` inside the objects are legacy keys - identity is the
// map key and visibility is derived - stripped on read, `id` re-injected on write so
// older builds still parse the column.

/// Load the tag records from the SQLite `maps.tags` JSON column.
pub(crate) fn read_tags_json(
    conn: &rusqlite::Connection,
    map_id: &str,
) -> HashMap<u32, ValueRecord> {
    let json: String = conn
        .query_row("SELECT tags FROM maps WHERE id = ?1", [map_id], |row| {
            row.get(0)
        })
        .unwrap_or_else(|_| "{}".into());
    let raw: HashMap<String, ValueRecord> = serde_json::from_str(&json).unwrap_or_default();
    raw.into_iter()
        .filter_map(|(k, mut rec)| {
            rec.remove("id");
            rec.remove("visible");
            k.parse::<u32>().ok().map(|id| (id, rec))
        })
        .collect()
}

/// Serialize tag records to JSON with string keys (SQLite stores them this way).
pub(crate) fn serialize_tags_json(tags: &HashMap<u32, ValueRecord>) -> String {
    let as_str_keys: HashMap<String, ValueRecord> = tags
        .iter()
        .map(|(k, v)| {
            let mut rec = v.clone();
            rec.insert("id".into(), (*k).into());
            (k.to_string(), rec)
        })
        .collect();
    serde_json::to_string(&as_str_keys).unwrap_or_default()
}

/// Persist tag records to the SQLite `maps.tags` JSON column.
pub(crate) fn write_tags_json(
    conn: &rusqlite::Connection,
    map_id: &str,
    tags: &HashMap<u32, ValueRecord>,
) -> AppResult<()> {
    let json = serialize_tags_json(tags);
    conn.execute(
        "UPDATE maps SET tags = ?1 WHERE id = ?2",
        rusqlite::params![json, map_id],
    )?;
    Ok(())
}
