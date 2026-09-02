//! Selection resolution engine.
//!
//! Selections are predicates over the location set (tag membership, polygon containment,
//! duplicates, filters on arbitrary fields, etc.). Each resolves to an id set over the
//! unified `LocView` (batch + overlay); composites (Intersection, Union, Invert) combine
//! their children's sets.

pub(crate) mod field_expr;
pub(crate) mod saved;

use crate::store::arrow;
use crate::types;
use crate::types::{Location, LocationFlags};
use arrow_array::{Array, Float64Array, ListArray, RecordBatch, StringArray, UInt32Array};

mod duplicates;
mod filter;
mod geometry;
mod partition;
pub use duplicates::*;
pub use filter::*;
pub use geometry::*;
pub(crate) use mma_geo::{
    anchor_bbox, extend_bbox_with_ring, haversine_m, in_bbox, polygon_contains, PreparedRing,
};
#[cfg(test)]
pub(crate) use mma_geo::{point_in_ring, unwrap_ring};
pub use partition::*;
use rayon::prelude::*;
use roaring::RoaringBitmap;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::collections::{HashMap, HashSet};

/// Discriminated union of all selection types. Serialized with `{ "type": "..." }` tag
/// for JS interop. Simple types (Tag, Untagged, PanoIds, etc.) resolve in O(N) with
///  parallel batch scans. Composites (Intersection, Union, Invert) recursively resolve
/// children. Duplicates uses a grid-accelerated spatial scan.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "type")]
pub enum Selector {
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
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
    pub selector: Selector,
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
    pano_ids: Option<&'a StringArray>,
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
    /// Visit each top-level `extra` key. Byte-scan only: no value parsing, no map alloc.
    pub fn for_each_extra_key(&self, mut f: impl FnMut(&str)) {
        match &self.inner {
            RowInner::Loc(l) => {
                if let Some(extra) = l.extra.as_ref() {
                    extra.for_each_field(|k, _| f(k));
                }
            }
            RowInner::Base(v, i) => {
                let Some(extras) = v.extras else { return };
                if extras.is_null(*i) {
                    return;
                }
                let s = extras.value(*i);
                types::scan_fields(s.as_bytes(), |fs| {
                    f(&types::decode_json_key(&s[fs.key.clone()]));
                    false
                });
            }
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
                // One byte-scan collects both members; only their value slices parse.
                let mut fv_extra: Option<serde_json::Value> = None;
                let mut tz: Option<String> = None;
                if let Some(s) = v.extras.and_then(|c| (!c.is_null(*i)).then(|| c.value(*i))) {
                    let b = s.as_bytes();
                    types::scan_fields(b, |fs| {
                        let k = &b[fs.key.clone()];
                        // Not else-if: `field` may itself be "timezone".
                        if tz.is_none() && k == b"timezone" {
                            tz = serde_json::from_str::<serde_json::Value>(&s[fs.value.clone()])
                                .ok()
                                .and_then(|v| v.as_str().map(str::to_owned));
                        }
                        if fv_extra.is_none() && k == field.as_bytes() {
                            fv_extra = serde_json::from_str(&s[fs.value.clone()]).ok();
                        }
                        tz.is_some() && fv_extra.is_some()
                    });
                }
                // Built-in names come from their columns, not the extras blob.
                let fv = if is_builtin_field(field) {
                    resolve_field_arrow(v, *i, field)
                } else {
                    fv_extra
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
    pub fn matches(&self, selector: &Selector) -> bool {
        test_row(self, selector)
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
        use crate::store::arrow::{
            col_created_at, col_extra, col_flags, col_heading, col_id, col_lat, col_lng,
            col_modified_at, col_pano_id, col_pitch, col_tags, col_zoom,
        };
        let batch_rows = batch.map_or(0, RecordBatch::num_rows);
        let ids = batch.map(col_id);
        let lats = batch.map(col_lat);
        let lngs = batch.map(col_lng);
        let headings = batch.map(col_heading);
        let pitches = batch.map(col_pitch);
        let zooms = batch.map(col_zoom);
        let flags = batch.map(col_flags);
        let tags = batch.map(col_tags);
        let extras = batch.map(col_extra);
        let pano_ids = batch.map(col_pano_id);
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
            pano_ids,
            created_ats,
            modified_ats,
            batch_rows,
            has_dead,
            has_patches,
            tag_sets,
        }
    }

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

    #[inline]
    pub fn patch_at(&self, i: usize) -> Option<&'a Location> {
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

    pub fn loc_at(&self, i: usize) -> Location {
        arrow::row_to_location(self.batch.unwrap(), i)
    }

    /// Every alive location once, overlay applied: dead rows skipped, patched rows
    /// surfaced as `RowRef::Loc`, then the overlay adds. The patch is resolved a
    /// single time per row.
    pub fn iter(&self) -> impl Iterator<Item = RowRef<'a, '_>> {
        (0..self.batch_rows)
            .filter(move |&i| self.is_alive(i))
            .map(move |i| match self.patch_at(i) {
                Some(p) => RowRef::from_loc(p),
                None => RowRef {
                    inner: RowInner::Base(self, i),
                },
            })
            .chain(self.adds.iter().map(RowRef::from_loc))
    }

    /// The narrowing guard: rows in `set` only, `None` = every alive row. Pairs with
    /// `narrow` -- resolution happens once at the command boundary, this is
    /// the one place the resolved set filters iteration.
    pub fn within<'v>(
        &'v self,
        set: Option<&'v RoaringBitmap>,
    ) -> impl Iterator<Item = RowRef<'a, 'v>> + 'v {
        self.iter()
            .filter(move |r| set.is_none_or(|s| s.contains(r.id())))
    }

    /// `within` as a visitor. A set small enough that seeking each id beats one
    /// sequential pass is walked by id (sorted ids on both the batch and the adds keep
    /// view order); anything larger takes the dense walk.
    #[inline]
    pub fn for_each_within<'v>(
        &'v self,
        set: Option<&'v RoaringBitmap>,
        mut f: impl FnMut(RowRef<'a, 'v>),
    ) {
        let physical_rows = self.batch_rows + self.adds.len();
        let sparse = set.is_some_and(|set| {
            let search_steps = self.batch_rows.checked_ilog2().unwrap_or(0)
                + self.adds.len().checked_ilog2().unwrap_or(0)
                + 2;
            set.len().saturating_mul(u64::from(search_steps)) < physical_rows as u64
        });
        if !sparse {
            self.within(set).for_each(f);
            return;
        }

        let set = set.unwrap();
        for id in set.iter() {
            let Some(i) = self
                .batch
                .and_then(|batch| arrow::batch_row_for_id(batch, id))
            else {
                continue;
            };
            if !self.is_alive(i) {
                continue;
            }
            let row = match self.patch_at(i) {
                Some(p) => RowRef::from_loc(p),
                None => RowRef {
                    inner: RowInner::Base(self, i),
                },
            };
            f(row);
        }
        for id in set.iter() {
            if let Ok(i) = self.adds.binary_search_by_key(&id, |loc| loc.id) {
                f(RowRef::from_loc(&self.adds[i]));
            }
        }
    }

    #[inline]
    pub fn for_each(&self, f: impl FnMut(RowRef)) {
        self.iter().for_each(f);
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

fn test_row(r: &RowRef, selector: &Selector) -> bool {
    match selector {
        Selector::Everything => true,
        Selector::Locations { locations, .. }
        | Selector::Manual { locations }
        | Selector::ValidationState { locations, .. }
        | Selector::Reviewed { locations, .. } => locations.contains(&r.id()),
        Selector::Tag { tag_id } => r.has_tag(*tag_id),
        Selector::Untagged => r.tags_empty(),
        Selector::Unpanned => r.heading() == 0.0,
        Selector::PanoIds => r.flags().contains(LocationFlags::LOAD_AS_PANO_ID),
        Selector::NotPanoIds => !r.flags().contains(LocationFlags::LOAD_AS_PANO_ID),
        Selector::Uncommitted => r.is_uncommitted(),
        Selector::Polygon {
            polygon,
            include_informational,
        } => {
            if !include_informational && r.flags().contains(LocationFlags::INFORMATIONAL) {
                return false;
            }
            point_in_geometry(r.lng(), r.lat(), polygon)
        }
        Selector::Filter {
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
                None => matches!(op, FilterOp::Nothas),
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
/// combine child bitmaps with native roaring set ops (`&`/`|`/`Sub`) - branchless,
/// sparse-aware, no per-row scanning. A `Tag` leaf hits the membership index when
/// present (O(1)-ish clone) instead of scanning every row's tag list. Geometric
/// leaves (`Polygon`/`Filter`/`Duplicates`) still scan, producing a positional mask
/// that is converted to an id set.
pub fn resolve(view: &LocView, selector: &Selector) -> RoaringBitmap {
    match selector {
        // Tag leaf via index: clone the precomputed member set, minus dead ids.
        Selector::Tag { tag_id } => {
            if let Some(idx) = view.tag_sets {
                let mut set = idx.get(tag_id).cloned().unwrap_or_default();
                if view.has_dead {
                    for &d in view.dead {
                        set.remove(d);
                    }
                }
                // Overlay adds aren't in the batch-built index; fold them in by scan.
                for loc in view.adds {
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
        Selector::Intersection { selections } => {
            if selections.is_empty() {
                return RoaringBitmap::new();
            }
            let mut acc = resolve(view, &selections[0].selector);
            for s in &selections[1..] {
                acc &= resolve(view, &s.selector);
                if acc.is_empty() {
                    break;
                } // short-circuit: nothing left to intersect
            }
            return acc;
        }
        Selector::Union { selections } => {
            let mut acc = RoaringBitmap::new();
            for s in selections {
                acc |= resolve(view, &s.selector);
            }
            return acc;
        }
        Selector::Invert { selections } => {
            // Invert = (all alive ids) - (child ids). roaring-rs has no native flip,
            // so this is a difference against the universe set.
            let universe = alive_id_set(view);
            if selections.is_empty() {
                return universe;
            }
            let inner = resolve(view, &selections[0].selector);
            return universe - inner;
        }
        _ => {}
    }
    // Scan leaves (incl. Tag with no index): build a positional mask, convert to ids.
    let mask = resolve_leaf_mask(view, selector);
    mask_to_set(view, &mask)
}

/// Resolve a whole selection forest in one pass: the id-set for each top-level
/// selection plus the resolved count of every node (top-level and nested), keyed by
/// `Selection.key`. Each node is resolved exactly once - composites combine their
/// children's already-resolved sets instead of re-resolving them.
pub fn resolve_forest(
    view: &LocView,
    sels: &[Selection],
) -> (Vec<RoaringBitmap>, HashMap<String, u32>) {
    fn walk(view: &LocView, sel: &Selection, counts: &mut HashMap<String, u32>) -> RoaringBitmap {
        let set = match &sel.selector {
            Selector::Intersection { selections } => {
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
            Selector::Union { selections } => {
                let mut acc = RoaringBitmap::new();
                for c in selections {
                    acc |= walk(view, c, counts);
                }
                acc
            }
            Selector::Invert { selections } => {
                let universe = alive_id_set(view);
                let mut children = selections.iter();
                let set = match children.next() {
                    Some(first) => universe - walk(view, first, counts),
                    None => universe,
                };
                // Invert is unary: extra children don't affect the set but their
                // counts are still reported, matching resolve semantics.
                for c in children {
                    walk(view, c, counts);
                }
                set
            }
            _ => resolve(view, &sel.selector),
        };
        counts.insert(sel.key.clone(), set.len() as u32);
        set
    }
    let mut counts = HashMap::new();
    let sets = sels.iter().map(|s| walk(view, s, &mut counts)).collect();
    (sets, counts)
}

/// Resolved count of every selection node - top-level and nested - keyed by
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
/// (or O(N^2) grid-accelerated for Duplicates). Composites are handled by `resolve`.
fn resolve_leaf_mask(view: &LocView, selector: &Selector) -> Vec<bool> {
    let n = view.batch_rows + view.adds.len();
    match selector {
        Selector::Locations { locations, .. }
        | Selector::Manual { locations }
        | Selector::ValidationState { locations, .. }
        | Selector::Reviewed { locations, .. } => {
            let set: HashSet<u32> = locations.iter().copied().collect();
            view.resolve_mask(|r| set.contains(&r.id()))
        }
        Selector::Duplicates { distance } => {
            let mut mask = vec![false; n];
            find_duplicates_bitmask(view, *distance, &mut mask);
            mask
        }
        Selector::Polygon {
            polygon,
            include_informational,
        } => {
            let inc = *include_informational;
            match geometry_bbox(polygon) {
                None => vec![false; n],
                Some(bb) => {
                    let prepared = PreparedGeometry::new(polygon);
                    view.resolve_mask(|r| {
                        if !inc && r.flags().contains(LocationFlags::INFORMATIONAL) {
                            return false;
                        }
                        in_bbox(r.lng(), r.lat(), &bb) && prepared.contains(r.lng(), r.lat())
                    })
                }
            }
        }
        Selector::TopK {
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
            let k = *k as usize;
            let asc = |a: &(usize, f64), b: &(usize, f64)| {
                a.1.partial_cmp(&b.1).unwrap_or(Ordering::Equal)
            };
            if k > 0 && k < entries.len() {
                if *ascending {
                    entries.select_nth_unstable_by(k - 1, asc);
                } else {
                    entries.select_nth_unstable_by(k - 1, |a, b| asc(b, a));
                }
                entries.truncate(k);
            }
            let mut mask = vec![false; n];
            if k > 0 {
                for &(i, _) in &entries {
                    mask[i] = true;
                }
            }
            mask
        }
        _ => view.resolve_mask(|r| test_row(r, selector)),
    }
}

/// The id set a selector narrows to, or `None` for "no narrowing" -- every alive row.
/// Two selectors answer without resolving: `Everything` is the whole map, and `Locations`
/// is already an id list. The result is only ever handed to [`LocView::within`], which
/// skips dead rows itself, so neither fast path has to filter them.
pub fn narrow(view: &LocView, selector: &Selector) -> Option<RoaringBitmap> {
    match selector {
        Selector::Everything => None,
        Selector::Locations { locations, .. } => Some(locations.iter().copied().collect()),
        _ => Some(resolve(view, selector)),
    }
}

/// How many selected rows hold a value for each field, key-sorted: `extra` keys and the
/// built-in columns a row can lack. A column that is always present would report every
/// row and say nothing, so only the optional ones are counted.
pub fn coverage(view: &LocView, set: Option<&RoaringBitmap>) -> Vec<(String, u32)> {
    let columns = optional_builtins();
    let mut counts: HashMap<String, u32> = HashMap::new();
    view.for_each_within(set, |row| {
        row.for_each_extra_key(|key| match counts.get_mut(key) {
            Some(c) => *c += 1,
            None => {
                counts.insert(key.to_string(), 1);
            }
        });
        for key in columns {
            if row.resolve_field(key).is_some() {
                *counts.entry((*key).to_string()).or_insert(0) += 1;
            }
        }
    });
    let mut out: Vec<(String, u32)> = counts.into_iter().collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// One value per selected row for each of `fields`, in view order, `Null` where the row
/// lacks it; `"tags"` yields the row's tag ids. A typed projection for scans that need
/// values but not rows.
pub fn columns_within(
    view: &LocView,
    set: Option<&RoaringBitmap>,
    fields: &[String],
) -> Vec<Vec<serde_json::Value>> {
    let mut out: Vec<Vec<serde_json::Value>> = fields.iter().map(|_| Vec::new()).collect();
    view.for_each_within(set, |row| {
        for (col, field) in out.iter_mut().zip(fields) {
            col.push(if field == "tags" {
                let mut tags = Vec::new();
                row.for_each_tag(|t| tags.push(serde_json::Value::from(t)));
                serde_json::Value::Array(tags)
            } else {
                row.resolve_field(field).unwrap_or(serde_json::Value::Null)
            });
        }
    });
    out
}

/// Size of the selected set. Counts rows, never materializes them.
pub fn count_within(view: &LocView, set: Option<&RoaringBitmap>) -> u32 {
    let mut count = 0;
    view.for_each_within(set, |_| count += 1);
    count
}

/// Ids of every alive location in the set, in view order (batch rows, then overlay adds).
pub fn ids_within(view: &LocView, set: Option<&RoaringBitmap>) -> Vec<u32> {
    let mut ids = Vec::new();
    view.for_each_within(set, |row| ids.push(row.id()));
    ids
}

/// Distinct values of `field` across the selected set, sorted. Scalars stringify so they
/// match the string-typed options they populate; null and containers are skipped.
pub fn distinct_values(view: &LocView, field: &str, set: Option<&RoaringBitmap>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    view.for_each_within(set, |row| match row.resolve_field(field) {
        Some(serde_json::Value::String(s)) if !s.is_empty() => {
            seen.insert(s);
        }
        Some(v @ (serde_json::Value::Number(_) | serde_json::Value::Bool(_))) => {
            seen.insert(v.to_string());
        }
        _ => {}
    });
    seen.into_iter().collect()
}

/// `n` distinct ids drawn uniformly at random. Partial Fisher-Yates, so drawing 5 from a
/// million swaps 5 entries rather than shuffling the pool.
pub fn sample(mut ids: Vec<u32>, n: usize) -> Vec<u32> {
    let k = n.min(ids.len());
    for i in 0..k {
        let j = i + fastrand::usize(..ids.len() - i);
        ids.swap(i, j);
    }
    ids.truncate(k);
    ids
}

#[cfg(test)]
#[path = "selections.test.rs"]
mod tests;
