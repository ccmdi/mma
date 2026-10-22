//! Bench support: deterministic fixtures plus a [`BenchApp`] harness that calls
//! the real `store_*` commands on a `MockRuntime` app. Compiled only under
//! `--features bench` (which pulls in `tauri/test`) and re-exported as
//! `app_lib::bench_api`; inert in every normal build.
//!
//! A child module of the engine, so it reaches the store's private internals without
//! widening their visibility. Command-level benches go through [`BenchApp`], the actual
//! command fns with no mirrored bodies, so they can never drift from the app.

use super::*;
use crate::selections::saved::SelectionEdit;
use crate::selections::tree::{SelectionInput, SelectionOp};
use crate::store::arrow::Columns;
use crate::store::commands::*;
use crate::store::storage;
use crate::types::RawExtra;
use std::env;
use std::path::Path;
use std::sync::atomic::{self, AtomicUsize};
use std::sync::Arc;
use tauri::async_runtime;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::test;
use tauri::test::MockRuntime;

pub use crate::selections::{Selection, Selector};
pub use crate::store::engine::{Answer, Mutation, RenderRequest, Store};
pub use crate::types::{Location, LocationFlags};
pub use mma_algebra::{Change, Edit, Id, Op, Patch};

/// Row count for the scale-parameterized benches. `MMA_BENCH_SCALE=200000` for a
/// full-size run; the default is a smoke-sized store.
pub fn scale() -> usize {
    env::var("MMA_BENCH_SCALE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(10_000)
}

const PANO_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const TAG_COUNT: u32 = 8;

/// One realistic location. Ids are 1-based and dense so the sorted-id invariant holds.
fn make_location(id: u32, rng: &mut fastrand::Rng) -> Location {
    let pano_id = (rng.u8(0..10) > 0).then(|| {
        (0..22)
            .map(|_| PANO_ALPHABET[rng.usize(0..PANO_ALPHABET.len())] as char)
            .collect::<String>()
    });
    let tag_n = rng.usize(0..=5);
    let mut tags: Vec<u32> = (0..tag_n).map(|_| rng.u32(1..=TAG_COUNT)).collect();
    tags.sort_unstable();
    tags.dedup();
    // ~120 bytes of extra on a quarter of the rows, matching a typical enriched map.
    let extra = (rng.u8(0..4) == 0).then(|| {
        RawExtra::from_string(format!(
            r#"{{"countryCode":"US","subdivisionCode":"US-CA","source":"bench","year":{},"month":{},"driveSide":"right","cameraGen":4}}"#,
            2009 + rng.u32(0..16),
            1 + rng.u32(0..12)
        ))
        .unwrap()
    });
    Location {
        id: Id::new(id),
        lat: rng.f64() * 140.0 - 70.0,
        lng: rng.f64() * 360.0 - 180.0,
        heading: rng.f64() * 360.0,
        pitch: 0.0,
        zoom: 1.0,
        pano_id: pano_id.map(Into::into),
        flags: LocationFlags::empty(),
        tags: tags.into_iter().map(Id::new).collect(),
        extra,
        created_at: 1_700_000_000 + id,
        modified_at: None,
    }
}

/// `n` deterministic locations with ids `1..=n`.
pub fn locations(n: usize, seed: u64) -> Vec<Location> {
    let mut rng = fastrand::Rng::with_seed(seed);
    (1..=n as u32)
        .map(|id| make_location(id, &mut rng))
        .collect()
}

/// A single realistic location, for the clone/materialize micro benches.
pub fn one_location(seed: u64) -> Location {
    let mut rng = fastrand::Rng::with_seed(seed);
    make_location(1, &mut rng)
}

/// A prepared population that can hand out fresh [`Store`]s cheaply: the Arrow
/// batch is Arc-backed, so each store gets the same committed base without a
/// rebuild. Benches that mutate must take a fresh store per iteration (criterion
/// `iter_batched`), or the second iteration measures the patched path instead of
/// the base path.
pub struct Fixture {
    pub batch: RecordBatch,
    tags: HashMap<Id<ValueRecord>, ValueRecord>,
    field_defs: HashMap<String, maps::FieldDef>,
    pub n: usize,
}

fn bench_map_id() -> Id<MapMeta, String> {
    Id::new("bench".into())
}

fn bench_store(batch: RecordBatch, tags: &HashMap<Id<ValueRecord>, ValueRecord>) -> Store {
    let mut store = Store::new();
    store.meta = Tracked::new(MapMeta {
        id: bench_map_id(),
        ..Default::default()
    });
    let last = batch.num_rows().checked_sub(1);
    store.next_id = Ids::above(last.map(|row| Id::new(Columns::id(&batch).value(row))));
    store.batch = Some(batch);
    store
        .records
        .insert("tags".into(), Tracked::new(tags.clone()));
    store
}

impl Fixture {
    pub fn new(n: usize) -> Self {
        Self::with_seed(n, 0xB0B0_CAFE)
    }

    pub fn with_seed(n: usize, seed: u64) -> Self {
        let locs = locations(n, seed);
        let tags = (1..=TAG_COUNT)
            .map(|id| {
                let rec = ValueRecord {
                    id: Id::new(id),
                    name: Some(format!("tag{id}")),
                    order: Some(id),
                    extra: serde_json::Map::from_iter([("color".to_string(), "#3a7fc2".into())]),
                };
                (rec.id, rec)
            })
            .collect();
        let field_defs = [
            "countryCode",
            "subdivisionCode",
            "source",
            "year",
            "month",
            "driveSide",
            "cameraGen",
        ]
        .iter()
        .map(|k| {
            let def = maps::known_field_def(k).unwrap_or(maps::FieldDef {
                field_type: maps::FieldType::String,
                label: None,
                values: None,
                comparison: None,
                interned: false,
                builtin: None,
            });
            ((*k).to_string(), def)
        })
        .collect();
        Fixture {
            batch: arrow::locations_to_batch(&locs),
            tags,
            field_defs,
            n,
        }
    }

    /// A store holding the whole population as a committed base batch, empty overlay.
    pub fn store(&self) -> Store {
        let mut store = bench_store(self.batch.clone(), &self.tags);
        store.alive_count = Tracked::new(self.n);
        store.field_defs = Tracked::new(self.field_defs.clone());
        store
    }

    /// A store with its render cells built and one window watching, as the app has after
    /// the open-time scene load. Required by anything that touches the render frames or
    /// the selection bitmask.
    pub fn rendered_store(&self) -> Store {
        let mut store = self.store();
        store.subscribe_frames(label(), Channel::new(|_| Ok(())), &render_request());
        store
    }

    /// `count` heading patches spread across the population.
    pub fn heading_updates(&self, count: usize) -> Vec<Edit<Location>> {
        let step = (self.n / count.max(1)).max(1);
        (0..count)
            .map(|i| {
                Op::Put(Patch::<Location> {
                    id: Id::new((i * step) as u32 + 1),
                    heading: Some(((i * 7) % 360) as f64),
                    ..Default::default()
                })
            })
            .collect()
    }

    /// `count` exact no-op heading patches spread across the population.
    pub fn noop_heading_updates(&self, count: usize) -> Vec<Edit<Location>> {
        let headings = Columns::heading(&self.batch);
        let step = (self.n / count.max(1)).max(1);
        (0..count)
            .map(|i| {
                let row = (i * step).min(self.n - 1);
                Op::Put(Patch::<Location> {
                    id: Id::new(row as u32 + 1),
                    heading: Some(headings.value(row)),
                    ..Default::default()
                })
            })
            .collect()
    }

    pub fn coords(&self, id: u32) -> (f64, f64) {
        let row = id as usize - 1;
        (
            Columns::lat(&self.batch).value(row),
            Columns::lng(&self.batch).value(row),
        )
    }
}

/// The default render request: pin markers, whole world, no explicit selection.
pub fn render_request() -> RenderRequest {
    RenderRequest {
        marker_style: "pin".into(),
    }
}

/// A `MockRuntime` Tauri app with a managed [`StoreState`] whose `"bench"` window
/// maps to the `"bench"` store. Command-level benches call the actual command fns
/// through this, exactly as IPC would (minus serialization). The app exists only
/// because `tauri::State` can't be constructed by hand.
pub struct BenchApp {
    app: tauri::App<MockRuntime>,
}

fn label() -> WindowLabel {
    WindowLabel("bench".into())
}

const MAP: Target = Target::Map { id: None };

impl Default for BenchApp {
    fn default() -> Self {
        Self::new()
    }
}

impl BenchApp {
    pub fn new() -> Self {
        use tauri::Manager;
        let app = test::mock_builder()
            .build(test::mock_context(test::noop_assets()))
            .expect("mock app");
        storage::init_paths(app.handle()).expect("init app paths");
        let mut mgr = StoreManager::new();
        mgr.holders.insert(Holder::Window(label()), bench_map_id());
        mgr.stores.insert(bench_map_id(), Store::new());
        app.manage(StoreState::new(mgr));
        Self { app }
    }

    fn state(&self) -> tauri::State<'_, StoreState> {
        use tauri::Manager;
        self.app.state()
    }

    /// Swap the `"bench"` store. Call in an `iter_batched` setup so every
    /// iteration mutates a fresh population.
    pub fn set_store(&self, store: Store) {
        self.state()
            .lock()
            .expect("store lock")
            .stores
            .insert(bench_map_id(), store);
    }

    pub fn edit(&self, edits: Vec<Edit<Location>>) -> EditResult {
        with_target(&self.state(), &label(), &MAP, |store| {
            store.at(&MAP).write(edits).settled()
        })
        .expect("edit")
    }

    pub fn undo(&self) -> Mutation {
        self.step(Stack::Undo)
    }

    pub fn redo(&self) -> Mutation {
        self.step(Stack::Redo)
    }

    fn step(&self, stack: Stack) -> Mutation {
        async_runtime::block_on(store_step(label(), self.state(), stack, Timeline::Edits))
            .expect("step")
    }

    /// Replace the listed selections with one per selector.
    pub fn edit_selections(&self, selectors: Vec<Selector>) -> Mutation<ListedSelection> {
        let selections = selectors
            .into_iter()
            .map(|s| input(Selection::of(s)))
            .collect();
        with_target(&self.state(), &label(), &MAP, |store| {
            let op = SelectionEdit::Op(SelectionOp::Set { selections }).resolved(store)?;
            store.at(&MAP).write(op).settled()
        })
        .expect("edit_selections")
    }

    /// Full scene via the real command: build, encode and send. Returns the frame's size.
    pub fn subscribe_frames(&self) -> usize {
        let size = Arc::new(AtomicUsize::new(0));
        let sent = size.clone();
        let sink = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                sent.store(bytes.len(), atomic::Ordering::Relaxed);
            }
            Ok(())
        });
        async_runtime::block_on(store_subscribe_frames(
            label(),
            self.state(),
            sink,
            render_request(),
        ))
        .expect("subscribe_frames");
        size.load(atomic::Ordering::Relaxed)
    }

    fn read(&self, selector: Selector<SelectionInput>, ask: Ask) -> Answer {
        async_runtime::block_on(store_read(label(), self.state(), MAP, selector, ask))
            .expect("read")
    }

    pub fn find_nearby(&self, lat: f64, lng: f64, radius_m: f64) -> Answer {
        self.read(
            Selector::Nearby {
                selection: None,
                lat,
                lng,
                radius_m,
            },
            Ask::Locations,
        )
    }

    pub fn near_any(&self, lats: Vec<f64>, lngs: Vec<f64>, radius_m: f64) -> Answer {
        self.read(
            Selector::Everything,
            Ask::NearAny {
                lats,
                lngs,
                radius_m,
            },
        )
    }
}

fn input(selection: Selection) -> SelectionInput {
    SelectionInput {
        selector: selection.selector.map_children(input),
        color: Some(selection.color),
    }
}

/// A location edit straight on the engine, without the command's state lock.
pub fn write(store: &mut Store, edits: &[Edit<Location>]) -> Mutation {
    store
        .at(&Target::Map { id: None })
        .write(edits.to_vec())
        .settled()
        .expect("write")
        .mutation
}

/// The rows `selector` resolves to, its indexes built first as every selector read does.
pub fn resolve_selection(store: &mut Store, selector: &Selector) -> u64 {
    store.scope(selector).ids().len()
}

/// A walk over the rows of `ids`, the id set built once up front.
pub fn scope_walk(
    store: &Store,
    ids: impl IntoIterator<Item = u32>,
) -> impl Fn() -> (usize, f64) + '_ {
    let set: IdSet<Location> = ids.into_iter().map(Id::new).collect();
    move || {
        let (mut count, mut sum) = (0, 0.0);
        for row in store.all().within(&set).rows() {
            count += 1;
            sum += row.lat() + row.lng();
        }
        (count, sum)
    }
}

pub fn serialize_overlay(store: &Store) -> Vec<u8> {
    arrow::arrow_ipc_bytes(&store.overlay().to_delta(store.batch.as_ref()))
        .expect("serialize overlay")
}

/// The open-time O(N) pass: alive count and bounds.
pub fn scan(store: &Store) -> usize {
    store.scan_locations().alive
}

/// Alive row count, so a bench can consume a store without naming its fields.
pub fn alive(store: &Store) -> usize {
    *store.alive_count
}

pub fn get_loc_by_id(store: &Store, id: u32) -> Option<Location> {
    store.get_loc_by_id(Id::new(id))
}

pub fn base_loc_by_id(store: &Store, id: u32) -> Option<Location> {
    store.base_loc_by_id(Id::new(id))
}

/// Apply a row change to the store.
pub fn put(store: &mut Store, change: &Change<Location>) {
    store.put(change);
}

/// The in-memory half of a commit: merge the overlay into a new base and adopt it.
pub fn bake_overlay(store: &mut Store) {
    if let Some(batch) = store.current_batch() {
        store.adopt_base(batch);
    }
}

pub fn build_spatial(store: &Store) -> usize {
    let mut index = SpatialIndex::new(SPATIAL_CELL_M);
    for row in store.all().rows() {
        index.insert(row.id().get(), row.lat(), row.lng());
    }
    index.len()
}

/// Write a population to a real Arrow IPC file, for the map-open bench to read back.
pub fn write_arrow(path: &Path, batch: &RecordBatch) {
    arrow::write_arrow_ipc(path, batch).expect("write arrow");
}

/// The in-process half of `store_open_map`: mmap the Arrow file, then derive the alive
/// count and bounds. The SQLite and edit-history halves are left out, as they need an
/// app data dir.
pub fn open_from_arrow(path: &Path, fx: &Fixture) -> Store {
    let (batch, handle) = arrow::read_arrow_ipc_mmap(path).expect("read arrow");
    let mut store = bench_store(batch, &fx.tags);
    store.mmap_handle = Some(handle);
    let agg = store.scan_locations();
    store.alive_count = Tracked::new(agg.alive);
    store.bounds.seed(At::new(store.version, agg.bounds));
    store
}
