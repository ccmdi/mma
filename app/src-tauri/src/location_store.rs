//! Core data engine: immutable Arrow RecordBatch base + in-memory overlay for mutations.
//!
//! All location data lives here. The overlay (adds, patches, dead set) accumulates mutations
//! between saves; `bake_overlay` merges them back into the batch. IDs are kept strictly sorted
//! in the batch to enable O(log n) lookups via `batch_row_for_id`. Render cells (32 geohash-1
//! buckets) and selection bitmasks are derived from the same `ChangeSet` via `finish_mutation`.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use roaring::RoaringBitmap;

use arrow::array::{
    Array, ArrayRef, Float64Array, ListArray, RecordBatch,
    StringArray, UInt32Array,
};
use arrow::compute::concat_batches;
use arrow::datatypes::SchemaRef;
use rayon::prelude::*;
use tauri::Manager;

use crate::arrow_bridge;
use crate::fast_io;
use crate::map_meta;
use crate::types::{Location, Tag};
use crate::util;
use crate::selections::{self, SelectionProps, Selection};

/// Full geohash precision used for dirty-tracking and VCS snapshots.
const GEOHASH_PRECISION: usize = 2;
const MAX_UNDO_ENTRIES: usize = 1000;
/// Standard base-32 alphabet for geohash encoding (Gustavo Niemeyer variant).
const BASE32: &[u8] = b"0123456789bcdefghjkmnpqrstuvwxyz";

/// Encode (lat, lng) into a base-32 geohash string. O(GEOHASH_PRECISION) — constant.
pub(crate) fn encode_geohash(lat: f64, lng: f64) -> String {
    let (mut min_lat, mut max_lat) = (-90.0, 90.0);
    let (mut min_lng, mut max_lng) = (-180.0, 180.0);
    let mut hash = String::with_capacity(GEOHASH_PRECISION);
    let mut bits = 0u8;
    let mut ch = 0u8;
    let mut even = true;
    while hash.len() < GEOHASH_PRECISION {
        if even {
            let mid = (min_lng + max_lng) / 2.0;
            if lng >= mid { ch = (ch << 1) | 1; min_lng = mid; } else { ch <<= 1; max_lng = mid; }
        } else {
            let mid = (min_lat + max_lat) / 2.0;
            if lat >= mid { ch = (ch << 1) | 1; min_lat = mid; } else { ch <<= 1; max_lat = mid; }
        }
        even = !even;
        bits += 1;
        if bits == 5 { hash.push(BASE32[ch as usize] as char); bits = 0; ch = 0; }
    }
    hash
}

/// Compute the render cell index (0-31) directly from coordinates without allocating
/// a geohash string. Equivalent to `BASE32.position(encode_geohash(lat, lng)[0])`.
pub(crate) fn render_cell_idx(lat: f64, lng: f64) -> u8 {
    let (mut min_lat, mut max_lat) = (-90.0, 90.0);
    let (mut min_lng, mut max_lng) = (-180.0, 180.0);
    let mut ch: u8 = 0;
    let mut even = true;
    for _ in 0..5 {
        if even {
            let mid = (min_lng + max_lng) / 2.0;
            if lng >= mid { ch = (ch << 1) | 1; min_lng = mid; } else { ch <<= 1; max_lng = mid; }
        } else {
            let mid = (min_lat + max_lat) / 2.0;
            if lat >= mid { ch = (ch << 1) | 1; min_lat = mid; } else { ch <<= 1; max_lat = mid; }
        }
        even = !even;
    }
    ch
}

/// Convert a cell index (0-31) back to its single-character base-32 key.
fn cell_key_from_idx(idx: u8) -> String {
    String::from(BASE32[idx as usize] as char)
}

/// Reverse lookup: parse a single-character cell key to its 0-31 index.
fn cell_idx_from_key(key: &str) -> Option<u8> {
    let b = *key.as_bytes().first()?;
    BASE32.iter().position(|&c| c == b).map(|i| i as u8)
}

/// Serialize one render cell's per-selection bitmasks into a self-describing segment:
/// `[cellChar:1][locCount:u32 le][ per selection: ceil(n/8) mask bytes ]`.
/// Bits are indexed by render position within the cell. Pure/read-only, so the
/// 32 cells can be serialized in parallel.
fn serialize_cell_bitmask(ci: usize, cr: &CellRender, loc_sets: &[RoaringBitmap]) -> Vec<u8> {
    let n = cr.id_order.len();
    let mask_bytes = n.div_ceil(8);
    let mut seg = Vec::with_capacity(1 + 4 + mask_bytes * loc_sets.len());
    seg.push(BASE32[ci]);
    seg.extend_from_slice(&(n as u32).to_le_bytes());
    for set in loc_sets {
        let mut bitmask = vec![0u8; mask_bytes];
        for (li, &id) in cr.id_order.iter().enumerate() {
            if set.contains(id) {
                bitmask[li / 8] |= 1 << (li % 8);
            }
        }
        seg.extend_from_slice(&bitmask);
    }
    seg
}

// ---------------------------------------------------------------------------
// Column accessors — typed downcasts from a RecordBatch
// ---------------------------------------------------------------------------

fn col_id(b: &RecordBatch) -> &UInt32Array { b.column(0).as_any().downcast_ref().unwrap() }
fn col_lat(b: &RecordBatch) -> &Float64Array { b.column(1).as_any().downcast_ref().unwrap() }
fn col_lng(b: &RecordBatch) -> &Float64Array { b.column(2).as_any().downcast_ref().unwrap() }
fn col_heading(b: &RecordBatch) -> &Float64Array { b.column(3).as_any().downcast_ref().unwrap() }
fn col_flags(b: &RecordBatch) -> &UInt32Array { b.column(7).as_any().downcast_ref().unwrap() }
fn col_tags(b: &RecordBatch) -> &ListArray { b.column(8).as_any().downcast_ref().unwrap() }
fn col_extra(b: &RecordBatch) -> &StringArray { b.column(9).as_any().downcast_ref().unwrap() }

fn num_rows(store: &Store) -> usize { store.batch.as_ref().map_or(0, |b| b.num_rows()) }

/// Binary search for a location ID in a sorted batch. O(log n).
fn batch_row_for_id(batch: &RecordBatch, id: u32) -> Option<usize> {
    let ids = col_id(batch);
    let (mut lo, mut hi) = (0usize, batch.num_rows());
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        let mid_id = ids.value(mid);
        if mid_id < id { lo = mid + 1; }
        else if mid_id > id { hi = mid; }
        else { return Some(mid); }
    }
    None
}

fn schema() -> SchemaRef { Arc::new(arrow_bridge::location_schema()) }

fn empty_batch() -> RecordBatch {
    RecordBatch::new_empty(schema())
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/// Per-cell render index: maps location IDs to their position within a cell's typed arrays.
/// `id_order` is the authoritative ordering; `id_to_index` provides O(1) reverse lookup.
/// Swap-remove semantics keep removals O(1) at the cost of reordering the last element.
pub(crate) struct CellRender {
    pub id_order: Vec<u32>,
    pub id_to_index: HashMap<u32, usize>,
}

/// Central state for one open map. Holds the immutable Arrow base batch plus an in-memory
/// overlay that accumulates mutations (adds, patches, dead). `bake_overlay` merges the
/// overlay back into the batch. The sorted ID invariant on `batch` + `overlay_adds` enables
/// O(log n) lookups via binary search. Render cells, selection bitmasks, undo/redo stacks,
/// and tag metadata all live here.
pub(crate) struct Overlay {
    pub adds: Vec<Location>,
    pub dead: HashSet<u32>,
    pub patches: HashMap<u32, Location>,
    pub dirty_geohashes: HashSet<String>,
    pub dirty: bool,
}

pub(crate) struct RenderState {
    pub cells: [Option<CellRender>; 32],
    pub id_to_cell_idx: Vec<u8>,
    pub arrow_style: bool,
}

pub(crate) struct SelectionState {
    pub all: Vec<Selection>,
    /// Per-selection membership, keyed by location id.
    pub loc_sets: Vec<RoaringBitmap>,
    pub version: u64,
    /// Union of all `loc_sets`. Answers "is this id selected".
    pub ids: RoaringBitmap,
    pub active_id: Option<u32>,
}

impl SelectionState {
    /// Color of a selected id = color of the last selection containing it. None if unselected.
    fn color_for(&self, id: u32) -> Option<[u8; 3]> {
        if !self.ids.contains(id) { return None; }
        let mut color = None;
        for (si, set) in self.loc_sets.iter().enumerate() {
            if set.contains(id) { color = Some(self.all[si].color); }
        }
        color
    }
}

pub(crate) struct TagState {
    pub all: HashMap<u32, Tag>,
    pub dirty: bool,
    pub next_id: u32,
}

pub(crate) struct EditStacks {
    pub undo: Vec<EditEntry>,
    pub redo: Vec<EditEntry>,
}

pub struct Store {
    pub(crate) map_id: Option<String>,
    // batch is declared before mmap_handle so it drops first (columns reference the mmap).
    pub(crate) batch: Option<RecordBatch>,
    mmap_handle: Option<fast_io::MmapHandle>,
    pub(crate) geohash_index: HashMap<String, Vec<usize>>,
    next_id: u32,
    version: u64,
    pub(crate) alive_count: usize,
    committed_blobs: HashMap<String, (String, u32)>,
    pub(crate) known_field_keys: HashSet<String>,

    pub(crate) overlay: Overlay,
    pub(crate) render: RenderState,
    pub(crate) selections: SelectionState,
    pub(crate) tags: TagState,
    pub(crate) edits: EditStacks,
}

/// One undo/redo entry. Records the locations created and removed by a single user action.
/// Updates are encoded as simultaneous remove-old + create-new with the same ID.
/// Reversing an entry swaps `created` and `removed`.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct EditEntry {
    pub created: Vec<Location>,
    pub removed: Vec<Location>,
}

struct MembershipDelta {
    gained: Vec<(u32, [u8; 3])>,
    lost: Vec<u32>,
}

impl Store {
    pub fn new() -> Self {
        Self {
            map_id: None,
            batch: None,
            mmap_handle: None,
            geohash_index: HashMap::new(),
            next_id: 1,
            version: 0,
            alive_count: 0,
            committed_blobs: HashMap::new(),
            known_field_keys: HashSet::new(),
            overlay: Overlay {
                adds: Vec::new(),
                dead: HashSet::new(),
                patches: HashMap::new(),
                dirty_geohashes: HashSet::new(),
                dirty: false,
            },
            render: RenderState {
                cells: [const { None }; 32],
                id_to_cell_idx: Vec::new(),
                arrow_style: false,
            },
            selections: SelectionState {
                all: Vec::new(),
                loc_sets: Vec::new(),
                version: 0,
                ids: RoaringBitmap::new(),
                active_id: None,
            },
            tags: TagState {
                all: HashMap::new(),
                dirty: false,
                next_id: 1,
            },
            edits: EditStacks {
                undo: Vec::new(),
                redo: Vec::new(),
            },
        }
    }

    /// Increment the store version counter. JS uses this to detect stale responses.
    pub(crate) fn bump(&mut self) -> u64 {
        self.version += 1;
        self.version
    }

    /// Snapshot current store metadata for the frontend: version, counts, undo/redo availability.
    pub(crate) fn store_status(&self) -> StoreStatus {
        StoreStatus {
            version: self.version,
            location_count: self.alive_count,
            can_undo: !self.edits.undo.is_empty(),
            can_redo: !self.edits.redo.is_empty(),
            tag_counts: self.tags.all.iter().map(|(&id, t)| (id, t.count)).collect(),
            known_field_keys: self.known_field_keys.iter().cloned().collect(),
        }
    }

    /// Bump version, derive the render delta + selection sync from the semantic
    /// changeset, and return the full mutation result. The changeset is the single
    /// source of truth; the render delta and selection sync are two projections of it.
    pub(crate) fn finish_mutation(&mut self, changes: ChangeSet) -> MutationResult {
        self.bump();

        let has_selections = !self.selections.all.is_empty();
        let full_resolve = has_selections &&
            (changes.full_reset || changes.added.len() + changes.removed.len() + changes.updated.len() > 100
             || self.selections_need_full_resolve());

        // Step 1: Record which render cells contain changed IDs BEFORE anything mutates render_cells.
        let affected_cells: HashSet<u8> = if has_selections {
            let mut cells = HashSet::new();
            for &id in changes.removed.iter()
                .chain(changes.added.iter().map(|l| &l.id))
                .chain(changes.updated.iter().map(|(_, n)| &n.id))
            {
                if let Some(&ci) = self.render.id_to_cell_idx.get(id as usize) {
                    if ci != 255 { cells.insert(ci); }
                }
            }
            cells
        } else {
            HashSet::new()
        };

        // Step 2: Update selection membership and get back what changed.
        let membership_delta = if has_selections {
            if full_resolve {
                self.resolve_selection_membership();
                None
            } else {
                Some(self.update_selection_membership(&changes))
            }
        } else {
            None
        };

        // Step 3: Derive render delta (mutates render_cells).
        let mut delta = self.derive_render_delta(&changes);

        // Step 4: Emit colorPatches from membership changes.
        if let Some(ref md) = membership_delta {
            for &(id, color) in &md.gained {
                if let Some((cell, ci)) = self.cell_lookup(id) {
                    delta.color_patches.push(ColorPatchEntry {
                        cell, cell_index: ci,
                        r: color[0], g: color[1], b: color[2], a: 255,
                    });
                }
            }
        }

        // Step 5: Build bitmask for affected cells.
        let mut bitmask_cells = affected_cells;
        for loc in &changes.added {
            let ci = render_cell_idx(loc.lat, loc.lng);
            bitmask_cells.insert(ci);
        }
        let selection_sync = if has_selections {
            if full_resolve {
                Some(self.rebuild_selection_bitmask())
            } else {
                Some(self.build_selection_bitmask_for_cells(&bitmask_cells))
            }
        } else {
            None
        };

        let mut tags = None;
        let mut vis_changed = false;
        // NOTE: tags created with count=0 (via store_create_tags) will be
        // flipped to visible=false here on the next unrelated mutation.
        // Create is followed by assign so this shouldn't matter.
        for tag in self.tags.all.values_mut() {
            let should = tag.count > 0;
            if tag.visible != should {
                tag.visible = should;
                vis_changed = true;
            }
        }
        if vis_changed {
            self.tags.dirty = true;
            tags = Some(self.tags.all.clone());
        }

        MutationResult {
            status: self.store_status(),
            delta,
            selection_sync,
            new_field_keys: None,
            tags,
        }
    }

    /// Return the RGBA color for a location in the base render layer.
    /// Selected locations are transparent (alpha=0) because they are drawn separately
    /// by the selection overlay layer with their selection color.
    fn base_color(&self, id: u32) -> (u8, u8, u8, u8) {
        if self.selections.ids.contains(id) { (0, 0, 0, 0) } else { (42, 42, 42, 255) }
    }

    /// Whether any active selection requires a full O(S*N) resolve rather than
    /// incremental membership updates (composites and duplicates depend on global state).
    fn selections_need_full_resolve(&self) -> bool {
        self.selections.all.iter().any(|s| matches!(s.props,
            SelectionProps::Duplicates { .. }
            | SelectionProps::Intersection { .. }
            | SelectionProps::Union { .. }
            | SelectionProps::Invert { .. }))
    }

    /// Project the changeset onto render cells, returning the render delta and keeping
    /// `render_cells` / `id_to_cell_idx` in sync. This is the single place cell
    /// membership is mutated for adds / removes / moves.
    fn derive_render_delta(&mut self, changes: &ChangeSet) -> RenderDelta {
        let mut delta = RenderDelta { full_reset: changes.full_reset, ..Default::default() };

        for &id in &changes.removed {
            if let Some(removal) = self.cell_remove_render(id) {
                delta.removed.push(removal);
            }
        }

        for loc in &changes.added {
            let ci = render_cell_idx(loc.lat, loc.lng);
            let (r, g, b, a) = self.base_color(loc.id);
            self.cell_add_render(ci, loc.id);
            let angle = if self.render.arrow_style { 180.0 - loc.heading as f32 } else { 0.0 };
            delta.added.push(RenderEntry {
                cell: cell_key_from_idx(ci), id: loc.id,
                lng: loc.lng as f32, lat: loc.lat as f32, heading: angle,
                r, g, b, a,
            });
        }

        for (old, new) in &changes.updated {
            let pos_changed = old.lat != new.lat || old.lng != new.lng;
            let heading_changed = old.heading != new.heading;
            if pos_changed {
                let new_ci = render_cell_idx(new.lat, new.lng);
                let old_ci = self.render.id_to_cell_idx.get(new.id as usize).copied().unwrap_or(255);
                if old_ci != new_ci {
                    if let Some(removal) = self.cell_remove_render(new.id) {
                        delta.removed.push(removal);
                    }
                    let (r, g, b, a) = self.base_color(new.id);
                    self.cell_add_render(new_ci, new.id);
                    let angle = if self.render.arrow_style { 180.0 - new.heading as f32 } else { 0.0 };
                    delta.added.push(RenderEntry {
                        cell: cell_key_from_idx(new_ci), id: new.id,
                        lng: new.lng as f32, lat: new.lat as f32, heading: angle,
                        r, g, b, a,
                    });
                    continue;
                }
            }
            if pos_changed || heading_changed {
                if let Some((cell, ci)) = self.cell_lookup(new.id) {
                    let angle = if self.render.arrow_style { 180.0 - new.heading as f32 } else { 0.0 };
                    delta.updated.push(RenderPatchEntry {
                        cell, cell_index: ci,
                        lng: if pos_changed { Some(new.lng as f32) } else { None },
                        lat: if pos_changed { Some(new.lat as f32) } else { None },
                        heading: if heading_changed { Some(angle) } else { None },
                    });
                }
            }
        }

        delta
    }

    /// Update selection membership sets for incremental changes (adds/removes/updates).
    /// Returns which IDs gained or lost selection so callers can emit colorPatches.
    fn update_selection_membership(&mut self, changes: &ChangeSet) -> MembershipDelta {
        let mut was_selected: HashSet<u32> = HashSet::new();

        let drop_ids: HashSet<u32> = changes.removed.iter().copied()
            .chain(changes.updated.iter().map(|(_, n)| n.id))
            .collect();
        if !drop_ids.is_empty() {
            for id in &drop_ids {
                if self.selections.ids.contains(*id) { was_selected.insert(*id); }
            }
            for set in &mut self.selections.loc_sets {
                for id in &drop_ids { set.remove(*id); }
            }
            for id in &drop_ids {
                self.selections.ids.remove(*id);
            }
        }

        let test_locs: Vec<&Location> = changes.added.iter()
            .chain(changes.updated.iter().map(|(_, n)| n))
            .collect();
        let sel_props: Vec<SelectionProps> = self.selections.all.iter().map(|s| s.props.clone()).collect();
        for (si, props) in sel_props.iter().enumerate() {
            for loc in &test_locs {
                if selections::test_add_row(loc, props) {
                    self.selections.loc_sets[si].insert(loc.id);
                    self.selections.ids.insert(loc.id);
                }
            }
        }
        self.selections.version += 1;

        let mut gained = Vec::new();
        let mut lost = Vec::new();
        for loc in changes.added.iter().chain(changes.updated.iter().map(|(_, n)| n)) {
            let is_now = self.selections.ids.contains(loc.id);
            let was_before = was_selected.contains(&loc.id);
            if is_now && !was_before {
                let color = self.selections.color_for(loc.id).unwrap_or([255, 0, 0]);
                gained.push((loc.id, color));
            } else if !is_now && was_before {
                lost.push(loc.id);
            }
        }
        // Removed locations that were selected
        for &id in &changes.removed {
            if was_selected.contains(&id) {
                lost.push(id);
            }
        }

        MembershipDelta { gained, lost }
    }

    /// Build the bitmask file for only the specified cell indices.
    fn build_selection_bitmask_for_cells(&self, affected: &HashSet<u8>) -> SelectionSync {
        let counts: Vec<usize> = self.selections.loc_sets.iter().map(|s| s.len() as usize).collect();
        let selected_count = self.selections.ids.len() as usize;

        if affected.is_empty() {
            return SelectionSync { counts, patch_file: None, selected_count };
        }

        let num_sels = self.selections.all.len();
        // Serialize affected cells in parallel; segments are self-describing so order is irrelevant.
        let segments: Vec<Vec<u8>> = self.render.cells.par_iter().enumerate()
            .filter_map(|(ci, opt)| {
                if !affected.contains(&(ci as u8)) { return None; }
                let cr = opt.as_ref()?;
                Some(serialize_cell_bitmask(ci, cr, &self.selections.loc_sets))
            })
            .collect();

        let mut buf: Vec<u8> = Vec::new();
        buf.push(num_sels as u8);
        for sel in &self.selections.all {
            buf.extend_from_slice(&sel.color);
        }
        buf.push(segments.len() as u8);
        for seg in &segments {
            buf.extend_from_slice(seg);
        }

        let patch_file = {
            let path = std::env::temp_dir().join(format!("mma_sel_{}.bin", self.map_id.as_deref().unwrap_or("default")));
            let _ = std::fs::write(&path, &buf);
            Some(path.to_string_lossy().into_owned())
        };

        log::debug!("[sel-incr] sels={} selected={} affected={} buf={}",
            num_sels, selected_count, affected.len(), buf.len());

        SelectionSync { counts, patch_file, selected_count }
    }

    /// Full selection membership resolve: recomputes selection_loc_sets, selected_ids,
    /// selected_colors from scratch. O(S * N). Does NOT build the bitmask file.
    fn resolve_selection_membership(&mut self) {
        let props: Vec<SelectionProps> = self.selections.all.iter().map(|s| s.props.clone()).collect();
        let masks: Vec<Vec<bool>> = {
            let view = self.loc_view();
            props.iter().map(|p| selections::resolve_bitmask(&view, p)).collect()
        };

        let num_sels = masks.len();
        let batch_len = self.batch.as_ref().map_or(0, |b| b.num_rows());
        self.selections.loc_sets = vec![RoaringBitmap::new(); num_sels];
        for si in 0..num_sels {
            let mask = &masks[si];
            // Batch ids are iterated in ascending order (sorted-id invariant)
            if let Some(ref b) = self.batch {
                let id_col = col_id(b);
                for i in 0..b.num_rows() {
                    if self.overlay.dead.contains(&id_col.value(i)) { continue; }
                    if i < mask.len() && mask[i] {
                        self.selections.loc_sets[si].insert(id_col.value(i));
                    }
                }
            }
            for (j, loc) in self.overlay.adds.iter().enumerate() {
                let mi = batch_len + j;
                if mi < mask.len() && mask[mi] {
                    self.selections.loc_sets[si].insert(loc.id);
                }
            }
        }

        let mut all_selected = RoaringBitmap::new();
        for set in &self.selections.loc_sets {
            all_selected |= set;
        }
        self.selections.ids = all_selected;
        self.selections.version += 1;
    }

    /// Full selection re-resolve + bitmask build (used by callers outside finish_mutation).
    pub(crate) fn refresh_and_sync_selections(&mut self) -> SelectionSync {
        self.resolve_selection_membership();
        self.rebuild_selection_bitmask()
    }

    /// Build the bitmask file from current render_cells + selection_loc_sets (all cells).
    fn rebuild_selection_bitmask(&self) -> SelectionSync {
        let t0 = std::time::Instant::now();
        let counts: Vec<usize> = self.selections.loc_sets.iter().map(|s| s.len() as usize).collect();
        let selected_count = self.selections.ids.len() as usize;

        let num_sels = self.selections.all.len();
        // Serialize all populated cells in parallel.
        let segments: Vec<Vec<u8>> = self.render.cells.par_iter().enumerate()
            .filter_map(|(ci, opt)| {
                let cr = opt.as_ref()?;
                Some(serialize_cell_bitmask(ci, cr, &self.selections.loc_sets))
            })
            .collect();
        let num_cells = segments.len();

        let mut buf: Vec<u8> = Vec::new();
        buf.push(num_sels as u8);
        for sel in &self.selections.all {
            buf.extend_from_slice(&sel.color);
        }
        buf.push(num_cells as u8);
        for seg in &segments {
            buf.extend_from_slice(seg);
        }

        let patch_file = if num_cells > 0 {
            let path = std::env::temp_dir().join(format!("mma_sel_{}.bin", self.map_id.as_deref().unwrap_or("default")));
            let _ = std::fs::write(&path, &buf);
            Some(path.to_string_lossy().into_owned())
        } else {
            None
        };

        log::debug!("[sel-rebuild] total={}ms sels={} selected={} cells={} buf={}",
            t0.elapsed().as_millis(), num_sels, selected_count, num_cells, buf.len());

        SelectionSync { counts, patch_file, selected_count }
    }

    /// Record that the geohash cell containing `(lat, lng)` has been modified.
    /// Used by VCS snapshot to determine which cells need re-serialization.
    pub(crate) fn mark_dirty(&mut self, lat: f64, lng: f64) {
        self.overlay.dirty_geohashes.insert(encode_geohash(lat, lng));
    }

    /// Adjust tag counts by `delta` (+1 for adds, -1 for removes). O(L * T) where L = locs, T = avg tags per loc.
    pub(crate) fn update_tag_counts(&mut self, locs: &[Location], delta: isize) {
        for loc in locs {
            for &tag_id in &loc.tags {
                if let Some(tag) = self.tags.all.get_mut(&tag_id) {
                    if delta < 0 {
                        tag.count = tag.count.saturating_sub((-delta) as usize);
                    } else {
                        tag.count += delta as usize;
                    }
                } else if delta > 0 {
                    self.tags.all.insert(tag_id, Tag {
                        id: tag_id,
                        name: format!("Tag {}", tag_id),
                        color: util::color_for_name(&format!("Tag {}", tag_id)),
                        visible: true,
                        order: None,
                        count: delta as usize,
                    });
                    self.tags.dirty = true;
                }
            }
        }
    }

    /// Increment tag counts for all tags referenced by `locs`.
    pub(crate) fn add_tag_counts(&mut self, locs: &[Location]) { self.update_tag_counts(locs, 1); }
    /// Decrement tag counts for all tags referenced by `locs` (saturating at zero).
    pub(crate) fn remove_tag_counts(&mut self, locs: &[Location]) { self.update_tag_counts(locs, -1); }

    /// Grow `id_to_cell_idx` so it can index `id`. Fills new slots with 255 (sentinel = unmapped).
    fn ensure_id_to_cell_capacity(&mut self, id: u32) {
        let needed = id as usize + 1;
        if self.render.id_to_cell_idx.len() < needed {
            self.render.id_to_cell_idx.resize(needed, 255u8);
        }
    }

    /// Register a location in a render cell, appending it to the end. Returns the new index.
    pub(crate) fn cell_add_render(&mut self, cell_idx: u8, id: u32) -> usize {
        let cr = self.render.cells[cell_idx as usize].get_or_insert_with(|| CellRender {
            id_order: Vec::new(),
            id_to_index: HashMap::new(),
        });
        let idx = cr.id_order.len();
        cr.id_to_index.insert(id, idx);
        cr.id_order.push(id);
        self.ensure_id_to_cell_capacity(id);
        self.render.id_to_cell_idx[id as usize] = cell_idx;
        idx
    }

    /// Remove a location from its render cell via swap-remove. Returns the removal
    /// descriptor (needed by JS to patch its typed arrays) or `None` if not found.
    fn cell_remove_render(&mut self, id: u32) -> Option<CellRemoval> {
        let ci = *self.render.id_to_cell_idx.get(id as usize)?;
        if ci == 255 { return None; }
        self.render.id_to_cell_idx[id as usize] = 255;
        let cr = self.render.cells[ci as usize].as_mut()?;
        let idx = cr.id_to_index.remove(&id)?;
        let last = cr.id_order.len() - 1;
        if idx != last {
            let moved_id = cr.id_order[last];
            cr.id_order[idx] = moved_id;
            cr.id_to_index.insert(moved_id, idx);
        }
        cr.id_order.pop();
        Some(CellRemoval { cell: cell_key_from_idx(ci), cell_index: idx, id })
    }

    /// Look up a location's render cell key and index within that cell.
    fn cell_lookup(&self, id: u32) -> Option<(String, usize)> {
        let ci = *self.render.id_to_cell_idx.get(id as usize)?;
        if ci == 255 { return None; }
        let cr = self.render.cells[ci as usize].as_ref()?;
        let idx = *cr.id_to_index.get(&id)?;
        Some((cell_key_from_idx(ci), idx))
    }

    /// Allocate the next monotonically increasing location ID.
    pub(crate) fn alloc_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    /// Allocate the next monotonically increasing tag ID.
    pub(crate) fn alloc_tag_id(&mut self) -> u32 {
        let id = self.tags.next_id;
        self.tags.next_id += 1;
        id
    }

    /// Push an edit onto the undo stack, capping at MAX_UNDO_ENTRIES. O(1) amortized.
    pub(crate) fn push_undo(&mut self, entry: EditEntry) {
        self.edits.undo.push(entry);
        if self.edits.undo.len() > MAX_UNDO_ENTRIES {
            self.edits.undo.drain(..self.edits.undo.len() - MAX_UNDO_ENTRIES);
        }
    }

    /// Unwrap the batch ref; panics if no map is open.
    fn batch_ref(&self) -> &RecordBatch {
        self.batch.as_ref().expect("no map open")
    }

    /// Look up a location by ID across patches, overlay_adds (binary search), and batch.
    fn get_loc_by_id(&self, id: u32) -> Option<Location> {
        if self.overlay.dead.contains(&id) { return None; }
        if let Some(patched) = self.overlay.patches.get(&id) { return Some(patched.clone()); }
        if let Ok(i) = self.overlay.adds.binary_search_by_key(&id, |l| l.id) {
            return Some(self.overlay.adds[i].clone());
        }
        if let Some(ref b) = self.batch {
            if let Some(idx) = batch_row_for_id(b, id) {
                return Some(arrow_bridge::row_to_location(b, idx));
            }
        }
        None
    }

    /// Read a location from the batch by row index, applying any overlay patch.
    fn get_loc(&self, idx: usize) -> Location {
        let loc = arrow_bridge::row_to_location(self.batch_ref(), idx);
        if let Some(patched) = self.overlay.patches.get(&loc.id) {
            return patched.clone();
        }
        loc
    }
    
    /// Collect all alive locations (batch + overlay) into a Vec. O(N) time and space.
    pub(crate) fn collect_all_locations(&self) -> Vec<Location> {
        let mut locs = Vec::new();
        if let Some(ref b) = self.batch {
            for i in 0..b.num_rows() {
                let id = col_id(b).value(i);
                if self.overlay.dead.contains(&id) { continue; }
                if let Some(patched) = self.overlay.patches.get(&id) {
                    locs.push(patched.clone());
                } else {
                    locs.push(arrow_bridge::row_to_location(b, i));
                }
            }
        }
        locs.extend(self.overlay.adds.iter().cloned());
        locs
    }

    /// Construct a read-only view over all alive locations for selection resolution.
    pub(crate) fn loc_view(&self) -> selections::LocView<'_> {
        selections::LocView::new(
            self.batch.as_ref(),
            &self.overlay.dead,
            &self.overlay.patches,
            &self.overlay.adds,
        )
    }

    /// Insert or restore a location in the overlay. O(1) amortized.
    pub(crate) fn overlay_add(&mut self, loc: Location) {
        self.mark_dirty(loc.lat, loc.lng);
        self.overlay.dirty = true;
        self.alive_count += 1;
        let in_batch = self.batch.as_ref().and_then(|b| batch_row_for_id(b, loc.id)).is_some();
        if in_batch {
            self.overlay.dead.remove(&loc.id);
            self.overlay.patches.insert(loc.id, loc);
        } else {
            self.overlay.dead.remove(&loc.id);
            // Keep overlay_adds sorted by id (invariant asserted in bake_overlay). A normal add has a
            // monotonic new id so this inserts at the end (cheap, like push); undo re-adds an old id,
            // which a plain push would append out of order — partition_point puts it in its sorted slot.
            let pos = self.overlay.adds.partition_point(|l| l.id < loc.id);
            self.overlay.adds.insert(pos, loc);
        }
    }

    /// Mark locations as dead in the overlay. O(L) for L locations removed.
    fn overlay_remove(&mut self, locs: &[Location]) {
        let remove_set: HashSet<u32> = locs.iter().map(|l| l.id).collect();
        for loc in locs {
            self.mark_dirty(loc.lat, loc.lng);
            self.alive_count -= 1;
            self.overlay.patches.remove(&loc.id);
        }
        self.overlay.dead.extend(&remove_set);
        self.overlay.adds.retain(|l| !remove_set.contains(&l.id));
        self.overlay.dirty = true;
    }

    /// Apply a partial patch to an existing location. Reads the current state, merges
    /// non-None fields from the patch, and writes back to overlay_adds or overlay_patches.
    fn overlay_update(&mut self, id: u32, patch: &LocationPatch) {
        let mut loc = match self.get_loc_by_id(id) {
            Some(l) => l,
            None => return,
        };
        self.mark_dirty(loc.lat, loc.lng);
        if let Some(v) = patch.lat { loc.lat = v; }
        if let Some(v) = patch.lng { loc.lng = v; }
        if let Some(v) = patch.heading { loc.heading = v; }
        if let Some(v) = patch.pitch { loc.pitch = v; }
        if let Some(v) = patch.zoom { loc.zoom = v; }
        if let Some(ref v) = patch.pano_id { loc.pano_id = v.clone(); }
        if let Some(v) = patch.flags { loc.flags = v; }
        if let Some(ref v) = patch.tags { loc.tags = v.clone(); }
        if let Some(ref v) = patch.extra { loc.extra = v.clone(); }
        if let Some(ref v) = patch.created_at { loc.created_at = v.clone(); }
        if let Some(ref v) = patch.modified_at { loc.modified_at = v.clone(); }
        self.mark_dirty(loc.lat, loc.lng);
        // If it's in overlay_adds, update in place
        if let Ok(pos) = self.overlay.adds.binary_search_by_key(&id, |l| l.id) {
            self.overlay.adds[pos] = loc;
        } else {
            self.overlay.patches.insert(id, loc);
        }
        self.overlay.dirty = true;
    }

    /// Reset overlay state. Called after bake or on map close.
    fn clear_overlay(&mut self) {
        self.overlay.adds.clear();
        self.overlay.dead.clear();
        self.overlay.patches.clear();
        self.overlay.dirty = false;
    }

    /// Merge overlay (adds, patches, dead) into the Arrow batch. O(N) where N = batch rows.
    /// Expensive at 10M+ rows — prefer delta saves; full bake only on commit.
    pub(crate) fn bake_overlay(&mut self) {
        if !self.overlay.dirty { return; }
        let _t = std::time::Instant::now();

        let mut batch = match self.batch.take() {
            Some(b) => b,
            None => {
                // No batch yet, just convert adds
                let b = arrow_bridge::locations_to_batch(&self.overlay.adds);
                self.clear_overlay();
                self.batch = Some(b);
                self.rebuild_index();
                return;
            }
        };

        // Step 1: filter out dead rows
        if !self.overlay.dead.is_empty() {
            let ids = col_id(&batch);
            let keep: Vec<u32> = (0..batch.num_rows())
                .filter(|&i| !self.overlay.dead.contains(&ids.value(i)))
                .map(|i| i as u32)
                .collect();
            if keep.len() < batch.num_rows() {
                let take_idx = arrow::array::UInt32Array::from(keep);
                batch = RecordBatch::try_new(
                    batch.schema(),
                    batch.columns().iter().map(|col| {
                        arrow::compute::take(col.as_ref(), &take_idx, None).unwrap()
                    }).collect(),
                ).unwrap();
            }
        }

        // Step 2: apply patches in place (preserves row order for sorted ID invariant)
        if !self.overlay.patches.is_empty() {
            let ids = col_id(&batch);
            let has_any = (0..batch.num_rows()).any(|i| self.overlay.patches.contains_key(&ids.value(i)));
            if has_any {
                let all: Vec<Location> = (0..batch.num_rows()).map(|i| {
                    let id = ids.value(i);
                    match self.overlay.patches.get(&id) {
                        Some(p) => p.clone(),
                        None => arrow_bridge::row_to_location(&batch, i),
                    }
                }).collect();
                batch = arrow_bridge::locations_to_batch(&all);
            }
        }

        // Step 3: concat adds
        if !self.overlay.adds.is_empty() {
            let add_batch = arrow_bridge::locations_to_batch(&self.overlay.adds);
            let s = schema();
            batch = arrow::compute::concat_batches(&s, &[batch, add_batch])
                .expect("concat failed");
        }

        log::debug!("[bake_overlay] total={}ms rows={}", _t.elapsed().as_millis(), batch.num_rows());
        assert!({
            let ids = col_id(&batch);
            (1..batch.num_rows()).all(|i| ids.value(i - 1) < ids.value(i))
        }, "batch IDs must be strictly sorted after bake");
        self.batch = Some(batch);
        self.clear_overlay();
        self.rebuild_index();
    }

    /// Rebuild geohash_index from the batch. O(N).
    pub(crate) fn rebuild_index(&mut self) {
        self.geohash_index.clear();
        if let Some(ref b) = self.batch {
            let lats = col_lat(b);
            let lngs = col_lng(b);
            for i in 0..b.num_rows() {
                let gh = encode_geohash(lats.value(i), lngs.value(i));
                self.geohash_index.entry(gh).or_default().push(i);
            }
        }
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

    pub fn store_for_window(&mut self, label: &str) -> Result<&mut Store, String> {
        let map_id = self.window_map.get(label)
            .ok_or_else(|| format!("no map open in window '{label}'"))?
            .clone();
        self.stores.get_mut(&map_id)
            .ok_or_else(|| format!("store not found for map '{map_id}'"))
    }

    pub fn store_for_map(&mut self, map_id: &str) -> Result<&mut Store, String> {
        self.stores.get_mut(map_id)
            .ok_or_else(|| format!("no store for map '{map_id}'"))
    }

    pub fn map_id_for_window(&self, label: &str) -> Result<String, String> {
        self.window_map.get(label)
            .cloned()
            .ok_or_else(|| format!("no map open in window '{label}'"))
    }
}

pub type StoreState = Mutex<StoreManager>;

macro_rules! with_store {
    ($webview:expr, $state:expr, |$store:ident| $body:block) => {{
        let mut mgr = $state.lock().map_err(|e| e.to_string())?;
        let $store = mgr.store_for_window($webview.label())?;
        $body
    }};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Metadata snapshot returned to JS after every mutation. JS uses `version` to
/// detect stale responses and `canUndo`/`canRedo` for toolbar button state.
/// `known_field_keys` lists every extra-field key that exists in location data
/// on this map. Add-only within a session; seeded from `MapMeta.extra.fields`
/// on map open.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StoreStatus {
    pub version: u64,
    pub location_count: usize,
    pub can_undo: bool,
    pub can_redo: bool,
    pub tag_counts: HashMap<u32, usize>,
    pub known_field_keys: Vec<String>,
}

/// Result of `store_save_dirty`: how many bytes were written to the delta file.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub saved_chunks: usize,
}

/// Lightweight status for polling: count, version, and whether unsaved changes exist.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SummaryResult {
    pub location_count: usize,
    pub version: u64,
    pub dirty_count: usize,
}

/// Incremental render update sent to JS after a mutation. Contains adds, position/heading
/// patches, swap-removals, and color patches (for selection overlay changes).
/// `full_reset` signals JS to discard all cell data and re-fetch via `store_fill_render_file`.
#[derive(serde::Serialize, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderDelta {
    pub added: Vec<RenderEntry>,
    pub updated: Vec<RenderPatchEntry>,
    pub removed: Vec<CellRemoval>,
    pub color_patches: Vec<ColorPatchEntry>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub full_reset: bool,
}

/// Semantic description of what a mutation changed, independent of any consumer.
/// `finish_mutation` derives both the render delta and the selection sync from it —
/// one source of truth, two projections. `updated` carries `(old, new)` so the
/// render side can detect cell moves / pos-heading patches and the selection side
/// can re-test membership.
#[derive(Default)]
pub struct ChangeSet {
    pub added: Vec<Location>,
    pub removed: Vec<u32>,
    pub updated: Vec<(Location, Location)>,
    pub full_reset: bool,
}

/// A newly-added marker to a render cell: position, heading, and base color.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderEntry {
    pub cell: String,
    pub id: u32,
    pub lng: f32,
    pub lat: f32,
    pub heading: f32,
    pub r: u8, pub g: u8, pub b: u8, pub a: u8,
}

/// Partial update to an existing marker within its cell (position and/or heading changed).
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderPatchEntry {
    pub cell: String,
    pub cell_index: usize,
    pub lng: Option<f32>,
    pub lat: Option<f32>,
    pub heading: Option<f32>,
}

/// A swap-removal from a render cell. JS must move the last element into `cell_index`
/// and pop the array to mirror the Rust-side swap-remove.
#[derive(serde::Serialize, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CellRemoval {
    pub cell: String,
    pub cell_index: usize,
    pub id: u32,
}

/// Override the RGBA color of a single marker within a cell (used when selection
/// membership changes without a position change).
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ColorPatchEntry {
    pub cell: String,
    pub cell_index: usize,
    pub r: u8, pub g: u8, pub b: u8, pub a: u8,
}

/// Selection bitmask sync payload. `patch_file` points to a temp binary that JS reads
/// via `mma-buf://` to update the selection overlay colors. `counts` gives per-selection
/// match counts for sidebar display.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SelectionSync {
    pub counts: Vec<usize>,
    pub patch_file: Option<String>,
    pub selected_count: usize,
}

/// Unified response for every mutation IPC. Bundles the store status, render delta,
/// optional selection sync, optional newly-discovered extra-field keys, and optional
/// updated tags. JS applies all of these atomically to stay in sync with the Rust state.
/// `new_field_keys` carries only keys discovered for the first time in this mutation --
/// field metadata (type, label) is resolved on the JS side via the field-def registry.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    #[serde(flatten)]
    pub status: StoreStatus,
    pub delta: RenderDelta,
    pub selection_sync: Option<SelectionSync>,
    pub new_field_keys: Option<Vec<String>>,
    pub tags: Option<HashMap<u32, Tag>>,
}

/// Deserialize a present-but-null JSON field as `Some(None)` instead of `None`.
/// Missing field → `None` (don't update), `null` → `Some(None)` (set to null),
/// `"value"` → `Some(Some("value"))` (set to value).
fn nullable<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    Ok(Some(Option::deserialize(deserializer)?))
}

/// Partial location update from JS. `None` fields are unchanged; `Some(None)` on
/// nullable fields (panoId, extra, modifiedAt) explicitly sets the field to null.
#[derive(Default, serde::Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct LocationPatch {
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub heading: Option<f64>,
    pub pitch: Option<f64>,
    pub zoom: Option<f64>,
    #[serde(default, deserialize_with = "nullable")]
    #[specta(type = Option<Option<String>>)]
    pub pano_id: Option<Option<String>>,
    pub flags: Option<u32>,
    pub tags: Option<Vec<u32>>,
    #[serde(default, deserialize_with = "nullable")]
    #[specta(type = Option<Option<specta_typescript::Any>>)]
    pub extra: Option<Option<serde_json::Map<String, serde_json::Value>>>,
    pub created_at: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    #[specta(type = Option<Option<String>>)]
    pub modified_at: Option<Option<String>>,
}



// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Load a map's Arrow data from disk, rebuild all indexes, and return initial state
/// (tag counts, undo/redo availability). Must be called before any other store commands.
#[tauri::command]
#[specta::specta]
pub async fn store_open_map(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    map_id: String,
) -> Result<StoreStatus, String> {
    let app2 = app.clone();
    let map_id2 = map_id.clone();

    let result = tokio::task::spawn_blocking(move || {
        use std::time::Instant;
        let t_total = Instant::now();

        let (batch, mmap_handle) = {
            let t0 = Instant::now();
            let path = fast_io::arrow_path(&app2, &map_id2)?;
            let delta_path = fast_io::arrow_delta_path(&app2, &map_id2)?;
            let has_delta = delta_path.exists();

            if !path.exists() {
                log::debug!("[store_open] no arrow file, empty batch");
                (RecordBatch::new_empty(schema()), None)
            } else if !has_delta {
                // Fast path: mmap directly, no copying
                let (batch, handle) = fast_io::read_arrow_ipc_mmap(&path)?;
                log::debug!("[store_open] mmap_read={}ms rows={}", t0.elapsed().as_millis(), batch.num_rows());
                (batch, Some(handle))
            } else {
                // Delta exists: heap read + merge + checkpoint, then mmap the result
                let mut batch = fast_io::read_arrow_ipc(&path)?;
                log::debug!("[store_open] arrow_read={}ms rows={}", t0.elapsed().as_millis(), batch.num_rows());

                let t_d = Instant::now();
                if let Ok(data) = std::fs::read(&delta_path) {
                    if let Ok(delta) = rmp_serde::from_slice::<DeltaOverlay>(&data) {
                        if !delta.dead_ids.is_empty() {
                            let dead_set: HashSet<u32> = delta.dead_ids.into_iter().collect();
                            let ids_col = col_id(&batch);
                            let keep: Vec<u32> = (0..batch.num_rows())
                                .filter(|&i| !dead_set.contains(&ids_col.value(i)))
                                .map(|i| i as u32)
                                .collect();
                            if keep.len() < batch.num_rows() {
                                let take_idx = UInt32Array::from(keep);
                                batch = RecordBatch::try_new(
                                    batch.schema(),
                                    batch.columns().iter().map(|col| {
                                        arrow::compute::take(col.as_ref(), &take_idx, None).unwrap()
                                    }).collect(),
                                ).unwrap();
                            }
                        }
                        if !delta.patches.is_empty() {
                            let patch_map: HashMap<u32, &Location> = delta.patches.iter().map(|l| (l.id, l)).collect();
                            let all: Vec<Location> = {
                                let ids_col = col_id(&batch);
                                (0..batch.num_rows()).map(|i| {
                                    let id = ids_col.value(i);
                                    if let Some(&patched) = patch_map.get(&id) { patched.clone() }
                                    else { arrow_bridge::row_to_location(&batch, i) }
                                }).collect()
                            };
                            batch = arrow_bridge::locations_to_batch(&all);
                        }
                        if !delta.adds.is_empty() {
                            let add_batch = arrow_bridge::locations_to_batch(&delta.adds);
                            batch = concat_batches(&schema(), &[batch, add_batch]).map_err(|e| e.to_string())?;
                        }
                        fast_io::write_arrow_ipc(&path, &batch)?;
                        let _ = std::fs::remove_file(&delta_path);
                        log::debug!("[store_open] delta checkpointed to Arrow IPC");
                    } else {
                        log::warn!("[store_open] delta deserialization failed, delta file preserved");
                    }
                }
                log::debug!("[store_open] delta_merge={}ms rows={}", t_d.elapsed().as_millis(), batch.num_rows());

                // Drop the heap batch and mmap the checkpointed file instead
                drop(batch);
                let (batch, handle) = fast_io::read_arrow_ipc_mmap(&path)?;
                log::debug!("[store_open] post-delta mmap={}ms rows={}", t0.elapsed().as_millis(), batch.num_rows());
                (batch, Some(handle))
            }
        };

        // Ensure sorted ID invariant (one-time migration for pre-Phase2 files)
        let (batch, mmap_handle) = {
            let ids = col_id(&batch);
            let sorted = (1..batch.num_rows()).all(|i| ids.value(i - 1) < ids.value(i));
            if sorted || batch.num_rows() == 0 {
                (batch, mmap_handle)
            } else {
                log::info!("[store_open] migrating unsorted Arrow file to sorted ID order");
                let sort_idx = arrow::compute::sort_to_indices(ids, None, None)
                    .map_err(|e| e.to_string())?;
                let sorted_batch = RecordBatch::try_new(
                    batch.schema(),
                    batch.columns().iter().map(|col| {
                        arrow::compute::take(col.as_ref(), &sort_idx, None).unwrap()
                    }).collect(),
                ).unwrap();
                drop(batch);
                drop(mmap_handle);
                let path = fast_io::arrow_path(&app2, &map_id2)?;
                fast_io::write_arrow_ipc(&path, &sorted_batch)?;
                drop(sorted_batch);
                let (b, h) = fast_io::read_arrow_ipc_mmap(&path)?;
                log::info!("[store_open] migration complete, re-mmap'd sorted file");
                (b, Some(h))
            }
        };

        let t3 = Instant::now();
        let lats = col_lat(&batch);
        let lngs = col_lng(&batch);
        let n = batch.num_rows();
        let mut geohash_index: HashMap<String, Vec<usize>> = HashMap::new();
        let max_id = if n > 0 { col_id(&batch).value(n - 1) } else { 0 };
        for i in 0..n {
            let gh = encode_geohash(lats.value(i), lngs.value(i));
            geohash_index.entry(gh).or_default().push(i);
        }
        log::debug!("[store_open] index_build={}ms", t3.elapsed().as_millis());

        let (undo, redo) = load_edit_history_inner(&app2, &map_id2)?;

        log::debug!("[store_open] TOTAL={}ms", t_total.elapsed().as_millis());
        Ok::<_, String>((batch, mmap_handle, geohash_index, max_id, undo, redo))
    })
    .await
    .map_err(|e| e.to_string())??;

    let (batch, mmap_handle, geohash_index, max_id, undo, redo) = result;

    let count = batch.num_rows();
    let mut store = Store::new();
    store.bump();
    store.map_id = Some(map_id.clone());
    store.next_id = max_id + 1;
    store.batch = Some(batch);
    store.mmap_handle = mmap_handle;
    store.alive_count = count;
    {
        let conn = fast_io::open_db(&app)?;
        conn.execute("UPDATE maps SET location_count = ?1 WHERE id = ?2",
            rusqlite::params![count, map_id]).map_err(|e| e.to_string())?;
        let mut tags = read_tags_json(&conn, &map_id);
        for tag in tags.values_mut() { tag.count = 0; }
        let mut max_tag_id: u32 = tags.keys().max().copied().unwrap_or(0);
        {
            let b = store.batch.as_ref().unwrap();
            let tags_col = col_tags(b);
            for i in 0..b.num_rows() {
                let list = tags_col.value(i);
                let ids = list.as_any().downcast_ref::<UInt32Array>().unwrap();
                for j in 0..ids.len() {
                    let tid = ids.value(j);
                    if tid > max_tag_id { max_tag_id = tid; }
                    if let Some(tag) = tags.get_mut(&tid) {
                        tag.count += 1;
                    } else {
                        tags.insert(tid, Tag {
                            id: tid,
                            name: format!("Tag {}", tid),
                            color: util::color_for_name(&format!("Tag {}", tid)),
                            visible: true,
                            order: None,
                            count: 1,
                        });
                    }
                }
            }
        }
        store.tags.all = tags;
        store.tags.dirty = false;
        store.tags.next_id = max_tag_id + 1;
        let extra_str: String = conn.query_row(
            "SELECT extra FROM maps WHERE id = ?1",
            rusqlite::params![map_id],
            |row| row.get(0),
        ).unwrap_or_default();
        let extra: map_meta::MapExtra = serde_json::from_str(&extra_str).unwrap_or_default();
        store.known_field_keys = extra.fields.as_ref()
            .map(|f| f.keys().cloned().collect())
            .unwrap_or_default();
    }
    store.geohash_index = geohash_index;
    store.edits.undo = undo;
    store.edits.redo = redo;

    let status = store.store_status();
    let mut mgr = state.lock().map_err(|e| e.to_string())?;
    mgr.window_map.insert(webview.label().to_string(), map_id.clone());
    mgr.stores.insert(map_id, store);
    Ok(status)
}

/// Close the current map: bake overlay, flush Arrow + tags + edit history to disk, then
/// release all in-memory state (batch, mmap, indexes, selections, undo stacks).
#[tauri::command]
#[specta::specta]
pub fn store_close_map(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
) -> Result<(), String> {
    let mut mgr = state.lock().map_err(|e| e.to_string())?;
    let label = webview.label().to_string();
    let map_id = match mgr.window_map.remove(&label) {
        Some(id) => id,
        None => return Ok(()),
    };
    let still_open = mgr.window_map.values().any(|v| v == &map_id);
    if still_open {
        return Ok(());
    }
    if let Some(mut store) = mgr.stores.remove(&map_id) {
        if store.overlay.dirty {
            store.bake_overlay();
            store.mmap_handle = None;
            if let Some(ref batch) = store.batch {
                let path = fast_io::arrow_path(&app, &map_id)?;
                fast_io::write_arrow_ipc(&path, batch)?;
            }
            let delta_path = fast_io::arrow_delta_path(&app, &map_id)?;
            let _ = std::fs::remove_file(delta_path);
        }
        let count = store.alive_count;
        let conn = fast_io::open_db(&app)?;
        conn.execute("UPDATE maps SET location_count = ?1 WHERE id = ?2", rusqlite::params![count, map_id])
            .map_err(|e| e.to_string())?;
        if store.tags.dirty {
            write_tags_json(&conn, &map_id, &store.tags.all)?;
        }
        save_edit_history_inner(&app, &map_id, &store.edits.undo, &store.edits.redo)?;
    }
    Ok(())
}

/// Scan `extra` JSON maps for keys not yet in `known_field_keys`, persist inferred
/// field definitions to SQLite (for export and cross-session survival), and return
/// the newly-discovered keys to JS via `result.new_field_keys`. Field *metadata*
/// (type, label) is resolved on the JS side; Rust only tracks key existence.
pub(crate) fn auto_register_extras(
    app: &tauri::AppHandle,
    store: &mut Store,
    extras: &[&serde_json::Map<String, serde_json::Value>],
    result: &mut MutationResult,
) {
    if extras.is_empty() { return; }
    if let Some(new_defs) = map_meta::auto_register_field_defs(&store.known_field_keys, extras) {
        let new_keys: Vec<String> = new_defs.keys().cloned().collect();
        if let Some(map_id) = &store.map_id {
            if let Ok(conn) = fast_io::open_db(app) {
                let _ = map_meta::persist_field_defs(&conn, map_id, &new_defs);
            }
        }
        for key in &new_keys {
            store.known_field_keys.insert(key.clone());
        }
        result.new_field_keys = Some(new_keys);
    }
}

/// Add new locations. IDs are allocated server-side (monotonic). Records an undo entry
/// and clears the redo stack.
#[tauri::command]
#[specta::specta]
pub fn store_add_locations(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    mut locations: Vec<Location>,
) -> Result<MutationResult, String> {
    let _t = std::time::Instant::now();
    with_store!(webview, state, |store| {
        let _lock = _t.elapsed().as_millis();
        for loc in &mut locations {
            loc.id = store.alloc_id();
        }
        store.push_undo(EditEntry { created: locations.clone(), removed: Vec::new() });
        store.edits.redo.clear();
        for loc in &locations {
            store.mark_dirty(loc.lat, loc.lng);
        }
        store.add_tag_counts(&locations);
        let added = locations.clone();
        for loc in locations {
            store.overlay_add(loc);
        }
        let mut result = store.finish_mutation(ChangeSet { added: added.clone(), ..Default::default() });
        let extras: Vec<&serde_json::Map<String, serde_json::Value>> = added.iter()
            .filter_map(|l| l.extra.as_ref())
            .collect();
        auto_register_extras(&app, store, &extras, &mut result);
        log::debug!("[cmd] store_add_locations lock={}ms total={}ms", _lock, _t.elapsed().as_millis());
        Ok(result)
    })
}

/// Remove locations by ID. Snapshots the full location data for undo before deleting.
#[tauri::command]
#[specta::specta]
pub fn store_remove_locations(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    ids: Vec<u32>,
) -> Result<MutationResult, String> {
    let _t = std::time::Instant::now();
    with_store!(webview, state, |store| {
        let mut removed_locs = Vec::new();
        for &id in &ids {
            if let Some(loc) = store.get_loc_by_id(id) {
                removed_locs.push(loc);
            }
        }
        store.remove_tag_counts(&removed_locs);
        store.overlay_remove(&removed_locs);

        let removed_ids: Vec<u32> = removed_locs.iter().map(|l| l.id).collect();
        store.push_undo(EditEntry { created: Vec::new(), removed: removed_locs });
        store.edits.redo.clear();

        log::debug!("[cmd] store_remove_locations total={}ms ids={}", _t.elapsed().as_millis(), ids.len());
        Ok(store.finish_mutation(ChangeSet { removed: removed_ids, ..Default::default() }))
    })
}

/// Apply partial patches to existing locations. `record_undo` defaults to true;
/// set to false for ephemeral updates (e.g., plugin-driven batch modifications
/// that manage their own undo).
#[tauri::command]
#[specta::specta]
pub fn store_update_locations(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    updates: Vec<(u32, LocationPatch)>,
    record_undo: Option<bool>,
) -> Result<MutationResult, String> {
    let record_undo = record_undo.unwrap_or(true);
    let _t = std::time::Instant::now();
    with_store!(webview, state, |store| {
        let mut updated: Vec<(Location, Location)> = Vec::new();
        let any_tags = updates.iter().any(|(_, p)| p.tags.is_some());
        let any_extras = updates.iter().any(|(_, p)| p.extra.is_some());
        for (id, patch) in &updates {
            if let Some(old) = store.get_loc_by_id(*id) {
                store.overlay_update(*id, patch);
                let new_loc = store.get_loc_by_id(*id).unwrap();
                updated.push((old, new_loc));
            }
        }
        if any_tags {
            let old_locs: Vec<Location> = updated.iter().map(|(o, _)| o.clone()).collect();
            let new_locs: Vec<Location> = updated.iter().map(|(_, n)| n.clone()).collect();
            store.remove_tag_counts(&old_locs);
            store.add_tag_counts(&new_locs);
        }
        if record_undo {
            let (changed_old, changed_new): (Vec<_>, Vec<_>) = updated.iter()
                .filter(|(o, n)| o != n)
                .map(|(o, n)| (o.clone(), n.clone()))
                .unzip();
            if !changed_old.is_empty() {
                store.push_undo(EditEntry { created: changed_new, removed: changed_old });
                store.edits.redo.clear();
            }
        }
        let mut result = store.finish_mutation(ChangeSet { updated: updated.clone(), ..Default::default() });
        if any_extras {
            let extras: Vec<&serde_json::Map<String, serde_json::Value>> = updated.iter()
                .filter_map(|(_, n)| n.extra.as_ref())
                .collect();
            auto_register_extras(&app, store, &extras, &mut result);
        }
        log::debug!("[cmd] store_update_locations n={} undo={} total={}ms",
            updates.len(), record_undo, _t.elapsed().as_millis());
        Ok(result)
    })
}

/// Update a tag's name and/or color. If the new name collides with an existing
/// tag (case-insensitive), merges: remaps all locations from `tag_id` to the
/// existing tag, removes `tag_id`. Returns MutationResult with `tags` populated.
#[tauri::command]
#[specta::specta]
pub fn store_update_tag(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    tag_id: u32,
    name: Option<String>,
    color: Option<String>,
) -> Result<MutationResult, String> {
    let _t = std::time::Instant::now();
    with_store!(webview, state, |store| {

    if !store.tags.all.contains_key(&tag_id) { return Err("tag not found".into()); }

    let merge_target = name.as_ref().and_then(|new_name| {
        let trimmed = new_name.trim();
        if trimmed.is_empty() { return None; }
        let lower = trimmed.to_lowercase();
        store.tags.all.iter().find(|(&id, t)| id != tag_id && t.name.to_lowercase() == lower).map(|(&id, _)| id)
    });

    let changeset = if let Some(target_id) = merge_target {
        let view = store.loc_view();
        let affected = selections::resolve(&view, &SelectionProps::Tag { tag_id });
        drop(view);

        let mut updated: Vec<(Location, Location)> = Vec::new();
        for loc_id in &affected {
            if let Some(old) = store.get_loc_by_id(*loc_id) {
                let mut new_tags: Vec<u32> = old.tags.iter()
                    .filter(|&&t| t != tag_id)
                    .copied()
                    .collect();
                if !new_tags.contains(&target_id) { new_tags.push(target_id); }
                let mut new_loc = old.clone();
                new_loc.tags = new_tags;
                updated.push((old, new_loc));
            }
        }

        let old_locs: Vec<Location> = updated.iter().map(|(o, _)| o.clone()).collect();
        store.remove_tag_counts(&old_locs);
        for (_, new_loc) in &updated {
            let patch = LocationPatch { tags: Some(new_loc.tags.clone()), ..Default::default() };
            store.overlay_update(new_loc.id, &patch);
        }
        let new_locs: Vec<Location> = updated.iter().map(|(_, n)| n.clone()).collect();
        store.add_tag_counts(&new_locs);

        let (changed_old, changed_new): (Vec<_>, Vec<_>) = updated.iter()
            .filter(|(o, n)| o != n)
            .map(|(o, n)| (o.clone(), n.clone()))
            .unzip();
        if !changed_old.is_empty() {
            store.push_undo(EditEntry { created: changed_new, removed: changed_old });
            store.edits.redo.clear();
        }

        log::debug!("[cmd] store_update_tag merge {}→{} locs={} total={}ms", tag_id, target_id, affected.len(), _t.elapsed().as_millis());
        ChangeSet { updated, ..Default::default() }
    } else {
        if let Some(t) = store.tags.all.get_mut(&tag_id) {
            if let Some(n) = &name {
                let trimmed = n.trim();
                if !trimmed.is_empty() { t.name = trimmed.to_string(); }
            }
            if let Some(c) = &color { t.color = c.clone(); }
        }
        log::debug!("[cmd] store_update_tag patch tag={} total={}ms", tag_id, _t.elapsed().as_millis());
        ChangeSet::default()
    };

    store.tags.dirty = true;
    let mut result = store.finish_mutation(changeset);
    result.tags = Some(store.tags.all.clone());
    Ok(result)

    })
}

/// Strip tags from all locations. Tags stay in `store.tags` with count=0 /
/// visible=false so undo can revive them. Returns MutationResult with `tags`.
#[tauri::command]
#[specta::specta]
pub fn store_delete_tags(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    tag_ids: Vec<u32>,
) -> Result<MutationResult, String> {
    let _t = std::time::Instant::now();
    with_store!(webview, state, |store| {
        let tag_set: HashSet<u32> = tag_ids.iter().copied().collect();
        let view = store.loc_view();
        let mut affected_ids = HashSet::new();
        for &tid in &tag_set {
            affected_ids.extend(selections::resolve(&view, &SelectionProps::Tag { tag_id: tid }));
        }
        drop(view);

        let mut updated: Vec<(Location, Location)> = Vec::new();
        for &id in &affected_ids {
            if let Some(old) = store.get_loc_by_id(id) {
                let mut new_loc = old.clone();
                new_loc.tags.retain(|t| !tag_set.contains(t));
                updated.push((old, new_loc));
            }
        }
        let old_locs: Vec<Location> = updated.iter().map(|(o, _)| o.clone()).collect();
        store.remove_tag_counts(&old_locs);
        for (_, new_loc) in &updated {
            let patch = LocationPatch { tags: Some(new_loc.tags.clone()), ..Default::default() };
            store.overlay_update(new_loc.id, &patch);
        }
        let new_locs: Vec<Location> = updated.iter().map(|(_, n)| n.clone()).collect();
        store.add_tag_counts(&new_locs);
        let (changed_old, changed_new): (Vec<_>, Vec<_>) = updated.iter()
            .filter(|(o, n)| o != n)
            .map(|(o, n)| (o.clone(), n.clone()))
            .unzip();
        if !changed_old.is_empty() {
            store.push_undo(EditEntry { created: changed_new, removed: changed_old });
            store.edits.redo.clear();
        }

        log::debug!("[cmd] store_delete_tags n={} locs={} total={}ms", tag_set.len(), affected_ids.len(), _t.elapsed().as_millis());
        Ok(store.finish_mutation(ChangeSet { updated, ..Default::default() }))
    })
}

/// Set (or clear) the active location. Fire-and-forget from JS; no re-render triggered.
/// JS patches the cell buffer synchronously to hide/show the active marker.
#[tauri::command]
#[specta::specta]
pub fn store_set_active(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    id: Option<u32>,
) -> Result<(), String> {
    with_store!(webview, state, |store| {
        store.selections.active_id = id;
        Ok(())
    })
}

/// Fetch a single location by ID. Returns `None` if the ID is dead or doesn't exist.
#[tauri::command]
#[specta::specta]
pub fn store_get_location(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    id: u32,
) -> Result<Option<Location>, String> {
    with_store!(webview, state, |store| {
        Ok(store.get_loc_by_id(id))
    })
}


/// Fetch multiple locations by ID. Silently skips IDs that don't exist.
#[tauri::command]
#[specta::specta]
pub fn store_get_locations_by_ids(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    ids: Vec<u32>,
) -> Result<Vec<Location>, String> {
    with_store!(webview, state, |store| {
        let mut result = Vec::with_capacity(ids.len());
        for &id in &ids {
            if let Some(loc) = store.get_loc_by_id(id) {
                result.push(loc);
            }
        }
        Ok(result)
    })
}

/// Dump every alive location to a temp JSON file. Returns the file path.
/// Used by export and plugins that need the full dataset.
#[tauri::command]
#[specta::specta]
pub fn store_get_all_locations(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
) -> Result<String, String> {
    with_store!(webview, state, |store| {
        let locs = store.collect_all_locations();
        let map_id_str = store.map_id.as_deref().unwrap_or("default");
        let json = serde_json::to_vec(&locs).map_err(|e| e.to_string())?;
        let path = app.path().temp_dir().map_err(|e| e.to_string())?
            .join(format!("mma_all_{map_id_str}.json"));
        std::fs::write(&path, &json).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    })
}

/// Msgpack-serialized overlay state written to the `.delta` file on autosave.
/// On next `store_open_map`, the delta is merged into the Arrow file and deleted.
#[derive(serde::Serialize, serde::Deserialize)]
struct DeltaOverlay {
    adds: Vec<Location>,
    dead_ids: Vec<u32>,
    patches: Vec<Location>,
}

/// Delta-only autosave: writes only dirty geohash chunks to disk (~17ms).
/// Does NOT bake the overlay — call `store_bake_and_save` for a full merge.
#[tauri::command]
#[specta::specta]
pub async fn store_save_dirty(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
) -> Result<SaveResult, String> {
    let _t = std::time::Instant::now();
    log::debug!("[cmd] store_save_dirty ENTER");
    let (map_id, delta_data, alive, tags_json) = {
        let mut mgr = state.lock().map_err(|e| e.to_string())?;
    let store = mgr.store_for_window(webview.label())?;
        let map_id = store.map_id.clone().ok_or("no map open")?;
        if !store.overlay.dirty && !store.tags.dirty {
            return Ok(SaveResult { saved_chunks: 0 });
        }
        let delta_data = if store.overlay.dirty {
            let overlay = DeltaOverlay {
                adds: store.overlay.adds.clone(),
                dead_ids: store.overlay.dead.iter().cloned().collect(),
                patches: store.overlay.patches.values().cloned().collect(),
            };
            Some(rmp_serde::to_vec_named(&overlay).map_err(|e| e.to_string())?)
        } else {
            None
        };
        let tags_json = if store.tags.dirty {
            store.tags.dirty = false;
            Some(serialize_tags_json(&store.tags.all))
        } else {
            None
        };
        (map_id, delta_data, store.alive_count, tags_json)
    };

    let size = delta_data.as_ref().map_or(0, |d| d.len());
    let app2 = app.clone();
    let map_id2 = map_id.clone();
    tokio::task::spawn_blocking(move || {
        if let Some(delta_data) = delta_data {
            let path = fast_io::arrow_delta_path(&app2, &map_id2)?;
            fast_io::atomic_write(&path, |mut file| {
                use std::io::Write;
                file.write_all(&delta_data).map_err(|e| e.to_string())
            })?;
        }
        let conn = fast_io::open_db(&app2)?;
        conn.execute("UPDATE maps SET location_count = ?1 WHERE id = ?2",
            rusqlite::params![alive, &map_id2]).map_err(|e| e.to_string())?;
        if let Some(tags_json) = tags_json {
            conn.execute("UPDATE maps SET tags = ?1 WHERE id = ?2",
                rusqlite::params![tags_json, &map_id2]).map_err(|e| e.to_string())?;
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| e.to_string())??;

    log::debug!("[cmd] store_save_dirty total={}ms size={}", _t.elapsed().as_millis(), size);
    Ok(SaveResult { saved_chunks: size })
}

/// Lightweight status query: location count, version, and dirty flag.
#[tauri::command]
#[specta::specta]
pub fn store_get_summary(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
) -> Result<SummaryResult, String> {
    let _t = std::time::Instant::now();
    with_store!(webview, state, |store| {
        let count = store.alive_count;
        log::debug!("[cmd] store_get_summary total={}ms alive_count={}", _t.elapsed().as_millis(), count);
        Ok(SummaryResult {
            location_count: count,
            version: store.version,
            dirty_count: if store.overlay.dirty { 1 } else { 0 },
        })
    })
}

/// Persist undo/redo stacks to SQLite as msgpack blobs, capped at MAX_UNDO_ENTRIES.
fn save_edit_history_inner(app: &tauri::AppHandle, map_id: &str, undo: &[EditEntry], redo: &[EditEntry]) -> Result<(), String> {
    let conn = fast_io::open_db(app)?;
    let undo_capped = if undo.len() > MAX_UNDO_ENTRIES { &undo[undo.len() - MAX_UNDO_ENTRIES..] } else { undo };
    let redo_capped = if redo.len() > MAX_UNDO_ENTRIES { &redo[redo.len() - MAX_UNDO_ENTRIES..] } else { redo };
    let undo_bytes = rmp_serde::to_vec_named(undo_capped).map_err(|e| e.to_string())?;
    let redo_bytes = rmp_serde::to_vec_named(redo_capped).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO edit_history (map_id, undo_stack, redo_stack) VALUES (?1, ?2, ?3)",
        rusqlite::params![map_id, undo_bytes, redo_bytes],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Load undo/redo stacks from SQLite. Returns empty stacks if no history exists.
fn load_edit_history_inner(app: &tauri::AppHandle, map_id: &str) -> Result<(Vec<EditEntry>, Vec<EditEntry>), String> {
    let conn = fast_io::open_db(app)?;
    let result = conn.query_row(
        "SELECT undo_stack, redo_stack FROM edit_history WHERE map_id = ?1",
        [map_id],
        |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?)),
    );
    match result {
        Ok((undo_bytes, redo_bytes)) => {
            let undo: Vec<EditEntry> = rmp_serde::from_slice(&undo_bytes).unwrap_or_default();
            let redo: Vec<EditEntry> = rmp_serde::from_slice(&redo_bytes).unwrap_or_default();
            Ok((undo, redo))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok((Vec::new(), Vec::new())),
        Err(e) => Err(e.to_string()),
    }
}

/// Write the current batch to disk as Arrow IPC and remove any stale delta file.
fn save_arrow_inner(store: &Store, app: &tauri::AppHandle, map_id: &str) -> Result<(), String> {
    if let Some(ref batch) = store.batch {
        let path = fast_io::arrow_path(app, map_id)?;
        fast_io::write_arrow_ipc(&path, batch)?;
        let delta = fast_io::arrow_delta_path(app, map_id)?;
        let _ = std::fs::remove_file(delta);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// VCS: snapshot / restore Arrow files
// ---------------------------------------------------------------------------

/// Merge the overlay into the Arrow batch, then write the full file to disk.
/// Expensive at 10M+ rows — only called on commit, not on autosave.
#[tauri::command]
#[specta::specta]
pub fn store_bake_and_save(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
) -> Result<(), String> {
    with_store!(webview, state, |store| {
        let map_id = store.map_id.clone().ok_or("no map open")?;
        store.bake_overlay();
        store.mmap_handle = None;
        save_arrow_inner(&store, &app, &map_id)?;
        let path = fast_io::arrow_path(&app, &map_id)?;
        if path.exists() {
            let (batch, handle) = fast_io::read_arrow_ipc_mmap(&path)?;
            store.batch = Some(batch);
            store.mmap_handle = Some(handle);
        }
        let count = store.batch.as_ref().map_or(0, |b| b.num_rows());
        let conn = fast_io::open_db(&app)?;
        conn.execute("UPDATE maps SET location_count = ?1 WHERE id = ?2", rusqlite::params![count, map_id])
            .map_err(|e| e.to_string())?;
        if store.tags.dirty {
            write_tags_json(&conn, &map_id, &store.tags.all)?;
            store.tags.dirty = false;
        }
        Ok(())
    })
}

/// One geohash cell's content-addressed blob in a VCS commit.
/// The blob hash is a SHA-256 of the Arrow IPC bytes for that cell.
#[derive(Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitBlobEntry {
    pub geohash: String,
    pub blob_hash: String,
    pub location_count: u32,
}

/// Create a VCS snapshot: partition batch by geohash, write each cell as a content-addressed
/// blob. First commit writes all cells; subsequent commits only write dirty cells.
/// Returns the full manifest of blob entries for the commit record.
pub(crate) fn snapshot_inner(
    app: &tauri::AppHandle,
    state: &StoreState,
    map_id: &str,
) -> Result<Vec<CommitBlobEntry>, String> {
    let _t = std::time::Instant::now();
    let mut mgr = state.lock().map_err(|e| e.to_string())?;
    let store = mgr.store_for_map(map_id)?;
    let batch = store.batch.as_ref().ok_or("no data loaded")?;
    if batch.num_rows() == 0 {
        store.committed_blobs.clear();
        store.overlay.dirty_geohashes.clear();
        return Ok(Vec::new());
    }

    let first_commit = store.committed_blobs.is_empty();
    let dirty = &store.overlay.dirty_geohashes;
    let stale_count: u32 = store.committed_blobs.values().map(|(_, c)| c).sum();
    log::debug!("[snapshot] first_commit={} batch_rows={} committed_blobs_count={} stale_loc_count={}",
        first_commit, batch.num_rows(), store.committed_blobs.len(), stale_count);

    if first_commit {
        let lats = col_lat(batch);
        let lngs = col_lng(batch);
        let schema = batch.schema();

        let mut gh_indices: HashMap<String, Vec<u32>> = HashMap::new();
        for i in 0..batch.num_rows() {
            let gh = encode_geohash(lats.value(i), lngs.value(i));
            gh_indices.entry(gh).or_default().push(i as u32);
        }

        let mut entries = Vec::with_capacity(gh_indices.len());
        for (gh, indices) in &gh_indices {
            let take_idx = arrow::array::UInt32Array::from(indices.clone());
            let columns: Vec<ArrayRef> = batch.columns().iter().map(|col| {
                arrow::compute::take(col.as_ref(), &take_idx, None).unwrap()
            }).collect();
            let cell_batch = RecordBatch::try_new(schema.clone(), columns).unwrap();
            let (hash, count) = fast_io::write_blob(app, &cell_batch)
                .expect("blob write failed");
            entries.push(CommitBlobEntry {
                geohash: gh.clone(),
                blob_hash: hash,
                location_count: count as u32,
            });
        }

        store.committed_blobs = entries.iter()
            .map(|e| (e.geohash.clone(), (e.blob_hash.clone(), e.location_count)))
            .collect();
        store.overlay.dirty_geohashes.clear();
        log::debug!("[cmd] snapshot_inner (full) total={}ms cells={}", _t.elapsed().as_millis(), entries.len());
        Ok(entries)
    } else {
        let dirty_cells: Vec<String> = dirty.iter().cloned().collect();
        let schema = batch.schema();

        let mut dirty_entries = Vec::new();
        for gh in &dirty_cells {
            let indices: Vec<u32> = match store.geohash_index.get(gh) {
                Some(v) => v.iter().map(|&i| i as u32).collect(),
                None => continue,
            };
            if indices.is_empty() { continue; }
            let take_idx = arrow::array::UInt32Array::from(indices);
            let columns: Vec<ArrayRef> = batch.columns().iter().map(|col| {
                arrow::compute::take(col.as_ref(), &take_idx, None).unwrap()
            }).collect();
            let cell_batch = RecordBatch::try_new(schema.clone(), columns).unwrap();
            let (hash, count) = fast_io::write_blob(app, &cell_batch)
                .expect("blob write failed");
            dirty_entries.push(CommitBlobEntry {
                geohash: gh.clone(),
                blob_hash: hash,
                location_count: count as u32,
            });
        }

        for entry in &dirty_entries {
            store.committed_blobs.insert(
                entry.geohash.clone(),
                (entry.blob_hash.clone(), entry.location_count),
            );
        }
        for gh in &dirty_cells {
            if !store.geohash_index.contains_key(gh) {
                store.committed_blobs.remove(gh);
            }
        }
        store.overlay.dirty_geohashes.clear();

        let entries: Vec<CommitBlobEntry> = store.committed_blobs.iter()
            .map(|(gh, (hash, count))| CommitBlobEntry {
                geohash: gh.clone(),
                blob_hash: hash.clone(),
                location_count: *count,
            })
            .collect();

        log::debug!("[cmd] snapshot_inner (incremental) total={}ms dirty={} total_cells={}",
            _t.elapsed().as_millis(), dirty_cells.len(), entries.len());
        Ok(entries)
    }
}

/// Restore a VCS snapshot: read blobs in parallel, concatenate into a single batch,
/// and write the Arrow IPC file. The caller (`store_checkout_commit`) reopens the map.
pub(crate) fn restore_inner(
    app: &tauri::AppHandle,
    map_id: &str,
    blobs: Vec<CommitBlobEntry>,
) -> Result<(), String> {
    let _t = std::time::Instant::now();
    let s = schema();
    let batches: Result<Vec<RecordBatch>, String> = blobs
        .par_iter()
        .map(|entry| fast_io::read_blob(app, &entry.blob_hash))
        .collect();
    let batches = batches?;
    let batch = if batches.is_empty() {
        RecordBatch::new_empty(s)
    } else {
        concat_batches(&s, &batches).map_err(|e| e.to_string())?
    };
    let path = fast_io::arrow_path(app, map_id)?;
    fast_io::write_arrow_ipc(&path, &batch)?;
    let delta = fast_io::arrow_delta_path(app, map_id)?;
    let _ = std::fs::remove_file(delta);
    log::debug!("[cmd] restore_inner total={}ms rows={}", _t.elapsed().as_millis(), batch.num_rows());
    Ok(())
}

// ---------------------------------------------------------------------------
// Render buffer
// ---------------------------------------------------------------------------

/// Parameters for a full render rebuild. `marker_style` ("arrow" or "pin") determines
/// whether heading angles are written. The bounding box fields are currently unused
/// (no viewport culling -- all locations are rendered).
#[derive(Default, serde::Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct RenderRequest {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
    pub selected_ids: Option<Vec<u32>>,
    pub marker_style: String,
}

/// Build the full render binary: single linear pass over all alive locations, partitioned into
/// 32 geohash cells. Also rebuilds render_cells index and selection overlay. O(N).
fn build_cell_render_buffers(store: &mut Store, req: &RenderRequest) -> Vec<u8> {
    let _t = std::time::Instant::now();
    let b = match &store.batch {
        Some(b) => b,
        None if store.overlay.adds.is_empty() => return Vec::new(),
        None => {
            let empty = arrow_bridge::locations_to_batch(&[]);
            store.batch = Some(empty);
            store.batch.as_ref().unwrap()
        }
    };
    let batch_n = b.num_rows();
    let lats = col_lat(b);
    let lngs = col_lng(b);
    let ids_col = col_id(b);
    let headings = col_heading(b);
    let has_dead = !store.overlay.dead.is_empty();
    let has_patches = !store.overlay.patches.is_empty();

    let selected_set: &RoaringBitmap = &store.selections.ids;
    let active_id = store.selections.active_id;
    let arrow_style = req.marker_style == "arrow";

    // 32 cells indexed by render_cell_idx (0-31)
    struct CellOut { ids: Vec<u32>, positions: Vec<f32>, colors: Vec<u8>, angles: Vec<f32> }
    const NONE: Option<CellOut> = None;
    let mut cells: [Option<CellOut>; 32] = [NONE; 32];

    // Selection overlay: selected entries rendered as a separate colored layer
    struct SelOverlay { ids: Vec<u32>, positions: Vec<f32>, colors: Vec<u8>, angles: Vec<f32> }
    let mut sel_ov = SelOverlay { ids: Vec::new(), positions: Vec::new(), colors: Vec::new(), angles: Vec::new() };

    // Single linear pass over batch rows (cache-friendly)
    for i in 0..batch_n {
        let id = ids_col.value(i);
        if has_dead && store.overlay.dead.contains(&id) { continue; }
        let (lat, lng, heading) = if has_patches {
            if let Some(p) = store.overlay.patches.get(&id) {
                (p.lat, p.lng, p.heading)
            } else {
                (lats.value(i), lngs.value(i), headings.value(i))
            }
        } else {
            (lats.value(i), lngs.value(i), headings.value(i))
        };
        let ci = render_cell_idx(lat, lng) as usize;
        let out = cells[ci].get_or_insert_with(|| CellOut {
            ids: Vec::new(), positions: Vec::new(), colors: Vec::new(), angles: Vec::new(),
        });
        out.positions.push(lng as f32);
        out.positions.push(lat as f32);
        let angle = if arrow_style { 180.0 - heading as f32 } else { 0.0 };
        let is_hidden = selected_set.contains(id) || active_id == Some(id);
        if is_hidden { out.colors.extend_from_slice(&[0, 0, 0, 0]); }
        else { out.colors.extend_from_slice(&[42, 42, 42, 255]); }
        out.angles.push(angle);
        out.ids.push(id);
        if let Some([r, g, b]) = store.selections.color_for(id) {
            sel_ov.positions.push(lng as f32);
            sel_ov.positions.push(lat as f32);
            sel_ov.colors.extend_from_slice(&[r, g, b, 255]);
            sel_ov.angles.push(angle);
            sel_ov.ids.push(id);
        }
    }
    // Overlay adds
    for loc in &store.overlay.adds {
        let ci = render_cell_idx(loc.lat, loc.lng) as usize;
        let out = cells[ci].get_or_insert_with(|| CellOut {
            ids: Vec::new(), positions: Vec::new(), colors: Vec::new(), angles: Vec::new(),
        });
        let id = loc.id;
        let is_hidden = selected_set.contains(id) || active_id == Some(id);
        out.positions.push(loc.lng as f32);
        out.positions.push(loc.lat as f32);
        let angle = if arrow_style { 180.0 - loc.heading as f32 } else { 0.0 };
        if is_hidden { out.colors.extend_from_slice(&[0, 0, 0, 0]); }
        else { out.colors.extend_from_slice(&[42, 42, 42, 255]); }
        out.angles.push(angle);
        out.ids.push(id);
        if let Some([r, g, b]) = store.selections.color_for(id) {
            sel_ov.positions.push(loc.lng as f32);
            sel_ov.positions.push(loc.lat as f32);
            sel_ov.colors.extend_from_slice(&[r, g, b, 255]);
            sel_ov.angles.push(angle);
            sel_ov.ids.push(id);
        }
    }

    // Rebuild per-cell render tracking
    store.render.cells = [const { None }; 32];
    store.render.id_to_cell_idx.clear();
    let mut total_count = 0usize;
    let mut non_empty = 0u32;
    for ci in 0..32 {
        let out = match &cells[ci] { Some(o) => o, None => continue };
        let mut cr = CellRender { id_order: Vec::with_capacity(out.ids.len()), id_to_index: HashMap::new() };
        for (i, &id) in out.ids.iter().enumerate() {
            cr.id_to_index.insert(id, i);
            cr.id_order.push(id);
            store.ensure_id_to_cell_capacity(id);
            store.render.id_to_cell_idx[id as usize] = ci as u8;
        }
        total_count += out.ids.len();
        non_empty += 1;
        store.render.cells[ci] = Some(cr);
    }

    // Serialize: u32 cell_count, per cell: [1 byte geohash char][u32 count][positions][colors][angles]
    let mut buf = Vec::new();
    buf.extend_from_slice(&non_empty.to_le_bytes());
    for ci in 0..32 {
        let out = match &cells[ci] { Some(o) => o, None => continue };
        let count = out.ids.len() as u32;
        buf.push(BASE32[ci]);
        buf.extend_from_slice(&count.to_le_bytes());
        for &id in &out.ids { buf.extend_from_slice(&id.to_le_bytes()); }
        for &v in &out.positions { buf.extend_from_slice(&v.to_le_bytes()); }
        buf.extend_from_slice(&out.colors);
        for &v in &out.angles { buf.extend_from_slice(&v.to_le_bytes()); }
    }

    // Selection overlay: [u32 count][f32[] positions][u8[] colors][f32[] angles][u32[] ids]
    let sel_count = sel_ov.ids.len() as u32;
    buf.extend_from_slice(&sel_count.to_le_bytes());
    if sel_count > 0 {
        for &v in &sel_ov.positions { buf.extend_from_slice(&v.to_le_bytes()); }
        buf.extend_from_slice(&sel_ov.colors);
        for &v in &sel_ov.angles { buf.extend_from_slice(&v.to_le_bytes()); }
        for &id in &sel_ov.ids { buf.extend_from_slice(&id.to_le_bytes()); }
    }

    log::debug!("[cmd] build_cell_render_buffers total={}ms cells={} points={} sel_overlay={} bytes={}",
        _t.elapsed().as_millis(), non_empty, total_count, sel_count, buf.len());
    buf
}

/// Full render rebuild: single-pass over all alive locations, writes binary to a temp file.
/// Returns the file path for JS to fetch via `mma-buf://`. Only called on map open or full reset.
#[tauri::command]
#[specta::specta]
pub async fn store_fill_render_file(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    req: RenderRequest,
) -> Result<String, String> {
    log::debug!("[cmd] store_fill_render_file ENTER");
    let (buf, map_id_str) = {
        let mut mgr = state.lock().map_err(|e| e.to_string())?;
        let store = mgr.store_for_window(webview.label())?;
        store.render.arrow_style = req.marker_style == "arrow";
        let mid = store.map_id.clone().unwrap_or_default();
        (build_cell_render_buffers(store, &req), mid)
    };
    let path = app.path().temp_dir().map_err(|e| e.to_string())?
        .join(format!("mma_render_{map_id_str}.bin"));
    tokio::task::spawn_blocking(move || {
        std::fs::write(&path, &buf).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Resolve a deck.gl pick result (cell key + index within cell) to a location ID.
/// Called on marker click to map the GPU pick back to a logical location.
#[tauri::command]
#[specta::specta]
pub fn store_resolve_pick(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    cell: String,
    cell_index: u32,
) -> Result<Option<u32>, String> {
    with_store!(webview, state, |store| {
        let ci = cell_idx_from_key(&cell).ok_or("invalid cell key")?;
        Ok(store.render.cells[ci as usize].as_ref()
            .and_then(|cr| cr.id_order.get(cell_index as usize).copied()))
    })
}

// ---------------------------------------------------------------------------
// Undo / Redo
// ---------------------------------------------------------------------------

/// Pop the undo stack and reverse the last edit. Pushes the entry onto the redo stack.
#[tauri::command]
#[specta::specta]
pub fn store_undo(webview: tauri::Webview, state: tauri::State<'_, StoreState>) -> Result<MutationResult, String> {
    with_store!(webview, state, |store| {
        let _t = std::time::Instant::now();
        let entry = store.edits.undo.pop().ok_or("nothing to undo")?;
        log::debug!("[UNDO] stack_depth={} created={} removed={}",
            store.edits.undo.len(), entry.created.len(), entry.removed.len());
        let changes = apply_edit_reverse(store, &entry);
        log::debug!("[UNDO] apply_edit={}ms changes: +{} ~{} -{}", _t.elapsed().as_millis(), changes.added.len(), changes.updated.len(), changes.removed.len());
        store.edits.redo.push(entry);
        Ok(store.finish_mutation(changes))
    })
}

/// Pop the redo stack and replay the edit forward. Pushes the entry back onto undo.
#[tauri::command]
#[specta::specta]
pub fn store_redo(webview: tauri::Webview, state: tauri::State<'_, StoreState>) -> Result<MutationResult, String> {
    with_store!(webview, state, |store| {
        let _t = std::time::Instant::now();
        let entry = store.edits.redo.pop().ok_or("nothing to redo")?;
        log::debug!("[REDO] stack_depth={} created={} removed={}",
            store.edits.redo.len(), entry.created.len(), entry.removed.len());
        let changes = apply_edit_forward(store, &entry);
        log::debug!("[REDO] apply_edit={}ms changes: +{} ~{} -{}", _t.elapsed().as_millis(), changes.added.len(), changes.updated.len(), changes.removed.len());
        store.push_undo(entry);
        Ok(store.finish_mutation(changes))
    })
}

/// Compute the net diff since last commit by walking the undo stack.
/// Returns (added, removed, modified) counts for the commit dialog.
#[tauri::command]
#[specta::specta]
pub fn store_commit_diff(webview: tauri::Webview, state: tauri::State<'_, StoreState>) -> Result<(u32, u32, u32), String> {
    with_store!(webview, state, |store| {
        let mut added = HashSet::new();
        let mut removed = HashSet::new();
        let mut modified = HashSet::new();
        for entry in &store.edits.undo {
            for loc in &entry.removed {
                if added.remove(&loc.id) { modified.remove(&loc.id); }
                else { removed.insert(&loc.id); }
            }
            for loc in &entry.created {
                if removed.remove(&loc.id) { modified.insert(&loc.id); }
                else if !added.contains(&loc.id) && !modified.contains(&loc.id) { added.insert(&loc.id); }
            }
        }
        Ok((added.len() as u32, removed.len() as u32, modified.len() as u32))
    })
}

/// Clear both undo and redo stacks. Called after a commit to start fresh.
#[tauri::command]
#[specta::specta]
pub fn store_reset_undo(webview: tauri::Webview, state: tauri::State<'_, StoreState>) -> Result<(), String> {
    with_store!(webview, state, |store| {
        store.edits.undo.clear();
        store.edits.redo.clear();
        Ok(())
    })
}

/// Core edit primitive: atomically remove then create locations, updating tags, overlay, and
/// render cells. Undo/redo swap the arguments. O(R + C) where R = removed, C = created.
fn apply_edit(store: &mut Store, remove: &[Location], create: &[Location]) -> ChangeSet {
    let t0 = std::time::Instant::now();
    let create_ids: HashSet<u32> = create.iter().map(|l| l.id).collect();
    let remove_by_id: HashMap<u32, &Location> = remove.iter().map(|l| (l.id, l)).collect();

    store.remove_tag_counts(remove);
    store.overlay_remove(remove);
    store.add_tag_counts(create);
    for loc in create {
        store.overlay_add(loc.clone());
    }

    // Categorize: same-id remove+create is an update; the rest are pure add/remove.
    let mut changes = ChangeSet::default();
    for loc in remove {
        if !create_ids.contains(&loc.id) {
            changes.removed.push(loc.id);
        }
    }
    for loc in create {
        if let Some(old) = remove_by_id.get(&loc.id) {
            changes.updated.push(((*old).clone(), loc.clone()));
        } else {
            changes.added.push(loc.clone());
        }
    }

    log::debug!("[apply_edit] +{} ~{} -{} in {}ms",
        changes.added.len(), changes.updated.len(), changes.removed.len(), t0.elapsed().as_millis());
    changes
}

/// Replay an edit forward: remove `entry.removed`, create `entry.created`.
fn apply_edit_forward(store: &mut Store, entry: &EditEntry) -> ChangeSet {
    apply_edit(store, &entry.removed, &entry.created)
}

/// Reverse an edit: remove `entry.created`, restore `entry.removed`.
fn apply_edit_reverse(store: &mut Store, entry: &EditEntry) -> ChangeSet {
    apply_edit(store, &entry.created, &entry.removed)
}

// ---------------------------------------------------------------------------
// Query commands
// ---------------------------------------------------------------------------

/// Load tags from the SQLite `maps.tags` JSON column, keyed by string ID.
pub(crate) fn read_tags_json(conn: &rusqlite::Connection, map_id: &str) -> HashMap<u32, Tag> {
    let json: String = conn.query_row(
        "SELECT tags FROM maps WHERE id = ?1", [map_id], |row| row.get(0),
    ).unwrap_or_else(|_| "{}".into());
    let raw: HashMap<String, Tag> = serde_json::from_str(&json).unwrap_or_default();
    raw.into_iter().filter_map(|(k, v)| k.parse::<u32>().ok().map(|id| (id, v))).collect()
}

/// Serialize tags to JSON with string keys (SQLite stores them this way).
fn serialize_tags_json(tags: &HashMap<u32, Tag>) -> String {
    let as_str_keys: HashMap<String, &Tag> = tags.iter().map(|(k, v)| (k.to_string(), v)).collect();
    serde_json::to_string(&as_str_keys).unwrap_or_default()
}

/// Persist tags to the SQLite `maps.tags` JSON column.
pub(crate) fn write_tags_json(conn: &rusqlite::Connection, map_id: &str, tags: &HashMap<u32, Tag>) -> Result<(), String> {
    let json = serialize_tags_json(tags);
    conn.execute("UPDATE maps SET tags = ?1 WHERE id = ?2", rusqlite::params![json, map_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Create tags by name. Deduplicates case-insensitively: if a tag with the same name
/// already exists, it is made visible instead of creating a duplicate.
#[tauri::command]
#[specta::specta]
pub fn store_create_tags(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    names: Vec<String>,
) -> Result<MutationResult, String> {
    with_store!(webview, state, |store| {
        let mut name_to_id: HashMap<String, u32> = HashMap::new();
        for (&id, entry) in &store.tags.all {
            name_to_id.insert(entry.name.to_lowercase(), id);
        }

        for name in &names {
            if let Some(&id) = name_to_id.get(&name.to_lowercase()) {
                let tag = store.tags.all.get_mut(&id).unwrap();
                if !tag.visible {
                    tag.visible = true;
                }
            } else {
                let id = store.alloc_tag_id();
                let color = util::color_for_name(name);
                let order = Some(store.tags.all.len() as u32);
                let tag = Tag { id, name: name.clone(), color, visible: true, order, count: 0 };
                store.tags.all.insert(id, tag.clone());
                name_to_id.insert(name.to_lowercase(), id);
            }
        }

        if !names.is_empty() {
            store.tags.dirty = true;
        }

        Ok(MutationResult {
            status: store.store_status(),
            delta: RenderDelta::default(),
            selection_sync: None,
            new_field_keys: None,
            tags: Some(store.tags.all.clone()),
        })
    })
}

/// Persist tag ordering. `ordered_ids` specifies the desired order; each tag's
/// `order` field is set to its index in the list.
#[tauri::command]
#[specta::specta]
pub fn store_reorder_tags(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    ordered_ids: Vec<u32>,
) -> Result<MutationResult, String> {
    with_store!(webview, state, |store| {
        for (i, &id) in ordered_ids.iter().enumerate() {
            if let Some(tag) = store.tags.all.get_mut(&id) {
                tag.order = Some(i as u32);
            }
        }
        store.tags.dirty = true;
        Ok(MutationResult {
            status: store.store_status(),
            delta: RenderDelta::default(),
            selection_sync: None,
            new_field_keys: None,
            tags: Some(store.tags.all.clone()),
        })
    })
}

/// Compute the bounding box [west, south, east, north] of all alive locations. O(N).
#[tauri::command]
#[specta::specta]
pub fn store_bounds(webview: tauri::Webview, state: tauri::State<'_, StoreState>) -> Result<Option<[f64; 4]>, String> {
    let _t = std::time::Instant::now();
    with_store!(webview, state, |store| {
        if store.batch.is_none() && store.overlay.adds.is_empty() { return Ok(None); }

        let (mut w, mut s, mut e, mut n) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        let mut count = 0usize;

        if let Some(ref b) = store.batch {
            let lats = col_lat(b);
            let lngs = col_lng(b);
            let ids = col_id(b);
            for i in 0..b.num_rows() {
                let id = ids.value(i);
                if store.overlay.dead.contains(&id) { continue; }
                let (lat, lng) = if let Some(p) = store.overlay.patches.get(&id) {
                    (p.lat, p.lng)
                } else {
                    (lats.value(i), lngs.value(i))
                };
                if lng < w { w = lng; }
                if lat < s { s = lat; }
                if lng > e { e = lng; }
                if lat > n { n = lat; }
                count += 1;
            }
        }
        for loc in &store.overlay.adds {
            if loc.lng < w { w = loc.lng; }
            if loc.lat < s { s = loc.lat; }
            if loc.lng > e { e = loc.lng; }
            if loc.lat > n { n = loc.lat; }
            count += 1;
        }

        log::debug!("[cmd] store_bounds total={}ms count={}", _t.elapsed().as_millis(), count);
        if count == 0 { Ok(None) } else { Ok(Some([w, s, e, n])) }
    })
}

/// Compute the bounding box of currently selected locations only. O(N).
#[tauri::command]
#[specta::specta]
pub fn store_selection_bounds(webview: tauri::Webview, state: tauri::State<'_, StoreState>) -> Result<Option<[f64; 4]>, String> {
    with_store!(webview, state, |store| {
        if store.selections.ids.is_empty() { return Ok(None); }

        let (mut w, mut s, mut e, mut n) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        let mut count = 0usize;

        if let Some(ref b) = store.batch {
            let lats = col_lat(b);
            let lngs = col_lng(b);
            let ids = col_id(b);
            for i in 0..b.num_rows() {
                let id = ids.value(i);
                if !store.selections.ids.contains(id) { continue; }
                if store.overlay.dead.contains(&id) { continue; }
                let (lat, lng) = if let Some(p) = store.overlay.patches.get(&id) {
                    (p.lat, p.lng)
                } else {
                    (lats.value(i), lngs.value(i))
                };
                if lng < w { w = lng; }
                if lat < s { s = lat; }
                if lng > e { e = lng; }
                if lat > n { n = lat; }
                count += 1;
            }
        }
        for loc in &store.overlay.adds {
            if !store.selections.ids.contains(loc.id) { continue; }
            if loc.lng < w { w = loc.lng; }
            if loc.lat < s { s = loc.lat; }
            if loc.lng > e { e = loc.lng; }
            if loc.lat > n { n = loc.lat; }
            count += 1;
        }

        log::debug!("[cmd] store_selection_bounds total count={}", count);
        if count == 0 { Ok(None) } else { Ok(Some([w, s, e, n])) }
    })
}

/// Return the number of alive locations (batch + adds - dead).
#[tauri::command]
#[specta::specta]
pub fn store_location_count(webview: tauri::Webview, state: tauri::State<'_, StoreState>) -> Result<u32, String> {
    with_store!(webview, state, |store| {
        Ok(store.alive_count as u32)
    })
}


/// Collect all distinct values for an `extra` field across all alive locations. O(N).
/// Used by the filter UI to populate dropdown options.
#[tauri::command]
#[specta::specta]
pub fn store_extra_field_values(webview: tauri::Webview, state: tauri::State<'_, StoreState>, field: String) -> Result<Vec<String>, String> {
    let _t = std::time::Instant::now();
    with_store!(webview, state, |store| {
    let mut seen = std::collections::BTreeSet::new();

    let mut scan_extra_json = |json_str: &str| {
        if let Ok(map) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(json_str) {
            if let Some(v) = map.get(&field) {
                let s = match v {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                seen.insert(s);
            }
        }
    };

    if let Some(ref b) = store.batch {
        let ids = col_id(b);
        let extras = col_extra(b);
        for i in 0..b.num_rows() {
            let id = ids.value(i);
            if store.overlay.dead.contains(&id) { continue; }
            if store.overlay.patches.contains_key(&id) { continue; }
            if !extras.is_null(i) {
                scan_extra_json(extras.value(i));
            }
        }
    }
    for loc in store.overlay.patches.values() {
        if let Some(ref extra) = loc.extra {
            if let Some(v) = extra.get(&field) {
                let s = match v {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                seen.insert(s);
            }
        }
    }
    for loc in &store.overlay.adds {
        if let Some(ref extra) = loc.extra {
            if let Some(v) = extra.get(&field) {
                let s = match v {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                seen.insert(s);
            }
        }
    }

    log::debug!("[cmd] store_extra_field_values field={} total={}ms", field, _t.elapsed().as_millis());
    Ok(seen.into_iter().collect())

    })
}

// ---------------------------------------------------------------------------
// Selections
// ---------------------------------------------------------------------------

/// Input for `store_sync_selections`: selection criteria + display color.
#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SelectionInput {
    pub props: SelectionProps,
    pub color: [u8; 3],
}

/// Result of `store_sync_selections`: per-selection counts and the bitmask patch file path.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncSelectionsResult {
    pub counts: Vec<usize>,
    pub patch_file: Option<String>,
    pub selected_count: usize,
}

/// Replace all selections, resolve bitmasks against current data, and write a binary
/// patch file for JS to apply to the render overlay. Returns per-selection counts.
#[tauri::command]
#[specta::specta]
pub async fn store_sync_selections(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    sels: Vec<SelectionInput>,
) -> Result<SyncSelectionsResult, String> {
    let _t = std::time::Instant::now();
    let (counts, buf, selected_count, num_cells, map_id_str) = {
        let mut mgr = state.lock().map_err(|e| e.to_string())?;
    let store = mgr.store_for_window(webview.label())?;
    let map_id_str = store.map_id.clone().unwrap_or_default();

        let num_sels = sels.len();

        // 1. Resolve bitmasks (parallel via rayon inside resolve_bitmask)
        let view = store.loc_view();
        let masks: Vec<Vec<bool>> = sels.iter()
            .map(|sel| selections::resolve_bitmask(&view, &sel.props))
            .collect();

        // 2. Build one Roaring bitmap per selection from its mask. Batch ids are
        // ascending (sorted-id invariant) so the bitmaps fill sequentially.
        let batch_rows = view.batch_rows();
        let sel_sets: Vec<RoaringBitmap> = (0..num_sels).into_par_iter().map(|si| {
            let mask = &masks[si];
            let mut bm = RoaringBitmap::new();
            for i in 0..batch_rows {
                if mask[i] && view.is_alive(i) {
                    bm.insert(view.id_at(i));
                }
            }
            for (j, loc) in view.adds().iter().enumerate() {
                if mask[batch_rows + j] {
                    bm.insert(loc.id);
                }
            }
            bm
        }).collect();
        drop(view);

        let mut all_selected = RoaringBitmap::new();
        for s in &sel_sets { all_selected |= s; }

        let counts: Vec<usize> = sel_sets.iter().map(|s| s.len() as usize).collect();
        let selected_count = all_selected.len() as usize;

        // 3. Serialize the per-cell bitmask binary. Cells are independent → parallel.
        let segments: Vec<Vec<u8>> = store.render.cells.par_iter().enumerate()
            .filter_map(|(ci, opt)| {
                let cr = opt.as_ref()?;
                Some(serialize_cell_bitmask(ci, cr, &sel_sets))
            })
            .collect();
        let num_cells = segments.len();

        let mut buf: Vec<u8> = Vec::new();
        buf.push(num_sels as u8);
        for sel in &sels {
            buf.extend_from_slice(&sel.color);
        }
        buf.push(num_cells as u8);
        for seg in &segments {
            buf.extend_from_slice(seg);
        }

        store.selections.ids = all_selected;
        store.selections.all = sels.iter().enumerate().map(|(i, sel)| {
            selections::Selection {
                key: format!("sync:{i}"),
                color: sel.color,
                props: sel.props.clone(),
                count: None,
            }
        }).collect();
        store.selections.loc_sets = sel_sets;
        store.selections.version += 1;

        let render_total: usize = store.render.cells.iter().filter_map(|o| o.as_ref()).map(|cr| cr.id_order.len()).sum();
        log::debug!("[cmd] store_sync_selections total={}ms sels={} selected={} cells={} buf_size={} batch_rows={} overlay_adds={} dead={} alive={} render_total={} mask_len={} counts={:?}",
            _t.elapsed().as_millis(), sels.len(), selected_count, num_cells, buf.len(),
            store.batch.as_ref().map_or(0, |b| b.num_rows()), store.overlay.adds.len(),
            store.overlay.dead.len(), store.alive_count, render_total,
            masks.first().map_or(0, |m| m.len()), counts);

        (counts, buf, selected_count, num_cells, map_id_str)
    };

    let patch_file = if num_cells > 0 {
        let path = app.path().temp_dir().map_err(|e| e.to_string())?
            .join(format!("mma_sel_{map_id_str}.bin"));
        let p = path.clone();
        tokio::task::spawn_blocking(move || {
            std::fs::write(&p, &buf).map_err(|e| e.to_string())
        }).await.map_err(|e| e.to_string())??;
        Some(path.to_string_lossy().into_owned())
    } else {
        None
    };

    Ok(SyncSelectionsResult { counts, patch_file, selected_count })
}

/// Return the union of all currently selected location IDs.
#[tauri::command]
#[specta::specta]
pub fn store_get_selected_ids_list(webview: tauri::Webview, state: tauri::State<'_, StoreState>) -> Result<Vec<u32>, String> {
    with_store!(webview, state, |store| {
        Ok(store.selections.ids.iter().collect())
    })
}

/// Resolve a single selection to its matching location IDs without persisting it.
/// Used by plugins and one-off queries (e.g., tag merge, export filtered).
#[tauri::command]
#[specta::specta]
pub fn store_resolve_selection(webview: tauri::Webview, state: tauri::State<'_, StoreState>, props: SelectionProps) -> Result<Vec<u32>, String> {
    with_store!(webview, state, |store| {
        let view = store.loc_view();
        Ok(selections::resolve(&view, &props))
    })
}

/// Find all locations within `radius_m` metres of (`lat`, `lng`).
///
/// O(n) linear scan with a cheap bounding-box pre-filter (degree margin)
/// that rejects 99.9%+ of points before haversine is called.
/// At 1M locations this is sub-millisecond on a modern CPU.
///
// TODO: if this becomes a bottleneck, consider a persistent spatial index (R-tree or k-d tree)
#[tauri::command]
#[specta::specta]
pub fn store_find_nearby(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    lat: f64,
    lng: f64,
    radius_m: f64,
) -> Result<Vec<Location>, String> {
    with_store!(webview, state, |store| {
    let deg_margin = radius_m / 111_000.0 * 1.5;
    let mut result = Vec::new();

    if let Some(ref b) = store.batch {
        let lats = b.column_by_name("lat").and_then(|c| c.as_any().downcast_ref::<Float64Array>());
        let lngs = b.column_by_name("lng").and_then(|c| c.as_any().downcast_ref::<Float64Array>());
        let ids = b.column_by_name("id").and_then(|c| c.as_any().downcast_ref::<UInt32Array>());
        if let (Some(lats), Some(lngs), Some(ids)) = (lats, lngs, ids) {
            for i in 0..b.num_rows() {
                let id = ids.value(i);
                if store.overlay.dead.contains(&id) { continue; }
                if let Some(patched) = store.overlay.patches.get(&id) {
                    if (patched.lat - lat).abs() <= deg_margin
                        && (patched.lng - lng).abs() <= deg_margin
                        && selections::haversine_m(lat, lng, patched.lat, patched.lng) <= radius_m
                    {
                        result.push(patched.clone());
                    }
                } else {
                    let rlat = lats.value(i);
                    let rlng = lngs.value(i);
                    if (rlat - lat).abs() <= deg_margin
                        && (rlng - lng).abs() <= deg_margin
                        && selections::haversine_m(lat, lng, rlat, rlng) <= radius_m
                    {
                        result.push(arrow_bridge::row_to_location(b, i));
                    }
                }
            }
        }
    }

    for loc in &store.overlay.adds {
        if (loc.lat - lat).abs() <= deg_margin
            && (loc.lng - lng).abs() <= deg_margin
            && selections::haversine_m(lat, lng, loc.lat, loc.lng) <= radius_m
        {
            result.push(loc.clone());
        }
    }

    Ok(result)
    })
}

// ---------------------------------------------------------------------------
// Selection commands
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "location_store.test.rs"]
mod tests;
