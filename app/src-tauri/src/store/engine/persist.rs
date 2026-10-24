//! Persist an open map's locations, metadata, and edit history.

use super::*;
use crate::store::maps::MapMeta;
use crate::store::{arrow, storage};
use crate::types::{AppError, AppResult, ErrCode, Location};
use crate::util::Lock;
use arrow_array::{RecordBatch, UInt32Array};
use mma_algebra::{by_key, Change, Counts, Id};
use rusqlite::Connection;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::PoisonError;
use std::time::Instant;
use tokio::task;

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

/// A hold on a map's store, which keeps it in the manager until the hold is released or
/// dropped.
pub(crate) struct Hold {
    state: &'static StoreState,
    map: Id<MapMeta, String>,
    holder: Mutex<Option<Holder>>,
}

impl Hold {
    /// Run `f` on the held map's store, refused once the hold lets go.
    pub(crate) fn store<R>(&self, f: impl FnOnce(&mut Store) -> AppResult<R>) -> AppResult<R> {
        if self.holder.locked().is_none() {
            return Err(AppError(format!("map {} is no longer held", self.map)));
        }
        f(self.state.locked().store_for_map(&self.map)?)
    }

    /// Let go of the map's store and save what disk lacks of it. Only the first release lets go.
    pub(crate) async fn release(&self) -> AppResult<()> {
        let holder = self.holder.locked().take();
        match holder {
            Some(holder) => release(self.state, &holder).await,
            None => Ok(()),
        }
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        let holder = self
            .holder
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(holder) = holder.take() {
            let state = self.state;
            tauri::async_runtime::spawn(async move {
                if let Err(error) = release(state, &holder).await {
                    log::warn!("[store] a held map was not saved: {}", error.0);
                }
            });
        }
    }
}

/// Keep the map's store in the manager for `holder` until the hold it hands back lets go,
/// loading it from disk when it is not there yet.
pub(crate) async fn hold(
    state: &'static StoreState,
    holder: Holder,
    map_id: &Id<MapMeta, String>,
) -> AppResult<Hold> {
    let files = state.lock()?.files(map_id);
    let _writing = files.lock().await;
    let loaded = if state.lock()?.stores.contains_key(map_id) {
        None
    } else {
        let map_id = map_id.clone();
        Some(task::spawn_blocking(move || load_store(&map_id)).await??)
    };
    let mut mgr = state.lock()?;
    if let Some(mut store) = loaded {
        store.dependents = mgr.providers.dependents();
        mgr.stores.insert(map_id.clone(), store);
    }
    mgr.holders.insert(holder.clone(), map_id.clone());
    Ok(Hold {
        state,
        map: map_id.clone(),
        holder: Mutex::new(Some(holder)),
    })
}

/// Save what disk lacks of the map's store, under its files lock. No-op when the store is
/// not open or nothing changed.
pub(crate) async fn save(state: &StoreState, map_id: &Id<MapMeta, String>) -> AppResult<()> {
    let files = state.lock()?.files(map_id);
    let _writing = files.lock().await;
    let unsaved = match state.lock()?.stores.get(map_id) {
        Some(store) => store.unsaved()?,
        None => None,
    };
    flush(state, map_id, unsaved).await
}

/// Let go of what `holder` keeps here and save what disk lacks of its map, under the map's
/// files lock from before the store leaves the manager, which it does once nothing else
/// holds it.
pub(crate) async fn release(state: &StoreState, holder: &Holder) -> AppResult<()> {
    loop {
        let Some(map_id) = state.lock()?.holders.get(holder).cloned() else {
            return Ok(());
        };
        let files = state.lock()?.files(&map_id);
        let _writing = files.lock().await;
        let unsaved = {
            let mut mgr = state.lock()?;
            if mgr.holders.get(holder) != Some(&map_id) {
                continue;
            }
            let unsaved = match mgr.stores.get(&map_id) {
                Some(store) => store.unsaved()?,
                None => None,
            };
            drop(mgr.release(holder));
            unsaved
        };
        return flush(state, &map_id, unsaved).await;
    }
}

/// Write `unsaved` for the map, then tell its store, when it is still here, that disk holds it.
async fn flush(
    state: &StoreState,
    map_id: &Id<MapMeta, String>,
    unsaved: Option<Unsaved>,
) -> AppResult<()> {
    let Some(unsaved) = unsaved else {
        return Ok(());
    };
    let map = map_id.clone();
    let unsaved = task::spawn_blocking(move || {
        unsaved.write(
            &*storage::open_db()?,
            &map,
            &storage::arrow_delta_path(&map)?,
        )?;
        AppResult::Ok(unsaved)
    })
    .await??;
    if let Some(store) = state.lock()?.stores.get_mut(map_id) {
        store.saved(&unsaved);
    }
    Ok(())
}

/// A store holding what disk holds for `map_id`: its last commit, uncommitted changes, edit
/// history, and metadata.
pub(crate) fn load_store(map_id: &Id<MapMeta, String>) -> AppResult<Store> {
    let t_total = Instant::now();

    let (batch, mmap_handle, delta) = {
        let t0 = Instant::now();
        let path = storage::arrow_path(map_id)?;
        let delta_path = storage::arrow_delta_path(map_id)?;

        // The base file holds the last committed state -- it may not exist at all for a
        // map with no commits, whose data then lives entirely in the delta sidecar. Mmap
        // the base zero-copy and leave it untouched; load the delta into the overlay
        // regardless of whether a base file exists (never folded into the base).
        let (batch, handle) = if path.exists() {
            let (b, h) = arrow::read_arrow_ipc_mmap(&path).map_err(|e| {
                log::error!("[store_open] {path:?} unreadable: {e}");
                ErrCode::MapUnreadable.err()
            })?;
            log::debug!(
                "[store_open] mmap_read={}ms rows={}",
                t0.elapsed().as_millis(),
                b.num_rows()
            );
            (b, Some(h))
        } else {
            log::debug!("[store_open] no base file, empty batch");
            (RecordBatch::new_empty(schema()), None)
        };
        delta_legacy::convert_msgpack_delta(&delta_path, &path)?;
        let delta = load_delta(&delta_path);
        (batch, handle, delta)
    };

    // Legacy files may be unsorted; enforce the sorted ID invariant once.
    let (batch, mmap_handle) = {
        let ids = Columns::id(&batch);
        let sorted = (1..batch.num_rows()).all(|i| ids.value(i - 1) < ids.value(i));
        if sorted || batch.num_rows() == 0 {
            (batch, mmap_handle)
        } else {
            log::info!("[store_open] migrating unsorted Arrow file to sorted ID order");
            let mut order: Vec<u32> = (0..batch.num_rows() as u32).collect();
            order.sort_by_key(|&i| ids.value(i as usize));
            let sort_idx = UInt32Array::from(order);
            let sorted_batch = RecordBatch::try_new(
                batch.schema(),
                batch
                    .columns()
                    .iter()
                    .map(|col| take::take(col.as_ref(), &sort_idx, None).unwrap())
                    .collect(),
            )
            .unwrap();
            drop(batch);
            drop(mmap_handle);
            let path = storage::arrow_path(map_id)?;
            arrow::write_arrow_ipc(&path, &sorted_batch)?;
            drop(sorted_batch);
            let (b, h) = arrow::read_arrow_ipc_mmap(&path)?;
            log::info!("[store_open] migration complete, re-mmap'd sorted file");
            (b, Some(h))
        }
    };

    let n = batch.num_rows();
    let max_id = n
        .checked_sub(1)
        .map(|last| Id::new(Columns::id(&batch).value(last)));

    let conn = storage::open_db()?;
    let edits = load_edit_history(&conn, map_id)?;
    let history_max = stored_history_max_id(&conn, map_id)?;

    let mut store = Store::new();
    store.bump();
    store.batch = Some(batch);
    store.mmap_handle = mmap_handle;

    // Load uncommitted edits into the overlay; the base batch stays at the last commit.
    // `added` rows are persisted in sorted-id order.
    if let Some(d) = delta {
        store.overlay = Tracked::new(d);
    }
    store.next_id = seed_next_id(max_id, &store.overlay.added, history_max);

    storage::set_map_counts(&conn, map_id, store.view().len(), store.overlay.counts())?;
    store.steps[Timeline::Edits] = Tracked::new(edits);

    let mut meta = maps::read_map_meta(&conn, map_id).map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => ErrCode::MapMissing.err(),
        e => AppError::from(e),
    })?;
    store.records = load_value_records(&conn, map_id)?
        .into_iter()
        .map(|(field, records)| (field, Tracked::new(records)))
        .collect();
    store.field_defs = Tracked::new(mem::take(&mut meta.extra.fields));
    store.meta = Tracked::new(meta);
    log::debug!("[store_open] TOTAL={}ms", t_total.elapsed().as_millis());
    Ok(store)
}

/// Read a map's full current state from disk = base file + uncommitted delta sidecar.
/// Use this for consumers (e.g. export) that read a map's locations directly off disk,
/// since the base file alone is only the last committed state.
pub(crate) fn read_full_state_from_disk(map_id: &Id<MapMeta, String>) -> AppResult<Vec<Location>> {
    let path = storage::arrow_path(map_id)?;
    // The base file may not exist for a map with no commits -- its data then lives entirely
    // in the delta sidecar, so always apply the delta below regardless.
    let mut locs = if path.exists() {
        by_key(arrow::batch_to_locations(&arrow::read_arrow_ipc(&path)?))
    } else {
        BTreeMap::new()
    };

    let delta_path = storage::arrow_delta_path(map_id)?;
    if delta_path.exists() {
        if let Ok(batch) = arrow::read_arrow_ipc(&delta_path) {
            let (created, removed) = arrow::batch_to_delta(&batch);
            Change::from_sides(created, removed).apply_to(&mut locs);
        }
    }
    Ok(locs.into_values().collect())
}

/// Every interned field's value records stored for `map_id`.
pub(crate) fn load_value_records(
    conn: &Connection,
    map_id: &Id<MapMeta, String>,
) -> AppResult<HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>>> {
    let rows = conn
        .prepare("SELECT field, records FROM value_records WHERE map_id = ?1")?
        .query_map([map_id.raw()], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .map(|(field, text)| (field, decode_records(&text)))
        .collect())
}

/// Store `records` as `field`'s value records for `map_id`.
pub(crate) fn save_value_records(
    conn: &Connection,
    map_id: &Id<MapMeta, String>,
    field: &str,
    records: &HashMap<Id<ValueRecord>, ValueRecord>,
) -> AppResult<()> {
    conn.prepare_cached(
        "INSERT INTO value_records (map_id, field, records) VALUES (?1, ?2, ?3)
         ON CONFLICT (map_id, field) DO UPDATE SET records = excluded.records",
    )?
    .execute(rusqlite::params![
        map_id.raw(),
        field,
        serde_json::to_string(records)?
    ])?;
    Ok(())
}

/// Records stored as an object keyed by id. Each takes its id from its key and drops the
/// legacy `visible` key.
fn decode_records(text: &str) -> HashMap<Id<ValueRecord>, ValueRecord> {
    let Ok(serde_json::Value::Object(stored)) = serde_json::from_str(text) else {
        return HashMap::new();
    };
    stored
        .into_iter()
        .filter_map(|(key, mut record)| {
            let id = key.parse::<u32>().ok()?;
            let fields = record.as_object_mut()?;
            fields.insert("id".into(), id.into());
            fields.remove("visible");
            let record: ValueRecord = serde_json::from_value(record).ok()?;
            Some((record.id, record))
        })
        .collect()
}

/// Unsaved map data with revision stamps, so concurrent edits stay unsaved.
pub(crate) struct Unsaved {
    delta: Option<At<RecordBatch>>,
    meta: Option<MetaRow>,
    records: Vec<(String, At<HashMap<Id<ValueRecord>, ValueRecord>>)>,
    steps: Option<At<StepStacks>>,
    alive: usize,
    pending: Counts,
}

/// A metadata patch and the revisions it includes.
struct MetaRow {
    row: MapMeta,
    meta: u64,
    defs: u64,
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
        for (field, records) in &self.records {
            save_value_records(conn, map_id, field, records.value())?;
        }
        if let Some(steps) = &self.steps {
            save_edit_history(conn, map_id, steps.value())?;
        }
        Ok(())
    }
}

impl Store {
    fn meta_unsaved(&self) -> bool {
        self.meta.is_unsaved() || self.field_defs.is_unsaved()
    }

    /// Whether disk lacks some of the map's current state.
    pub(crate) fn is_unsaved(&self) -> bool {
        self.overlay.is_unsaved()
            || self.steps[Timeline::Edits].is_unsaved()
            || self.meta_unsaved()
            || self.records.values().any(Tracked::is_unsaved)
    }

    /// The state disk lacks, or `None` when disk is current.
    pub(crate) fn unsaved(&self) -> AppResult<Option<Unsaved>> {
        if !self.is_unsaved() {
            return Ok(None);
        }
        let meta = self.meta_unsaved().then(|| MetaRow {
            row: self.map(),
            meta: self.meta.rev(),
            defs: self.field_defs.rev(),
        });
        let records = self
            .records
            .iter()
            .filter(|(_, records)| records.is_unsaved())
            .map(|(field, records)| (field.clone(), records.stamp((**records).clone())))
            .collect();
        Ok(Some(Unsaved {
            delta: self.overlay.is_unsaved().then(|| {
                self.overlay
                    .stamp(self.overlay.to_delta(self.batch.as_ref()))
            }),
            meta,
            records,
            steps: {
                let steps = &self.steps[Timeline::Edits];
                steps.is_unsaved().then(|| steps.stamp((**steps).clone()))
            },
            alive: self.view().len(),
            pending: self.overlay.counts(),
        }))
    }

    /// Disk now holds `written`. Subscribers hear when that leaves nothing unsaved.
    pub(crate) fn saved(&mut self, written: &Unsaved) {
        if let Some(delta) = &written.delta {
            self.overlay.saved_at(delta.rev());
        }
        if let Some(row) = &written.meta {
            self.meta.saved_at(row.meta);
            self.field_defs.saved_at(row.defs);
        }
        for (field, records) in &written.records {
            if let Some(held) = self.records.get_mut(field) {
                held.saved_at(records.rev());
            }
        }
        if let Some(steps) = &written.steps {
            self.steps[Timeline::Edits].saved_at(steps.rev());
        }
        self.announce();
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
                    "INSERT INTO edit_entries (map_id, seq, stack, max_id, entry, parts) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
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
        "SELECT entry, parts FROM edit_entries WHERE map_id = ?1 AND seq = ?2",
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

impl Store {
    /// Bake the overlay into the map's base file, and only then adopt it, clear the overlay,
    /// drop the stale delta file, and re-map the base. A failed write leaves the store as it was.
    pub(crate) fn bake(&mut self) -> AppResult<()> {
        self.owned()?;
        let _t = Instant::now();
        let Some(batch) = self.current_batch() else {
            return Ok(());
        };
        let t_bake = _t.elapsed();
        let path = storage::arrow_path(&self.meta.id)?;
        arrow::write_arrow_ipc(&path, &batch)?;
        let t_write = _t.elapsed();
        self.adopt_base(batch);
        let _ = fs::remove_file(storage::arrow_delta_path(&self.meta.id)?);
        let (batch, handle) = arrow::read_arrow_ipc_mmap(&path)?;
        self.batch = Some(batch);
        self.mmap_handle = Some(handle);
        log::debug!(
            "[bake] bake={:.0}ms base-write={:.0}ms remmap={:.0}ms",
            t_bake.as_millis(),
            (t_write - t_bake).as_millis(),
            (_t.elapsed() - t_write).as_millis()
        );
        Ok(())
    }
}

#[cfg(test)]
#[path = "persist.test.rs"]
mod tests;
