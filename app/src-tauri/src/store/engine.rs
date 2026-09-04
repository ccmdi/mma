//! Core data engine: immutable Arrow RecordBatch base + in-memory overlay for mutations.
//!
//! All location data lives here. The overlay (adds, patches, dead set) accumulates mutations
//! between saves; `bake_overlay` merges them back into the batch. IDs are kept strictly sorted
//! in the batch to enable O(log n) lookups via `batch_row_for_id`. Render cells (32 geohash-1
//! buckets) and selection bitmasks are derived from the same `ChangeSet` via `finish_mutation`.

use crate::types::{AppError, AppResult};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

pub use history::*;
pub use membership::*;
pub use mutations::*;
pub use persist::*;
pub use query::*;
pub use render::*;
pub use tags::*;

use roaring::RoaringBitmap;

use arrow_array::RecordBatch;
use rayon::prelude::*;

use crate::selections;
use crate::store::arrow;
use crate::store::arrow::{batch_row_for_id, col_id, schema};
use crate::store::maps;
use crate::store::spatial;
use crate::types::RawExtra;
use crate::types::{Location, LocationFlags};
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
/// O(log n) lookups via binary search. Render cells, selection bitmasks, undo/redo stacks,
/// and tag metadata all live here.
///
/// This is also the on-disk `.delta` sidecar format: serializing it is the autosave, and
/// deserializing it is the reload. `dead_ids`/`patches` are the wire names and shapes
/// (a seq either way), so the msgpack stays byte-compatible with existing delta files.
#[derive(Default, serde::Serialize, serde::Deserialize)]
pub(crate) struct Overlay {
    pub adds: Vec<Location>,
    #[serde(rename = "dead_ids")]
    pub dead: HashSet<u32>,
    #[serde(with = "patches_as_seq")]
    pub patches: HashMap<u32, Location>,
}

impl Overlay {
    /// No uncommitted content. An autosaved overlay is clean but stays non-empty until baked.
    pub(crate) fn is_empty(&self) -> bool {
        self.adds.is_empty() && self.dead.is_empty() && self.patches.is_empty()
    }

    /// Apply these changes onto a plain location list read off disk.
    fn apply_to(self, locs: &mut Vec<Location>) {
        locs.retain(|l| !self.dead.contains(&l.id));
        for l in locs.iter_mut() {
            if let Some(p) = self.patches.get(&l.id) {
                *l = p.clone();
            }
        }
        locs.extend(self.adds);
    }
}

pub struct Store {
    pub(crate) map_id: Option<String>,
    // batch is declared before mmap_handle so it drops first (columns reference the mmap).
    pub(crate) batch: Option<RecordBatch>,
    pub(crate) mmap_handle: Option<arrow::MmapHandle>,
    pub(crate) next_id: u32,
    pub(crate) version: u64,
    pub(crate) alive_count: usize,
    /// What JS was last told, so a mutation result carries only the fields that moved.
    pub(crate) reported: Reported,
    /// The map's extra-field registry, mirroring `maps.extra.fields` on disk.
    pub(crate) field_defs: Tracked<HashMap<String, maps::ExtraFieldDef>>,

    pub(crate) overlay: Tracked<Overlay>,
    pub(crate) render: RenderState,
    pub(crate) selections: SelectionState,
    pub(crate) tags: TagState,
    pub(crate) edits: EditStacks,
    /// Whole-map bounds as of a store version. `update_bounds` carries it across a
    /// mutation when the change can only grow the box; otherwise it is left behind and
    /// the next read rescans. `None` until first read. Resolved to `[w,s,e,n]` on read.
    pub(crate) bounds: Option<At<Option<BoundsAcc>>>,
    /// Lazy spatial index over alive locations. Built on the first radius query,
    /// then maintained incrementally by the overlay mutation functions. A length
    /// mismatch against `alive_count` at query time forces a rebuild, so any bulk
    /// path that bypasses the overlay fns degrades to a rebuild, never wrong results.
    spatial: Option<spatial::SpatialIndex>,
}

macro_rules! apply_patch {
    ($target:expr, $patch:expr; $($field:ident),+ $(,)?) => {
        $(if let Some(v) = $patch.$field { $target.$field = v; })+
    };
    (clone $target:expr, $patch:expr; $($field:ident),+ $(,)?) => {
        $(if let Some(ref v) = $patch.$field { $target.$field = v.clone(); })+
    };
}

impl Default for Store {
    fn default() -> Self {
        Self::new()
    }
}

impl Store {
    pub fn new() -> Self {
        Self {
            map_id: None,
            batch: None,
            mmap_handle: None,
            next_id: 1,
            version: 0,
            alive_count: 0,
            reported: Reported::default(),
            field_defs: Tracked::default(),
            overlay: Tracked::default(),
            render: RenderState {
                cells: [const { None }; 32],
                id_to_cell_idx: Vec::new(),
                arrow_style: false,
                marker_color: [42, 42, 42],
            },
            selections: SelectionState {
                resolved: Vec::new(),
                node_counts: HashMap::new(),
                version: 0,
                ids: RoaringBitmap::new(),
                active_id: None,
            },
            tags: TagState {
                all: Tracked::default(),
                counts: Touched::default(),
                next_id: 1,
                sets: HashMap::new(),
            },
            edits: EditStacks {
                undo: Vec::new(),
                redo: Vec::new(),
            },
            bounds: None,
            spatial: None,
        }
    }

    /// Increment the store version counter. JS uses this to detect stale responses.
    pub(crate) fn bump(&mut self) -> u64 {
        self.version += 1;
        self.version
    }

    /// Snapshot current store metadata for the frontend: version, counts, undo/redo availability.
    /// The full picture, for a window that has nothing yet. Every later mutation result
    /// is a delta against this, so it also resets what counts as "already reported".
    pub(crate) fn open_status(&mut self) -> StoreStatus {
        let now = self.current();
        self.reported = now;
        StoreStatus {
            version: self.version,
            location_count: now.location_count,
            can_undo: now.can_undo,
            can_redo: now.can_redo,
            tag_counts: self.tag_counts(),
        }
    }

    fn tag_counts(&self) -> HashMap<u32, usize> {
        self.tags
            .all
            .keys()
            .map(|&id| (id, self.tag_count(id)))
            .collect()
    }

    fn current(&self) -> Reported {
        Reported {
            location_count: self.alive_count,
            can_undo: !self.edits.undo.is_empty(),
            can_redo: !self.edits.redo.is_empty(),
        }
    }

    /// Put on `result` every scalar JS has not seen at its current value, and remember
    /// that it has now. Idempotent: a second call in the same mutation adds only what
    /// moved in between (an undo entry pushed after `finish_mutation`, say).
    pub(crate) fn report(&mut self, result: &mut MutationResult) {
        let now = self.current();
        let was = mem::replace(&mut self.reported, now);
        if now.location_count != was.location_count {
            result.location_count = Some(now.location_count);
        }
        if now.can_undo != was.can_undo {
            result.can_undo = Some(now.can_undo);
        }
        if now.can_redo != was.can_redo {
            result.can_redo = Some(now.can_redo);
        }
    }

    /// Bump version, derive the render delta + selection sync from the semantic
    /// changeset, and return the full mutation result. The changeset is the single
    /// source of truth; the render delta and selection sync are two projections of it.
    pub(crate) fn finish_mutation(&mut self, changes: &ChangeSet) -> MutationResult {
        let before = self.version;
        self.bump();
        self.update_bounds(changes, before);

        // A metadata-only mutation (tag rename, reorder, a create with nothing to assign)
        // moves no rows, so there is no membership to re-test and no delta to derive.
        let has_selections = !changes.is_empty() && !self.selections.resolved.is_empty();
        let full_resolve = has_selections
            && (changes.full_reset
                || changes.added.len() + changes.removed.len() + changes.updated.len() > 100
                || self.selections_need_full_resolve());

        // Step 1: Update selection membership and get back what changed.
        let membership_delta = if has_selections {
            if full_resolve {
                self.resolve_selection_membership();
                None
            } else {
                Some(self.update_selection_membership(changes))
            }
        } else {
            None
        };

        // Step 2: Derive the render delta (mutates render_cells). Every entry it emits
        // states the row's selection state, so membership changes need no second channel:
        // a row that only gained or lost a selection comes out as a coordinate-free patch.
        let changed = membership_delta.map(|md| md.changed).unwrap_or_default();
        let delta = self.derive_render_delta(changes, &changed);

        // Step 3: Only a full resolve ships a bitmask. The incremental path is carried
        // entirely by the delta above, which costs O(changed) instead of the
        // O(rows in the affected cells) that a per-cell bitmask rebuild costs.
        let selection_sync = if has_selections {
            if full_resolve {
                Some(self.build_selection_bitmask())
            } else {
                Some(SelectionSync {
                    counts: self.selections.node_counts.clone(),
                    bitmask: None,
                    selected_count: self.selections.ids.len() as usize,
                })
            }
        } else {
            None
        };

        // A tag is visible exactly while something carries it.
        let touched = self.tags.counts.drain_touched();
        for &tag_id in &touched {
            let should = self.tag_count(tag_id) > 0;
            if self
                .tags
                .all
                .get(&tag_id)
                .is_some_and(|t| t.visible != should)
            {
                self.tags.all.edit().get_mut(&tag_id).unwrap().visible = should;
            }
        }
        let tag_counts = (!touched.is_empty()).then(|| self.tag_counts());
        let tags = self.tags.all.take_changed();
        let field_defs = self.field_defs.take_changed();

        let mut result = MutationResult {
            version: self.version,
            delta,
            selection_sync,
            location_count: None,
            can_undo: None,
            can_redo: None,
            tag_counts,
            tags,
            field_defs,
        };
        self.report(&mut result);
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
        if self.overlay.dead.contains(&id) {
            return None;
        }
        if let Some(patched) = self.overlay.patches.get(&id) {
            return Some(patched.clone());
        }
        if let Ok(i) = self.overlay.adds.binary_search_by_key(&id, |l| l.id) {
            return Some(self.overlay.adds[i].clone());
        }
        if let Some(ref b) = self.batch {
            if let Some(idx) = batch_row_for_id(b, id) {
                return Some(arrow::row_to_location(b, idx));
            }
        }
        None
    }

    /// Read a single location from the committed base batch by id (ignores the
    /// overlay). O(log n). Used to recover the pre-edit version of a row.
    fn base_loc_by_id(&self, id: u32) -> Option<Location> {
        let b = self.batch.as_ref()?;
        let idx = batch_row_for_id(b, id)?;
        Some(arrow::row_to_location(b, idx))
    }

    /// Build a commit delta directly from the overlay - the in-memory changeset
    /// since the last commit. O(changeset), no history replay. Old versions of
    /// modified/removed rows come from the committed base batch, so this is only
    /// valid while the base still holds the parent state (i.e. before `bake_overlay`).
    /// Returns `(created, removed, added, removed, modified)`.
    pub(crate) fn build_overlay_delta(&self) -> (Vec<Location>, Vec<Location>, u32, u32, u32) {
        let mut created: Vec<Location> = self.overlay.adds.clone();
        let mut removed: Vec<Location> = Vec::new();
        let added = self.overlay.adds.len() as u32;

        let mut modified = 0u32;
        for (id, new) in &self.overlay.patches {
            match self.base_loc_by_id(*id) {
                Some(old) => {
                    removed.push(old);
                    created.push(new.clone());
                    modified += 1;
                }
                None => created.push(new.clone()), // not in base: a net add
            }
        }

        let mut removed_n = 0u32;
        for id in &self.overlay.dead {
            // A dead id absent from the base was added-then-removed this session: a no-op.
            if let Some(old) = self.base_loc_by_id(*id) {
                removed.push(old);
                removed_n += 1;
            }
        }

        (created, removed, added, removed_n, modified)
    }

    /// Net `(added, removed, modified)` since last commit, counted from the overlay.
    /// Mirrors `build_overlay_delta`'s categorization without cloning any locations:
    /// adds are created, patches on base rows are modified (patches absent from the
    /// base are net adds), dead base rows are removed. Added-then-removed ids never
    /// touch the base and count as nothing. O(overlay * log n).
    pub(crate) fn overlay_diff_counts(&self) -> (u32, u32, u32) {
        let in_base = |id: u32| {
            self.batch
                .as_ref()
                .is_some_and(|b| batch_row_for_id(b, id).is_some())
        };
        let mut added = self.overlay.adds.len() as u32;
        let mut modified = 0u32;
        for &id in self.overlay.patches.keys() {
            if in_base(id) {
                modified += 1;
            } else {
                added += 1;
            }
        }
        let removed = self.overlay.dead.iter().filter(|&&id| in_base(id)).count() as u32;
        (added, removed, modified)
    }

    /// Insert or restore locations in the overlay. `adds` stays sorted by id (the invariant
    /// `bake_overlay` asserts): fresh ids sort above everything and are appended, O(k);
    /// anything else (an undo re-adding old ids) is merged in one linear pass, O(n + k),
    /// where inserting each row into its slot would shift the rows above it, O(n * k).
    pub(crate) fn overlay_add(&mut self, locs: Vec<Location>) {
        let mut fresh: Vec<Location> = Vec::with_capacity(locs.len());
        for loc in locs {
            self.alive_count += 1;
            if let Some(ix) = self.spatial.as_mut() {
                ix.insert(loc.id, loc.lat, loc.lng);
            }
            self.overlay.edit().dead.remove(&loc.id);
            let in_batch = self
                .batch
                .as_ref()
                .and_then(|b| batch_row_for_id(b, loc.id))
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
    pub(crate) fn overlay_remove(&mut self, locs: &[Location]) {
        let remove_set: HashSet<u32> = locs.iter().map(|l| l.id).collect();
        for loc in locs {
            self.alive_count -= 1;
            // Index under the CURRENT coords, not the caller's copy: a patched
            // location's overlay coords are where the index filed it.
            let (lat, lng) = self.coords_of(loc.id).unwrap_or((loc.lat, loc.lng));
            if let Some(ix) = self.spatial.as_mut() {
                ix.remove(loc.id, lat, lng);
            }
            self.overlay.edit().patches.remove(&loc.id);
        }
        self.overlay.edit().dead.extend(&remove_set);
        self.overlay
            .edit()
            .adds
            .retain(|l| !remove_set.contains(&l.id));
    }

    /// Apply a partial patch to an existing location. Reads the current state, merges
    /// non-None fields from the patch, and writes back to overlay_adds or overlay_patches.
    fn overlay_update(&mut self, id: u32, patch: &LocationPatch) -> Option<(Location, Location)> {
        let old = self.get_loc_by_id(id)?;
        let mut loc = old.clone();
        apply_patch!(loc, patch; lat, lng, heading, pitch, zoom, created_at, modified_at);
        apply_patch!(clone loc, patch; pano_id, tags);
        if let Some(v) = patch.flags {
            loc.flags = LocationFlags::from_bits_retain(v);
        }
        if let Some(ref v) = patch.extra {
            // JSON Merge Patch (RFC 7386)
            loc.extra = match v {
                None => None,
                Some(p) => {
                    let mut m = loc.extra.as_ref().map(RawExtra::to_map).unwrap_or_default();
                    for (k, val) in p.to_map() {
                        if val.is_null() {
                            m.remove(&k);
                        } else {
                            m.insert(k, val);
                        }
                    }
                    RawExtra::from_map(&m)
                }
            };
        }
        let loc = self.overlay_write(id, loc, &old);
        Some((old, loc))
    }

    /// Write an already-computed Location into the overlay (adds/patches). `old` is the
    /// row's pre-mutation state, which every caller already holds -- for an unpatched row
    /// it IS the base row, so the no-op check needs no Arrow re-materialization. Returns
    /// the location as the store now holds it (stamped on a real change).
    fn overlay_write(&mut self, id: u32, mut loc: Location, old: &Location) -> Location {
        if (loc.lat, loc.lng) != (old.lat, old.lng) {
            if let Some(ix) = self.spatial.as_mut() {
                ix.remove(id, old.lat, old.lng);
                ix.insert(id, loc.lat, loc.lng);
            }
        }
        // Stamp only on a real change in every branch
        if let Ok(pos) = self.overlay.adds.binary_search_by_key(&id, |l| l.id) {
            if self.overlay.adds[pos] != loc {
                touch(&mut loc);
                self.overlay.edit().adds[pos] = loc.clone();
            }
        } else if self.overlay.patches.contains_key(&id) {
            // A patched row: `old` is the patched state, so reverting to the base row
            // exactly is the one case that still has to materialize it.
            if self.base_loc_by_id(id).as_ref() == Some(&loc) {
                self.overlay.edit().patches.remove(&id);
            } else if self.overlay.patches.get(&id) != Some(&loc) {
                touch(&mut loc);
                self.overlay.edit().patches.insert(id, loc.clone());
            }
        } else if loc != *old {
            touch(&mut loc);
            self.overlay.edit().patches.insert(id, loc.clone());
        }
        loc
    }

    /// Reset overlay state. Called after bake or on map close.
    fn clear_overlay(&mut self) {
        let overlay = self.overlay.edit();
        overlay.adds.clear();
        overlay.dead.clear();
        overlay.patches.clear();
        self.overlay.mark_saved();
    }

    /// Merge overlay (adds, patches, dead) into the Arrow batch. O(N) where N = batch rows.
    /// Expensive at 10M+ rows - prefer delta saves; full bake only on commit.
    /// Gated on emptiness: an autosave folds nothing in, so a saved overlay must still bake.
    pub(crate) fn bake_overlay(&mut self) {
        if self.overlay.is_empty() {
            return;
        }
        let _t = Instant::now();

        let Some(mut batch) = self.batch.take() else {
            let b = arrow::locations_to_batch(&self.overlay.adds);
            self.clear_overlay();
            self.batch = Some(b);
            return;
        };

        // Step 1: filter out dead rows
        if !self.overlay.dead.is_empty() {
            let ids = col_id(&batch);
            let keep: Vec<u32> = (0..batch.num_rows())
                .filter(|&i| !self.overlay.dead.contains(&ids.value(i)))
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
                let ids = col_id(&batch);
                (1..batch.num_rows()).all(|i| ids.value(i - 1) < ids.value(i))
            },
            "batch IDs must be strictly sorted after bake"
        );
        self.batch = Some(batch);
        self.clear_overlay();
    }
}

/// Manages multiple open `Store` instances, keyed by map ID, with a
/// window-label-to-map-ID registry so each Tauri webview operates on
/// its own map without clobbering others.
pub struct StoreManager {
    pub(crate) stores: HashMap<String, Store>,
    pub(crate) window_map: HashMap<String, String>,
}

impl StoreManager {
    pub fn new() -> Self {
        Self {
            stores: HashMap::new(),
            window_map: HashMap::new(),
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Metadata snapshot returned to JS after every mutation. JS uses `version` to
/// detect stale responses and `canUndo`/`canRedo` for toolbar button state.
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StoreStatus {
    pub version: u64,
    pub location_count: usize,
    pub can_undo: bool,
    pub can_redo: bool,
    pub tag_counts: HashMap<u32, usize>,
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

    pub(crate) fn into_value(self) -> T {
        self.value
    }
}

/// State with two consumers, JS and disk, each holding it as of some revision. Every edit
/// bumps `rev`; reads deref; the only `&mut` is [`Tracked::edit`], so an edit that forgot
/// to mark itself cannot be written. `finish_mutation` ships what JS has not seen; a save
/// records the rev it wrote, so an edit racing an async write stays unsaved.
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

    /// An edit with nothing to write: the value is unchanged but must ship and save again.
    pub(crate) fn touch(&mut self) {
        self.rev += 1;
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

    /// The value if edited since JS last saw it.
    pub(crate) fn take_changed(&mut self) -> Option<T>
    where
        T: Clone,
    {
        (!self.shipped.covers(self.rev)).then(|| {
            self.shipped = At::new(self.rev, ());
            self.value.clone()
        })
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

impl<T> std::ops::Deref for Tracked<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.value
    }
}

/// A map that remembers which keys were written since the last drain. The only `&mut`
/// into an entry is [`Touched::edit`], so a moved entry cannot fail to be announced.
#[derive(Debug, Default)]
pub(crate) struct Touched<K, V> {
    map: HashMap<K, V>,
    touched: HashSet<K>,
}

impl<K: Eq + std::hash::Hash + Copy, V: Default> Touched<K, V> {
    pub(crate) fn new(map: HashMap<K, V>) -> Self {
        Self {
            map,
            touched: HashSet::new(),
        }
    }

    pub(crate) fn edit(&mut self, key: K) -> &mut V {
        self.touched.insert(key);
        self.map.entry(key).or_default()
    }

    /// Announce a key without writing it (a tag that sits at zero still needs a look).
    pub(crate) fn touch(&mut self, key: K) {
        self.touched.insert(key);
    }

    pub(crate) fn drain_touched(&mut self) -> HashSet<K> {
        mem::take(&mut self.touched)
    }
}

impl<K, V> std::ops::Deref for Touched<K, V> {
    type Target = HashMap<K, V>;
    fn deref(&self) -> &HashMap<K, V> {
        &self.map
    }
}

/// The scalars a mutation result reports by change, not by value.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Reported {
    pub location_count: usize,
    pub can_undo: bool,
    pub can_redo: bool,
}

/// Lightweight status for polling: count, version, and whether unsaved changes exist.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SummaryResult {
    pub location_count: usize,
    pub version: u64,
    pub dirty_count: usize,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// One read through a selector: resolve once, then project.
macro_rules! selector_read {
    ($label:ident, $state:ident, $selector:ident, |$view:ident, $set:ident| $body:expr) => {
        with_store!($label, $state, |store| {
            let $view = store.loc_view();
            let resolved = selections::narrow(&$view, &$selector);
            let $set = resolved.as_ref();
            Ok($body)
        })
    };
    // The view borrows the store, so a projection needing `&mut store` gets the set only
    // after the view is dropped.
    ($label:ident, $state:ident, $selector:ident, store: |$store:ident, $set:ident| $body:expr) => {
        with_store!($label, $state, |$store| {
            let resolved = {
                let view = $store.loc_view();
                selections::narrow(&view, &$selector)
            };
            let $set = resolved.as_ref();
            Ok($body)
        })
    };
}
pub(crate) use selector_read;

/// Patches ride the wire as a plain list of locations, keyed back by id on the way in.
mod patches_as_seq {
    use super::{HashMap, Location};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(m: &HashMap<u32, Location>, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(m.values())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<HashMap<u32, Location>, D::Error> {
        Ok(Vec::<Location>::deserialize(d)?
            .into_iter()
            .map(|l| (l.id, l))
            .collect())
    }
}

mod history;
mod membership;
mod mutations;
mod persist;
mod query;
mod render;
mod tags;

#[cfg(test)]
#[path = "engine.test.rs"]
mod tests;

#[cfg(feature = "bench")]
#[path = "engine.bench.rs"]
pub mod bench;

/// The engine's own write on every real change to a row.
fn touch(loc: &mut Location) {
    loc.modified_at = Some(util::now_unix());
}

/// The nullable built-in columns a bulk clear can empty: the optional ones that stay empty
/// through `touch`. Probed, not declared, so a column the engine starts writing is refused
/// the same day.
pub fn clearable_builtins() -> &'static [&'static str] {
    static KEYS: OnceLock<Vec<&'static str>> = OnceLock::new();
    KEYS.get_or_init(|| {
        let mut probe = Location::default();
        touch(&mut probe);
        selections::optional_builtins()
            .iter()
            .copied()
            .filter(|key| selections::resolve_field_loc(&probe, key).is_none())
            .collect()
    })
}
