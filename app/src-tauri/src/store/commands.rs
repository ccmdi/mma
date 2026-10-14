//! Tauri commands over the location store: each takes the window lock, calls the engine,
//! and maps the result. Workflow belongs in the engine or in TS, not here.
#![allow(clippy::needless_pass_by_value)]

use crate::io::export;
use crate::plugins::borders;
use crate::selections::saved::SavedSelection;
use crate::selections::tree::{SelectionInput, SelectionOp};
use crate::selections::{self, Selector};
use crate::store::engine::*;
use crate::store::maps::MapMeta;
use crate::store::storage;
use crate::types::{AppError, AppResult, Location};
use crate::util::Rgb;
use mma_algebra::{Edit, Id, Op};
use std::time::Instant;
use tauri::async_runtime;
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
    state: &StoreState,
    map_id: Id<MapMeta, String>,
) -> AppResult<StoreStatus> {
    let files = state.lock()?.files(&map_id);
    let _writing = files.lock().await;
    let map_id2 = map_id.clone();
    let mut store = task::spawn_blocking(move || load_store(&map_id2)).await??;
    let mut mgr = state.lock()?;
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
    close_window(&state, &label).await
}

/// Close a window's map binding when its webview goes away without a proper close.
pub fn release_window_binding(app: &tauri::AppHandle, label: &str) {
    let Some(state) = tauri::Manager::try_state::<StoreState>(app) else {
        return;
    };
    // The webserve release callback runs on a synchronous HTTP worker; wait here so its
    // flush cannot be cancelled when the callback returns and destroys the client webview.
    let closed =
        async_runtime::block_on(close_window(state.inner(), &WindowLabel(label.to_string())));
    if let Err(e) = closed {
        log::error!("[close_map] flush for released window '{label}' failed: {e}");
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

/// Apply the edits uploaded in `session` (see `storeUploadBegin`) at `target`, as one change.
#[tauri::command]
#[specta::specta]
pub async fn store_edit_uploaded(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    target: Target,
    session: String,
) -> AppResult<MutationResult> {
    let started = Instant::now();
    // Read before taking the store lock: a malformed chunk must leave the store untouched.
    let edits = task::spawn_blocking(move || export::read_uploaded_chunks(&session)).await??;
    let result =
        task::block_in_place(|| store_edit(label, state, target, edits, IncomingRecords::new()))?;
    log::debug!(
        "[cmd] store_edit_uploaded total={}ms",
        started.elapsed().as_millis()
    );
    Ok(result)
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

/// Copy the locations that `selector` matches into another map, skipping ones it already has.
/// Extra fields carry over, and interned values such as tags are matched to the target's by name.
#[tauri::command]
#[specta::specta]
pub fn store_copy_locations_to_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    target_map_id: Id<MapMeta, String>,
    selector: Selector<SelectionInput>,
) -> AppResult<CopyToMapResult> {
    let started = Instant::now();
    let copied = copy_locations_to_map(&state, &label, target_map_id, selector)?;
    log::debug!(
        "[cmd] copy_to_map copied={} skipped={} total={}ms",
        copied.copied,
        copied.skipped,
        started.elapsed().as_millis()
    );
    Ok(copied)
}

fn copy_locations_to_map(
    state: &StoreState,
    label: &WindowLabel,
    target_map_id: Id<MapMeta, String>,
    selector: Selector<SelectionInput>,
) -> AppResult<CopyToMapResult> {
    let here = Target::Map { id: None };
    let (matched, records) = with_target(state, label, &here, |source| {
        if source.meta.id == target_map_id {
            return Err(AppError("cannot copy a location into its own map".into()));
        }
        let rows = source
            .at(&here)
            .rows(&selector.map_children(SelectionInput::compile));
        Ok((rows, source.held_value_records()))
    })?;
    let there = Target::Map {
        id: Some(target_map_id),
    };
    with_target(state, label, &there, |target| {
        let held = HeldRows::of(&target.at(&there).rows(&Selector::Everything));
        let total = matched.len() as u32;
        let fresh: Vec<Location> = matched.into_iter().filter(|row| !held.holds(row)).collect();
        let records = referenced_records(&records, &fresh);
        let adds = fresh.into_iter().map(Op::Add).collect();
        let copied = target.at(&there).edit(adds, records, &mut None).keys.len() as u32;
        Ok(CopyToMapResult {
            copied,
            skipped: total - copied,
        })
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
    let files = {
        let mut mgr = state.lock()?;
        let map_id = mgr.map_id_for_window(&label)?;
        mgr.files(&map_id)
    };
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
    timeline: Timeline,
) -> AppResult<MutationResult> {
    with_store!(label, state, |store| {
        let _t = Instant::now();
        let map_id = store.meta.id.clone();
        let changes = store
            .step(stack, timeline, |seq| {
                load_edit(&storage::open_db()?, &map_id, seq)
            })?
            .ok_or("nothing to step through")?;
        log::debug!(
            "[{stack:?} {timeline:?}] stack_depth={} apply_edit={}ms changes: +{} ~{} -{}",
            store.steps[timeline].len(stack),
            _t.elapsed().as_millis(),
            changes.locations.added.len(),
            changes.locations.updated.len(),
            changes.locations.removed.len()
        );
        Ok(MutationResult {
            mutation: store.finish(Finished::Entry(&changes)),
        })
    })
}

/// Compile unaddressed selections into keyed store inputs.
#[tauri::command]
#[specta::specta]
pub fn selection_build(selections: Vec<SelectionInput>) -> Vec<selections::Selection> {
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
        });
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
    mma_geo::random_points(&polygon.prepared(), count as usize, fastrand::f64)
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
        fastrand::f64,
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

/// The receipt `window` waits on for `mutation` at `target`: version 0 when the edit reached
/// a map this window does not watch, so waiting returns at once.
fn receipt(
    store: &Store,
    window: &WindowLabel,
    target: &Target,
    mutation: Mutation,
) -> MutationResult {
    let unwatched = matches!(target, Target::Map { id: Some(_) }) && !store.changes.has(window);
    MutationResult {
        mutation: Mutation {
            version: if unwatched { 0 } else { mutation.version },
            ..mutation
        },
    }
}

#[cfg(test)]
#[path = "commands.test.rs"]
mod tests;

macro_rules! command_table {
    ($callback:ident, $extra:tt) => {
        $callback! { $extra;
            "Edit locations where target says; an open pending layer holds edits until it lands. Rows refer to interned values such as tags by their ids in `records`; each is matched to the map's value of the same name, created when missing." store_edit(target: Target, edits: Vec<Edit<Location>>, records: IncomingRecords) at target -> MutationResult => |store, window| {
                store.check_interned(&records)?;
                let mutation = store.at(&target).edit(edits, records, &mut None);
                Ok(receipt(store, window, &target, mutation))
            };
            "Land a pending layer's edits on the map as one undoable step; later edits to it join that step." store_land_layer(name: String) -> MutationResult => |store| {
                Ok(MutationResult { mutation: store.land(&name, &mut None) })
            };
            "Run work over every location matched by selector." store_work(selector: Selector<SelectionInput>, work: Work) -> WorkResult => |store| {
                apply_work(store, &selector.map_children(SelectionInput::compile), &work)
            };
            "Edit an interned field's value records; membership uses ordinary location edits." store_edit_values(field: String, edits: Vec<Edit<ValueRecord>>) -> MutationResult<ValueRecord> => |store| {
                Ok(MutationResult { mutation: store.edit_values(&field, edits)? })
            };

            "Edit the selection tree." store_edit_selections(op: SelectionOp) -> MutationResult<ListedSelection> => |store| {
                Ok(store.edit_selections(&op))
            };
            "Answer one question about the target's locations matched by selector." store_read(target: Target, selector: Selector<SelectionInput>, ask: Ask) at target -> Answer => |store| {
                store.at(&target).read(&selector.map_children(SelectionInput::compile), &ask)
            };
            "Apply a saved rule with its value names resolved against the open map." store_apply_saved_selection(id: Id<SavedSelection, String>) -> MutationResult<ListedSelection> => |store| {
                selections::saved::apply_saved_selection(store, &id)
            };
 }
    };
}
pub(crate) use command_table;

macro_rules! table_target {
    () => {
        &Target::Map { id: None }
    };
    ($at:ident) => {
        &$at
    };
}

macro_rules! define_commands {
    ($extra:tt; $( $doc:literal $name:ident( $( $arg:ident: $ty:ty ),* ) $( at $at:ident )? -> $ret:ty => |$store:ident $(, $window:ident)?| $body:block; )*) => {
        $(
            #[doc = $doc]
            #[tauri::command]
            #[specta::specta]
            pub fn $name(label: WindowLabel, state: tauri::State<'_, StoreState>, $( $arg: $ty ),*) -> AppResult<$ret> {
                let started = Instant::now();
                let result = with_target(&state, &label, table_target!($( $at )?), |$store| {
                    $( let $window = &label; )?
                    $body
                });
                log::debug!("[cmd] {} total={}ms", stringify!($name), started.elapsed().as_millis());
                result
            }
        )*
    };
}
command_table!(define_commands, []);
