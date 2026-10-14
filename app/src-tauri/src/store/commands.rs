//! Tauri commands over the location store: each takes the window lock, calls the engine,
//! and maps the result. Workflow belongs in the engine or in TS, not here.
#![allow(clippy::needless_pass_by_value)]

use crate::io::{export, import};
use crate::plugins::borders;
use crate::selections::saved::SavedSelection;
use crate::selections::tree::{SelectionInput, SelectionOp};
use crate::selections::{self, Selector};
use crate::store::arrow::schema;
use crate::store::engine::*;
use crate::store::maps::MapMeta;
use crate::store::{arrow, maps, storage};
use crate::types::{AppError, AppResult, Location, RawExtra};
use crate::util;
use crate::util::Rgb;
use arrow_array::{RecordBatch, UInt32Array};
use arrow_select::take;
use mma_algebra::{Edit, Id, Op, Patch, Patchable};
use std::collections::{HashMap, HashSet};
use std::mem;
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
    map_id: Id<MapMeta, String>,
) -> AppResult<StoreStatus> {
    // Claim the window binding before the unlocked read, so a concurrent checkout's
    // open-elsewhere guard sees this open from its first moment.
    state
        .lock()?
        .window_map
        .insert(label.clone(), map_id.clone());
    let opened = open_claimed_map(&label, &state, map_id.clone()).await;
    if opened.is_err() {
        if let Ok(mut mgr) = state.lock() {
            if mgr.window_map.get(&label) == Some(&map_id) {
                mgr.window_map.remove(&label);
            }
        }
    }
    opened
}

async fn open_claimed_map(
    label: &WindowLabel,
    state: &tauri::State<'_, StoreState>,
    map_id: Id<MapMeta, String>,
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
        let max_id = n
            .checked_sub(1)
            .map(|last| Id::new(arrow::Columns::id(&batch).value(last)));

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
    let conn = storage::open_db()?;
    storage::set_map_counts(&conn, &map_id, alive, store.overlay_diff_counts())?;
    store.edits = Tracked::new(edits);

    let mut mgr = state.lock()?;
    let mut meta = maps::read_map_meta(&conn, &map_id)?;
    store
        .value_meta
        .insert("tags".into(), Tracked::new(mem::take(&mut meta.tags)));
    store.meta = Tracked::new(meta);
    let status = store.open_status();
    store.dependents = mgr.providers.dependents();
    mgr.window_map.insert(label.clone(), map_id.clone());
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
    let Some((map_id, store)) = state.lock()?.unbind_window(&label) else {
        return Ok(());
    };
    flush_closed_store(map_id, store).await
}

/// Close a window's map binding when its webview goes away without a proper close.
pub fn release_window_binding(app: &tauri::AppHandle, label: &str) {
    let Some(state) = tauri::Manager::try_state::<StoreState>(app) else {
        return;
    };
    let unbound = state
        .lock()
        .ok()
        .and_then(|mut mgr| mgr.unbind_window(&WindowLabel(label.to_string())));
    if let Some((map_id, store)) = unbound {
        // The webserve release callback runs on a synchronous HTTP worker; wait here so its
        // flush cannot be cancelled when the callback returns and destroys the client webview.
        if let Err(e) = tauri::async_runtime::block_on(flush_closed_store(map_id.clone(), store)) {
            log::error!("[close_map] flush for released window '{label}' failed: {e} ({map_id})");
        }
    }
}

/// Close a pending layer. Edits not yet landed are discarded; work still writing to a landed layer finishes first.
#[tauri::command]
#[specta::specta]
pub fn store_close_layer(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    name: String,
    map_id: Option<Id<MapMeta, String>>,
) -> AppResult<()> {
    let mut manager = state.lock()?;
    let map_id = map_id.or_else(|| manager.window_map.get(&label).cloned());
    let Some(map_id) = map_id else {
        return Ok(());
    };
    if let Some(store) = manager.stores.get_mut(&map_id) {
        store.close_layer(&name);
    }
    Ok(())
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
        let edits = locations.into_iter().map(Op::Add).collect();
        let result = store.edit(&Target::Map, edits, false, &mut None);
        log::debug!(
            "[cmd] store_add_locations_uploaded n={} read={}ms total={}ms",
            n,
            _read,
            _t.elapsed().as_millis()
        );
        Ok(MutationResult { mutation: result })
    })
}

/// Set the default marker color for new render updates.
#[tauri::command]
#[specta::specta]
pub fn store_set_marker_color(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    color: Rgb,
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
    selector: Selector<SelectionInput>,
    level: String,
) -> AppResult<Vec<(String, u32)>> {
    let coords: AppResult<Vec<(f64, f64)>> = with_store!(label, state, |store| {
        Ok(store
            .scope(&selector.map_children(SelectionInput::compile))
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
    target_map_id: Id<MapMeta, String>,
    selector: Selector<SelectionInput>,
) -> AppResult<CopyToMapResult> {
    copy_to_map(label, state, target_map_id, |src| {
        src.collect(
            &Target::Map,
            &selector.map_children(SelectionInput::compile),
        )
    })
}

/// Add caller-supplied locations to another map. Tags are matched by name against this
/// map's tag table.
#[tauri::command]
#[specta::specta]
pub fn store_add_locations_to_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    target_map_id: Id<MapMeta, String>,
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
    target_map_id: Id<MapMeta, String>,
    collect: impl FnOnce(&mut Store) -> Vec<Location>,
) -> AppResult<CopyToMapResult> {
    let _t = Instant::now();
    let conn = storage::open_db()?;

    // The manager lock is held for both paths: it serializes the closed-path
    // delta-file rewrite against a concurrent store_open_map of the same map.
    let mut mgr = state.lock()?;
    let source_map_id = mgr.map_id_for_window(&label)?;
    if source_map_id == target_map_id {
        return Err(AppError("cannot copy a location into its own map".into()));
    }

    let now = util::now_unix();
    let mut sources: Vec<Location> = Vec::new();
    let source_tags: HashMap<Id<ValueRecord>, ValueRecord> = {
        let src = mgr.store_for_map(&source_map_id)?;
        for mut loc in collect(src) {
            loc.created_at = now;
            loc.modified_at = Some(now);
            sources.push(loc);
        }
        let used: HashSet<Id<ValueRecord>> = sources
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
        });
    }

    let used_tags = |fresh: &[Location]| -> Vec<ValueRecord> {
        let used: HashSet<Id<ValueRecord>> =
            fresh.iter().flat_map(|l| l.tags.iter().copied()).collect();
        used.iter()
            .filter_map(|&id| source_tags.get(&id).cloned())
            .collect()
    };

    if mgr.stores.contains_key(&target_map_id) {
        // The import path handles an open target. Its window receives the change feed
        // and schedules autosave.
        let target = mgr.store_for_map(&target_map_id)?;
        let t_scan = Instant::now();
        let existing = target.collect(&Target::Map, &Selector::Everything);
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
        return Ok(CopyToMapResult { copied, skipped });
    }

    // Target closed: append to the uncommitted delta sidecar (what autosave writes).
    let t_read = Instant::now();
    let existing = read_full_state_from_disk(&target_map_id)?;
    let read_ms = t_read.elapsed().as_millis();
    let (mut fresh, skipped) = split_new_locations(sources, &existing);
    let copied = fresh.len() as u32;
    if copied > 0 {
        let target_meta = maps::read_map_meta(&conn, &target_map_id)?;
        let mut target_tags = target_meta.tags;
        let data_max = existing
            .iter()
            .flat_map(|l| l.tags.iter().map(|t| t.get()))
            .max()
            .unwrap_or(0);
        let remap = reconcile_values_by_name(&used_tags(&fresh), &mut target_tags, data_max);
        for loc in &mut fresh {
            loc.tags = loc
                .tags
                .iter()
                .filter_map(|t| remap.get(t).copied())
                .collect();
        }

        let mut fields = target_meta.extra.fields;
        let extras: Vec<&RawExtra> = fresh.iter().filter_map(|l| l.extra.as_ref()).collect();
        if let Some(defs) = maps::infer_field_defs(|k| fields.contains_key(k), &extras) {
            fields.extend(defs);
        }

        let t_hist = Instant::now();
        let history_max = stored_history_max_id(&conn, &target_map_id)?;
        let hist_ms = t_hist.elapsed().as_millis();
        let mut ids = seed_next_id(existing.iter().map(|l| l.id).max(), &[], history_max);
        for loc in &mut fresh {
            loc.id = ids.take();
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
        let row = maps::read_map_meta(&conn, &target_map_id)?.patched(&Patch::<maps::MapMeta> {
            id: target_map_id.clone(),
            tags: Some(target_tags),
            extra: Some(maps::MapExtra { fields }),
            ..Default::default()
        });
        storage::update_row(&conn, "maps", target_map_id.raw(), &row)?;
        log::debug!(
            "[cmd] copy_to_map closed-target read={}ms history={}ms save={}ms total={}ms",
            read_ms,
            hist_ms,
            t_save.elapsed().as_millis(),
            _t.elapsed().as_millis()
        );
    }
    Ok(CopyToMapResult { copied, skipped })
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
    let files = state.lock()?.store_for_window(&label)?.files.clone();
    let _writing = files.lock().await;
    let (map_id, unsaved) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_window(&label)?;
        let map_id = store.meta.id.clone();
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
    if let Ok(store) = mgr.store_for_window(&label) {
        if store.meta.id == map_id {
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
    let map_id = mgr.map_id_for_window(&label)?;
    for (id, store) in &mut mgr.stores {
        if *id != map_id {
            store.frames.remove(&label);
        }
    }
    mgr.store_for_map(&map_id)?
        .subscribe_frames(label, frames, &req);
    Ok(())
}

/// Subscribe to map changes, including the ids of added, removed, and updated rows.
#[tauri::command]
#[specta::specta]
pub async fn store_subscribe_changes(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    changes: Channel<ChangeEvent>,
) -> AppResult<()> {
    let mut mgr = state.lock()?;
    let map_id = mgr.map_id_for_window(&label)?;
    for (id, store) in &mut mgr.stores {
        if *id != map_id {
            store.changes.remove(&label);
        }
    }
    mgr.store_for_map(&map_id)?.changes.insert(label, changes);
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
) -> AppResult<Option<Id<Location>>> {
    with_store!(label, state, |store| {
        let ci = cell_idx_from_key(&cell).ok_or("invalid cell key")?;
        Ok(store.render.cells[ci as usize]
            .as_ref()
            .and_then(|cr| cr.id_order.get(cell_index as usize).copied()))
    })
}

/// Undo the newest edit, or redo the newest undone one.
#[tauri::command]
#[specta::specta]
pub async fn store_step(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    stack: Stack,
    key: Option<EntryKey>,
) -> AppResult<MutationResult> {
    with_store!(label, state, |store| {
        let _t = Instant::now();
        let map_id = store.meta.id.clone();
        let changes = match key {
            Some(key) => store.step_key(stack, key, |seq| {
                load_edit(&storage::open_db()?, &map_id, seq)
            })?,
            None => store.step(stack, |seq| load_edit(&storage::open_db()?, &map_id, seq))?,
        }
        .ok_or("nothing to step through")?;
        log::debug!(
            "[{stack:?}] stack_depth={} apply_edit={}ms changes: +{} ~{} -{}",
            store.edits.len(stack),
            _t.elapsed().as_millis(),
            changes.locations.added.len(),
            changes.locations.updated.len(),
            changes.locations.removed.len()
        );
        Ok(MutationResult {
            mutation: store.finish_entry(&changes),
        })
    })
}

/// Compile unaddressed selections into keyed store inputs.
#[tauri::command]
#[specta::specta]
pub fn selection_build(selections: Vec<SelectionInput>) -> Vec<crate::selections::Selection> {
    selections
        .into_iter()
        .map(SelectionInput::compile)
        .collect()
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

macro_rules! command_table {
    ($callback:ident, $extra:tt) => {
        $callback! { $extra;
            "Edit locations where target says; a pending layer holds edits until land." store_edit(target: Target, edits: Vec<Edit<Location>>, opts: Option<EditOpts>) -> MutationResult => |store| {
                let opts = opts.unwrap_or_default();
                Ok(MutationResult { mutation: store.edit(&target, edits, opts.land, &mut None) })
            };
            "Run work over every location matched by selector." store_work(selector: Selector<SelectionInput>, work: Work) -> WorkResult => |store| {
                apply_work(store, &selector.map_children(SelectionInput::compile), &work)
            };
            "Edit an interned field's value records; membership uses ordinary location edits." store_edit_values(field: String, edits: Vec<Edit<ValueRecord>>) -> MutationResult<ValueRecord> => |store| {
                Ok(MutationResult { mutation: store.edit_values(&field, edits)? })
            };
            "Return the uncommitted location change counts." store_commit_diff() -> mma_algebra::Counts => |store| {
                Ok(store.overlay_diff_counts())
            };
            "Edit the selection tree." store_edit_selections(op: SelectionOp) -> MutationResult => |store| {
                Ok(store.edit_selections(&op))
            };
            "Answer one question about the target's locations matched by selector." store_read(target: Target, selector: Selector<SelectionInput>, ask: Ask) -> Answer => |store| {
                store.read(&target, &selector.map_children(SelectionInput::compile), &ask)
            };
            "Apply a saved rule with its value names resolved against the open map." store_apply_saved_selection(id: Id<SavedSelection, String>) -> MutationResult => |store| {
                selections::saved::apply_saved_selection(store, &id)
            };
            "Return the open store's location count, version and dirty count." store_summary() -> Summary => |store| {
                Ok(store.summary())
            };
 }
    };
}
pub(crate) use command_table;

macro_rules! define_commands {
    ($extra:tt; $( $doc:literal $name:ident( $( $arg:ident: $ty:ty ),* ) -> $ret:ty => |$store:ident| $body:block; )*) => {
        $(
            #[doc = $doc]
            #[tauri::command]
            #[specta::specta]
            pub fn $name(label: WindowLabel, state: tauri::State<'_, StoreState>, $( $arg: $ty ),*) -> AppResult<$ret> {
                let started = Instant::now();
                let result = with_store!(label, state, |$store| $body);
                log::debug!("[cmd] {} total={}ms", stringify!($name), started.elapsed().as_millis());
                result
            }
        )*
    };
}
command_table!(define_commands, []);
