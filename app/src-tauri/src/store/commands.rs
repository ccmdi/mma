//! Tauri commands over the location store: each takes the window lock, calls the engine,
//! and maps the result. Workflow belongs in the engine or in TS, not here.
#![allow(clippy::needless_pass_by_value)]

use crate::io::export;
use crate::plugins::borders;
use crate::selections::saved::SelectionEdit;
use crate::selections::tree::SelectionInput;
use crate::selections::{self, Selector};
use crate::store::engine::*;
use crate::store::maps::{scratch_map_row, MapMeta, SCRATCH_MAP_ID};
use crate::store::storage;
use crate::types::{AppError, AppResult, Location};
use crate::util::now_iso;
use mma_algebra::{Edit, Id, Op};
use std::collections::HashMap;
use std::time::Instant;
use tauri::ipc::Channel;
use tauri_specta::Reply;
use tokio::task;

/// Open a map, deliver its later changes on `changes`, and return its initial state
/// (per-value counts, metadata, undo/redo availability). The scratch map is created on its
/// first open. Must be called before any other store commands.
#[tauri::command]
#[specta::specta]
pub async fn store_open_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    map_id: Id<MapMeta, String>,
    changes: Channel<ChangeEvent>,
) -> AppResult<StoreStatus> {
    // Claim the window binding before the unlocked read, so a concurrent checkout's
    // open-elsewhere guard sees this open from its first moment.
    let window = Holder::Window(label.clone());
    state.lock()?.holders.insert(window.clone(), map_id.clone());
    let opened = open_claimed_map(&label, &state, map_id.clone(), changes).await;
    if opened.is_err() {
        if let Ok(mut mgr) = state.lock() {
            if mgr.holders.get(&window) == Some(&map_id) {
                mgr.holders.remove(&window);
            }
        }
    }
    opened
}

async fn open_claimed_map(
    label: &WindowLabel,
    state: &StoreState,
    map_id: Id<MapMeta, String>,
    changes: Channel<ChangeEvent>,
) -> AppResult<StoreStatus> {
    let files = state.lock()?.files(&map_id);
    let _writing = files.lock().await;
    let live = state.lock()?.stores.contains_key(&map_id);
    let map_id2 = map_id.clone();
    let loaded = task::spawn_blocking(move || {
        let db = storage::open_db()?;
        if map_id2.raw() == SCRATCH_MAP_ID {
            scratch_map_row(&db)?;
        }
        let mut loaded = (!live).then(|| load_store(&map_id2)).transpose()?;
        let now = now_iso();
        db.execute(
            "UPDATE maps SET last_opened_at = ?1 WHERE id = ?2",
            rusqlite::params![now, map_id2.raw()],
        )?;
        if let Some(store) = &mut loaded {
            store.meta = Tracked::new(MapMeta {
                last_opened_at: Some(now),
                ..(*store.meta).clone()
            });
        }
        AppResult::Ok(loaded)
    })
    .await??;
    let mut mgr = state.lock()?;
    let dependents = mgr.providers.dependents();
    let window = Holder::Window(label.clone());
    mgr.holders.insert(window.clone(), map_id.clone());
    for other in mgr.stores.values_mut() {
        other.changes.remove(&window);
    }
    let store = match loaded {
        Some(mut store) => {
            store.dependents = dependents;
            mgr.stores.entry(map_id).or_insert(store)
        }
        None => mgr.store_for_map(&map_id)?,
    };
    store.announce();
    let status = store.open_status();
    store.changes.insert(window, changes);
    Ok(status)
}

/// Close the open map, saving unsaved changes first.
#[tauri::command]
#[specta::specta]
pub async fn store_close_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<()> {
    release(&state, &Holder::Window(label)).await
}

/// Save uncommitted changes to disk. No-op when nothing has changed.
#[tauri::command]
#[specta::specta]
pub async fn store_save_dirty(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<()> {
    let map_id = state.lock()?.map_id_for_window(&label)?;
    save(&state, &map_id).await
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
    let window = Holder::Window(label.clone());
    for (id, store) in &mut mgr.stores {
        if *id != map_id {
            store.frames.remove(&window);
        }
    }
    mgr.store_for_map(&map_id)?
        .subscribe_frames(label, frames, &req);
    Ok(())
}

/// A change to the map: its locations, an interned field's values, or the selection list.
#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Edits {
    /// Locations where `target` says. Rows refer to interned values such as tags by their ids
    /// in `records`; each is matched to the map's value of the same name, created when missing.
    Locations {
        target: Target,
        edits: Rows,
        records: HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>>,
    },
    /// One interned field's value records; membership uses location edits.
    Values {
        field: String,
        edits: Vec<Edit<ValueRecord>>,
    },
    /// The selection list.
    Selections(SelectionEdit),
}

/// A location edit's rows: sent with it, or uploaded beforehand in chunks.
#[derive(serde::Deserialize, specta::Type)]
#[serde(untagged)]
pub enum Rows {
    /// The rows themselves.
    Inline(InlineRows),
    /// The rows uploaded to the session `storeUploadBegin` opened.
    Uploaded { session: String },
}

#[derive(specta::Type)]
#[specta(transparent, inline)]
pub struct InlineRows(Vec<Edit<Location>>);

/// Read through a JSON value: a raw extra cannot be read back from serde's buffered input.
impl<'de> serde::Deserialize<'de> for InlineRows {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let rows = <serde_json::Value as serde::Deserialize>::deserialize(deserializer)?;
        serde_json::from_value(rows)
            .map(InlineRows)
            .map_err(serde::de::Error::custom)
    }
}

impl Rows {
    /// The rows in hand, reading an upload's chunks.
    fn read(self) -> AppResult<Vec<Edit<Location>>> {
        match self {
            Rows::Inline(InlineRows(rows)) => Ok(rows),
            Rows::Uploaded { session } => export::read_uploaded_chunks(&session),
        }
    }
}

/// What an edit did, answering the `Edits` variant it was.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Edited {
    /// What the location edit did.
    Locations(EditResult),
    /// The version the value edit reached and the keys its new records took.
    Values(Mutation<ValueRecord>),
    /// The version the selection edit reached.
    Selections(Mutation<ListedSelection>),
}

impl Edits {
    /// Where the change goes: the map or layer a location edit names, else this window's map.
    fn target(&self) -> Target {
        match self {
            Edits::Locations { target, .. } => target.clone(),
            Edits::Values { .. } | Edits::Selections(_) => Target::Map { id: None },
        }
    }

    /// This edit with its rows in hand. It runs before the store lock, so reading a large
    /// upload holds up no other window.
    fn read(self) -> AppResult<Self> {
        Ok(match self {
            Edits::Locations {
                target,
                edits,
                records,
            } => Edits::Locations {
                target,
                edits: Rows::Inline(InlineRows(edits.read()?)),
                records,
            },
            edits => edits,
        })
    }

    /// Make the change on `store` at `target` for `window`.
    fn write(
        self,
        store: &mut Store,
        window: &WindowLabel,
        target: &Target,
    ) -> AppResult<Reached<Edited>> {
        let receipt = receipt(store, window, target);
        let received = move |edited: EditResult| EditResult {
            mutation: receipt(edited.mutation),
            ..edited
        };
        Ok(match self {
            Edits::Locations { edits, records, .. } => {
                let edited = store.at(target).from(&records)?.write(edits.read()?);
                edited.map(|edited| Edited::Locations(received(edited)))
            }
            Edits::Values { field, edits } => store
                .at(target)
                .field(&field)?
                .write(edits)
                .map(Edited::Values),
            Edits::Selections(edit) => {
                let op = edit.resolved(store)?;
                store.at(target).write(op).map(Edited::Selections)
            }
        })
    }
}

/// Edit the map; an open pending layer holds location edits until it lands.
#[tauri::command]
#[specta::specta]
pub fn store_edit(
    label: WindowLabel,
    writes: tauri::State<'_, Writes>,
    edits: Edits,
    reply: Reply<Edited>,
) {
    reply.when(writes.write(move |state| {
        let target = edits.target();
        let edits = edits.read()?;
        with_target(state, &label, &target, |store| {
            edits.write(store, &label, &target)
        })
    }));
}

/// Run work over the target's locations matched by selector; an open pending layer holds the
/// edits until it lands.
#[tauri::command]
#[specta::specta]
pub fn store_work(
    label: WindowLabel,
    writes: tauri::State<'_, Writes>,
    target: Target,
    selector: Selector<SelectionInput>,
    work: Work,
    reply: Reply<WorkResult>,
) {
    reply.when(writes.write(move |state| {
        with_target(state, &label, &target, |store| {
            let receipt = receipt(store, &label, &target);
            let worked = store
                .at(&target)
                .scope(&selector.map_children(SelectionInput::compile))
                .write(work);
            Ok(worked.map(|worked| WorkResult {
                mutation: receipt(worked.mutation),
                ..worked
            }))
        })
    }));
}

/// Undo the newest edit, or redo the newest undone one.
#[tauri::command]
#[specta::specta]
pub fn store_step(
    label: WindowLabel,
    writes: tauri::State<'_, Writes>,
    stack: Stack,
    timeline: Timeline,
    reply: Reply<Mutation>,
) {
    reply.when(writes.write(move |state| {
        with_target(state, &label, &Target::Map { id: None }, |store| {
            let _t = Instant::now();
            let map_id = store.meta.id.clone();
            let stepped = store.step(stack, timeline, |seq| {
                load_edit(&storage::open_db()?, &map_id, seq)
            });
            log::debug!(
                "[{stack:?} {timeline:?}] stack_depth={} step={}ms",
                store.steps[timeline].len(stack),
                _t.elapsed().as_millis()
            );
            Ok(Reached::later(async move {
                stepped
                    .await?
                    .ok_or_else(|| "nothing to step through".into())
            }))
        })
    }));
}

/// Land a pending layer's edits on the map as one undoable step; later edits to it join that
/// step.
#[tauri::command]
#[specta::specta]
pub fn store_land_layer(
    label: WindowLabel,
    writes: tauri::State<'_, Writes>,
    name: String,
    reply: Reply<Mutation>,
) {
    reply.when(writes.write(move |state| {
        with_target(state, &label, &Target::Map { id: None }, |store| {
            Ok(store.at(&Target::Pending { name }).land())
        })
    }));
}

/// Close a pending layer. Edits not yet landed are discarded; work still writing to a landed layer finishes first.
#[tauri::command]
#[specta::specta]
pub fn store_close_layer(
    label: WindowLabel,
    writes: tauri::State<'_, Writes>,
    name: String,
    map_id: Option<Id<MapMeta, String>>,
    reply: Reply<()>,
) {
    reply.when(writes.write(move |state| {
        let mut manager = state.lock()?;
        let map_id = map_id.or_else(|| manager.map_id_for_window(&label).ok());
        if let Some(store) = map_id.and_then(|map_id| manager.stores.get_mut(&map_id)) {
            store.close_layer(&name);
        }
        Ok(Reached::ready(Ok(())))
    }));
}

/// The receipt `window` waits on for a mutation at `target`: version 0 when the change
/// reaches a map this window does not watch, so waiting returns at once.
fn receipt(
    store: &Store,
    window: &WindowLabel,
    target: &Target,
) -> impl FnOnce(Mutation) -> Mutation + Send + 'static {
    let unwatched = matches!(target, Target::Map { id: Some(_) })
        && !store.changes.has(&Holder::Window(window.clone()));
    move |mutation| Mutation {
        version: if unwatched { 0 } else { mutation.version },
        ..mutation
    }
}

/// Answer one question about the target's locations matched by selector.
#[tauri::command]
#[specta::specta]
pub async fn store_read(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    target: Target,
    selector: Selector<SelectionInput>,
    ask: Ask,
) -> AppResult<Answer> {
    reach_target(&state, &label, &target, |store| {
        Ok(Reached::ready(store.at(&target).read(
            &selector.map_children(SelectionInput::compile),
            &ask,
        )))
    })
    .await
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
    let coords: AppResult<Vec<(f64, f64)>> =
        with_target(&state, &label, &Target::Map { id: None }, |store| {
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
pub async fn store_copy_locations_to_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    target_map_id: Id<MapMeta, String>,
    selector: Selector<SelectionInput>,
) -> AppResult<CopyToMapResult> {
    let started = Instant::now();
    let copied = copy_locations_to_map(&state, &label, target_map_id, selector).await?;
    log::debug!(
        "[cmd] copy_to_map copied={} skipped={} total={}ms",
        copied.copied,
        copied.skipped,
        started.elapsed().as_millis()
    );
    Ok(copied)
}

async fn copy_locations_to_map(
    state: &StoreState,
    label: &WindowLabel,
    target_map_id: Id<MapMeta, String>,
    selector: Selector<SelectionInput>,
) -> AppResult<CopyToMapResult> {
    let here = Target::Map { id: None };
    let (matched, records) = task::block_in_place(|| {
        with_target(state, label, &here, |source| {
            if source.meta.id == target_map_id {
                return Err(AppError("cannot copy a location into its own map".into()));
            }
            let rows = source
                .at(&here)
                .rows(&selector.map_children(SelectionInput::compile));
            Ok((rows, source.held_value_records()))
        })
    })?;
    let there = Target::Map {
        id: Some(target_map_id),
    };
    let (copied, total) = task::block_in_place(|| {
        with_target(state, label, &there, |target| {
            let held = HeldRows::of(&target.at(&there).rows(&Selector::Everything));
            let total = matched.len() as u32;
            let fresh: Vec<Location> = matched.into_iter().filter(|row| !held.holds(row)).collect();
            let records = referenced_records(&records, &fresh);
            let adds = fresh
                .into_iter()
                .map(|row| {
                    Op::Add(Location {
                        created_at: 0,
                        ..row
                    })
                })
                .collect();
            let copied = target.at(&there).from(&records)?.write(adds);
            Ok((copied, total))
        })
    })?;
    let copied = copied.await?.mutation.keys.len() as u32;
    Ok(CopyToMapResult {
        copied,
        skipped: total - copied,
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

/// How points are drawn inside a polygon.
#[derive(serde::Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]

pub enum PointSampling {
    /// Up to `count` points uniformly at random, fewer when the polygon fills little of its bounding box.
    Random { count: u32 },
    /// Points no two closer than `spacingM` metres and no gap wider than about twice that, in random order.
    Poisson { spacing_m: f64 },
}

/// Points inside the polygon as `[lng, lat]` pairs, drawn as `sampling` says.
#[tauri::command]
#[specta::specta]
pub async fn polygon_points(
    polygon: selections::PolygonGeometry,
    sampling: PointSampling,
) -> AppResult<Vec<[f64; 2]>> {
    match sampling {
        PointSampling::Random { count } => Ok(mma_geo::random_points(
            &polygon.prepared(),
            count as usize,
            fastrand::f64,
        )),
        PointSampling::Poisson { spacing_m } => {
            if !(spacing_m.is_finite() && spacing_m >= 1.0) {
                return Err(AppError::from(
                    "polygon_points: spacing_m must be at least 1 metre",
                ));
            }
            Ok(mma_geo::poisson_points(
                &polygon.prepared(),
                spacing_m,
                fastrand::f64,
            ))
        }
    }
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
    let [w, s, e, n] = polygon.prepared().bbox()?;
    // A full turn is the whole world: folding both edges would collapse it to zero width.
    if e - w >= 360.0 {
        return Some([-180.0, s, 180.0, n]);
    }
    Some([
        mma_geo::fold_lng(w, -180.0),
        s,
        mma_geo::fold_lng(e, -180.0),
        n,
    ])
}

#[cfg(test)]
#[path = "commands.test.rs"]
mod tests;
