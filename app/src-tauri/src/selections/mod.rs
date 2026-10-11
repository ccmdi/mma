//! Selection resolution engine.
//!
//! Selections are predicates over the location set (tag membership, polygon containment,
//! duplicates, filters on arbitrary fields, etc.). Each resolves to an id set over the
//! unified `LocView` (batch + overlay); composites (Intersection, Union, Invert) combine
//! their children's sets.

pub(crate) mod field_expr;
pub(crate) mod saved;

use crate::store::arrow::{Column, Columns};
use crate::store::engine::{pick_even, pick_spaced, SpacedPickResult, SPATIAL_CELL_M};
use crate::store::maps::IndexShape;
use crate::types;
use crate::types::{Location, LocationFlags, RawExtra};
use crate::util::Rgb;
use arrow_array::RecordBatch;
use mma_algebra::{rank_by, Change, Keyed};
use mma_fields::Children;

mod duplicates;
mod filter;
mod geometry;
pub(crate) mod neighborhood;
mod partition;
pub(crate) mod tree;
pub use duplicates::*;
pub use filter::*;
pub(crate) use geometry::*;
use mma_geo::SpatialIndex;
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
use std::collections::BTreeSet;
use std::collections::HashMap;

/// Selection predicates and composites, serialized with a `type` discriminator.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type, Children)]
#[serde(tag = "type")]
pub enum Selector<S = Selection> {
    Locations {
        locations: Vec<u32>,
        name: Option<String>,
    },
    Everything,
    /// The locations currently selected in the editor.
    Selected,
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
    Validation {
        locations: Vec<u32>,
        category: String,
    },
    #[serde(rename_all = "camelCase")]
    Reviewed {
        locations: Vec<u32>,
        session_id: String,
        mode: String,
    },
    Intersection {
        #[children]
        selections: Vec<S>,
    },
    Union {
        #[children]
        selections: Vec<S>,
    },
    Invert {
        #[children]
        selections: Vec<S>,
    },
    Filter {
        field: String,
        test: FilterOp,
    },
    /// Rank by a field expression, optionally keeping only the first `k`.
    /// Unscorable rows rank last; without `k`, all child rows are kept.
    #[serde(rename_all = "camelCase")]
    Ranked {
        /// What to rank; `null` ranks the whole map.
        #[children]
        selection: Option<Box<S>>,
        expr: String,
        k: Option<u32>,
        ascending: bool,
    },
    /// `n` rows of a selection drawn uniformly at random, without replacement.
    Sample {
        /// What to draw from; `null` draws from the whole map.
        #[children]
        selection: Option<Box<S>>,
        n: u32,
    },
    /// A selection thinned to a spread-out subset.
    #[serde(rename_all = "camelCase")]
    Spaced {
        /// What to thin; `null` thins the whole map.
        #[children]
        selection: Option<Box<S>>,
        thin: Thinning,
    },
    /// A selection thinned on a honeycomb, never two picks closer than half the spacing.
    #[serde(rename_all = "camelCase")]
    EvenlySpaced {
        /// What to thin; `null` thins the whole map.
        #[children]
        selection: Option<Box<S>>,
        thin: Thinning,
    },
    /// The rows of a selection within `radiusM` metres of a coordinate.
    #[serde(rename_all = "camelCase")]
    Nearby {
        /// Where to look; `null` looks over the whole map.
        #[children]
        selection: Option<Box<S>>,
        lat: f64,
        lng: f64,
        radius_m: f64,
    },
    /// The row of a selection closest to a coordinate.
    Nearest {
        /// Where to look; `null` looks over the whole map.
        #[children]
        selection: Option<Box<S>>,
        lat: f64,
        lng: f64,
    },
}

/// Limit a spaced pick by count or minimum spacing.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "by", rename_all = "camelCase")]
pub enum Thinning {
    /// At most `n` rows.
    Count { n: u32 },
    /// Rows about `m` metres apart.
    Metres { m: f64 },
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
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PolygonGeometry {
    pub coordinates: Vec<Vec<[f64; 2]>>,
    pub extra_polygons: Option<Vec<Vec<Vec<[f64; 2]>>>>,
    #[serde(default)]
    #[specta(type = Option<specta_typescript::Any>)]
    pub properties: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub key: String,
    pub color: Rgb,
    pub selector: Selector,
}

impl<'de> Deserialize<'de> for Selection {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        tree::SelectionInput::deserialize(deserializer).map(tree::SelectionInput::compile)
    }
}

impl Selection {
    /// A selection nobody displays, for code composing a query. The key is derived from
    /// the selector so equal queries share it.
    pub fn of(selector: Selector) -> Self {
        let key = tree::key(&selector);
        Selection {
            color: tree::color(&key),
            key,
            selector,
        }
    }
    pub fn fold<T>(&self, combine: &mut impl FnMut(&Selection, Vec<T>) -> T) -> T {
        let children = self
            .selector
            .children()
            .into_iter()
            .map(|child| child.fold(combine))
            .collect();
        combine(self, children)
    }

    pub fn mapped(&self, edit: &impl Fn(Selector) -> Selector) -> Self {
        self.fold(&mut |node, children| {
            let mut next = Selection::of(edit(node.selector.with_children_ref(children)));
            next.color = node.color;
            next
        })
    }

    pub fn filter_map(&self, edit: &impl Fn(&Selector) -> Option<Selector>) -> Option<Self> {
        let selector = edit(&self.selector)?;
        let children = selector.children();
        if children.is_empty() {
            return Some(self.rebuilt(selector));
        }
        let children: Vec<_> = children
            .into_iter()
            .filter_map(|child| child.filter_map(edit))
            .collect();
        if children.is_empty() {
            return None;
        }
        crate::selections::tree::rebuilt(
            &Selection {
                selector,
                ..self.clone()
            },
            children,
        )
        .into_iter()
        .next()
    }

    pub fn rebuilt(&self, selector: Selector) -> Self {
        if selector == self.selector {
            return self.clone();
        }
        let mut next = Selection::of(selector);
        if next.key == self.key {
            next.color = self.color;
        }
        next
    }

    fn named_value_color(&self, color: &impl Fn(&str, u32) -> Option<Rgb>) -> Rgb {
        let inner = match &self.selector {
            Selector::Invert { selections } => selections.first().unwrap_or(self),
            _ => self,
        };
        inner
            .selector
            .member_test()
            .and_then(|(field, id)| color(field, id))
            .unwrap_or(self.color)
    }

    /// Use the named value's colour for membership nodes when available.
    pub fn recolored(&self, color: &impl Fn(&str, u32) -> Option<Rgb>) -> Self {
        self.fold(&mut |node, children| Self {
            key: node.key.clone(),
            color: node.named_value_color(color),
            selector: node.selector.with_children_ref(children),
        })
    }
}

pub(crate) enum Index {
    Presence(String),
    Values(String),
    Spatial,
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

    pub fn walk(&self, visit: &mut impl FnMut(&Selector)) {
        visit(self);
        for child in self.children() {
            child.selector.walk(visit);
        }
    }

    pub(crate) fn indexes(&self) -> Vec<Index> {
        let mut indexes = Vec::new();
        self.walk(&mut |selector| match selector {
            Self::Filter {
                field,
                test: FilterOp::Has | FilterOp::Nothas,
            } => indexes.push(Index::Presence(field.clone())),
            Self::Filter { field, .. } => indexes.push(Index::Values(field.clone())),
            Self::Nearby { .. } | Self::Nearest { .. } => indexes.push(Index::Spatial),
            _ => {}
        });
        indexes
    }

    pub fn row_local(&self) -> bool {
        match self {
            Self::Everything
            | Self::Locations { .. }
            | Self::Manual { .. }
            | Self::Validation { .. }
            | Self::Reviewed { .. }
            | Self::Polygon { .. }
            | Self::Filter { .. } => true,
            Self::Intersection { .. }
            | Self::Union { .. }
            | Self::Invert { .. }
            | Self::Nearby { .. }
            | Self::Ranked { k: None, .. } => self
                .children()
                .iter()
                .all(|child| child.selector.row_local()),
            Self::Selected
            | Self::Uncommitted
            | Self::Duplicates { .. }
            | Self::Ranked { k: Some(_), .. }
            | Self::Sample { .. }
            | Self::Spaced { .. }
            | Self::EvenlySpaced { .. }
            | Self::Nearest { .. } => false,
        }
    }

    /// The field and value of a list-membership test, if this is one.
    pub fn member_test(&self) -> Option<(&str, u32)> {
        match self {
            Selector::Filter {
                field,
                test: FilterOp::Contains { value },
            } => Some((field, u32::try_from(value.as_u64()?).ok()?)),
            _ => None,
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

impl FieldIndex {
    fn contribution(&self, value: Option<&serde_json::Value>) -> Option<Vec<String>> {
        value.map(|value| {
            let mut keys = index_keys(self.shape, value);
            keys.sort();
            keys.dedup();
            keys
        })
    }

    fn mark(&mut self, id: u32, keys: &Option<Vec<String>>, present: bool) {
        let Some(keys) = keys else {
            return;
        };
        let mark = |ids: &mut RoaringBitmap| {
            if present {
                ids.insert(id);
            } else {
                ids.remove(id);
            }
        };
        mark(&mut self.rows);
        for key in keys {
            mark(self.by_value.entry(key.clone()).or_default());
        }
    }

    pub fn insert(&mut self, id: u32, value: &serde_json::Value) {
        let keys = self.contribution(Some(value));
        self.mark(id, &keys, true);
    }

    pub fn project<T: Keyed<Key = u32>>(
        &self,
        change: &Change<T>,
        value: impl Fn(&T) -> Option<serde_json::Value>,
    ) -> Change<(u32, Option<Vec<String>>)> {
        change.project(|row| (row.key(), self.contribution(value(row).as_ref())))
    }

    pub fn apply(&mut self, change: &Change<(u32, Option<Vec<String>>)>) -> BTreeSet<String> {
        let mut moved = BTreeSet::new();
        for (rows, present) in [
            (change.before().collect::<Vec<_>>(), false),
            (change.after().collect(), true),
        ] {
            for (id, keys) in rows {
                self.mark(*id, keys, present);
                moved.extend(keys.iter().flatten().cloned());
            }
        }
        moved
    }

    pub fn absent_after(
        &self,
        change: &Change<(u32, Option<Vec<String>>)>,
        touched: impl IntoIterator<Item = String>,
    ) -> std::collections::HashSet<String> {
        let mut counts =
            change.count_by(|(_, keys)| keys.iter().flatten().cloned().collect::<Vec<_>>());
        for key in touched {
            counts.entry(key).or_default();
        }
        counts
            .into_iter()
            .filter_map(|(key, delta)| {
                let count = self.by_value.get(&key).map_or(0, |ids| ids.len() as i64);
                (count + delta <= 0).then_some(key)
            })
            .collect()
    }
}

/// Per-field indexes of live rows, maintained as rows change.
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
    dead: &'a RoaringBitmap,
    patches: &'a HashMap<u32, Location>,
    adds: &'a [Location],
    /// The base batch's columns, downcast once.
    cols: Option<Columns<'a>>,
    /// Optional per-field inverted indexes. When one covers the filtered field and the
    /// operator is a lookup, a `Filter` leaf resolves by cloning postings instead of
    /// scanning every row.
    field_indexes: Option<&'a FieldIndexes>,
    /// The synced selected-id set, which a `Selected` leaf borrows instead of
    /// re-resolving the live selection tree.
    selected: Option<&'a RoaringBitmap>,
    /// The store's spatial index, when built: the candidates a distance node tests.
    spatial: Option<&'a SpatialIndex>,
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
    /// Hand `f` each of `fields` this row holds, by position, with its value. Built-in
    /// fields read their columns; every other field comes from one walk of the row's
    /// extras that stops once all of them are found. A null value is not held.
    pub fn resolve_fields(&self, fields: &[&str], mut f: impl FnMut(usize, serde_json::Value)) {
        let mut wanted = 0;
        for (i, field) in fields.iter().enumerate() {
            match builtin_value(self, field) {
                Some(Some(v)) => f(i, v),
                Some(None) => {}
                None => wanted += 1,
            }
        }
        if wanted == 0 {
            return;
        }
        let mut found = 0;
        let mut member = |key: &str, raw: &str| {
            for (i, field) in fields.iter().enumerate() {
                if *field != key || builtin_value(self, field).is_some() {
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
        let Some(extra) = self.extra().0 else {
            return;
        };
        types::scan_fields(extra.as_bytes(), |fs| {
            member(
                &types::decode_json_key(&extra[fs.key.clone()]),
                &extra[fs.value.clone()],
            )
        });
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
            RowInner::Base(v, i) => v.cols.unwrap().location(*i),
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

// One typed reader per `Location` field (`#[derive(Fields)]`): the column's value in
// place on a base row, the field on an overlay row.
macro_rules! row_readers {
    ($({ $idx:literal, $f:ident, $ty:ty }),* $(,)?) => {
        #[allow(dead_code, reason = "one reader per column, generated whether or not it is called")]
        impl<'a, 'v> RowRef<'a, 'v> {
            $(
                #[inline]
                pub fn $f(&self) -> <$ty as Column>::Cell<'_> {
                    match &self.inner {
                        RowInner::Base(v, i) => <$ty as Column>::cell_at(v.cols.unwrap().$f, *i),
                        RowInner::Loc(l) => l.$f.cell(),
                    }
                }
            )*
        }
    };
}

crate::types::location_columns!(row_readers);

impl<'a> LocView<'a> {
    pub(crate) fn select<'v>(&self, selector: &Selector) -> Scope<'v, 'a> {
        self.all().narrow(selector)
    }

    /// Resolve selection memberships and per-node counts. Child counts are independent of their parents.
    pub fn resolve_forest(&self, sels: &[Selection]) -> (Vec<RoaringBitmap>, HashMap<String, u32>) {
        let scope = self.all();
        let mut counts = HashMap::new();
        let sets = sels
            .iter()
            .map(|selection| {
                selection.fold(&mut |node, children: Vec<RoaringBitmap>| {
                    let set = match &node.selector {
                        Selector::Intersection { .. } => children
                            .into_iter()
                            .reduce(|left, right| left & right)
                            .unwrap_or_default(),
                        Selector::Union { .. } => children
                            .into_iter()
                            .fold(RoaringBitmap::new(), |left, right| left | right),
                        Selector::Invert { .. } => match children.into_iter().next() {
                            Some(first) => scope.ids() - first,
                            None => scope.ids(),
                        },
                        _ => scope.resolve(&node.selector),
                    };
                    counts.insert(node.key.clone(), set.len() as u32);
                    set
                })
            })
            .collect();
        (sets, counts)
    }

    pub(crate) fn indexed(
        mut self,
        fields: &'a FieldIndexes,
        spatial: Option<&'a SpatialIndex>,
    ) -> Self {
        self.field_indexes = Some(fields);
        self.spatial = spatial;
        self
    }

    pub fn new(
        batch: Option<&'a RecordBatch>,
        dead: &'a RoaringBitmap,
        patches: &'a HashMap<u32, Location>,
        adds: &'a [Location],
        field_indexes: Option<&'a FieldIndexes>,
        selected: Option<&'a RoaringBitmap>,
        spatial: Option<&'a SpatialIndex>,
    ) -> Self {
        Self {
            dead,
            patches,
            adds,
            cols: batch.map(Columns::of),
            field_indexes,
            selected,
            spatial,
        }
    }

    /// How many rows the base batch holds, dead ones included.
    fn batch_rows(&self) -> usize {
        self.cols.map_or(0, |c| c.id.len())
    }

    /// Read the raw batch ID at row `i` (no overlay check).
    fn batch_id(&self, i: usize) -> u32 {
        self.cols.unwrap().id.value(i)
    }

    /// Whether batch row `i` is alive (not in the dead set).
    #[inline]
    fn is_alive(&self, i: usize) -> bool {
        !self.dead.contains(self.batch_id(i))
    }

    #[inline]
    fn patch_at(&self, i: usize) -> Option<&'a Location> {
        self.patches.get(&self.batch_id(i))
    }

    /// Every alive row, in view order: batch rows, then overlay adds.
    fn alive(&self) -> impl Iterator<Item = RowRef<'a, '_>> {
        (0..self.batch_rows())
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

    pub fn get(&self, id: u32) -> Option<RowRef<'a, '_>> {
        if self.dead.contains(id) {
            return None;
        }
        if let Some(row) = self.patches.get(&id) {
            return Some(RowRef::from_loc(row));
        }
        if let Ok(i) = self.adds.binary_search_by_key(&id, |row| row.id) {
            return Some(RowRef::from_loc(&self.adds[i]));
        }
        Some(self.row(self.cols?.row_of(id)?))
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
        | Selector::Validation { locations, .. }
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
        Selector::Intersection { selections } => {
            !selections.is_empty() && selections.iter().all(|child| test_row(r, &child.selector))
        }
        Selector::Union { selections } => {
            selections.iter().any(|child| test_row(r, &child.selector))
        }
        Selector::Invert { selections } => selections
            .first()
            .is_none_or(|child| !test_row(r, &child.selector)),
        Selector::Ranked {
            selection, k: None, ..
        } => selection
            .as_ref()
            .is_none_or(|child| test_row(r, &child.selector)),
        Selector::Nearby {
            selection,
            lat,
            lng,
            radius_m,
        } => {
            selection
                .as_ref()
                .is_none_or(|child| test_row(r, &child.selector))
                && (DistanceTo {
                    lat: *lat,
                    lng: *lng,
                })
                .score(r)
                    <= *radius_m
        }
        _ => false,
    }
}

/// A spaced pick's ids, or none when its thinning is out of range.
fn picked(r: types::AppResult<SpacedPickResult>) -> RoaringBitmap {
    match r {
        Ok(r) => r.ids.into_iter().collect(),
        Err(e) => {
            log::warn!("[selections] {e}");
            RoaringBitmap::new()
        }
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
        let physical = view.batch_rows() + view.adds.len();
        let seek_steps = view.batch_rows().checked_ilog2().unwrap_or(0)
            + view.adds.len().checked_ilog2().unwrap_or(0)
            + 2;
        if set.len().saturating_mul(u64::from(seek_steps)) >= physical as u64 {
            return Walk::Dense(view.alive().filter(move |r| set.contains(r.id())));
        }
        let base = set.iter().filter_map(move |id| {
            view.cols?.row_of(id)?;
            view.get(id)
        });
        let adds = set.iter().filter_map(move |id| {
            view.adds.binary_search_by_key(&id, |row| row.id).ok()?;
            view.get(id)
        });
        Walk::Seek(base.chain(adds))
    }

    pub fn any_within(&self, lat: f64, lng: f64, radius_m: f64) -> bool {
        let distance = DistanceTo { lat, lng };
        let close = |row: RowRef<'_, '_>| distance.score(&row) <= radius_m;
        if let Some(index) = self.view.spatial {
            return index.any_candidate(lat, lng, radius_m, |id| {
                if self.rows.as_deref().is_some_and(|rows| !rows.contains(id)) {
                    return false;
                }
                self.view.get(id).is_some_and(close)
            });
        }
        self.rows().any(close)
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
        let base: Vec<u32> = (0..view.batch_rows())
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

    pub(crate) fn coverage(&self, fields: &[String]) -> Vec<(String, u32)> {
        let mut counts: Vec<_> = fields
            .iter()
            .filter_map(|field| {
                let count = self.resolve(&Selector::has(field)).len() as u32;
                (count > 0).then_some((field.clone(), count))
            })
            .collect();
        counts.sort_by(|a, b| a.0.cmp(&b.0));
        counts
    }

    /// A narrower scope: the rows here `selector` keeps. `Everything` keeps this scope.
    fn narrow(&self, selector: &Selector) -> Scope<'v, 'a> {
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
    fn resolve(&self, selector: &Selector) -> RoaringBitmap {
        match selector {
            Selector::Everything => self.ids(),
            Selector::Selected => match self.view.selected {
                Some(ids) => self.within(ids).ids(),
                None => RoaringBitmap::new(),
            },
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
            | Selector::Validation { locations, .. }
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
                let pool = self.pool(selection);
                let Some(k) = k else {
                    return self.clip(pool.ids());
                };
                self.clip(
                    pool.ranked(expr, Some(*k as usize), *ascending)
                        .into_iter()
                        .collect(),
                )
            }
            Selector::Sample { selection, n } => self.clip(
                self.pool(selection)
                    .sample(*n as usize)
                    .into_iter()
                    .collect(),
            ),
            Selector::Spaced { selection, thin } => {
                self.clip(picked(pick_spaced(self.pool(selection).points(), *thin)))
            }
            Selector::EvenlySpaced { selection, thin } => {
                self.clip(picked(pick_even(&self.pool(selection).points(), *thin)))
            }
            Selector::Nearby {
                selection,
                lat,
                lng,
                radius_m,
            } => self.clip(
                DistanceTo {
                    lat: *lat,
                    lng: *lng,
                }
                .within(&self.pool(selection), *radius_m),
            ),
            Selector::Nearest {
                selection,
                lat,
                lng,
            } => self.clip(
                DistanceTo {
                    lat: *lat,
                    lng: *lng,
                }
                .minimum(&self.pool(selection))
                .into_iter()
                .collect(),
            ),
            _ => self.keep(|r| test_row(r, selector)),
        }
    }

    /// Resolve a set-dependent child over the whole map before clipping to this scope.
    fn pool(&self, selection: &Option<Box<Selection>>) -> Scope<'v, 'a> {
        let all = self.view.all();
        match selection {
            Some(child) => all.narrow(&child.selector),
            None => all,
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
                    serde_json::json!(row.tags())
                } else {
                    row.resolve_field(field).unwrap_or(serde_json::Value::Null)
                });
            }
        }
        out
    }

    pub fn rank_by(
        &self,
        score: impl Fn(&RowRef) -> Option<f64>,
        take: Option<usize>,
        ascending: bool,
    ) -> Vec<u32> {
        rank_by(self.rows(), take, score, |a, b| {
            let order = a.total_cmp(b);
            if ascending {
                order
            } else {
                order.reverse()
            }
        })
        .into_iter()
        .map(|row| row.id())
        .collect()
    }

    pub fn ranked(&self, expr: &str, take: Option<usize>, ascending: bool) -> Vec<u32> {
        let expr = field_expr::parse(expr).ok();
        self.rank_by(
            |row| {
                expr.as_ref()
                    .and_then(|expr| field_expr::eval(expr, &|name| row.resolve_field(name)))
            },
            take,
            ascending,
        )
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
            if let Some(key) = row.resolve_field(field).as_ref().and_then(index_key) {
                if !key.is_empty() {
                    seen.insert(key);
                }
            }
        }
        seen.into_iter().collect()
    }
}

/// Every alive row within `distance` metres of another, over the whole map.
fn duplicates(view: &LocView, distance: f64) -> RoaringBitmap {
    let mut mask = vec![false; view.batch_rows() + view.adds.len()];
    find_duplicates_bitmask(view, distance, &mut mask);
    let base = (0..view.batch_rows())
        .filter(|&i| mask[i] && view.is_alive(i))
        .map(|i| view.batch_id(i));
    let adds = view
        .adds
        .iter()
        .enumerate()
        .filter(|(j, _)| mask[view.batch_rows() + j])
        .map(|(_, l)| l.id);
    base.chain(adds).collect()
}

#[cfg(test)]
#[path = "selections.test.rs"]
mod tests;
