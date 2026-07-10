//! Bitmask-based selection resolution engine.
//!
//! Selections are predicates over the location set (tag membership, polygon containment,
//! duplicates, filters on arbitrary fields, etc.). This module resolves each selection to
//! a `Vec<bool>` bitmask over the unified `LocView` (batch + overlay), using rayon for
//! parallel evaluation. Composite selections (Intersection, Union, Invert) combine child
//! bitmasks. The bitmasks are then serialized into a per-cell binary format that JS reads
//! to color the selection overlay.

use crate::types::{Location, LocationFlags};
use crate::util::{tz_offset_seconds, unix_to_hour_min, unix_to_month_day};
use arrow_array::{Array, Float64Array, ListArray, RecordBatch, StringArray, UInt32Array};
use chrono::{DateTime, Datelike, Timelike, Utc};
use rayon::prelude::*;
use roaring::RoaringBitmap;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Discriminated union of all selection types. Serialized with `{ "type": "..." }` tag
/// for JS interop. Simple types (Tag, Untagged, PanoIds, etc.) resolve in O(N) with
///  parallel batch scans. Composites (Intersection, Union, Invert) recursively resolve
/// children. Duplicates uses a grid-accelerated spatial scan.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum SelectionProps {
    Locations {
        locations: Vec<u32>,
        name: Option<String>,
    },
    Everything,
    #[serde(rename_all = "camelCase")]
    Polygon {
        polygon: PolygonGeometry,
        #[serde(rename = "includeInformational")]
        include_informational: bool,
    },
    Tag {
        #[serde(rename = "tagId")]
        tag_id: u32,
    },
    Untagged,
    Unpanned,
    PanoIds,
    NotPanoIds,
    Uncommitted,
    Manual {
        locations: Vec<u32>,
    },
    Duplicates {
        distance: f64,
    },
    ValidationState {
        locations: Vec<u32>,
        state: u8,
    },
    #[serde(rename_all = "camelCase")]
    Reviewed {
        locations: Vec<u32>,
        session_id: String,
        mode: String,
    },
    Intersection {
        selections: Vec<Selection>,
    },
    Union {
        selections: Vec<Selection>,
    },
    Invert {
        selections: Vec<Selection>,
    },
    Filter {
        field: String,
        op: FilterOp,
        #[specta(type = specta_typescript::Any)]
        value: serde_json::Value,
        #[serde(default)]
        #[specta(type = Option<specta_typescript::Any>)]
        value2: Option<serde_json::Value>,
        #[serde(default, rename = "tzLocal")]
        tz_local: bool,
    },
    TopK {
        field: String,
        k: u32,
        ascending: bool,
    },
}

/// Filter comparison operator. Single source of truth: specta renders the literal
/// union, so the TS `FilterOp` type and `OP_LABELS` derive from this enum.
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Neq,
    Gt,
    Lt,
    Gte,
    Lte,
    Between,
    BetweenAnyyear,
    BetweenAnytime,
    Has,
    Nothas,
    Contains,
    Notcontains,
}

/// GeoJSON-like polygon geometry. `coordinates` is the primary polygon (outer ring +
/// optional holes). `extra_polygons` allows multipolygon selections (e.g., from GeoJSON import).
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PolygonGeometry {
    pub coordinates: Vec<Vec<[f64; 2]>>,
    #[serde(default)]
    pub extra_polygons: Option<Vec<Vec<Vec<[f64; 2]>>>>,
    #[serde(default)]
    #[specta(type = Option<specta_typescript::Any>)]
    pub properties: Option<serde_json::Value>,
}

/// A named, colored selection. `key` is deterministic (e.g., `"tag:5"`, `"polygon:abc"`)
/// so JS can diff selections across syncs. `color` is the RGB overlay color.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub key: String,
    pub color: [u8; 3],
    pub props: SelectionProps,
}

// ---------------------------------------------------------------------------
// LocView: unified view over Arrow batch + overlay
// ---------------------------------------------------------------------------

/// Unified read-only view over Arrow batch + overlay (dead, patches, adds).
/// Caches column downcast refs on construction to avoid repeated downcasts.
pub struct LocView<'a> {
    batch: Option<&'a RecordBatch>,
    dead: &'a HashSet<u32>,
    patches: &'a HashMap<u32, Location>,
    adds: &'a [Location],
    // Cached column refs (from batch)
    ids: Option<&'a UInt32Array>,
    lats: Option<&'a Float64Array>,
    lngs: Option<&'a Float64Array>,
    headings: Option<&'a Float64Array>,
    pitches: Option<&'a Float64Array>,
    zooms: Option<&'a Float64Array>,
    flags: Option<&'a UInt32Array>,
    tags: Option<&'a ListArray>,
    extras: Option<&'a StringArray>,
    created_ats: Option<&'a UInt32Array>,
    modified_ats: Option<&'a UInt32Array>,
    batch_rows: usize,
    has_dead: bool,
    has_patches: bool,
    /// Optional `tag_id -> member location ids` index. When present, a `Tag` leaf
    /// resolves by cloning the set instead of scanning every row's tag list.
    tag_sets: Option<&'a HashMap<u32, RoaringBitmap>>,
}

/// One alive location yielded by [`LocView::for_each`]. Provides uniform field
/// access regardless of whether the data lives in an Arrow batch column or a
/// materialized `Location` struct (patch or overlay add).
pub struct RowRef<'a, 'v> {
    inner: RowInner<'a, 'v>,
}

// SAFETY: RowRef only holds shared references to immutable Arrow arrays and
// Location structs. Nothing is mutated through these references during parallel
// iteration. The borrow checker can't prove this statically because LocView
// holds non-Send references, but all accessed data is effectively read-only.
unsafe impl Send for RowRef<'_, '_> {}
unsafe impl Sync for RowRef<'_, '_> {}

enum RowInner<'a, 'v> {
    Base(&'v LocView<'a>, usize),
    Loc(&'a Location),
}

impl<'a> RowRef<'a, '_> {
    pub fn from_loc(loc: &'a Location) -> Self {
        RowRef {
            inner: RowInner::Loc(loc),
        }
    }
}

impl<'a, 'v> RowRef<'a, 'v> {
    #[inline]
    pub fn id(&self) -> u32 {
        match &self.inner {
            RowInner::Base(v, i) => v.batch_id(*i),
            RowInner::Loc(l) => l.id,
        }
    }
    #[inline]
    pub fn lat(&self) -> f64 {
        match &self.inner {
            RowInner::Base(v, i) => v.lats.unwrap().value(*i),
            RowInner::Loc(l) => l.lat,
        }
    }
    #[inline]
    pub fn lng(&self) -> f64 {
        match &self.inner {
            RowInner::Base(v, i) => v.lngs.unwrap().value(*i),
            RowInner::Loc(l) => l.lng,
        }
    }
    #[inline]
    pub fn heading(&self) -> f64 {
        match &self.inner {
            RowInner::Base(v, i) => v.headings.unwrap().value(*i),
            RowInner::Loc(l) => l.heading,
        }
    }
    #[inline]
    pub fn pitch(&self) -> f64 {
        match &self.inner {
            RowInner::Base(v, i) => v.pitches.unwrap().value(*i),
            RowInner::Loc(l) => l.pitch,
        }
    }
    #[inline]
    pub fn zoom(&self) -> f64 {
        match &self.inner {
            RowInner::Base(v, i) => v.zooms.unwrap().value(*i),
            RowInner::Loc(l) => l.zoom,
        }
    }
    #[inline]
    pub fn flags(&self) -> LocationFlags {
        match &self.inner {
            RowInner::Base(v, i) => LocationFlags::from_bits_retain(v.flags.unwrap().value(*i)),
            RowInner::Loc(l) => l.flags,
        }
    }
    pub fn has_tag(&self, tag_id: u32) -> bool {
        match &self.inner {
            RowInner::Base(v, i) => {
                let list = v.tags.unwrap().value(*i);
                let ids = list.as_any().downcast_ref::<UInt32Array>().unwrap();
                (0..ids.len()).any(|k| ids.value(k) == tag_id)
            }
            RowInner::Loc(l) => l.tags.contains(&tag_id),
        }
    }
    pub fn tags_empty(&self) -> bool {
        match &self.inner {
            RowInner::Base(v, i) => v.tags.unwrap().value(*i).is_empty(),
            RowInner::Loc(l) => l.tags.is_empty(),
        }
    }
    pub fn for_each_tag(&self, mut f: impl FnMut(u32)) {
        match &self.inner {
            RowInner::Base(v, i) => {
                let list = v.tags.unwrap().value(*i);
                let ids = list.as_any().downcast_ref::<UInt32Array>().unwrap();
                for j in 0..ids.len() {
                    f(ids.value(j));
                }
            }
            RowInner::Loc(l) => {
                for &t in &l.tags {
                    f(t);
                }
            }
        }
    }
    pub fn resolve_field(&self, field: &str) -> Option<serde_json::Value> {
        match &self.inner {
            RowInner::Base(v, i) => resolve_field_arrow(v, *i, field),
            RowInner::Loc(l) => resolve_field_loc(l, field),
        }
    }
    /// Resolve `field` plus the companion `timezone` with at most one extras-JSON parse.
    /// The tz_local filter path reads both per row; going through `resolve_field` twice
    /// would parse the extras blob twice.
    pub fn resolve_field_and_tz(&self, field: &str) -> (Option<serde_json::Value>, Option<String>) {
        match &self.inner {
            RowInner::Loc(l) => (
                resolve_field_loc(l, field),
                l.extra
                    .as_ref()
                    .and_then(|e| e.get("timezone"))
                    .and_then(|v| v.as_str().map(str::to_owned)),
            ),
            RowInner::Base(v, i) => {
                let extras: Option<serde_json::Map<String, serde_json::Value>> =
                    v.extras.and_then(|c| {
                        if c.is_null(*i) {
                            return None;
                        }
                        serde_json::from_str(c.value(*i)).ok()
                    });
                let tz = extras
                    .as_ref()
                    .and_then(|m| m.get("timezone"))
                    .and_then(|v| v.as_str())
                    .map(str::to_owned);
                // Built-in names come from their columns; keep in sync with resolve_field_arrow.
                let fv = match field {
                    "lat" | "lng" | "heading" | "pitch" | "zoom" | "id" | "createdAt"
                    | "modifiedAt" => resolve_field_arrow(v, *i, field),
                    _ => extras.as_ref().and_then(|m| m.get(field).cloned()),
                };
                (fv, tz)
            }
        }
    }
    pub fn to_location(&self) -> Location {
        match &self.inner {
            RowInner::Base(v, i) => v.loc_at(*i),
            RowInner::Loc(l) => (*l).clone(),
        }
    }
    pub fn matches(&self, props: &SelectionProps) -> bool {
        test_row(self, props)
    }
    /// Whether this row lives in the overlay (an add or a patch) rather than the
    /// committed base batch -- i.e. it has uncommitted changes since the last commit.
    pub fn is_uncommitted(&self) -> bool {
        matches!(self.inner, RowInner::Loc(_))
    }
}

impl<'a> LocView<'a> {
    pub fn new(
        batch: Option<&'a RecordBatch>,
        dead: &'a HashSet<u32>,
        patches: &'a HashMap<u32, Location>,
        adds: &'a [Location],
        tag_sets: Option<&'a HashMap<u32, RoaringBitmap>>,
    ) -> Self {
        use crate::arrow_bridge::{
            col_created_at, col_extra, col_flags, col_heading, col_id, col_lat, col_lng,
            col_modified_at, col_pitch, col_tags, col_zoom,
        };
        let batch_rows = batch.map_or(0, |b| b.num_rows());
        let ids = batch.map(col_id);
        let lats = batch.map(col_lat);
        let lngs = batch.map(col_lng);
        let headings = batch.map(col_heading);
        let pitches = batch.map(col_pitch);
        let zooms = batch.map(col_zoom);
        let flags = batch.map(col_flags);
        let tags = batch.map(col_tags);
        let extras = batch.map(col_extra);
        let created_ats = batch.map(col_created_at);
        let modified_ats = batch.map(col_modified_at);
        let has_dead = !dead.is_empty();
        let has_patches = !patches.is_empty();
        Self {
            batch,
            dead,
            patches,
            adds,
            ids,
            lats,
            lngs,
            headings,
            pitches,
            zooms,
            flags,
            tags,
            extras,
            created_ats,
            modified_ats,
            batch_rows,
            has_dead,
            has_patches,
            tag_sets,
        }
    }

    /// Number of rows in the Arrow batch (before overlay).
    pub fn batch_rows(&self) -> usize {
        self.batch_rows
    }
    /// Read the raw batch ID at row `i` (no overlay check).
    pub fn batch_id(&self, i: usize) -> u32 {
        self.ids.unwrap().value(i)
    }

    /// Whether batch row `i` is alive (not in the dead set).
    #[inline]
    pub fn is_alive(&self, i: usize) -> bool {
        !self.has_dead || !self.dead.contains(&self.batch_id(i))
    }

    /// Return the overlay patch for batch row `i`, if one exists.
    #[inline]
    pub fn patch_at(&self, i: usize) -> Option<&Location> {
        if !self.has_patches {
            return None;
        }
        self.patches.get(&self.batch_id(i))
    }

    /// Read the effective ID at batch row `i`, checking patches first.
    pub fn id_at(&self, i: usize) -> u32 {
        if self.has_patches {
            if let Some(p) = self.patches.get(&self.batch_id(i)) {
                return p.id;
            }
        }
        self.batch_id(i)
    }

    /// Materialize batch row `i` into a full `Location`.
    pub fn loc_at(&self, i: usize) -> Location {
        crate::arrow_bridge::row_to_location(self.batch.unwrap(), i)
    }

    /// Visit every alive location once, overlay applied: dead rows skipped, patched
    /// rows surfaced as `RowRef::Loc`, then the overlay adds. The patch is resolved a
    /// single time per row. Serial; `f` may accumulate.
    #[inline]
    pub fn for_each(&self, mut f: impl FnMut(RowRef)) {
        for i in 0..self.batch_rows {
            if !self.is_alive(i) {
                continue;
            }
            match self.patch_at(i) {
                Some(p) => f(RowRef {
                    inner: RowInner::Loc(p),
                }),
                None => f(RowRef {
                    inner: RowInner::Base(self, i),
                }),
            }
        }
        for loc in self.adds {
            f(RowRef {
                inner: RowInner::Loc(loc),
            });
        }
    }

    /// Build a bool mask over all locations (batch + adds) using a per-row predicate.
    /// Batch rows are scanned in parallel with rayon. O(N) with parallel speedup.
    pub fn resolve_mask(&self, test: impl Fn(&RowRef) -> bool + Sync + Send) -> Vec<bool> {
        let mut mask: Vec<bool> = (0..self.batch_rows)
            .into_par_iter()
            .with_min_len(CHUNK_SIZE)
            .map(|i| {
                if !self.is_alive(i) {
                    return false;
                }
                let row = match self.patch_at(i) {
                    Some(p) => RowRef {
                        inner: RowInner::Loc(p),
                    },
                    None => RowRef {
                        inner: RowInner::Base(self, i),
                    },
                };
                test(&row)
            })
            .collect();
        mask.extend(self.adds.iter().map(|loc| test(&RowRef::from_loc(loc))));
        mask
    }
}

// ---------------------------------------------------------------------------
// Bitmask resolve
// ---------------------------------------------------------------------------

fn test_row(r: &RowRef, props: &SelectionProps) -> bool {
    match props {
        SelectionProps::Everything => true,
        SelectionProps::Locations { locations, .. }
        | SelectionProps::Manual { locations }
        | SelectionProps::ValidationState { locations, .. }
        | SelectionProps::Reviewed { locations, .. } => locations.contains(&r.id()),
        SelectionProps::Tag { tag_id } => r.has_tag(*tag_id),
        SelectionProps::Untagged => r.tags_empty(),
        SelectionProps::Unpanned => r.heading() == 0.0,
        SelectionProps::PanoIds => r.flags().contains(LocationFlags::LOAD_AS_PANO_ID),
        SelectionProps::NotPanoIds => !r.flags().contains(LocationFlags::LOAD_AS_PANO_ID),
        SelectionProps::Uncommitted => r.is_uncommitted(),
        SelectionProps::Polygon {
            polygon,
            include_informational,
        } => {
            if !include_informational && r.flags().contains(LocationFlags::INFORMATIONAL) {
                return false;
            }
            point_in_geometry(r.lng(), r.lat(), polygon)
        }
        SelectionProps::Filter {
            field,
            op,
            value,
            value2,
            tz_local,
        } => {
            // tz_local only applies where a clock frame matters; has/nothas/eq/neq
            // keep their normal semantics even if the flag is set.
            if *tz_local
                && matches!(
                    op,
                    FilterOp::Gt
                        | FilterOp::Lt
                        | FilterOp::Gte
                        | FilterOp::Lte
                        | FilterOp::Between
                        | FilterOp::BetweenAnyyear
                        | FilterOp::BetweenAnytime
                )
            {
                return compare_filter_local_tz(r, field, *op, value, value2.as_ref());
            }
            match r.resolve_field(field) {
                Some(ref v) => compare_filter(v, *op, value, value2.as_ref()),
                None => matches!(op, FilterOp::Neq | FilterOp::Nothas),
            }
        }
        _ => false,
    }
}

/// Minimum rayon chunk size for parallel batch iteration. Tuned to amortize
/// per-chunk overhead while keeping cache-friendly access patterns.
const CHUNK_SIZE: usize = 64 * 1024;

/// Resolve a selection into a `RoaringBitmap` of matching (alive) location **ids**.
///
/// This is the primary resolve path. Composites (`Intersection`/`Union`/`Invert`)
/// combine child bitmaps with native roaring set ops (`&`/`|`/`Sub`) — branchless,
/// sparse-aware, no per-row scanning. A `Tag` leaf hits the membership index when
/// present (O(1)-ish clone) instead of scanning every row's tag list. Geometric
/// leaves (`Polygon`/`Filter`/`Duplicates`) still scan, producing a positional mask
/// that is converted to an id set.
pub fn resolve_set(view: &LocView, props: &SelectionProps) -> RoaringBitmap {
    match props {
        // Tag leaf via index: clone the precomputed member set, minus dead ids.
        SelectionProps::Tag { tag_id } => {
            if let Some(idx) = view.tag_sets {
                let mut set = idx.get(tag_id).cloned().unwrap_or_default();
                if view.has_dead {
                    for &d in view.dead.iter() {
                        set.remove(d);
                    }
                }
                // Overlay adds aren't in the batch-built index; fold them in by scan.
                for loc in view.adds.iter() {
                    if loc.tags.contains(tag_id) {
                        set.insert(loc.id);
                    }
                }
                // Patches can change a row's tags vs the indexed (base) value: re-test
                // patched rows so the index can't go stale under uncommitted edits.
                if view.has_patches {
                    for p in view.patches.values() {
                        if p.tags.contains(tag_id) {
                            set.insert(p.id);
                        } else {
                            set.remove(p.id);
                        }
                    }
                }
                return set;
            }
            // No index: fall through to the scan path below.
        }
        SelectionProps::Intersection { selections } => {
            if selections.is_empty() {
                return RoaringBitmap::new();
            }
            let mut acc = resolve_set(view, &selections[0].props);
            for s in &selections[1..] {
                acc &= resolve_set(view, &s.props);
                if acc.is_empty() {
                    break;
                } // short-circuit: nothing left to intersect
            }
            return acc;
        }
        SelectionProps::Union { selections } => {
            let mut acc = RoaringBitmap::new();
            for s in selections {
                acc |= resolve_set(view, &s.props);
            }
            return acc;
        }
        SelectionProps::Invert { selections } => {
            // Invert = (all alive ids) - (child ids). roaring-rs has no native flip,
            // so this is a difference against the universe set.
            let universe = alive_id_set(view);
            if selections.is_empty() {
                return universe;
            }
            let inner = resolve_set(view, &selections[0].props);
            return universe - inner;
        }
        _ => {}
    }
    // Scan leaves (incl. Tag with no index): build a positional mask, convert to ids.
    let mask = resolve_leaf_mask(view, props);
    mask_to_set(view, &mask)
}

/// Resolve a whole selection forest in one pass: the id-set for each top-level
/// selection plus the resolved count of every node (top-level and nested), keyed by
/// `Selection.key`. Each node is resolved exactly once — composites combine their
/// children's already-resolved sets instead of re-resolving them. (The previous
/// resolve-then-count pair resolved every top-level node twice and nested children
/// twice or more.)
pub fn resolve_forest(
    view: &LocView,
    sels: &[Selection],
) -> (Vec<RoaringBitmap>, HashMap<String, u32>) {
    fn walk(view: &LocView, sel: &Selection, counts: &mut HashMap<String, u32>) -> RoaringBitmap {
        let set = match &sel.props {
            SelectionProps::Intersection { selections } => {
                // No empty short-circuit: children's counts are reported regardless,
                // so they must resolve either way.
                let mut acc: Option<RoaringBitmap> = None;
                for c in selections {
                    let child = walk(view, c, counts);
                    acc = Some(match acc {
                        Some(a) => a & child,
                        None => child,
                    });
                }
                acc.unwrap_or_default()
            }
            SelectionProps::Union { selections } => {
                let mut acc = RoaringBitmap::new();
                for c in selections {
                    acc |= walk(view, c, counts);
                }
                acc
            }
            SelectionProps::Invert { selections } => {
                let universe = alive_id_set(view);
                let mut children = selections.iter();
                let set = match children.next() {
                    Some(first) => universe - walk(view, first, counts),
                    None => universe,
                };
                // Invert is unary: extra children don't affect the set but their
                // counts are still reported, matching resolve_set semantics.
                for c in children {
                    walk(view, c, counts);
                }
                set
            }
            _ => resolve_set(view, &sel.props),
        };
        counts.insert(sel.key.clone(), set.len() as u32);
        set
    }
    let mut counts = HashMap::new();
    let sets = sels.iter().map(|s| walk(view, s, &mut counts)).collect();
    (sets, counts)
}

/// Resolved count of every selection node — top-level and nested — keyed by
/// `Selection.key`. Thin wrapper over [`resolve_forest`] for callers that only
/// need the counts.
pub fn resolve_node_counts(view: &LocView, sels: &[Selection]) -> HashMap<String, u32> {
    resolve_forest(view, sels).1
}

/// Set of all alive location ids (batch minus dead, plus overlay adds).
fn alive_id_set(view: &LocView) -> RoaringBitmap {
    let mut set = RoaringBitmap::new();
    view.for_each(|row| {
        set.insert(row.id());
    });
    set
}

/// Convert a positional mask (batch rows then adds) into a roaring id set. Excludes
/// dead batch rows. O(N).
fn mask_to_set(view: &LocView, mask: &[bool]) -> RoaringBitmap {
    let mut set = RoaringBitmap::new();
    for i in 0..view.batch_rows {
        if mask[i] && view.is_alive(i) {
            set.insert(view.id_at(i));
        }
    }
    for (j, loc) in view.adds.iter().enumerate() {
        if mask[view.batch_rows + j] {
            set.insert(loc.id);
        }
    }
    set
}

/// Resolve a single non-composite leaf into a positional bool mask. O(N) parallel
/// (or O(N^2) grid-accelerated for Duplicates). Composites are handled by `resolve_set`.
fn resolve_leaf_mask(view: &LocView, props: &SelectionProps) -> Vec<bool> {
    let n = view.batch_rows + view.adds.len();
    match props {
        SelectionProps::Locations { locations, .. }
        | SelectionProps::Manual { locations }
        | SelectionProps::ValidationState { locations, .. }
        | SelectionProps::Reviewed { locations, .. } => {
            let set: HashSet<u32> = locations.iter().copied().collect();
            view.resolve_mask(|r| set.contains(&r.id()))
        }
        SelectionProps::Duplicates { distance } => {
            let mut mask = vec![false; n];
            find_duplicates_bitmask(view, *distance, &mut mask);
            mask
        }
        SelectionProps::Polygon {
            polygon,
            include_informational,
        } => {
            let inc = *include_informational;
            match geometry_bbox(polygon) {
                None => vec![false; n],
                Some(bb) => view.resolve_mask(|r| {
                    if !inc && r.flags().contains(LocationFlags::INFORMATIONAL) {
                        return false;
                    }
                    in_bbox(r.lng(), r.lat(), &bb) && point_in_geometry(r.lng(), r.lat(), polygon)
                }),
            }
        }
        SelectionProps::TopK {
            field,
            k,
            ascending,
        } => {
            let mut entries: Vec<(usize, f64)> = Vec::new();
            for i in 0..view.batch_rows {
                if !view.is_alive(i) {
                    continue;
                }
                let row = match view.patch_at(i) {
                    Some(p) => RowRef::from_loc(p),
                    None => RowRef {
                        inner: RowInner::Base(view, i),
                    },
                };
                if let Some(v) = row.resolve_field(field).as_ref().and_then(as_f64) {
                    entries.push((i, v));
                }
            }
            for (j, loc) in view.adds.iter().enumerate() {
                if let Some(v) = resolve_field_loc(loc, field).as_ref().and_then(as_f64) {
                    entries.push((view.batch_rows + j, v));
                }
            }
            if *ascending {
                entries.sort_unstable_by(|a, b| {
                    a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)
                });
            } else {
                entries.sort_unstable_by(|a, b| {
                    b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
                });
            }
            let mut mask = vec![false; n];
            for &(i, _) in entries.iter().take(*k as usize) {
                mask[i] = true;
            }
            mask
        }
        _ => view.resolve_mask(|r| test_row(r, props)),
    }
}

/// Resolve a selection to a Vec of matching location IDs (sorted ascending). O(N).
pub fn resolve(view: &LocView, props: &SelectionProps) -> Vec<u32> {
    resolve_set(view, props).into_iter().collect()
}

// --- Geometry (ray-casting point-in-polygon) ---

/// Returns true if the ring involves the antimeridian — either wrapped coordinates
/// (edge lng jump > 180) or unwrapped (any vertex lng outside [-180, 180]).
pub(crate) fn ring_crosses_antimeridian(ring: &[[f64; 2]]) -> bool {
    let n = ring.len();
    if n < 2 {
        return false;
    }
    let mut j = n - 1;
    for i in 0..n {
        if ring[i][0] > 180.0 || ring[i][0] < -180.0 {
            return true;
        }
        if (ring[i][0] - ring[j][0]).abs() > 180.0 {
            return true;
        }
        j = i;
    }
    false
}

#[inline]
pub(crate) fn normalize_lng(lng: f64) -> f64 {
    if lng < 0.0 {
        lng + 360.0
    } else {
        lng
    }
}

/// Ray-casting algorithm: cast a horizontal ray eastward from (lng, lat) and count
/// edge crossings. Odd count = inside. O(V) where V = vertices.
/// Handles antimeridian-crossing rings by shifting to [0, 360).
pub(crate) fn point_in_ring(lng: f64, lat: f64, ring: &[[f64; 2]]) -> bool {
    let crosses = ring_crosses_antimeridian(ring);
    let lng = if crosses { normalize_lng(lng) } else { lng };
    let mut inside = false;
    let n = ring.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let xi = if crosses {
            normalize_lng(ring[i][0])
        } else {
            ring[i][0]
        };
        let yi = ring[i][1];
        let xj = if crosses {
            normalize_lng(ring[j][0])
        } else {
            ring[j][0]
        };
        let yj = ring[j][1];
        if ((yi > lat) != (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Test point-in-polygon with holes over rings yielded as slices: inside the outer
/// ring (first) and outside all hole rings (rest). The single source of truth for the
/// outer/hole composition, shared by owned `Vec`-backed and mmap'd archived geometry.
pub(crate) fn polygon_contains<'a>(
    lng: f64,
    lat: f64,
    mut rings: impl Iterator<Item = &'a [[f64; 2]]>,
) -> bool {
    let Some(outer) = rings.next() else {
        return false;
    };
    if !point_in_ring(lng, lat, outer) {
        return false;
    }
    for hole in rings {
        if point_in_ring(lng, lat, hole) {
            return false;
        }
    }
    true
}

fn point_in_polygon(lng: f64, lat: f64, coords: &[Vec<[f64; 2]>]) -> bool {
    polygon_contains(lng, lat, coords.iter().map(|r| r.as_slice()))
}

/// Test against the full geometry (primary polygon + extra_polygons). Any hit = true.
pub(crate) fn point_in_geometry(lng: f64, lat: f64, geom: &PolygonGeometry) -> bool {
    if point_in_polygon(lng, lat, &geom.coordinates) {
        return true;
    }
    if let Some(extras) = &geom.extra_polygons {
        for poly in extras {
            if point_in_polygon(lng, lat, poly) {
                return true;
            }
        }
    }
    false
}

/// Axis-aligned bounding box `[min_lng, min_lat, max_lng, max_lat]` over every ring of
/// a geometry (outer + holes + extra polygons). Used as a cheap broad-phase reject
/// before the full crossing-number test in polygon selections. `None` if no coords.
/// When the geometry crosses the antimeridian, longitudes are normalized to [0, 360)
/// so `max_lng` may exceed 180 — `in_bbox` handles this transparently.
pub(crate) fn geometry_bbox(geom: &PolygonGeometry) -> Option<[f64; 4]> {
    let crosses = geom
        .coordinates
        .iter()
        .chain(
            geom.extra_polygons
                .iter()
                .flat_map(|polys| polys.iter().flatten()),
        )
        .any(|ring| ring_crosses_antimeridian(ring));
    let mut bb = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    let mut any = false;
    for ring in &geom.coordinates {
        extend_bbox_with_ring(&mut bb, &mut any, crosses, ring);
    }
    if let Some(extras) = &geom.extra_polygons {
        for poly in extras {
            for ring in poly {
                extend_bbox_with_ring(&mut bb, &mut any, crosses, ring);
            }
        }
    }
    if any {
        Some(bb)
    } else {
        None
    }
}

/// Fold one ring's vertices into a running `[min_lng, min_lat, max_lng, max_lat]`,
/// normalizing longitudes to [0, 360) when the geometry crosses the antimeridian.
/// `any` flips true once at least one vertex has been seen. Shared by owned and
/// archived bbox computation.
pub(crate) fn extend_bbox_with_ring(
    bb: &mut [f64; 4],
    any: &mut bool,
    crosses: bool,
    ring: &[[f64; 2]],
) {
    for &[lng, lat] in ring {
        let lng = if crosses { normalize_lng(lng) } else { lng };
        if lng < bb[0] {
            bb[0] = lng;
        }
        if lat < bb[1] {
            bb[1] = lat;
        }
        if lng > bb[2] {
            bb[2] = lng;
        }
        if lat > bb[3] {
            bb[3] = lat;
        }
        *any = true;
    }
}

/// `bb` is `[min_lng, min_lat, max_lng, max_lat]`.
/// When `max_lng > 180` the bbox is in normalized [0,360) space (antimeridian crossing);
/// negative test longitudes are shifted by +360 automatically.
#[inline]
pub(crate) fn in_bbox(lng: f64, lat: f64, bb: &[f64; 4]) -> bool {
    let lng = if bb[2] > 180.0 && lng < 0.0 {
        lng + 360.0
    } else {
        lng
    };
    lng >= bb[0] && lng <= bb[2] && lat >= bb[1] && lat <= bb[3]
}

// --- Duplicates (bitmask version) ---

/// Cell-hashed spatial grid in CSR layout (Müller, "Blazing Fast Neighbor Search
/// with Spatial Hashing"). Cells are hashed into a fixed table sized to the point
/// count, so the structure is O(n) regardless of spatial extent — no dense world
/// array. Build is two linear passes (count → prefix-sum → scatter); neighbor
/// iteration walks a contiguous slice. Hash collisions are harmless: distinct cells
/// may share a bucket, and the caller's distance test rejects any foreign points.
struct SpatialHash {
    table_size: usize,
    cell_start: Vec<u32>, // len table_size + 1; CSR offsets
    entries: Vec<u32>,    // len n; point indices grouped by bucket
}

#[inline]
fn hash_cell(cx: i32, cy: i32, table_size: usize) -> usize {
    let h = (cx.wrapping_mul(92_837_111)) ^ (cy.wrapping_mul(689_287_499));
    (h.unsigned_abs() as usize) % table_size
}

impl SpatialHash {
    /// Build from per-point integer cell coords. `table_size = max(n, 1)`.
    fn build(cells: &[(i32, i32)]) -> Self {
        let n = cells.len();
        let table_size = n.max(1);
        let mut cell_start = vec![0u32; table_size + 1];
        for &(cx, cy) in cells {
            cell_start[hash_cell(cx, cy, table_size)] += 1;
        }
        // Prefix-sum into start offsets.
        let mut sum = 0u32;
        for slot in cell_start.iter_mut() {
            let c = *slot;
            *slot = sum;
            sum += c;
        }
        // Scatter point indices; cell_start[b] temporarily advances as a write cursor.
        let mut entries = vec![0u32; n];
        for (pi, &(cx, cy)) in cells.iter().enumerate() {
            let b = hash_cell(cx, cy, table_size);
            entries[cell_start[b] as usize] = pi as u32;
            cell_start[b] += 1;
        }
        // Restore offsets: shift right by one (the scatter advanced each cursor to its end).
        for b in (1..=table_size).rev() {
            cell_start[b] = cell_start[b - 1];
        }
        cell_start[0] = 0;
        SpatialHash {
            table_size,
            cell_start,
            entries,
        }
    }

    /// Point indices in the bucket that `(cx, cy)` hashes to. May include points from
    /// other cells that collide on the same bucket — caller must distance-filter.
    #[inline]
    fn bucket(&self, cx: i32, cy: i32) -> &[u32] {
        let b = hash_cell(cx, cy, self.table_size);
        &self.entries[self.cell_start[b] as usize..self.cell_start[b + 1] as usize]
    }
}

/// Grid broad-phase pair sweep shared by the duplicate bitmask/groups/prune paths.
/// Calls `pair(state, pi, pj)` (pi < pj) for every index pair within `distance_m` metres.
/// `skip_anchor(state, pi)` short-circuits a whole anchor scan — the bitmask path relies
/// on it to stay near-linear when many points share one cell. O(N) average with uniform
/// distribution, O(N^2) worst case if all points fall in one grid cell.
fn for_pairs_within<S>(
    n: usize,
    pos: impl Fn(usize) -> (f64, f64),
    distance_m: f64,
    state: &mut S,
    skip_anchor: impl Fn(&S, usize) -> bool,
    mut pair: impl FnMut(&mut S, usize, usize),
) {
    if n < 2 {
        return;
    }
    let cell_deg = distance_m / 111_000.0 * 1.5;
    // Degenerate radius (distance == 0, or a non-finite cell size): "within 0 m" means
    // exact-coordinate equality. The grid would divide by zero, saturate every point to
    // one cell, and collapse to O(n^2). Hash on exact coords instead — O(n). (#69)
    if !(cell_deg > 0.0) {
        let mut groups: HashMap<(u64, u64), Vec<usize>> = HashMap::new();
        for i in 0..n {
            let (lat, lng) = pos(i);
            if !lat.is_finite() || !lng.is_finite() {
                continue;
            }
            // `+ 0.0` folds -0.0 into +0.0 so the two compare equal.
            groups
                .entry(((lat + 0.0).to_bits(), (lng + 0.0).to_bits()))
                .or_default()
                .push(i);
        }
        for idxs in groups.values() {
            for (a, &pi) in idxs.iter().enumerate() {
                if skip_anchor(state, pi) {
                    continue;
                }
                for &pj in &idxs[a + 1..] {
                    pair(state, pi, pj);
                }
            }
        }
        return;
    }
    let cells: Vec<(i32, i32)> = (0..n)
        .map(|i| {
            let (lat, lng) = pos(i);
            (
                (lng / cell_deg).floor() as i32,
                (lat / cell_deg).floor() as i32,
            )
        })
        .collect();
    let grid = SpatialHash::build(&cells);
    let thresh_m2 = distance_m * distance_m;
    for pi in 0..n {
        if skip_anchor(state, pi) {
            continue;
        }
        let (lat, lng) = pos(pi);
        let (cx, cy) = cells[pi];
        let cos_lat = lat.to_radians().cos();
        for dx in -1..=1 {
            for dy in -1..=1 {
                // saturating: a stray non-finite coord can floor to i32::MAX/MIN; a plain
                // add would overflow (panic in debug, wrap in release).
                let (nx, ny) = (cx.saturating_add(dx), cy.saturating_add(dy));
                for &pj in grid.bucket(nx, ny) {
                    let pj = pj as usize;
                    if pj <= pi {
                        continue;
                    }
                    // Bucket may hold points from collided cells; the cell-coord check
                    // keeps us to the true 3x3 neighborhood. Then the distance test.
                    if cells[pj] != (nx, ny) {
                        continue;
                    }
                    let (plat, plng) = pos(pj);
                    if equirect_m2(lat, lng, plat, plng, cos_lat) <= thresh_m2 {
                        pair(state, pi, pj);
                    }
                }
            }
        }
    }
}

/// Grid-accelerated spatial duplicate detection.
fn find_duplicates_bitmask(view: &LocView, distance_m: f64, mask: &mut [bool]) {
    struct Pt {
        lat: f64,
        lng: f64,
        global_idx: usize,
    }
    let mut points = Vec::new();

    for i in 0..view.batch_rows {
        if !view.is_alive(i) {
            continue;
        }
        if let Some(p) = view.patch_at(i) {
            points.push(Pt {
                lat: p.lat,
                lng: p.lng,
                global_idx: i,
            });
        } else {
            points.push(Pt {
                lat: view.lats.unwrap().value(i),
                lng: view.lngs.unwrap().value(i),
                global_idx: i,
            });
        }
    }
    for (j, loc) in view.adds.iter().enumerate() {
        points.push(Pt {
            lat: loc.lat,
            lng: loc.lng,
            global_idx: view.batch_rows + j,
        });
    }

    let n = points.len();
    let mut state = (vec![false; n], mask); // (in_group, mask)
    for_pairs_within(
        n,
        |i| (points[i].lat, points[i].lng),
        distance_m,
        &mut state,
        |s, pi| s.0[pi],
        |s, pi, pj| {
            if s.0[pj] {
                return;
            }
            s.0[pj] = true;
            s.1[points[pj].global_idx] = true;
            s.1[points[pi].global_idx] = true;
        },
    );
}

/// Transitive (connected-component) spatial grouping. Two locations are linked when within
/// `distance_m` metres; each returned group is a connected component of size >= 2. Same
/// grid broad-phase as `find_duplicates_bitmask`, but union-find preserves the partition
/// instead of flattening to a membership mask. Chains collapse: A~B, B~C => {A,B,C} even
/// if A and C are out of range. Output is deterministic: ids ascending within each group,
/// groups ordered by first id.
pub fn find_duplicate_groups(view: &LocView, distance_m: f64) -> Vec<Vec<u32>> {
    struct Pt {
        lat: f64,
        lng: f64,
        id: u32,
    }
    let mut points: Vec<Pt> = Vec::new();
    view.for_each(|row| {
        points.push(Pt {
            lat: row.lat(),
            lng: row.lng(),
            id: row.id(),
        })
    });

    let n = points.len();
    if n < 2 {
        return Vec::new();
    }

    // Union-find with path halving.
    fn find(parent: &mut [usize], mut x: usize) -> usize {
        while parent[x] != x {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        x
    }
    let mut parent: Vec<usize> = (0..n).collect();

    for_pairs_within(
        n,
        |i| (points[i].lat, points[i].lng),
        distance_m,
        &mut parent,
        |_, _| false,
        |parent, pi, pj| {
            let ra = find(parent, pi);
            let rb = find(parent, pj);
            if ra != rb {
                parent[ra] = rb;
            }
        },
    );

    let mut comps: HashMap<usize, Vec<u32>> = HashMap::new();
    for pi in 0..n {
        let r = find(&mut parent, pi);
        comps.entry(r).or_default().push(points[pi].id);
    }

    let mut groups: Vec<Vec<u32>> = comps
        .into_values()
        .filter(|g| g.len() >= 2)
        .map(|mut g| {
            g.sort_unstable();
            g
        })
        .collect();
    groups.sort_unstable_by_key(|g| g[0]);
    groups
}

/// Prune duplicates. `locs` is the resolved selection; informational locations are
/// never pruned and never count as neighbours. Returns ids to remove.
/// - <= 25 m: relevance prune — each radius cluster keeps its best-scored location
///   (see [`prune_score`]; tie: oldest `created_at`, then lowest id), rest pruned.
/// - > 25 m: greedy max-thinning — repeatedly drop the location with the most in-range
///   neighbours until no two survivors are within `distance_m`.
pub fn prune_duplicates(
    locs: &[Location],
    distance_m: f64,
    keep_tag_ids: &HashSet<u32>,
) -> Vec<u32> {
    let locs: Vec<&Location> = locs
        .iter()
        .filter(|l| !l.flags.contains(LocationFlags::INFORMATIONAL))
        .collect();
    if locs.len() < 2 {
        return Vec::new();
    }
    if distance_m > 25.0 {
        prune_thinning(&locs, distance_m)
    } else {
        prune_relevance(&locs, distance_m, keep_tag_ids)
    }
}

/// Relevance score: +1 pano, +1 per tag, +1 LoadAsPanoId, +5 keep-tag, +1 nonzero heading.
fn prune_score(l: &Location, keep_tag_ids: &HashSet<u32>) -> i64 {
    let mut s = l.tags.len() as i64;
    if l.pano_id.is_some() {
        s += 1;
    }
    if l.flags.contains(LocationFlags::LOAD_AS_PANO_ID) {
        s += 1;
    }
    if l.tags.iter().any(|t| keep_tag_ids.contains(t)) {
        s += 5;
    }
    if l.heading != 0.0 {
        s += 1;
    }
    s
}

/// Symmetric within-distance neighbour lists (indices into `locs`).
fn neighbor_lists(locs: &[&Location], distance_m: f64) -> Vec<Vec<usize>> {
    let mut out: Vec<Vec<usize>> = vec![Vec::new(); locs.len()];
    for_pairs_within(
        locs.len(),
        |i| (locs[i].lat, locs[i].lng),
        distance_m,
        &mut out,
        |_, _| false,
        |out, pi, pj| {
            out[pi].push(pj);
            out[pj].push(pi);
        },
    );
    out
}

fn prune_relevance(locs: &[&Location], distance_m: f64, keep_tag_ids: &HashSet<u32>) -> Vec<u32> {
    let neighbors = neighbor_lists(locs, distance_m);
    let mut pruned = vec![false; locs.len()];
    let mut out = Vec::new();
    for i in 0..locs.len() {
        if pruned[i] {
            continue;
        }
        let mut cluster: Vec<usize> = vec![i];
        cluster.extend(neighbors[i].iter().copied().filter(|&j| !pruned[j]));
        if cluster.len() < 2 {
            continue;
        }
        let survivor = *cluster
            .iter()
            .max_by(|&&a, &&b| {
                prune_score(locs[a], keep_tag_ids)
                    .cmp(&prune_score(locs[b], keep_tag_ids))
                    .then_with(|| locs[b].created_at.cmp(&locs[a].created_at)) // older wins ties
                    .then_with(|| locs[b].id.cmp(&locs[a].id))
            })
            .unwrap();
        for &j in &cluster {
            if j != survivor {
                pruned[j] = true;
                out.push(locs[j].id);
            }
        }
    }
    out
}

fn prune_thinning(locs: &[&Location], distance_m: f64) -> Vec<u32> {
    let n = locs.len();
    let neighbors = neighbor_lists(locs, distance_m);
    let mut deg: Vec<u32> = neighbors.iter().map(|v| v.len() as u32).collect();
    let mut removed = vec![false; n];
    // Stack with O(1) membership removal: all nodes at the current max degree are
    // processed before recounting; a neighbour of a removed node leaves the stack
    // even if it still sits at max degree.
    let mut stack: Vec<usize> = Vec::new();
    let mut pos: HashMap<usize, usize> = HashMap::new();
    loop {
        let max = deg.iter().copied().max().unwrap_or(0);
        if max == 0 {
            break;
        }
        for i in 0..n {
            if deg[i] == max {
                pos.insert(i, stack.len());
                stack.push(i);
            }
        }
        while let Some(t) = stack.pop() {
            pos.remove(&t);
            deg[t] = 0;
            removed[t] = true;
            for &u in &neighbors[t] {
                if deg[u] > 0 {
                    deg[u] -= 1;
                }
                if let Some(p) = pos.remove(&u) {
                    let last = stack.pop().unwrap();
                    if p < stack.len() {
                        stack[p] = last;
                        pos.insert(last, p);
                    }
                }
            }
        }
    }
    (0..n).filter(|&i| removed[i]).map(|i| locs[i].id).collect()
}

/// Great-circle distance in metres using the haversine formula. Assumes spherical Earth (R = 6371 km).
pub(crate) fn haversine_m(lat1: f64, lng1: f64, lat2: f64, lng2: f64) -> f64 {
    let r = 6_371_000.0;
    let dlat = (lat2 - lat1).to_radians();
    let dlng = (lng2 - lng1).to_radians();
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (dlng / 2.0).sin().powi(2);
    2.0 * r * a.sqrt().asin()
}

const EARTH_R_M: f64 = 6_371_000.0;

/// Squared equirectangular distance in metres², for cheap threshold tests at small
/// separations (no trig, no sqrt). `cos_lat` is `cos(reference latitude)`, precomputed
/// once per query point. Error vs haversine is sub-mm under ~1km — negligible for the
/// meter-scale radii dedup/find-nearby use. Compare against `threshold * threshold`.
#[inline]
fn equirect_m2(lat1: f64, lng1: f64, lat2: f64, lng2: f64, cos_lat: f64) -> f64 {
    let x = (lng2 - lng1).to_radians() * cos_lat;
    let y = (lat2 - lat1).to_radians();
    (x * x + y * y) * EARTH_R_M * EARTH_R_M
}

// --- Filter: field-level comparison predicates ---

/// Resolve a field name to its JSON value from a `Location` struct.
/// Built-in fields (lat, lng, heading, etc.) are accessed directly;
/// unknown fields fall through to `loc.extra`.
fn resolve_field_loc(loc: &Location, field: &str) -> Option<serde_json::Value> {
    match field {
        "lat" => Some(serde_json::json!(loc.lat)),
        "lng" => Some(serde_json::json!(loc.lng)),
        "heading" => Some(serde_json::json!(loc.heading)),
        "pitch" => Some(serde_json::json!(loc.pitch)),
        "zoom" => Some(serde_json::json!(loc.zoom)),
        "id" => Some(serde_json::json!(loc.id)),
        "createdAt" => Some(serde_json::json!(loc.created_at as f64)),
        "modifiedAt" => loc.modified_at.map(|ts| serde_json::json!(ts as f64)),
        "tagCount" => Some(serde_json::json!(loc.tags.len())),
        _ => loc.extra.as_ref().and_then(|e| e.get(field)),
    }
}

/// Resolve a field name to its JSON value directly from Arrow columns (avoids
/// materializing a full `Location`). Falls through to `extras` JSON for unknown fields.
fn resolve_field_arrow(view: &LocView, idx: usize, field: &str) -> Option<serde_json::Value> {
    match field {
        "lat" => view.lats.map(|c| serde_json::json!(c.value(idx))),
        "lng" => view.lngs.map(|c| serde_json::json!(c.value(idx))),
        "heading" => view.headings.map(|c| serde_json::json!(c.value(idx))),
        "pitch" => view.pitches.map(|c| serde_json::json!(c.value(idx))),
        "zoom" => view.zooms.map(|c| serde_json::json!(c.value(idx))),
        "id" => view.ids.map(|c| serde_json::json!(c.value(idx))),
        "createdAt" => view
            .created_ats
            .map(|c| serde_json::json!(c.value(idx) as f64)),
        "modifiedAt" => view.modified_ats.and_then(|c| {
            if c.is_null(idx) {
                return None;
            }
            Some(serde_json::json!(c.value(idx) as f64))
        }),
        "tagCount" => view.tags.map(|c| serde_json::json!(c.value(idx).len())),
        _ => {
            let extras = view.extras?;
            if extras.is_null(idx) {
                return None;
            }
            let map: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(extras.value(idx)).ok()?;
            map.get(field).cloned()
        }
    }
}

/// Core comparison dispatch. Supports eq, neq, has, nothas, gt, lt, gte, lte, between,
/// between_anyyear (month-day range ignoring year), and between_anytime (time-of-day range).
/// Numeric comparison is attempted first; falls back to lexicographic string comparison.
fn compare_filter(
    field_val: &serde_json::Value,
    op: FilterOp,
    value: &serde_json::Value,
    value2: Option<&serde_json::Value>,
) -> bool {
    if let Some(arr) = field_val.as_array() {
        return match op {
            FilterOp::Contains => arr.iter().any(|el| val_eq(el, value)),
            FilterOp::Notcontains => !arr.iter().any(|el| val_eq(el, value)),
            FilterOp::Has => true,
            FilterOp::Nothas => false,
            _ => {
                let len_val = serde_json::Value::from(arr.len() as f64);
                compare_filter(&len_val, op, value, value2)
            }
        };
    }
    match op {
        FilterOp::Eq => val_eq(field_val, value),
        FilterOp::Neq => !val_eq(field_val, value),
        FilterOp::Has => true,
        FilterOp::Nothas => false,
        FilterOp::Contains | FilterOp::Notcontains => false,
        FilterOp::Gt | FilterOp::Lt | FilterOp::Gte | FilterOp::Lte | FilterOp::Between => {
            let fv = as_f64(field_val);
            let cv = as_f64(value);
            match (fv, cv) {
                (Some(a), Some(b)) => match op {
                    FilterOp::Gt => a > b,
                    FilterOp::Lt => a < b,
                    FilterOp::Gte => a >= b,
                    FilterOp::Lte => a <= b,
                    FilterOp::Between => {
                        let upper = value2.and_then(as_f64).unwrap_or(f64::MAX);
                        a >= b && a <= upper
                    }
                    _ => false,
                },
                _ => {
                    let fs = field_val.as_str().unwrap_or("");
                    let vs = value.as_str().unwrap_or("");
                    match op {
                        FilterOp::Gt => fs > vs,
                        FilterOp::Lt => fs < vs,
                        FilterOp::Gte => fs >= vs,
                        FilterOp::Lte => fs <= vs,
                        FilterOp::Between => {
                            let upper = value2.and_then(|v| v.as_str()).unwrap_or("");
                            fs >= vs && fs <= upper
                        }
                        _ => false,
                    }
                }
            }
        }
        FilterOp::BetweenAnyyear => {
            let lo = value.as_str().unwrap_or("");
            let hi = value2.and_then(|v| v.as_str()).unwrap_or("12-31");
            let fv_md = if let Some(ts) = as_f64(field_val) {
                let (m, d) = unix_to_month_day(ts);
                format!("{:02}-{:02}", m, d)
            } else if let Some(s) = field_val.as_str() {
                if s.len() >= 7 && s.as_bytes()[4] == b'-' {
                    if s.len() >= 10 {
                        s[5..10].to_string()
                    } else {
                        format!("{}-01", &s[5..7])
                    }
                } else {
                    return false;
                }
            } else {
                return false;
            };
            if lo <= hi {
                fv_md.as_str() >= lo && fv_md.as_str() <= hi
            } else {
                fv_md.as_str() >= lo || fv_md.as_str() <= hi
            }
        }
        FilterOp::BetweenAnytime => {
            let lo = value.as_str().unwrap_or("00:00");
            let hi = value2.and_then(|v| v.as_str()).unwrap_or("23:59");
            let fv_hm = if let Some(ts) = as_f64(field_val) {
                let (h, m) = unix_to_hour_min(ts);
                format!("{:02}:{:02}", h, m)
            } else {
                return false;
            };
            if lo <= hi {
                fv_hm.as_str() >= lo && fv_hm.as_str() <= hi
            } else {
                fv_hm.as_str() >= lo || fv_hm.as_str() <= hi
            }
        }
    }
}

/// `tz_local` filters: bucket the location's absolute timestamp into its own timezone's
/// wall-clock before comparing, for any frame-sensitive op. The shifted value runs
/// through the normal `compare_filter` dispatch, so range ops compare against wall-clock
/// instants encoded as UTC-epoch seconds (the picker's wall-clock mode) and the
/// anyyear/anytime shapes bucket month-day / hour-min in the pano's local clock.
/// The location's `timezone` (IANA) supplies the DST-correct offset; locations lacking
/// a resolvable `timezone` or field value are excluded.
fn compare_filter_local_tz(
    r: &RowRef,
    field: &str,
    op: FilterOp,
    value: &serde_json::Value,
    value2: Option<&serde_json::Value>,
) -> bool {
    let (fv, tz_name) = r.resolve_field_and_tz(field);
    let ts = match fv.as_ref().and_then(as_f64) {
        Some(t) => t,
        None => return false,
    };
    let tz_name = match tz_name {
        Some(s) => s,
        None => return false,
    };
    let offset = match tz_offset_seconds(&tz_name, ts) {
        Some(o) => o,
        None => return false,
    };
    compare_filter(
        &serde_json::Value::from(ts + offset as f64),
        op,
        value,
        value2,
    )
}

/// Equality comparison with type coercion: tries numeric, then string, then JSON equality.
fn val_eq(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    if a == b {
        return true;
    }
    if a.is_null() || b.is_null() {
        return false;
    }
    match (as_f64(a), as_f64(b)) {
        (Some(fa), Some(fb)) => fa == fb,
        _ => {
            let sa = val_to_str(a);
            let sb = val_to_str(b);
            !sa.is_empty() && sa == sb
        }
    }
}

/// Coerce a JSON value to a string for comparison. Numbers use their string repr.
fn val_to_str(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// Try to extract an f64 from a JSON value: native number or parseable string.
fn as_f64(v: &serde_json::Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

// ---------------------------------------------------------------------------
// Partition: group-by aggregation
// ---------------------------------------------------------------------------
//
// `partition` splits the (scoped) location set into groups by a derived key, returning
// compact `{ key, ids, bin }` per group.
//

/// How a field value becomes a group key. Wire-mirrors the JS `KeySpec`.
#[derive(Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum KeySpec {
    /// String value of the field (enum/string/month "YYYY-MM"/number).
    Value,
    /// Equal-width numeric bins.
    NumericBin { binning: NumericBinning },
    /// Calendar component of a date (epoch seconds) or month ("YYYY-MM") field.
    DatePart {
        part: DatePart,
        #[serde(rename = "tzLocal")]
        tz_local: bool,
    },
}

/// Equal-width bin sizing. `count` derives the width from the data range; `width` fixes it.
#[derive(Clone, Deserialize, specta::Type)]
#[serde(tag = "by", rename_all = "camelCase")]
pub enum NumericBinning {
    Count { n: u32 },
    Width { w: f64 },
}

/// Which locations to operate on: the whole map or the current selection. Resolved in Rust
/// against the maintained selection set.
#[derive(Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Scope {
    All,
    Selected,
}

/// A calendar component to group dates by.
#[derive(Clone, Copy, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum DatePart {
    Year,
    YearMonth,
    Day,
    MonthOfYear,
    HourOfDay,
}

/// One partition group: a stable key, the ids it holds, and (numeric bins only) the
/// `[lo, hi]` bounds so JS can rebuild a live Filter for whole-map gradients.
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PartitionBucket {
    pub key: String,
    pub ids: Vec<u32>,
    pub bin: Option<[f64; 2]>,
}

const MONTH_NAMES: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// Partition `view` into groups by `field`. `scope` (when Some) restricts to that id set.
/// Returns groups in a deterministic but unsorted order (numeric: bin order; projection:
/// first-seen) — the JS caller sorts for display.
pub fn partition(
    view: &LocView,
    field: &str,
    spec: &KeySpec,
    scope: Option<&RoaringBitmap>,
) -> Vec<PartitionBucket> {
    match spec {
        KeySpec::NumericBin { binning } => partition_numeric(view, field, binning, scope),
        _ => partition_keyed(view, field, spec, scope),
    }
}

#[inline]
fn out_of_scope(scope: Option<&RoaringBitmap>, id: u32) -> bool {
    scope.is_some_and(|s| !s.contains(id))
}

fn partition_numeric(
    view: &LocView,
    field: &str,
    binning: &NumericBinning,
    scope: Option<&RoaringBitmap>,
) -> Vec<PartitionBucket> {
    let mut vals: Vec<(u32, f64)> = Vec::new();
    view.for_each(|row| {
        let id = row.id();
        if out_of_scope(scope, id) {
            return;
        }
        if let Some(n) = row.resolve_field(field).as_ref().and_then(as_f64) {
            vals.push((id, n));
        }
    });
    let nums: Vec<f64> = vals.iter().map(|(_, n)| *n).collect();
    let buckets = match bin_numeric(&nums, binning) {
        Some(b) => b,
        None => return Vec::new(),
    };
    let mut groups: Vec<PartitionBucket> = buckets
        .bounds
        .iter()
        .map(|&(lo, hi)| PartitionBucket {
            key: bound_label(lo, hi),
            ids: Vec::new(),
            bin: Some([lo, hi]),
        })
        .collect();
    for (id, n) in vals {
        groups[buckets.index_of(n)].ids.push(id);
    }
    groups.retain(|g| !g.ids.is_empty());
    groups
}

fn partition_keyed(
    view: &LocView,
    field: &str,
    spec: &KeySpec,
    scope: Option<&RoaringBitmap>,
) -> Vec<PartitionBucket> {
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut groups: Vec<PartitionBucket> = Vec::new();
    view.for_each(|row| {
        let id = row.id();
        if out_of_scope(scope, id) {
            return;
        }
        let key = match spec {
            KeySpec::Value => row.resolve_field(field).and_then(|v| value_key(&v)),
            KeySpec::DatePart { part, tz_local } => {
                if *tz_local {
                    let (fv, tz) = row.resolve_field_and_tz(field);
                    date_part_key(fv.as_ref(), *part, true, tz.as_deref())
                } else {
                    date_part_key(row.resolve_field(field).as_ref(), *part, false, None)
                }
            }
            KeySpec::NumericBin { .. } => None,
        };
        if let Some(k) = key {
            if k.is_empty() {
                return;
            }
            match index.get(&k) {
                Some(&i) => groups[i].ids.push(id),
                None => {
                    index.insert(k.clone(), groups.len());
                    groups.push(PartitionBucket {
                        key: k,
                        ids: vec![id],
                        bin: None,
                    });
                }
            }
        }
    });
    groups
}

/// JS `String(value)` for the key: strings verbatim (empty -> skip), numbers without a
/// trailing ".0", bools as "true"/"false". Null/other -> skip.
fn value_key(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => {
            if s.is_empty() {
                None
            } else {
                Some(s.clone())
            }
        }
        serde_json::Value::Number(n) => Some(
            n.as_i64()
                .map(|i| i.to_string())
                .or_else(|| n.as_f64().map(js_number_string))
                .unwrap_or_else(|| n.to_string()),
        ),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Calendar component of a date/month field value. Month strings ("YYYY-MM") read y/mo with
/// day=1, hour=0; everything else is epoch seconds, read in the pano's timezone (`tz_local`)
/// or UTC.
fn date_part_key(
    v: Option<&serde_json::Value>,
    part: DatePart,
    tz_local: bool,
    tz: Option<&str>,
) -> Option<String> {
    let v = v?;
    if let Some(s) = v.as_str() {
        if let Some((y, mo)) = parse_year_month(s) {
            return Some(parts_to_key(y, mo, 1, 0, part));
        }
    }
    let ts = as_f64(v)?;
    let (y, mo, d, h) = if tz_local {
        let off = tz_offset_seconds(tz?, ts)?;
        utc_parts(ts + off as f64)
    } else {
        utc_parts(ts)
    };
    Some(parts_to_key(y, mo, d, h, part))
}

fn parts_to_key(y: i32, mo: u32, d: u32, h: u32, part: DatePart) -> String {
    match part {
        DatePart::Year => format!("{}", y),
        DatePart::YearMonth => format!("{}-{:02}", y, mo),
        DatePart::Day => format!("{}-{:02}-{:02}", y, mo, d),
        DatePart::MonthOfYear => MONTH_NAMES[(mo.clamp(1, 12) - 1) as usize].to_string(),
        DatePart::HourOfDay => format!("{:02}:00", h),
    }
}

/// Parse a strict "YYYY-MM" string into (year, month). `None` for any other shape (e.g. a
/// numeric date string), which the caller then treats as epoch seconds.
fn parse_year_month(s: &str) -> Option<(i32, u32)> {
    let b = s.as_bytes();
    if s.len() != 7 || b[4] != b'-' {
        return None;
    }
    Some((s[0..4].parse().ok()?, s[5..7].parse().ok()?))
}

fn utc_parts(ts: f64) -> (i32, u32, u32, u32) {
    let dt = DateTime::<Utc>::from_timestamp(ts as i64, 0).unwrap_or_default();
    (dt.year(), dt.month(), dt.day(), dt.hour())
}

/// JS `String(number)`: integer-valued floats print without a decimal.
fn js_number_string(f: f64) -> String {
    if f.is_finite() && f.fract() == 0.0 {
        format!("{}", f as i64)
    } else {
        format!("{}", f)
    }
}

/// Equal-width numeric bins, mirroring JS `binNumeric`.
struct NumBuckets {
    bounds: Vec<(f64, f64)>,
    mode: BinMode,
}

enum BinMode {
    Count {
        min: f64,
        max: f64,
        step: f64,
        count: usize,
    },
    Width {
        lo0: f64,
        w: f64,
        count: usize,
    },
}

impl NumBuckets {
    fn index_of(&self, v: f64) -> usize {
        match self.mode {
            BinMode::Count {
                min,
                max,
                step,
                count,
            } => {
                if v <= min {
                    return 0;
                }
                if v >= max {
                    return count - 1;
                }
                (((v - min) / step).floor() as isize).clamp(0, count as isize - 1) as usize
            }
            BinMode::Width { lo0, w, count } => {
                (((v - lo0) / w).floor() as isize).clamp(0, count as isize - 1) as usize
            }
        }
    }
}

fn bin_numeric(values: &[f64], binning: &NumericBinning) -> Option<NumBuckets> {
    let (mut min, mut max, mut any) = (f64::INFINITY, f64::NEG_INFINITY, false);
    for &n in values {
        if n.is_finite() {
            any = true;
            if n < min {
                min = n;
            }
            if n > max {
                max = n;
            }
        }
    }
    if !any {
        return None;
    }

    match *binning {
        NumericBinning::Count { n } => {
            let count = n as usize;
            if count < 1 || min == max {
                return None;
            }
            let step = (max - min) / count as f64;
            let bounds = (0..count)
                .map(|i| {
                    let lo = min + step * i as f64;
                    let hi = if i == count - 1 {
                        max
                    } else {
                        min + step * (i + 1) as f64
                    };
                    (lo, hi)
                })
                .collect();
            Some(NumBuckets {
                bounds,
                mode: BinMode::Count {
                    min,
                    max,
                    step,
                    count,
                },
            })
        }
        NumericBinning::Width { w } => {
            if !(w > 0.0) {
                return None;
            }
            let lo0 = (min / w).floor() * w;
            let count = (((max - lo0) / w).floor() as usize + 1).max(1);
            let bounds = (0..count)
                .map(|i| (lo0 + w * i as f64, lo0 + w * (i + 1) as f64))
                .collect();
            Some(NumBuckets {
                bounds,
                mode: BinMode::Width { lo0, w, count },
            })
        }
    }
}

/// Numeric bin label, matching JS `fmtBound` ("lo–hi", integers without decimals).
fn bound_label(lo: f64, hi: f64) -> String {
    format!("{}–{}", fmt_bound(lo), fmt_bound(hi))
}

fn fmt_bound(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{}", (n * 100.0).round() / 100.0)
    }
}

#[cfg(test)]
#[path = "selections.test.rs"]
mod tests;
