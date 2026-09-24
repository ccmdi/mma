//! Tauri commands over the location store: each takes the window lock, calls the engine,
//! and maps the result. Workflow belongs in the engine or in TS, not here.
#![allow(clippy::needless_pass_by_value)]

use crate::io::export;
use crate::io::import;
use crate::plugins::borders;
use crate::selections::{self, Selection, Selector};
use crate::store::arrow;
use crate::store::arrow::schema;
use crate::store::engine::*;
use crate::store::maps;
use crate::store::storage;
use crate::types::Location;
use crate::types::RawExtra;
use crate::types::{AppError, AppResult};
use crate::util;
use arrow_array::{RecordBatch, UInt32Array};
use arrow_select::take;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{self, AtomicUsize};
use std::time::Instant;
use tokio::task;

/// Matched locations: returned inline, or as a file path to read them from.
#[derive(serde::Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Rows {
    Inline { locations: Vec<Location> },
    File { path: String },
}

/// Above this many rows, `store_collect` stages a file instead of answering over IPC.
pub(crate) const ROWS_INLINE_MAX: usize = 1024;

/// A rotating slot per rows-file query: the file is fetched after the store lock is
/// released, so two concurrent row reads must not share one path -- while the slot
/// cycle keeps stale files bounded and self-overwriting like a fixed path.
pub(crate) fn rows_file_path(temp: &Path, map_id: &str) -> PathBuf {
    static SLOT: AtomicUsize = AtomicUsize::new(0);
    let slot = SLOT.fetch_add(1, atomic::Ordering::Relaxed) % 8;
    temp.join(format!("mma_rows_{map_id}_{slot}.json"))
}

/// Open a map and return its initial state (per-value counts, metadata, undo/redo availability).
/// Must be called before any other store commands.
#[tauri::command]
#[specta::specta]
pub async fn store_open_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    map_id: String,
) -> AppResult<StoreStatus> {
    let map_id2 = map_id.clone();

    let result = task::spawn_blocking(move || {
        use std::time::Instant;
        let t_total = Instant::now();

        let (batch, mmap_handle, delta) = {
            let t0 = Instant::now();
            let path = storage::arrow_path(&map_id2)?;
            let delta_path = storage::arrow_delta_path(&map_id2)?;

            // The base file holds the last committed state -- it may not exist at all for a
            // map with no commits, whose data then lives entirely in the delta sidecar. Mmap
            // the base zero-copy and leave it untouched; load the delta into the overlay
            // regardless of whether a base file exists (never folded into the base).
            let (batch, handle) = if path.exists() {
                let (b, h) = arrow::read_arrow_ipc_mmap(&path)?;
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
            let delta = load_delta(&delta_path);
            (batch, handle, delta)
        };

        // Legacy files may be unsorted; enforce the sorted ID invariant once.
        let (batch, mmap_handle) = {
            let ids = arrow::Columns::id(&batch);
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
                let path = storage::arrow_path(&map_id2)?;
                arrow::write_arrow_ipc(&path, &sorted_batch)?;
                drop(sorted_batch);
                let (b, h) = arrow::read_arrow_ipc_mmap(&path)?;
                log::info!("[store_open] migration complete, re-mmap'd sorted file");
                (b, Some(h))
            }
        };

        let n = batch.num_rows();
        let max_id = if n > 0 {
            arrow::Columns::id(&batch).value(n - 1)
        } else {
            0
        };

        let (undo, redo) = load_edit_history(&map_id2)?;

        log::debug!("[store_open] TOTAL={}ms", t_total.elapsed().as_millis());
        Ok::<_, AppError>((batch, mmap_handle, max_id, undo, redo, delta))
    })
    .await??;

    let (batch, mmap_handle, max_id, undo, redo, delta) = result;

    let mut store = Store::new();
    store.bump();
    store.map_id = Some(map_id.clone());
    store.batch = Some(batch);
    store.mmap_handle = mmap_handle;

    // Load uncommitted edits into the overlay; the base batch stays at the last commit.
    // `adds` are persisted in sorted-id order.
    if let Some(d) = delta {
        store.overlay = Tracked::unsaved(d);
    }
    store.next_id = seed_next_id(max_id, &store.overlay.adds, &undo, &redo);

    let LocationAggregates { alive, bounds } = store.scan_locations();
    store.alive_count = Tracked::new(alive);
    store.bounds = Some(At::new(store.version, bounds));
    {
        let conn = storage::open_db()?;
        storage::set_map_counts(&conn, &map_id, alive, store.overlay_diff_counts().into())?;
        store
            .value_meta
            .insert("tags".into(), Tracked::new(read_tags_json(&conn, &map_id)));
        let extra_str: String = conn
            .query_row(
                "SELECT extra FROM maps WHERE id = ?1",
                rusqlite::params![map_id],
                |row| row.get(0),
            )
            .unwrap_or_default();
        let extra = maps::MapExtra::from_json(&extra_str);
        store.field_defs = Tracked::new(extra.fields.unwrap_or_default());
    }
    store.edits = Tracked::new(EditStacks { undo, redo });

    let status = store.open_status();
    let mut mgr = state.lock()?;
    mgr.window_map.insert(label.0.clone(), map_id.clone());
    mgr.stores.insert(map_id, store);
    Ok(status)
}

/// Close the open map, saving unsaved changes first.
#[tauri::command]
#[specta::specta]
pub async fn store_close_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<()> {
    let (map_id, store) = {
        let mut mgr = state.lock()?;
        let Some(map_id) = mgr.window_map.remove(&label.0) else {
            return Ok(());
        };
        if mgr.window_map.values().any(|v| v == &map_id) {
            log::debug!("[close_map] {map_id} still open in another window, skipping flush");
            return Ok(());
        }
        let Some(store) = mgr.stores.remove(&map_id) else {
            log::debug!("[close_map] {map_id} has no store, nothing to flush");
            return Ok(());
        };
        (map_id, store)
    };
    task::spawn_blocking(move || flush_closed_store(&map_id, &store)).await?
}

/// Add new locations, allocating sequential IDs. Undoable.
#[tauri::command]
#[specta::specta]
pub fn store_add_locations(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    locations: Vec<Location>,
) -> AppResult<MutationResult> {
    let _t = Instant::now();
    with_store!(label, state, |store| {
        let _lock = _t.elapsed().as_millis();
        let result = apply_adds(store, locations);
        log::debug!(
            "[cmd] store_add_locations lock={}ms total={}ms",
            _lock,
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// Add locations from an upload session (see `storeUploadBegin`) as one undoable change.
#[tauri::command]
#[specta::specta]
pub async fn store_add_locations_uploaded(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    session_dir: String,
) -> AppResult<MutationResult> {
    let _t = Instant::now();
    // Parse before taking the store lock: a malformed chunk must leave the store untouched.
    let locations =
        task::spawn_blocking(move || export::read_uploaded_chunks(&session_dir)).await??;
    let _read = _t.elapsed().as_millis();
    with_store!(label, state, |store| {
        let n = locations.len();
        let result = apply_adds(store, locations);
        log::debug!(
            "[cmd] store_add_locations_uploaded n={} read={}ms total={}ms",
            n,
            _read,
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// Remove locations by ID. Undoable.
#[tauri::command]
#[specta::specta]
pub fn store_remove_locations(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    ids: Vec<u32>,
) -> AppResult<MutationResult> {
    let _t = Instant::now();
    with_store!(label, state, |store| {
        let removed: Vec<Location> = ids
            .iter()
            .filter_map(|&id| store.get_loc_by_id(id))
            .collect();
        let result = store.apply_undoable(removed, Vec::new());
        log::debug!(
            "[cmd] store_remove_locations total={}ms ids={}",
            _t.elapsed().as_millis(),
            ids.len()
        );
        Ok(result)
    })
}

/// Apply partial patches to existing locations. `recordUndo` defaults to true;
/// set to false for ephemeral updates (e.g., plugin-driven batch modifications
/// that manage their own undo).
#[tauri::command]
#[specta::specta]
pub async fn store_update_locations(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    updates: Vec<Update<LocationPatch>>,
    record_undo: Option<bool>,
) -> AppResult<MutationResult> {
    let record_undo = record_undo.unwrap_or(true);
    let _t = Instant::now();
    with_store!(label, state, |store| {
        let n = updates.len();
        let result = apply_updates(store, &updates, record_undo);
        log::debug!(
            "[cmd] store_update_locations n={} undo={} total={}ms",
            n,
            record_undo,
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// Apply a field operation to every location matched by `selector`.
#[tauri::command]
#[specta::specta]
pub async fn store_apply_field_op(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    op: FieldOp,
    record_undo: Option<bool>,
) -> AppResult<FieldOpResult> {
    let _t = Instant::now();
    with_store!(label, state, |store| {
        let result = apply_field_op(store, &selector, &op, record_undo.unwrap_or(true))?;
        log::debug!(
            "[cmd] store_apply_field_op total={}ms",
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// Patch an interned field's value metadata: get-or-create names, edit display
/// metadata, reorder. Metadata only - membership writes go through the ordinary
/// `listSet` field op. `tags` is the first (and so far only) interned field.
#[tauri::command]
#[specta::specta]
pub fn store_patch_field_values(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    field: String,
    patch: FieldValuesPatch,
) -> AppResult<FieldValuesResult> {
    with_store!(label, state, |store| {
        store.patch_field_values(&field, &patch)
    })
}

/// Set (or clear) the active location.
#[tauri::command]
#[specta::specta]
pub fn store_set_active(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    id: Option<u32>,
) -> AppResult<()> {
    with_store!(label, state, |store| {
        store.selections.active_id = id;
        Ok(())
    })
}

/// Set the default marker color for new render updates.
#[tauri::command]
#[specta::specta]
pub fn store_set_marker_color(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    color: [u8; 3],
) -> AppResult<()> {
    with_store!(label, state, |store| {
        store.render.marker_color = color;
        Ok(())
    })
}

/// Count locations by country using offline point-in-polygon. Returns (ISO-A2, count) pairs.
/// `level` selects border precision, falling back to "light" if unavailable.
// Coords are gathered under the store lock, then classified after it's released.
#[tauri::command]
#[specta::specta]
pub async fn store_country_distribution(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    level: String,
) -> AppResult<Vec<(String, u32)>> {
    let coords: AppResult<Vec<(f64, f64)>> = selector_read!(label, state, selector, |scope| {
        scope.rows().map(|row| (row.lat(), row.lng())).collect()
    });
    borders::tally_countries(&level, &coords?)
}

/// Copy locations already stored in this map into another map.
#[tauri::command]
#[specta::specta]
pub fn store_copy_locations_to_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    target_map_id: String,
    selector: Selector,
) -> AppResult<CopyToMapResult> {
    copy_to_map(label, state, target_map_id, |src| src.collect(&selector))
}

/// Add caller-supplied locations to another map. Tags are matched by name against this
/// map's tag table.
#[tauri::command]
#[specta::specta]
pub fn store_add_locations_to_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    target_map_id: String,
    locations: Vec<Location>,
) -> AppResult<CopyToMapResult> {
    copy_to_map(label, state, target_map_id, |_| locations)
}

/// Insert `collect`'s locations into another map, skipping ones the target already has.
/// Tags and extra fields carry over.
// If the target is open in any window its live store is mutated and `store-external-mutation`
// tells its windows to resync; either way the result is persisted immediately.
fn copy_to_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    target_map_id: String,
    collect: impl FnOnce(&mut Store) -> Vec<Location>,
) -> AppResult<CopyToMapResult> {
    let _t = Instant::now();
    let conn = storage::open_db()?;
    let target_name: String = conn.query_row(
        "SELECT name FROM maps WHERE id = ?1",
        [&target_map_id],
        |r| r.get(0),
    )?;

    // The manager lock is held for both paths: it serializes the closed-path
    // delta-file rewrite against a concurrent store_open_map of the same map.
    let mut mgr = state.lock()?;
    let source_map_id = mgr.map_id_for_window(&label.0)?;
    if source_map_id == target_map_id {
        return Err(AppError("cannot copy a location into its own map".into()));
    }

    let now = util::now_unix();
    let mut sources: Vec<Location> = Vec::new();
    let source_tags: HashMap<u32, ValueRecord> = {
        let src = mgr.store_for_map(&source_map_id)?;
        for mut loc in collect(src) {
            loc.created_at = now;
            loc.modified_at = Some(now);
            sources.push(loc);
        }
        let used: HashSet<u32> = sources
            .iter()
            .flat_map(|l| l.tags.iter().copied())
            .collect();
        src.value_meta
            .get("tags")
            .map(|meta| {
                meta.iter()
                    .filter(|(id, _)| used.contains(id))
                    .map(|(&id, t)| (id, t.clone()))
                    .collect()
            })
            .unwrap_or_default()
    };
    if sources.is_empty() {
        return Ok(CopyToMapResult {
            copied: 0,
            skipped: 0,
            target_name,
        });
    }

    let used_tags = |fresh: &[Location]| -> Vec<(u32, ValueRecord)> {
        let used: HashSet<u32> = fresh.iter().flat_map(|l| l.tags.iter().copied()).collect();
        used.iter()
            .filter_map(|&id| source_tags.get(&id).map(|r| (id, r.clone())))
            .collect()
    };

    if mgr.stores.contains_key(&target_map_id) {
        // Target open in some window: insert through the import path (reconcile,
        // id alloc, counts, field defs, undo, render cells) and emit the resulting
        // MutationResult. The receiving window applies it via the same mutate() flow
        // as a local edit - including the save - so we do NOT persist here.
        let target = mgr.store_for_map(&target_map_id)?;
        let t_scan = Instant::now();
        let existing = target.collect(&Selector::Everything);
        let (fresh, skipped) = split_new_locations(sources, &existing);
        let scan_ms = t_scan.elapsed().as_millis();
        let copied = fresh.len() as u32;
        if copied > 0 {
            let tags = used_tags(&fresh);
            let t_add = Instant::now();
            let result = import::add_copied_to_store(target, fresh, tags)?;
            log::debug!(
                "[cmd] copy_to_map open-target scan={}ms add={}ms total={}ms",
                scan_ms,
                t_add.elapsed().as_millis(),
                _t.elapsed().as_millis()
            );
            crate::emit_event(ExternalMutation {
                result,
                map_id: target_map_id.clone(),
            });
        }
        return Ok(CopyToMapResult {
            copied,
            skipped,
            target_name,
        });
    }

    // Target closed: append to the uncommitted delta sidecar (what autosave writes).
    let t_read = Instant::now();
    let existing = read_full_state_from_disk(&target_map_id)?;
    let read_ms = t_read.elapsed().as_millis();
    let (mut fresh, skipped) = split_new_locations(sources, &existing);
    let copied = fresh.len() as u32;
    if copied > 0 {
        let mut target_tags = read_tags_json(&conn, &target_map_id);
        let data_max = existing
            .iter()
            .flat_map(|l| l.tags.iter().copied())
            .max()
            .unwrap_or(0);
        let (remap, _) = reconcile_values_by_name(&used_tags(&fresh), &mut target_tags, data_max);
        for loc in &mut fresh {
            loc.tags = loc
                .tags
                .iter()
                .filter_map(|t| remap.get(t).copied())
                .collect();
        }

        // Register any extra-field defs the copies introduce. `persist_field_defs`
        // skips keys the target already defines, so an empty known-set is safe.
        {
            let extras: Vec<&RawExtra> = fresh.iter().filter_map(|l| l.extra.as_ref()).collect();
            if let Some(defs) = maps::infer_field_defs(|_| false, &extras) {
                maps::persist_field_defs(&conn, &target_map_id, &defs)?;
            }
        }

        let t_hist = Instant::now();
        let (undo, redo) = load_edit_history(&target_map_id)?;
        let hist_ms = t_hist.elapsed().as_millis();
        let base_max = existing.iter().map(|l| l.id).max().unwrap_or(0);
        let next = seed_next_id(base_max, &[], &undo, &redo);
        for (loc, id) in fresh.iter_mut().zip(next..) {
            loc.id = id;
        }
        let t_save = Instant::now();
        let delta_path = storage::arrow_delta_path(&target_map_id)?;
        let mut delta: Overlay = if delta_path.exists() {
            rmp_serde::from_slice(&fs::read(&delta_path)?)?
        } else {
            Overlay::default()
        };
        delta.adds.extend(fresh);
        let bytes = rmp_serde::to_vec_named(&delta)?;
        let alive = existing.len() + copied as usize;
        let mut pending = storage::map_pending(&conn, &target_map_id)?;
        pending.added += copied;
        persist_dirty(
            &target_map_id,
            Some(bytes),
            alive,
            pending,
            Some(serialize_tags_json(&target_tags)),
        )?;
        log::debug!(
            "[cmd] copy_to_map closed-target read={}ms history={}ms save={}ms total={}ms",
            read_ms,
            hist_ms,
            t_save.elapsed().as_millis(),
            _t.elapsed().as_millis()
        );
    }
    Ok(CopyToMapResult {
        copied,
        skipped,
        target_name,
    })
}

/// Save uncommitted changes to disk. No-op when nothing has changed.
#[tauri::command]
#[specta::specta]
pub async fn store_save_dirty(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<SaveResult> {
    let _t = Instant::now();
    log::debug!("[cmd] store_save_dirty ENTER");
    // The snapshot carries the revision it serialized, so the store can be told exactly
    // what disk holds once the write lands, however many edits arrived meanwhile.
    // (Value metadata is not here: it persists write-through at the edit.)
    let (map_id, delta, alive, pending) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_window(&label.0)?;
        let map_id = store.map_id.clone().ok_or("no map open")?;
        if !store.overlay.is_unsaved() {
            return Ok(SaveResult { saved_bytes: 0 });
        }
        let delta = overlay_delta_bytes(&store.overlay).map(|b| store.overlay.stamp(b))?;
        (
            map_id,
            delta,
            *store.alive_count,
            store.overlay_diff_counts().into(),
        )
    };

    let size = delta.value().len();
    let delta_rev = delta.rev();
    let map_id2 = map_id.clone();
    task::spawn_blocking(move || {
        persist_dirty(&map_id2, Some(delta.into_value()), alive, pending, None)
    })
    .await
    .unwrap_or_else(|e| Err(e.into()))?;

    // The window may have closed or switched maps during the write; the map_id check
    // stops a fresh store from being marked saved by a stale write.
    let mut mgr = state.lock()?;
    if let Ok(store) = mgr.store_for_window(&label.0) {
        if store.map_id.as_deref() == Some(map_id.as_str()) {
            store.overlay.saved_at(delta_rev);
        }
    }

    log::debug!(
        "[cmd] store_save_dirty total={}ms size={}",
        _t.elapsed().as_millis(),
        size
    );
    Ok(SaveResult { saved_bytes: size })
}

/// Return the map's current location count, store version, and unsaved-change count.
#[tauri::command]
#[specta::specta]
pub fn store_get_summary(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<SummaryResult> {
    let _t = Instant::now();
    with_store!(label, state, |store| {
        let count = *store.alive_count;
        log::debug!(
            "[cmd] store_get_summary total={}ms alive_count={}",
            _t.elapsed().as_millis(),
            count
        );
        Ok(SummaryResult {
            location_count: count,
            version: store.version,
            dirty_count: usize::from(store.overlay.is_unsaved()),
        })
    })
}

/// Rebuild all marker render data from scratch and return the file path to fetch it from.
#[tauri::command]
#[specta::specta]
pub async fn store_fill_render_file(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    req: RenderRequest,
) -> AppResult<String> {
    let (buf, map_id_str) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_window(&label.0)?;
        store.render.arrow_style = req.marker_style == "arrow";
        if let Some(mc) = req.marker_color {
            store.render.marker_color = mc;
        }
        let mid = store.map_id.clone().unwrap_or_default();
        (build_cell_render_buffers(store, &req), mid)
    };
    let path = storage::temp_dir()?.join(format!("mma_render_{map_id_str}.bin"));
    task::spawn_blocking(move || {
        fs::write(&path, &buf)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await?
}

/// Resolve a marker pick (cell key + index within cell) to a location ID.
#[tauri::command]
#[specta::specta]
pub fn store_resolve_pick(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    cell: String,
    cell_index: u32,
) -> AppResult<Option<u32>> {
    with_store!(label, state, |store| {
        let ci = cell_idx_from_key(&cell).ok_or("invalid cell key")?;
        Ok(store.render.cells[ci as usize]
            .as_ref()
            .and_then(|cr| cr.id_order.get(cell_index as usize).copied()))
    })
}

/// Undo the last edit.
#[tauri::command]
#[specta::specta]
pub async fn store_undo(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<MutationResult> {
    with_store!(label, state, |store| {
        let _t = Instant::now();
        let entry = store.edits.edit().undo.pop().ok_or("nothing to undo")?;
        log::debug!(
            "[UNDO] stack_depth={} created={} removed={}",
            store.edits.undo.len(),
            entry.created.len(),
            entry.removed.len()
        );
        let changes = store.apply_edit_reverse(&entry);
        log::debug!(
            "[UNDO] apply_edit={}ms changes: +{} ~{} -{}",
            _t.elapsed().as_millis(),
            changes.added.len(),
            changes.updated.len(),
            changes.removed.len()
        );
        store.edits.edit().redo.push(entry);
        Ok(store.finish_mutation(&changes))
    })
}

/// Redo the last undone edit.
#[tauri::command]
#[specta::specta]
pub async fn store_redo(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<MutationResult> {
    with_store!(label, state, |store| {
        let _t = Instant::now();
        let entry = store.edits.edit().redo.pop().ok_or("nothing to redo")?;
        log::debug!(
            "[REDO] stack_depth={} created={} removed={}",
            store.edits.redo.len(),
            entry.created.len(),
            entry.removed.len()
        );
        let changes = store.apply_edit_forward(&entry);
        log::debug!(
            "[REDO] apply_edit={}ms changes: +{} ~{} -{}",
            _t.elapsed().as_millis(),
            changes.added.len(),
            changes.updated.len(),
            changes.removed.len()
        );
        store.push_undo(entry);
        Ok(store.finish_mutation(&changes))
    })
}

/// Return the uncommitted change counts (added, removed, modified) since the last commit.
// Derived from the overlay, not the undo stack: the stack is capped, and non-undoable edits
// (enrichment, field renames, plugin batches) bypass it while still being part of the commit.
#[tauri::command]
#[specta::specta]
pub fn store_commit_diff(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<(u32, u32, u32)> {
    with_store!(label, state, |store| { Ok(store.overlay_diff_counts()) })
}

/// Replace all active selections and resolve them against current data. Returns
/// per-selection counts and a bitmask for the marker overlay.
#[tauri::command]
#[specta::specta]
pub async fn store_sync_selections(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    sels: Vec<SelectionInput>,
) -> AppResult<SelectionSync> {
    let _t = Instant::now();
    let (counts, buf, selected_count, num_cells) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_window(&label.0)?;

        // Faithful tree: real keys preserved so per-node counts come back keyed (incl. nested).
        let sels_full: Vec<Selection> = sels.iter().map(|si| si.selection.clone()).collect();

        // 1. Resolve the whole forest in one pass: per-selection Roaring id-sets plus
        //    counts for every node (top-level and nested). Indexed filter leaves clone
        //    postings; composites combine natively. (Geometric leaves still scan.)
        //    Counts cover ghosted selections too; the overlay uses the non-ghosted subset.
        let (sel_sets, counts) = store.resolve_forest(&sels_full);

        // 2. Keep every selection, ghosted flagged: a mutation recounts all of them, and
        //    `SelectionState::live` is the one rule that keeps ghosted out of the overlay
        //    and the selected set.
        store.selections.resolved =
            pair_selections(sels_full, sel_sets, sels.iter().map(|si| si.ghosted));

        let all_selected = store.selections.live_ids();
        let selected_count = all_selected.len() as usize;

        // 3. Route selections to per-cell indices (O(selected), not O(S*N)), then
        //    serialize the per-cell bitmask binary.
        let render_total = store.render.total_len();
        let live: Vec<&ResolvedSelection> = store.selections.live().collect();
        let (buf, num_cells) = build_selection_buf(&store.render, &live);

        store.selections.ids = all_selected;
        store.selections.node_counts = counts.clone();
        store.selections.version += 1;

        log::debug!("[cmd] store_sync_selections total={}ms sels={} selected={} cells={} buf_size={} batch_rows={} overlay_adds={} dead={} alive={} render_total={} first_set_len={} counts={:?}",
            _t.elapsed().as_millis(), sels.len(), selected_count, num_cells, buf.len(),
            store.batch.as_ref().map_or(0, RecordBatch::num_rows), store.overlay.adds.len(),
            store.overlay.dead.len(), *store.alive_count, render_total,
            store.selections.resolved.first().map_or(0, |r| r.set.len() as usize), counts);

        (counts, buf, selected_count, num_cells)
    };

    let bitmask = if num_cells > 0 { Some(buf) } else { None };
    Ok(SelectionSync {
        counts,
        bitmask,
        selected_count,
    })
}

/// Ids of every location the selector resolves to, ascending.
#[tauri::command]
#[specta::specta]
pub fn store_resolve(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
) -> AppResult<Vec<u32>> {
    selector_read!(label, state, selector, |scope| match &selector {
        Selector::Ranked {
            expr, ascending, ..
        } => scope.ranked(expr, None, *ascending),
        _ => scope.rows().map(|row| row.id()).collect(),
    })
}

/// Count how many locations the selector matches.
#[tauri::command]
#[specta::specta]
pub fn store_count(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
) -> AppResult<u32> {
    selector_read!(label, state, selector, |scope| scope.rows().count() as u32)
}

/// `n` ids drawn uniformly at random from the selected set, without replacement.
#[tauri::command]
#[specta::specta]
pub fn store_sample(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    n: u32,
) -> AppResult<Vec<u32>> {
    selector_read!(label, state, selector, |scope| scope.sample(n as usize))
}

/// An evenly spaced subset: exactly one of `targetCount` (thin to N, maximizing
/// spacing) or `minDistanceM` (keep as many as fit at that spacing).
#[tauri::command]
#[specta::specta]
pub fn store_spaced(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    target_count: Option<u32>,
    min_distance_m: Option<f64>,
) -> AppResult<SpacedPickResult> {
    selector_read!(label, state, selector, |scope| pick_spaced(
        scope.points(),
        target_count,
        min_distance_m
    )?)
}

/// An evenly spaced subset laid out on a honeycomb: exactly one of `targetCount` (at most
/// N, spaced as widely as that allows) or `spacingM` (about that far apart, and never
/// closer than half of it).
#[tauri::command]
#[specta::specta]
pub fn store_evenly_spaced(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    target_count: Option<u32>,
    spacing_m: Option<f64>,
) -> AppResult<SpacedPickResult> {
    selector_read!(label, state, selector, |scope| pick_even(
        &scope.points(),
        target_count,
        spacing_m
    )?)
}

/// One row of honeycomb points: `count` points from `lng` eastward, each `lngStep` degrees
/// apart.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HoneycombRun {
    pub lat: f64,
    pub lng: f64,
    pub lng_step: f64,
    pub count: u32,
}

/// The points of a honeycomb about `spacingM` metres apart that fall inside the polygon,
/// one entry per row of points.
#[tauri::command]
#[specta::specta]
pub async fn honeycomb_points(
    polygon: selections::PolygonGeometry,
    spacing_m: f64,
) -> AppResult<Vec<HoneycombRun>> {
    if !(spacing_m.is_finite() && spacing_m >= 1.0) {
        return Err(AppError::from(
            "honeycomb_points: spacing_m must be at least 1 metre",
        ));
    }
    let polygons: Vec<Vec<Vec<[f64; 2]>>> = polygon.parts().map(<[_]>::to_vec).collect();
    let mut bb = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    let mut any = false;
    for outer in polygons.iter().filter_map(|p| p.first()) {
        mma_geo::extend_bbox_with_ring(&mut bb, &mut any, outer);
    }
    if !any {
        return Ok(Vec::new());
    }
    let grid = mma_geo::HexGrid::new(
        (bb[1] + bb[3]) / 2.0,
        mma_geo::fold_lng((bb[0] + bb[2]) / 2.0, -180.0),
        spacing_m,
    );
    let mut runs = Vec::new();
    grid.for_each_run(&polygons, |lat, lng, lng_step, count| {
        runs.push(HoneycombRun {
            lat,
            lng,
            lng_step,
            count,
        })
    });
    Ok(runs)
}

/// Up to `count` points drawn uniformly at random inside the polygon, as `[lng, lat]`
/// pairs. Fewer come back when the polygon fills little of its bounding box.
#[tauri::command]
#[specta::specta]
pub async fn polygon_random_points(
    polygon: selections::PolygonGeometry,
    count: u32,
) -> Vec<[f64; 2]> {
    mma_geo::random_points(&polygon.prepared(), count as usize, || fastrand::f64())
}

/// Points covering the polygon with no two closer than `spacingM` metres and no gap
/// wider than about twice that, in random order.
#[tauri::command]
#[specta::specta]
pub async fn polygon_poisson_points(
    polygon: selections::PolygonGeometry,
    spacing_m: f64,
) -> AppResult<Vec<[f64; 2]>> {
    if !(spacing_m.is_finite() && spacing_m >= 1.0) {
        return Err(AppError::from(
            "polygon_poisson_points: spacing_m must be at least 1 metre",
        ));
    }
    Ok(mma_geo::poisson_points(
        &polygon.prepared(),
        spacing_m,
        || fastrand::f64(),
    ))
}

/// Whether each of the points sits inside the polygon.
#[tauri::command]
#[specta::specta]
pub async fn polygon_contains_points(
    polygon: selections::PolygonGeometry,
    lats: Vec<f64>,
    lngs: Vec<f64>,
) -> AppResult<Vec<bool>> {
    if lats.len() != lngs.len() {
        return Err(AppError::from(
            "polygon_contains_points: lats and lngs must be the same length",
        ));
    }
    let prepared = polygon.prepared();
    Ok(lats
        .iter()
        .zip(&lngs)
        .map(|(&lat, &lng)| prepared.contains(lng, lat))
        .collect())
}

/// Bounding box `[west, south, east, north]` of the polygon itself, or `null` when it
/// has no vertices. `west > east` means the box crosses the antimeridian.
#[tauri::command]
#[specta::specta]
pub async fn polygon_bounds(polygon: selections::PolygonGeometry) -> Option<[f64; 4]> {
    Some(crossing_bounds(polygon.prepared().bbox()?))
}

/// An anchored bbox in the crossing form: both edges in [-180, 180), `west > east` when
/// the box spans the antimeridian, the whole world when the span reaches a full turn
/// (folding both edges of that box would collapse it to zero width).
fn crossing_bounds([w, s, e, n]: [f64; 4]) -> [f64; 4] {
    if e - w >= 360.0 {
        return [-180.0, s, 180.0, n];
    }
    [
        mma_geo::fold_lng(w, -180.0),
        s,
        mma_geo::fold_lng(e, -180.0),
        n,
    ]
}

#[cfg(test)]
#[path = "commands.test.rs"]
mod tests;

/// Group by a derived key, returning `{ key, ids, bin }` per group.
#[tauri::command]
#[specta::specta]
pub fn store_group_by(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    field: String,
    key: selections::KeySpec,
) -> AppResult<Vec<selections::PartitionBucket>> {
    selector_read!(label, state, selector, |scope| scope
        .partition(&field, &key))
}

/// Group locations by a derived key, returning counts only (no member ids) and how many
/// distinct locations those groups cover.
#[tauri::command]
#[specta::specta]
pub fn store_count_by(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    field: String,
    key: selections::KeySpec,
) -> AppResult<selections::CountBy> {
    selector_read!(label, state, selector, |scope| scope.count_by(&field, &key))
}

/// Distinct values of `field` across the selected set, sorted.
#[tauri::command]
#[specta::specta]
pub fn store_values(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    field: String,
) -> AppResult<Vec<String>> {
    selector_read!(label, state, selector, |scope| scope
        .distinct_values(&field))
}

/// How many rows hold a value for each field, key-sorted: `extra` keys and the built-in
/// columns a row can lack.
#[tauri::command]
#[specta::specta]
pub fn store_coverage(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
) -> AppResult<Vec<(String, u32)>> {
    with_store!(label, state, |store| { Ok(store.coverage(&selector)) })
}

/// Per-field columns of the selected set. One value per row per field, `null` where a
/// row lacks it; `"tags"` is a column of tag-id arrays.
#[derive(serde::Serialize, specta::Type)]
#[serde(transparent)]
pub struct Columns(
    #[specta(type = Vec<Vec<specta_typescript::Unknown>>)] pub Vec<Vec<serde_json::Value>>,
);

/// Read specific fields across matched locations, returned as one column per field.
#[tauri::command]
#[specta::specta]
pub fn store_columns(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    fields: Vec<String>,
) -> AppResult<Columns> {
    selector_read!(label, state, selector, |scope| Columns(
        scope.columns(&fields)
    ))
}

/// Bounding box `[west, south, east, north]`, or `null` when the set is empty.
#[tauri::command]
#[specta::specta]
pub fn store_bounds(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
) -> AppResult<Option<[f64; 4]>> {
    // The whole-map box is maintained incrementally; narrower ones scan.
    if matches!(selector, Selector::Everything) {
        return with_store!(label, state, |store| { Ok(store.cached_bounds()) });
    }
    selector_read!(label, state, selector, |scope| scope
        .bounds()
        .map(BoundsAcc::resolve))
}

/// Collect all matched locations as full rows. Prefer a projection (`storeColumns`,
/// `storeValues`) when only specific fields are needed.
#[tauri::command]
#[specta::specta]
pub fn store_collect(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
) -> AppResult<Rows> {
    with_store!(label, state, |store| {
        let locations = store.collect(&selector);
        if locations.len() <= ROWS_INLINE_MAX {
            return Ok(Rows::Inline { locations });
        }
        let map_id_str = store.map_id.as_deref().unwrap_or("default");
        let path = rows_file_path(&storage::temp_dir()?, map_id_str);
        fs::write(&path, serde_json::to_vec(&locations)?)?;
        Ok(Rows::File {
            path: path.to_string_lossy().into_owned(),
        })
    })
}

/// Find groups of locations within `distance` metres of each other (transitive).
/// Returns groups of IDs, each with at least two members.
#[tauri::command]
#[specta::specta]
pub fn store_duplicate_groups(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    distance: f64,
) -> AppResult<Vec<Vec<u32>>> {
    with_store!(label, state, |store| {
        Ok(store.all().duplicate_groups(distance))
    })
}

/// Merge each duplicate group within `distance` metres into one location, unioning tags
/// and extra fields. `score` ranks which location survives; blank uses the default ranking.
/// Undoable.
// Extra merges survivor-wins.
#[tauri::command]
#[specta::specta]
pub async fn store_merge_duplicates(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    distance: f64,
    score: Option<String>,
) -> AppResult<MutationResult> {
    let _t = Instant::now();
    let score = selections::parse_duplicate_score(score.as_deref())?;
    with_store!(label, state, |store| {
        let groups = store.all().duplicate_groups(distance);

        let mut remove: Vec<Location> = Vec::new();
        let mut create: Vec<Location> = Vec::new();

        for group in &groups {
            let members: Vec<Location> = group
                .iter()
                .filter_map(|&id| store.get_loc_by_id(id))
                .collect();
            if members.len() < 2 {
                continue;
            }
            create.push(merge_group(&members, &score));
            for m in members {
                remove.push(m);
            }
        }

        log::debug!(
            "[cmd] store_merge_duplicates groups={} merged_away={} total={}ms",
            create.len(),
            remove.len().saturating_sub(create.len()),
            _t.elapsed().as_millis()
        );
        Ok(store.apply_undoable(remove, create))
    })
}

/// Remove duplicate locations within `distance` metres of each other, keeping the
/// best-scored survivor per cluster. Undoable.
// <= 25m: best-scored per cluster; > 25m: greedy thinning so no two survivors remain in
// range.
#[tauri::command]
#[specta::specta]
pub async fn store_prune_duplicates(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    distance: f64,
    score: Option<String>,
) -> AppResult<MutationResult> {
    let _t = Instant::now();
    let score = selections::parse_duplicate_score(score.as_deref())?;
    with_store!(label, state, |store| {
        let locs: Vec<Location> = store.collect(&selector);
        let prune_ids: HashSet<u32> = selections::prune_duplicates(&locs, distance, &score)
            .into_iter()
            .collect();
        let total = locs.len();
        let remove: Vec<Location> = locs
            .into_iter()
            .filter(|l| prune_ids.contains(&l.id))
            .collect();

        log::debug!(
            "[cmd] store_prune_duplicates pruned={} of {} total={}ms",
            remove.len(),
            total,
            _t.elapsed().as_millis()
        );
        Ok(store.apply_undoable(remove, Vec::new()))
    })
}

/// Find all locations within `radiusM` metres of (`lat`, `lng`).
// Lazy spatial index: O(cells in radius) per query after a one-time O(N) build, maintained
// incrementally. Called on every marker click (duplicate check), so it must not scan.
#[tauri::command]
#[specta::specta]
pub fn store_find_nearby(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    lat: f64,
    lng: f64,
    radius_m: f64,
) -> AppResult<Vec<Location>> {
    with_store!(label, state, |store| {
        let _t = Instant::now();
        let mut ids = store.find_nearby_ids(lat, lng, radius_m);
        ids.sort_unstable();
        let result: Vec<Location> = ids
            .iter()
            .filter_map(|&id| store.get_loc_by_id(id))
            .collect();
        log::debug!(
            "[cmd] store_find_nearby r={}m hits={} total={}ms",
            radius_m,
            result.len(),
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// The location closest to a coordinate, or null when the map has none.
#[tauri::command]
#[specta::specta]
pub fn store_find_nearest(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    lat: f64,
    lng: f64,
) -> AppResult<Option<Location>> {
    with_store!(label, state, |store| {
        Ok(store
            .find_nearest_id(lat, lng)
            .and_then(|id| store.get_loc_by_id(id)))
    })
}

/// For each input point, whether any existing location lies within `radiusM` metres.
/// Batch form for probing many coordinates at once.
#[tauri::command]
#[specta::specta]
pub fn store_near_any(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    lats: Vec<f64>,
    lngs: Vec<f64>,
    radius_m: f64,
) -> AppResult<Vec<bool>> {
    if lats.len() != lngs.len() {
        return Err(AppError::from("store_near_any: lats/lngs length mismatch"));
    }
    with_store!(label, state, |store| {
        let _t = Instant::now();
        let result: Vec<bool> = lats
            .iter()
            .zip(lngs.iter())
            .map(|(&la, &ln)| store.any_within(la, ln, radius_m))
            .collect();
        log::debug!(
            "[cmd] store_near_any n={} r={}m total={}ms",
            result.len(),
            radius_m,
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}
