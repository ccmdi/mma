//! Everything that touches disk or SQLite for an open store: Arrow snapshots, the uncommitted delta, edit history, tag display metadata.

use super::*;
use crate::store::arrow;
use crate::store::storage;
use crate::types::Location;
use crate::types::{AppError, AppResult};
use arrow_array::RecordBatch;
use mma_algebra::Counts;
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::time::Instant;

/// Load the uncommitted-delta sidecar. An unreadable delta is set aside as a
/// `.corrupt` sibling - never left in place where the next autosave would
/// overwrite it - and the user is warned via a `store-warning` event.
pub(crate) fn load_delta(delta_path: &Path) -> Option<Overlay> {
    if !delta_path.exists() {
        return None;
    }
    match arrow::read_arrow_ipc(delta_path) {
        Ok(batch) => Some(Overlay::from_delta(&batch)),
        Err(e) => {
            set_aside_delta(delta_path, &e);
            None
        }
    }
}

/// Move an unreadable delta to a `.corrupt` sibling and warn the user.
pub(crate) fn set_aside_delta(delta_path: &Path, reason: &AppError) {
    let kept = delta_path.with_extension("corrupt");
    let _ = fs::remove_file(&kept);
    let moved = fs::rename(delta_path, &kept).is_ok();
    log::error!("[delta] unreadable delta ({reason}), set aside (moved={moved}) at {kept:?}");
    crate::emit_event(StoreWarning::DeltaSetAside);
}

pub(crate) fn flush_closed_store(map_id: &str, store: &Store) -> AppResult<()> {
    if let Some(unsaved) = store.unsaved()? {
        unsaved.write(
            &storage::open_db()?,
            map_id,
            &storage::arrow_delta_path(map_id)?,
        )?;
    }
    log::debug!(
        "[close_map] {map_id} flushed: undo={} redo={}",
        store.edits.undo_len(),
        store.edits.redo_len()
    );
    Ok(())
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
        if let Ok(batch) = arrow::read_arrow_ipc(&delta_path) {
            Overlay::from_delta(&batch).apply_to(&mut locs);
        }
    }
    Ok(locs)
}

/// What an open map owes disk: its delta and its undo history, each stamped with the
/// revision it reflects, so edits made while the write runs stay unsaved.
pub(crate) struct Unsaved {
    delta: Option<At<RecordBatch>>,
    edits: Option<At<EditStacks>>,
    alive: usize,
    pending: Counts,
}

impl Unsaved {
    /// Delta before history, so a crash between the two leaves history behind the data, never ahead of it.
    pub(crate) fn write(
        &self,
        conn: &Connection,
        map_id: &str,
        delta_path: &Path,
    ) -> AppResult<()> {
        if let Some(delta) = &self.delta {
            arrow::write_arrow_ipc(delta_path, delta.value())?;
        }
        storage::set_map_counts(conn, map_id, self.alive, self.pending)?;
        if let Some(edits) = &self.edits {
            save_edit_history(conn, map_id, edits.value())?;
        }
        Ok(())
    }
}

impl Store {
    /// The state disk lacks, or `None` when disk is current.
    pub(crate) fn unsaved(&self) -> AppResult<Option<Unsaved>> {
        if !self.overlay.is_unsaved() && !self.edits.is_unsaved() {
            return Ok(None);
        }
        Ok(Some(Unsaved {
            delta: self.overlay.is_unsaved().then(|| {
                self.overlay
                    .stamp(self.overlay.to_delta(self.batch.as_ref()))
            }),
            edits: self
                .edits
                .is_unsaved()
                .then(|| self.edits.stamp((*self.edits).clone())),
            alive: *self.alive_count,
            pending: self.overlay_diff_counts(),
        }))
    }

    /// Disk now holds `written`.
    pub(crate) fn saved(&mut self, written: &Unsaved) {
        if let Some(delta) = &written.delta {
            self.overlay.saved_at(delta.rev());
        }
        if let Some(edits) = &written.edits {
            self.edits.saved_at(edits.rev());
        }
    }
}

fn stack_code(stack: Stack) -> i64 {
    match stack {
        Stack::Undo => 0,
        Stack::Redo => 1,
    }
}

/// Bring the stored history in line with the stacks: store edits it lacks, move the ones
/// that changed stack, drop the ones the stacks no longer hold. An edit is serialized
/// once, when first stored.
pub(crate) fn save_edit_history(
    conn: &Connection,
    map_id: &str,
    edits: &EditStacks,
) -> AppResult<()> {
    let stored: HashMap<u64, i64> = conn
        .prepare("SELECT seq, stack FROM edit_entries WHERE map_id = ?1")?
        .query_map([map_id], |r| Ok((r.get::<_, i64>(0)? as u64, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let tx = conn.unchecked_transaction()?;
    let mut live = HashSet::with_capacity(edits.undo_len() + edits.redo_len());
    for (stack, edit) in edits.iter() {
        live.insert(edit.seq);
        let stack = stack_code(stack);
        match (stored.get(&edit.seq), &edit.entry) {
            (Some(&at), _) if at == stack => {}
            (Some(_), _) => {
                tx.prepare_cached(
                    "UPDATE edit_entries SET stack = ?3 WHERE map_id = ?1 AND seq = ?2",
                )?
                .execute(rusqlite::params![map_id, edit.seq as i64, stack])?;
            }
            (None, Some(entry)) => {
                tx.prepare_cached(
                    "INSERT INTO edit_entries (map_id, seq, stack, max_id, entry) VALUES (?1, ?2, ?3, ?4, ?5)",
                )?
                .execute(rusqlite::params![
                    map_id,
                    edit.seq as i64,
                    stack,
                    entry.max_key().unwrap_or(0),
                    arrow::arrow_ipc_bytes(&{
                        let (created, removed) = entry.sides();
                        arrow::delta_to_batch(&created, &removed)
                    })?
                ])?;
            }
            (None, None) => log::warn!(
                "[save_edit_history] {map_id} edit {} is on no disk",
                edit.seq
            ),
        }
    }
    for seq in stored.keys().filter(|seq| !live.contains(seq)) {
        tx.prepare_cached("DELETE FROM edit_entries WHERE map_id = ?1 AND seq = ?2")?
            .execute(rusqlite::params![map_id, *seq as i64])?;
    }
    tx.commit()?;
    Ok(())
}

/// The stored undo/redo stacks, without reading any edit: each is fetched with
/// [`load_edit`] when undo or redo first reaches it.
pub(crate) fn load_edit_history(conn: &Connection, map_id: &str) -> AppResult<EditStacks> {
    let rows = conn
        .prepare("SELECT seq, stack FROM edit_entries WHERE map_id = ?1")?
        .query_map([map_id], |r| {
            let stack = if r.get::<_, i64>(1)? == stack_code(Stack::Redo) {
                Stack::Redo
            } else {
                Stack::Undo
            };
            Ok((r.get::<_, i64>(0)? as u64, stack))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    log::debug!("[load_edit_history] {map_id} {} edits on disk", rows.len());
    Ok(EditStacks::on_disk(rows))
}

/// One stored edit.
pub(crate) fn load_edit(conn: &Connection, map_id: &str, seq: u64) -> AppResult<Change> {
    let bytes: Vec<u8> = conn.query_row(
        "SELECT entry FROM edit_entries WHERE map_id = ?1 AND seq = ?2",
        rusqlite::params![map_id, seq as i64],
        |r| r.get(0),
    )?;
    let (created, removed) = arrow::batch_to_delta(&arrow::read_arrow_ipc_bytes(&bytes)?);
    Ok(Change::from_sides(created, removed))
}

/// Highest location id the stored history can re-materialize, without reading it.
pub(crate) fn stored_history_max_id(conn: &Connection, map_id: &str) -> AppResult<u32> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(max_id), 0) FROM edit_entries WHERE map_id = ?1",
        [map_id],
        |r| r.get(0),
    )?)
}

/// Bake the overlay into the base, write it to `path`, and only then adopt it, clear the
/// overlay, drop the stale delta file, and re-mmap. A failed write leaves the store as it was.
pub(crate) fn write_baked_base(store: &mut Store, path: &Path, delta_path: &Path) -> AppResult<()> {
    let _t = Instant::now();
    let Some(batch) = store.current_batch() else {
        return Ok(());
    };
    let t_bake = _t.elapsed();
    arrow::write_arrow_ipc(path, &batch)?;
    let t_write = _t.elapsed();
    store.adopt_base(batch);
    let _ = fs::remove_file(delta_path);
    let (batch, handle) = arrow::read_arrow_ipc_mmap(path)?;
    store.batch = Some(batch);
    store.mmap_handle = Some(handle);
    log::debug!(
        "[write_baked_base] bake={:.0}ms base-write={:.0}ms remmap={:.0}ms",
        t_bake.as_millis(),
        (t_write - t_bake).as_millis(),
        (_t.elapsed() - t_write).as_millis()
    );
    Ok(())
}

/// Write the baked base for `store_commit` and flush the location count.
pub(crate) fn bake_and_save(store: &mut Store, map_id: &str) -> AppResult<()> {
    write_baked_base(
        store,
        &storage::arrow_path(map_id)?,
        &storage::arrow_delta_path(map_id)?,
    )?;
    let count = store.batch.as_ref().map_or(0, RecordBatch::num_rows);
    let conn = storage::open_db()?;
    storage::set_map_counts(&conn, map_id, count, Counts::default())?;
    Ok(())
}
