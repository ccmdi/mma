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
use crate::selections::{self, Selection, Selector};
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
/// is O(min(set size, render size)) rather than O(render size) per selection: sparse sets
/// walk their members and probe `id_to_cell_idx`/`id_to_index`; dense sets (where
/// member-walking would do the same work anyway) scan the cell arrays directly.
fn selection_cell_indices(
    render: &RenderState,
    render_size: usize,
    set: &RoaringBitmap,
) -> [Vec<u32>; 32] {
    let mut out: [Vec<u32>; 32] = std::array::from_fn(|_| Vec::new());
    if (set.len() as usize) <= render_size {
        for id in set {
            let Some(&ci) = render.id_to_cell_idx.get(id as usize) else {
                continue;
            };
            if ci == 255 {
                continue;
            }
            let Some(cr) = render.cells[ci as usize].as_ref() else {
                continue;
            };
            if let Some(&li) = cr.id_to_index.get(&id) {
                out[ci as usize].push(li as u32);
            }
        }
    } else {
        for (ci, opt) in render.cells.iter().enumerate() {
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
    //   1 = index-list: u32 count + count*u32 selected local indices, unordered (sparse → O(selected))
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

/// Build the selection-bitmask wire buffer for `sels` against the current render cells:
/// route each selection to per-cell local indices, serialize the cells, assemble. Returns
/// the buffer and the number of cells it covers. The only place those steps are sequenced.
/// Cells and selections are independent, so both passes go parallel.
fn build_selection_buf(render: &RenderState, sels: &[ResolvedSelection]) -> (Vec<u8>, usize) {
    let render_total = render.total_len();
    let routed: Vec<[Vec<u32>; 32]> = sels
        .par_iter()
        .map(|r| selection_cell_indices(render, render_total, &r.set))
        .collect();
    let segments: Vec<Vec<u8>> = render
        .cells
        .par_iter()
        .enumerate()
        .filter_map(|(ci, opt)| {
            let cr = opt.as_ref()?;
            Some(serialize_cell_segment(ci, cr, &routed))
        })
        .collect();
    let num_cells = segments.len();
    let buf = assemble_selection_bitmask(sels.iter().map(|r| &r.sel.color), &segments);
    (buf, num_cells)
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
    /// Unsaved since the last autosave. Cleared by `store_save_dirty` after a
    /// confirmed write (rev-guarded); NOT a "has uncommitted content" flag — that
    /// is [`Overlay::is_empty`].
    #[serde(skip)]
    pub dirty: bool,
    /// Bumped on every overlay mutation. `store_save_dirty` clears `dirty` only if
    /// the rev it serialized is still current once the async write lands.
    #[serde(skip)]
    pub rev: u64,
}

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

impl Overlay {
    /// No uncommitted content. Distinct from `dirty`: an autosaved overlay is
    /// clean but stays non-empty until baked by a commit.
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

impl RenderState {
    /// Total rendered marker count across all cells.
    fn total_len(&self) -> usize {
        self.cells
            .iter()
            .filter_map(|o| o.as_ref())
            .map(|cr| cr.id_order.len())
            .sum()
    }
}

/// A selection together with its resolved membership. One value rather than two parallel
/// vectors, so the index correspondence the color lookups depend on cannot drift.
pub(crate) struct ResolvedSelection {
    pub sel: Selection,
    /// Member location ids.
    pub set: RoaringBitmap,
}

/// Zip selections with the member sets `resolve_forest` returned for them. The only place
/// the two are joined, so the pairing is stated once.
fn pair_selections(sels: Vec<Selection>, sets: Vec<RoaringBitmap>) -> Vec<ResolvedSelection> {
    debug_assert_eq!(
        sels.len(),
        sets.len(),
        "resolve_forest returns one set per selection"
    );
    sels.into_iter()
        .zip(sets)
        .map(|(sel, set)| ResolvedSelection { sel, set })
        .collect()
}

pub(crate) struct SelectionState {
    pub resolved: Vec<ResolvedSelection>,
    /// Resolved count of every selection node (top-level and nested), keyed by `Selection.key`.
    /// The faithful per-node count source for sidebar display; refreshed on every sync/resolve.
    pub node_counts: HashMap<String, u32>,
    pub version: u64,
    /// Union of every member set. Answers "is this id selected".
    pub ids: RoaringBitmap,
    pub active_id: Option<u32>,
}

impl SelectionState {
    /// Paint of a selected id = the last selection containing it. None if unselected.
    fn paint_for(&self, id: u32) -> Option<SelPaint> {
        if !self.ids.contains(id) {
            return None;
        }
        let mut paint = None;
        for (i, r) in self.resolved.iter().enumerate() {
            if r.set.contains(id) {
                paint = Some(SelPaint {
                    idx: i as u32,
                    color: r.sel.color,
                });
            }
        }
        paint
    }

    /// Bulk form of `paint_for`. Later selections overwrite earlier ones, so each id ends
    /// up with the same paint the per-id lookup would return.
    fn paint_map(&self) -> HashMap<u32, SelPaint> {
        let mut map = HashMap::with_capacity(self.ids.len() as usize);
        for (i, r) in self.resolved.iter().enumerate() {
            let paint = SelPaint {
                idx: i as u32,
                color: r.sel.color,
            };
            for id in &r.set {
                map.insert(id, paint);
            }
        }
        map
    }
}

pub(crate) struct TagState {
    pub all: HashMap<u32, Tag>,
    pub dirty: bool,
    /// Tags whose count moved since the last `finish_mutation`, which drains it. Decides
    /// both which tags get their visibility re-derived (scanning all of them instead would
    /// hide any tag merely sitting at zero, including one just created) and whether the
    /// result carries `tag_counts` at all.
    pub touched: HashSet<u32>,
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
    /// Cached whole-map bounds accumulator. Maintained incrementally on add/update
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

/// Ids whose selection paint changed in a mutation — including moves between overlapping
/// selections, where union membership never flips but the winning colour does. Carries no
/// paint: `SelectionState::paint_for` is the one place colour and draw order is decided.
struct MembershipDelta {
    changed: HashSet<u32>,
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

macro_rules! apply_patch {
    ($target:expr, $patch:expr; $($field:ident),+ $(,)?) => {
        $(if let Some(v) = $patch.$field { $target.$field = v; })+
    };
    (clone $target:expr, $patch:expr; $($field:ident),+ $(,)?) => {
        $(if let Some(ref v) = $patch.$field { $target.$field = v.clone(); })+
    };
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
            overlay: Overlay::default(),
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
                all: HashMap::new(),
                dirty: false,
                touched: HashSet::new(),
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
    pub(crate) fn finish_mutation(&mut self, changes: &ChangeSet) -> MutationResult {
        self.bump();
        self.update_bounds(changes);

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

        let mut tags = None;
        let mut vis_changed = false;
        let touched = std::mem::take(&mut self.tags.touched);
        let counts_changed = !touched.is_empty();
        for tag_id in touched {
            let Some(tag) = self.tags.all.get_mut(&tag_id) else {
                continue;
            };
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
        if !counts_changed {
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

    /// Whether any active selection requires a full O(S*N) resolve rather than
    /// incremental membership updates (composites and duplicates depend on global state).
    fn selections_need_full_resolve(&self) -> bool {
        self.selections.resolved.iter().any(|r| {
            matches!(
                r.sel.selector,
                Selector::Duplicates { .. }
                    | Selector::TopK { .. }
                    | Selector::Uncommitted
                    | Selector::Intersection { .. }
                    | Selector::Union { .. }
                    | Selector::Invert { .. }
            )
        })
    }

    /// Render angle for a heading. Only arrow markers point anywhere.
    fn render_angle(&self, heading: f64) -> f32 {
        if self.render.arrow_style {
            -(heading as f32)
        } else {
            0.0
        }
    }

    /// Project the changeset onto render cells, returning the render delta and keeping
    /// `render_cells` / `id_to_cell_idx` in sync. This is the single place cell
    /// membership is mutated for adds / removes / moves.
    ///
    /// `membership_changed` carries the ids whose selection membership moved, so a row that
    /// changed selection without moving still gets a patch stating its new state.
    fn derive_render_delta(
        &mut self,
        changes: &ChangeSet,
        membership_changed: &HashSet<u32>,
    ) -> RenderDelta {
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
            self.cell_add_render(ci, loc.id);
            delta.added.push(RenderEntry {
                cell: cell_key_from_idx(ci),
                id: loc.id,
                lng: loc.lng as f32,
                lat: loc.lat as f32,
                heading: self.render_angle(loc.heading),
                sel: self.selections.paint_for(loc.id),
                moved_from: None,
            });
        }

        for (old, new) in &changes.updated {
            let pos_changed = old.lat != new.lat || old.lng != new.lng;
            let heading_changed = old.heading != new.heading;
            let new_ci = render_cell_idx(new.lat, new.lng);
            let old_ci = self
                .render
                .id_to_cell_idx
                .get(new.id as usize)
                .copied()
                .unwrap_or(255);

            // Crossing cells is a move, not a delete plus an unrelated create: the vacated
            // slot rides along on the entry so the overlay entry can follow the row.
            if pos_changed && old_ci != new_ci {
                let moved_from = self.cell_remove_render(new.id);
                self.cell_add_render(new_ci, new.id);
                delta.added.push(RenderEntry {
                    cell: cell_key_from_idx(new_ci),
                    id: new.id,
                    lng: new.lng as f32,
                    lat: new.lat as f32,
                    heading: self.render_angle(new.heading),
                    sel: self.selections.paint_for(new.id),
                    moved_from,
                });
                continue;
            }

            if pos_changed || heading_changed || membership_changed.contains(&new.id) {
                if let Some((cell, cell_index)) = self.cell_lookup(new.id) {
                    delta.updated.push(RenderPatchEntry {
                        cell,
                        cell_index,
                        lng: pos_changed.then_some(new.lng as f32),
                        lat: pos_changed.then_some(new.lat as f32),
                        heading: heading_changed.then(|| self.render_angle(new.heading)),
                        sel: self.selections.paint_for(new.id),
                    });
                }
            }
        }

        delta
    }

    /// Update selection membership sets for incremental changes (adds/removes/updates).
    /// Returns which ids changed paint, so the render delta can state their new
    /// selection state.
    fn update_selection_membership(&mut self, changes: &ChangeSet) -> MembershipDelta {
        let drop_ids: HashSet<u32> = changes
            .removed
            .iter()
            .copied()
            .chain(changes.updated.iter().map(|(_, n)| n.id))
            .collect();
        // Paint before the mutation, snapshotted while the sets still reflect it. Paint is
        // the compared fact — not union membership — because a row that moves between
        // overlapping selections changes colour without ever leaving the union.
        let mut prev_paint: HashMap<u32, Option<SelPaint>> = HashMap::new();
        if !drop_ids.is_empty() {
            for id in &drop_ids {
                prev_paint.insert(*id, self.selections.paint_for(*id));
            }
            for r in &mut self.selections.resolved {
                for id in &drop_ids {
                    r.set.remove(*id);
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
        // Split the borrow so membership and the union can be updated in one pass.
        let SelectionState { resolved, ids, .. } = &mut self.selections;
        for r in resolved.iter_mut() {
            for loc in &test_locs {
                if selections::RowRef::from_loc(loc).matches(&r.sel.selector) {
                    r.set.insert(loc.id);
                    ids.insert(loc.id);
                }
            }
        }
        self.selections.version += 1;
        // Incremental path runs only without composites, so every node is top-level.
        self.selections.node_counts = self
            .selections
            .resolved
            .iter()
            .map(|r| (r.sel.key.clone(), r.set.len() as u32))
            .collect();

        let mut changed = HashSet::new();
        for loc in changes
            .added
            .iter()
            .chain(changes.updated.iter().map(|(_, n)| n))
        {
            // Added rows have no snapshot: their previous paint is None, and they compare
            // against whatever they resolve to now.
            let before = prev_paint.get(&loc.id).copied().flatten();
            if self.selections.paint_for(loc.id) != before {
                changed.insert(loc.id);
            }
        }
        // A removed row leaves the overlay with its cell; nothing to state about it.
        MembershipDelta { changed }
    }

    /// Full selection membership resolve: recomputes every member set, the union, and the
    /// per-node counts from scratch. O(S * N). Does NOT build the bitmask.
    fn resolve_selection_membership(&mut self) {
        let sels: Vec<Selection> = self
            .selections
            .resolved
            .iter()
            .map(|r| r.sel.clone())
            .collect();
        let (loc_sets, node_counts) = {
            let view = self.loc_view();
            selections::resolve_forest(&view, &sels)
        };
        self.selections.node_counts = node_counts;
        self.selections.resolved = pair_selections(sels, loc_sets);

        let mut all_selected = RoaringBitmap::new();
        for r in &self.selections.resolved {
            all_selected |= &r.set;
        }
        self.selections.ids = all_selected;
        self.selections.version += 1;
    }

    /// Build the full selection bitmask from the current render cells + member sets.
    /// Every cell is rebuilt; incremental membership changes ride the `sel` field on the
    /// render delta's own entries instead (see `finish_mutation`).
    fn build_selection_bitmask(&self) -> SelectionSync {
        let counts = self.selections.node_counts.clone();
        let selected_count = self.selections.ids.len() as usize;

        let t0 = std::time::Instant::now();
        let num_sels = self.selections.resolved.len();
        let (buf, num_cells) = build_selection_buf(&self.render, &self.selections.resolved);
        let bitmask = if num_cells > 0 { Some(buf) } else { None };

        log::debug!(
            "[sel] total={}ms sels={} selected={} cells={}",
            t0.elapsed().as_millis(),
            num_sels,
            selected_count,
            num_cells,
        );

        SelectionSync {
            counts,
            bitmask,
            selected_count,
        }
    }

    /// Adjust tag counts by `delta` (+1 for adds, -1 for removes). O(L * T) where L = locs, T = avg tags per loc.
    pub(crate) fn update_tag_counts<'a>(
        &mut self,
        locs: impl IntoIterator<Item = &'a Location>,
        delta: isize,
    ) {
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
                            doclinks: Vec::new(),
                        },
                    );
                    self.tags.dirty = true;
                }
                members.entry(tag_id).or_default().push(loc.id);
                self.tags.touched.insert(tag_id);
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
    pub(crate) fn add_tag_counts<'a>(&mut self, locs: impl IntoIterator<Item = &'a Location>) {
        self.update_tag_counts(locs, 1);
    }
    /// Decrement tag counts for all tags referenced by `locs` (saturating at zero).
    pub(crate) fn remove_tag_counts<'a>(&mut self, locs: impl IntoIterator<Item = &'a Location>) {
        self.update_tag_counts(locs, -1);
    }

    /// Push an undo entry for the changed (old != new) pairs and clear redo. Returns
    /// whether anything was pushed.
    fn record_update_undo(
        &mut self,
        updated: impl IntoIterator<Item = (Location, Location)>,
    ) -> bool {
        let (changed_old, changed_new): (Vec<_>, Vec<_>) =
            updated.into_iter().filter(|(o, n)| o != n).unzip();
        if changed_old.is_empty() {
            return false;
        }
        self.push_undo(EditEntry {
            created: changed_new,
            removed: changed_old,
        });
        self.edits.redo.clear();
        true
    }

    /// Apply a tags-only update: adjust tag counts, write the tags patch into the
    /// overlay, and record undo for the changed pairs. Returns the ChangeSet.
    fn commit_tag_update(&mut self, updated: Vec<(Location, Location)>) -> ChangeSet {
        self.remove_tag_counts(updated.iter().map(|(o, _)| o));
        let updated: Vec<(Location, Location)> = updated
            .into_iter()
            .map(|(old, new_loc)| {
                let new_loc = self.overlay_write(new_loc.id, new_loc, &old);
                (old, new_loc)
            })
            .collect();
        self.add_tag_counts(updated.iter().map(|(_, n)| n));
        self.record_update_undo(updated.iter().cloned());
        ChangeSet {
            updated,
            ..Default::default()
        }
    }

    /// Core edit primitive: atomically remove then create locations, updating tags, overlay,
    /// and render cells. Undo/redo swap the arguments. O(R + C) where R = removed, C = created.
    fn apply_edit(&mut self, remove: &[Location], create: &[Location]) -> ChangeSet {
        let t0 = std::time::Instant::now();
        let create_ids: HashSet<u32> = create.iter().map(|l| l.id).collect();
        let remove_by_id: HashMap<u32, &Location> = remove.iter().map(|l| (l.id, l)).collect();

        self.remove_tag_counts(remove);
        self.overlay_remove(remove);
        self.add_tag_counts(create);
        self.overlay_add(create.to_vec());

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

    fn apply_edit_forward(&mut self, entry: &EditEntry) -> ChangeSet {
        self.apply_edit(&entry.removed, &entry.created)
    }

    fn apply_edit_reverse(&mut self, entry: &EditEntry) -> ChangeSet {
        self.apply_edit(&entry.created, &entry.removed)
    }

    /// Apply an edit, record undo, clear redo, finish mutation. No-op when both sides empty.
    fn apply_undoable(&mut self, remove: Vec<Location>, create: Vec<Location>) -> MutationResult {
        if remove.is_empty() && create.is_empty() {
            return self.finish_mutation(&ChangeSet::default());
        }
        let changes = self.apply_edit(&remove, &create);
        self.push_undo(EditEntry {
            created: create,
            removed: remove,
        });
        self.edits.redo.clear();
        self.finish_mutation(&changes)
    }

    /// Ensure `names` exist as tags and are on `location_ids`, in one mutation. Names match
    /// case-insensitively, so an existing tag is reused (and un-hidden) rather than
    /// duplicated. An empty `location_ids` just creates them.
    pub(crate) fn create_tags(&mut self, names: &[String], location_ids: &[u32]) -> MutationResult {
        let mut name_to_id: HashMap<String, u32> = HashMap::new();
        for (&id, entry) in &self.tags.all {
            name_to_id.insert(entry.name.to_lowercase(), id);
        }

        let mut tag_ids: Vec<u32> = Vec::with_capacity(names.len());
        for name in names {
            if let Some(&id) = name_to_id.get(&name.to_lowercase()) {
                let tag = self.tags.all.get_mut(&id).unwrap();
                tag.visible = true;
                tag_ids.push(id);
            } else {
                let id = self.alloc_tag_id();
                let order = self.tags.all.values().filter_map(|t| t.order).max();
                self.tags.all.insert(
                    id,
                    Tag {
                        id,
                        name: name.clone(),
                        color: util::color_for_name(name),
                        visible: true,
                        order: Some(order.map_or(1, |m| m + 1)),
                        count: 0,
                        doclinks: Vec::new(),
                    },
                );
                name_to_id.insert(name.to_lowercase(), id);
                tag_ids.push(id);
            }
        }

        if !names.is_empty() {
            self.tags.dirty = true;
        }

        let mut updated: Vec<(Location, Location)> = Vec::new();
        for &id in location_ids {
            let Some(old) = self.get_loc_by_id(id) else {
                continue;
            };
            let mut tags = old.tags.clone();
            for &t in &tag_ids {
                if !tags.contains(&t) {
                    tags.push(t);
                }
            }
            if tags.len() == old.tags.len() {
                continue; // already had all of them
            }
            let mut new_loc = old.clone();
            new_loc.tags = tags;
            updated.push((old, new_loc));
        }

        let changeset = self.commit_tag_update(updated);
        let mut result = self.finish_mutation(&changeset);
        result.tags = Some(self.tags.all.clone());
        result
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

    /// Evenly spaced subset of `set` (`None` = whole map): `target_count` thins to
    /// N ids maximizing spacing; `min_distance_m` keeps as many as fit at that
    /// spacing.
    pub(crate) fn pick_spaced(
        &self,
        set: Option<&RoaringBitmap>,
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
            (_, Some(d)) if d > i32::MAX as u32 => {
                return Err(AppError::from("pick_spaced: min_distance_m too large"))
            }
            _ => {}
        }

        let candidate_ids: Vec<u32> = match set {
            Some(s) => s.iter().collect(),
            None => selections::ids_within(&self.loc_view(), None),
        };
        let mut candidates: Vec<(u32, f64, f64)> = candidate_ids
            .into_iter()
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

    /// Materialize the selected location set (`Everything` = every alive location).
    /// A named id list binary-searches each (marker click, enrich refetch ship a handful)
    /// and keeps the caller's order and duplicates; every other selector is one scan,
    /// sorted and deduped by the bitmap. O(N) time and space.
    pub(crate) fn collect(&self, selector: &Selector) -> Vec<Location> {
        if let Selector::Locations { locations, .. } = selector {
            return locations
                .iter()
                .filter_map(|&id| self.get_loc_by_id(id))
                .collect();
        }
        let view = self.loc_view();
        let resolved = selections::narrow(&view, selector);
        let mut locs = Vec::with_capacity(self.alive_count);
        locs.extend(view.within(resolved.as_ref()).map(|row| row.to_location()));
        locs
    }

    /// Full O(N) bounds scan, optionally narrowed to an id set. Returns the raw
    /// accumulator; callers `.resolve()` it to `[w,s,e,n]`.
    fn scan_bounds(&self, set: Option<&RoaringBitmap>) -> Option<BoundsAcc> {
        self.loc_view().within(set).fold(None, |acc, row| {
            Some(BoundsAcc::fold(acc, row.lat(), row.lng()))
        })
    }

    fn compute_bounds(&self, set: Option<&RoaringBitmap>) -> Option<[f64; 4]> {
        self.scan_bounds(set).map(BoundsAcc::resolve)
    }

    /// Whole-map bounding box, cached. Recomputes O(N) only when dirty (after a
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
    pub(crate) fn loc_view(&self) -> selections::LocView<'_> {
        selections::LocView::new(
            self.batch.as_ref(),
            &self.overlay.dead,
            &self.overlay.patches,
            &self.overlay.adds,
            Some(&self.tags.sets),
        )
    }

    /// Insert or restore locations in the overlay. `adds` stays sorted by id (the invariant
    /// `bake_overlay` asserts): fresh ids sort above everything and are appended, O(k);
    /// anything else (an undo re-adding old ids) is merged in one linear pass, O(n + k),
    /// where inserting each row into its slot would shift the rows above it, O(n * k).
    pub(crate) fn overlay_add(&mut self, locs: Vec<Location>) {
        let mut fresh: Vec<Location> = Vec::with_capacity(locs.len());
        for loc in locs {
            self.overlay.touch();
            self.alive_count += 1;
            if let Some(ix) = self.spatial.as_mut() {
                ix.insert(loc.id, loc.lat, loc.lng);
            }
            self.overlay.dead.remove(&loc.id);
            let in_batch = self
                .batch
                .as_ref()
                .and_then(|b| batch_row_for_id(b, loc.id))
                .is_some();
            if !in_batch {
                fresh.push(loc);
            } else if self.base_loc_by_id(loc.id).as_ref() == Some(&loc) {
                self.overlay.patches.remove(&loc.id);
            } else {
                self.overlay.patches.insert(loc.id, loc);
            }
        }
        if fresh.is_empty() {
            return;
        }
        fresh.sort_unstable_by_key(|l| l.id);
        if cfg!(debug_assertions) {
            if let Some(w) = fresh.windows(2).find(|w| w[0].id == w[1].id) {
                panic!("overlay_add duplicate id {} -- next_id allocation bug", w[1].id);
            }
        }
        let adds = &mut self.overlay.adds;
        if adds.last().is_none_or(|last| last.id < fresh[0].id) {
            adds.extend(fresh);
        } else {
            let old = std::mem::take(adds);
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
                    panic!("overlay_add duplicate id {} -- next_id allocation bug", w[1].id);
                }
            }
            *adds = merged;
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
                loc.modified_at = Some(crate::util::now_unix());
                self.overlay.adds[pos] = loc.clone();
            }
        } else if self.overlay.patches.contains_key(&id) {
            // A patched row: `old` is the patched state, so reverting to the base row
            // exactly is the one case that still has to materialize it.
            if self.base_loc_by_id(id).as_ref() == Some(&loc) {
                self.overlay.patches.remove(&id);
            } else if self.overlay.patches.get(&id) != Some(&loc) {
                loc.modified_at = Some(crate::util::now_unix());
                self.overlay.patches.insert(id, loc.clone());
            }
        } else if loc != *old {
            loc.modified_at = Some(crate::util::now_unix());
            self.overlay.patches.insert(id, loc.clone());
        }
        self.overlay.touch();
        loc
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

impl<'de, R: tauri::Runtime> tauri::ipc::CommandArg<'de, R> for WindowLabel {
    fn from_command(
        command: tauri::ipc::CommandItem<'de, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        Ok(Self(command.message.webview_ref().label().to_string()))
    }
}

impl specta::function::FunctionArg for WindowLabel {
    fn to_datatype(_: &mut specta::Types) -> Option<specta::datatype::DataType> {
        None
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Metadata snapshot returned to JS after every mutation. JS uses `version` to
/// detect stale responses and `canUndo`/`canRedo` for toolbar button state.
/// `known_field_keys` lists every extra-field key that exists in location data
/// on this map. Add-only within a session; seeded from `MapMeta.extra.fields`
/// on map open.
#[derive(serde::Serialize, Clone, specta::Type)]
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

/// Incremental render update sent to JS after a mutation: adds, patches, and removals.
/// Every entry states the row's resulting selection state, so applying a delta is
/// idempotent and the base cells and the selection overlay cannot drift apart.
/// `full_reset` signals JS to discard all cell data and re-fetch via `store_fill_render_file`.
#[derive(serde::Serialize, Clone, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderDelta {
    pub added: Vec<RenderEntry>,
    pub updated: Vec<RenderPatchEntry>,
    pub removed: Vec<CellRemoval>,
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

impl ChangeSet {
    /// No rows moved. A metadata-only mutation (tag rename, reorder) produces one of these.
    pub(crate) fn is_empty(&self) -> bool {
        !self.full_reset
            && self.added.is_empty()
            && self.removed.is_empty()
            && self.updated.is_empty()
    }
}

/// The selection drawing a row: its colour, and its index in `SelectionState::resolved`.
/// The index is the draw order — a later selection overdraws an earlier one — so the
/// overlay can be ordered by it instead of by whatever order rows happen to arrive in.
/// Every marker sits at z=0 in one deck.gl layer, so buffer order is the only z there is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SelPaint {
    pub idx: u32,
    pub color: [u8; 3],
}

/// A marker appended to a render cell: position, heading, and selection state.
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderEntry {
    pub cell: String,
    pub id: u32,
    pub lng: f32,
    pub lat: f32,
    pub heading: f32,
    /// `None` = drawn by the base layer, `Some(paint)` = drawn by the selection overlay.
    pub sel: Option<SelPaint>,
    /// The slot this row vacated when it crossed cells. Present only for a move, so JS
    /// mirrors the swap-remove and carries the overlay entry across instead of inferring
    /// a move from an unrelated removed/added pair.
    pub moved_from: Option<CellRemoval>,
}

/// Update to an existing marker within its cell. Position and heading are `None` when
/// unchanged; `sel` always states the row's current selection state, so a membership
/// change with no movement is just a patch with no coordinates.
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderPatchEntry {
    pub cell: String,
    pub cell_index: usize,
    pub lng: Option<f32>,
    pub lat: Option<f32>,
    pub heading: Option<f32>,
    pub sel: Option<SelPaint>,
}

/// A swap-removal from a render cell. JS must move the last element into `cell_index`
/// and pop the array to mirror the Rust-side swap-remove.
#[derive(serde::Serialize, Clone, Default, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CellRemoval {
    pub cell: String,
    pub cell_index: usize,
    pub id: u32,
}

/// Selection bitmask sync payload. `bitmask` carries the packed per-cell bitmask bytes
/// inline in the IPC response (no shared temp file → no clobber race under concurrent
/// mutations). `None` when nothing changed. `counts` gives per-selection match counts.
#[derive(serde::Serialize, Clone, specta::Type)]
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
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    #[serde(flatten)]
    pub status: StoreStatus,
    pub delta: RenderDelta,
    pub selection_sync: Option<SelectionSync>,
    pub new_field_defs: Option<HashMap<String, map_meta::ExtraFieldDef>>,
    pub tags: Option<HashMap<u32, Tag>>,
}

/// User-facing warning toast.
#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(transparent)]
#[tauri_specta(event_name = "store-warning")]
pub struct StoreWarning(pub String);

/// A mutation another window made to a map this window may have open, routed by `map_id`.
#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "store-external-mutation")]
pub struct ExternalMutation {
    #[serde(flatten)]
    pub result: MutationResult,
    pub map_id: String,
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
#[derive(Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct LocationPatch {
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub heading: Option<f64>,
    pub pitch: Option<f64>,
    pub zoom: Option<f64>,
    #[serde(default, deserialize_with = "nullable")]
    #[specta(type = Option<Option<String>>)]
    pub pano_id: Option<Option<compact_str::CompactString>>,
    pub flags: Option<u32>,
    pub tags: Option<Vec<u32>>,
    #[serde(default, deserialize_with = "nullable")]
    #[specta(type = Option<Option<std::collections::HashMap<String, specta_typescript::Unknown>>>)]
    pub extra: Option<Option<crate::types::RawExtra>>,
    pub created_at: Option<u32>,
    #[serde(default, deserialize_with = "nullable")]
    #[specta(type = Option<Option<u32>>)]
    pub modified_at: Option<Option<u32>>,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Load the uncommitted-delta sidecar. An unreadable delta is set aside as a
/// `.corrupt` sibling - never left in place where the next autosave would
/// overwrite it - and the user is warned via a `store-warning` event.
fn load_delta(delta_path: &std::path::Path) -> Option<Overlay> {
    if !delta_path.exists() {
        return None;
    }
    let parsed = std::fs::read(delta_path)
        .map_err(|e| e.to_string())
        .and_then(|d| rmp_serde::from_slice::<Overlay>(&d).map_err(|e| e.to_string()));
    match parsed {
        Ok(p) => Some(p),
        Err(e) => {
            let kept = delta_path.with_extension("corrupt");
            let _ = std::fs::remove_file(&kept);
            let moved = std::fs::rename(delta_path, &kept).is_ok();
            log::error!(
                "[store_open] unreadable delta ({e}), set aside (moved={moved}) at {kept:?}"
            );
            crate::emit_event(StoreWarning(
                "Uncommitted changes could not be read and were set aside as a .corrupt file. The map opened from its last committed state.".into(),
            ));
            None
        }
    }
}

/// Load a map's Arrow data from disk, rebuild all indexes, and return initial state
/// (tag counts, undo/redo availability). Must be called before any other store commands.
#[tauri::command]
#[specta::specta]
pub async fn store_open_map(
    label: WindowLabel,
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
            let delta = load_delta(&delta_path);
            (batch, handle, delta)
        };

        // Legacy files may be unsorted; enforce the sorted ID invariant once.
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

        let (undo, redo) = load_edit_history(&map_id2)?;

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
    // `adds` are persisted in sorted-id order.
    if let Some(d) = delta {
        store.overlay = d;
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
        storage::set_location_count(&conn, &map_id, alive)?;
        let mut tags = read_tags_json(&conn, &map_id);
        let (max_tag_id, healed) = reconcile_tag_registry(&mut tags, &tag_counts);
        store.tags.all = tags;
        store.tags.dirty = healed;
        store.tags.next_id = max_tag_id + 1;
        store.rebuild_tag_sets();
        let extra_str: String = conn
            .query_row(
                "SELECT extra FROM maps WHERE id = ?1",
                rusqlite::params![map_id],
                |row| row.get(0),
            )
            .unwrap_or_default();
        let extra = map_meta::MapExtra::from_json(&extra_str);
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
    mgr.window_map.insert(label.0.clone(), map_id.clone());
    mgr.stores.insert(map_id, store);
    Ok(status)
}

/// Close the current map: bake overlay, flush Arrow + tags + edit history to disk, then
/// release all in-memory state (batch, mmap, indexes, selections, undo stacks).
#[tauri::command]
#[specta::specta]
pub async fn store_close_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<()> {
    let (map_id, store) = {
        let mut mgr = state.lock()?;
        let map_id = match mgr.window_map.remove(&label.0) {
            Some(id) => id,
            None => return Ok(()),
        };
        if mgr.window_map.values().any(|v| v == &map_id) {
            log::debug!("[close_map] {map_id} still open in another window, skipping flush");
            return Ok(());
        }
        let Some(store) = mgr.stores.remove(&map_id) else {
            log::debug!("[close_map] {map_id} has no store, nothing to flush");
            return Ok(());
        };
        (map_id, store)
    };
    tokio::task::spawn_blocking(move || flush_closed_store(&map_id, &store)).await?
}

fn flush_closed_store(map_id: &str, store: &Store) -> AppResult<()> {
    {
        if store.overlay.dirty {
            // Persist uncommitted edits to the delta sidecar. The base file stays pinned
            // at the last committed state -- it only advances on commit/checkout -- so the
            // overlay remains a faithful changeset-since-last-commit for the next commit.
            let bytes = overlay_delta_bytes(store)?;
            let path = storage::arrow_delta_path(map_id)?;
            storage::atomic_write(&path, |mut file| {
                use std::io::Write;
                file.write_all(&bytes).map_err(AppError::from)
            })?;
        }
        let count = store.alive_count;
        let conn = storage::open_db()?;
        storage::set_location_count(&conn, map_id, count)?;
        if store.tags.dirty {
            write_tags_json(&conn, map_id, &store.tags.all)?;
        }
        save_edit_history(map_id, &store.edits.undo, &store.edits.redo)?;
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
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    locations: Vec<Location>,
) -> AppResult<MutationResult> {
    let _t = std::time::Instant::now();
    with_store!(label, state, |store| {
        let _lock = _t.elapsed().as_millis();
        let result = apply_adds(store, locations);
        log::debug!(
            "[cmd] store_add_locations lock={}ms total={}ms",
            _lock,
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// Allocate IDs for `locations`, insert them, and record the undo entry. The one place a
/// batch of new locations becomes a mutation -- every add path (direct IPC, uploaded chunks)
/// ends here, so they cannot drift in what they record.
pub(crate) fn apply_adds(store: &mut Store, mut locations: Vec<Location>) -> MutationResult {
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
        store.overlay_add(vec![loc]);
    }
    let mut result = store.finish_mutation(&ChangeSet {
        added: added.clone(),
        ..Default::default()
    });
    let extras: Vec<&crate::types::RawExtra> =
        added.iter().filter_map(|l| l.extra.as_ref()).collect();
    auto_register_extras(store, &extras, &mut result);
    result
}

/// Add locations uploaded as chunked JSON in an upload session dir (see `store_upload_begin`),
/// so the frontend never serializes the whole batch at once. Otherwise identical to
/// [`store_add_locations`]: one atomic mutation, one undo entry, IDs in uploaded order.
#[tauri::command]
#[specta::specta]
pub async fn store_add_locations_uploaded(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    session_dir: String,
) -> AppResult<MutationResult> {
    let _t = std::time::Instant::now();
    // Parse before taking the store lock: a malformed chunk must leave the store untouched.
    let locations =
        tokio::task::spawn_blocking(move || crate::export::read_uploaded_chunks(&session_dir))
            .await??;
    let _read = _t.elapsed().as_millis();
    with_store!(label, state, |store| {
        let n = locations.len();
        let result = apply_adds(store, locations);
        log::debug!(
            "[cmd] store_add_locations_uploaded n={} read={}ms total={}ms",
            n,
            _read,
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// Remove locations by ID. Snapshots the full location data for undo before deleting.
#[tauri::command]
#[specta::specta]
pub fn store_remove_locations(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    ids: Vec<u32>,
) -> AppResult<MutationResult> {
    let _t = std::time::Instant::now();
    with_store!(label, state, |store| {
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
        Ok(store.finish_mutation(&ChangeSet {
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
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    updates: Vec<Update<LocationPatch>>,
    record_undo: Option<bool>,
) -> AppResult<MutationResult> {
    let record_undo = record_undo.unwrap_or(true);
    let _t = std::time::Instant::now();
    with_store!(label, state, |store| {
        let n = updates.len();
        let result = apply_updates(store, &updates, record_undo);
        log::debug!(
            "[cmd] store_update_locations n={} undo={} total={}ms",
            n,
            record_undo,
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// Apply `{id, patch}` updates: overlay, tag counts, undo, extras registration. The one
/// place a patch batch becomes a mutation -- every command that derives patches ends here.
pub(crate) fn apply_updates(
    store: &mut Store,
    updates: &[Update<LocationPatch>],
    record_undo: bool,
) -> MutationResult {
    let mut updated: Vec<(Location, Location)> = Vec::with_capacity(updates.len());
    let any_tags = updates.iter().any(|u| u.patch.tags.is_some());
    let any_extras = updates.iter().any(|u| u.patch.extra.is_some());
    for u in updates {
        if let Some(pair) = store.overlay_update(u.id, &u.patch) {
            updated.push(pair);
        }
    }
    if any_tags {
        store.remove_tag_counts(updated.iter().map(|(o, _)| o));
        store.add_tag_counts(updated.iter().map(|(_, n)| n));
    }
    let extras: Vec<crate::types::RawExtra> = if any_extras {
        updated
            .iter()
            .filter_map(|(_, n)| n.extra.clone())
            .collect()
    } else {
        Vec::new()
    };
    let changes = ChangeSet {
        updated,
        ..Default::default()
    };
    let mut result = store.finish_mutation(&changes);
    // Undo is recorded after the mutation is finished so the pairs move into the entry
    // instead of being cloned; the status was read before the push, so patch it.
    if record_undo && store.record_update_undo(changes.updated) {
        result.status.can_undo = true;
        result.status.can_redo = false;
    }
    if any_extras {
        let refs: Vec<&crate::types::RawExtra> = extras.iter().collect();
        auto_register_extras(store, &refs, &mut result);
    }
    result
}

/// When a move target already holds a value, which side survives.
#[derive(serde::Deserialize, specta::Type, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MergeWinner {
    From,
    To,
}

/// A field-wide rewrite of the `extra` map. Patches are derived *per row*, which is what
/// separates these from `store_update_locations`' explicit patch list.
#[derive(serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FieldOp {
    /// Rename `from` into `to`. Merge is the same operation -- rename is just the case
    /// where nothing holds `to` -- so `winner` decides only where a row holds both.
    Move {
        from: String,
        to: String,
        winner: MergeWinner,
    },
    /// Drop `keys` from every row that has them.
    Delete { keys: Vec<String> },
    /// Assign `value` to `key` on every row where it differs. A writable built-in key
    /// (`heading`, `pitch`, `zoom`) patches its column; anything else writes `extra`.
    Set {
        key: String,
        #[specta(type = specta_typescript::Unknown)]
        value: serde_json::Value,
    },
    /// Assign `key = expr(row)` per row. A row where the expression cannot evaluate (a
    /// missing or non-numeric field, a non-finite result) is skipped and counted.
    Expr { key: String, expr: String },
}

/// What a field op planned: the patches for the rows it changes, the removed keys that
/// no longer exist on any row, and the rows an expression could not evaluate.
#[derive(Default)]
struct FieldPlan {
    updates: Vec<Update<LocationPatch>>,
    forget: Vec<String>,
    skipped: u32,
}

/// The op's outcome for the caller: the mutation plus the counts its message needs.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldOpResult {
    pub mutation: MutationResult,
    /// Rows the op patched.
    pub changed: u32,
    /// Rows an expression could not evaluate.
    pub skipped: u32,
}

/// Two field values are the same when JSON says so, except numbers, which compare by
/// value: an integer stored as `45` equals the `45.0` an expression computes.
fn same_field_value(current: Option<&serde_json::Value>, next: &serde_json::Value) -> bool {
    match (current, next) {
        (Some(c), n) if c.is_number() && n.is_number() => c.as_f64() == n.as_f64(),
        (c, n) => c == Some(n),
    }
}

/// A computed number as the JSON a JS writer would have stored: whole values as
/// integers, the rest as floats.
fn number_value(v: f64) -> serde_json::Value {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        serde_json::Value::from(v as i64)
    } else {
        serde_json::Value::from(v)
    }
}

/// The patch assigning `value` to `key`: a writable built-in column directly, anything
/// else as an `extra` merge.
fn assign_patch(key: &str, value: serde_json::Value) -> AppResult<LocationPatch> {
    if selections::is_writable_builtin(key) {
        Ok(serde_json::from_value(serde_json::json!({ key: value }))?)
    } else {
        let mut merge = serde_json::Map::new();
        merge.insert(key.to_string(), value);
        Ok(LocationPatch {
            extra: Some(crate::types::RawExtra::from_map(&merge)),
            ..Default::default()
        })
    }
}

/// Derive the patch each selected row needs for `op`. Rows the op wouldn't change yield
/// nothing, so the patch list is the changed set. Also reports which of the op's removed
/// keys no longer exist on ANY row afterward -- the caller forgets those in
/// `known_field_keys`, so a later reappearance of the key is re-announced to JS. Pure.
fn plan_field_op(
    view: &selections::LocView,
    set: Option<&roaring::RoaringBitmap>,
    op: &FieldOp,
) -> AppResult<FieldPlan> {
    let removed: Vec<String> = match op {
        FieldOp::Move { from, to, .. } if from != to && !to.is_empty() => vec![from.clone()],
        FieldOp::Move { .. } => return Ok(FieldPlan::default()),
        FieldOp::Delete { keys } => keys.clone(),
        FieldOp::Set { .. } | FieldOp::Expr { .. } => Vec::new(),
    };
    let expr = match op {
        FieldOp::Expr { expr, .. } => Some(crate::field_expr::parse(expr)?),
        _ => None,
    };
    let mut plan = FieldPlan::default();
    let mut survives: HashSet<String> = HashSet::new();
    let mut failed: Option<AppError> = None;
    view.for_each(|row| {
        let id = row.id();
        let mut merge = serde_json::Map::new();
        if set.is_none_or(|s| s.contains(id)) {
            match op {
                FieldOp::Set { key, value } => {
                    if !same_field_value(row.resolve_field(key).as_ref(), value) {
                        match assign_patch(key, value.clone()) {
                            Ok(patch) => plan.updates.push(Update { id, patch }),
                            Err(e) => failed = Some(e),
                        }
                    }
                }
                FieldOp::Expr { key, .. } => {
                    let expr = expr.as_ref().expect("parsed above");
                    let field = |name: &str| row.resolve_field(name).and_then(|v| v.as_f64());
                    match crate::field_expr::eval(expr, &field) {
                        None => plan.skipped += 1,
                        Some(v) => {
                            let value = number_value(v);
                            if !same_field_value(row.resolve_field(key).as_ref(), &value) {
                                match assign_patch(key, value) {
                                    Ok(patch) => plan.updates.push(Update { id, patch }),
                                    Err(e) => failed = Some(e),
                                }
                            }
                        }
                    }
                }
                FieldOp::Move { from, to, winner } => {
                    if let Some(value) = row.resolve_field(from) {
                        merge.insert(from.clone(), serde_json::Value::Null);
                        // Winner decides only where the row already holds `to`.
                        if *winner == MergeWinner::From || row.resolve_field(to).is_none() {
                            merge.insert(to.clone(), value);
                        }
                    }
                }
                FieldOp::Delete { keys } => {
                    for key in keys {
                        if row.resolve_field(key).is_some() {
                            merge.insert(key.clone(), serde_json::Value::Null);
                        }
                    }
                }
            }
        }
        // A removed key survives on any row this op leaves it on (unselected, or absent
        // from the patch).
        for k in &removed {
            if merge.get(k) != Some(&serde_json::Value::Null)
                && !survives.contains(k)
                && row.resolve_field(k).is_some()
            {
                survives.insert(k.clone());
            }
        }
        if !merge.is_empty() {
            plan.updates.push(Update {
                id,
                patch: LocationPatch {
                    extra: Some(crate::types::RawExtra::from_map(&merge)),
                    ..Default::default()
                },
            });
        }
    });
    if let Some(e) = failed {
        return Err(e);
    }
    plan.forget = removed
        .into_iter()
        .filter(|k| !survives.contains(k))
        .collect();
    Ok(plan)
}

/// The keys an op may only reach through `extra`, and the shape a built-in assignment
/// must have. A built-in name written through `extra` would silently shadow a column.
fn check_field_op(op: &FieldOp) -> AppResult<()> {
    let extra_keys: Vec<&str> = match op {
        FieldOp::Move { from, to, .. } => vec![from.as_str(), to.as_str()],
        FieldOp::Delete { keys } => keys.iter().map(String::as_str).collect(),
        FieldOp::Set { key, .. } | FieldOp::Expr { key, .. } => {
            if selections::is_writable_builtin(key) {
                Vec::new()
            } else {
                vec![key.as_str()]
            }
        }
    };
    if let Some(k) = extra_keys.iter().find(|k| selections::is_builtin_field(k)) {
        return Err(AppError::from(format!(
            "store_apply_field_op: {k} is a built-in field"
        )));
    }
    if let FieldOp::Set { key, value } = op {
        if selections::is_writable_builtin(key) && !value.is_number() {
            return Err(AppError::from(format!(
                "store_apply_field_op: {key} takes a number"
            )));
        }
    }
    Ok(())
}

/// Rewrite a field across the selected set in one pass. Replaces fetching every location
/// into JS to derive patches and shipping them all back. Keeps `known_field_keys`
/// truthful: keys the op erased from every row are forgotten (before the status snapshot),
/// so `StoreStatus.knownFieldKeys` reflects the data and a reappearing key is re-announced
/// through `new_field_defs`.
pub(crate) fn apply_field_op(
    store: &mut Store,
    selector: &Selector,
    op: &FieldOp,
    record_undo: bool,
) -> AppResult<FieldOpResult> {
    check_field_op(op)?;
    let plan = {
        let view = store.loc_view();
        let resolved = selections::narrow(&view, selector);
        plan_field_op(&view, resolved.as_ref(), op)?
    };
    for k in &plan.forget {
        store.known_field_keys.remove(k);
    }
    Ok(FieldOpResult {
        changed: plan.updates.len() as u32,
        skipped: plan.skipped,
        mutation: apply_updates(store, &plan.updates, record_undo),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn store_apply_field_op(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    op: FieldOp,
    record_undo: Option<bool>,
) -> AppResult<FieldOpResult> {
    let _t = std::time::Instant::now();
    with_store!(label, state, |store| {
        let result = apply_field_op(store, &selector, &op, record_undo.unwrap_or(true))?;
        log::debug!(
            "[cmd] store_apply_field_op total={}ms",
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
    /// Full replacement for the tag's doclink URLs (empty vec clears).
    pub doclinks: Option<Vec<String>>,
}

/// Apply a TagPatch's set fields in place. Blank names are ignored; `doclinks`
/// is a full-list replacement (empty vec clears).
pub(crate) fn apply_tag_patch(t: &mut Tag, patch: &TagPatch) {
    if let Some(n) = &patch.name {
        let trimmed = n.trim();
        if !trimmed.is_empty() {
            t.name = trimmed.to_string();
        }
    }
    apply_patch!(clone t, patch; color, doclinks);
}

/// Rename and/or recolor tags in one batch. Renaming onto an existing name (case-insensitive)
/// merges the two tags.
// Batched so a folder-cascade rename lands as one render instead of one per tag.
#[tauri::command]
#[specta::specta]
pub async fn store_update_tags(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    updates: Vec<Update<TagPatch>>,
) -> AppResult<MutationResult> {
    let _t = std::time::Instant::now();
    with_store!(label, state, |store| {
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
                let affected = selections::resolve(&view, &Selector::Tag { tag_id: u.id });
                drop(view);

                let mut updated: Vec<(Location, Location)> =
                    Vec::with_capacity(affected.len() as usize);
                for loc_id in &affected {
                    if let Some(old) = store.get_loc_by_id(loc_id) {
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
                apply_tag_patch(t, &u.patch);
            }
        }

        store.tags.dirty = true;
        let mut result = store.finish_mutation(&ChangeSet {
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
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    tag_ids: Vec<u32>,
) -> AppResult<MutationResult> {
    let _t = std::time::Instant::now();
    with_store!(label, state, |store| {
        let tag_set: HashSet<u32> = tag_ids.iter().copied().collect();
        let view = store.loc_view();
        let mut affected_ids = HashSet::new();
        for &tid in &tag_set {
            affected_ids.extend(selections::resolve(&view, &Selector::Tag { tag_id: tid }));
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
        // A zero-member tag never passes through update_tag_counts, so mark it touched
        // directly or finish_mutation skips the visible=false flip and the delete no-ops.
        store.tags.touched.extend(tag_set.iter().copied());
        let changeset = store.commit_tag_update(updated);
        Ok(store.finish_mutation(&changeset))
    })
}

/// Set (or clear) the active location. Fire-and-forget from JS; no re-render triggered.
/// JS patches the cell buffer synchronously to hide/show the active marker.
#[tauri::command]
#[specta::specta]
pub fn store_set_active(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    id: Option<u32>,
) -> AppResult<()> {
    with_store!(label, state, |store| {
        store.selections.active_id = id;
        Ok(())
    })
}

/// Set the default marker color used by the render delta path. Fire-and-forget from JS;
/// the JS side recolors its cell buffers in place (no full rebuild).
#[tauri::command]
#[specta::specta]
pub fn store_set_marker_color(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    color: [u8; 3],
) -> AppResult<()> {
    with_store!(label, state, |store| {
        store.render.marker_color = color;
        Ok(())
    })
}

/// Count locations by country (offline point-in-polygon). Returns unsorted (ISO-A2, count) pairs.
/// `level` selects border precision, falling back to "light" if unavailable.
// Coords are gathered under the store lock, then classified after it's released.
#[tauri::command]
#[specta::specta]
pub async fn store_country_distribution(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    level: String,
) -> AppResult<Vec<(String, u32)>> {
    let coords: Vec<(f64, f64)> = with_store!(label, state, |store| {
        let view = store.loc_view();
        let resolved = selections::narrow(&view, &selector);
        view.within(resolved.as_ref())
            .map(|row| (row.lat(), row.lng()))
            .collect()
    });
    crate::borders::tally_countries(&level, &coords)
}

/// Msgpack-serialize the overlay (uncommitted changes) for the `.delta` sidecar.
/// This is what lets the base file stay pinned at the last commit: on next
/// `store_open_map` the blob is loaded straight back into the overlay, and a commit
/// bakes it into the base and deletes the file.
fn overlay_delta_bytes(store: &Store) -> AppResult<Vec<u8>> {
    rmp_serde::to_vec_named(&store.overlay).map_err(AppError::from)
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
            if let Ok(delta) = rmp_serde::from_slice::<Overlay>(&data) {
                delta.apply_to(&mut locs);
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
///
/// Doclinks follow the same claim-if-empty rule: a matched target with no
/// doclinks adopts the source's list; existing assignments are never
/// overwritten by import.
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
    let mut adopted_doclinks = false;
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
        if !tag.doclinks.is_empty() {
            let target = target_tags.get_mut(&target_id).unwrap();
            if target.doclinks.is_empty() {
                target.doclinks = tag.doclinks.clone();
                adopted_doclinks = true;
            }
        }
        remap.insert(tag.id, target_id);
    }
    claims.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.2.cmp(&b.2)));
    let changed = created || adopted_doclinks || !claims.is_empty();
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

/// Copy locations into another map, skipping ones the target already has. Tags and extra
/// fields carry over.
// If the target is open in any window its live store is mutated and `store-external-mutation`
// tells its windows to resync; either way the result is persisted immediately.
#[tauri::command]
#[specta::specta]
pub fn store_copy_locations_to_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    target_map_id: String,
    selector: Selector,
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
    let source_map_id = mgr.map_id_for_window(&label.0)?;
    if source_map_id == target_map_id {
        return Err(AppError("cannot copy a location into its own map".into()));
    }

    let now = crate::util::now_unix();
    let mut sources: Vec<Location> = Vec::new();
    let mut source_tags: HashMap<u32, Tag> = HashMap::new();
    {
        let src = mgr.store_for_map(&source_map_id)?;
        for mut loc in src.collect(&selector) {
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
        let existing = target.collect(&Selector::Everything);
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
            crate::emit_event(ExternalMutation {
                result,
                map_id: target_map_id.clone(),
            });
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
        let (undo, redo) = load_edit_history(&target_map_id)?;
        let hist_ms = t_hist.elapsed().as_millis();
        let base_max = existing.iter().map(|l| l.id).max().unwrap_or(0);
        let next = seed_next_id(base_max, &[], &undo, &redo);
        for (loc, id) in fresh.iter_mut().zip(next..) {
            loc.id = id;
        }
        let t_save = std::time::Instant::now();
        let delta_path = storage::arrow_delta_path(&target_map_id)?;
        let mut delta: Overlay = if delta_path.exists() {
            rmp_serde::from_slice(&std::fs::read(&delta_path)?)?
        } else {
            Overlay::default()
        };
        delta.adds.extend(fresh);
        let bytes = rmp_serde::to_vec_named(&delta)?;
        let alive = existing.len() + copied as usize;
        persist_dirty(
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
pub(crate) fn persist_dirty(
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
    storage::set_location_count(&conn, map_id, alive)?;
    if let Some(tags_json) = tags_json {
        conn.execute(
            "UPDATE maps SET tags = ?1 WHERE id = ?2",
            rusqlite::params![tags_json, map_id],
        )?;
    }
    Ok(())
}

/// Autosave uncommitted changes to the delta sidecar. No-op when nothing changed.
// Does NOT bake the overlay (store_commit does). `overlay.dirty` is cleared only after the
// write lands and only if the overlay wasn't mutated in flight (rev guard), so a failed or
// raced save keeps the data flagged for the next attempt.
#[tauri::command]
#[specta::specta]
pub async fn store_save_dirty(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<SaveResult> {
    let _t = std::time::Instant::now();
    log::debug!("[cmd] store_save_dirty ENTER");
    let (map_id, delta_data, alive, tags_json, rev) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_window(&label.0)?;
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
    let wrote_tags = tags_json.is_some();
    let map_id2 = map_id.clone();
    let write =
        tokio::task::spawn_blocking(move || persist_dirty(&map_id2, delta_data, alive, tags_json))
            .await
            .unwrap_or_else(|e| Err(e.into()));
    if write.is_err() && wrote_tags {
        if let Ok(store) = state.lock()?.store_for_window(&label.0) {
            store.tags.dirty = true;
        }
    }
    write?;

    if wrote_delta {
        let mut mgr = state.lock()?;
        // The window may have closed or switched maps during the write; the map_id
        // check stops a fresh store (rev 0) from being cleared by a stale save.
        if let Ok(store) = mgr.store_for_window(&label.0) {
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
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<SummaryResult> {
    let _t = std::time::Instant::now();
    with_store!(label, state, |store| {
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
fn save_edit_history(map_id: &str, undo: &[EditEntry], redo: &[EditEntry]) -> AppResult<()> {
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
fn load_edit_history(map_id: &str) -> AppResult<(Vec<EditEntry>, Vec<EditEntry>)> {
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
pub(crate) fn save_arrow(store: &Store, map_id: &str) -> AppResult<()> {
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
pub(crate) fn bake_and_save(store: &mut Store, map_id: &str) -> AppResult<()> {
    let _t = std::time::Instant::now();
    store.bake_overlay();
    let t_bake = _t.elapsed();
    store.mmap_handle = None;
    save_arrow(store, map_id)?;
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
    storage::set_location_count(&conn, map_id, count)?;
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
    let paint_map = store.selections.paint_map();
    let active_id = store.selections.active_id;
    let arrow_style = req.marker_style == "arrow";

    // 32 cells indexed by render_cell_idx (0-31). Base markers all draw in the one marker
    // colour, which JS hands the layer as a constant, so the only per-marker colour fact
    // here is visibility. The selection overlay below genuinely varies and ships RGBA.
    struct CellOut {
        ids: Vec<u32>,
        positions: Vec<f32>,
        visible: Vec<u8>,
        angles: Vec<f32>,
    }
    const NONE: Option<CellOut> = None;
    let mut cells: [Option<CellOut>; 32] = [NONE; 32];

    // Selection overlay: selected entries rendered as a separate colored layer. `sel_idx`
    // is the drawing selection's index, which JS orders the entries by on load and keeps
    // them ordered by as later edits add and drop entries.
    struct SelOverlay {
        ids: Vec<u32>,
        positions: Vec<f32>,
        colors: Vec<u8>,
        angles: Vec<f32>,
        sel_idx: Vec<u32>,
    }
    let mut sel_ov = SelOverlay {
        ids: Vec::new(),
        positions: Vec::new(),
        colors: Vec::new(),
        angles: Vec::new(),
        sel_idx: Vec::new(),
    };

    {
        let mut emit = |id: u32, lat: f64, lng: f64, heading: f64| {
            let ci = render_cell_idx(lat, lng) as usize;
            let out = cells[ci].get_or_insert_with(|| CellOut {
                ids: Vec::new(),
                positions: Vec::new(),
                visible: Vec::new(),
                angles: Vec::new(),
            });
            out.positions.push(lng as f32);
            out.positions.push(lat as f32);
            let angle = if arrow_style { -(heading as f32) } else { 0.0 };
            // Hidden when the selection overlay or the active highlight is drawing it instead.
            let hidden = selected_set.contains(id) || active_id == Some(id);
            out.visible.push(if hidden { 0 } else { 255 });
            out.angles.push(angle);
            out.ids.push(id);
            if let Some(&SelPaint {
                idx,
                color: [r, g, b],
            }) = paint_map.get(&id)
            {
                sel_ov.positions.push(lng as f32);
                sel_ov.positions.push(lat as f32);
                sel_ov.colors.extend_from_slice(&[r, g, b, 255]);
                sel_ov.angles.push(angle);
                sel_ov.ids.push(id);
                sel_ov.sel_idx.push(idx);
            }
        };

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
            emit(id, lat, lng, heading);
        }
        for loc in &store.overlay.adds {
            emit(loc.id, loc.lat, loc.lng, loc.heading);
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

    // Serialize: u32 cell_count, per cell:
    //   [1 byte geohash char][u32 count][3 pad][u32[] ids][f32[] positions][u8[] visible][pad to 4][f32[] angles]
    // Arrays sit 4-byte aligned within the buffer so JS wraps them as views without copying.
    let body_cap: usize = (0..32)
        .filter_map(|ci| cells[ci].as_ref())
        .map(|o| {
            8 + o.ids.len() * 4 + o.positions.len() * 4 + o.visible.len() + 3 + o.angles.len() * 4
        })
        .sum();
    let sel_cap = if sel_ov.ids.is_empty() {
        0
    } else {
        sel_ov.positions.len() * 4
            + sel_ov.colors.len()
            + sel_ov.angles.len() * 4
            + sel_ov.ids.len() * 4
            + sel_ov.sel_idx.len() * 4
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
        buf.extend_from_slice(&[0u8; 3]);
        // cast_slice = native-endian; all supported targets are little-endian like the JS side.
        buf.extend_from_slice(bytemuck::cast_slice(&out.ids));
        buf.extend_from_slice(bytemuck::cast_slice(&out.positions));
        buf.extend_from_slice(&out.visible);
        buf.extend_from_slice(&[0u8; 3][..(4 - out.visible.len() % 4) % 4]);
        buf.extend_from_slice(bytemuck::cast_slice(&out.angles));
    }

    // Selection overlay, in emission order. `selIdx` is the z key: JS sorts by it on load,
    // the same way it does after every delta, so the ordering lives in one implementation.
    // [u32 count][f32[] positions][u8[] colors][f32[] angles][u32[] ids][u32[] selIdx]
    let sel_count = sel_ov.ids.len() as u32;
    buf.extend_from_slice(&sel_count.to_le_bytes());
    if sel_count > 0 {
        buf.extend_from_slice(bytemuck::cast_slice(&sel_ov.positions));
        buf.extend_from_slice(&sel_ov.colors);
        buf.extend_from_slice(bytemuck::cast_slice(&sel_ov.angles));
        buf.extend_from_slice(bytemuck::cast_slice(&sel_ov.ids));
        buf.extend_from_slice(bytemuck::cast_slice(&sel_ov.sel_idx));
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
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    req: RenderRequest,
) -> AppResult<String> {
    let (buf, map_id_str) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_window(&label.0)?;
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
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    cell: String,
    cell_index: u32,
) -> AppResult<Option<u32>> {
    with_store!(label, state, |store| {
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
pub async fn store_undo(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<MutationResult> {
    with_store!(label, state, |store| {
        let _t = std::time::Instant::now();
        let entry = store.edits.undo.pop().ok_or("nothing to undo")?;
        log::debug!(
            "[UNDO] stack_depth={} created={} removed={}",
            store.edits.undo.len(),
            entry.created.len(),
            entry.removed.len()
        );
        let changes = store.apply_edit_reverse(&entry);
        log::debug!(
            "[UNDO] apply_edit={}ms changes: +{} ~{} -{}",
            _t.elapsed().as_millis(),
            changes.added.len(),
            changes.updated.len(),
            changes.removed.len()
        );
        store.edits.redo.push(entry);
        Ok(store.finish_mutation(&changes))
    })
}

/// Pop the redo stack and replay the edit forward. Pushes the entry back onto undo.
#[tauri::command]
#[specta::specta]
pub async fn store_redo(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<MutationResult> {
    with_store!(label, state, |store| {
        let _t = std::time::Instant::now();
        let entry = store.edits.redo.pop().ok_or("nothing to redo")?;
        log::debug!(
            "[REDO] stack_depth={} created={} removed={}",
            store.edits.redo.len(),
            entry.created.len(),
            entry.removed.len()
        );
        let changes = store.apply_edit_forward(&entry);
        log::debug!(
            "[REDO] apply_edit={}ms changes: +{} ~{} -{}",
            _t.elapsed().as_millis(),
            changes.added.len(),
            changes.updated.len(),
            changes.removed.len()
        );
        store.push_undo(entry);
        Ok(store.finish_mutation(&changes))
    })
}

/// The uncommitted changes since the last commit -- the same changeset `store_commit` will record.
// Derived from the overlay, not the undo stack: the stack is capped, and non-undoable edits
// (enrichment, field renames, plugin batches) bypass it while still being part of the commit.
#[tauri::command]
#[specta::specta]
pub fn store_commit_diff(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<(u32, u32, u32)> {
    with_store!(label, state, |store| { Ok(store.overlay_diff_counts()) })
}

/// Clear both undo and redo stacks. Called after a commit to start fresh.
#[tauri::command]
#[specta::specta]
pub fn store_reset_undo(label: WindowLabel, state: tauri::State<'_, StoreState>) -> AppResult<()> {
    with_store!(label, state, |store| {
        store.edits.undo.clear();
        store.edits.redo.clear();
        Ok(())
    })
}

/// Fold a duplicate group into one survivor. Survivor = highest `score` (the map's
/// duplicate preference expression, or tag count when it has none), then earliest
/// `created_at`, then lowest id (`max_by` picks the greatest, so created_at/id are
/// reversed to favour smaller). A location the expression can't evaluate ranks below
/// every one it can. Tags are set-unioned; `extra` is merged with the survivor winning
/// key conflicts; all other survivor fields are kept. `members` must be non-empty. The
/// returned survivor keeps its original id (so callers represent the merge as an update
/// of the survivor plus removal of the rest).
fn merge_group(members: &[Location], score: Option<&crate::field_expr::Expr>) -> Location {
    let rank = |l: &Location| -> Option<f64> {
        let Some(expr) = score else {
            return Some(l.tags.len() as f64);
        };
        let row = selections::RowRef::from_loc(l);
        crate::field_expr::eval(expr, &|name| {
            row.resolve_field(name).as_ref().and_then(|v| v.as_f64())
        })
    };
    let survivor = members
        .iter()
        .max_by(|a, b| {
            // Option orders None below Some; eval never yields NaN, so partial_cmp is total.
            rank(a)
                .partial_cmp(&rank(b))
                .unwrap_or(std::cmp::Ordering::Equal)
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

/// Rebuild registry counts from a location scan (map open). Counted tags are
/// forced visible: commit checkout restores locations without reviving their
/// soft-deleted tags, so a count>0/visible=false pair is always a desync.
/// Returns (max tag id, whether any tag was revived and needs persisting).
fn reconcile_tag_registry(
    tags: &mut HashMap<u32, Tag>,
    tag_counts: &HashMap<u32, usize>,
) -> (u32, bool) {
    for tag in tags.values_mut() {
        tag.count = 0;
    }
    let mut max_tag_id: u32 = tags.keys().max().copied().unwrap_or(0);
    let mut healed = false;
    for (&tid, &count) in tag_counts {
        max_tag_id = max_tag_id.max(tid);
        let tag = tags.entry(tid).or_insert_with(|| Tag {
            id: tid,
            name: format!("Tag {}", tid),
            color: util::color_for_name(&format!("Tag {}", tid)),
            visible: true,
            order: None,
            count: 0,
            doclinks: Vec::new(),
        });
        tag.count = count;
        healed |= !tag.visible;
        tag.visible = true;
    }
    (max_tag_id, healed)
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
///
/// `location_ids` assigns every resulting tag to those locations in the same mutation.
/// Doing both here is not a convenience: creating and assigning as two commands leaves the
/// tag visible at count 0 for the round trip in between, and makes the caller fetch every
/// location into JS just to append an id Rust already has.
#[tauri::command]
#[specta::specta]
pub fn store_create_tags(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    names: Vec<String>,
    selector: Selector,
) -> AppResult<MutationResult> {
    with_store!(label, state, |store| {
        let location_ids: Vec<u32> = {
            let view = store.loc_view();
            let resolved = selections::narrow(&view, &selector);
            selections::ids_within(&view, resolved.as_ref())
        };
        Ok(store.create_tags(&names, &location_ids))
    })
}

/// Persist tag ordering. `ordered_ids` specifies the desired order; each tag's
/// `order` field is set to its index in the list.
#[tauri::command]
#[specta::specta]
pub fn store_reorder_tags(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    ordered_ids: Vec<u32>,
) -> AppResult<MutationResult> {
    with_store!(label, state, |store| {
        for (i, &id) in ordered_ids.iter().enumerate() {
            if let Some(tag) = store.tags.all.get_mut(&id) {
                tag.order = Some(i as u32);
            }
        }
        store.tags.dirty = true;
        let mut result = store.finish_mutation(&ChangeSet::default());
        result.tags = Some(store.tags.all.clone());
        Ok(result)
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
    pub selector: Selector,
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
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    sels: Vec<SelectionInput>,
) -> AppResult<SelectionSync> {
    let _t = std::time::Instant::now();
    let (counts, buf, selected_count, num_cells) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_window(&label.0)?;

        // Faithful tree: real keys preserved so per-node counts come back keyed (incl. nested).
        let sels_full: Vec<selections::Selection> = sels
            .iter()
            .map(|si| selections::Selection {
                key: si.key.clone(),
                color: si.color,
                selector: si.selector.clone(),
            })
            .collect();

        // 1. Resolve the whole forest in one pass: per-selection Roaring id-sets plus
        //    counts for every node (top-level and nested). Tag leaves hit the membership
        //    index; composites combine natively. (Geometric leaves still scan.)
        //    Counts cover ghosted selections too; the overlay uses the non-ghosted subset.
        let view = store.loc_view();
        let (sel_sets, counts) = selections::resolve_forest(&view, &sels_full);
        drop(view);

        // 2. Drop the ghosted ones once, here. Everything downstream reads `live`, so the
        //    selections and their member sets can never be filtered by two different rules.
        let live: Vec<ResolvedSelection> = pair_selections(sels_full, sel_sets)
            .into_iter()
            .zip(&sels)
            .filter(|(_, si)| !si.ghosted)
            .map(|(r, _)| r)
            .collect();

        let mut all_selected = RoaringBitmap::new();
        for r in &live {
            all_selected |= &r.set;
        }
        let selected_count = all_selected.len() as usize;

        // 3. Route selections to per-cell indices (O(selected), not O(S*N)), then
        //    serialize the per-cell bitmask binary.
        let render_total = store.render.total_len();
        let (buf, num_cells) = build_selection_buf(&store.render, &live);

        store.selections.ids = all_selected;
        store.selections.resolved = live;
        store.selections.node_counts = counts.clone();
        store.selections.version += 1;

        log::debug!("[cmd] store_sync_selections total={}ms sels={} selected={} cells={} buf_size={} batch_rows={} overlay_adds={} dead={} alive={} render_total={} first_set_len={} counts={:?}",
            _t.elapsed().as_millis(), sels.len(), selected_count, num_cells, buf.len(),
            store.batch.as_ref().map_or(0, |b| b.num_rows()), store.overlay.adds.len(),
            store.overlay.dead.len(), store.alive_count, render_total,
            store.selections.resolved.first().map_or(0, |r| r.set.len() as usize), counts);

        (counts, buf, selected_count, num_cells)
    };

    let bitmask = if num_cells > 0 { Some(buf) } else { None };
    Ok(SelectionSync {
        counts,
        bitmask,
        selected_count,
    })
}

/// `pick_spaced`'s answer: the picked ids plus the spacing achieved (count mode) or
/// enforced (distance mode).
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SpacedPickResult {
    pub ids: Vec<u32>,
    pub distance_m: i32,
}

/// Above this many rows, `store_collect` stages a file instead of answering over IPC.
const ROWS_INLINE_MAX: usize = 1024;

/// How `store_collect` shipped its answer. A transport choice, not a projection: both
/// variants carry the same rows, and callers take whichever arrives.
#[derive(serde::Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Rows {
    Inline { locations: Vec<Location> },
    File { path: String },
}

/// A rotating slot per rows-file query: the file is fetched after the store lock is
/// released, so two concurrent row reads must not share one path -- while the slot
/// cycle keeps stale files bounded and self-overwriting like a fixed path.
fn rows_file_path(temp: &std::path::Path, map_id: &str) -> std::path::PathBuf {
    static SLOT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let slot = SLOT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % 8;
    temp.join(format!("mma_rows_{map_id}_{slot}.json"))
}

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

/// Ids of every location the selector resolves to, ascending.
#[tauri::command]
#[specta::specta]
pub fn store_resolve(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
) -> AppResult<Vec<u32>> {
    selector_read!(label, state, selector, |view, set| selections::ids_within(
        &view, set
    ))
}

/// How many locations the selector resolves to. Counts rows, never materializes them.
#[tauri::command]
#[specta::specta]
pub fn store_count(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
) -> AppResult<u32> {
    selector_read!(
        label,
        state,
        selector,
        |view, set| selections::count_within(&view, set)
    )
}

/// `n` ids drawn uniformly at random from the selected set, without replacement.
#[tauri::command]
#[specta::specta]
pub fn store_sample(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    n: u32,
) -> AppResult<Vec<u32>> {
    selector_read!(label, state, selector, |view, set| selections::sample(
        selections::ids_within(&view, set),
        n as usize
    ))
}

/// An evenly spaced subset: exactly one of `target_count` (thin to N, maximizing
/// spacing) or `min_distance_m` (keep as many as fit at that spacing).
#[tauri::command]
#[specta::specta]
pub fn store_spaced(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    target_count: Option<u32>,
    min_distance_m: Option<u32>,
) -> AppResult<SpacedPickResult> {
    selector_read!(label, state, selector, store: |store, set| store.pick_spaced(
        set,
        target_count,
        min_distance_m
    )?)
}

/// Group by a derived key, returning `{ key, ids, bin }` per group.
#[tauri::command]
#[specta::specta]
pub fn store_group_by(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    field: String,
    key: selections::KeySpec,
) -> AppResult<Vec<selections::PartitionBucket>> {
    selector_read!(label, state, selector, |view, set| selections::partition(
        &view, &field, &key, set
    ))
}

/// Group by a derived key, returning counts only -- no member ids on the wire.
#[tauri::command]
#[specta::specta]
pub fn store_count_by(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    field: String,
    key: selections::KeySpec,
) -> AppResult<Vec<(String, u32)>> {
    selector_read!(label, state, selector, |view, set| selections::count_by(
        &view, &field, &key, set
    ))
}

/// Distinct values of `field` across the selected set, sorted.
#[tauri::command]
#[specta::specta]
pub fn store_values(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    field: String,
) -> AppResult<Vec<String>> {
    selector_read!(label, state, selector, |view, set| {
        selections::distinct_values(&view, &field, set)
    })
}

/// How many rows carry each top-level `extra` key, key-sorted.
#[tauri::command]
#[specta::specta]
pub fn store_coverage(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
) -> AppResult<Vec<(String, u32)>> {
    selector_read!(label, state, selector, |view, set| {
        selections::extra_key_coverage(&view, set)
    })
}

/// Per-field columns of the selected set. One value per row per field, `null` where a
/// row lacks it; `"tags"` is a column of tag-id arrays.
#[derive(serde::Serialize, specta::Type)]
#[serde(transparent)]
pub struct Columns(
    #[specta(type = Vec<Vec<specta_typescript::Unknown>>)] pub Vec<Vec<serde_json::Value>>,
);

/// Values, never rows: the projection for a scan that reads fields across a set.
#[tauri::command]
#[specta::specta]
pub fn store_columns(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    fields: Vec<String>,
) -> AppResult<Columns> {
    selector_read!(label, state, selector, |view, set| {
        Columns(selections::columns_within(&view, set, &fields))
    })
}

/// Bounding box `[west, south, east, north]`, or `None` when the set is empty.
#[tauri::command]
#[specta::specta]
pub fn store_bounds(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
) -> AppResult<Option<[f64; 4]>> {
    // The whole-map box is maintained incrementally; narrower ones scan.
    selector_read!(label, state, selector, store: |store, set| match set {
        None => store.cached_bounds(),
        Some(set) => store.compute_bounds(Some(set)),
    })
}

/// Full rows. The last resort -- prefer a projection. Every row is materialized in
/// webview memory, so an `Everything` call costs O(map). Large answers are staged to a file
/// rather than pushed through the IPC channel.
#[tauri::command]
#[specta::specta]
pub fn store_collect(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
) -> AppResult<Rows> {
    with_store!(label, state, |store| {
        let locations = store.collect(&selector);
        if locations.len() <= ROWS_INLINE_MAX {
            return Ok(Rows::Inline { locations });
        }
        let map_id_str = store.map_id.as_deref().unwrap_or("default");
        let path = rows_file_path(&storage::temp_dir()?, map_id_str);
        std::fs::write(&path, serde_json::to_vec(&locations)?)?;
        Ok(Rows::File {
            path: path.to_string_lossy().into_owned(),
        })
    })
}

/// Transitive spatial duplicate groups (connected components, size >= 2) within `distance`
/// metres. Read-only; used to preview a merge. Returns groups of location IDs.
#[tauri::command]
#[specta::specta]
pub fn store_duplicate_groups(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    distance: f64,
) -> AppResult<Vec<Vec<u32>>> {
    with_store!(label, state, |store| {
        let view = store.loc_view();
        Ok(selections::find_duplicate_groups(&view, distance))
    })
}

/// Merge each duplicate group within `distance` metres into one survivor location, unioning
/// tags and extra fields. `score` is the map's duplicate preference expression; blank or
/// absent keeps the built-in ranking. One undoable edit.
// Survivor = highest score, then earliest created_at, then lowest id; extra merges
// survivor-wins.
#[tauri::command]
#[specta::specta]
pub async fn store_merge_duplicates(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    distance: f64,
    score: Option<String>,
) -> AppResult<MutationResult> {
    let _t = std::time::Instant::now();
    let score = match score.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(src) => Some(crate::field_expr::parse(src)?),
        None => None,
    };
    with_store!(label, state, |store| {
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
            create.push(merge_group(&members, score.as_ref()));
            for m in members {
                remove.push(m);
            }
        }

        log::debug!(
            "[cmd] store_merge_duplicates groups={} merged_away={} total={}ms",
            create.len(),
            remove.len().saturating_sub(create.len()),
            _t.elapsed().as_millis()
        );
        Ok(store.apply_undoable(remove, create))
    })
}

/// Thin duplicates among `ids` within `distance` metres, keeping the best location per
/// cluster. Informational locations are never pruned. One undoable edit.
// <= 25m: best-scored per cluster (keep_tag_ids +5, see selections::prune_score);
// > 25m: greedy thinning so no two survivors remain in range.
#[tauri::command]
#[specta::specta]
pub async fn store_prune_duplicates(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    distance: f64,
    keep_tag_ids: Vec<u32>,
) -> AppResult<MutationResult> {
    let _t = std::time::Instant::now();
    with_store!(label, state, |store| {
        let locs: Vec<Location> = store.collect(&selector);
        let keep: HashSet<u32> = keep_tag_ids.into_iter().collect();
        let prune_ids: HashSet<u32> = selections::prune_duplicates(&locs, distance, &keep)
            .into_iter()
            .collect();
        let total = locs.len();
        let remove: Vec<Location> = locs
            .into_iter()
            .filter(|l| prune_ids.contains(&l.id))
            .collect();

        log::debug!(
            "[cmd] store_prune_duplicates pruned={} of {} total={}ms",
            remove.len(),
            total,
            _t.elapsed().as_millis()
        );
        Ok(store.apply_undoable(remove, Vec::new()))
    })
}

/// Find all locations within `radius_m` metres of (`lat`, `lng`).
// Lazy spatial index: O(cells in radius) per query after a one-time O(N) build, maintained
// incrementally. Called on every marker click (duplicate check), so it must not scan.
#[tauri::command]
#[specta::specta]
pub fn store_find_nearby(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    lat: f64,
    lng: f64,
    radius_m: f64,
) -> AppResult<Vec<Location>> {
    with_store!(label, state, |store| {
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
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    lats: Vec<f64>,
    lngs: Vec<f64>,
    radius_m: f64,
) -> AppResult<Vec<bool>> {
    if lats.len() != lngs.len() {
        return Err(AppError::from("store_near_any: lats/lngs length mismatch"));
    }
    with_store!(label, state, |store| {
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

#[cfg(test)]
#[path = "location_store.test.rs"]
mod tests;

#[cfg(feature = "bench")]
#[path = "location_store.bench.rs"]
pub mod bench;
