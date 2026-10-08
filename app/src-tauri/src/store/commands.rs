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
use mma_algebra::Patch;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;
use tauri::ipc::Channel;
use tokio::task;

/// Open a map and return its initial state (per-value counts, metadata, undo/redo availability).
/// Must be called before any other store commands.
#[tauri::command]
#[specta::specta]
pub async fn store_open_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    map_id: String,
) -> AppResult<StoreStatus> {
    // Claim the window binding before the unlocked read, so a concurrent checkout's
    // open-elsewhere guard sees this open from its first moment.
    state
        .lock()?
        .window_map
        .insert(label.0.clone(), map_id.clone());
    let opened = open_claimed_map(&label, &state, map_id.clone()).await;
    if opened.is_err() {
        if let Ok(mut mgr) = state.lock() {
            if mgr.window_map.get(&label.0) == Some(&map_id) {
                mgr.window_map.remove(&label.0);
            }
        }
    }
    opened
}

async fn open_claimed_map(
    label: &WindowLabel,
    state: &tauri::State<'_, StoreState>,
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
            delta_legacy::convert_msgpack_delta(&delta_path, &path)?;
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

        let conn = storage::open_db()?;
        let edits = load_edit_history(&conn, &map_id2)?;
        let history_max = stored_history_max_id(&conn, &map_id2)?;

        log::debug!("[store_open] TOTAL={}ms", t_total.elapsed().as_millis());
        Ok::<_, AppError>((batch, mmap_handle, max_id, edits, history_max, delta))
    })
    .await??;

    let (batch, mmap_handle, max_id, edits, history_max, delta) = result;

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
    store.next_id = seed_next_id(max_id, &store.overlay.adds, history_max);

    let LocationAggregates { alive, bounds } = store.scan_locations();
    store.alive_count = Tracked::new(alive);
    store.bounds.seed(At::new(store.version, bounds));
    {
        let conn = storage::open_db()?;
        storage::set_map_counts(&conn, &map_id, alive, store.overlay_diff_counts())?;
        let meta = maps::read_map_meta(&conn, &map_id)?;
        store
            .value_meta
            .insert("tags".into(), Tracked::new(meta.tags.0));
        store.field_defs = Tracked::new(meta.extra.fields.unwrap_or_default());
    }
    store.edits = Tracked::new(edits);

    let status = store.open_status();
    let mut mgr = state.lock()?;
    store.derived = mgr.derived.clone();
    mgr.window_map.insert(label.0.clone(), map_id.clone());
    if let Some(replaced) = mgr.stores.remove(&map_id) {
        store.adopt_watchers(replaced);
    }
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
    let Some((map_id, store)) = state.lock()?.unbind_window(&label.0) else {
        return Ok(());
    };
    task::spawn_blocking(move || flush_closed_store(&map_id, &store)).await?
}

/// Close a window's map binding when its webview goes away without a proper close.
pub fn release_window_binding(app: &tauri::AppHandle, label: &str) {
    let Some(state) = tauri::Manager::try_state::<StoreState>(app) else {
        return;
    };
    let unbound = state
        .lock()
        .ok()
        .and_then(|mut mgr| mgr.unbind_window(label));
    if let Some((map_id, store)) = unbound {
        if let Err(e) = flush_closed_store(&map_id, &store) {
            log::error!("[close_map] flush for released window '{label}' failed: {e} ({map_id})");
        }
    }
}

/// Edit rows where `target` says. Edits at a pending layer are held there until one says
/// `land`; once landed they write through and join its step.
#[tauri::command]
#[specta::specta]
pub fn store_edit(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    target: Target,
    edits: Vec<Edit>,
    opts: Option<EditOpts>,
) -> AppResult<MutationResult> {
    let _t = Instant::now();
    with_store!(label, state, |store| {
        let opts = opts.unwrap_or_default();
        let result = store.edit(&target, edits, opts.land, &mut None);
        log::debug!("[cmd] store_edit total={}ms", _t.elapsed().as_millis());
        Ok(result)
    })
}

/// The row at `id` as `target` sees it.
#[tauri::command]
#[specta::specta]
pub fn store_row(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    target: Target,
    id: u32,
) -> AppResult<Option<Location>> {
    with_store!(label, state, |store| { Ok(store.row_at(&target, id)) })
}

/// Drop a named pending layer and everything it holds.
#[tauri::command]
#[specta::specta]
pub fn store_drop(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    name: String,
) -> AppResult<()> {
    with_store!(label, state, |store| {
        store.drop_pending(&name);
        Ok(())
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
        task::spawn_blocking(move || export::read_uploaded_chunks::<Location>(&session_dir))
            .await??;
    let _read = _t.elapsed().as_millis();
    with_store!(label, state, |store| {
        let n = locations.len();
        let edits = locations
            .into_iter()
            .map(|mut l| {
                l.id = 0;
                Edit::Set(l)
            })
            .collect();
        let result = store.edit(&Target::Map, edits, false, &mut None);
        log::debug!(
            "[cmd] store_add_locations_uploaded n={} read={}ms total={}ms",
            n,
            _read,
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// Declare which fields are computed from which: each input field and the fields derived
/// from it. A write that changes an input clears what was derived from it.
#[tauri::command]
#[specta::specta]
pub fn store_set_derived(
    state: tauri::State<'_, StoreState>,
    edges: HashMap<String, Vec<String>>,
) -> AppResult<()> {
    let mut mgr = state.lock()?;
    mgr.derived = Arc::new(edges);
    let derived = mgr.derived.clone();
    for store in mgr.stores.values_mut() {
        store.derived = derived.clone();
    }
    Ok(())
}

/// Run work over every location matched by `selector`, landing the edits it derives.
#[tauri::command]
#[specta::specta]
pub async fn store_work(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    work: Work,
    record_undo: Option<bool>,
) -> AppResult<WorkResult> {
    let _t = Instant::now();
    with_store!(label, state, |store| {
        let result = apply_work(store, &selector, &work, record_undo.unwrap_or(true))?;
        log::debug!("[cmd] store_work total={}ms", _t.elapsed().as_millis());
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
    let coords: AppResult<Vec<(f64, f64)>> = with_store!(label, state, |store| {
        Ok(store
            .scope(&selector)
            .rows()
            .map(|row| (row.lat(), row.lng()))
            .collect())
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
        // id alloc, counts, field defs, undo, render cells). The change feed tells the
        // receiving window, whose save scheduling follows it - so we do NOT persist here.
        let target = mgr.store_for_map(&target_map_id)?;
        let t_scan = Instant::now();
        let existing = target.collect(&Selector::Everything);
        let (fresh, skipped) = split_new_locations(sources, &existing);
        let scan_ms = t_scan.elapsed().as_millis();
        let copied = fresh.len() as u32;
        if copied > 0 {
            let tags = used_tags(&fresh);
            let t_add = Instant::now();
            import::add_copied_to_store(target, fresh, tags)?;
            log::debug!(
                "[cmd] copy_to_map open-target scan={}ms add={}ms total={}ms",
                scan_ms,
                t_add.elapsed().as_millis(),
                _t.elapsed().as_millis()
            );
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
        let mut target_tags = maps::read_map_meta(&conn, &target_map_id)?.tags.0;
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
        let history_max = stored_history_max_id(&conn, &target_map_id)?;
        let hist_ms = t_hist.elapsed().as_millis();
        let base_max = existing.iter().map(|l| l.id).max().unwrap_or(0);
        let next = seed_next_id(base_max, &[], history_max);
        for (loc, id) in fresh.iter_mut().zip(next..) {
            loc.id = id;
        }
        let t_save = Instant::now();
        let delta_path = storage::arrow_delta_path(&target_map_id)?;
        let (mut created, removed) = if delta_path.exists() {
            arrow::batch_to_delta(&arrow::read_arrow_ipc(&delta_path)?)
        } else {
            Default::default()
        };
        created.extend(fresh);
        arrow::write_arrow_ipc(&delta_path, &arrow::delta_to_batch(&created, &removed))?;
        let mut pending = storage::map_pending(&conn, &target_map_id)?;
        pending.added += copied;
        storage::set_map_counts(
            &conn,
            &target_map_id,
            existing.len() + copied as usize,
            pending,
        )?;
        storage::update_row::<maps::MapMeta>(
            &conn,
            "maps",
            &target_map_id,
            &Patch::<maps::MapMeta> {
                id: target_map_id.clone(),
                tags: Some(maps::TagRecords(target_tags)),
                ..Default::default()
            },
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
) -> AppResult<()> {
    let _t = Instant::now();
    log::debug!("[cmd] store_save_dirty ENTER");
    // The snapshot carries the revision it serialized, so the store can be told exactly
    // what disk holds once the write lands, however many edits arrived meanwhile.
    // (Value metadata is not here: it persists write-through at the edit.)
    let (map_id, unsaved) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_window(&label.0)?;
        let map_id = store.map_id.clone().ok_or("no map open")?;
        let Some(unsaved) = store.unsaved()? else {
            return Ok(());
        };
        (map_id, unsaved)
    };

    let map_id2 = map_id.clone();
    let unsaved = task::spawn_blocking(move || {
        let delta_path = storage::arrow_delta_path(&map_id2)?;
        unsaved.write(&storage::open_db()?, &map_id2, &delta_path)?;
        Ok::<_, AppError>(unsaved)
    })
    .await
    .unwrap_or_else(|e| Err(e.into()))?;

    // The window may have closed or switched maps during the write; the map_id check
    // stops a fresh store from being marked saved by a stale write.
    let mut mgr = state.lock()?;
    if let Ok(store) = mgr.store_for_window(&label.0) {
        if store.map_id.as_deref() == Some(map_id.as_str()) {
            store.saved(&unsaved);
        }
    }

    log::debug!(
        "[cmd] store_save_dirty total={}ms",
        _t.elapsed().as_millis()
    );
    Ok(())
}

/// Draw the open map's markers: `frames` receives the whole scene, then every change to it.
#[tauri::command]
#[specta::specta]
pub async fn store_subscribe_frames(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    frames: Channel<FrameBytes>,
    req: RenderRequest,
) -> AppResult<()> {
    let mut mgr = state.lock()?;
    let map_id = mgr.map_id_for_window(&label.0)?;
    for (id, store) in &mut mgr.stores {
        if *id != map_id {
            store.frames.remove(&label.0);
        }
    }
    mgr.store_for_map(&map_id)?
        .subscribe_frames(label.0, frames, &req);
    Ok(())
}

/// Hear every change to the open map's rows: `changes` receives the ids each landed
/// change created, deleted and rewrote, whatever caused it.
#[tauri::command]
#[specta::specta]
pub async fn store_subscribe_changes(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    changes: Channel<ChangeEvent>,
) -> AppResult<()> {
    let mut mgr = state.lock()?;
    let map_id = mgr.map_id_for_window(&label.0)?;
    for (id, store) in &mut mgr.stores {
        if *id != map_id {
            store.changes.remove(&label.0);
        }
    }
    mgr.store_for_map(&map_id)?.changes.insert(label.0, changes);
    Ok(())
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
        let map_id = store.map_id.clone().unwrap_or_default();
        let changes = store
            .undo(|seq| load_edit(&storage::open_db()?, &map_id, seq))?
            .ok_or("nothing to undo")?;
        log_history_step("UNDO", _t, store.edits.undo_len(), &changes);
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
        let map_id = store.map_id.clone().unwrap_or_default();
        let changes = store
            .redo(|seq| load_edit(&storage::open_db()?, &map_id, seq))?
            .ok_or("nothing to redo")?;
        log_history_step("REDO", _t, store.edits.redo_len(), &changes);
        Ok(store.finish_mutation(&changes))
    })
}

fn log_history_step(step: &str, started: Instant, depth: usize, changes: &Change) {
    log::debug!(
        "[{step}] stack_depth={depth} apply_edit={}ms changes: +{} ~{} -{}",
        started.elapsed().as_millis(),
        changes.added.len(),
        changes.updated.len(),
        changes.removed.len()
    );
}

/// Return the uncommitted change counts since the last commit.
// Derived from the overlay, not the undo stack: the stack is capped, and non-undoable edits
// (enrichment, field renames, plugin batches) bypass it while still being part of the commit.
#[tauri::command]
#[specta::specta]
pub fn store_commit_diff(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<mma_algebra::Counts> {
    with_store!(label, state, |store| { Ok(store.overlay_diff_counts()) })
}

/// Replace all active selections and resolve them against current data. Returns
/// per-selection counts; the markers repaint through the render frame.
#[tauri::command]
#[specta::specta]
pub async fn store_sync_selections(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    sels: Vec<ListedSelection>,
) -> AppResult<MutationResult> {
    let _t = Instant::now();
    let mut mgr = state.lock()?;
    let store = mgr.store_for_window(&label.0)?;

    // Faithful tree: real keys preserved so per-node counts come back keyed (incl. nested).
    let sels_full: Vec<Selection> = sels.iter().map(|si| si.selection.clone()).collect();

    // Resolve the whole forest in one pass: per-selection Roaring id-sets plus counts for
    // every node (top-level and nested). Indexed filter leaves clone postings; composites
    // combine natively. (Geometric leaves still scan.) Counts cover ghosted selections too;
    // the overlay uses the non-ghosted subset.
    let (sel_sets, counts) = store.resolve_forest(&sels_full);

    // Keep every selection, ghosted flagged: a mutation recounts all of them, and
    // `SelectionState::live` is the one rule that keeps ghosted out of the overlay and the
    // selected set.
    store.selections.resolved =
        pair_selections(sels_full, sel_sets, sels.iter().map(|si| si.ghosted));
    store.selections.ids = store.selections.live_ids();
    store.selections.node_counts = counts;
    store.selections.version += 1;
    let result = store.finish_selection_change();

    log::debug!(
        "[cmd] store_sync_selections total={}ms sels={} selected={} batch_rows={} overlay_adds={} dead={} alive={} render_total={}",
        _t.elapsed().as_millis(),
        sels.len(),
        store.selections.ids.len(),
        store.batch.as_ref().map_or(0, RecordBatch::num_rows),
        store.overlay.adds.len(),
        store.overlay.dead.len(),
        *store.alive_count,
        store.render.total_len(),
    );
    Ok(result)
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

/// The area a polygon selects, as polygons whose edges never cross, for drawing its fill.
#[tauri::command]
#[specta::specta]
pub async fn polygon_fill(polygon: selections::PolygonGeometry) -> Vec<Vec<Vec<[f64; 2]>>> {
    polygon
        .parts()
        .flat_map(mma_geo::untangle_polygon)
        .collect()
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

/// Answer one question about the rows a selector resolves to, optionally narrowed by a
/// pick first.
#[tauri::command]
#[specta::specta]
pub fn store_read(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    pick: Option<RowPick>,
    ask: Ask,
) -> AppResult<Answer> {
    let _t = Instant::now();
    with_store!(label, state, |store| {
        let answer = store.read(&selector, pick.as_ref(), &ask);
        log::debug!("[cmd] store_read total={}ms", _t.elapsed().as_millis());
        answer
    })
}
