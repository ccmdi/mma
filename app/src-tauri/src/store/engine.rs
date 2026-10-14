//! Location store: a committed Arrow batch plus an overlay of uncommitted edits.
//! Commits merge the overlay into the batch. Rows stay sorted by id for fast lookup;
//! render frames and selection membership are updated from the same row changes.

use crate::procedure::engine;
use crate::procedure::registry::Providers;
use crate::store::maps::MapMeta;
use crate::types::{AppError, AppResult, Location};
use mma_algebra::{Counts, Delta, Id, Ids};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::ops::Deref;
use std::sync::{Arc, Mutex};
use std::{fmt, mem};
use tokio::sync;

mod dependents;
pub use frame::*;
pub(crate) use history::*;
pub use membership::*;
pub use mutations::*;
pub use persist::*;
pub use query::*;
pub use render::*;
pub use values::*;

use crate::store::id_set::IdSet;
use mma_geo::SpatialIndex;

use arrow_array::RecordBatch;
use rayon::prelude::*;

use crate::selections;
use crate::store::arrow::{schema, Columns};
use crate::store::{arrow, maps, storage};
use arrow_select::{concat, take};
use specta::datatype::DataType;
use specta::function::FunctionArg;
use std::time::Instant;
use tauri::ipc::{CommandArg, CommandItem, InvokeError};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/// Uncommitted changes over the base batch: added rows sorted by id, removed ids, and
/// updated rows whole, by id. The `.delta` sidecar is this overlay written as an uncommitted
/// commit delta ([`Overlay::to_delta`]), and reopening reads it back ([`Overlay::from_delta`]).
#[derive(Default, Debug, PartialEq)]
pub(crate) struct Overlay {
    pub added: Vec<Location>,
    pub removed: IdSet<Location>,
    pub updated: HashMap<Id<Location>, Location>,
}

impl Overlay {
    /// No uncommitted content. An autosaved overlay is clean but stays non-empty until baked.
    pub(crate) fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.updated.is_empty()
    }

    /// These changes as a commit delta against `base`: adds and patched rows' new versions
    /// are created; patched and dead base rows are removed. A dead id absent from the base
    /// was added then removed, and is dropped.
    pub(crate) fn to_delta(&self, base: Option<&RecordBatch>) -> RecordBatch {
        let cols = base.map(Columns::of);
        let base_row =
            |id: Id<Location>| cols.as_ref().and_then(|c| Some(c.location(c.row_of(id)?)));
        let mut created: Vec<Location> = self.added.clone();
        created.extend(self.updated.values().cloned());
        created.sort_unstable_by_key(|l| l.id);
        let mut removed: Vec<Location> = self
            .updated
            .keys()
            .copied()
            .chain(&self.removed)
            .filter_map(base_row)
            .collect();
        removed.sort_unstable_by_key(|l| l.id);
        arrow::delta_to_batch(&created, &removed)
    }

    /// The overlay a [`Overlay::to_delta`] batch was written from: an id on both sides is a
    /// patch, one only created is an add, one only removed is dead.
    pub(crate) fn from_delta(batch: &RecordBatch) -> Self {
        let (created, removed) = arrow::batch_to_delta(batch);
        let mut dead: IdSet<Location> = removed.iter().map(|l| l.id).collect();
        let mut overlay = Self::default();
        for l in created {
            if dead.remove(l.id) {
                overlay.updated.insert(l.id, l);
            } else {
                overlay.added.push(l);
            }
        }
        overlay.added.sort_unstable_by_key(|l| l.id);
        overlay.removed = dead;
        overlay
    }

    /// Apply these changes onto a plain location list read off disk.
    fn apply_to(self, locs: &mut Vec<Location>) {
        locs.retain(|l| !self.removed.contains(l.id));
        for l in locs.iter_mut() {
            if let Some(p) = self.updated.get(&l.id) {
                *l = p.clone();
            }
        }
        locs.extend(self.added);
    }
}

/// Central state for one open map: the immutable Arrow base batch, the overlay of uncommitted
/// changes on it, render cells and the windows watching them, undo stacks, and value records.
/// [`Store::bake_overlay`] merges the overlay into the batch. Rows are sorted by id in both
/// `batch` and `overlay.added`, so a lookup by id is a binary search.
pub struct Store {
    /// The open map's metadata. Value records live in `records`, field definitions in
    /// `field_defs`, and `meta` keeps neither.
    pub(crate) meta: Tracked<MapMeta>,
    /// The map's extra-field definitions.
    pub(crate) field_defs: Tracked<HashMap<String, maps::FieldDef>>,
    // batch is declared before mmap_handle so it drops first (columns reference the mmap).
    pub(crate) batch: Option<RecordBatch>,
    pub(crate) mmap_handle: Option<arrow::MmapHandle>,
    pub(crate) next_id: Ids<Id<Location>>,
    pub(crate) version: u64,
    pub(crate) alive_count: Tracked<usize>,

    pub(crate) overlay: Tracked<Overlay>,
    /// Net row changes since the last commit, recounted whenever the overlay moves.
    pub(crate) pending_counts: Tracked<Counts>,
    pub(crate) render: RenderState,
    pub(crate) selections: SelectionState,
    /// Each interned field's value records.
    pub(crate) records: HashMap<String, Tracked<HashMap<Id<ValueRecord>, ValueRecord>>>,
    /// Lazy per-field indexes of live rows, maintained on mutation.
    /// Per-value counts come from index membership.
    field_indexes: selections::FieldIndexes,
    pub(crate) steps: Timelines,
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
    /// Pending layers that procedure work is currently writing to.
    pub(crate) writing_layers: Tracked<BTreeSet<String>>,
    /// Whether disk lacks some of this state, as last derived.
    pub(crate) has_unsaved: Tracked<bool>,
    /// Field dependencies declared by providers.
    pub(crate) dependents: Arc<mma_algebra::Dependents<String>>,
    /// Named layers of pending edits held over the map's rows.
    pub(crate) pending: HashMap<String, Pending>,
}

/// What a finished change touched.
#[derive(Clone, Copy)]
pub(crate) enum Finished<'a> {
    /// An entry's rows, value records, field definitions, or selections.
    Entry(&'a Entry),
    /// The base rows were rewritten, so every row restates its selection.
    Base,
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
            field_defs: Tracked::default(),
            batch: None,
            mmap_handle: None,
            next_id: Ids::default(),
            version: 0,
            alive_count: Tracked::default(),
            overlay: Tracked::default(),
            pending_counts: Tracked::default(),
            render: RenderState {
                cells: [const { None }; 32],
                id_to_cell_idx: Vec::new(),
                arrow_style: false,
                marker_color: DEFAULT_MARKER_COLOR,
            },
            selections: SelectionState::default(),
            records: HashMap::new(),
            field_indexes: selections::FieldIndexes::default(),
            steps: Timelines::default(),
            bounds: Ensured::default(),
            spatial: Ensured::default(),
            frames: Sinks::default(),
            changes: Sinks::default(),
            writing_layers: Tracked::default(),
            has_unsaved: Tracked::default(),
            dependents: Default::default(),
            pending: HashMap::new(),
        }
    }

    /// Every field this map's rows can hold, built-in or the map's own.
    pub(crate) fn registry(&self) -> selections::FieldRegistry<'_> {
        selections::FieldRegistry::new(&self.field_defs)
    }

    /// Increment the store version counter. JS uses this to detect stale responses.
    pub(crate) fn bump(&mut self) -> u64 {
        self.version += 1;
        self.version
    }

    /// Current map metadata projected from its owned state and location changes.
    pub(crate) fn map(&self) -> MapMeta {
        MapMeta {
            extra: maps::MapExtra {
                fields: (*self.field_defs).clone(),
            },
            location_count: *self.alive_count as i64,
            pending: self.overlay_diff_counts(),
            ..(*self.meta).clone()
        }
    }

    /// The derived state whose sources moved since they last shipped. Changes that are not
    /// held in a tracked slice, such as field values, join it per change.
    fn shipped(&mut self) -> Derived {
        self.count_pending();
        let unsaved = self.is_unsaved();
        if unsaved != *self.has_unsaved {
            self.has_unsaved.replace(unsaved);
        }
        Derived {
            location_count: self.alive_count.ship().then(|| *self.alive_count),
            pending: self.pending_counts.ship().then(|| *self.pending_counts),
            meta: self
                .meta
                .ship()
                .then(|| maps::MapDetails((*self.meta).clone())),
            history: self.steps.ship().then(|| self.history()),
            field_values: None,
            field_defs: self.field_defs.ship().then(|| (*self.field_defs).clone()),
            selection_counts: None,
            selection_list: None,
            writing_layers: self
                .writing_layers
                .ship()
                .then(|| (*self.writing_layers).clone()),
            unsaved: self.has_unsaved.ship().then(|| *self.has_unsaved),
        }
    }

    /// Initial derived state for a newly opened window, marking all included values as delivered.
    pub(crate) fn open_status(&mut self) -> StoreStatus {
        self.writing_layers
            .replace(engine::pending_writers(&self.meta.id));
        self.shipped();
        let fields: Vec<_> = self
            .registry()
            .iter()
            .filter(|(_, def)| {
                (def.builtin.is_some() || def.interned)
                    && def.index_shape() != maps::IndexShape::None
            })
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
                pending: Some(*self.pending_counts),
                meta: Some(maps::MapDetails((*self.meta).clone())),
                history: Some(self.history()),
                field_values: Some(field_values),
                field_defs: Some((*self.field_defs).clone()),
                selection_counts: Some(self.selections.node_counts.clone()),
                selection_list: Some(self.selections.list()),
                writing_layers: Some((*self.writing_layers).clone()),
                unsaved: Some(*self.has_unsaved),
            },
        }
    }

    /// Finish a row change: update derived state, broadcast frames and changes, and return its result.
    #[cfg(test)]
    pub(crate) fn finish_mutation(&mut self, changes: &Change) -> Mutation {
        let mut entry = Entry {
            locations: changes.clone(),
            ..Default::default()
        };
        entry.selections = self.selection_consequences(&entry);
        self.put_entry(&Entry {
            selections: entry.selections.clone(),
            ..Default::default()
        });
        self.finish(Finished::Entry(&entry))
    }

    /// Recount the pending changes if the overlay moved since they were last counted.
    fn count_pending(&mut self) {
        if self.overlay.ship() {
            let counts = self.overlay_diff_counts();
            if counts != *self.pending_counts {
                self.pending_counts.replace(counts);
            }
        }
    }

    /// Update derived state for what changed, broadcast frames and changes, and return its result.
    pub(crate) fn finish(&mut self, finished: Finished) -> Mutation {
        let empty = Entry::default();
        let (entry, resolve_all) = match finished {
            Finished::Entry(entry) => (entry, !entry.selections.is_empty()),
            Finished::Base => (&empty, true),
        };
        let (changes, records) = (&entry.locations, &entry.records);
        let before = self.version;
        self.bump();
        self.update_bounds(changes, before);

        let mut moved = self.reindex(changes);
        for (field, delta) in records {
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
        let has_selections = (!changes.is_empty() || resolve_all) && !self.selections.is_empty();
        let full_resolve =
            has_selections && (resolve_all || changes.len() > 100 || self.selections.set_dependent);

        let membership_delta = if has_selections || resolve_all {
            if full_resolve || resolve_all {
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
        let restated = full_resolve || resolve_all;
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

        let derived = Derived {
            field_values: (!field_values.is_empty()).then_some(field_values),
            selection_counts: (has_selections || resolve_all)
                .then(|| self.selections.node_counts.clone()),
            selection_list: (resolve_all || records.values().any(|delta| !delta.is_empty()))
                .then(|| self.selections.list()),
            ..self.shipped()
        };
        let result = Mutation {
            version: self.version,
            keys: Vec::new(),
            history_cleared: false,
        };
        // Announce every version, including no-ops, so callers can await their mutation.
        self.changes.send(ChangeEvent {
            version: self.version,
            keys: changes.keys(),
            derived,
        });
        result
    }

    /// Look up a location by ID across updated rows, added rows (binary search), and batch.
    pub(crate) fn get_loc_by_id(&self, id: Id<Location>) -> Option<Location> {
        self.view().get(id).map(|row| row.to_location())
    }

    /// Read a single location from the committed base batch by id (ignores the
    /// overlay). O(log n). Used to recover the pre-edit version of a row.
    fn base_loc_by_id(&self, id: Id<Location>) -> Option<Location> {
        let cols = Columns::of(self.batch.as_ref()?);
        Some(cols.location(cols.row_of(id)?))
    }

    /// Net row changes since the last commit, counted off the overlay without cloning rows,
    /// since undo history is capped and drops oversized steps. Rows added and then removed
    /// contribute nothing.
    pub(crate) fn overlay_diff_counts(&self) -> Counts {
        let in_base = |id: Id<Location>| {
            self.batch
                .as_ref()
                .is_some_and(|b| Columns::of(b).row_of(id).is_some())
        };
        let mut added = self.overlay.added.len() as u32;
        let mut updated = 0u32;
        for &id in self.overlay.updated.keys() {
            if in_base(id) {
                updated += 1;
            } else {
                added += 1;
            }
        }
        let removed = self
            .overlay
            .removed
            .iter()
            .filter(|&id| in_base(id))
            .count() as u32;
        Counts {
            added,
            removed,
            updated,
        }
    }

    /// Insert or restore locations in the overlay. `added` stays sorted by id (the invariant
    /// `bake_overlay` asserts): fresh ids sort above everything and are appended, O(k);
    /// anything else (an undo re-adding old ids) is merged in one linear pass, O(n + k),
    /// where inserting each row into its slot would shift the rows above it, O(n * k).
    fn overlay_add(&mut self, locs: Vec<Location>) {
        let mut fresh: Vec<Location> = Vec::with_capacity(locs.len());
        for loc in locs {
            *self.alive_count.edit() += 1;
            if let Some(ix) = self.spatial.if_built_mut() {
                ix.insert(loc.id.get(), loc.lat, loc.lng);
            }
            self.overlay.edit().removed.remove(loc.id);
            let in_batch = self
                .batch
                .as_ref()
                .and_then(|b| Columns::of(b).row_of(loc.id))
                .is_some();
            if !in_batch {
                fresh.push(loc);
            } else if self.base_loc_by_id(loc.id).as_ref() == Some(&loc) {
                self.overlay.edit().updated.remove(&loc.id);
            } else {
                self.overlay.edit().updated.insert(loc.id, loc);
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
        let adds = &mut self.overlay.edit().added;
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
        let mut remove_set: HashSet<Id<Location>> = HashSet::new();
        for loc in locs {
            remove_set.insert(loc.id);
            *self.alive_count.edit() -= 1;
            // Index under the CURRENT coords, not the caller's copy: a patched
            // location's overlay coords are where the index filed it.
            let (lat, lng) = self.coords_of(loc.id).unwrap_or((loc.lat, loc.lng));
            if let Some(ix) = self.spatial.if_built_mut() {
                if !ix.remove(loc.id.get(), lat, lng) {
                    log::warn!("[spatial] remove miss for id {}", loc.id);
                }
            }
            self.overlay.edit().updated.remove(&loc.id);
        }
        self.overlay
            .edit()
            .removed
            .extend(remove_set.iter().copied());
        self.overlay
            .edit()
            .added
            .retain(|l| !remove_set.contains(&l.id));
    }

    /// Reset overlay state. Called after bake or on map close.
    fn clear_overlay(&mut self) {
        let overlay = self.overlay.edit();
        overlay.added.clear();
        overlay.removed.clear();
        overlay.updated.clear();
        self.overlay.mark_saved();
    }

    /// Merge overlay (added, updated, removed) into the Arrow batch.
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
            return Some(arrow::locations_to_batch(&self.overlay.added));
        };

        // Step 1: filter out dead rows
        if !self.overlay.removed.is_empty() {
            let ids = Columns::id(&batch);
            let keep: Vec<u32> = (0..batch.num_rows())
                .filter(|&i| !self.overlay.removed.contains(Id::new(ids.value(i))))
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
        if !self.overlay.updated.is_empty() {
            batch = arrow::patch_batch(&batch, &self.overlay.updated);
        }

        // Step 3: concat adds
        if !self.overlay.added.is_empty() {
            let add_batch = arrow::locations_to_batch(&self.overlay.added);
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
    pub(crate) stores: HashMap<Id<MapMeta, String>, Store>,
    pub(crate) window_map: HashMap<WindowLabel, Id<MapMeta, String>>,
    /// Registered providers, whose field dependencies every opened store shares.
    pub(crate) providers: Providers,
    /// Each map's files lock, held across every read-to-write of its files on disk.
    files: HashMap<Id<MapMeta, String>, Arc<sync::Mutex<()>>>,
}

impl StoreManager {
    pub fn new() -> Self {
        Self {
            stores: HashMap::new(),
            window_map: HashMap::new(),
            providers: Default::default(),
            files: HashMap::new(),
        }
    }

    /// The lock a map's files are written under: an open, save, commit, close, or write to
    /// the closed map holds it, so none of them interleave.
    pub(crate) fn files(&mut self, map_id: &Id<MapMeta, String>) -> Arc<sync::Mutex<()>> {
        self.files.entry(map_id.clone()).or_default().clone()
    }

    /// The map a target names.
    pub(crate) fn target_map(
        &self,
        label: &WindowLabel,
        target: &Target,
    ) -> AppResult<Id<MapMeta, String>> {
        match target {
            Target::Map { id: Some(id) } => Ok(id.clone()),
            _ => self.map_id_for_window(label),
        }
    }

    pub fn store_for_window(&mut self, label: &WindowLabel) -> AppResult<&mut Store> {
        let map_id = self
            .window_map
            .get(label)
            .ok_or_else(|| format!("no map open in window '{label}'"))?
            .clone();
        self.stores
            .get_mut(&map_id)
            .ok_or_else(|| AppError(format!("store not found for map '{map_id}'")))
    }

    pub fn store_for_map(&mut self, map_id: &Id<MapMeta, String>) -> AppResult<&mut Store> {
        self.stores
            .get_mut(map_id)
            .ok_or_else(|| AppError(format!("no store for map '{map_id}'")))
    }

    pub fn map_id_for_window(&self, label: &WindowLabel) -> AppResult<Id<MapMeta, String>> {
        self.window_map
            .get(label)
            .cloned()
            .ok_or_else(|| AppError(format!("no map open in window '{label}'")))
    }

    /// Unbind `label` from its map, handing back the map's store to flush when no
    /// other window still has it open.
    pub fn unbind_window(&mut self, label: &WindowLabel) -> Option<(Id<MapMeta, String>, Store)> {
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

/// Run `f` on the store `target` names: this window's, the live store of a map open in any
/// window, or a closed map loaded from disk and saved after `f`, under its files lock.
// Lock order: files lock, then manager lock; never wait for a files lock under the manager lock.
pub(crate) fn with_target<R>(
    state: &StoreState,
    label: &WindowLabel,
    target: &Target,
    f: impl FnOnce(&mut Store) -> AppResult<R>,
) -> AppResult<R> {
    let (map_id, files) = {
        let mut mgr = state.lock()?;
        let map_id = mgr.target_map(label, target)?;
        if let Some(store) = mgr.stores.get_mut(&map_id) {
            return f(store);
        }
        let Target::Map { id: Some(_) } = target else {
            return Err(AppError(format!("store not found for map '{map_id}'")));
        };
        let files = mgr.files(&map_id);
        (map_id, files)
    };
    let _writing = files.blocking_lock();
    let dependents = {
        let mut mgr = state.lock()?;
        if let Some(store) = mgr.stores.get_mut(&map_id) {
            return f(store);
        }
        mgr.providers.dependents()
    };
    let mut store = load_store(&map_id)?;
    store.dependents = dependents;
    let result = f(&mut store)?;
    if let Some(unsaved) = store.unsaved()? {
        unsaved.write(
            &storage::open_db()?,
            &map_id,
            &storage::arrow_delta_path(&map_id)?,
        )?;
    }
    Ok(result)
}

macro_rules! with_store {
    ($label:expr, $state:expr, |$store:ident| $body:block) => {{
        let mut mgr = $state.lock()?;
        let $store = mgr.store_for_window(&$label)?;
        $body
    }};
}
pub(crate) use with_store;

/// The invoking window's label, extracted from the IPC call. Commands take this
/// instead of a `Webview` so they stay runtime-agnostic and directly callable
/// (benches, tests) with any label the `StoreManager` knows. Invisible to TS:
/// the `FunctionArg` impl skips it in the generated bindings.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct WindowLabel(pub String);

impl fmt::Display for WindowLabel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

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

#[cfg(test)]
#[path = "engine/save_concurrency.test.rs"]
mod save_concurrency_tests;
