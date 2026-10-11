//! Location store: a committed Arrow batch plus an overlay of uncommitted edits.
//! Commits merge the overlay into the batch. Rows stay sorted by id for fast lookup;
//! render frames and selection membership are updated from the same row changes.

use crate::types::{AppError, AppResult};
use mma_algebra::{Counts, Delta, Patch, Patchable};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::ops::Deref;
use std::sync::Mutex;

mod dependencies;
pub(crate) use dependencies::*;
pub use frame::*;
pub(crate) use history::*;
pub use membership::*;
pub use mutations::*;
pub use persist::*;
pub use query::*;
pub use render::*;
pub use values::*;

use mma_geo::SpatialIndex;
use roaring::RoaringBitmap;

use arrow_array::RecordBatch;
use rayon::prelude::*;

use crate::selections;
use crate::store::arrow;
use crate::store::arrow::{schema, Columns};
use crate::store::maps;
use crate::types::Location;
use crate::util;
use arrow_select::concat;
use arrow_select::take;
use specta::datatype::DataType;
use specta::function::FunctionArg;
use std::mem;
use std::time::Instant;
use tauri::ipc::CommandArg;
use tauri::ipc::CommandItem;
use tauri::ipc::InvokeError;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/// Central state for one open map. Holds the immutable Arrow base batch plus an in-memory
/// overlay that accumulates mutations (adds, patches, dead). `bake_overlay` merges the
/// overlay back into the batch. The sorted ID invariant on `batch` + `overlay_adds` enables
/// O(log n) lookups via binary search. Render cells, the windows watching them, undo/redo
/// stacks, and tag metadata all live here.
///
/// The `.delta` sidecar is this overlay written as an uncommitted commit delta
/// ([`Overlay::to_delta`]), and reopening reads it back ([`Overlay::from_delta`]).
#[derive(Default, Debug, PartialEq)]
pub(crate) struct Overlay {
    pub adds: Vec<Location>,
    pub dead: RoaringBitmap,
    pub patches: HashMap<u32, Location>,
}

impl Overlay {
    /// No uncommitted content. An autosaved overlay is clean but stays non-empty until baked.
    pub(crate) fn is_empty(&self) -> bool {
        self.adds.is_empty() && self.dead.is_empty() && self.patches.is_empty()
    }

    /// These changes as a commit delta against `base`: adds and patched rows' new versions
    /// are created; patched and dead base rows are removed. A dead id absent from the base
    /// was added then removed, and is dropped.
    pub(crate) fn to_delta(&self, base: Option<&RecordBatch>) -> RecordBatch {
        let cols = base.map(Columns::of);
        let base_row = |id: u32| cols.as_ref().and_then(|c| Some(c.location(c.row_of(id)?)));
        let mut created: Vec<Location> = self.adds.clone();
        created.extend(self.patches.values().cloned());
        created.sort_unstable_by_key(|l| l.id);
        let mut removed: Vec<Location> = self
            .patches
            .keys()
            .copied()
            .chain(&self.dead)
            .filter_map(base_row)
            .collect();
        removed.sort_unstable_by_key(|l| l.id);
        arrow::delta_to_batch(&created, &removed)
    }

    /// The overlay a [`Overlay::to_delta`] batch was written from: an id on both sides is a
    /// patch, one only created is an add, one only removed is dead.
    pub(crate) fn from_delta(batch: &RecordBatch) -> Self {
        let (created, removed) = arrow::batch_to_delta(batch);
        let mut dead: RoaringBitmap = removed.iter().map(|l| l.id).collect();
        let mut overlay = Self::default();
        for l in created {
            if dead.remove(l.id) {
                overlay.patches.insert(l.id, l);
            } else {
                overlay.adds.push(l);
            }
        }
        overlay.adds.sort_unstable_by_key(|l| l.id);
        overlay.dead = dead;
        overlay
    }

    /// Apply these changes onto a plain location list read off disk.
    fn apply_to(self, locs: &mut Vec<Location>) {
        locs.retain(|l| !self.dead.contains(l.id));
        for l in locs.iter_mut() {
            if let Some(p) = self.patches.get(&l.id) {
                *l = p.clone();
            }
        }
        locs.extend(self.adds);
    }
}

pub struct Store {
    /// The open map's metadata and field definitions. Tag records live in `value_meta`.
    pub(crate) meta: Tracked<maps::MapMeta>,
    // batch is declared before mmap_handle so it drops first (columns reference the mmap).
    pub(crate) batch: Option<RecordBatch>,
    pub(crate) mmap_handle: Option<arrow::MmapHandle>,
    pub(crate) next_id: u32,
    pub(crate) version: u64,
    pub(crate) alive_count: Tracked<usize>,

    pub(crate) overlay: Tracked<Overlay>,
    pub(crate) render: RenderState,
    pub(crate) selections: SelectionState,
    /// Per-field value records. `tags` is currently the only interned field.
    pub(crate) value_meta: HashMap<String, Tracked<HashMap<u32, ValueRecord>>>,
    /// Lazy per-field indexes of live rows, maintained on mutation.
    /// Per-value counts come from index membership.
    field_indexes: selections::FieldIndexes,
    pub(crate) edits: Tracked<EditStacks>,
    pub(crate) histories: Tracked<HashMap<EntryKey, EditStacks>>,
    /// Whole-map bounds as of a store version. `update_bounds` carries it across a
    /// mutation when the change can only grow the box; otherwise it is left behind and
    /// the next read rescans. Resolved to `[w,s,e,n]` on read.
    pub(crate) bounds: Ensured<At<Option<BoundsAcc>>>,
    /// Lazy spatial index over alive locations, maintained incrementally by the overlay
    /// mutation functions. Validity is a length match against `alive_count`, so any bulk
    /// path that bypasses the overlay fns degrades to a rebuild, never wrong results.
    pub(crate) spatial: Ensured<SpatialIndex>,
    /// The windows drawing this store. A store opened afresh has none: each window
    /// subscribes when it loads its scene.
    pub(crate) frames: Sinks<FrameBytes>,
    /// Subscribers to map changes and derived state updates.
    pub(crate) changes: Sinks<ChangeEvent>,
    /// Field dependencies declared by providers.
    pub(crate) derived: ComputedFrom,
    /// Named layers of pending edits held over the map's rows.
    pub(crate) pending: HashMap<String, Pending>,
}

impl Default for Store {
    fn default() -> Self {
        Self::new()
    }
}

impl Store {
    pub fn new() -> Self {
        Self {
            meta: Tracked::default(),
            batch: None,
            mmap_handle: None,
            next_id: 1,
            version: 0,
            alive_count: Tracked::default(),
            overlay: Tracked::default(),
            render: RenderState {
                cells: [const { None }; 32],
                id_to_cell_idx: Vec::new(),
                arrow_style: false,
                marker_color: [42, 42, 42],
            },
            selections: SelectionState::default(),
            value_meta: HashMap::new(),
            field_indexes: selections::FieldIndexes::default(),
            edits: Tracked::default(),
            histories: Tracked::default(),
            bounds: Ensured::default(),
            spatial: Ensured::default(),
            frames: Sinks::default(),
            changes: Sinks::default(),
            derived: ComputedFrom::default(),
            pending: HashMap::new(),
        }
    }

    /// Every field this map's rows can hold, built-in or the map's own.
    pub(crate) fn registry(&self) -> selections::FieldRegistry<'_> {
        selections::FieldRegistry::new(&self.meta.extra.fields)
    }

    /// Increment the store version counter. JS uses this to detect stale responses.
    pub(crate) fn bump(&mut self) -> u64 {
        self.version += 1;
        self.version
    }

    /// Initial derived state for a newly opened window, marking all included values as delivered.
    pub(crate) fn open_status(&mut self) -> StoreStatus {
        self.alive_count.ship();
        self.edits.ship();
        self.histories.ship();
        self.meta.ship();
        let fields: Vec<_> = self
            .registry()
            .iter()
            .filter(|(_, def)| def.builtin.is_some() && def.index_shape() != maps::IndexShape::None)
            .map(|(key, _)| key.to_string())
            .collect();
        let field_values = self
            .fields(fields.iter().map(String::as_str))
            .into_iter()
            .map(|values| (values.field().to_string(), values.project(values.keys())))
            .collect();
        StoreStatus {
            version: self.version,
            derived: Derived {
                location_count: Some(*self.alive_count),
                meta: None,
                history: Some(self.history()),
                field_values: Some(field_values),
                field_defs: Some(self.meta.extra.fields.clone()),
                selection_counts: Some(self.selections.node_counts.clone()),
                selection_list: Some(self.selections.list()),
            },
        }
    }

    fn history(&self) -> HashMap<EntryKey, History> {
        let mut histories = self.edits.availability();
        histories.remove(&EntryKey::Selections);
        for (key, stack) in &*self.histories {
            if let Some(history) = stack.availability().get(key) {
                histories.insert(*key, *history);
            }
        }
        histories
    }

    /// Finish a row change: update derived state, broadcast frames and changes, and return its result.
    #[cfg(test)]
    pub(crate) fn finish_mutation(&mut self, changes: &Change) -> Mutation {
        let mut entry = Entry {
            rows: changes.clone(),
            ..Default::default()
        };
        entry.selections = self.selection_consequences(&entry);
        self.put_entry(&Entry {
            selections: entry.selections.clone(),
            ..Default::default()
        });
        self.finish_entry(&entry)
    }

    /// Finish a change to rows, value records, or field definitions.
    pub(crate) fn finish_entry(&mut self, entry: &Entry) -> Mutation {
        let meta = entry
            .meta
            .updated
            .first()
            .map(|(old, new)| maps::MapMeta::between(old, new));
        self.finish(
            &entry.rows,
            &entry.piles,
            !entry.selections.is_empty(),
            meta,
        )
    }

    /// Finish a change to the selection list itself: no row moves, and the frame restates
    /// every row's selection.
    pub(crate) fn finish_selection_change(&mut self) -> Mutation {
        self.finish(&Change::default(), &Piles::new(), true, None)
    }

    fn finish(
        &mut self,
        changes: &Change,
        piles: &Piles,
        selections_replaced: bool,
        meta: Option<Patch<maps::MapMeta>>,
    ) -> Mutation {
        let before = self.version;
        self.bump();
        self.update_bounds(changes, before);

        let mut moved = self.reindex(changes);
        for (field, delta) in piles {
            moved
                .entry(field.clone())
                .or_default()
                .extend(delta.keys_iter().map(|id| id.to_string()));
        }
        let field_values: HashMap<String, HashMap<String, Option<HeldValue>>> = self
            .fields(moved.keys().map(String::as_str))
            .into_iter()
            .map(|values| {
                let field = values.field();
                (
                    field.to_string(),
                    values.project(moved[field].iter().cloned()),
                )
            })
            .collect();

        // A metadata-only mutation (a value rename or reorder, a create with nothing to
        // assign) moves no rows, so there is no membership to re-test.
        let has_selections =
            (!changes.is_empty() || selections_replaced) && !self.selections.is_empty();
        let full_resolve = has_selections
            && (selections_replaced || changes.len() > 100 || self.selections.set_dependent);

        let membership_delta = if has_selections || selections_replaced {
            if full_resolve || selections_replaced {
                self.resolve_selection_membership();
                None
            } else {
                Some(self.selections.update(changes))
            }
        } else {
            None
        };

        // Every row the frame carries states its selection, so an incremental membership
        // change needs no second channel: a row that only gained or lost a selection comes
        // out as a patch. Only a full resolve restates every cell's membership, which costs
        // O(rows in the affected cells) where the patches cost O(changed).
        let changed = membership_delta.unwrap_or_default();
        let cells = self.derive_cell_frames(changes, &changed);
        let restated = full_resolve || selections_replaced;
        let frame = Frame {
            kind: FrameKind::PATCH,
            version: self.version,
            palette: self.selections.palette(),
            cells: Frame::cells_of(cells),
            selection: restated.then(|| self.selection_section()),
        };
        if !self.frames.is_empty() {
            self.frames.send(FrameBytes(frame.encode()));
        }

        let mut derived = Derived {
            meta,
            field_values: (!field_values.is_empty()).then_some(field_values),
            field_defs: self.meta.ship().then(|| self.meta.extra.fields.clone()),
            selection_counts: (has_selections || selections_replaced)
                .then(|| self.selections.node_counts.clone()),
            selection_list: (selections_replaced || piles.values().any(|delta| !delta.is_empty()))
                .then(|| self.selections.list()),
            ..Default::default()
        };
        if self.alive_count.ship() {
            derived.location_count = Some(*self.alive_count);
        }
        if self.edits.ship() | self.histories.ship() {
            derived.history = Some(self.history());
        }
        let keys = changes.keys();
        let result = Mutation {
            version: self.version,
            added: keys.added.clone(),
        };
        // Announce every version, including no-ops, so callers can await their mutation.
        self.changes.send(ChangeEvent {
            version: self.version,
            keys,
            derived,
        });
        result
    }

    /// Allocate the next monotonically increasing location ID.
    pub(crate) fn alloc_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Look up a location by ID across patches, overlay_adds (binary search), and batch.
    pub(crate) fn get_loc_by_id(&self, id: u32) -> Option<Location> {
        self.rows().get(id).map(|row| row.to_location())
    }

    /// Read a single location from the committed base batch by id (ignores the
    /// overlay). O(log n). Used to recover the pre-edit version of a row.
    fn base_loc_by_id(&self, id: u32) -> Option<Location> {
        let cols = Columns::of(self.batch.as_ref()?);
        Some(cols.location(cols.row_of(id)?))
    }

    /// Net row changes since the last commit, counted without cloning rows.
    /// Rows added and then removed contribute nothing.
    pub(crate) fn overlay_diff_counts(&self) -> Counts {
        let in_base = |id: u32| {
            self.batch
                .as_ref()
                .is_some_and(|b| Columns::of(b).row_of(id).is_some())
        };
        let mut added = self.overlay.adds.len() as u32;
        let mut updated = 0u32;
        for &id in self.overlay.patches.keys() {
            if in_base(id) {
                updated += 1;
            } else {
                added += 1;
            }
        }
        let removed = self.overlay.dead.iter().filter(|&id| in_base(id)).count() as u32;
        Counts {
            added,
            removed,
            updated,
        }
    }

    /// Insert or restore locations in the overlay. `adds` stays sorted by id (the invariant
    /// `bake_overlay` asserts): fresh ids sort above everything and are appended, O(k);
    /// anything else (an undo re-adding old ids) is merged in one linear pass, O(n + k),
    /// where inserting each row into its slot would shift the rows above it, O(n * k).
    fn overlay_add(&mut self, locs: Vec<Location>) {
        let mut fresh: Vec<Location> = Vec::with_capacity(locs.len());
        for loc in locs {
            *self.alive_count.edit() += 1;
            if let Some(ix) = self.spatial.if_built_mut() {
                ix.insert(loc.id, loc.lat, loc.lng);
            }
            self.overlay.edit().dead.remove(loc.id);
            let in_batch = self
                .batch
                .as_ref()
                .and_then(|b| Columns::of(b).row_of(loc.id))
                .is_some();
            if !in_batch {
                fresh.push(loc);
            } else if self.base_loc_by_id(loc.id).as_ref() == Some(&loc) {
                self.overlay.edit().patches.remove(&loc.id);
            } else {
                self.overlay.edit().patches.insert(loc.id, loc);
            }
        }
        if fresh.is_empty() {
            return;
        }
        fresh.sort_unstable_by_key(|l| l.id);
        if cfg!(debug_assertions) {
            if let Some(w) = fresh.windows(2).find(|w| w[0].id == w[1].id) {
                panic!(
                    "overlay_add duplicate id {} -- next_id allocation bug",
                    w[1].id
                );
            }
        }
        let adds = &mut self.overlay.edit().adds;
        if adds.last().is_none_or(|last| last.id < fresh[0].id) {
            adds.extend(fresh);
        } else {
            let old = mem::take(adds);
            let mut merged = Vec::with_capacity(old.len() + fresh.len());
            let mut a = old.into_iter().peekable();
            let mut b = fresh.into_iter().peekable();
            loop {
                let take_a = match (a.peek(), b.peek()) {
                    (Some(x), Some(y)) => x.id < y.id,
                    (Some(_), None) => true,
                    (None, Some(_)) => false,
                    (None, None) => break,
                };
                merged.extend(if take_a { a.next() } else { b.next() });
            }
            if cfg!(debug_assertions) {
                if let Some(w) = merged.windows(2).find(|w| w[0].id == w[1].id) {
                    panic!(
                        "overlay_add duplicate id {} -- next_id allocation bug",
                        w[1].id
                    );
                }
            }
            *adds = merged;
        }
    }

    /// Mark locations as dead in the overlay. O(L) for L locations removed.
    fn overlay_remove<'a>(&mut self, locs: impl Iterator<Item = &'a Location>) {
        let mut remove_set: HashSet<u32> = HashSet::new();
        for loc in locs {
            remove_set.insert(loc.id);
            *self.alive_count.edit() -= 1;
            // Index under the CURRENT coords, not the caller's copy: a patched
            // location's overlay coords are where the index filed it.
            let (lat, lng) = self.coords_of(loc.id).unwrap_or((loc.lat, loc.lng));
            if let Some(ix) = self.spatial.if_built_mut() {
                if !ix.remove(loc.id, lat, lng) {
                    log::warn!("[spatial] remove miss for id {}", loc.id);
                }
            }
            self.overlay.edit().patches.remove(&loc.id);
        }
        self.overlay.edit().dead.extend(&remove_set);
        self.overlay
            .edit()
            .adds
            .retain(|l| !remove_set.contains(&l.id));
    }

    /// Reset overlay state. Called after bake or on map close.
    fn clear_overlay(&mut self) {
        let overlay = self.overlay.edit();
        overlay.adds.clear();
        overlay.dead.clear();
        overlay.patches.clear();
        self.overlay.mark_saved();
    }

    /// Merge overlay (adds, patches, dead) into the Arrow batch.
    #[cfg(any(test, feature = "bench"))]
    pub(crate) fn bake_overlay(&mut self) {
        if let Some(batch) = self.baked_batch() {
            self.adopt_base(batch);
        }
    }

    /// Make `batch` the base and clear the overlay it already holds.
    fn adopt_base(&mut self, batch: RecordBatch) {
        self.batch = Some(batch);
        self.field_indexes.clear();
        self.clear_overlay();
    }

    /// Every live location as one batch: the base with the overlay merged in, or `None` for a
    /// store with no base and nothing in its overlay.
    pub(crate) fn current_batch(&self) -> Option<RecordBatch> {
        self.baked_batch().or_else(|| self.batch.clone())
    }

    /// The base batch with the overlay merged in, or `None` when there is nothing to merge.
    /// O(N) where N = batch rows. Expensive at 10M+ rows - prefer delta saves; full bake only on commit.
    /// Gated on emptiness: an autosave folds nothing in, so a saved overlay must still bake.
    fn baked_batch(&self) -> Option<RecordBatch> {
        if self.overlay.is_empty() {
            return None;
        }
        let _t = Instant::now();

        let Some(mut batch) = self.batch.clone() else {
            return Some(arrow::locations_to_batch(&self.overlay.adds));
        };

        // Step 1: filter out dead rows
        if !self.overlay.dead.is_empty() {
            let ids = Columns::id(&batch);
            let keep: Vec<u32> = (0..batch.num_rows())
                .filter(|&i| !self.overlay.dead.contains(ids.value(i)))
                .map(|i| i as u32)
                .collect();
            if keep.len() < batch.num_rows() {
                let take_idx = arrow_array::UInt32Array::from(keep);
                batch = RecordBatch::try_new(
                    batch.schema(),
                    batch
                        .columns()
                        .iter()
                        .map(|col| take::take(col.as_ref(), &take_idx, None).unwrap())
                        .collect(),
                )
                .unwrap();
            }
        }

        // Step 2: apply patches column-wise (preserves row order for sorted ID invariant)
        if !self.overlay.patches.is_empty() {
            batch = arrow::patch_batch(&batch, &self.overlay.patches);
        }

        // Step 3: concat adds
        if !self.overlay.adds.is_empty() {
            let add_batch = arrow::locations_to_batch(&self.overlay.adds);
            let s = schema();
            batch = concat::concat_batches(&s, &[batch, add_batch]).expect("concat failed");
        }

        log::debug!(
            "[bake_overlay] total={}ms rows={}",
            _t.elapsed().as_millis(),
            batch.num_rows()
        );
        assert!(
            {
                let ids = Columns::id(&batch);
                (1..batch.num_rows()).all(|i| ids.value(i - 1) < ids.value(i))
            },
            "batch IDs must be strictly sorted after bake"
        );
        Some(batch)
    }
}

/// Manages multiple open `Store` instances, keyed by map ID, with a
/// window-label-to-map-ID registry so each Tauri webview operates on
/// its own map without clobbering others.
pub struct StoreManager {
    pub(crate) stores: HashMap<String, Store>,
    pub(crate) window_map: HashMap<String, String>,
    /// Field dependencies shared with each opened store.
    pub(crate) derived: ComputedFrom,
}

impl StoreManager {
    pub fn new() -> Self {
        Self {
            stores: HashMap::new(),
            window_map: HashMap::new(),
            derived: ComputedFrom::default(),
        }
    }

    pub fn store_for_window(&mut self, label: &str) -> AppResult<&mut Store> {
        let map_id = self
            .window_map
            .get(label)
            .ok_or_else(|| format!("no map open in window '{label}'"))?
            .clone();
        self.stores
            .get_mut(&map_id)
            .ok_or_else(|| AppError(format!("store not found for map '{map_id}'")))
    }

    pub fn store_for_map(&mut self, map_id: &str) -> AppResult<&mut Store> {
        self.stores
            .get_mut(map_id)
            .ok_or_else(|| AppError(format!("no store for map '{map_id}'")))
    }

    pub fn map_id_for_window(&self, label: &str) -> AppResult<String> {
        self.window_map
            .get(label)
            .cloned()
            .ok_or_else(|| AppError(format!("no map open in window '{label}'")))
    }

    /// Unbind `label` from its map, handing back the map's store to flush when no
    /// other window still has it open.
    pub fn unbind_window(&mut self, label: &str) -> Option<(String, Store)> {
        let map_id = self.window_map.remove(label)?;
        if let Some(store) = self.stores.get_mut(&map_id) {
            store.frames.remove(label);
            store.changes.remove(label);
        }
        if self.window_map.values().any(|v| v == &map_id) {
            log::debug!("[close_map] {map_id} still open in another window, skipping flush");
            return None;
        }
        let Some(store) = self.stores.remove(&map_id) else {
            log::debug!("[close_map] {map_id} has no store, nothing to flush");
            return None;
        };
        Some((map_id, store))
    }
}

pub type StoreState = Mutex<StoreManager>;

macro_rules! with_store {
    ($label:expr, $state:expr, |$store:ident| $body:block) => {{
        let mut mgr = $state.lock()?;
        let $store = mgr.store_for_window(&$label.0)?;
        $body
    }};
}
pub(crate) use with_store;

/// The invoking window's label, extracted from the IPC call. Commands take this
/// instead of a `Webview` so they stay runtime-agnostic and directly callable
/// (benches, tests) with any label the `StoreManager` knows. Invisible to TS:
/// the `FunctionArg` impl skips it in the generated bindings.
pub struct WindowLabel(pub String);

impl<'de, R: tauri::Runtime> CommandArg<'de, R> for WindowLabel {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        Ok(Self(command.message.webview_ref().label().to_string()))
    }
}

impl FunctionArg for WindowLabel {
    fn to_datatype(_: &mut specta::Types) -> Option<DataType> {
        None
    }
}

// Versioned map state: all derived fields on open, changed fields after an edit.
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StoreStatus {
    pub version: u64,
    pub derived: Derived,
}

/// Something that was correct at revision `rev` of its source: a consumer's watermark
/// (`At<()>`, satisfied by any later revision) or a derived cache (valid at exactly one).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct At<T> {
    rev: u64,
    value: T,
}

impl<T> At<T> {
    pub(crate) fn new(rev: u64, value: T) -> Self {
        Self { rev, value }
    }

    /// A derived value is right only for the revision it was computed at.
    pub(crate) fn current(&self, rev: u64) -> bool {
        self.rev == rev
    }

    /// A consumer that has seen `self.rev` has seen everything up to it.
    pub(crate) fn covers(&self, rev: u64) -> bool {
        self.rev >= rev
    }

    pub(crate) fn rev(&self) -> u64 {
        self.rev
    }

    pub(crate) fn value(&self) -> &T {
        &self.value
    }
}

/// A derived cache's validity check, rebuild function, and storage slot.
pub(crate) trait Cached: Sized {
    fn valid(&self, store: &Store) -> bool;
    fn build(store: &Store) -> Self;
    fn slot(store: &mut Store) -> &mut Ensured<Self>;
    fn slot_ref(store: &Store) -> &Ensured<Self>;
}

/// A cache that checks validity and rebuilds before use.
#[derive(Debug)]
pub(crate) struct Ensured<T>(Option<T>);

impl<T> Default for Ensured<T> {
    fn default() -> Self {
        Self(None)
    }
}

impl<T: Cached> Ensured<T> {
    /// Ensure, then read beside the store: the closure gets the value and the store as
    /// shared borrows, so answers can be checked against live rows in the same pass.
    pub(crate) fn with<R>(store: &mut Store, f: impl FnOnce(&T, &Store) -> R) -> R {
        let val = match T::slot(store).0.take() {
            Some(v) if v.valid(store) => v,
            _ => T::build(store),
        };
        T::slot(store).0 = Some(val);
        let store = &*store;
        f(
            T::slot_ref(store).0.as_ref().expect("just installed"),
            store,
        )
    }
}

impl<T> Ensured<T> {
    /// Install a value computed elsewhere (an open-time scan that already walked the rows).
    pub(crate) fn seed(&mut self, value: T) {
        self.0 = Some(value);
    }

    /// Maintain in place when built; never builds. Staleness is the next read's problem.
    pub(crate) fn if_built_mut(&mut self) -> Option<&mut T> {
        self.0.as_mut()
    }

    /// Read the cached value without checking validity. The caller must ensure it first.
    pub(crate) fn peek(&self) -> Option<&T> {
        self.0.as_ref()
    }
}

/// Revision-tracked state, with separate delivery and save progress.
/// Edits made during an asynchronous save remain unsaved.
#[derive(Debug, Default)]
pub(crate) struct Tracked<T> {
    value: T,
    rev: u64,
    shipped: At<()>,
    saved: At<()>,
}

impl<T> Tracked<T> {
    /// A value both JS and disk already hold (map open).
    pub(crate) fn new(value: T) -> Self {
        Self {
            value,
            rev: 0,
            shipped: At::new(0, ()),
            saved: At::new(0, ()),
        }
    }

    /// A value disk does not hold yet.
    pub(crate) fn unsaved(value: T) -> Self {
        Self {
            value,
            rev: 1,
            shipped: At::new(1, ()),
            saved: At::new(0, ()),
        }
    }

    pub(crate) fn edit(&mut self) -> &mut T {
        self.rev += 1;
        &mut self.value
    }

    pub(crate) fn replace(&mut self, value: T) {
        self.value = value;
        self.rev += 1;
    }

    pub(crate) fn rev(&self) -> u64 {
        self.rev
    }

    /// Something derived from the value now, stamped with the revision it reflects.
    pub(crate) fn stamp<R>(&self, derived: R) -> At<R> {
        At::new(self.rev, derived)
    }

    /// Mark the current revision as seen by JS; true when it had not been.
    pub(crate) fn ship(&mut self) -> bool {
        if self.shipped.covers(self.rev) {
            false
        } else {
            self.shipped = At::new(self.rev, ());
            true
        }
    }

    pub(crate) fn is_unsaved(&self) -> bool {
        !self.saved.covers(self.rev)
    }

    /// Disk now holds revision `rev`. A later edit keeps the value unsaved.
    pub(crate) fn saved_at(&mut self, rev: u64) {
        if !self.saved.covers(rev) {
            self.saved = At::new(rev, ());
        }
    }

    pub(crate) fn mark_saved(&mut self) {
        self.saved = At::new(self.rev, ());
    }
}

impl<T> Deref for Tracked<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.value
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

pub(crate) mod delta_legacy;
pub(crate) mod frame;
mod history;
mod membership;
mod mutations;
mod persist;
pub(crate) mod query;
mod render;
mod values;

#[cfg(test)]
#[path = "engine.test.rs"]
pub(crate) mod tests;

#[cfg(feature = "bench")]
#[path = "engine.bench.rs"]
pub mod bench;

/// The engine's own write on every real change to a row.
fn touch(loc: &mut Location) {
    loc.modified_at = Some(util::now_unix());
}

#[cfg(test)]
#[path = "engine/save_concurrency.test.rs"]
mod save_concurrency_tests;
