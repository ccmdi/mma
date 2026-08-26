//! Selection resolution engine.
//!
//! Selections are predicates over the location set (tag membership, polygon containment,
//! duplicates, filters on arbitrary fields, etc.). Each resolves to an id set over the
//! unified `LocView` (batch + overlay); composites (Intersection, Union, Invert) combine
//! their children's sets.

use crate::types::{Location, LocationFlags};
use crate::util::{tz_offset_seconds, unix_to_hour_min, unix_to_month_day};
use arrow_array::{Array, Float64Array, ListArray, RecordBatch, StringArray, UInt32Array};
use chrono::{DateTime, Datelike, Timelike, Utc};
use mma_geo::equirect_m2;
pub(crate) use mma_geo::{
    anchor_bbox, extend_bbox_with_ring, haversine_m, in_bbox, polygon_contains, PreparedRing,
};
#[cfg(test)]
pub(crate) use mma_geo::{point_in_ring, unwrap_ring};
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
                crate::types::scan_fields(s.as_bytes(), |fs| {
                    f(&crate::types::decode_json_key(&s[fs.key.clone()]));
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
                    crate::types::scan_fields(b, |fs| {
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
        use crate::arrow_bridge::{
            col_created_at, col_extra, col_flags, col_heading, col_id, col_lat, col_lng,
            col_modified_at, col_pano_id, col_pitch, col_tags, col_zoom,
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
        crate::arrow_bridge::row_to_location(self.batch.unwrap(), i)
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

    #[inline]
    pub fn for_each(&self, f: impl FnMut(RowRef)) {
        self.iter().for_each(f)
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
pub fn resolve(view: &LocView, selector: &Selector) -> RoaringBitmap {
    match selector {
        // Tag leaf via index: clone the precomputed member set, minus dead ids.
        Selector::Tag { tag_id } => {
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
/// `Selection.key`. Each node is resolved exactly once — composites combine their
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
                a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)
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

// --- Geometry (ray-casting point-in-polygon; primitives live in mma-geo) ---

/// A whole geometry (primary polygon + extras) preprocessed with per-ring bboxes and
/// antimeridian flags. Build once per resolve; `contains` is then bbox-rejected per
/// polygon and per hole instead of paying the O(V) antimeridian pre-scan per point.
pub(crate) struct PreparedGeometry<'a> {
    /// Each entry is one polygon: outer ring first, then holes.
    polys: Vec<Vec<PreparedRing<'a>>>,
}

impl<'a> PreparedGeometry<'a> {
    pub(crate) fn new(geom: &'a PolygonGeometry) -> Self {
        let prep = |rings: &'a [Vec<[f64; 2]>]| -> Vec<PreparedRing<'a>> {
            rings.iter().map(|r| PreparedRing::new(r)).collect()
        };
        let mut polys = vec![prep(&geom.coordinates)];
        if let Some(extras) = &geom.extra_polygons {
            for p in extras {
                polys.push(prep(p));
            }
        }
        Self { polys }
    }

    /// Equivalent to `point_in_geometry`.
    #[inline]
    pub(crate) fn contains(&self, lng: f64, lat: f64) -> bool {
        self.polys.iter().any(|rings| match rings.split_first() {
            Some((outer, holes)) => {
                outer.contains(lng, lat) && !holes.iter().any(|h| h.contains(lng, lat))
            }
            None => false,
        })
    }
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
/// Longitudes are in the unwrapped frame of the first ring, so `min_lng` may sit below
/// -180 and `max_lng` above it - `in_bbox` handles this transparently.
pub(crate) fn geometry_bbox(geom: &PolygonGeometry) -> Option<[f64; 4]> {
    let mut bb = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    let mut any = false;
    for ring in &geom.coordinates {
        extend_bbox_with_ring(&mut bb, &mut any, ring);
    }
    if let Some(extras) = &geom.extra_polygons {
        for poly in extras {
            for ring in poly {
                extend_bbox_with_ring(&mut bb, &mut any, ring);
            }
        }
    }
    if any {
        anchor_bbox(&mut bb);
        Some(bb)
    } else {
        None
    }
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

/// Index groups keyed by exact coordinate, the degenerate-radius fallback shared by
/// every duplicate path: "within 0 m" means exact-coordinate equality. The grid would
/// divide by zero, saturate every point to one cell, and collapse to O(n^2). Hashing
/// on exact coords instead is O(n); non-finite coordinates never match anything. (#69)
fn exact_coord_groups(pts: &[(f64, f64)]) -> HashMap<(u64, u64), Vec<usize>> {
    let mut groups: HashMap<(u64, u64), Vec<usize>> = HashMap::new();
    for (i, &(lat, lng)) in pts.iter().enumerate() {
        if !lat.is_finite() || !lng.is_finite() {
            continue;
        }
        // `+ 0.0` folds -0.0 into +0.0 so the two compare equal.
        groups
            .entry(((lat + 0.0).to_bits(), (lng + 0.0).to_bits()))
            .or_default()
            .push(i);
    }
    groups
}

/// The grid broad-phase every duplicate path runs on: cell sizing, coordinate
/// quantization, and the neighborhood walk live here once, so the pair sweep and
/// the parallel per-point scan cannot drift apart. Read-only after build, so callers
/// may probe it from parallel iterators.
struct DupGrid {
    /// (lat, lng) per point, the coordinates the cells were quantized from.
    pts: Vec<(f64, f64)>,
    cells: Vec<(i32, i32)>,
    grid: SpatialHash,
    thresh_m2: f64,
    radius_m: f64,
    cell_deg: f64,
}

impl DupGrid {
    /// `None` for a degenerate radius (distance == 0, or a non-finite cell size) —
    /// callers fall back to `exact_coord_groups`.
    fn build(pts: &[(f64, f64)], distance_m: f64) -> Option<DupGrid> {
        let cell_deg = distance_m / mma_geo::M_PER_DEG * 1.5;
        if !(cell_deg > 0.0) {
            return None;
        }
        let pts = pts.to_vec();
        let cells: Vec<(i32, i32)> = pts
            .iter()
            .map(|&(lat, lng)| {
                (
                    (lng / cell_deg).floor() as i32,
                    (lat / cell_deg).floor() as i32,
                )
            })
            .collect();
        let grid = SpatialHash::build(&cells);
        Some(DupGrid {
            pts,
            cells,
            grid,
            thresh_m2: distance_m * distance_m,
            radius_m: distance_m,
            cell_deg,
        })
    }

    /// Visit every point within the distance threshold of `pi`, skipping indices below
    /// `min_pj` before the distance test (`pi + 1` gives the ordered pair sweep, `0`
    /// gives all neighbours). Stops early when `visit` returns true; returns whether it
    /// stopped.
    fn for_each_neighbor(
        &self,
        pi: usize,
        min_pj: usize,
        mut visit: impl FnMut(usize) -> bool,
    ) -> bool {
        let (lat, lng) = self.pts[pi];
        let cos_lat = lat.to_radians().cos();
        let cover = mma_geo::covering_cells(lat, lng, self.radius_m, self.cell_deg);
        for (nx, ny) in cover.cells() {
            for &pj in self.grid.bucket(nx, ny) {
                let pj = pj as usize;
                if pj == pi || pj < min_pj {
                    continue;
                }
                // Bucket may hold points from collided cells; the cell-coord check
                // keeps us to the true neighborhood. Then the distance test.
                if self.cells[pj] != (nx, ny) {
                    continue;
                }
                let (plat, plng) = self.pts[pj];
                if equirect_m2(lat, lng, plat, plng, cos_lat) <= self.thresh_m2 && visit(pj) {
                    return true;
                }
            }
        }
        false
    }
}

/// Grid broad-phase pair sweep shared by the duplicate groups/prune paths.
/// Calls `pair(state, pi, pj)` (pi < pj) for every index pair within `distance_m`
/// metres. O(N) average with uniform distribution, O(N^2) worst case if all points
/// fall in one grid cell.
fn for_pairs_within<S>(
    n: usize,
    pos: impl Fn(usize) -> (f64, f64),
    distance_m: f64,
    state: &mut S,
    mut pair: impl FnMut(&mut S, usize, usize),
) {
    if n < 2 {
        return;
    }
    let pts: Vec<(f64, f64)> = (0..n).map(pos).collect();
    let Some(grid) = DupGrid::build(&pts, distance_m) else {
        for idxs in exact_coord_groups(&pts).values() {
            for (a, &pi) in idxs.iter().enumerate() {
                for &pj in &idxs[a + 1..] {
                    pair(state, pi, pj);
                }
            }
        }
        return;
    };
    for pi in 0..n {
        grid.for_each_neighbor(pi, pi + 1, |pj| {
            pair(state, pi, pj);
            false
        });
    }
}

/// Grid-accelerated spatial duplicate detection: `mask[global_idx] = true` for every
/// location with at least one other location within `distance_m`. A per-point
/// predicate rather than a pair sweep: the grid is read-only after build, so points
/// are tested in parallel, and each test early-exits on its first neighbour — a
/// dense cluster costs O(1) per member instead of O(members) pair callbacks.
fn find_duplicates_bitmask(view: &LocView, distance_m: f64, mask: &mut [bool]) {
    use rayon::prelude::*;
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
    if n < 2 {
        return;
    }

    let pts: Vec<(f64, f64)> = points.iter().map(|p| (p.lat, p.lng)).collect();
    // Degenerate radius: every member of an exact-coordinate group of >= 2 is a dup.
    let Some(grid) = DupGrid::build(&pts, distance_m) else {
        for idxs in exact_coord_groups(&pts).values() {
            if idxs.len() >= 2 {
                for &i in idxs {
                    mask[points[i].global_idx] = true;
                }
            }
        }
        return;
    };

    let marks: Vec<bool> = (0..n)
        .into_par_iter()
        .with_min_len(4096)
        .map(|pi| grid.for_each_neighbor(pi, 0, |_| true))
        .collect();
    for (i, p) in points.iter().enumerate() {
        if marks[i] {
            mask[p.global_idx] = true;
        }
    }
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

    // Union-find with path halving and union by size.
    fn find(parent: &mut [usize], mut x: usize) -> usize {
        while parent[x] != x {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        x
    }
    let mut uf: (Vec<usize>, Vec<u32>) = ((0..n).collect(), vec![1; n]);

    for_pairs_within(
        n,
        |i| (points[i].lat, points[i].lng),
        distance_m,
        &mut uf,
        |uf, pi, pj| {
            let ra = find(&mut uf.0, pi);
            let rb = find(&mut uf.0, pj);
            if ra != rb {
                let (small, big) = if uf.1[ra] < uf.1[rb] {
                    (ra, rb)
                } else {
                    (rb, ra)
                };
                uf.0[small] = big;
                uf.1[big] += uf.1[small];
            }
        },
    );
    let mut parent = uf.0;

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
    // Bucket queue by degree: O(n + m) total instead of an O(n) max-scan per round.
    // A degree drop re-files the node; the entry left in the old bucket goes stale
    // and is skipped on pop (deg mismatch), so no in-place removal is needed.
    let max_deg = deg.iter().copied().max().unwrap_or(0) as usize;
    let mut buckets: Vec<Vec<usize>> = vec![Vec::new(); max_deg + 1];
    for i in 0..n {
        if deg[i] > 0 {
            buckets[deg[i] as usize].push(i);
        }
    }
    let mut cur = max_deg;
    while cur > 0 {
        let Some(i) = buckets[cur].pop() else {
            cur -= 1;
            continue;
        };
        if removed[i] || deg[i] as usize != cur {
            continue;
        }
        removed[i] = true;
        deg[i] = 0;
        for &u in &neighbors[i] {
            if !removed[u] && deg[u] > 0 {
                deg[u] -= 1;
                if deg[u] > 0 {
                    buckets[deg[u] as usize].push(u);
                }
            }
        }
    }
    (0..n).filter(|&i| removed[i]).map(|i| locs[i].id).collect()
}

// --- Filter: field-level comparison predicates ---

/// How a built-in field may be accessed by the field system on the TS side.
/// `None` means listable and filterable but read-only.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum BuiltinFieldKind {
    /// Composes the location itself: never writable, never offered in pickers.
    Identity,
    /// Derived, not stored on the location. Never writable.
    Virtual,
    /// Explicitly bulk-editable top-level field.
    Writable,
}

/// One entry of the built-in field vocabulary. Exported to TS as a specta constant so
/// `fieldDefRegistry` derives its table from here rather than restating it.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinField {
    pub key: &'static str,
    pub label: &'static str,
    #[serde(rename = "type")]
    pub field_type: crate::map_meta::ExtraFieldType,
    pub kind: Option<BuiltinFieldKind>,
    pub comparison: Option<crate::map_meta::ComparisonType>,
}

/// Single source of truth for the built-in field vocabulary: the exported table, the two
/// per-row resolvers, and the "is this a column, not an extras key" test all expand from
/// one list. Match arms are literal-keyed, so resolution stays allocation-free.
macro_rules! builtin_fields {
    ($(
        $key:literal, $label:literal, $ty:expr, $kind:expr, $cmp:expr,
        |$l:ident| $loc_expr:expr,
        |$v:ident, $i:ident| $arrow_expr:expr;
    )*) => {
        pub const BUILTIN_FIELDS: &[BuiltinField] = &[$(BuiltinField {
            key: $key,
            label: $label,
            field_type: $ty,
            kind: $kind,
            comparison: $cmp,
        }),*];

        /// True for fields backed by a Location column rather than the `extras` blob.
        pub fn is_builtin_field(field: &str) -> bool {
            matches!(field, $($key)|*)
        }

        /// True for the built-in columns a bulk set may assign (`heading`, `pitch`, `zoom`).
        pub fn is_writable_builtin(field: &str) -> bool {
            BUILTIN_FIELDS
                .iter()
                .any(|f| f.key == field && matches!(f.kind, Some(BuiltinFieldKind::Writable)))
        }

        /// Resolve a field name to its JSON value from a `Location` struct.
        /// Unknown fields fall through to `loc.extra`.
        fn resolve_field_loc(loc: &Location, field: &str) -> Option<serde_json::Value> {
            match field {
                $($key => { let $l = loc; $loc_expr })*
                _ => loc.extra.as_ref().and_then(|e| e.get(field)),
            }
        }

        /// Resolve a field name to its JSON value directly from Arrow columns (avoids
        /// materializing a full `Location`). Falls through to `extras` JSON otherwise.
        fn resolve_field_arrow(view: &LocView, idx: usize, field: &str) -> Option<serde_json::Value> {
            match field {
                $($key => { let ($v, $i) = (view, idx); $arrow_expr })*
                _ => {
                    let extras = view.extras?;
                    if extras.is_null(idx) {
                        return None;
                    }
                    // Byte-scan for the one key; parses only its value slice instead of
                    // the whole extras document per row.
                    crate::types::json_field(extras.value(idx), field)
                }
            }
        }
    };
}

use crate::map_meta::{ComparisonType, ExtraFieldType};

builtin_fields! {
    "lat", "Latitude", ExtraFieldType::Number, Some(BuiltinFieldKind::Identity), None,
        |l| Some(serde_json::json!(l.lat)),
        |v, i| v.lats.map(|c| serde_json::json!(c.value(i)));
    "lng", "Longitude", ExtraFieldType::Number, Some(BuiltinFieldKind::Identity), None,
        |l| Some(serde_json::json!(l.lng)),
        |v, i| v.lngs.map(|c| serde_json::json!(c.value(i)));
    "heading", "Heading", ExtraFieldType::Number, Some(BuiltinFieldKind::Writable),
        Some(ComparisonType::Circular { period: 360.0 }),
        |l| Some(serde_json::json!(l.heading)),
        |v, i| v.headings.map(|c| serde_json::json!(c.value(i)));
    "pitch", "Pitch", ExtraFieldType::Number, Some(BuiltinFieldKind::Writable), None,
        |l| Some(serde_json::json!(l.pitch)),
        |v, i| v.pitches.map(|c| serde_json::json!(c.value(i)));
    "zoom", "Zoom", ExtraFieldType::Number, Some(BuiltinFieldKind::Writable), None,
        |l| Some(serde_json::json!(l.zoom)),
        |v, i| v.zooms.map(|c| serde_json::json!(c.value(i)));
    "id", "ID", ExtraFieldType::Number, Some(BuiltinFieldKind::Identity), None,
        |l| Some(serde_json::json!(l.id)),
        |v, i| v.ids.map(|c| serde_json::json!(c.value(i)));
    "createdAt", "Created", ExtraFieldType::Date, None, None,
        |l| Some(serde_json::json!(l.created_at as f64)),
        |v, i| v.created_ats.map(|c| serde_json::json!(c.value(i) as f64));
    "modifiedAt", "Modified", ExtraFieldType::Date, None, None,
        |l| l.modified_at.map(|ts| serde_json::json!(ts as f64)),
        |v, i| v.modified_ats.and_then(|c| {
            (!c.is_null(i)).then(|| serde_json::json!(c.value(i) as f64))
        });
    "panoId", "Pano ID", ExtraFieldType::String, None, None,
        |l| l.pano_id.as_deref().map(|p| serde_json::json!(p)),
        |v, i| v.pano_ids.and_then(|c| {
            (!c.is_null(i)).then(|| serde_json::json!(c.value(i)))
        });
    "tagCount", "Tag count", ExtraFieldType::Number, Some(BuiltinFieldKind::Virtual), None,
        |l| Some(serde_json::json!(l.tags.len())),
        |v, i| v.tags.map(|c| serde_json::json!(c.value(i).len()));
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
// `partition` splits the selected location set into groups by a derived key, returning
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

/// One grouping projection a field type may be partitioned by: `"value"` or a `DatePart`
/// by its wire name. Exported to TS as a specta constant so the dropdowns derive from
/// here rather than restating the list.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Projection {
    pub id: &'static str,
    pub applies_to: &'static [crate::map_meta::ExtraFieldType],
    /// Date projections read in the location's own timezone when asked to.
    pub needs_tz: bool,
}

pub const PROJECTIONS: &[Projection] = {
    use crate::map_meta::ExtraFieldType::*;
    &[
        Projection {
            id: "value",
            applies_to: &[String, Enum, Number, Month],
            needs_tz: false,
        },
        Projection {
            id: "year",
            applies_to: &[Date, Month],
            needs_tz: true,
        },
        Projection {
            id: "yearMonth",
            applies_to: &[Date],
            needs_tz: true,
        },
        Projection {
            id: "day",
            applies_to: &[Date],
            needs_tz: true,
        },
        Projection {
            id: "monthOfYear",
            applies_to: &[Date, Month],
            needs_tz: true,
        },
        Projection {
            id: "hourOfDay",
            applies_to: &[Date],
            needs_tz: true,
        },
    ]
};

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

/// Partition `view` into groups by `field`. `set` (when Some) restricts to those ids.
/// Returns groups in a deterministic but unsorted order (numeric: bin order; projection:
/// first-seen) — the JS caller sorts for display.
pub fn partition(
    view: &LocView,
    field: &str,
    spec: &KeySpec,
    set: Option<&RoaringBitmap>,
) -> Vec<PartitionBucket> {
    match spec {
        KeySpec::NumericBin { binning } => partition_numeric(view, field, binning, set),
        _ => partition_keyed(view, field, spec, set),
    }
}

fn partition_numeric(
    view: &LocView,
    field: &str,
    binning: &NumericBinning,
    set: Option<&RoaringBitmap>,
) -> Vec<PartitionBucket> {
    let mut vals: Vec<(u32, f64)> = Vec::new();
    for row in view.within(set) {
        if let Some(n) = row.resolve_field(field).as_ref().and_then(as_f64) {
            vals.push((row.id(), n));
        }
    }
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
    set: Option<&RoaringBitmap>,
) -> Vec<PartitionBucket> {
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut groups: Vec<PartitionBucket> = Vec::new();
    for row in view.within(set) {
        let id = row.id();
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
                continue;
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
    }
    groups
}

/// Group counts without the member ids. Delegates to `partition` so key derivation
/// keeps one definition.
pub fn count_by(
    view: &LocView,
    field: &str,
    spec: &KeySpec,
    set: Option<&RoaringBitmap>,
) -> Vec<(String, u32)> {
    partition(view, field, spec, set)
        .into_iter()
        .map(|g| (g.key, g.ids.len() as u32))
        .collect()
}

/// How many selected rows carry each top-level `extra` key, key-sorted. Answers "which
/// fields does this map actually have, and how covered are they" in one pass.
pub fn extra_key_coverage(view: &LocView, set: Option<&RoaringBitmap>) -> Vec<(String, u32)> {
    let mut counts: HashMap<String, u32> = HashMap::new();
    for row in view.within(set) {
        row.for_each_extra_key(|key| match counts.get_mut(key) {
            Some(c) => *c += 1,
            None => {
                counts.insert(key.to_string(), 1);
            }
        });
    }
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
    for row in view.within(set) {
        for (col, field) in out.iter_mut().zip(fields) {
            col.push(if field == "tags" {
                let mut tags = Vec::new();
                row.for_each_tag(|t| tags.push(serde_json::Value::from(t)));
                serde_json::Value::Array(tags)
            } else {
                row.resolve_field(field).unwrap_or(serde_json::Value::Null)
            });
        }
    }
    out
}

/// Size of the selected set. Counts rows, never materializes them.
pub fn count_within(view: &LocView, set: Option<&RoaringBitmap>) -> u32 {
    view.within(set).count() as u32
}

/// Ids of every alive location in the set, in view order (batch rows, then overlay adds).
pub fn ids_within(view: &LocView, set: Option<&RoaringBitmap>) -> Vec<u32> {
    view.within(set).map(|row| row.id()).collect()
}

/// Distinct values of `field` across the selected set, sorted. Scalars stringify so they
/// match the string-typed options they populate; null and containers are skipped.
pub fn distinct_values(view: &LocView, field: &str, set: Option<&RoaringBitmap>) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    for row in view.within(set) {
        match row.resolve_field(field) {
            Some(serde_json::Value::String(s)) if !s.is_empty() => {
                seen.insert(s);
            }
            Some(v @ (serde_json::Value::Number(_) | serde_json::Value::Bool(_))) => {
                seen.insert(v.to_string());
            }
            _ => {}
        }
    }
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
