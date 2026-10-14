//! Persist an open map's locations, metadata, and edit history.

use super::*;
use crate::store::maps::MapMeta;
use crate::store::{arrow, storage};
use crate::types::{AppError, AppResult, Location};
use arrow_array::RecordBatch;
use mma_algebra::{Counts, Id};
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

/// Flush a store after its final window closes, using the same per-map file lock as saves and
/// commits. Taking ownership keeps the detached store alive until its flush completes.
pub(crate) async fn flush_closed_store(map_id: Id<MapMeta, String>, store: Store) -> AppResult<()> {
    let files = store.files.clone();
    let _writing = files.lock().await;
    tokio::task::spawn_blocking(move || {
        if let Some(unsaved) = store.unsaved()? {
            unsaved.write(
                &storage::open_db()?,
                &map_id,
                &storage::arrow_delta_path(&map_id)?,
            )?;
        }
        log::debug!(
            "[close_map] {map_id} flushed: undo={} redo={}",
            store.steps[Timeline::Edits].len(Stack::Undo),
            store.steps[Timeline::Edits].len(Stack::Redo)
        );
        Ok(())
    })
    .await?
}

/// Read a map's full current state from disk = base file + uncommitted delta sidecar.
/// Use this for consumers (e.g. export) that read a map's locations directly off disk,
/// since the base file alone is only the last committed state.
pub(crate) fn read_full_state_from_disk(map_id: &Id<MapMeta, String>) -> AppResult<Vec<Location>> {
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

/// Unsaved map data with revision stamps, so concurrent edits stay unsaved.
pub(crate) struct Unsaved {
    delta: Option<At<RecordBatch>>,
    meta: Option<MetaRow>,
    steps: Option<At<StepStacks>>,
    alive: usize,
    pending: Counts,
}

/// A metadata patch and the revisions it includes.
struct MetaRow {
    row: MapMeta,
    meta: u64,
    defs: u64,
    values: Vec<(String, u64)>,
}

impl Unsaved {
    /// Data before history, so a crash between the two leaves history behind the data, never ahead of it.
    pub(crate) fn write(
        &self,
        conn: &Connection,
        map_id: &Id<MapMeta, String>,
        delta_path: &Path,
    ) -> AppResult<()> {
        if let Some(delta) = &self.delta {
            arrow::write_arrow_ipc(delta_path, delta.value())?;
        }
        storage::set_map_counts(conn, map_id, self.alive, self.pending)?;
        if let Some(row) = &self.meta {
            storage::update_row::<MapMeta>(conn, "maps", map_id.raw(), &row.row)?;
        }
        if let Some(steps) = &self.steps {
            save_edit_history(conn, map_id, steps.value())?;
        }
        Ok(())
    }
}

impl Store {
    /// The state disk lacks, or `None` when disk is current.
    pub(crate) fn unsaved(&self) -> AppResult<Option<Unsaved>> {
        let meta = (self.meta.is_unsaved()
            || self.field_defs.is_unsaved()
            || self.value_meta.values().any(Tracked::is_unsaved))
        .then(|| MetaRow {
            row: self.map(),
            meta: self.meta.rev(),
            defs: self.field_defs.rev(),
            values: self
                .value_meta
                .iter()
                .map(|(field, v)| (field.clone(), v.rev()))
                .collect(),
        });
        if !self.overlay.is_unsaved() && !self.steps[Timeline::Edits].is_unsaved() && meta.is_none()
        {
            return Ok(None);
        }
        Ok(Some(Unsaved {
            delta: self.overlay.is_unsaved().then(|| {
                self.overlay
                    .stamp(self.overlay.to_delta(self.batch.as_ref()))
            }),
            meta,
            steps: {
                let steps = &self.steps[Timeline::Edits];
                steps.is_unsaved().then(|| steps.stamp((**steps).clone()))
            },
            alive: *self.alive_count,
            pending: self.overlay_diff_counts(),
        }))
    }

    /// Disk now holds `written`.
    pub(crate) fn saved(&mut self, written: &Unsaved) {
        if let Some(delta) = &written.delta {
            self.overlay.saved_at(delta.rev());
        }
        if let Some(row) = &written.meta {
            self.meta.saved_at(row.meta);
            self.field_defs.saved_at(row.defs);
            for (field, rev) in &row.values {
                if let Some(v) = self.value_meta.get_mut(field) {
                    v.saved_at(*rev);
                }
            }
        }
        if let Some(steps) = &written.steps {
            self.steps[Timeline::Edits].saved_at(steps.rev());
        }
    }
}

fn stack_code(stack: Stack) -> i64 {
    match stack {
        Stack::Undo => 0,
        Stack::Redo => 1,
    }
}

/// Bring the stored history in line with the stacks: store steps it lacks, move the ones
/// that changed stack, drop the ones the stacks no longer hold. A step is serialized
/// once, when first stored.
pub(crate) fn save_edit_history(
    conn: &Connection,
    map_id: &Id<MapMeta, String>,
    steps: &StepStacks,
) -> AppResult<()> {
    let stored: HashMap<u64, i64> = conn
        .prepare("SELECT seq, stack FROM edit_entries WHERE map_id = ?1")?
        .query_map([map_id.raw()], |r| {
            Ok((r.get::<_, i64>(0)? as u64, r.get(1)?))
        })?
        .collect::<Result<_, _>>()?;
    let tx = conn.unchecked_transaction()?;
    let mut live = HashSet::with_capacity(steps.len(Stack::Undo) + steps.len(Stack::Redo));
    for (stack, step) in steps.iter() {
        live.insert(step.seq);
        let stack = stack_code(stack);
        match (stored.get(&step.seq), &step.entry) {
            (Some(&at), _) if at == stack => {}
            (Some(_), _) => {
                tx.prepare_cached(
                    "UPDATE edit_entries SET stack = ?3 WHERE map_id = ?1 AND seq = ?2",
                )?
                .execute(rusqlite::params![
                    map_id.raw(),
                    step.seq as i64,
                    stack
                ])?;
            }
            (None, Some(entry)) => {
                tx.prepare_cached(
                    "INSERT INTO edit_entries (map_id, seq, stack, max_id, entry, piles) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )?
                .execute(rusqlite::params![
                    map_id.raw(),
                    step.seq as i64,
                    stack,
                    entry.locations.max_key().map_or(0, Id::get),
                    arrow::arrow_ipc_bytes(&{
                        let (created, removed) = entry.locations.sides();
                        arrow::delta_to_batch(&created, &removed)
                    })?,
                    serde_json::to_string(&**entry)?
                ])?;
            }
            (None, None) => log::warn!(
                "[save_edit_history] {map_id} step {} is on no disk",
                step.seq
            ),
        }
    }
    for seq in stored.keys().filter(|seq| !live.contains(seq)) {
        tx.prepare_cached("DELETE FROM edit_entries WHERE map_id = ?1 AND seq = ?2")?
            .execute(rusqlite::params![map_id.raw(), *seq as i64])?;
    }
    tx.commit()?;
    Ok(())
}

/// The stored stacks and changed field keys, without decoding location payloads.
pub(crate) fn load_edit_history(
    conn: &Connection,
    map_id: &Id<MapMeta, String>,
) -> AppResult<StepStacks> {
    let rows = conn
        .prepare("SELECT seq, stack FROM edit_entries WHERE map_id = ?1")?
        .query_map([map_id.raw()], |r| {
            let stack = if r.get::<_, i64>(1)? == stack_code(Stack::Redo) {
                Stack::Redo
            } else {
                Stack::Undo
            };
            Ok((r.get::<_, i64>(0)? as u64, stack))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    log::debug!("[load_edit_history] {map_id} {} steps on disk", rows.len());
    Ok(StepStacks::on_disk(rows))
}

/// One stored step.
pub(crate) fn load_edit(
    conn: &Connection,
    map_id: &Id<MapMeta, String>,
    seq: u64,
) -> AppResult<Entry> {
    let (bytes, json): (Vec<u8>, String) = conn.query_row(
        "SELECT entry, piles FROM edit_entries WHERE map_id = ?1 AND seq = ?2",
        rusqlite::params![map_id.raw(), seq as i64],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let (created, removed) = arrow::batch_to_delta(&arrow::read_arrow_ipc_bytes(&bytes)?);
    Ok(Entry {
        locations: Change::from_sides(created, removed),
        ..serde_json::from_str(&json)?
    })
}

/// Highest location id the stored history can re-materialize, without reading it.
pub(crate) fn stored_history_max_id(
    conn: &Connection,
    map_id: &Id<MapMeta, String>,
) -> AppResult<Option<Id<Location>>> {
    Ok(conn.query_row(
        "SELECT MAX(max_id) FROM edit_entries WHERE map_id = ?1",
        [map_id.raw()],
        |r| r.get::<_, Option<u32>>(0).map(|max| max.map(Id::new)),
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
pub(crate) fn bake_and_save(store: &mut Store, map_id: &Id<MapMeta, String>) -> AppResult<()> {
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

#[cfg(test)]
#[path = "persist.test.rs"]
mod tests;
