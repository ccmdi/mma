//! Core data engine: immutable Arrow RecordBatch base + in-memory overlay for mutations.
//!
//! All location data lives here. The overlay (adds, patches, dead set) accumulates mutations
//! between saves; `bake_overlay` merges them back into the batch. IDs are kept strictly sorted
//! in the batch to enable O(log n) lookups via `batch_row_for_id`. Render cells (32 geohash-1
//! buckets) and selection bitmasks are derived from the same `ChangeSet` via `finish_mutation`.

use crate::types::{AppError, AppResult};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use roaring::RoaringBitmap;

use arrow_array::RecordBatch;
use arrow_schema::SchemaRef;
use rayon::prelude::*;

use crate::arrow_bridge;
use crate::arrow_bridge::{col_heading, col_id, col_lat, col_lng};
use crate::map_meta;
use crate::selections::{self, Selection, SelectionProps};
use crate::spatial;
use crate::storage;
use crate::types::{Location, LocationFlags, Tag};
use crate::util;

const MAX_UNDO_ENTRIES: usize = 1000;
/// Standard base-32 alphabet (Gustavo Niemeyer geohash variant); render cells are
/// keyed by its first character.
const BASE32: &[u8] = b"0123456789bcdefghjkmnpqrstuvwxyz";

/// Compute the render cell index (0-31) directly from coordinates. This is the
/// first base-32 character of the point's geohash, computed without allocating.
pub(crate) fn render_cell_idx(lat: f64, lng: f64) -> u8 {
    let (mut min_lat, mut max_lat) = (-90.0, 90.0);
    let (mut min_lng, mut max_lng) = (-180.0, 180.0);
    let mut ch: u8 = 0;
    let mut even = true;
    for _ in 0..5 {
        if even {
            let mid = (min_lng + max_lng) / 2.0;
            if lng >= mid {
                ch = (ch << 1) | 1;
                min_lng = mid;
            } else {
                ch <<= 1;
                max_lng = mid;
            }
        } else {
            let mid = (min_lat + max_lat) / 2.0;
            if lat >= mid {
                ch = (ch << 1) | 1;
                min_lat = mid;
            } else {
                ch <<= 1;
                max_lat = mid;
            }
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

/// Assemble the selection-bitmask wire buffer shared by sync/delta/rebuild:
/// `[numSels: u32 le][numSels * RGB][numCells: u8][segments...]`.
/// The count is u32 so thousands of selections (e.g. shift-selecting many tags)
/// don't wrap the header and desync the JS parser.
fn assemble_selection_bitmask<'a>(
    colors: impl ExactSizeIterator<Item = &'a [u8; 3]>,
    segments: &[Vec<u8>],
) -> Vec<u8> {
    let mut buf: Vec<u8> = Vec::new();
    buf.extend_from_slice(&(colors.len() as u32).to_le_bytes());
    for c in colors {
        buf.extend_from_slice(c);
    }
    buf.push(segments.len() as u8);
    for seg in segments {
        buf.extend_from_slice(seg);
    }
    buf
}

/// Route one selection's id-set to per-cell local render indices. Adaptive so the cost
/// is O(min(set size, render size in scope)) rather than O(render size) per selection:
/// sparse sets walk their members and probe `id_to_cell_idx`/`id_to_index`; dense sets
/// (where member-walking would do the same work anyway) scan the cell arrays directly.
/// `affected` limits the scope to those cells (delta path); `None` = all cells.
fn selection_cell_indices(
    render: &RenderState,
    set: &RoaringBitmap,
    affected: Option<&HashSet<u8>>,
) -> [Vec<u32>; 32] {
    let mut out: [Vec<u32>; 32] = std::array::from_fn(|_| Vec::new());
    let in_scope = |ci: u8| affected.map_or(true, |a| a.contains(&ci));
    let scope_size: usize = render
        .cells
        .iter()
        .enumerate()
        .filter(|(ci, _)| in_scope(*ci as u8))
        .filter_map(|(_, o)| o.as_ref())
        .map(|cr| cr.id_order.len())
        .sum();
    if (set.len() as usize) <= scope_size {
        for id in set {
            let Some(&ci) = render.id_to_cell_idx.get(id as usize) else {
                continue;
            };
            if ci == 255 || !in_scope(ci) {
                continue;
            }
            let Some(cr) = render.cells[ci as usize].as_ref() else {
                continue;
            };
            if let Some(&li) = cr.id_to_index.get(&id) {
                out[ci as usize].push(li as u32);
            }
        }
        for v in &mut out {
            v.sort_unstable();
        }
    } else {
        for (ci, opt) in render.cells.iter().enumerate() {
            if !in_scope(ci as u8) {
                continue;
            }
            let Some(cr) = opt.as_ref() else { continue };
            for (li, &id) in cr.id_order.iter().enumerate() {
                if set.contains(id) {
                    out[ci].push(li as u32);
                }
            }
        }
    }
    out
}

/// Serialize one render cell's segment from pre-routed per-selection indices:
/// `[cellChar:1][locCount:u32 le][ per selection: fmt byte + payload ]`.
/// Pure/read-only, so the 32 cells can be serialized in parallel.
fn serialize_cell_segment(ci: usize, cr: &CellRender, per_sel: &[[Vec<u32>; 32]]) -> Vec<u8> {
    let n = cr.id_order.len();
    let mask_bytes = n.div_ceil(8);
    let mut seg = Vec::new();
    seg.push(BASE32[ci]);
    seg.extend_from_slice(&(n as u32).to_le_bytes());
    // Per selection, emit one of two self-describing formats (format byte first):
    //   1 = index-list: u32 count + count*u32 selected local indices (sparse → O(selected))
    //   0 = bitmask:    mask_bytes raw bits (dense → smaller than an index list)
    // The index-list lets JS rebuild the overlay in O(selected) instead of scanning N bits.
    for sel_cells in per_sel {
        let indices = &sel_cells[ci];
        if indices.len() * 4 + 4 < mask_bytes {
            seg.push(1u8);
            seg.extend_from_slice(&(indices.len() as u32).to_le_bytes());
            for idx in indices {
                seg.extend_from_slice(&idx.to_le_bytes());
            }
        } else {
            seg.push(0u8);
            let mut bitmask = vec![0u8; mask_bytes];
            for &li in indices {
                bitmask[li as usize / 8] |= 1 << (li % 8);
            }
            seg.extend_from_slice(&bitmask);
        }
    }
    seg
}

/// Binary search for a location ID in a sorted batch. O(log n).
fn batch_row_for_id(batch: &RecordBatch, id: u32) -> Option<usize> {
    let ids = col_id(batch);
    let (mut lo, mut hi) = (0usize, batch.num_rows());
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        let mid_id = ids.value(mid);
        if mid_id < id {
            lo = mid + 1;
        } else if mid_id > id {
            hi = mid;
        } else {
            return Some(mid);
        }
    }
    None
}

fn schema() -> SchemaRef {
    Arc::new(arrow_bridge::location_schema())
}

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
    /// Unsaved since the last autosave. Cleared by `store_save_dirty` after a
    /// confirmed write (rev-guarded); NOT a "has uncommitted content" flag — that
    /// is [`Overlay::is_empty`].
    pub dirty: bool,
    /// Bumped on every overlay mutation. `store_save_dirty` clears `dirty` only if
    /// the rev it serialized is still current once the async write lands.
    pub rev: u64,
}

impl Overlay {
    /// No uncommitted content. Distinct from `dirty`: an autosaved overlay is
    /// clean but stays non-empty until baked by a commit.
    pub(crate) fn is_empty(&self) -> bool {
        self.adds.is_empty() && self.dead.is_empty() && self.patches.is_empty()
    }

    /// Mark the overlay mutated: flag it unsaved and invalidate in-flight saves.
    fn touch(&mut self) {
        self.dirty = true;
        self.rev += 1;
    }
}

pub(crate) struct RenderState {
    pub cells: [Option<CellRender>; 32],
    pub id_to_cell_idx: Vec<u8>,
    pub arrow_style: bool,
    pub marker_color: [u8; 3],
}

pub(crate) struct SelectionState {
    pub all: Vec<Selection>,
    /// Per-selection membership, keyed by location id.
    pub loc_sets: Vec<RoaringBitmap>,
    /// Resolved count of every selection node (top-level and nested), keyed by `Selection.key`.
    /// The faithful per-node count source for sidebar display; refreshed on every sync/resolve.
    pub node_counts: HashMap<String, u32>,
    pub version: u64,
    /// Union of all `loc_sets`. Answers "is this id selected".
    pub ids: RoaringBitmap,
    pub active_id: Option<u32>,
}

impl SelectionState {
    /// Color of a selected id = color of the last selection containing it. None if unselected.
    fn color_for(&self, id: u32) -> Option<[u8; 3]> {
        if !self.ids.contains(id) {
            return None;
        }
        let mut color = None;
        for (si, set) in self.loc_sets.iter().enumerate() {
            if set.contains(id) {
                color = Some(self.all[si].color);
            }
        }
        color
    }

    fn color_map(&self) -> HashMap<u32, [u8; 3]> {
        let mut map = HashMap::with_capacity(self.ids.len() as usize);
        for (si, set) in self.loc_sets.iter().enumerate() {
            let color = self.all[si].color;
            for id in set {
                map.insert(id, color);
            }
        }
        map
    }
}

pub(crate) struct TagState {
    pub all: HashMap<u32, Tag>,
    pub dirty: bool,
    pub counts_dirty: bool,
    pub next_id: u32,
    /// `tag_id -> set of member location ids`. Lets a `Tag` selection resolve by
    /// cloning a set instead of scanning every row's tag list. Maintained
    /// incrementally in `update_tag_counts` (the single choke point for tag
    /// membership changes) and rebuilt from the batch on map open. Covers committed
    /// base rows + overlay adds; patched/dead rows are reconciled at resolve time.
    pub sets: HashMap<u32, RoaringBitmap>,
}

pub(crate) struct EditStacks {
    pub undo: Vec<EditEntry>,
    pub redo: Vec<EditEntry>,
}

pub struct Store {
    pub(crate) map_id: Option<String>,
    // batch is declared before mmap_handle so it drops first (columns reference the mmap).
    pub(crate) batch: Option<RecordBatch>,
    mmap_handle: Option<storage::MmapHandle>,
    next_id: u32,
    version: u64,
    pub(crate) alive_count: usize,
    pub(crate) known_field_keys: HashSet<String>,

    pub(crate) overlay: Overlay,
    pub(crate) render: RenderState,
    pub(crate) selections: SelectionState,
    pub(crate) tags: TagState,
    pub(crate) edits: EditStacks,
    /// Cached unscoped bounds accumulator. Maintained incrementally on add/update
    /// (which can only grow it); `bounds_dirty` forces an O(N) recompute on the
    /// next read after a removal or bulk change. Resolved to `[w,s,e,n]` on read.
    bounds_cache: Option<BoundsAcc>,
    bounds_dirty: bool,
    /// Lazy spatial index over alive locations. Built on the first radius query,
    /// then maintained incrementally by the overlay mutation functions. A length
    /// mismatch against `alive_count` at query time forces a rebuild, so any bulk
    /// path that bypasses the overlay fns degrades to a rebuild, never wrong results.
    spatial: Option<spatial::SpatialIndex>,
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

/// Everything derived from a single O(N) pass over all alive locations. Computed
/// once on map open; add new whole-map derivations here rather than scanning again.
struct LocationAggregates {
    alive: usize,
    tag_counts: HashMap<u32, usize>,
    bounds: Option<BoundsAcc>,
}

/// Incremental bounding-box accumulator. Tracks latitude min/max plus longitude
/// min/max in *two* framings — raw `[-180,180]` and shifted `[0,360)` — so
/// `resolve` can pick the tighter longitude span and emit an antimeridian-crossing
/// box (`west > east`) when the data straddles 180°. Every field is a plain
/// min/max, so it grows in O(1) per point with no sort — the cache stays cheap.
#[derive(Clone, Copy)]
struct BoundsAcc {
    s: f64,
    n: f64, // latitude min / max
    w: f64,
    e: f64, // longitude min / max, raw [-180,180]
    ws: f64,
    es: f64, // longitude min / max, shifted to [0,360)
}

impl BoundsAcc {
    fn shift(lng: f64) -> f64 {
        if lng < 0.0 {
            lng + 360.0
        } else {
            lng
        }
    }

    fn seed(lat: f64, lng: f64) -> Self {
        let sh = Self::shift(lng);
        BoundsAcc {
            s: lat,
            n: lat,
            w: lng,
            e: lng,
            ws: sh,
            es: sh,
        }
    }

    fn expand(self, lat: f64, lng: f64) -> Self {
        let sh = Self::shift(lng);
        BoundsAcc {
            s: self.s.min(lat),
            n: self.n.max(lat),
            w: self.w.min(lng),
            e: self.e.max(lng),
            ws: self.ws.min(sh),
            es: self.es.max(sh),
        }
    }

    /// Fold a point into an optional accumulator (seed if empty).
    fn fold(acc: Option<Self>, lat: f64, lng: f64) -> Self {
        match acc {
            Some(a) => a.expand(lat, lng),
            None => Self::seed(lat, lng),
        }
    }

    /// `[west, south, east, north]`, choosing whichever longitude framing is
    /// tighter. The shifted framing winning means the box crosses 180°, which
    /// maps back to `west > east` — the form Google/deck `fitBounds` zooms to the
    /// short way (matching the original's `east += 360` handling).
    fn resolve(self) -> [f64; 4] {
        if self.es - self.ws < self.e - self.w {
            let unshift = |v: f64| if v >= 180.0 { v - 360.0 } else { v };
            [unshift(self.ws), self.s, unshift(self.es), self.n]
        } else {
            [self.w, self.s, self.e, self.n]
        }
    }

    /// Whether a point sits on any extreme — removing it might shrink the box,
    /// forcing a recompute.
    fn on_edge(self, lat: f64, lng: f64) -> bool {
        let sh = Self::shift(lng);
        lat == self.s
            || lat == self.n
            || lng == self.w
            || lng == self.e
            || sh == self.ws
            || sh == self.es
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
            known_field_keys: HashSet::new(),
            overlay: Overlay {
                adds: Vec::new(),
                dead: HashSet::new(),
                patches: HashMap::new(),
                dirty: false,
                rev: 0,
            },
            render: RenderState {
                cells: [const { None }; 32],
                id_to_cell_idx: Vec::new(),
                arrow_style: false,
                marker_color: [42, 42, 42],
            },
            selections: SelectionState {
                all: Vec::new(),
                loc_sets: Vec::new(),
                node_counts: HashMap::new(),
                version: 0,
                ids: RoaringBitmap::new(),
                active_id: None,
            },
            tags: TagState {
                all: HashMap::new(),
                dirty: false,
                counts_dirty: false,
                next_id: 1,
                sets: HashMap::new(),
            },
            edits: EditStacks {
                undo: Vec::new(),
                redo: Vec::new(),
            },
            bounds_cache: None,
            bounds_dirty: true,
            spatial: None,
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
            tag_counts: Some(self.tags.all.iter().map(|(&id, t)| (id, t.count)).collect()),
            known_field_keys: self.known_field_keys.iter().cloned().collect(),
        }
    }

    /// Bump version, derive the render delta + selection sync from the semantic
    /// changeset, and return the full mutation result. The changeset is the single
    /// source of truth; the render delta and selection sync are two projections of it.
    pub(crate) fn finish_mutation(&mut self, changes: ChangeSet) -> MutationResult {
        self.bump();
        self.update_bounds(&changes);

        let has_selections = !self.selections.all.is_empty();
        let full_resolve = has_selections
            && (changes.full_reset
                || changes.added.len() + changes.removed.len() + changes.updated.len() > 100
                || self.selections_need_full_resolve());

        // Step 1: Record which render cells contain changed IDs BEFORE anything mutates render_cells.
        let affected_cells: HashSet<u8> = if has_selections {
            let mut cells = HashSet::new();
            for &id in changes
                .removed
                .iter()
                .chain(changes.added.iter().map(|l| &l.id))
                .chain(changes.updated.iter().map(|(_, n)| &n.id))
            {
                if let Some(&ci) = self.render.id_to_cell_idx.get(id as usize) {
                    if ci != 255 {
                        cells.insert(ci);
                    }
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
                        cell,
                        cell_index: ci,
                        r: color[0],
                        g: color[1],
                        b: color[2],
                        a: 255,
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
                Some(self.build_selection_bitmask(None))
            } else {
                Some(self.build_selection_bitmask(Some(&bitmask_cells)))
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

        let mut status = self.store_status();
        if !std::mem::take(&mut self.tags.counts_dirty) {
            status.tag_counts = None;
        }

        MutationResult {
            status,
            delta,
            selection_sync,
            new_field_defs: None,
            tags,
        }
    }

    /// Return the RGBA color for a location in the base render layer.
    /// Selected locations are transparent (alpha=0) because they are drawn separately
    /// by the selection overlay layer with their selection color.
    fn base_color(&self, id: u32) -> (u8, u8, u8, u8) {
        if self.selections.ids.contains(id) {
            (0, 0, 0, 0)
        } else {
            let [r, g, b] = self.render.marker_color;
            (r, g, b, 255)
        }
    }

    /// Whether any active selection requires a full O(S*N) resolve rather than
    /// incremental membership updates (composites and duplicates depend on global state).
    fn selections_need_full_resolve(&self) -> bool {
        self.selections.all.iter().any(|s| {
            matches!(
                s.props,
                SelectionProps::Duplicates { .. }
                    | SelectionProps::TopK { .. }
                    | SelectionProps::Uncommitted
                    | SelectionProps::Intersection { .. }
                    | SelectionProps::Union { .. }
                    | SelectionProps::Invert { .. }
            )
        })
    }

    /// Project the changeset onto render cells, returning the render delta and keeping
    /// `render_cells` / `id_to_cell_idx` in sync. This is the single place cell
    /// membership is mutated for adds / removes / moves.
    fn derive_render_delta(&mut self, changes: &ChangeSet) -> RenderDelta {
        let mut delta = RenderDelta {
            full_reset: changes.full_reset,
            ..Default::default()
        };

        for &id in &changes.removed {
            if let Some(removal) = self.cell_remove_render(id) {
                delta.removed.push(removal);
            }
        }

        for loc in &changes.added {
            let ci = render_cell_idx(loc.lat, loc.lng);
            let (r, g, b, a) = self.base_color(loc.id);
            self.cell_add_render(ci, loc.id);
            let angle = if self.render.arrow_style {
                -(loc.heading as f32)
            } else {
                0.0
            };
            delta.added.push(RenderEntry {
                cell: cell_key_from_idx(ci),
                id: loc.id,
                lng: loc.lng as f32,
                lat: loc.lat as f32,
                heading: angle,
                r,
                g,
                b,
                a,
            });
        }

        for (old, new) in &changes.updated {
            let pos_changed = old.lat != new.lat || old.lng != new.lng;
            let heading_changed = old.heading != new.heading;
            if pos_changed {
                let new_ci = render_cell_idx(new.lat, new.lng);
                let old_ci = self
                    .render
                    .id_to_cell_idx
                    .get(new.id as usize)
                    .copied()
                    .unwrap_or(255);
                if old_ci != new_ci {
                    if let Some(removal) = self.cell_remove_render(new.id) {
                        delta.removed.push(removal);
                    }
                    let (r, g, b, a) = self.base_color(new.id);
                    self.cell_add_render(new_ci, new.id);
                    let angle = if self.render.arrow_style {
                        -(new.heading as f32)
                    } else {
                        0.0
                    };
                    delta.added.push(RenderEntry {
                        cell: cell_key_from_idx(new_ci),
                        id: new.id,
                        lng: new.lng as f32,
                        lat: new.lat as f32,
                        heading: angle,
                        r,
                        g,
                        b,
                        a,
                    });
                    continue;
                }
            }
            if pos_changed || heading_changed {
                if let Some((cell, ci)) = self.cell_lookup(new.id) {
                    let angle = if self.render.arrow_style {
                        -(new.heading as f32)
                    } else {
                        0.0
                    };
                    delta.updated.push(RenderPatchEntry {
                        cell,
                        cell_index: ci,
                        lng: if pos_changed {
                            Some(new.lng as f32)
                        } else {
                            None
                        },
                        lat: if pos_changed {
                            Some(new.lat as f32)
                        } else {
                            None
                        },
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

        let drop_ids: HashSet<u32> = changes
            .removed
            .iter()
            .copied()
            .chain(changes.updated.iter().map(|(_, n)| n.id))
            .collect();
        if !drop_ids.is_empty() {
            for id in &drop_ids {
                if self.selections.ids.contains(*id) {
                    was_selected.insert(*id);
                }
            }
            for set in &mut self.selections.loc_sets {
                for id in &drop_ids {
                    set.remove(*id);
                }
            }
            for id in &drop_ids {
                self.selections.ids.remove(*id);
            }
        }

        let test_locs: Vec<&Location> = changes
            .added
            .iter()
            .chain(changes.updated.iter().map(|(_, n)| n))
            .collect();
        let sel_props: Vec<SelectionProps> = self
            .selections
            .all
            .iter()
            .map(|s| s.props.clone())
            .collect();
        for (si, props) in sel_props.iter().enumerate() {
            for loc in &test_locs {
                if selections::RowRef::from_loc(loc).matches(&props) {
                    self.selections.loc_sets[si].insert(loc.id);
                    self.selections.ids.insert(loc.id);
                }
            }
        }
        self.selections.version += 1;
        // Incremental path runs only without composites, so every node is top-level.
        self.selections.node_counts = self
            .selections
            .all
            .iter()
            .zip(&self.selections.loc_sets)
            .map(|(s, set)| (s.key.clone(), set.len() as u32))
            .collect();

        let mut gained = Vec::new();
        let mut lost = Vec::new();
        for loc in changes
            .added
            .iter()
            .chain(changes.updated.iter().map(|(_, n)| n))
        {
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

    /// Full selection membership resolve: recomputes selection_loc_sets, selected_ids,
    /// selected_colors from scratch. O(S * N). Does NOT build the bitmask file.
    fn resolve_selection_membership(&mut self) {
        let sels = self.selections.all.clone();
        let (loc_sets, node_counts) = {
            let view = self.loc_view();
            selections::resolve_forest(&view, &sels)
        };
        self.selections.loc_sets = loc_sets;
        self.selections.node_counts = node_counts;

        let mut all_selected = RoaringBitmap::new();
        for set in &self.selections.loc_sets {
            all_selected |= set;
        }
        self.selections.ids = all_selected;
        self.selections.version += 1;
    }

    /// Build the selection bitmask file from current render_cells + selection_loc_sets.
    /// `affected = None` rebuilds all cells (full resolve path); `Some` restricts the
    /// rebuild to those cell indices (incremental delta path).
    fn build_selection_bitmask(&self, affected: Option<&HashSet<u8>>) -> SelectionSync {
        let counts = self.selections.node_counts.clone();
        let selected_count = self.selections.ids.len() as usize;

        if affected.is_some_and(|a| a.is_empty()) {
            return SelectionSync {
                counts,
                bitmask: None,
                selected_count,
            };
        }

        let t0 = std::time::Instant::now();
        let num_sels = self.selections.all.len();
        // Route selections to per-cell indices (parallel over selections, O(selected)),
        // then serialize affected cells in parallel; segments are self-describing so
        // order is irrelevant.
        let routed: Vec<[Vec<u32>; 32]> = self
            .selections
            .loc_sets
            .par_iter()
            .map(|set| selection_cell_indices(&self.render, set, affected))
            .collect();
        let segments: Vec<Vec<u8>> = self
            .render
            .cells
            .par_iter()
            .enumerate()
            .filter_map(|(ci, opt)| {
                if let Some(a) = affected {
                    if !a.contains(&(ci as u8)) {
                        return None;
                    }
                }
                let cr = opt.as_ref()?;
                Some(serialize_cell_segment(ci, cr, &routed))
            })
            .collect();
        let num_cells = segments.len();

        let buf =
            assemble_selection_bitmask(self.selections.all.iter().map(|s| &s.color), &segments);
        let bitmask = if num_cells > 0 { Some(buf) } else { None };

        log::debug!(
            "[sel] total={}ms sels={} selected={} cells={} incremental={}",
            t0.elapsed().as_millis(),
            num_sels,
            selected_count,
            num_cells,
            affected.is_some()
        );

        SelectionSync {
            counts,
            bitmask,
            selected_count,
        }
    }

    /// Adjust tag counts by `delta` (+1 for adds, -1 for removes). O(L * T) where L = locs, T = avg tags per loc.
    pub(crate) fn update_tag_counts(&mut self, locs: &[Location], delta: isize) {
        if locs.iter().any(|l| !l.tags.is_empty()) {
            self.tags.counts_dirty = true;
        }
        // Pre-aggregate membership changes per tag for bulk bitmap operations.
        let mut members: HashMap<u32, Vec<u32>> = HashMap::new();
        for loc in locs {
            for &tag_id in &loc.tags {
                if let Some(tag) = self.tags.all.get_mut(&tag_id) {
                    if delta < 0 {
                        tag.count = tag.count.saturating_sub((-delta) as usize);
                    } else {
                        tag.count += delta as usize;
                    }
                } else if delta > 0 {
                    self.tags.all.insert(
                        tag_id,
                        Tag {
                            id: tag_id,
                            name: format!("Tag {}", tag_id),
                            color: util::color_for_name(&format!("Tag {}", tag_id)),
                            visible: true,
                            order: None,
                            count: delta as usize,
                        },
                    );
                    self.tags.dirty = true;
                }
                members.entry(tag_id).or_default().push(loc.id);
            }
        }
        for (tag_id, mut ids) in members {
            if delta > 0 {
                ids.sort_unstable();
                self.tags.sets.entry(tag_id).or_default().extend(ids);
            } else if let Some(set) = self.tags.sets.get_mut(&tag_id) {
                for id in ids {
                    set.remove(id);
                }
            }
        }
    }

    /// Rebuild the `tag_id -> member ids` index from scratch over the live data
    /// (alive base rows + overlay adds, with patches applied). O(N * tags/loc). Called
    /// on map open; incremental edits maintain it via `update_tag_counts`.
    pub(crate) fn rebuild_tag_sets(&mut self) {
        let view = self.loc_view();
        let mut sets: HashMap<u32, RoaringBitmap> = HashMap::new();
        view.for_each(|row| {
            let id = row.id();
            row.for_each_tag(|tid| {
                sets.entry(tid).or_default().insert(id);
            });
        });
        self.tags.sets = sets;
    }

    /// Increment tag counts for all tags referenced by `locs`.
    pub(crate) fn add_tag_counts(&mut self, locs: &[Location]) {
        self.update_tag_counts(locs, 1);
    }
    /// Decrement tag counts for all tags referenced by `locs` (saturating at zero).
    pub(crate) fn remove_tag_counts(&mut self, locs: &[Location]) {
        self.update_tag_counts(locs, -1);
    }

    /// Push an undo entry for the changed (old != new) pairs and clear redo.
    fn record_update_undo(&mut self, updated: &[(Location, Location)]) {
        let (changed_old, changed_new): (Vec<_>, Vec<_>) = updated
            .iter()
            .filter(|(o, n)| o != n)
            .map(|(o, n)| (o.clone(), n.clone()))
            .unzip();
        if !changed_old.is_empty() {
            self.push_undo(EditEntry {
                created: changed_new,
                removed: changed_old,
            });
            self.edits.redo.clear();
        }
    }

    /// Apply a tags-only update: adjust tag counts, write the tags patch into the
    /// overlay, and record undo for the changed pairs. Returns the ChangeSet.
    fn commit_tag_update(&mut self, updated: Vec<(Location, Location)>) -> ChangeSet {
        let old_locs: Vec<Location> = updated.iter().map(|(o, _)| o.clone()).collect();
        self.remove_tag_counts(&old_locs);
        for (old, new_loc) in &updated {
            self.overlay_write(new_loc.id, new_loc.clone(), (old.lat, old.lng));
        }
        let new_locs: Vec<Location> = updated.iter().map(|(_, n)| n.clone()).collect();
        self.add_tag_counts(&new_locs);
        self.record_update_undo(&updated);
        ChangeSet {
            updated,
            ..Default::default()
        }
    }

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
        if ci == 255 {
            return None;
        }
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
        Some(CellRemoval {
            cell: cell_key_from_idx(ci),
            cell_index: idx,
            id,
        })
    }

    /// Look up a location's render cell key and index within that cell.
    fn cell_lookup(&self, id: u32) -> Option<(String, usize)> {
        let ci = *self.render.id_to_cell_idx.get(id as usize)?;
        if ci == 255 {
            return None;
        }
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
            self.edits
                .undo
                .drain(..self.edits.undo.len() - MAX_UNDO_ENTRIES);
        }
    }

    /// Look up a location by ID across patches, overlay_adds (binary search), and batch.
    fn get_loc_by_id(&self, id: u32) -> Option<Location> {
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
                return Some(arrow_bridge::row_to_location(b, idx));
            }
        }
        None
    }

    /// Current coordinates of an alive location, without cloning the full Location.
    fn coords_of(&self, id: u32) -> Option<(f64, f64)> {
        if self.overlay.dead.contains(&id) {
            return None;
        }
        if let Some(p) = self.overlay.patches.get(&id) {
            return Some((p.lat, p.lng));
        }
        if let Ok(i) = self.overlay.adds.binary_search_by_key(&id, |l| l.id) {
            let l = &self.overlay.adds[i];
            return Some((l.lat, l.lng));
        }
        if let Some(ref b) = self.batch {
            if let Some(idx) = batch_row_for_id(b, id) {
                return Some((col_lat(b).value(idx), col_lng(b).value(idx)));
            }
        }
        None
    }

    /// Current heading of an alive location, without cloning the full Location.
    fn heading_of(&self, id: u32) -> Option<f64> {
        if self.overlay.dead.contains(&id) {
            return None;
        }
        if let Some(p) = self.overlay.patches.get(&id) {
            return Some(p.heading);
        }
        if let Ok(i) = self.overlay.adds.binary_search_by_key(&id, |l| l.id) {
            return Some(self.overlay.adds[i].heading);
        }
        if let Some(ref b) = self.batch {
            if let Some(idx) = batch_row_for_id(b, id) {
                return Some(col_heading(b).value(idx));
            }
        }
        None
    }

    /// Build the spatial index if absent or drifted (length mismatch vs alive_count
    /// catches any bulk path that bypassed the overlay fns — rebuild, never wrong).
    fn ensure_spatial(&mut self) {
        if let Some(ix) = self.spatial.as_ref() {
            if ix.len() == self.alive_count {
                return;
            }
            log::warn!(
                "[spatial] index len {} != alive {} — rebuilding",
                ix.len(),
                self.alive_count
            );
        }
        let _t = std::time::Instant::now();
        let mut ix = spatial::SpatialIndex::new();
        self.loc_view()
            .for_each(|row| ix.insert(row.id(), row.lat(), row.lng()));
        log::debug!(
            "[spatial] built n={} in {}ms",
            ix.len(),
            _t.elapsed().as_millis()
        );
        self.spatial = Some(ix);
    }

    /// Ids of alive locations within `radius_m` metres of the point. Index-backed:
    /// O(cells in radius) instead of an O(N) scan.
    pub(crate) fn find_nearby_ids(&mut self, lat: f64, lng: f64, radius_m: f64) -> Vec<u32> {
        self.ensure_spatial();
        let mut cand = Vec::new();
        self.spatial
            .as_ref()
            .unwrap()
            .candidates(lat, lng, radius_m, &mut cand);
        cand.retain(|&id| {
            self.coords_of(id)
                .is_some_and(|(la, ln)| selections::haversine_m(lat, lng, la, ln) <= radius_m)
        });
        cand
    }

    /// Whether any alive location lies within `radius_m` metres of the point.
    pub(crate) fn any_within(&mut self, lat: f64, lng: f64, radius_m: f64) -> bool {
        self.ensure_spatial();
        let mut cand = Vec::new();
        self.spatial
            .as_ref()
            .unwrap()
            .candidates(lat, lng, radius_m, &mut cand);
        cand.iter().any(|&id| {
            self.coords_of(id)
                .is_some_and(|(la, ln)| selections::haversine_m(lat, lng, la, ln) <= radius_m)
        })
    }

    /// Evenly spaced subset of the current selection: `target_count` thins to N ids
    /// maximizing spacing; `min_distance_m` keeps as many as fit at that spacing.
    pub(crate) fn pick_spaced(
        &self,
        target_count: Option<u32>,
        min_distance_m: Option<u32>,
    ) -> AppResult<SpacedPickResult> {
        match (target_count, min_distance_m) {
            (Some(_), Some(_)) => {
                return Err(AppError::from(
                    "pick_spaced: pass exactly one of target_count or min_distance_m, not both",
                ))
            }
            (None, None) => {
                return Err(AppError::from(
                    "pick_spaced: pass exactly one of target_count or min_distance_m",
                ))
            }
            (_, Some(0)) => {
                return Err(AppError::from(
                    "pick_spaced: min_distance_m must be greater than 0",
                ))
            }
            _ => {}
        }

        let mut candidates: Vec<(u32, f64, f64)> = self
            .selections
            .ids
            .iter()
            .filter_map(|id| {
                let (lat, lng) = self.coords_of(id)?;
                (lat.is_finite() && lng.is_finite()).then_some((id, lat, lng))
            })
            .collect();
        fastrand::shuffle(&mut candidates);

        if let Some(n) = target_count {
            if n as usize >= candidates.len() {
                return Ok(SpacedPickResult {
                    ids: candidates.iter().map(|c| c.0).collect(),
                    distance_m: 0,
                });
            }
            let coords: Vec<(f64, f64)> = candidates.iter().map(|c| (c.1, c.2)).collect();
            let (idxs, distance_m) =
                vali_geo::with_max_min_distance(&coords, n as usize, None, &[]);
            let ids = idxs.into_iter().map(|i| candidates[i as usize].0).collect();
            return Ok(SpacedPickResult { ids, distance_m });
        }

        let d = min_distance_m.unwrap() as i32;
        if candidates.is_empty() {
            return Ok(SpacedPickResult {
                ids: Vec::new(),
                distance_m: 0,
            });
        }
        let coords: Vec<(f64, f64)> = candidates.iter().map(|c| (c.1, c.2)).collect();
        let idxs = vali_geo::place_spaced(&coords, candidates.len(), d, &[]);
        let ids = idxs.into_iter().map(|i| candidates[i as usize].0).collect();
        Ok(SpacedPickResult { ids, distance_m: d })
    }

    /// Collect all alive locations (batch + overlay) into a Vec. O(N) time and space.
    pub(crate) fn collect_all_locations(&self) -> Vec<Location> {
        let view = self.loc_view();
        let mut locs = Vec::with_capacity(self.alive_count);
        view.for_each(|row| locs.push(row.to_location()));
        locs
    }

    /// Like `collect_all_locations`, optionally restricted to a set of ids.
    pub(crate) fn collect_scoped(&self, scope: Option<&[u32]>) -> Vec<Location> {
        match scope {
            Some(ids) => {
                let set: std::collections::HashSet<u32> = ids.iter().copied().collect();
                self.collect_all_locations()
                    .into_iter()
                    .filter(|l| set.contains(&l.id))
                    .collect()
            }
            None => self.collect_all_locations(),
        }
    }

    /// Full O(N) bounds scan, optionally scoped to a selection. Returns the raw
    /// accumulator; callers `.resolve()` it to `[w,s,e,n]`.
    fn scan_bounds(&self, scope: Option<&RoaringBitmap>) -> Option<BoundsAcc> {
        let view = self.loc_view();
        let mut acc: Option<BoundsAcc> = None;
        view.for_each(|row| {
            if let Some(ids) = scope {
                if !ids.contains(row.id()) {
                    return;
                }
            }
            acc = Some(BoundsAcc::fold(acc, row.lat(), row.lng()));
        });
        acc
    }

    fn compute_bounds(&self, scope: Option<&RoaringBitmap>) -> Option<[f64; 4]> {
        self.scan_bounds(scope).map(BoundsAcc::resolve)
    }

    /// Unscoped bounding box, cached. Recomputes O(N) only when dirty (after a
    /// removal or bulk change); otherwise O(1). The scoring UI refreshes this on
    /// every edit, so it must not scan the whole map per mutation.
    fn cached_bounds(&mut self) -> Option<[f64; 4]> {
        if self.bounds_dirty {
            self.bounds_cache = self.scan_bounds(None);
            self.bounds_dirty = false;
        }
        self.bounds_cache.map(BoundsAcc::resolve)
    }

    /// Keep the cached bounds current for one mutation. Added / updated-new
    /// positions can only grow the box (O(changed)). A removal — or an update
    /// whose OLD position sat on an edge — can shrink it, which needs the next
    /// extreme point, so we just mark dirty and recompute lazily on next read.
    /// `removed` carries ids only (no coords), so any removal is conservative.
    fn update_bounds(&mut self, changes: &ChangeSet) {
        if self.bounds_dirty {
            return;
        }
        if changes.full_reset || !changes.removed.is_empty() {
            self.bounds_dirty = true;
            return;
        }
        if let Some(acc) = self.bounds_cache {
            if changes
                .updated
                .iter()
                .any(|(old, _)| acc.on_edge(old.lat, old.lng))
            {
                self.bounds_dirty = true;
                return;
            }
        }
        for (lat, lng) in changes
            .added
            .iter()
            .map(|l| (l.lat, l.lng))
            .chain(changes.updated.iter().map(|(_, nw)| (nw.lat, nw.lng)))
        {
            self.bounds_cache = Some(BoundsAcc::fold(self.bounds_cache, lat, lng));
        }
    }

    /// Single O(N) pass over all alive locations deriving every open-time
    /// aggregate: alive count, tag counts, and the bounding box. Seeding the
    /// bbox here means the first `store_bounds` after open is an O(1) cache hit
    /// instead of a second full scan.
    fn scan_locations(&self) -> LocationAggregates {
        let view = self.loc_view();
        let mut tag_counts: HashMap<u32, usize> = HashMap::new();
        let mut alive = 0usize;
        let mut bounds: Option<BoundsAcc> = None;
        view.for_each(|row| {
            alive += 1;
            bounds = Some(BoundsAcc::fold(bounds, row.lat(), row.lng()));
            row.for_each_tag(|tid| {
                *tag_counts.entry(tid).or_default() += 1;
            });
        });
        LocationAggregates {
            alive,
            tag_counts,
            bounds,
        }
    }

    /// Read a single location from the committed base batch by id (ignores the
    /// overlay). O(log n). Used to recover the pre-edit version of a row.
    fn base_loc_by_id(&self, id: u32) -> Option<Location> {
        let b = self.batch.as_ref()?;
        let idx = batch_row_for_id(b, id)?;
        Some(arrow_bridge::row_to_location(b, idx))
    }

    /// Build a commit delta directly from the overlay — the in-memory changeset
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

    /// Construct a read-only view over all alive locations for selection resolution.
    fn loc_view(&self) -> selections::LocView<'_> {
        selections::LocView::new(
            self.batch.as_ref(),
            &self.overlay.dead,
            &self.overlay.patches,
            &self.overlay.adds,
            Some(&self.tags.sets),
        )
    }

    /// Insert or restore a location in the overlay. O(1) amortized.
    pub(crate) fn overlay_add(&mut self, loc: Location) {
        self.overlay.touch();
        self.alive_count += 1;
        if let Some(ix) = self.spatial.as_mut() {
            ix.insert(loc.id, loc.lat, loc.lng);
        }
        let in_batch = self
            .batch
            .as_ref()
            .and_then(|b| batch_row_for_id(b, loc.id))
            .is_some();
        if in_batch {
            self.overlay.dead.remove(&loc.id);
            if self.base_loc_by_id(loc.id).as_ref() == Some(&loc) {
                self.overlay.patches.remove(&loc.id);
            } else {
                self.overlay.patches.insert(loc.id, loc);
            }
        } else {
            self.overlay.dead.remove(&loc.id);
            // Keep overlay_adds sorted by id (invariant asserted in bake_overlay). A normal add has a
            // monotonic new id so this inserts at the end (cheap, like push); undo re-adds an old id,
            // which a plain push would append out of order — partition_point puts it in its sorted slot.
            let pos = self.overlay.adds.partition_point(|l| l.id < loc.id);
            debug_assert!(
                self.overlay.adds.get(pos).is_none_or(|l| l.id != loc.id),
                "overlay_add duplicate id {} — next_id allocation bug",
                loc.id
            );
            self.overlay.adds.insert(pos, loc);
        }
    }

    /// Mark locations as dead in the overlay. O(L) for L locations removed.
    fn overlay_remove(&mut self, locs: &[Location]) {
        let remove_set: HashSet<u32> = locs.iter().map(|l| l.id).collect();
        for loc in locs {
            self.alive_count -= 1;
            // Index under the CURRENT coords, not the caller's copy: a patched
            // location's overlay coords are where the index filed it.
            let (lat, lng) = self.coords_of(loc.id).unwrap_or((loc.lat, loc.lng));
            if let Some(ix) = self.spatial.as_mut() {
                ix.remove(loc.id, lat, lng);
            }
            self.overlay.patches.remove(&loc.id);
        }
        self.overlay.dead.extend(&remove_set);
        self.overlay.adds.retain(|l| !remove_set.contains(&l.id));
        self.overlay.touch();
    }

    /// Apply a partial patch to an existing location. Reads the current state, merges
    /// non-None fields from the patch, and writes back to overlay_adds or overlay_patches.
    fn overlay_update(&mut self, id: u32, patch: &LocationPatch) {
        let mut loc = match self.get_loc_by_id(id) {
            Some(l) => l,
            None => return,
        };
        let old_coords = (loc.lat, loc.lng);
        if let Some(v) = patch.lat {
            loc.lat = v;
        }
        if let Some(v) = patch.lng {
            loc.lng = v;
        }
        if let Some(v) = patch.heading {
            loc.heading = v;
        }
        if let Some(v) = patch.pitch {
            loc.pitch = v;
        }
        if let Some(v) = patch.zoom {
            loc.zoom = v;
        }
        if let Some(ref v) = patch.pano_id {
            loc.pano_id = v.clone();
        }
        if let Some(ref v) = patch.provider {
            loc.provider = v.clone();
        }
        if let Some(v) = patch.flags {
            loc.flags = LocationFlags::from_bits_retain(v);
        }
        if let Some(ref v) = patch.tags {
            loc.tags = v.clone();
        }
        if let Some(ref v) = patch.extra {
            // JSON Merge Patch (RFC 7386): keys shallow-merge into the current extra,
            // a null value deletes its key, and a null patch clears extra entirely.
            loc.extra = match v {
                None => None,
                Some(p) => {
                    let mut m = loc.extra.as_ref().map(|e| e.to_map()).unwrap_or_default();
                    for (k, val) in p.to_map() {
                        if val.is_null() {
                            m.remove(&k);
                        } else {
                            m.insert(k, val);
                        }
                    }
                    crate::types::RawExtra::from_map(&m)
                }
            };
        }
        if let Some(v) = patch.created_at {
            loc.created_at = v;
        }
        if let Some(v) = patch.modified_at {
            loc.modified_at = v;
        }
        self.overlay_write(id, loc, old_coords);
    }

    /// Write an already-computed Location into the overlay (adds/patches), given the id
    /// and its pre-mutation coords for spatial-index maintenance. Shared by `overlay_update`
    /// (which fetches+mutates a patch itself) and callers that already hold the fully-built
    /// new Location (e.g. `commit_tag_update`), so the latter skip a redundant re-fetch.
    fn overlay_write(&mut self, id: u32, mut loc: Location, old_coords: (f64, f64)) {
        if (loc.lat, loc.lng) != old_coords {
            if let Some(ix) = self.spatial.as_mut() {
                ix.remove(id, old_coords.0, old_coords.1);
                ix.insert(id, loc.lat, loc.lng);
            }
        }
        if let Ok(pos) = self.overlay.adds.binary_search_by_key(&id, |l| l.id) {
            // Stamp only on a real change (parity with the base-row branch below): a
            // session-added row must not report "never modified", but a no-op patch
            // must stay a no-op or it fabricates undo entries.
            if self.overlay.adds[pos] != loc {
                loc.modified_at = Some(crate::util::now_unix());
                self.overlay.adds[pos] = loc;
            }
        } else if self.base_loc_by_id(id).as_ref() == Some(&loc) {
            self.overlay.patches.remove(&id);
        } else {
            loc.modified_at = Some(crate::util::now_unix());
            self.overlay.patches.insert(id, loc);
        }
        self.overlay.touch();
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
    /// Gated on emptiness, not `dirty`: an autosave clears `dirty` without folding
    /// anything in, and a clean-but-nonempty overlay must still bake.
    pub(crate) fn bake_overlay(&mut self) {
        if self.overlay.is_empty() {
            return;
        }
        let _t = std::time::Instant::now();

        let mut batch = match self.batch.take() {
            Some(b) => b,
            None => {
                // No batch yet, just convert adds
                let b = arrow_bridge::locations_to_batch(&self.overlay.adds);
                self.clear_overlay();
                self.batch = Some(b);
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
                let take_idx = arrow_array::UInt32Array::from(keep);
                batch = RecordBatch::try_new(
                    batch.schema(),
                    batch
                        .columns()
                        .iter()
                        .map(|col| arrow_select::take::take(col.as_ref(), &take_idx, None).unwrap())
                        .collect(),
                )
                .unwrap();
            }
        }

        // Step 2: apply patches column-wise (preserves row order for sorted ID invariant)
        if !self.overlay.patches.is_empty() {
            batch = arrow_bridge::patch_batch(&batch, &self.overlay.patches);
        }

        // Step 3: concat adds
        if !self.overlay.adds.is_empty() {
            let add_batch = arrow_bridge::locations_to_batch(&self.overlay.adds);
            let s = schema();
            batch = arrow_select::concat::concat_batches(&s, &[batch, add_batch])
                .expect("concat failed");
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
    ($webview:expr, $state:expr, |$store:ident| $body:block) => {{
        let mut mgr = $state.lock()?;
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
    /// `None` when the mutation did not change any tag count (`finish_mutation`
    /// strips it), so JS keeps its reference and consumers skip re-rendering.
    pub tag_counts: Option<HashMap<u32, usize>>,
    pub known_field_keys: Vec<String>,
}

/// Result of `store_save_dirty`: bytes written to the delta sidecar (0 = skipped).
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub saved_bytes: usize,
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
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
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
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

/// Selection bitmask sync payload. `bitmask` carries the packed per-cell bitmask bytes
/// inline in the IPC response (no shared temp file → no clobber race under concurrent
/// mutations). `None` when nothing changed. `counts` gives per-selection match counts.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SelectionSync {
    /// Resolved count per selection node, keyed by `Selection.key` (top-level and nested).
    pub counts: HashMap<String, u32>,
    pub bitmask: Option<Vec<u8>>,
    pub selected_count: usize,
}

/// Unified response for every mutation IPC. Bundles the store status, render delta,
/// optional selection sync, optional newly-discovered extra-field keys, and optional
/// updated tags. JS applies all of these atomically to stay in sync with the Rust state.
/// `new_field_defs` carries the inferred/known field definitions for extra-field keys
/// discovered for the first time in this mutation. JS merges them straight into the
/// field-def registry, so field metadata is live without a reload.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    #[serde(flatten)]
    pub status: StoreStatus,
    pub delta: RenderDelta,
    pub selection_sync: Option<SelectionSync>,
    pub new_field_defs: Option<HashMap<String, map_meta::ExtraFieldDef>>,
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
/// `extra` is a JSON Merge Patch (RFC 7386): keys shallow-merge, null values delete.
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
    #[serde(default, deserialize_with = "nullable")]
    #[specta(type = Option<Option<String>>)]
    pub provider: Option<Option<String>>,
    pub flags: Option<u32>,
    pub tags: Option<Vec<u32>>,
    #[serde(default, deserialize_with = "nullable")]
    #[specta(type = Option<Option<specta_typescript::Any>>)]
    pub extra: Option<Option<crate::types::RawExtra>>,
    pub created_at: Option<u32>,
    #[serde(default, deserialize_with = "nullable")]
    #[specta(type = Option<Option<u32>>)]
    pub modified_at: Option<Option<u32>>,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Load a map's Arrow data from disk, rebuild all indexes, and return initial state
/// (tag counts, undo/redo availability). Must be called before any other store commands.
#[tauri::command]
#[specta::specta]
pub async fn store_open_map(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    map_id: String,
) -> AppResult<StoreStatus> {
    let map_id2 = map_id.clone();

    let result = tokio::task::spawn_blocking(move || {
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
                let (b, h) = storage::read_arrow_ipc_mmap(&path)?;
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
            let delta = if delta_path.exists() {
                match std::fs::read(&delta_path) {
                    Ok(d) => match rmp_serde::from_slice::<DeltaOverlay>(&d) {
                        Ok(parsed) => Some(parsed),
                        Err(e) => {
                            log::warn!("[store_open] delta parse failed, ignoring: {e}");
                            None
                        }
                    },
                    Err(e) => {
                        log::warn!("[store_open] delta read failed, ignoring: {e}");
                        None
                    }
                }
            } else {
                None
            };
            (batch, handle, delta)
        };

        // Ensure sorted ID invariant (one-time migration for pre-Phase2 files)
        let (batch, mmap_handle) = {
            let ids = col_id(&batch);
            let sorted = (1..batch.num_rows()).all(|i| ids.value(i - 1) < ids.value(i));
            if sorted || batch.num_rows() == 0 {
                (batch, mmap_handle)
            } else {
                log::info!("[store_open] migrating unsorted Arrow file to sorted ID order");
                let sort_idx = arrow_ord::sort::sort_to_indices(ids, None, None)?;
                let sorted_batch = RecordBatch::try_new(
                    batch.schema(),
                    batch
                        .columns()
                        .iter()
                        .map(|col| arrow_select::take::take(col.as_ref(), &sort_idx, None).unwrap())
                        .collect(),
                )
                .unwrap();
                drop(batch);
                drop(mmap_handle);
                let path = storage::arrow_path(&map_id2)?;
                storage::write_arrow_ipc(&path, &sorted_batch)?;
                drop(sorted_batch);
                let (b, h) = storage::read_arrow_ipc_mmap(&path)?;
                log::info!("[store_open] migration complete, re-mmap'd sorted file");
                (b, Some(h))
            }
        };

        let n = batch.num_rows();
        let max_id = if n > 0 {
            col_id(&batch).value(n - 1)
        } else {
            0
        };

        let (undo, redo) = load_edit_history_inner(&map_id2)?;

        log::debug!("[store_open] TOTAL={}ms", t_total.elapsed().as_millis());
        Ok::<_, AppError>((batch, mmap_handle, max_id, undo, redo, delta))
    })
    .await??;

    let (batch, mmap_handle, max_id, undo, redo, delta) = result;

    let mut store = Store::new();
    store.bump();
    store.map_id = Some(map_id.clone());
    store.batch = Some(batch);
    store.mmap_handle = mmap_handle;

    // Load uncommitted edits into the overlay; the base batch stays at the last commit.
    if let Some(d) = delta {
        store.overlay.dead = d.dead_ids.into_iter().collect();
        for p in d.patches {
            store.overlay.patches.insert(p.id, p);
        }
        store.overlay.adds = d.adds; // persisted in sorted-id order
        store.overlay.dirty = true;
    }
    store.next_id = seed_next_id(max_id, &store.overlay.adds, &undo, &redo);

    let LocationAggregates {
        alive,
        tag_counts,
        bounds,
    } = store.scan_locations();
    store.alive_count = alive;
    store.bounds_cache = bounds;
    store.bounds_dirty = false;
    {
        let conn = storage::open_db()?;
        conn.execute(
            "UPDATE maps SET location_count = ?1 WHERE id = ?2",
            rusqlite::params![alive, map_id],
        )?;
        let mut tags = read_tags_json(&conn, &map_id);
        for tag in tags.values_mut() {
            tag.count = 0;
        }
        let mut max_tag_id: u32 = tags.keys().max().copied().unwrap_or(0);
        for (&tid, &count) in &tag_counts {
            if tid > max_tag_id {
                max_tag_id = tid;
            }
            match tags.get_mut(&tid) {
                Some(tag) => tag.count = count,
                None => {
                    tags.insert(
                        tid,
                        Tag {
                            id: tid,
                            name: format!("Tag {}", tid),
                            color: util::color_for_name(&format!("Tag {}", tid)),
                            visible: true,
                            order: None,
                            count,
                        },
                    );
                }
            }
        }
        store.tags.all = tags;
        store.tags.dirty = false;
        store.tags.next_id = max_tag_id + 1;
        store.rebuild_tag_sets();
        let extra_str: String = conn
            .query_row(
                "SELECT extra FROM maps WHERE id = ?1",
                rusqlite::params![map_id],
                |row| row.get(0),
            )
            .unwrap_or_default();
        let extra: map_meta::MapExtra = serde_json::from_str(&extra_str).unwrap_or_default();
        store.known_field_keys = extra
            .fields
            .as_ref()
            .map(|f| f.keys().cloned().collect())
            .unwrap_or_default();
    }
    store.edits.undo = undo;
    store.edits.redo = redo;

    let status = store.store_status();
    let mut mgr = state.lock()?;
    mgr.window_map
        .insert(webview.label().to_string(), map_id.clone());
    mgr.stores.insert(map_id, store);
    Ok(status)
}

/// Close the current map: bake overlay, flush Arrow + tags + edit history to disk, then
/// release all in-memory state (batch, mmap, indexes, selections, undo stacks).
#[tauri::command]
#[specta::specta]
pub fn store_close_map(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
) -> AppResult<()> {
    let mut mgr = state.lock()?;
    let label = webview.label().to_string();
    let map_id = match mgr.window_map.remove(&label) {
        Some(id) => id,
        None => return Ok(()),
    };
    let still_open = mgr.window_map.values().any(|v| v == &map_id);
    if still_open {
        log::debug!("[close_map] {map_id} still open in another window, skipping flush");
        return Ok(());
    }
    if mgr.stores.get(&map_id).is_none() {
        log::debug!("[close_map] {map_id} has no store, nothing to flush");
    }
    if let Some(store) = mgr.stores.remove(&map_id) {
        if store.overlay.dirty {
            // Persist uncommitted edits to the delta sidecar. The base file stays pinned
            // at the last committed state -- it only advances on commit/checkout -- so the
            // overlay remains a faithful changeset-since-last-commit for the next commit.
            let bytes = overlay_delta_bytes(&store)?;
            let path = storage::arrow_delta_path(&map_id)?;
            storage::atomic_write(&path, |mut file| {
                use std::io::Write;
                file.write_all(&bytes).map_err(AppError::from)
            })?;
        }
        let count = store.alive_count;
        let conn = storage::open_db()?;
        conn.execute(
            "UPDATE maps SET location_count = ?1 WHERE id = ?2",
            rusqlite::params![count, map_id],
        )?;
        if store.tags.dirty {
            write_tags_json(&conn, &map_id, &store.tags.all)?;
        }
        save_edit_history_inner(&map_id, &store.edits.undo, &store.edits.redo)?;
        log::debug!(
            "[close_map] {map_id} flushed: undo={} redo={}",
            store.edits.undo.len(),
            store.edits.redo.len()
        );
    }
    Ok(())
}

/// Scan `extra` JSON maps for keys not yet in `known_field_keys`, persist inferred
/// field definitions to SQLite (for export and cross-session survival), and return
/// those definitions to JS via `result.new_field_defs` so they land in the live
/// field-def registry immediately (no reload needed).
pub(crate) fn auto_register_extras(
    store: &mut Store,
    extras: &[&crate::types::RawExtra],
    result: &mut MutationResult,
) {
    if extras.is_empty() {
        return;
    }
    if let Some(new_defs) = map_meta::auto_register_field_defs(&store.known_field_keys, extras) {
        apply_field_defs(store, new_defs, result);
    }
}

/// Persist newly-discovered extra-field definitions to SQLite and surface them on the
/// mutation result. Split out so callers that scan `extras` before consuming the
/// source locations (e.g. import's move-into-overlay path) can apply defs afterward.
pub(crate) fn apply_field_defs(
    store: &mut Store,
    new_defs: std::collections::HashMap<String, map_meta::ExtraFieldDef>,
    result: &mut MutationResult,
) {
    if let Some(map_id) = &store.map_id {
        if let Ok(conn) = storage::open_db() {
            let _ = map_meta::persist_field_defs(&conn, map_id, &new_defs);
        }
    }
    for key in new_defs.keys() {
        store.known_field_keys.insert(key.clone());
    }
    result.new_field_defs = Some(new_defs);
}

/// Add new locations. IDs are allocated server-side (monotonic). Records an undo entry
/// and clears the redo stack.
#[tauri::command]
#[specta::specta]
pub fn store_add_locations(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    mut locations: Vec<Location>,
) -> AppResult<MutationResult> {
    let _t = std::time::Instant::now();
    with_store!(webview, state, |store| {
        let _lock = _t.elapsed().as_millis();
        for loc in &mut locations {
            loc.id = store.alloc_id();
        }
        store.push_undo(EditEntry {
            created: locations.clone(),
            removed: Vec::new(),
        });
        store.edits.redo.clear();
        store.add_tag_counts(&locations);
        let added = locations.clone();
        for loc in locations {
            store.overlay_add(loc);
        }
        let mut result = store.finish_mutation(ChangeSet {
            added: added.clone(),
            ..Default::default()
        });
        let extras: Vec<&crate::types::RawExtra> =
            added.iter().filter_map(|l| l.extra.as_ref()).collect();
        auto_register_extras(store, &extras, &mut result);
        log::debug!(
            "[cmd] store_add_locations lock={}ms total={}ms",
            _lock,
            _t.elapsed().as_millis()
        );
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
) -> AppResult<MutationResult> {
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
        store.push_undo(EditEntry {
            created: Vec::new(),
            removed: removed_locs,
        });
        store.edits.redo.clear();

        log::debug!(
            "[cmd] store_remove_locations total={}ms ids={}",
            _t.elapsed().as_millis(),
            ids.len()
        );
        Ok(store.finish_mutation(ChangeSet {
            removed: removed_ids,
            ..Default::default()
        }))
    })
}

/// Apply partial patches to existing locations. `record_undo` defaults to true;
/// set to false for ephemeral updates (e.g., plugin-driven batch modifications
/// that manage their own undo).
#[tauri::command]
#[specta::specta]
pub async fn store_update_locations(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    updates: Vec<Update<LocationPatch>>,
    record_undo: Option<bool>,
) -> AppResult<MutationResult> {
    let record_undo = record_undo.unwrap_or(true);
    let _t = std::time::Instant::now();
    with_store!(webview, state, |store| {
        let mut updated: Vec<(Location, Location)> = Vec::with_capacity(updates.len());
        let any_tags = updates.iter().any(|u| u.patch.tags.is_some());
        let any_extras = updates.iter().any(|u| u.patch.extra.is_some());
        // TODO: overlay_update re-fetches internally; returning (old, new) would drop 2 of the
        // 3 lookups+clones per id, and the any_tags/undo blocks below re-clone the pairs again.
        // Only matters for 100k+ bulk edits.
        for u in &updates {
            if let Some(old) = store.get_loc_by_id(u.id) {
                store.overlay_update(u.id, &u.patch);
                let new_loc = store.get_loc_by_id(u.id).unwrap();
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
            store.record_update_undo(&updated);
        }
        let mut result = store.finish_mutation(ChangeSet {
            updated: updated.clone(),
            ..Default::default()
        });
        if any_extras {
            let extras: Vec<&crate::types::RawExtra> = updated
                .iter()
                .filter_map(|(_, n)| n.extra.as_ref())
                .collect();
            auto_register_extras(store, &extras, &mut result);
        }
        log::debug!(
            "[cmd] store_update_locations n={} undo={} total={}ms",
            updates.len(),
            record_undo,
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// Generic `{id, patch}` update envelope, parameterized by the patch type. Specta
/// has no `Partial<T>`, and a patch is a deliberate *subset* of patchable fields, so
/// each entity names its own patch struct (e.g. `TagPatch`) rather than deriving one.
#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Update<P> {
    pub id: u32,
    pub patch: P,
}

/// Patchable fields of a `Tag`. Subset by design: id/count/visible aren't editable here.
#[derive(serde::Deserialize, specta::Type, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct TagPatch {
    pub name: Option<String>,
    pub color: Option<String>,
}

/// Update name and/or color for one or more tags in a single mutation. A new name
/// that collides with an existing tag (case-insensitive) merges: locations remap from
/// the renamed tag to the existing one. Batched so a folder-cascade rename lands as one
/// render instead of one per tag. Returns MutationResult with `tags` populated.
#[tauri::command]
#[specta::specta]
pub async fn store_update_tags(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    updates: Vec<Update<TagPatch>>,
) -> AppResult<MutationResult> {
    let _t = std::time::Instant::now();
    with_store!(webview, state, |store| {
        let mut all_updated: Vec<(Location, Location)> = Vec::new();

        for u in &updates {
            if !store.tags.all.contains_key(&u.id) {
                continue;
            }

            let merge_target = u.patch.name.as_ref().and_then(|new_name| {
                let trimmed = new_name.trim();
                if trimmed.is_empty() {
                    return None;
                }
                let lower = trimmed.to_lowercase();
                store
                    .tags
                    .all
                    .iter()
                    .find(|(&id, t)| id != u.id && t.name.to_lowercase() == lower)
                    .map(|(&id, _)| id)
            });

            if let Some(target_id) = merge_target {
                let view = store.loc_view();
                let affected = selections::resolve(&view, &SelectionProps::Tag { tag_id: u.id });
                drop(view);

                let mut updated: Vec<(Location, Location)> = Vec::with_capacity(affected.len());
                for loc_id in &affected {
                    if let Some(old) = store.get_loc_by_id(*loc_id) {
                        let mut new_tags: Vec<u32> =
                            old.tags.iter().filter(|&&t| t != u.id).copied().collect();
                        if !new_tags.contains(&target_id) {
                            new_tags.push(target_id);
                        }
                        let mut new_loc = old.clone();
                        new_loc.tags = new_tags;
                        updated.push((old, new_loc));
                    }
                }
                all_updated.extend(store.commit_tag_update(updated).updated);
            } else if let Some(t) = store.tags.all.get_mut(&u.id) {
                if let Some(n) = &u.patch.name {
                    let trimmed = n.trim();
                    if !trimmed.is_empty() {
                        t.name = trimmed.to_string();
                    }
                }
                if let Some(c) = &u.patch.color {
                    t.color = c.clone();
                }
            }
        }

        store.tags.dirty = true;
        let mut result = store.finish_mutation(ChangeSet {
            updated: all_updated,
            ..Default::default()
        });
        result.tags = Some(store.tags.all.clone());
        log::debug!(
            "[cmd] store_update_tags n={} total={}ms",
            updates.len(),
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// Strip tags from all locations. Tags stay in `store.tags` with count=0 /
/// visible=false so undo can revive them. Returns MutationResult with `tags`.
#[tauri::command]
#[specta::specta]
pub async fn store_delete_tags(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    tag_ids: Vec<u32>,
) -> AppResult<MutationResult> {
    let _t = std::time::Instant::now();
    with_store!(webview, state, |store| {
        let tag_set: HashSet<u32> = tag_ids.iter().copied().collect();
        let view = store.loc_view();
        let mut affected_ids = HashSet::new();
        for &tid in &tag_set {
            affected_ids.extend(selections::resolve(
                &view,
                &SelectionProps::Tag { tag_id: tid },
            ));
        }
        drop(view);

        let mut updated: Vec<(Location, Location)> = Vec::with_capacity(affected_ids.len());
        for &id in &affected_ids {
            if let Some(old) = store.get_loc_by_id(id) {
                let mut new_loc = old.clone();
                new_loc.tags.retain(|t| !tag_set.contains(t));
                updated.push((old, new_loc));
            }
        }
        log::debug!(
            "[cmd] store_delete_tags n={} locs={} total={}ms",
            tag_set.len(),
            affected_ids.len(),
            _t.elapsed().as_millis()
        );
        let changeset = store.commit_tag_update(updated);
        Ok(store.finish_mutation(changeset))
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
) -> AppResult<()> {
    with_store!(webview, state, |store| {
        store.selections.active_id = id;
        Ok(())
    })
}

/// Set the default marker color used by the render delta path. Fire-and-forget from JS;
/// the JS side recolors its cell buffers in place (no full rebuild).
#[tauri::command]
#[specta::specta]
pub fn store_set_marker_color(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    color: [u8; 3],
) -> AppResult<()> {
    with_store!(webview, state, |store| {
        store.render.marker_color = color;
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
) -> AppResult<Option<Location>> {
    with_store!(webview, state, |store| { Ok(store.get_loc_by_id(id)) })
}

/// Fetch multiple locations by ID. Silently skips IDs that don't exist.
#[tauri::command]
#[specta::specta]
pub fn store_get_locations_by_ids(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    ids: Vec<u32>,
) -> AppResult<Vec<Location>> {
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
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
) -> AppResult<String> {
    with_store!(webview, state, |store| {
        let locs = store.collect_all_locations();
        let map_id_str = store.map_id.as_deref().unwrap_or("default");
        let json = serde_json::to_vec(&locs)?;
        let path = storage::temp_dir()?.join(format!("mma_all_{map_id_str}.json"));
        std::fs::write(&path, &json)?;
        Ok(path.to_string_lossy().into_owned())
    })
}

/// Count locations by country via point-in-polygon against the border dataset (no
/// network). `level` selects the border precision ("light"/"medium"/"heavy"), falling
/// back to bundled "light" if unavailable. Returns unsorted (ISO-A2 code, count) pairs.
/// Coords are gathered under the store lock, then classified after it's released.
#[tauri::command]
#[specta::specta]
pub async fn store_country_distribution(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    level: String,
) -> AppResult<Vec<(String, u32)>> {
    let coords: Vec<(f64, f64)> = with_store!(webview, state, |store| {
        let view = store.loc_view();
        let mut v = Vec::with_capacity(store.alive_count);
        view.for_each(|row| v.push((row.lat(), row.lng())));
        v
    });
    crate::borders::tally_countries(&level, &coords)
}

/// Msgpack-serialized overlay state written to the `.delta` file on autosave.
/// On next `store_open_map` it is loaded back into the overlay (the base file stays
/// pinned at the last commit); a commit bakes it into the base and deletes the file.
#[derive(serde::Serialize, serde::Deserialize)]
struct DeltaOverlay {
    adds: Vec<Location>,
    dead_ids: Vec<u32>,
    patches: Vec<Location>,
}

/// Serialize the overlay (uncommitted changes) as a `DeltaOverlay` msgpack blob.
/// This is the sidecar that lets the base file stay pinned at the last commit.
fn overlay_delta_bytes(store: &Store) -> AppResult<Vec<u8>> {
    let overlay = DeltaOverlay {
        adds: store.overlay.adds.clone(),
        dead_ids: store.overlay.dead.iter().cloned().collect(),
        patches: store.overlay.patches.values().cloned().collect(),
    };
    rmp_serde::to_vec_named(&overlay).map_err(AppError::from)
}

/// Read a map's full current state from disk = base file + uncommitted delta sidecar.
/// Use this for consumers (e.g. export) that read a map's locations directly off disk,
/// since the base file alone is only the last committed state.
pub(crate) fn read_full_state_from_disk(map_id: &str) -> AppResult<Vec<Location>> {
    let path = storage::arrow_path(map_id)?;
    // The base file may not exist for a map with no commits -- its data then lives entirely
    // in the delta sidecar, so always apply the delta below regardless.
    let mut locs = if path.exists() {
        arrow_bridge::batch_to_locations(&storage::read_arrow_ipc(&path)?)
    } else {
        Vec::new()
    };

    let delta_path = storage::arrow_delta_path(map_id)?;
    if delta_path.exists() {
        if let Ok(data) = std::fs::read(&delta_path) {
            if let Ok(delta) = rmp_serde::from_slice::<DeltaOverlay>(&data) {
                let dead: HashSet<u32> = delta.dead_ids.into_iter().collect();
                let patches: HashMap<u32, Location> =
                    delta.patches.into_iter().map(|l| (l.id, l)).collect();
                locs.retain(|l| !dead.contains(&l.id));
                for l in locs.iter_mut() {
                    if let Some(p) = patches.get(&l.id) {
                        *l = p.clone();
                    }
                }
                locs.extend(delta.adds);
            }
        }
    }
    Ok(locs)
}

/// Result of a cross-map location copy. `target_name` feeds the toast.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CopyToMapResult {
    pub copied: u32,
    pub skipped: u32,
    pub target_name: String,
}

/// Cross-map dedup: a source is a duplicate of a target location if they share a
/// panoId (when the source has one) or exact lat/lng bits (pano-less sources).
/// Makes the copy hotkey idempotent; fuzzy spatial matching stays the job of the
/// in-map Duplicates selection.
pub(crate) fn split_new_locations(
    sources: Vec<Location>,
    existing: &[Location],
) -> (Vec<Location>, u32) {
    let mut panos: HashSet<&str> = HashSet::new();
    let mut coords: HashSet<(u64, u64)> = HashSet::new();
    for l in existing {
        if let Some(p) = &l.pano_id {
            if !p.is_empty() {
                panos.insert(p.as_str());
            }
        }
        coords.insert((l.lat.to_bits(), l.lng.to_bits()));
    }
    let mut fresh = Vec::new();
    let mut skipped = 0u32;
    for l in sources {
        let dup = match &l.pano_id {
            Some(p) if !p.is_empty() => panos.contains(p.as_str()),
            _ => coords.contains(&(l.lat.to_bits(), l.lng.to_bits())),
        };
        if dup {
            skipped += 1;
        } else {
            fresh.push(l);
        }
    }
    (fresh, skipped)
}

/// Merge `source_tags` into `target_tags` by case-insensitive name matching:
/// matches remap to the existing target id; misses are inserted as a clone of
/// the source tag (count reset) under a fresh id from `next_id`. Returns the
/// `{source_id -> target_id}` remap table and whether `target_tags` changed.
/// Single source of truth for tag reconciliation — used by import and
/// cross-map copy.
///
/// Order semantics: source order values are never stored verbatim. Every
/// ordered source tag whose target has no order yet (newly created, or an
/// existing tag with `order: None`) is appended after the target's max order,
/// dense, sorted by (source order, name). Targets with a concrete order keep
/// it; unordered source tags stay unordered.
pub(crate) fn reconcile_tags_by_name(
    source_tags: &[Tag],
    target_tags: &mut HashMap<u32, Tag>,
    next_id: &mut u32,
) -> (HashMap<u32, u32>, bool) {
    let mut name_to_id: HashMap<String, u32> = target_tags
        .values()
        .map(|t| (t.name.to_lowercase(), t.id))
        .collect();
    let mut remap: HashMap<u32, u32> = HashMap::new();
    let mut created = false;
    let mut claims: Vec<(u32, u32, String)> = Vec::new();
    let mut claimed: std::collections::HashSet<u32> = std::collections::HashSet::new();
    for tag in source_tags {
        let lower = tag.name.to_lowercase();
        let target_id = match name_to_id.get(&lower) {
            Some(&id) => id,
            None => {
                let id = *next_id;
                *next_id += 1;
                target_tags.insert(
                    id,
                    Tag {
                        id,
                        count: 0,
                        order: None,
                        ..tag.clone()
                    },
                );
                name_to_id.insert(lower.clone(), id);
                created = true;
                id
            }
        };
        if let Some(src_order) = tag.order {
            if target_tags[&target_id].order.is_none() && claimed.insert(target_id) {
                claims.push((target_id, src_order, lower));
            }
        }
        remap.insert(tag.id, target_id);
    }
    claims.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.2.cmp(&b.2)));
    let changed = created || !claims.is_empty();
    let mut next_order = target_tags
        .values()
        .filter_map(|t| t.order)
        .max()
        .map_or(1, |m| m + 1);
    for (id, _, _) in claims {
        target_tags.get_mut(&id).unwrap().order = Some(next_order);
        next_order += 1;
    }
    (remap, changed)
}

/// Copy locations from the current window's map into another map (routing
/// hotkeys). Duplicates in the target are skipped (`split_new_locations`).
/// Tags carry over import-style (`reconcile_copied_tags`), extras carry with
/// field defs auto-registered in the target; timestamps are fresh. If the
/// target is open (any window), its live store is mutated and a
/// `store-external-mutation` event tells its windows to resync; either way
/// the result is persisted immediately (delta sidecar + tags + count).
#[tauri::command]
#[specta::specta]
pub fn store_copy_locations_to_map(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    target_map_id: String,
    ids: Vec<u32>,
) -> AppResult<CopyToMapResult> {
    let _t = std::time::Instant::now();
    let conn = storage::open_db()?;
    let target_name: String = conn.query_row(
        "SELECT name FROM maps WHERE id = ?1",
        [&target_map_id],
        |r| r.get(0),
    )?;

    // The manager lock is held for both paths: it serializes the closed-path
    // delta-file rewrite against a concurrent store_open_map of the same map.
    let mut mgr = state.lock()?;
    let source_map_id = mgr.map_id_for_window(webview.label())?;
    if source_map_id == target_map_id {
        return Err(AppError("cannot copy a location into its own map".into()));
    }

    let now = crate::util::now_unix();
    let mut sources: Vec<Location> = Vec::new();
    let mut source_tags: HashMap<u32, Tag> = HashMap::new();
    {
        let src = mgr.store_for_map(&source_map_id)?;
        for &id in &ids {
            if let Some(mut loc) = src.get_loc_by_id(id) {
                loc.created_at = now;
                loc.modified_at = Some(now);
                for &t in &loc.tags {
                    if let Some(tag) = src.tags.all.get(&t) {
                        source_tags.insert(t, tag.clone());
                    }
                }
                sources.push(loc);
            }
        }
    }
    if sources.is_empty() {
        return Ok(CopyToMapResult {
            copied: 0,
            skipped: 0,
            target_name,
        });
    }

    let used_tags = |fresh: &[Location]| -> Vec<Tag> {
        let used: HashSet<u32> = fresh.iter().flat_map(|l| l.tags.iter().copied()).collect();
        used.iter()
            .filter_map(|id| source_tags.get(id).cloned())
            .collect()
    };

    if mgr.stores.contains_key(&target_map_id) {
        // Target open in some window: insert through the import path (reconcile,
        // id alloc, counts, field defs, undo, render cells) and emit the resulting
        // MutationResult. The receiving window applies it via the same mutate() flow
        // as a local edit — including the save — so we do NOT persist here.
        let target = mgr.store_for_map(&target_map_id)?;
        let t_scan = std::time::Instant::now();
        let existing = target.collect_scoped(None);
        let (fresh, skipped) = split_new_locations(sources, &existing);
        let scan_ms = t_scan.elapsed().as_millis();
        let copied = fresh.len() as u32;
        if copied > 0 {
            let tags = used_tags(&fresh);
            let t_add = std::time::Instant::now();
            let result = crate::import::add_copied_to_store(target, fresh, tags)?;
            // Force tags dirty so the receiving window's autosave flushes the bumped
            // counts even when no new tag was created.
            target.tags.dirty = true;
            log::debug!(
                "[cmd] store_copy_locations_to_map open-target scan={}ms add={}ms total={}ms",
                scan_ms,
                t_add.elapsed().as_millis(),
                _t.elapsed().as_millis()
            );
            // Ship the full MutationResult (+ target map id for routing) on the event.
            let mut payload = serde_json::to_value(&result)?;
            if let Some(obj) = payload.as_object_mut() {
                obj.insert(
                    "mapId".into(),
                    serde_json::Value::String(target_map_id.clone()),
                );
            }
            crate::emit_event("store-external-mutation", payload);
        }
        return Ok(CopyToMapResult {
            copied,
            skipped,
            target_name,
        });
    }

    // Target closed: append to the uncommitted delta sidecar (what autosave writes).
    let t_read = std::time::Instant::now();
    let existing = read_full_state_from_disk(&target_map_id)?;
    let read_ms = t_read.elapsed().as_millis();
    let (mut fresh, skipped) = split_new_locations(sources, &existing);
    let copied = fresh.len() as u32;
    if copied > 0 {
        let mut target_tags = read_tags_json(&conn, &target_map_id);
        let mut next_tag = target_tags.keys().max().copied().unwrap_or(0) + 1;
        let (remap, _) =
            reconcile_tags_by_name(&used_tags(&fresh), &mut target_tags, &mut next_tag);
        for loc in &mut fresh {
            loc.tags = loc
                .tags
                .iter()
                .filter_map(|t| remap.get(t).copied())
                .collect();
            for t in &loc.tags {
                if let Some(tag) = target_tags.get_mut(t) {
                    tag.count += 1;
                }
            }
        }

        // Register any extra-field defs the copies introduce. `persist_field_defs`
        // skips keys the target already defines, so an empty known-set is safe.
        {
            let extras: Vec<&crate::types::RawExtra> =
                fresh.iter().filter_map(|l| l.extra.as_ref()).collect();
            if let Some(defs) =
                map_meta::auto_register_field_defs(&HashSet::<String>::new(), &extras)
            {
                map_meta::persist_field_defs(&conn, &target_map_id, &defs)?;
            }
        }

        let t_hist = std::time::Instant::now();
        let (undo, redo) = load_edit_history_inner(&target_map_id)?;
        let hist_ms = t_hist.elapsed().as_millis();
        let base_max = existing.iter().map(|l| l.id).max().unwrap_or(0);
        let next = seed_next_id(base_max, &[], &undo, &redo);
        for (loc, id) in fresh.iter_mut().zip(next..) {
            loc.id = id;
        }
        let t_save = std::time::Instant::now();
        let delta_path = storage::arrow_delta_path(&target_map_id)?;
        let mut delta: DeltaOverlay = if delta_path.exists() {
            rmp_serde::from_slice(&std::fs::read(&delta_path)?)?
        } else {
            DeltaOverlay {
                adds: Vec::new(),
                dead_ids: Vec::new(),
                patches: Vec::new(),
            }
        };
        delta.adds.extend(fresh);
        let bytes = rmp_serde::to_vec_named(&delta)?;
        let alive = existing.len() + copied as usize;
        persist_dirty_inner(
            &target_map_id,
            Some(bytes),
            alive,
            Some(serialize_tags_json(&target_tags)),
        )?;
        log::debug!("[cmd] store_copy_locations_to_map closed-target read={}ms history={}ms save={}ms total={}ms",
            read_ms, hist_ms, t_save.elapsed().as_millis(), _t.elapsed().as_millis());
    }
    Ok(CopyToMapResult {
        copied,
        skipped,
        target_name,
    })
}

/// Write a map's dirty state: delta sidecar (if any), location count, and tags
/// JSON (if any). Sync core shared by `store_save_dirty` and cross-map copy.
pub(crate) fn persist_dirty_inner(
    map_id: &str,
    delta_data: Option<Vec<u8>>,
    alive: usize,
    tags_json: Option<String>,
) -> AppResult<()> {
    if let Some(delta_data) = delta_data {
        let path = storage::arrow_delta_path(map_id)?;
        storage::atomic_write(&path, |mut file| {
            use std::io::Write;
            file.write_all(&delta_data).map_err(AppError::from)
        })?;
    }
    let conn = storage::open_db()?;
    conn.execute(
        "UPDATE maps SET location_count = ?1 WHERE id = ?2",
        rusqlite::params![alive, map_id],
    )?;
    if let Some(tags_json) = tags_json {
        conn.execute(
            "UPDATE maps SET tags = ?1 WHERE id = ?2",
            rusqlite::params![tags_json, map_id],
        )?;
    }
    Ok(())
}

/// Autosave: serialize the overlay (uncommitted changes) to the delta sidecar, plus
/// dirty tags and the location count. Skips entirely when nothing changed since the
/// last save. Does NOT bake the overlay — `store_commit` does the full merge.
/// `overlay.dirty` is cleared only after the write lands, and only if the overlay
/// wasn't mutated while the write was in flight (rev guard), so a failed or raced
/// save keeps the data flagged for the next attempt.
#[tauri::command]
#[specta::specta]
pub async fn store_save_dirty(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
) -> AppResult<SaveResult> {
    let _t = std::time::Instant::now();
    log::debug!("[cmd] store_save_dirty ENTER");
    let (map_id, delta_data, alive, tags_json, rev) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_window(webview.label())?;
        let map_id = store.map_id.clone().ok_or("no map open")?;
        if !store.overlay.dirty && !store.tags.dirty {
            return Ok(SaveResult { saved_bytes: 0 });
        }
        let delta_data = store
            .overlay
            .dirty
            .then(|| overlay_delta_bytes(store))
            .transpose()?;
        let tags_json = if store.tags.dirty {
            store.tags.dirty = false;
            Some(serialize_tags_json(&store.tags.all))
        } else {
            None
        };
        (
            map_id,
            delta_data,
            store.alive_count,
            tags_json,
            store.overlay.rev,
        )
    };

    let size = delta_data.as_ref().map_or(0, |d| d.len());
    let wrote_delta = delta_data.is_some();
    let map_id2 = map_id.clone();
    tokio::task::spawn_blocking(move || {
        persist_dirty_inner(&map_id2, delta_data, alive, tags_json)
    })
    .await??;

    if wrote_delta {
        let mut mgr = state.lock()?;
        // The window may have closed or switched maps during the write; the map_id
        // check stops a fresh store (rev 0) from being cleared by a stale save.
        if let Ok(store) = mgr.store_for_window(webview.label()) {
            if store.overlay.rev == rev && store.map_id.as_deref() == Some(map_id.as_str()) {
                store.overlay.dirty = false;
            }
        }
    }

    log::debug!(
        "[cmd] store_save_dirty total={}ms size={}",
        _t.elapsed().as_millis(),
        size
    );
    Ok(SaveResult { saved_bytes: size })
}

/// Lightweight status query: location count, version, and dirty flag.
#[tauri::command]
#[specta::specta]
pub fn store_get_summary(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
) -> AppResult<SummaryResult> {
    let _t = std::time::Instant::now();
    with_store!(webview, state, |store| {
        let count = store.alive_count;
        log::debug!(
            "[cmd] store_get_summary total={}ms alive_count={}",
            _t.elapsed().as_millis(),
            count
        );
        Ok(SummaryResult {
            location_count: count,
            version: store.version,
            dirty_count: if store.overlay.dirty { 1 } else { 0 },
        })
    })
}

/// Persist undo/redo stacks to SQLite as msgpack blobs, capped at MAX_UNDO_ENTRIES.
fn save_edit_history_inner(map_id: &str, undo: &[EditEntry], redo: &[EditEntry]) -> AppResult<()> {
    let conn = storage::open_db()?;
    let undo_capped = if undo.len() > MAX_UNDO_ENTRIES {
        &undo[undo.len() - MAX_UNDO_ENTRIES..]
    } else {
        undo
    };
    let redo_capped = if redo.len() > MAX_UNDO_ENTRIES {
        &redo[redo.len() - MAX_UNDO_ENTRIES..]
    } else {
        redo
    };
    let undo_bytes = rmp_serde::to_vec_named(undo_capped)?;
    let redo_bytes = rmp_serde::to_vec_named(redo_capped)?;
    conn.execute(
        "INSERT OR REPLACE INTO edit_history (map_id, undo_stack, redo_stack) VALUES (?1, ?2, ?3)",
        rusqlite::params![map_id, undo_bytes, redo_bytes],
    )?;
    Ok(())
}

/// Highest location id referenced anywhere in the undo/redo stacks. Used to seed
/// `next_id` on map open so undo/redo replay can never collide with a fresh allocation.
pub(crate) fn history_max_id(undo: &[EditEntry], redo: &[EditEntry]) -> u32 {
    undo.iter()
        .chain(redo.iter())
        .flat_map(|e| e.created.iter().chain(e.removed.iter()))
        .map(|l| l.id)
        .max()
        .unwrap_or(0)
}

/// Open-time `next_id` seed. Must exceed every id the system can re-materialize:
/// base rows, uncommitted overlay adds, and ids replayable from persisted undo/redo
/// (replay resurrects locations with their original ids; re-allocating one would
/// create a duplicate and break the strictly-sorted bake invariant).
pub(crate) fn seed_next_id(
    base_max: u32,
    adds: &[Location],
    undo: &[EditEntry],
    redo: &[EditEntry],
) -> u32 {
    let max_add = adds.iter().map(|l| l.id).max().unwrap_or(0);
    base_max.max(max_add).max(history_max_id(undo, redo)) + 1
}

/// Load undo/redo stacks from SQLite. Returns empty stacks if no history exists.
fn load_edit_history_inner(map_id: &str) -> AppResult<(Vec<EditEntry>, Vec<EditEntry>)> {
    let conn = storage::open_db()?;
    let result = conn.query_row(
        "SELECT undo_stack, redo_stack FROM edit_history WHERE map_id = ?1",
        [map_id],
        |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?)),
    );
    match result {
        Ok((undo_bytes, redo_bytes)) => {
            let undo: Vec<EditEntry> = rmp_serde::from_slice(&undo_bytes).unwrap_or_else(|e| {
                log::warn!("[load_edit_history] {map_id} undo stack deserialize failed: {e}");
                Vec::new()
            });
            let redo: Vec<EditEntry> = rmp_serde::from_slice(&redo_bytes).unwrap_or_else(|e| {
                log::warn!("[load_edit_history] {map_id} redo stack deserialize failed: {e}");
                Vec::new()
            });
            log::debug!(
                "[load_edit_history] {map_id} loaded: undo={} redo={}",
                undo.len(),
                redo.len()
            );
            Ok((undo, redo))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            log::debug!("[load_edit_history] {map_id} no row");
            Ok((Vec::new(), Vec::new()))
        }
        Err(e) => Err(e.into()),
    }
}

/// Write the current batch to disk as Arrow IPC and remove any stale delta file.
pub(crate) fn save_arrow_inner(store: &Store, map_id: &str) -> AppResult<()> {
    if let Some(ref batch) = store.batch {
        let path = storage::arrow_path(map_id)?;
        storage::write_arrow_ipc(&path, batch)?;
        let delta = storage::arrow_delta_path(map_id)?;
        let _ = std::fs::remove_file(delta);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// VCS: snapshot / restore Arrow files
// ---------------------------------------------------------------------------

/// Bake the overlay into the base batch, write it to disk, re-mmap, and flush
/// location count + dirty tags. Used by `store_commit` so a commit builds
/// the batch only once.
pub(crate) fn bake_and_save_inner(store: &mut Store, map_id: &str) -> AppResult<()> {
    let _t = std::time::Instant::now();
    store.bake_overlay();
    let t_bake = _t.elapsed();
    store.mmap_handle = None;
    save_arrow_inner(store, map_id)?;
    let t_write = _t.elapsed();
    let path = storage::arrow_path(map_id)?;
    if path.exists() {
        let (batch, handle) = storage::read_arrow_ipc_mmap(&path)?;
        store.batch = Some(batch);
        store.mmap_handle = Some(handle);
    }
    let t_mmap = _t.elapsed();
    log::debug!(
        "[bake_and_save] bake={:.0}ms base-write={:.0}ms remmap={:.0}ms total={:.0}ms",
        t_bake.as_millis(),
        (t_write - t_bake).as_millis(),
        (t_mmap - t_write).as_millis(),
        _t.elapsed().as_millis()
    );
    let count = store.batch.as_ref().map_or(0, |b| b.num_rows());
    let conn = storage::open_db()?;
    conn.execute(
        "UPDATE maps SET location_count = ?1 WHERE id = ?2",
        rusqlite::params![count, map_id],
    )?;
    if store.tags.dirty {
        write_tags_json(&conn, map_id, &store.tags.all)?;
        store.tags.dirty = false;
    }
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
    pub marker_color: Option<[u8; 3]>,
}

/// Maps below this render full detail — no LOD section in the blob.
/// Mirrors LOD_MIN_TOTAL in CellManager.ts — keep in sync.
const LOD_MIN_TOTAL: usize = 50_000;

/// Finest-band aggregation-LOD rep indices for one cell's `[lng, lat]` f32 pairs.
/// Mirrors `decimateBand` in CellManager.ts (keep in sync): position-only binning
/// on a 12px grid at zoom 12, representative = highest index in the bin (painter's
/// topmost). Bins nest exactly 2x per zoom band, so JS derives every coarser band
/// from this list. Transcendental rounding may differ from JS by an ulp on exact
/// bin boundaries — both results are valid decimations.
pub(crate) fn lod_finest_reps(positions: &[f32]) -> Vec<u32> {
    use std::collections::hash_map::Entry;
    const INV: f64 = 256.0 * 4096.0 / 12.0; // worldPx at maxZoom 12 / binPx 12
    let n = positions.len() / 2;
    let mut bins: HashMap<i64, usize> = HashMap::with_capacity(n);
    let mut reps: Vec<u32> = Vec::new();
    for i in 0..n {
        let lng = positions[i * 2] as f64;
        let lat = positions[i * 2 + 1] as f64;
        let siny = (lat * std::f64::consts::PI / 180.0)
            .sin()
            .clamp(-0.9999, 0.9999);
        let bx = ((lng / 360.0 + 0.5) * INV).floor() as i64;
        let by = ((0.5 - ((1.0 + siny) / (1.0 - siny)).ln() / (4.0 * std::f64::consts::PI)) * INV)
            .floor() as i64;
        let key = by * 131072 + bx;
        match bins.entry(key) {
            Entry::Occupied(e) => reps[*e.get()] = i as u32, // ascending i: topmost wins
            Entry::Vacant(e) => {
                e.insert(reps.len());
                reps.push(i as u32);
            }
        }
    }
    reps
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
    let color_map = store.selections.color_map();
    let active_id = store.selections.active_id;
    let arrow_style = req.marker_style == "arrow";
    let mc = store.render.marker_color;
    let base_color = [mc[0], mc[1], mc[2], 255u8];

    // 32 cells indexed by render_cell_idx (0-31)
    struct CellOut {
        ids: Vec<u32>,
        positions: Vec<f32>,
        colors: Vec<u8>,
        angles: Vec<f32>,
    }
    const NONE: Option<CellOut> = None;
    let mut cells: [Option<CellOut>; 32] = [NONE; 32];

    // Selection overlay: selected entries rendered as a separate colored layer
    struct SelOverlay {
        ids: Vec<u32>,
        positions: Vec<f32>,
        colors: Vec<u8>,
        angles: Vec<f32>,
    }
    let mut sel_ov = SelOverlay {
        ids: Vec::new(),
        positions: Vec::new(),
        colors: Vec::new(),
        angles: Vec::new(),
    };

    // Single linear pass over batch rows (cache-friendly)
    for i in 0..batch_n {
        let id = ids_col.value(i);
        if has_dead && store.overlay.dead.contains(&id) {
            continue;
        }
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
            ids: Vec::new(),
            positions: Vec::new(),
            colors: Vec::new(),
            angles: Vec::new(),
        });
        out.positions.push(lng as f32);
        out.positions.push(lat as f32);
        let angle = if arrow_style { -(heading as f32) } else { 0.0 };
        let is_hidden = selected_set.contains(id) || active_id == Some(id);
        if is_hidden {
            out.colors.extend_from_slice(&[0, 0, 0, 0]);
        } else {
            out.colors.extend_from_slice(&base_color);
        }
        out.angles.push(angle);
        out.ids.push(id);
        if let Some(&[r, g, b]) = color_map.get(&id) {
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
            ids: Vec::new(),
            positions: Vec::new(),
            colors: Vec::new(),
            angles: Vec::new(),
        });
        let id = loc.id;
        let is_hidden = selected_set.contains(id) || active_id == Some(id);
        out.positions.push(loc.lng as f32);
        out.positions.push(loc.lat as f32);
        let angle = if arrow_style {
            -(loc.heading as f32)
        } else {
            0.0
        };
        if is_hidden {
            out.colors.extend_from_slice(&[0, 0, 0, 0]);
        } else {
            out.colors.extend_from_slice(&base_color);
        }
        out.angles.push(angle);
        out.ids.push(id);
        if let Some(&[r, g, b]) = color_map.get(&id) {
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
        let out = match &cells[ci] {
            Some(o) => o,
            None => continue,
        };
        let mut cr = CellRender {
            id_order: Vec::with_capacity(out.ids.len()),
            id_to_index: HashMap::new(),
        };
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
    let body_cap: usize = (0..32)
        .filter_map(|ci| cells[ci].as_ref())
        .map(|o| 5 + o.ids.len() * 4 + o.positions.len() * 4 + o.colors.len() + o.angles.len() * 4)
        .sum();
    let sel_cap = if sel_ov.ids.is_empty() {
        0
    } else {
        sel_ov.positions.len() * 4
            + sel_ov.colors.len()
            + sel_ov.angles.len() * 4
            + sel_ov.ids.len() * 4
    };
    let mut buf = Vec::with_capacity(4 + body_cap + 4 + sel_cap);
    buf.extend_from_slice(&non_empty.to_le_bytes());
    for ci in 0..32 {
        let out = match &cells[ci] {
            Some(o) => o,
            None => continue,
        };
        let count = out.ids.len() as u32;
        buf.push(BASE32[ci]);
        buf.extend_from_slice(&count.to_le_bytes());
        for &id in &out.ids {
            buf.extend_from_slice(&id.to_le_bytes());
        }
        for &v in &out.positions {
            buf.extend_from_slice(&v.to_le_bytes());
        }
        buf.extend_from_slice(&out.colors);
        for &v in &out.angles {
            buf.extend_from_slice(&v.to_le_bytes());
        }
    }

    // Selection overlay: [u32 count][f32[] positions][u8[] colors][f32[] angles][u32[] ids]
    let sel_count = sel_ov.ids.len() as u32;
    buf.extend_from_slice(&sel_count.to_le_bytes());
    if sel_count > 0 {
        for &v in &sel_ov.positions {
            buf.extend_from_slice(&v.to_le_bytes());
        }
        buf.extend_from_slice(&sel_ov.colors);
        for &v in &sel_ov.angles {
            buf.extend_from_slice(&v.to_le_bytes());
        }
        for &id in &sel_ov.ids {
            buf.extend_from_slice(&id.to_le_bytes());
        }
    }

    // Finest-band LOD reps: [u32 repCount][u32[] indices] per non-empty cell, cells-
    // section order; repCount 0 below the LOD threshold. JS seeds its pyramid from
    // this instead of binning O(N) on the main thread.
    let lod_reps: Vec<Vec<u32>> = if total_count >= LOD_MIN_TOTAL {
        use rayon::prelude::*;
        (0..32)
            .filter_map(|ci| cells[ci].as_ref())
            .collect::<Vec<_>>()
            .par_iter()
            .map(|o| lod_finest_reps(&o.positions))
            .collect()
    } else {
        Vec::new()
    };
    if lod_reps.is_empty() {
        for _ in 0..non_empty {
            buf.extend_from_slice(&0u32.to_le_bytes());
        }
    } else {
        for reps in &lod_reps {
            buf.extend_from_slice(&(reps.len() as u32).to_le_bytes());
            for &r in reps {
                buf.extend_from_slice(&r.to_le_bytes());
            }
        }
    }

    log::debug!(
        "[cmd] build_cell_render_buffers total={}ms cells={} points={} sel_overlay={} bytes={}",
        _t.elapsed().as_millis(),
        non_empty,
        total_count,
        sel_count,
        buf.len()
    );
    buf
}

/// Full render rebuild: single-pass over all alive locations, writes binary to a temp file.
/// Returns the file path for JS to fetch via `mma-buf://`. Only called on map open or full reset.
#[tauri::command]
#[specta::specta]
pub async fn store_fill_render_file(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    req: RenderRequest,
) -> AppResult<String> {
    let (buf, map_id_str) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_window(webview.label())?;
        store.render.arrow_style = req.marker_style == "arrow";
        if let Some(mc) = req.marker_color {
            store.render.marker_color = mc;
        }
        let mid = store.map_id.clone().unwrap_or_default();
        (build_cell_render_buffers(store, &req), mid)
    };
    let path = storage::temp_dir()?.join(format!("mma_render_{map_id_str}.bin"));
    tokio::task::spawn_blocking(move || {
        std::fs::write(&path, &buf)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await?
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
) -> AppResult<Option<u32>> {
    with_store!(webview, state, |store| {
        let ci = cell_idx_from_key(&cell).ok_or("invalid cell key")?;
        Ok(store.render.cells[ci as usize]
            .as_ref()
            .and_then(|cr| cr.id_order.get(cell_index as usize).copied()))
    })
}

// ---------------------------------------------------------------------------
// Undo / Redo
// ---------------------------------------------------------------------------

/// Pop the undo stack and reverse the last edit. Pushes the entry onto the redo stack.
#[tauri::command]
#[specta::specta]
pub fn store_undo(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
) -> AppResult<MutationResult> {
    with_store!(webview, state, |store| {
        let _t = std::time::Instant::now();
        let entry = store.edits.undo.pop().ok_or("nothing to undo")?;
        log::debug!(
            "[UNDO] stack_depth={} created={} removed={}",
            store.edits.undo.len(),
            entry.created.len(),
            entry.removed.len()
        );
        let changes = apply_edit_reverse(store, &entry);
        log::debug!(
            "[UNDO] apply_edit={}ms changes: +{} ~{} -{}",
            _t.elapsed().as_millis(),
            changes.added.len(),
            changes.updated.len(),
            changes.removed.len()
        );
        store.edits.redo.push(entry);
        Ok(store.finish_mutation(changes))
    })
}

/// Pop the redo stack and replay the edit forward. Pushes the entry back onto undo.
#[tauri::command]
#[specta::specta]
pub fn store_redo(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
) -> AppResult<MutationResult> {
    with_store!(webview, state, |store| {
        let _t = std::time::Instant::now();
        let entry = store.edits.redo.pop().ok_or("nothing to redo")?;
        log::debug!(
            "[REDO] stack_depth={} created={} removed={}",
            store.edits.redo.len(),
            entry.created.len(),
            entry.removed.len()
        );
        let changes = apply_edit_forward(store, &entry);
        log::debug!(
            "[REDO] apply_edit={}ms changes: +{} ~{} -{}",
            _t.elapsed().as_millis(),
            changes.added.len(),
            changes.updated.len(),
            changes.removed.len()
        );
        store.push_undo(entry);
        Ok(store.finish_mutation(changes))
    })
}

/// Net diff since last commit for the commit dialog, derived from the overlay --
/// the same changeset `store_commit` will record. The undo stack is NOT consulted:
/// it is capped, and non-undoable edits (enrichment, field renames, plugin batches)
/// bypass it entirely while still being part of the commit.
#[tauri::command]
#[specta::specta]
pub fn store_commit_diff(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
) -> AppResult<(u32, u32, u32)> {
    with_store!(webview, state, |store| { Ok(store.overlay_diff_counts()) })
}

/// Clear both undo and redo stacks. Called after a commit to start fresh.
#[tauri::command]
#[specta::specta]
pub fn store_reset_undo(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
) -> AppResult<()> {
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

    log::debug!(
        "[apply_edit] +{} ~{} -{} in {}ms",
        changes.added.len(),
        changes.updated.len(),
        changes.removed.len(),
        t0.elapsed().as_millis()
    );
    changes
}

/// Fold a duplicate group into one survivor. Survivor = most tags, then earliest
/// `created_at`, then lowest id (`max_by` picks the greatest, so created_at/id are
/// reversed to favour smaller). Tags are set-unioned; `extra` is merged with the
/// survivor winning key conflicts; all other survivor fields are kept. `members` must
/// be non-empty. The returned survivor keeps its original id (so callers represent the
/// merge as an update of the survivor plus removal of the rest).
fn merge_group(members: &[Location]) -> Location {
    let survivor = members
        .iter()
        .max_by(|a, b| {
            a.tags
                .len()
                .cmp(&b.tags.len())
                .then_with(|| b.created_at.cmp(&a.created_at))
                .then_with(|| b.id.cmp(&a.id))
        })
        .expect("merge_group requires a non-empty group");

    let mut tagset: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    for m in members {
        tagset.extend(m.tags.iter().copied());
    }

    // Non-survivors in id order first, survivor last so its values win conflicts.
    let mut merged_extra = serde_json::Map::new();
    let mut others: Vec<&Location> = members.iter().filter(|m| m.id != survivor.id).collect();
    others.sort_by_key(|m| m.id);
    for m in others {
        if let Some(e) = &m.extra {
            for (k, v) in e.to_map() {
                merged_extra.insert(k, v);
            }
        }
    }
    if let Some(e) = &survivor.extra {
        for (k, v) in e.to_map() {
            merged_extra.insert(k, v);
        }
    }

    let mut new_survivor = survivor.clone();
    new_survivor.tags = tagset.into_iter().collect();
    new_survivor.extra = crate::types::RawExtra::from_map(&merged_extra);
    new_survivor.modified_at = Some(crate::util::now_unix());
    new_survivor
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
    let json: String = conn
        .query_row("SELECT tags FROM maps WHERE id = ?1", [map_id], |row| {
            row.get(0)
        })
        .unwrap_or_else(|_| "{}".into());
    let raw: HashMap<String, Tag> = serde_json::from_str(&json).unwrap_or_default();
    raw.into_iter()
        .filter_map(|(k, v)| k.parse::<u32>().ok().map(|id| (id, v)))
        .collect()
}

/// Serialize tags to JSON with string keys (SQLite stores them this way).
fn serialize_tags_json(tags: &HashMap<u32, Tag>) -> String {
    let as_str_keys: HashMap<String, &Tag> = tags.iter().map(|(k, v)| (k.to_string(), v)).collect();
    serde_json::to_string(&as_str_keys).unwrap_or_default()
}

/// Persist tags to the SQLite `maps.tags` JSON column.
pub(crate) fn write_tags_json(
    conn: &rusqlite::Connection,
    map_id: &str,
    tags: &HashMap<u32, Tag>,
) -> AppResult<()> {
    let json = serialize_tags_json(tags);
    conn.execute(
        "UPDATE maps SET tags = ?1 WHERE id = ?2",
        rusqlite::params![json, map_id],
    )?;
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
) -> AppResult<MutationResult> {
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
                let order = Some(
                    store
                        .tags
                        .all
                        .values()
                        .filter_map(|t| t.order)
                        .max()
                        .map_or(1, |m| m + 1),
                );
                let tag = Tag {
                    id,
                    name: name.clone(),
                    color,
                    visible: true,
                    order,
                    count: 0,
                };
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
            new_field_defs: None,
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
) -> AppResult<MutationResult> {
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
            new_field_defs: None,
            tags: Some(store.tags.all.clone()),
        })
    })
}

/// Compute the bounding box [west, south, east, north]. O(N).
/// When `selected_only` is true, restricts to the current selection.
#[tauri::command]
#[specta::specta]
pub async fn store_bounds(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    selected_only: bool,
) -> AppResult<Option<[f64; 4]>> {
    with_store!(webview, state, |store| {
        // Selection-scoped bounds change with the selection, so they stay O(N)
        // (zoom-to-selection hotkey, infrequent). The unscoped box is cached.
        if selected_only {
            Ok(store.compute_bounds(Some(&store.selections.ids)))
        } else {
            Ok(store.cached_bounds())
        }
    })
}

/// Return the number of alive locations (batch + adds - dead).
#[tauri::command]
#[specta::specta]
pub fn store_location_count(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
) -> AppResult<u32> {
    with_store!(webview, state, |store| { Ok(store.alive_count as u32) })
}

/// Collect all distinct values for an `extra` field across all alive locations. O(N).
/// Used by the filter UI to populate dropdown options.
#[tauri::command]
#[specta::specta]
pub fn store_extra_field_values(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    field: String,
) -> AppResult<Vec<String>> {
    let _t = std::time::Instant::now();
    with_store!(webview, state, |store| {
        let view = store.loc_view();
        let mut seen = std::collections::BTreeSet::new();
        view.for_each(|row| {
            if let Some(v) = row.resolve_field(&field) {
                let s = match v {
                    serde_json::Value::String(s) => s,
                    other => other.to_string(),
                };
                seen.insert(s);
            }
        });
        log::debug!(
            "[cmd] store_extra_field_values field={} total={}ms",
            field,
            _t.elapsed().as_millis()
        );
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
    /// Deterministic selection key (e.g. `"tag:5"`), used to return per-node counts back keyed.
    pub key: String,
    pub props: SelectionProps,
    pub color: [u8; 3],
    /// Counted, but kept out of the overlay and the selected set.
    #[serde(default)]
    pub ghosted: bool,
}

/// Replace all selections, resolve bitmasks against current data, and write a binary
/// patch file for JS to apply to the render overlay. Returns per-selection counts.
#[tauri::command]
#[specta::specta]
pub async fn store_sync_selections(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    sels: Vec<SelectionInput>,
) -> AppResult<SelectionSync> {
    let _t = std::time::Instant::now();
    let (counts, buf, selected_count, num_cells) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_window(webview.label())?;

        // Faithful tree: real keys preserved so per-node counts come back keyed (incl. nested).
        let sels_full: Vec<selections::Selection> = sels
            .iter()
            .map(|si| selections::Selection {
                key: si.key.clone(),
                color: si.color,
                props: si.props.clone(),
            })
            .collect();

        // 1. Resolve the whole forest in one pass: per-selection Roaring id-sets plus
        //    counts for every node (top-level and nested). Tag leaves hit the membership
        //    index; composites combine natively. (Geometric leaves still scan.)
        //    Counts cover ghosted selections too; the overlay uses the non-ghosted subset.
        let view = store.loc_view();
        let (sel_sets, counts) = selections::resolve_forest(&view, &sels_full);
        drop(view);

        let live: Vec<usize> = (0..sels.len()).filter(|&i| !sels[i].ghosted).collect();

        let mut all_selected = RoaringBitmap::new();
        for &i in &live {
            all_selected |= &sel_sets[i];
        }
        let selected_count = all_selected.len() as usize;

        // 3. Route selections to per-cell indices (O(selected), not O(S*N)), then
        //    serialize the per-cell bitmask binary. Cells are independent → parallel.
        let routed: Vec<[Vec<u32>; 32]> = live
            .par_iter()
            .map(|&i| selection_cell_indices(&store.render, &sel_sets[i], None))
            .collect();
        let segments: Vec<Vec<u8>> = store
            .render
            .cells
            .par_iter()
            .enumerate()
            .filter_map(|(ci, opt)| {
                let cr = opt.as_ref()?;
                Some(serialize_cell_segment(ci, cr, &routed))
            })
            .collect();
        let num_cells = segments.len();

        let buf = assemble_selection_bitmask(live.iter().map(|&i| &sels[i].color), &segments);

        store.selections.ids = all_selected;
        store.selections.all = live.iter().map(|&i| sels_full[i].clone()).collect();
        store.selections.loc_sets = sel_sets
            .into_iter()
            .enumerate()
            .filter(|(i, _)| !sels[*i].ghosted)
            .map(|(_, s)| s)
            .collect();
        store.selections.node_counts = counts.clone();
        store.selections.version += 1;

        let render_total: usize = store
            .render
            .cells
            .iter()
            .filter_map(|o| o.as_ref())
            .map(|cr| cr.id_order.len())
            .sum();
        log::debug!("[cmd] store_sync_selections total={}ms sels={} selected={} cells={} buf_size={} batch_rows={} overlay_adds={} dead={} alive={} render_total={} first_set_len={} counts={:?}",
            _t.elapsed().as_millis(), sels.len(), selected_count, num_cells, buf.len(),
            store.batch.as_ref().map_or(0, |b| b.num_rows()), store.overlay.adds.len(),
            store.overlay.dead.len(), store.alive_count, render_total,
            store.selections.loc_sets.first().map_or(0, |s| s.len() as usize), counts);

        (counts, buf, selected_count, num_cells)
    };

    let bitmask = if num_cells > 0 { Some(buf) } else { None };
    Ok(SelectionSync {
        counts,
        bitmask,
        selected_count,
    })
}

/// Return the union of all currently selected location IDs.
#[tauri::command]
#[specta::specta]
pub fn store_get_selected_ids_list(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
) -> AppResult<Vec<u32>> {
    with_store!(webview, state, |store| {
        Ok(store.selections.ids.iter().collect())
    })
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SpacedPickResult {
    pub ids: Vec<u32>,
    pub distance_m: i32,
}

/// Pick an evenly spaced subset of the current selection. Exactly one of `target_count`
/// (thin to N, maximizing spacing) or `min_distance_m` (keep as many as fit at that spacing)
/// must be provided.
#[tauri::command]
#[specta::specta]
pub fn store_pick_spaced(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    target_count: Option<u32>,
    min_distance_m: Option<u32>,
) -> AppResult<SpacedPickResult> {
    let _t = std::time::Instant::now();
    with_store!(webview, state, |store| {
        let candidate_count = store.selections.ids.len();
        let result = store.pick_spaced(target_count, min_distance_m)?;
        let mode = if target_count.is_some() {
            "count"
        } else {
            "distance"
        };
        log::debug!(
            "[cmd] store_pick_spaced mode={} candidates={} picked={} distance_m={} total={}ms",
            mode,
            candidate_count,
            result.ids.len(),
            result.distance_m,
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// Resolve a single selection to its matching location IDs without persisting it.
/// Used by plugins and one-off queries (e.g., tag merge, export filtered).
#[tauri::command]
#[specta::specta]
pub fn store_resolve_selection(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    props: SelectionProps,
) -> AppResult<Vec<u32>> {
    with_store!(webview, state, |store| {
        let view = store.loc_view();
        Ok(selections::resolve(&view, &props))
    })
}

/// Partition the (optionally scoped) location set into groups by a derived key, returning
/// compact `{ key, ids, bin }` per group — no hydrated locations. `scope` None partitions
/// the whole map; Some resolves that selection and restricts to it. Powers the gradient
/// (groups -> colored selections) and apply-as-tags (groups -> tags) surfaces without
/// materializing location data into JS.
#[tauri::command]
#[specta::specta]
pub fn store_partition(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    field: String,
    key: selections::KeySpec,
    scope: selections::Scope,
) -> AppResult<Vec<selections::PartitionBucket>> {
    with_store!(webview, state, |store| {
        let view = store.loc_view();
        let scope_set = match scope {
            selections::Scope::All => None,
            selections::Scope::Selected => Some(&store.selections.ids),
        };
        Ok(selections::partition(&view, &field, &key, scope_set))
    })
}

/// Transitive spatial duplicate groups (connected components, size >= 2) within `distance`
/// metres. Read-only; used to preview a merge. Returns groups of location IDs.
#[tauri::command]
#[specta::specta]
pub fn store_duplicate_groups(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    distance: f64,
) -> AppResult<Vec<Vec<u32>>> {
    with_store!(webview, state, |store| {
        let view = store.loc_view();
        Ok(selections::find_duplicate_groups(&view, distance))
    })
}

/// Merge each transitive duplicate group (size >= 2 within `distance` metres) into one
/// survivor. Survivor = most tags, then earliest `created_at`, then lowest id. Tags are
/// set-unioned across the group; `extra` is merged with the survivor winning key conflicts;
/// all other survivor fields are kept. Applied as a single undoable edit.
#[tauri::command]
#[specta::specta]
pub async fn store_merge_duplicates(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    distance: f64,
) -> AppResult<MutationResult> {
    let _t = std::time::Instant::now();
    with_store!(webview, state, |store| {
        let groups = {
            let view = store.loc_view();
            selections::find_duplicate_groups(&view, distance)
        };

        let mut remove: Vec<Location> = Vec::new();
        let mut create: Vec<Location> = Vec::new();

        for group in &groups {
            let members: Vec<Location> = group
                .iter()
                .filter_map(|&id| store.get_loc_by_id(id))
                .collect();
            if members.len() < 2 {
                continue;
            }
            create.push(merge_group(&members));
            for m in members {
                remove.push(m);
            }
        }

        let result = if create.is_empty() {
            store.finish_mutation(ChangeSet::default())
        } else {
            let group_count = create.len();
            let merged_away = remove.len() - create.len();
            let changes = apply_edit(store, &remove, &create);
            store.push_undo(EditEntry {
                created: create,
                removed: remove,
            });
            store.edits.redo.clear();
            log::debug!(
                "[cmd] store_merge_duplicates groups={} merged_away={} total={}ms",
                group_count,
                merged_away,
                _t.elapsed().as_millis()
            );
            store.finish_mutation(changes)
        };
        Ok(result)
    })
}

/// Prune duplicates among `ids` (a resolved selection) within `distance` metres:
/// <= 25m keeps the best-scored location per cluster (`keep_tag_ids` score +5, see
/// selections::prune_score); > 25m thins greedily so no two survivors remain in
/// range. Informational locations are never pruned. One undoable edit.
#[tauri::command]
#[specta::specta]
pub async fn store_prune_duplicates(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    ids: Vec<u32>,
    distance: f64,
    keep_tag_ids: Vec<u32>,
) -> AppResult<MutationResult> {
    let _t = std::time::Instant::now();
    with_store!(webview, state, |store| {
        let locs: Vec<Location> = ids
            .iter()
            .filter_map(|&id| store.get_loc_by_id(id))
            .collect();
        let keep: HashSet<u32> = keep_tag_ids.into_iter().collect();
        let prune_ids: HashSet<u32> = selections::prune_duplicates(&locs, distance, &keep)
            .into_iter()
            .collect();
        let remove: Vec<Location> = locs
            .into_iter()
            .filter(|l| prune_ids.contains(&l.id))
            .collect();

        let result = if remove.is_empty() {
            store.finish_mutation(ChangeSet::default())
        } else {
            let changes = apply_edit(store, &remove, &[]);
            store.push_undo(EditEntry {
                created: Vec::new(),
                removed: remove,
            });
            store.edits.redo.clear();
            log::debug!(
                "[cmd] store_prune_duplicates pruned={} of {} total={}ms",
                prune_ids.len(),
                ids.len(),
                _t.elapsed().as_millis()
            );
            store.finish_mutation(changes)
        };
        Ok(result)
    })
}

/// Find all locations within `radius_m` metres of (`lat`, `lng`).
///
/// Backed by the store's lazy spatial index: O(cells in radius) per query after a
/// one-time O(N) build, maintained incrementally across mutations. Called on every
/// marker click (duplicate check), so it must not scan.
#[tauri::command]
#[specta::specta]
pub fn store_find_nearby(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    lat: f64,
    lng: f64,
    radius_m: f64,
) -> AppResult<Vec<Location>> {
    with_store!(webview, state, |store| {
        let _t = std::time::Instant::now();
        let mut ids = store.find_nearby_ids(lat, lng, radius_m);
        ids.sort_unstable();
        let result: Vec<Location> = ids
            .iter()
            .filter_map(|&id| store.get_loc_by_id(id))
            .collect();
        log::debug!(
            "[cmd] store_find_nearby r={}m hits={} total={}ms",
            radius_m,
            result.len(),
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// For each input point, whether any existing location lies within `radius_m` metres.
/// Bulk form so callers probing many coordinates (e.g. the map generator skipping
/// already-covered spots) pay one IPC round-trip, not one per point.
#[tauri::command]
#[specta::specta]
pub fn store_near_any(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    lats: Vec<f64>,
    lngs: Vec<f64>,
    radius_m: f64,
) -> AppResult<Vec<bool>> {
    if lats.len() != lngs.len() {
        return Err(AppError::from("store_near_any: lats/lngs length mismatch"));
    }
    with_store!(webview, state, |store| {
        let _t = std::time::Instant::now();
        let result: Vec<bool> = lats
            .iter()
            .zip(lngs.iter())
            .map(|(&la, &ln)| store.any_within(la, ln, radius_m))
            .collect();
        log::debug!(
            "[cmd] store_near_any n={} r={}m total={}ms",
            result.len(),
            radius_m,
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

// ---------------------------------------------------------------------------
// CPU marker picking
// ---------------------------------------------------------------------------
// Replaces deck.gl GPU picking for marker layers. Coverage math mirrors the
// SDFMarkerLayer shaders (sdf-marker-fragment/vertex.glsl.ts) exactly: same
// SDFs, same unit space, same pin tip-anchor offset. Style radii mirror
// MARKER_STYLE in markerLayer.ts.

pub(crate) mod pick {
    /// Extra pixels of slop around a marker's edge (deck used pickingRadius: 2).
    pub const SLOP_PX: f64 = 2.0;
    /// The SDF circle inscribes the unit quad (radius 1.0); 6px visible radius.
    pub const CIRCLE_RADIUS_PX: f64 = 6.0;
    pub const ARROW_RADIUS_PX: f64 = 12.0;
    pub const PIN_RADIUS_PX: f64 = 16.0;

    #[derive(Clone, Copy, PartialEq)]
    pub enum Shape {
        Circle,
        Arrow,
        Pin,
    }

    pub fn shape_for_style(style: &str) -> (Shape, f64) {
        match style {
            "arrow" => (Shape::Arrow, ARROW_RADIUS_PX),
            "circle" => (Shape::Circle, CIRCLE_RADIUS_PX),
            _ => (Shape::Pin, PIN_RADIUS_PX),
        }
    }

    fn sd_circle(x: f64, y: f64, r: f64) -> f64 {
        (x * x + y * y).sqrt() - r
    }

    fn sd_triangle_isosceles(px: f64, py: f64, qx: f64, qy: f64) -> f64 {
        let px = px.abs();
        let t = ((px * qx + py * qy) / (qx * qx + qy * qy)).clamp(0.0, 1.0);
        let (ax, ay) = (px - qx * t, py - qy * t);
        let t2 = (px / qx).clamp(0.0, 1.0);
        let (bx, by) = (px - qx * t2, py - qy);
        let s = -qy.signum();
        let dx = (ax * ax + ay * ay).min(bx * bx + by * by);
        let dy = (s * (px * qy - py * qx)).min(s * (py - qy));
        -dx.sqrt() * dy.signum()
    }

    fn sd_box(px: f64, py: f64, bx: f64, by: f64) -> f64 {
        let dx = px.abs() - bx;
        let dy = py.abs() - by;
        let (ox, oy) = (dx.max(0.0), dy.max(0.0));
        (ox * ox + oy * oy).sqrt() + dx.max(dy).min(0.0)
    }

    fn sd_arrow(px: f64, py: f64) -> f64 {
        let head = sd_triangle_isosceles(px, py + 0.5, 0.6, 0.6);
        let shaft = sd_box(px, py - 0.30, 0.2, 0.30);
        head.min(shaft)
    }

    fn sd_pin(px: f64, py: f64) -> f64 {
        let py = -py;
        let px = px.abs();
        const CY: f64 = 0.3;
        const CR: f64 = 0.65;
        const TIP: f64 = -0.9;
        const SIN_A: f64 = 0.5416666666666667;
        const COS_A: f64 = 0.8405933750763339;
        const EDGE_LEN: f64 = 1.0087120500916007;
        let (tpx, tpy) = (px, py - TIP);
        let along = tpx * SIN_A + tpy * COS_A;
        if along < 0.0 {
            return (tpx * tpx + tpy * tpy).sqrt();
        }
        if along > EDGE_LEN {
            return (px * px + (py - CY) * (py - CY)).sqrt() - CR;
        }
        tpx * COS_A - tpy * SIN_A
    }

    fn sd_shape(shape: Shape, x: f64, y: f64) -> f64 {
        match shape {
            Shape::Circle => sd_circle(x, y, 1.0),
            Shape::Arrow => sd_arrow(x, y),
            Shape::Pin => sd_pin(x, y),
        }
    }

    /// World pixel coordinates (Web Mercator, 256px world at z0, y down/north-up).
    pub fn world_px(lat: f64, lng: f64, zoom: f64) -> (f64, f64) {
        let scale = 256.0 * 2f64.powf(zoom);
        let siny = lat.to_radians().sin().clamp(-0.9999, 0.9999);
        let x = (lng / 360.0 + 0.5) * scale;
        let y = (0.5 - ((1.0 + siny) / (1.0 - siny)).ln() / (4.0 * std::f64::consts::PI)) * scale;
        (x, y)
    }

    /// Signed distance in *pixels* from the cursor to the marker's edge.
    /// (dx, dy_down) = cursor screen offset from the marker anchor, y down.
    /// Inverts the vertex shader: scr = flipY(R(-angle) * unit * r) + pinShift.
    pub fn marker_distance_px(
        shape: Shape,
        dx: f64,
        dy_down: f64,
        radius_px: f64,
        angle_deg: f64,
    ) -> f64 {
        let dy_up = -dy_down;
        let (sx, sy) = match shape {
            Shape::Pin => (dx, dy_up - 0.9 * radius_px),
            _ => (dx, dy_up),
        };
        // Un-flip, then un-rotate (rotate_by_angle in the shader is R(-angle)).
        let (vx, vy) = (sx, -sy);
        let a = angle_deg.to_radians();
        let (c, s) = (a.cos(), a.sin());
        let ux = (c * vx - s * vy) / radius_px;
        let uy = (s * vx + c * vy) / radius_px;
        sd_shape(shape, ux, uy) * radius_px
    }
}

/// One marker under the cursor. `selected` = drawn in the selection overlay
/// (or as the active marker), i.e. above every base cell marker.
#[derive(serde::Serialize, specta::Type, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct PickHit {
    pub id: u32,
    pub selected: bool,
}

/// CPU hit-test replacing deck.gl GPU picking for the marker layers. Returns
/// covering markers topmost-first, resolving overlaps by draw order (selection
/// overlay/active above base; within base, cell order then index within cell),
/// which reproduces the painter's-order stacking the renderer draws.
/// `zoom` is Google-scale; `marker_style`/`size_scale` must match the surface.
#[tauri::command]
#[specta::specta]
pub fn store_pick(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    lat: f64,
    lng: f64,
    zoom: f64,
    marker_style: String,
    size_scale: f64,
) -> AppResult<Vec<PickHit>> {
    with_store!(webview, state, |store| {
        let _t = std::time::Instant::now();
        let (shape, base_radius) = pick::shape_for_style(&marker_style);
        let radius_px = base_radius * size_scale.max(0.01);
        // Meters per pixel at this latitude/zoom; search covers the pin's full
        // screen extent (up to ~1.9r above the anchor) plus slop.
        let mpp = 156_543.033_92 * lat.to_radians().cos().abs().max(1e-4) / 2f64.powf(zoom);
        let search_m = (2.0 * radius_px + pick::SLOP_PX) * mpp;
        let (cx, cy) = pick::world_px(lat, lng, zoom);
        let arrow = shape == pick::Shape::Arrow;

        let ids = store.find_nearby_ids(lat, lng, search_m);
        let mut hits: Vec<(u8, u8, usize, u32)> = Vec::new();
        for id in ids {
            let Some((mlat, mlng)) = store.coords_of(id) else {
                continue;
            };
            let (mx, my) = pick::world_px(mlat, mlng, zoom);
            let angle = if arrow {
                -store.heading_of(id).unwrap_or(0.0)
            } else {
                0.0
            };
            let d = pick::marker_distance_px(shape, cx - mx, cy - my, radius_px, angle);
            if d > pick::SLOP_PX {
                continue;
            }
            let selected =
                store.selections.ids.contains(id) || store.selections.active_id == Some(id);
            let (ci, idx) = match store.cell_lookup(id) {
                Some((key, idx)) => (cell_idx_from_key(&key).unwrap_or(0), idx),
                None => (0, 0),
            };
            hits.push((selected as u8, ci, idx, id));
        }
        // Topmost first: overlay group, then cell draw order, then index within cell.
        hits.sort_unstable_by(|a, b| b.cmp(a));
        let result: Vec<PickHit> = hits
            .into_iter()
            .map(|(sel, _, _, id)| PickHit {
                id,
                selected: sel != 0,
            })
            .collect();
        if _t.elapsed().as_millis() >= 5 {
            log::debug!(
                "[cmd] store_pick z={:.1} hits={} total={}ms",
                zoom,
                result.len(),
                _t.elapsed().as_millis()
            );
        }
        Ok(result)
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "location_store.test.rs"]
mod tests;
