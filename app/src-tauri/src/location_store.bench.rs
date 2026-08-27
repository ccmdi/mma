//! Bench support: deterministic fixtures plus a [`BenchApp`] harness that calls
//! the real `store_*` commands on a `MockRuntime` app. Compiled only under
//! `--features bench` (which pulls in `tauri/test`) and re-exported as
//! `app_lib::bench_api`; inert in every normal build.
//!
//! A child module of `location_store`, so it reaches the private internals
//! (`overlay_write`, `get_loc_by_id`, `apply_edit_*`) without widening their
//! visibility. Command-level benches go through [`BenchApp`] -- the actual
//! command fns, no mirrored bodies -- so they can never drift from the app.

use super::*;
use crate::types::RawExtra;
use std::env;
use tauri::async_runtime;
use tauri::test;
use tauri::test::MockRuntime;

pub use crate::location_store::{
    LocationPatch, MutationResult, RenderRequest, SelectionInput, Store, Update,
};
pub use crate::selections::{Selection, Selector};
pub use crate::types::{Location, Tag};

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
        id,
        lat: rng.f64() * 140.0 - 70.0,
        lng: rng.f64() * 360.0 - 180.0,
        heading: rng.f64() * 360.0,
        pitch: 0.0,
        zoom: 1.0,
        pano_id: pano_id.map(Into::into),
        flags: LocationFlags::empty(),
        tags,
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
    pub tags: HashMap<u32, Tag>,
    pub counts: HashMap<u32, usize>,
    pub sets: HashMap<u32, RoaringBitmap>,
    pub known_field_keys: HashSet<String>,
    pub n: usize,
}

impl Fixture {
    pub fn new(n: usize) -> Self {
        Self::with_seed(n, 0xB0B0_CAFE)
    }

    pub fn with_seed(n: usize, seed: u64) -> Self {
        let locs = locations(n, seed);
        let mut tags: HashMap<u32, Tag> = HashMap::new();
        let mut sets: HashMap<u32, RoaringBitmap> = HashMap::new();
        let mut counts: HashMap<u32, usize> = HashMap::new();
        for id in 1..=TAG_COUNT {
            tags.insert(
                id,
                Tag {
                    id,
                    name: format!("tag{id}"),
                    color: "#3a7fc2".into(),
                    visible: true,
                    order: Some(id),
                    doclinks: Vec::new(),
                },
            );
        }
        for l in &locs {
            for t in &l.tags {
                sets.entry(*t).or_default().insert(l.id);
                *counts.entry(*t).or_default() += 1;
            }
        }
        let known_field_keys = [
            "countryCode",
            "subdivisionCode",
            "source",
            "year",
            "month",
            "driveSide",
            "cameraGen",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        Fixture {
            batch: arrow_bridge::locations_to_batch(&locs),
            tags,
            counts,
            sets,
            known_field_keys,
            n,
        }
    }

    /// A store holding the whole population as a committed base batch, empty overlay.
    pub fn store(&self) -> Store {
        let mut store = Store::new();
        store.map_id = Some("bench".into());
        store.batch = Some(self.batch.clone());
        store.next_id = self.n as u32 + 1;
        store.alive_count = self.n;
        store.known_field_keys = self.known_field_keys.clone();
        store.tags.all = self.tags.clone();
        store.tags.counts = self.counts.clone();
        store.tags.sets = self.sets.clone();
        store.tags.next_id = TAG_COUNT + 1;
        store.bounds_dirty = true;
        store
    }

    /// A store with its render cells built, as the app has after the open-time
    /// full render. Required by anything that touches the render delta or the
    /// selection bitmask.
    pub fn rendered_store(&self) -> Store {
        let mut store = self.store();
        fill_render(&mut store);
        store
    }

    /// `count` heading patches spread across the population.
    pub fn heading_updates(&self, count: usize) -> Vec<Update<LocationPatch>> {
        let step = (self.n / count.max(1)).max(1);
        (0..count)
            .map(|i| Update {
                id: (i * step) as u32 + 1,
                patch: LocationPatch {
                    heading: Some(((i * 7) % 360) as f64),
                    ..Default::default()
                },
            })
            .collect()
    }
}

/// The default render request: pin markers, whole world, no explicit selection.
pub fn render_request() -> RenderRequest {
    RenderRequest {
        west: -180.0,
        south: -90.0,
        east: 180.0,
        north: 90.0,
        selected_ids: None,
        marker_style: "pin".into(),
        marker_color: None,
    }
}

// ---------------------------------------------------------------------------
// BenchApp: the real commands on a MockRuntime app
// ---------------------------------------------------------------------------

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
        mgr.window_map.insert("bench".into(), "bench".into());
        mgr.stores.insert("bench".into(), Store::new());
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
            .insert("bench".into(), store);
    }

    pub fn add_locations(&self, locations: Vec<Location>) -> MutationResult {
        store_add_locations(label(), self.state(), locations).expect("add_locations")
    }

    pub fn remove_locations(&self, ids: Vec<u32>) -> MutationResult {
        store_remove_locations(label(), self.state(), ids).expect("remove_locations")
    }

    pub fn undo(&self) -> MutationResult {
        async_runtime::block_on(store_undo(label(), self.state())).expect("undo")
    }

    pub fn redo(&self) -> MutationResult {
        async_runtime::block_on(store_redo(label(), self.state())).expect("redo")
    }

    pub fn sync_selections(&self, sels: Vec<SelectionInput>) -> usize {
        async_runtime::block_on(store_sync_selections(label(), self.state(), sels))
            .expect("sync_selections")
            .selected_count
    }

    /// Full render via the real command, temp-file write included.
    pub fn fill_render(&self) -> String {
        async_runtime::block_on(store_fill_render_file(
            label(),
            self.state(),
            render_request(),
        ))
        .expect("fill_render")
    }
}

// ---------------------------------------------------------------------------
// Direct engine calls (real fns, no command plumbing)
// ---------------------------------------------------------------------------

/// The render build the command wraps; used by fixtures and the delta bench.
pub fn fill_render(store: &mut Store) -> Vec<u8> {
    let req = render_request();
    store.render.arrow_style = false;
    build_cell_render_buffers(store, &req)
}

/// The real bulk-update path -- `store_update_locations` is this plus the state lock.
pub fn update_locations(
    store: &mut Store,
    updates: &[Update<LocationPatch>],
    record_undo: bool,
) -> MutationResult {
    apply_updates(store, updates, record_undo)
}

/// Resolution only, no bitmask serialization.
pub fn resolve_selection(store: &Store, selector: &Selector) -> usize {
    let view = store.loc_view();
    selections::resolve(&view, selector).len() as usize
}

/// Setup-only population of the overlay (id alloc + add + tag counts). Fixture
/// seeding for benches that measure something downstream of adds; never the
/// measured operation itself -- that is `BenchApp::add_locations`.
pub fn seed_adds(store: &mut Store, mut locs: Vec<Location>) {
    for loc in &mut locs {
        loc.id = store.alloc_id();
    }
    store.add_tag_counts(&locs);
    for loc in locs {
        store.overlay_add(vec![loc]);
    }
}

/// The open-time O(N) pass: alive count, tag counts, bounds.
pub fn scan(store: &Store) -> usize {
    store.scan_locations().alive
}

/// Alive row count, so a bench can consume a store without naming its fields.
pub fn alive(store: &Store) -> usize {
    store.alive_count
}

// ---------------------------------------------------------------------------
// Direct internals (headline benches above are explained by these)
// ---------------------------------------------------------------------------

pub fn get_loc_by_id(store: &Store, id: u32) -> Option<Location> {
    store.get_loc_by_id(id)
}

pub fn base_loc_by_id(store: &Store, id: u32) -> Option<Location> {
    store.base_loc_by_id(id)
}

/// `old` is the row's pre-mutation state, as every caller in the app holds it.
pub fn overlay_write(store: &mut Store, loc: Location, old: &Location) -> Location {
    store.overlay_write(loc.id, loc, old)
}

pub fn overlay_update(
    store: &mut Store,
    id: u32,
    patch: &LocationPatch,
) -> Option<(Location, Location)> {
    store.overlay_update(id, patch)
}

pub fn bake_overlay(store: &mut Store) {
    store.bake_overlay();
}

pub fn rebuild_tag_sets(store: &mut Store) {
    store.rebuild_tag_sets();
}

// ---------------------------------------------------------------------------
// Map open (Arrow IPC round trip)
// ---------------------------------------------------------------------------

/// Write a population to a real Arrow IPC file, for the map-open bench to read back.
pub fn write_arrow(path: &Path, batch: &RecordBatch) {
    storage::write_arrow_ipc(path, batch).expect("write arrow");
}

/// The in-process half of `store_open_map`: mmap the Arrow file, then rebuild the
/// derived state (alive count, tag counts, bounds, tag membership index). The
/// SQLite and edit-history halves are left out -- they need an app data dir.
pub fn open_from_arrow(path: &Path, tags: &HashMap<u32, Tag>) -> Store {
    let (batch, handle) = storage::read_arrow_ipc_mmap(path).expect("read arrow");
    let n = batch.num_rows();
    let max_id = if n > 0 {
        col_id(&batch).value(n - 1)
    } else {
        0
    };
    let mut store = Store::new();
    store.map_id = Some("bench".into());
    store.batch = Some(batch);
    store.mmap_handle = Some(handle);
    store.next_id = max_id + 1;
    let agg = store.scan_locations();
    store.alive_count = agg.alive;
    store.bounds_cache = agg.bounds;
    store.bounds_dirty = false;
    store.tags.all = tags.clone();
    store.tags.counts = agg.tag_counts;
    store.tags.next_id = TAG_COUNT + 1;
    store.rebuild_tag_sets();
    store
}
