//! Selection resolution engine.
//!
//! Selections are predicates over the location set (tag membership, polygon containment,
//! duplicates, filters on arbitrary fields, etc.). Each resolves to an id set over the
//! unified `LocView` (batch + overlay); composites (Intersection, Union, Invert) combine
//! their children's sets.

pub(crate) mod field_expr;
pub(crate) mod saved;

use crate::store::arrow;
use crate::store::maps::IndexShape;
use crate::types;
use crate::types::{Location, LocationFlags};
use arrow_array::{Array, Float64Array, ListArray, RecordBatch, StringArray, UInt32Array};

mod duplicates;
mod filter;
mod geometry;
pub(crate) mod neighborhood;
mod partition;
pub use duplicates::*;
pub use filter::*;
pub(crate) use geometry::*;
pub(crate) use mma_geo::{
    anchor_bbox, extend_bbox_with_ring, haversine_m, in_bbox, polygon_contains,
};
#[cfg(test)]
pub(crate) use mma_geo::{point_in_ring, unwrap_ring};
pub use partition::*;
use rayon::prelude::*;
use roaring::RoaringBitmap;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::BTreeSet;
use std::collections::HashMap;

/// Discriminated union of all selection types. Serialized with `{ "type": "..." }` tag
/// for JS interop. Simple types resolve in O(N) with parallel batch scans, or from an
/// inverted index when one covers the filtered field. Composites (Intersection, Union,
/// Invert) recursively resolve children. Duplicates uses a grid-accelerated spatial scan.
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
    },
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
        test: FilterOp,
    },
    /// Rank a selection by a field expression, optionally keeping only the first `k`. Emits
    /// a ranked root in rank order, where every other selector answers ascending. With no
    /// `k` this selects its child unchanged and states only how to walk it. A member the
    /// expression cannot score ranks last, so ranking never drops anything.
    #[serde(rename_all = "camelCase")]
    Ranked {
        /// What to rank; `null` ranks the whole map.
        selection: Option<Box<Selection>>,
        expr: String,
        k: Option<u32>,
        ascending: bool,
    },
}

/// A filter's predicate: the operator with its operands. Single source of truth: specta
/// renders the tagged union, so the TS `FilterOp` type and `OP_LABELS` derive from it.
/// The range operators can read a date in the row's own timezone (`tzLocal`); the
/// `between_*` shapes bucket a timestamp by month-day or time-of-day before comparing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum FilterOp {
    Has,
    Nothas,
    Eq {
        #[specta(type = specta_typescript::Any)]
        value: serde_json::Value,
    },
    Neq {
        #[specta(type = specta_typescript::Any)]
        value: serde_json::Value,
    },
    Contains {
        #[specta(type = specta_typescript::Any)]
        value: serde_json::Value,
    },
    Notcontains {
        #[specta(type = specta_typescript::Any)]
        value: serde_json::Value,
    },
    Gt {
        #[specta(type = specta_typescript::Any)]
        value: serde_json::Value,
        #[serde(default, rename = "tzLocal")]
        tz_local: bool,
    },
    Lt {
        #[specta(type = specta_typescript::Any)]
        value: serde_json::Value,
        #[serde(default, rename = "tzLocal")]
        tz_local: bool,
    },
    Gte {
        #[specta(type = specta_typescript::Any)]
        value: serde_json::Value,
        #[serde(default, rename = "tzLocal")]
        tz_local: bool,
    },
    Lte {
        #[specta(type = specta_typescript::Any)]
        value: serde_json::Value,
        #[serde(default, rename = "tzLocal")]
        tz_local: bool,
    },
    Between {
        #[specta(type = specta_typescript::Any)]
        lo: serde_json::Value,
        #[specta(type = specta_typescript::Any)]
        hi: serde_json::Value,
        #[serde(default, rename = "tzLocal")]
        tz_local: bool,
    },
    BetweenAnyyear {
        lo: String,
        hi: String,
        #[serde(default, rename = "tzLocal")]
        tz_local: bool,
    },
    BetweenAnytime {
        lo: String,
        hi: String,
        #[serde(default, rename = "tzLocal")]
        tz_local: bool,
    },
}

impl FilterOp {
    /// Whether the row's clock is read in its own timezone. Only a range asks.
    pub fn tz_local(&self) -> bool {
        match self {
            FilterOp::Gt { tz_local, .. }
            | FilterOp::Lt { tz_local, .. }
            | FilterOp::Gte { tz_local, .. }
            | FilterOp::Lte { tz_local, .. }
            | FilterOp::Between { tz_local, .. }
            | FilterOp::BetweenAnyyear { tz_local, .. }
            | FilterOp::BetweenAnytime { tz_local, .. } => *tz_local,
            _ => false,
        }
    }
}

/// GeoJSON-like polygon geometry. `coordinates` is the primary polygon (outer ring and
/// optional holes); `extraPolygons` holds any further polygons of a multipolygon.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PolygonGeometry {
    pub coordinates: Vec<Vec<[f64; 2]>>,
    pub extra_polygons: Option<Vec<Vec<Vec<[f64; 2]>>>>,
    #[serde(default)]
    #[specta(type = Option<specta_typescript::Any>)]
    pub properties: Option<serde_json::Value>,
}

/// A named, colored selection. `key` is deterministic (JS mints it) so selections can be
/// diffed across syncs; `Selection::of` keys internal queries by their serialized selector.
/// `color` is the RGB overlay color.
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub key: String,
    pub color: [u8; 3],
    pub selector: Selector,
}

impl Selection {
    /// A selection nobody displays, for code composing a query. The key is derived from
    /// the selector so equal queries share it.
    pub fn of(selector: Selector) -> Self {
        Selection {
            key: serde_json::to_string(&selector).unwrap_or_default(),
            color: [0; 3],
            selector,
        }
    }
}

impl Selector {
    /// Rows holding a value for `field`, as a filter's `has` means it.
    pub fn has(field: &str) -> Selector {
        Selector::Filter {
            field: field.into(),
            test: FilterOp::Has,
        }
    }

    /// Rows carrying `tag_id`. Membership on the `tags` list field, because that is all a
    /// tag ever was: there is no tag selector.
    pub fn tag(tag_id: u32) -> Selector {
        Selector::Filter {
            field: "tags".into(),
            test: FilterOp::Contains {
                value: serde_json::json!(tag_id),
            },
        }
    }

    /// Rows with no tags. `tags` resolves to nothing on an untagged row, so this is the
    /// ordinary "field absent" test.
    pub fn untagged() -> Selector {
        Selector::Filter {
            field: "tags".into(),
            test: FilterOp::Nothas,
        }
    }

    /// Rows whose heading was never set.
    pub fn unpanned() -> Selector {
        Selector::Filter {
            field: "heading".into(),
            test: FilterOp::Eq {
                value: serde_json::json!(0),
            },
        }
    }

    /// Rows pinned to one exact pano - the flag plus a pano id, per [`RowRef::is_pinned`] -
    /// or the rows not pinned.
    pub fn pano_ids(on: bool) -> Selector {
        let pinned = Selector::all([
            Selector::Filter {
                field: "loadAsPanoId".into(),
                test: FilterOp::Eq {
                    value: serde_json::json!(true),
                },
            },
            Selector::has("panoId"),
        ]);
        if on {
            pinned
        } else {
            pinned.not()
        }
    }

    /// Rows every selector keeps. Of none: no rows.
    pub fn all(selectors: impl IntoIterator<Item = Selector>) -> Selector {
        Selector::Intersection {
            selections: selectors.into_iter().map(Selection::of).collect(),
        }
    }

    #[allow(
        clippy::should_implement_trait,
        reason = "builder DSL alongside all/any, not the operator"
    )]
    pub fn not(self) -> Selector {
        Selector::Invert {
            selections: vec![Selection::of(self)],
        }
    }
}

// ---------------------------------------------------------------------------
// Field indexes
// ---------------------------------------------------------------------------

/// Inverted index over one field: the rows holding it, and for an enumerable field the
/// member ids of each canonical value. Carries its own shape so a lookup needs no second
/// trip to the field registry, and so an `extra` field is indexed on exactly the same
/// terms as a builtin.
pub struct FieldIndex {
    pub shape: IndexShape,
    /// Rows holding a value for the field.
    pub rows: RoaringBitmap,
    pub by_value: HashMap<String, RoaringBitmap>,
}

/// Inverted indexes by field. Built from the base batch; [`resolve`] folds the overlay in
/// at query time, so an edit never invalidates one.
pub type FieldIndexes = HashMap<String, FieldIndex>;

/// Canonical index key for a scalar value. Numbers render through `f64` so a value written
/// as `1` and one arriving as `1.0` land in the same bucket, matching `same_field_value`.
pub fn index_key(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Number(n) => n.as_f64().map(|f| f.to_string()),
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Null | serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            None
        }
    }
}

/// The keys one row contributes to a field's index, per the field type's [`IndexShape`].
pub fn index_keys(shape: IndexShape, v: &serde_json::Value) -> Vec<String> {
    match (shape, v) {
        (IndexShape::Scalar, v) => index_key(v).into_iter().collect(),
        (IndexShape::Multi, serde_json::Value::Array(a)) => {
            a.iter().filter_map(index_key).collect()
        }
        _ => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// LocView: unified view over Arrow batch + overlay
// ---------------------------------------------------------------------------

/// Unified read-only view over Arrow batch + overlay (dead, patches, adds).
/// Caches column downcast refs on construction to avoid repeated downcasts. Only
/// references, so a copy costs nothing.
#[derive(Clone, Copy)]
pub struct LocView<'a> {
    batch: Option<&'a RecordBatch>,
    dead: &'a RoaringBitmap,
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
    /// Optional per-field inverted indexes. When one covers the filtered field and the
    /// operator is a lookup, a `Filter` leaf resolves by cloning postings instead of
    /// scanning every row.
    field_indexes: Option<&'a FieldIndexes>,
}

/// One alive location yielded by [`Scope::rows`]. Provides uniform field
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
    #[allow(
        dead_code,
        reason = "completes the lat/lng/heading/pitch/zoom accessor set"
    )]
    pub fn heading(&self) -> f64 {
        match &self.inner {
            RowInner::Base(v, i) => v.headings.unwrap().value(*i),
            RowInner::Loc(l) => l.heading,
        }
    }
    #[inline]
    #[allow(
        dead_code,
        reason = "completes the lat/lng/heading/pitch/zoom accessor set"
    )]
    pub fn pitch(&self) -> f64 {
        match &self.inner {
            RowInner::Base(v, i) => v.pitches.unwrap().value(*i),
            RowInner::Loc(l) => l.pitch,
        }
    }
    #[inline]
    #[allow(
        dead_code,
        reason = "completes the lat/lng/heading/pitch/zoom accessor set"
    )]
    pub fn zoom(&self) -> f64 {
        match &self.inner {
            RowInner::Base(v, i) => v.zooms.unwrap().value(*i),
            RowInner::Loc(l) => l.zoom,
        }
    }
    #[inline]
    #[allow(dead_code, reason = "is_pinned's read; kept beside it")]
    pub fn flags(&self) -> LocationFlags {
        match &self.inner {
            RowInner::Base(v, i) => LocationFlags::from_bits_retain(v.flags.unwrap().value(*i)),
            RowInner::Loc(l) => l.flags,
        }
    }
    /// Pinned: the row always opens one exact pano. The named form of the predicate
    /// [`Selector::pano_ids`] expresses as a query.
    #[allow(
        dead_code,
        reason = "exercised by tests; queries go through Selector::pano_ids"
    )]
    pub fn is_pinned(&self) -> bool {
        if !self.flags().contains(LocationFlags::LOAD_AS_PANO_ID) {
            return false;
        }
        match &self.inner {
            RowInner::Base(v, i) => {
                let ids = v.pano_ids.unwrap();
                !ids.is_null(*i) && !ids.value(*i).is_empty()
            }
            RowInner::Loc(l) => l.pano_id.as_deref().is_some_and(|p| !p.is_empty()),
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
    /// Hand `f` each of `fields` this row holds, by position, with its value. Built-in
    /// fields read their columns; every other field comes from one walk of the row's
    /// extras that stops once all of them are found. A null value is not held.
    pub fn resolve_fields(&self, fields: &[&str], mut f: impl FnMut(usize, serde_json::Value)) {
        let mut wanted = 0;
        for (i, field) in fields.iter().enumerate() {
            if !is_builtin_field(field) {
                wanted += 1;
                continue;
            }
            let v = match &self.inner {
                RowInner::Base(v, row) => resolve_field_arrow(v, *row, field),
                RowInner::Loc(l) => resolve_field_loc(l, field),
            };
            if let Some(v) = v {
                f(i, v);
            }
        }
        if wanted == 0 {
            return;
        }
        let mut found = 0;
        let mut member = |key: &str, raw: &str| {
            for (i, field) in fields.iter().enumerate() {
                if *field != key || is_builtin_field(field) {
                    continue;
                }
                found += 1;
                match serde_json::from_str::<serde_json::Value>(raw) {
                    Ok(v) if !v.is_null() => f(i, v),
                    _ => {}
                }
            }
            found == wanted
        };
        match &self.inner {
            RowInner::Loc(l) => {
                if let Some(extra) = l.extra.as_ref() {
                    extra.for_each_field(|key, raw| {
                        member(key, raw);
                    });
                }
            }
            RowInner::Base(v, i) => {
                let Some(extras) = v.extras else { return };
                if extras.is_null(*i) {
                    return;
                }
                let s = extras.value(*i);
                types::scan_fields(s.as_bytes(), |fs| {
                    member(
                        &types::decode_json_key(&s[fs.key.clone()]),
                        &s[fs.value.clone()],
                    )
                });
            }
        }
    }
    pub fn resolve_field(&self, field: &str) -> Option<serde_json::Value> {
        let mut value = None;
        self.resolve_fields(&[field], |_, v| value = Some(v));
        value
    }
    /// `field` and the row's `timezone`, which a local-time date test reads together.
    pub fn resolve_field_and_tz(&self, field: &str) -> (Option<serde_json::Value>, Option<String>) {
        let (mut value, mut tz) = (None, None);
        self.resolve_fields(&[field, "timezone"], |i, v| match i {
            0 => value = Some(v),
            _ => tz = v.as_str().map(str::to_owned),
        });
        (value, tz)
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
        dead: &'a RoaringBitmap,
        patches: &'a HashMap<u32, Location>,
        adds: &'a [Location],
        field_indexes: Option<&'a FieldIndexes>,
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
            field_indexes,
        }
    }

    /// Read the raw batch ID at row `i` (no overlay check).
    fn batch_id(&self, i: usize) -> u32 {
        self.ids.unwrap().value(i)
    }

    /// Whether batch row `i` is alive (not in the dead set).
    #[inline]
    fn is_alive(&self, i: usize) -> bool {
        !self.has_dead || !self.dead.contains(self.batch_id(i))
    }

    #[inline]
    fn patch_at(&self, i: usize) -> Option<&'a Location> {
        if !self.has_patches {
            return None;
        }
        self.patches.get(&self.batch_id(i))
    }

    /// Read the effective ID at batch row `i`, checking patches first.
    fn id_at(&self, i: usize) -> u32 {
        if self.has_patches {
            if let Some(p) = self.patches.get(&self.batch_id(i)) {
                return p.id;
            }
        }
        self.batch_id(i)
    }

    fn loc_at(&self, i: usize) -> Location {
        arrow::row_to_location(self.batch.unwrap(), i)
    }

    /// Every alive row, in view order: batch rows, then overlay adds.
    fn alive(&self) -> impl Iterator<Item = RowRef<'a, '_>> {
        (0..self.batch_rows)
            .filter(move |&i| self.is_alive(i))
            .map(move |i| self.row(i))
            .chain(self.adds.iter().map(RowRef::from_loc))
    }

    /// Batch row `i` as it reads now: its patch when it has one, else the base row.
    fn row(&self, i: usize) -> RowRef<'a, '_> {
        match self.patch_at(i) {
            Some(p) => RowRef::from_loc(p),
            None => RowRef {
                inner: RowInner::Base(self, i),
            },
        }
    }

    /// Every alive row.
    pub fn all<'v>(&self) -> Scope<'v, 'a> {
        Scope {
            view: *self,
            rows: None,
        }
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
        Selector::Uncommitted => r.is_uncommitted(),
        Selector::Polygon { polygon } => point_in_geometry(r.lng(), r.lat(), polygon),
        Selector::Filter { field, test } => {
            if test.tz_local() {
                return compare_filter_local_tz(r, field, test);
            }
            match r.resolve_field(field) {
                Some(ref v) => compare_filter(v, test),
                None => matches!(test, FilterOp::Nothas),
            }
        }
        _ => false,
    }
}

/// Minimum rayon chunk size for parallel batch iteration. Tuned to amortize
/// per-chunk overhead while keeping cache-friendly access patterns.
const CHUNK_SIZE: usize = 64 * 1024;

/// The three ways a scope walks its rows, chosen once by [`Scope::rows`]: every alive row,
/// a dense pass filtered to the set, or a seek by each id in a sparse set.
enum Walk<A, D, S> {
    All(A),
    Dense(D),
    Seek(S),
}

impl<T, A, D, S> Iterator for Walk<A, D, S>
where
    A: Iterator<Item = T>,
    D: Iterator<Item = T>,
    S: Iterator<Item = T>,
{
    type Item = T;
    fn next(&mut self) -> Option<T> {
        match self {
            Walk::All(rows) => rows.next(),
            Walk::Dense(rows) => rows.next(),
            Walk::Seek(rows) => rows.next(),
        }
    }
}

/// The rows a query ranges over: every alive row, or the alive rows of one set. The only
/// place "the whole map or these rows" is said; everything that walks, tests or resolves
/// rows does it through one.
#[derive(Clone)]
pub struct Scope<'v, 'a> {
    view: LocView<'a>,
    rows: Option<Cow<'v, RoaringBitmap>>,
}

impl<'v, 'a> Scope<'v, 'a> {
    /// The rows in scope, in view order: batch rows, then overlay adds. A set small enough
    /// that seeking each id beats one sequential pass is walked by id.
    pub fn rows(&self) -> impl Iterator<Item = RowRef<'a, '_>> + '_ {
        let view = &self.view;
        let Some(set) = self.rows.as_deref() else {
            return Walk::All(view.alive());
        };
        let physical = view.batch_rows + view.adds.len();
        let seek_steps = view.batch_rows.checked_ilog2().unwrap_or(0)
            + view.adds.len().checked_ilog2().unwrap_or(0)
            + 2;
        if set.len().saturating_mul(u64::from(seek_steps)) >= physical as u64 {
            return Walk::Dense(view.alive().filter(move |r| set.contains(r.id())));
        }
        let base = set.iter().filter_map(move |id| {
            let i = arrow::batch_row_for_id(view.batch?, id)?;
            view.is_alive(i).then(|| view.row(i))
        });
        let adds = set.iter().filter_map(move |id| {
            let i = view.adds.binary_search_by_key(&id, |loc| loc.id).ok()?;
            Some(RowRef::from_loc(&view.adds[i]))
        });
        Walk::Seek(base.chain(adds))
    }

    /// The ids in scope.
    pub fn ids(&self) -> RoaringBitmap {
        self.rows().map(|r| r.id()).collect()
    }

    /// Whether the scope holds no rows at all.
    pub fn is_empty(&self) -> bool {
        self.rows.as_deref().is_some_and(RoaringBitmap::is_empty)
    }

    /// The rows of `set` that are in scope.
    fn clip(&self, set: RoaringBitmap) -> RoaringBitmap {
        match self.rows.as_deref() {
            Some(rows) => set & rows,
            None => set,
        }
    }

    /// The rows in scope `test` keeps. Over the whole map the batch is tested in parallel.
    pub fn keep(&self, test: impl Fn(&RowRef) -> bool + Sync + Send) -> RoaringBitmap {
        if self.rows.is_some() {
            return self.rows().filter(|r| test(r)).map(|r| r.id()).collect();
        }
        let view = &self.view;
        let base: Vec<u32> = (0..view.batch_rows)
            .into_par_iter()
            .with_min_len(CHUNK_SIZE)
            .filter_map(|i| {
                let row = view.is_alive(i).then(|| view.row(i))?;
                test(&row).then(|| row.id())
            })
            .collect();
        let adds = view.adds.iter().filter(|loc| test(&RowRef::from_loc(loc)));
        base.into_iter().chain(adds.map(|loc| loc.id)).collect()
    }

    /// The rows of `set` in this scope.
    pub fn within<'s>(&self, set: &'s RoaringBitmap) -> Scope<'s, 'a> {
        Scope {
            view: self.view,
            rows: Some(match self.rows.as_deref() {
                None => Cow::Borrowed(set),
                Some(rows) => Cow::Owned(rows & set),
            }),
        }
    }

    /// Every selection's rows and every node's count, keyed by `Selection.key`, resolved
    /// in this scope without narrowing: a child's count is its full count.
    pub fn resolve_forest(&self, sels: &[Selection]) -> (Vec<RoaringBitmap>, HashMap<String, u32>) {
        fn walk(all: &Scope, sel: &Selection, counts: &mut HashMap<String, u32>) -> RoaringBitmap {
            let set = match &sel.selector {
                Selector::Intersection { selections } => {
                    // No empty short-circuit: children's counts are reported regardless,
                    // so they must resolve either way.
                    let mut acc: Option<RoaringBitmap> = None;
                    for c in selections {
                        let child = walk(all, c, counts);
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
                        acc |= walk(all, c, counts);
                    }
                    acc
                }
                Selector::Invert { selections } => {
                    let mut children = selections.iter();
                    let set = match children.next() {
                        Some(first) => all.ids() - walk(all, first, counts),
                        None => all.ids(),
                    };
                    // Invert is unary: extra children don't affect the set but their
                    // counts are still reported, matching resolve semantics.
                    for c in children {
                        walk(all, c, counts);
                    }
                    set
                }
                _ => all.resolve(&sel.selector),
            };
            counts.insert(sel.key.clone(), set.len() as u32);
            set
        }
        let mut counts = HashMap::new();
        let sets = sels.iter().map(|s| walk(self, s, &mut counts)).collect();
        (sets, counts)
    }

    /// A narrower scope: the rows here `selector` keeps. `Everything` keeps this scope.
    pub fn narrow(&self, selector: &Selector) -> Scope<'v, 'a> {
        match selector {
            Selector::Everything => self.clone(),
            _ => Scope {
                view: self.view,
                rows: Some(Cow::Owned(self.resolve(selector))),
            },
        }
    }

    /// The rows here `selector` keeps. Composites combine their children's sets, and an
    /// intersection narrows the scope child by child, so `page AND has(field)` costs the
    /// page, not the map. Duplicates and top-k depend on rows outside the scope, so they
    /// resolve over the whole map and are clipped to it.
    pub fn resolve(&self, selector: &Selector) -> RoaringBitmap {
        match selector {
            Selector::Everything => self.ids(),
            Selector::Intersection { selections } => {
                if selections.is_empty() {
                    return RoaringBitmap::new();
                }
                let mut scope = self.clone();
                for s in selections {
                    if scope.is_empty() {
                        break;
                    }
                    scope = scope.narrow(&s.selector);
                }
                scope.ids()
            }
            Selector::Union { selections } => {
                selections.iter().fold(RoaringBitmap::new(), |acc, s| {
                    acc | self.resolve(&s.selector)
                })
            }
            Selector::Invert { selections } => match selections.first() {
                Some(first) => self.ids() - self.resolve(&first.selector),
                None => self.ids(),
            },
            Selector::Locations { locations, .. }
            | Selector::Manual { locations }
            | Selector::ValidationState { locations, .. }
            | Selector::Reviewed { locations, .. } => {
                let ids: RoaringBitmap = locations.iter().copied().collect();
                self.within(&ids).ids()
            }
            Selector::Filter { field, test } => self
                .indexed(field, test)
                .unwrap_or_else(|| self.keep(|r| test_row(r, selector))),
            Selector::Polygon { polygon } => match geometry_bbox(polygon) {
                None => RoaringBitmap::new(),
                Some(bb) => {
                    let prepared = polygon.prepared();
                    self.keep(|r| {
                        in_bbox(r.lng(), r.lat(), &bb) && prepared.contains(r.lng(), r.lat())
                    })
                }
            },
            Selector::Duplicates { distance } => self.clip(duplicates(&self.view, *distance)),
            Selector::Ranked {
                selection,
                expr,
                k,
                ascending,
            } => {
                let all = self.view.all();
                let pool = match selection {
                    Some(child) => all.narrow(&child.selector),
                    None => all,
                };
                let Some(k) = k else {
                    return self.clip(pool.ids());
                };
                self.clip(
                    pool.ranked(expr, Some(*k as usize), *ascending)
                        .into_iter()
                        .collect(),
                )
            }
            _ => self.keep(|r| test_row(r, selector)),
        }
    }

    /// A filter's rows answered from its field's index: existence from the rows holding
    /// the field, equality on a scalar and membership in a list from the postings. Every
    /// row move updates the index beside the mutation, so the set is already the answer.
    /// `None` when the field has no index or the operator is not a lookup and needs a scan.
    fn indexed(&self, field: &str, test: &FilterOp) -> Option<RoaringBitmap> {
        let index = self.view.field_indexes?.get(field)?;
        Some(match (index.shape, test) {
            (_, FilterOp::Has) => self.clip(index.rows.clone()),
            (_, FilterOp::Nothas) => self.ids() - &index.rows,
            (IndexShape::Scalar, FilterOp::Eq { value })
            | (IndexShape::Multi, FilterOp::Contains { value }) => {
                let key = index_key(value)?;
                self.clip(index.by_value.get(&key).cloned().unwrap_or_default())
            }
            _ => return None,
        })
    }

    /// One value per row in scope for each of `fields`, in view order, `Null` where the
    /// row lacks it; `"tags"` yields the row's tag ids.
    pub fn columns(&self, fields: &[String]) -> Vec<Vec<serde_json::Value>> {
        let mut out: Vec<Vec<serde_json::Value>> = fields.iter().map(|_| Vec::new()).collect();
        for row in self.rows() {
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

    /// Ids in scope best-ranked first: highest score, or lowest when `ascending`. A row
    /// the expression cannot evaluate ranks below every row it can, whichever direction
    /// is asked for. The sort is stable, so ties keep view order. `k` cuts to the best k
    /// first, which costs a selection rather than a full sort.
    pub fn ranked(&self, expr: &str, k: Option<usize>, ascending: bool) -> Vec<u32> {
        let expr = field_expr::parse(expr).ok();
        let mut scored: Vec<(u32, Option<f64>)> = self
            .rows()
            .map(|row| {
                let score = expr
                    .as_ref()
                    .and_then(|e| field_expr::eval(e, &|name| row.resolve_field(name)));
                (row.id(), score)
            })
            .collect();
        // eval never yields NaN, so partial_cmp is total.
        let better = |a: &(u32, Option<f64>), b: &(u32, Option<f64>)| match (a.1, b.1) {
            (Some(x), Some(y)) => {
                let c = x.partial_cmp(&y).unwrap_or(Ordering::Equal);
                if ascending {
                    c
                } else {
                    c.reverse()
                }
            }
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        };
        if let Some(k) = k {
            if k == 0 {
                return Vec::new();
            }
            if k < scored.len() {
                scored.select_nth_unstable_by(k - 1, better);
                scored.truncate(k);
            }
        }
        scored.sort_by(better);
        scored.into_iter().map(|(id, _)| id).collect()
    }

    /// `n` distinct ids in scope drawn uniformly at random. Partial Fisher-Yates, so drawing
    /// 5 from a million swaps 5 entries rather than shuffling the pool.
    pub fn sample(&self, n: usize) -> Vec<u32> {
        let mut ids: Vec<u32> = self.rows().map(|r| r.id()).collect();
        let k = n.min(ids.len());
        for i in 0..k {
            let j = i + fastrand::usize(..ids.len() - i);
            ids.swap(i, j);
        }
        ids.truncate(k);
        ids
    }

    /// Distinct values of `field` in scope, sorted. Scalars stringify so they match the
    /// string-typed options they populate; null and containers are skipped.
    pub fn distinct_values(&self, field: &str) -> Vec<String> {
        let mut seen = BTreeSet::new();
        for row in self.rows() {
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
}

/// Every alive row within `distance` metres of another, over the whole map.
fn duplicates(view: &LocView, distance: f64) -> RoaringBitmap {
    let mut mask = vec![false; view.batch_rows + view.adds.len()];
    find_duplicates_bitmask(view, distance, &mut mask);
    let base = (0..view.batch_rows)
        .filter(|&i| mask[i] && view.is_alive(i))
        .map(|i| view.id_at(i));
    let adds = view
        .adds
        .iter()
        .enumerate()
        .filter(|(j, _)| mask[view.batch_rows + j])
        .map(|(_, l)| l.id);
    base.chain(adds).collect()
}

#[cfg(test)]
#[path = "selections.test.rs"]
mod tests;
