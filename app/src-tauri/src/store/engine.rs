//! Location store: a committed Arrow batch plus an overlay of uncommitted edits.
//! Commits merge the overlay into the batch. Rows stay sorted by id for fast lookup;
//! render frames and selection membership are updated from the same row changes.

use crate::procedure::registry::Providers;
use crate::runs;
use crate::store::maps::MapMeta;
use crate::types::{AppError, AppResult, Location};
use mma_algebra::{Change, Counts, Delta, Id, Ids, PatchOp};
use std::collections::{hash_map, BTreeSet, HashMap, HashSet};
use std::ops::Deref;
use std::sync::{Arc, Mutex};
use std::{fmt, mem};
use tokio::{sync, task};

mod dependents;
pub use frame::*;
pub(crate) use history::*;
pub(crate) use intent::*;
pub use membership::*;
pub use mutations::*;
pub use persist::*;
pub use query::*;
pub use render::*;
pub(crate) use targeted::*;
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
    pub(crate) fn counts(&self) -> Counts {
        Counts {
            added: self.added.len() as u32,
            removed: self.removed.len() as u32,
            updated: self.updated.len() as u32,
        }
    }

    /// Apply a change relative to the base, retaining only its net difference.
    fn apply(&mut self, change: &Change<Location>, base: Option<&RecordBatch>) {
        let base = base.map(Columns::of);
        if !change.removed.is_empty() {
            let mut removed: HashSet<_> = change.removed.iter().map(|row| row.id).collect();
            self.added.retain(|row| !removed.remove(&row.id));
            for id in removed {
                self.updated.remove(&id);
                if base.as_ref().is_some_and(|base| base.row_of(id).is_some()) {
                    self.removed.insert(id);
                }
            }
        }

        let mut added = Vec::new();
        for transition in change.transitions() {
            let Some(row) = transition.after else {
                continue;
            };
            self.removed.remove(row.id);
            if transition.before.is_some() {
                if let Ok(i) = self.added.binary_search_by_key(&row.id, |row| row.id) {
                    self.added[i] = row.clone();
                    continue;
                }
            }
            if let Some((base, i)) = base
                .as_ref()
                .and_then(|base| Some((base, base.row_of(row.id)?)))
            {
                if base.location(i) == *row {
                    self.updated.remove(&row.id);
                } else {
                    self.updated.insert(row.id, row.clone());
                }
            } else {
                added.push(row.clone());
            }
        }
        if added.is_empty() {
            return;
        }
        added.sort_unstable_by_key(|row| row.id);
        let above = self.added.last().is_none_or(|last| last.id < added[0].id);
        self.added.extend(added);
        if !above {
            self.added.sort_by_key(|row| row.id);
        }
        if cfg!(debug_assertions) {
            if let Some(rows) = self.added.windows(2).find(|rows| rows[0].id == rows[1].id) {
                panic!("duplicate id {}", rows[0].id);
            }
        }
    }

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
}

/// Central state for one open map: the immutable Arrow base batch, the overlay of uncommitted
/// changes on it, render cells and the windows watching them, undo stacks, and value records.
/// [`Store::bake`] merges the overlay into the batch. Rows are sorted by id in both
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

    overlay: Tracked<Overlay>,
    /// Net row changes since the last commit.
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
    /// Lazy spatial index over alive locations, maintained incrementally by [`Store::put`].
    /// Validity is a length match against `alive_count`, so any bulk path that bypasses
    /// `put` degrades to a rebuild, never wrong results.
    pub(crate) spatial: Ensured<SpatialIndex>,
    /// The windows drawing this store. A store opened afresh has none: each window
    /// subscribes when it loads its scene.
    pub(crate) frames: Sinks<FrameBytes>,
    /// Subscribers to every finished change and derived state update, in version order.
    pub(crate) changes: Sinks<ChangeEvent>,
    /// Pending layers that procedure work is currently writing to.
    pub(crate) writing_layers: Tracked<BTreeSet<String>>,
    /// Whether disk lacks some of this state, as last derived.
    pub(crate) has_unsaved: Tracked<bool>,
    /// The values every window holds, by field: what a patch may add to or remove from.
    held_values: HashMap<String, HashSet<String>>,
    /// Field dependencies declared by providers.
    pub(crate) dependents: Arc<mma_algebra::Dependents<String>>,
    /// Named layers of pending edits held over the map's rows.
    pub(crate) pending: HashMap<String, Pending>,
    /// Where writes to the map's shared content go when another app hosts the map.
    pub(crate) upstream: Option<Arc<dyn Upstream>>,
}

/// What a finished change touched.
#[derive(Clone)]
pub(crate) enum Finished {
    /// An entry's rows, value records, field definitions, or selections.
    Entry(Arc<Entry>),
    /// The base rows were rewritten, so every row restates its selection.
    Base,
}

impl Default for Store {
    fn default() -> Self {
        Self::new()
    }
}

impl Store {
    /// The uncommitted rows over the base. Only the engine's write path changes it.
    pub(crate) fn overlay(&self) -> &Overlay {
        &self.overlay
    }

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
            held_values: HashMap::new(),
            dependents: Default::default(),
            pending: HashMap::new(),
            upstream: None,
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
            pending: *self.pending_counts,
            ..(*self.meta).clone()
        }
    }

    /// The derived state whose sources moved since they last shipped, as patch operations.
    /// Changes that are not held in a tracked slice, such as field values, join it per change.
    fn shipped(&mut self) -> Vec<PatchOp> {
        if self.overlay.ship() {
            let counts = self.overlay.counts();
            if counts != *self.pending_counts {
                self.pending_counts.replace(counts);
            }
        }
        let unsaved = self.is_unsaved();
        if unsaved != *self.has_unsaved {
            self.has_unsaved.replace(unsaved);
        }
        let mut patch = Vec::new();
        if self.alive_count.ship() {
            patch.push(PatchOp::replace(["locationCount"], *self.alive_count));
        }
        if self.pending_counts.ship() {
            patch.push(PatchOp::replace(["pending"], *self.pending_counts));
        }
        if self.meta.ship() {
            patch.push(PatchOp::replace(
                ["map"],
                maps::MapDetails((*self.meta).clone()),
            ));
        }
        if self.steps.ship() {
            patch.push(PatchOp::replace(["history"], self.history()));
        }
        if self.field_defs.ship() {
            patch.push(PatchOp::replace(["fieldDefs"], &*self.field_defs));
        }
        if self.writing_layers.ship() {
            patch.push(PatchOp::replace(["writingLayers"], &*self.writing_layers));
        }
        if self.has_unsaved.ship() {
            patch.push(PatchOp::replace(["unsaved"], *self.has_unsaved));
        }
        patch
    }

    /// The whole derived state, for a window that starts from nothing. Every window holds
    /// what this returns from here on, so it marks everything shipped.
    pub(crate) fn open_status(&mut self) -> StoreStatus {
        self.writing_layers
            .replace(runs::pending_writers(&self.meta.id));
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
        let field_values: HashMap<String, HashMap<String, HeldValue>> = self
            .fields(fields.iter().map(String::as_str))
            .into_iter()
            .map(|values| {
                let held = values
                    .project(values.keys())
                    .into_iter()
                    .filter_map(|(key, value)| Some((key, value?)))
                    .collect();
                (values.field().to_string(), held)
            })
            .collect();
        self.held_values = field_values
            .iter()
            .map(|(field, values)| (field.clone(), values.keys().cloned().collect()))
            .collect();
        let (selection_rows, selection_order) = self.selections.ship_list();
        StoreStatus {
            version: self.version,
            derived: Derived {
                location_count: *self.alive_count,
                pending: *self.pending_counts,
                map: maps::MapDetails((*self.meta).clone()),
                history: self.history(),
                field_values,
                field_defs: (*self.field_defs).clone(),
                selection_counts: self.selections.node_counts.clone(),
                selection_rows,
                selection_order,
                writing_layers: (*self.writing_layers).clone(),
                unsaved: *self.has_unsaved,
            },
        }
    }

    /// Update derived state for what changed, broadcast frames and changes, and return its result.
    pub(crate) fn finish(
        &mut self,
        finished: Finished,
        projections: &HashMap<String, selections::Projection>,
    ) -> Mutation {
        let empty = Entry::default();
        let list_only = matches!(&finished, Finished::Entry(entry)
            if entry.locations.is_empty() && !entry.selections.is_empty());
        let (entry, resolve_all) = match &finished {
            Finished::Entry(entry) => (&**entry, !entry.selections.is_empty()),
            Finished::Base => (&empty, true),
        };
        let t0 = Instant::now();
        let (changes, records) = (&entry.locations, &entry.records);
        let before = self.version;
        self.bump();
        self.update_bounds(changes, before);

        let mut moved = self.reindex(projections);
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
        let t_index = t0.elapsed();
        let has_selections = (!changes.is_empty() || resolve_all) && !self.selections.is_empty();
        let full_resolve =
            has_selections && (resolve_all || changes.len() > 100 || self.selections.set_dependent);

        let membership_delta = if has_selections || resolve_all {
            if list_only && !self.selections.set_dependent {
                self.resolve_unresolved_selections();
                None
            } else if full_resolve || resolve_all {
                self.resolve_selection_membership();
                None
            } else {
                Some(self.selections.update(changes))
            }
        } else {
            None
        };

        let t_members = t0.elapsed();
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
            polygons: if resolve_all {
                self.selections.mesh_change()
            } else {
                PolygonFrame::default()
            },
        };
        if !self.frames.is_empty() {
            self.frames.send(FrameBytes(frame.encode()));
        }
        let t_frame = t0.elapsed();

        let mut patch = self.shipped();
        for (field, values) in field_values {
            match self.held_values.entry(field) {
                hash_map::Entry::Vacant(slot) => {
                    let held: HashMap<String, HeldValue> = values
                        .into_iter()
                        .filter_map(|(key, value)| Some((key, value?)))
                        .collect();
                    patch.push(PatchOp::add(["fieldValues", slot.key().as_str()], &held));
                    slot.insert(held.into_keys().collect());
                }
                hash_map::Entry::Occupied(slot) => {
                    let field = slot.key().clone();
                    let held = slot.into_mut();
                    for (key, value) in values {
                        let path = ["fieldValues", field.as_str(), key.as_str()];
                        match value {
                            Some(value) => {
                                patch.push(PatchOp::add(path, value));
                                held.insert(key);
                            }
                            None => {
                                if held.remove(&key) {
                                    patch.push(PatchOp::remove(path));
                                }
                            }
                        }
                    }
                }
            }
        }
        if has_selections || resolve_all {
            patch.push(PatchOp::replace(
                ["selectionCounts"],
                &self.selections.node_counts,
            ));
        }
        if resolve_all || records.values().any(|delta| !delta.is_empty()) {
            patch.extend(self.selections.list_patch());
        }
        if t0.elapsed().as_millis() > 20 {
            log::debug!(
                "[finish] v{} total={}ms index={}ms members={}ms frame={}ms ship={}ms rows={} full_resolve={}",
                self.version,
                t0.elapsed().as_millis(),
                t_index.as_millis(),
                (t_members - t_index).as_millis(),
                (t_frame - t_members).as_millis(),
                (t0.elapsed() - t_frame).as_millis(),
                changes.len(),
                full_resolve || resolve_all,
            );
        }
        let result = Mutation {
            version: self.version,
            keys: Vec::new(),
            history_cleared: false,
        };
        // Announce every version, including no-ops, so callers can await their mutation.
        self.changes.send(ChangeEvent {
            version: self.version,
            keys: changes.keys(),
            patch,
            finished: Some(finished),
        });
        result
    }

    /// Look up a location by ID across updated rows, added rows (binary search), and batch.
    pub(crate) fn get_loc_by_id(&self, id: Id<Location>) -> Option<Location> {
        self.view().get(id).map(|row| row.to_location())
    }

    /// Make `batch` the base and clear the overlay it already holds.
    fn adopt_base(&mut self, batch: RecordBatch) {
        self.batch = Some(batch);
        self.field_indexes.clear();
        *self.overlay.edit() = Overlay::default();
        self.overlay.mark_saved();
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
                batch =
                    take::take_record_batch(&batch, &arrow_array::UInt32Array::from(keep)).unwrap();
            }
        }

        // Step 2: apply patches column-wise (preserves row order for sorted ID invariant)
        if !self.overlay.updated.is_empty() {
            batch = arrow::patch_batch(&batch, &self.overlay.updated);
        }

        // Step 3: concat adds, sorted into id order when lent ids fall below the base's
        if !self.overlay.added.is_empty() {
            let base_rows = batch.num_rows();
            let interleaved = base_rows > 0
                && Columns::id(&batch).value(base_rows - 1) > self.overlay.added[0].id.get();
            let add_batch = arrow::locations_to_batch(&self.overlay.added);
            batch = concat::concat_batches(&schema(), &[batch, add_batch]).expect("concat failed");
            if interleaved {
                let ids = Columns::id(&batch);
                let mut order: Vec<u32> = (0..batch.num_rows() as u32).collect();
                order.sort_by_key(|&row| ids.value(row as usize));
                batch = take::take_record_batch(&batch, &arrow_array::UInt32Array::from(order))
                    .unwrap();
            }
        }

        log::debug!(
            "[baked_batch] total={}ms rows={}",
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
    /// What keeps each map's store here: a store leaves once nothing holds its map.
    pub(crate) holders: HashMap<Holder, Id<MapMeta, String>>,
    /// Registered providers, whose field dependencies every opened store shares.
    pub(crate) providers: Providers,
    /// Each map's files lock, held across every read-to-write of its files on disk.
    files: HashMap<Id<MapMeta, String>, Arc<sync::Mutex<()>>>,
}

/// What keeps a map's store open.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Holder {
    /// A window showing the map.
    Window(WindowLabel),
    /// A session working on the map, with or without a window open on it.
    Session(Id<MapMeta, String>),
}

impl StoreManager {
    pub fn new() -> Self {
        Self {
            stores: HashMap::new(),
            holders: HashMap::new(),
            providers: Default::default(),
            files: HashMap::new(),
        }
    }

    /// Let go of what `holder` keeps here, handing back its map's store when nothing else
    /// holds the map.
    pub(crate) fn release(&mut self, holder: &Holder) -> Option<(Id<MapMeta, String>, Store)> {
        let map_id = self.holders.remove(holder)?;
        if let Some(store) = self.stores.get_mut(&map_id) {
            store.frames.remove(holder);
            store.changes.remove(holder);
        }
        if self.holders.values().any(|held| *held == map_id) {
            return None;
        }
        self.stores.remove_entry(&map_id)
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

    /// A map's row as it stands, as its store holds it when the map is open.
    pub(crate) fn current(&self, row: MapMeta) -> MapMeta {
        self.stores.get(&row.id).map_or(row, Store::map)
    }

    pub fn store_for_window(&mut self, label: &WindowLabel) -> AppResult<&mut Store> {
        let map_id = self.map_id_for_window(label)?;
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
        self.holders
            .get(&Holder::Window(label.clone()))
            .cloned()
            .ok_or_else(|| AppError(format!("no map open in window '{label}'")))
    }
}

pub type StoreState = Mutex<StoreManager>;

/// The store's writes, made one at a time in the order they were asked for, off the thread
/// that asked.
pub struct Writes(crate::util::Serial<tauri::AppHandle>);

impl Writes {
    /// The writes of the app `app` serves.
    pub fn new(app: tauri::AppHandle) -> Self {
        Self(crate::util::Serial::new("store-writes", app))
    }

    /// What `job` comes to on the store state, once every write asked for before it is made.
    /// Waiting for a replica's host happens outside the line, so it holds up no later write.
    pub(crate) fn write<T: Send + 'static>(
        &self,
        job: impl FnOnce(&StoreState) -> AppResult<Reached<T>> + Send + 'static,
    ) -> impl std::future::Future<Output = AppResult<T>> {
        use tauri::Manager;
        let made = self.0.then(move |app| job(&app.state::<StoreState>()));
        async move { made.await??.await }
    }
}

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

/// Run `f` as [`with_target`] does, then await the change it made as this store reaches it,
/// with the manager unlocked.
pub(crate) async fn reach_target<R>(
    state: &StoreState,
    label: &WindowLabel,
    target: &Target,
    f: impl FnOnce(&mut Store) -> AppResult<Reached<R>>,
) -> AppResult<R> {
    task::block_in_place(|| with_target(state, label, target, f))?.await
}

impl From<WindowLabel> for Holder {
    fn from(label: WindowLabel) -> Self {
        Holder::Window(label)
    }
}

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
mod intent;
mod membership;
mod mutations;
mod persist;
pub(crate) mod query;
mod render;
mod targeted;
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
