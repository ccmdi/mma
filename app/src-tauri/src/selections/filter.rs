//! Field filters: the built-in field table and value comparison rules.

use super::*;
use crate::store::engine::ValueRecord;
use crate::store::maps::{ComparisonType, FieldDef, FieldType};
use crate::types::{location_fields, AppError, AppResult, Location};
use crate::util::{tz_offset_seconds, unix_to_hour_min, unix_to_month_day};
use mma_algebra::{Edit, Field, Id, JsonWrite, Op, Patch, Patchable};
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::ptr;
use std::sync::OnceLock;

/// How a built-in field may be accessed by the field system.
/// `None` means listable and filterable but read-only.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BuiltinFieldKind {
    /// Composes the location itself. Never writable, never offered in pickers.
    Identity,
    /// Derived, not stored on the location. Never writable.
    Virtual,
    /// Explicitly bulk-editable top-level field.
    Writable,
}

/// Where a built-in field physically lives and how field ops may touch it. Never part of
/// a map's own stored definitions.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Builtin {
    pub kind: Option<BuiltinFieldKind>,
    /// A null in the field's patch empties it.
    pub clearable: bool,
    #[serde(skip)]
    pub optional: bool,
    /// Where a write lands; a derived field has nowhere.
    #[serde(skip)]
    pub address: Option<Address>,
}

/// Where a field's value is written on a row patch.
#[derive(Clone, Copy, Debug)]
pub enum Address {
    Column(fn(&mut Patch<Location>, &serde_json::Value) -> AppResult<()>),
    Flag(LocationFlags),
    Extra,
}

impl PartialEq for Address {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Column(a), Self::Column(b)) => ptr::fn_addr_eq(*a, *b),
            (Self::Flag(a), Self::Flag(b)) => a == b,
            (Self::Extra, Self::Extra) => true,
            _ => false,
        }
    }
}

/// Leave to write one field, granted only when the field takes the write.
#[derive(Clone, Copy)]
pub struct FieldWriter<'k> {
    key: &'k str,
    address: Address,
}

impl<'k> FieldWriter<'k> {
    pub fn key(&self) -> &'k str {
        self.key
    }

    pub fn is_flag(&self) -> bool {
        matches!(self.address, Address::Flag(_))
    }

    pub fn is_extra(&self) -> bool {
        matches!(self.address, Address::Extra)
    }

    /// Write `value` onto `patch`, a row whose flags stand at `flags`. A null clears.
    pub fn write(
        &self,
        patch: &mut Patch<Location>,
        flags: LocationFlags,
        value: &serde_json::Value,
    ) -> AppResult<()> {
        match self.address {
            Address::Column(write) => write(patch, value),
            Address::Flag(bit) => {
                let mut next = patch.flags.unwrap_or(flags);
                next.set(bit, flag_assignment(self.key, value)?);
                patch.flags = Some(next);
                Ok(())
            }
            Address::Extra => {
                patch.extra = extra_with(&patch.extra, self.key, value);
                Ok(())
            }
        }
    }
}

/// `pending` with `key` written to `value`, keeping a pending clear or replacement of the
/// whole extra.
fn extra_with(
    pending: &Field<JsonWrite>,
    key: &str,
    value: &serde_json::Value,
) -> Field<JsonWrite> {
    let object = |raw: &serde_json::Value| raw.as_object().cloned().unwrap_or_default();
    let mut whole = match pending {
        Field::Keep => return Field::Set(JsonWrite::Merge(serde_json::json!({ key: value }))),
        Field::Set(JsonWrite::Merge(raw)) => {
            let mut merge = object(raw);
            merge.insert(key.to_string(), value.clone());
            return Field::Set(JsonWrite::Merge(serde_json::Value::Object(merge)));
        }
        Field::Clear => serde_json::Map::new(),
        Field::Set(JsonWrite::Replace(raw)) => object(raw),
    };
    if value.is_null() {
        whole.remove(key);
    } else {
        whole.insert(key.to_string(), value.clone());
    }
    if whole.is_empty() {
        Field::Clear
    } else {
        Field::Set(JsonWrite::Replace(serde_json::Value::Object(whole)))
    }
}

/// A flag field's assigned value as the bit it sets: a boolean, nothing else.
pub fn flag_assignment(key: &str, value: &serde_json::Value) -> AppResult<bool> {
    value
        .as_bool()
        .ok_or_else(|| AppError(format!("'{key}' takes true or false, not {value}")))
}

// The field vocabulary is declared once, on the `Location` struct (`#[derive(Fields)]`,
// see `mma-fields`): `location_fields!` hands the declared table to the callback below,
// which expands it into the built-in definitions and the value resolver. The helper
// macros translate each row's tokens; resolver bodies are chosen by the row's category and
// its column's type, so a quirk is a declared category or column, never a one-off closure.

macro_rules! field_kind {
    (identity) => {
        Some(BuiltinFieldKind::Identity)
    };
    (virtual_) => {
        Some(BuiltinFieldKind::Virtual)
    };
    (writable) => {
        Some(BuiltinFieldKind::Writable)
    };
    (readonly) => {
        None
    };
}

macro_rules! field_cmp {
    (none) => {
        None
    };
    ((circular $p:literal)) => {
        Some(ComparisonType::Circular { period: $p })
    };
}

macro_rules! field_interned {
    (interned) => {
        true
    };
    (not_interned) => {
        false
    };
}

/// How a column reads as a built-in field: its type, and its value on a row, `None` when absent.
trait FieldColumn: Column {
    const FIELD_TYPE: FieldType;
    fn field_value(cell: Self::Cell<'_>) -> Option<serde_json::Value>;
}

impl FieldColumn for f64 {
    const FIELD_TYPE: FieldType = FieldType::Number;
    fn field_value(cell: f64) -> Option<serde_json::Value> {
        Some(serde_json::json!(cell))
    }
}

impl<T: 'static> FieldColumn for Id<T> {
    const FIELD_TYPE: FieldType = FieldType::Number;
    fn field_value(cell: Id<T>) -> Option<serde_json::Value> {
        Some(serde_json::json!(cell))
    }
}

/// The empty string is absent, the same absence a missing key has.
impl FieldColumn for Option<compact_str::CompactString> {
    const FIELD_TYPE: FieldType = FieldType::String;
    fn field_value(cell: Option<&str>) -> Option<serde_json::Value> {
        cell.filter(|s| !s.is_empty()).map(|s| serde_json::json!(s))
    }
}

/// The empty list is absent.
impl<T: 'static> FieldColumn for Vec<Id<T>> {
    const FIELD_TYPE: FieldType = FieldType::Array;
    fn field_value(cell: &[Id<T>]) -> Option<serde_json::Value> {
        (!cell.is_empty()).then(|| serde_json::json!(cell))
    }
}

/// A column of unix seconds read as a date field.
trait DateColumn: Column {
    fn date_value(cell: Self::Cell<'_>) -> Option<serde_json::Value>;
}

impl DateColumn for u32 {
    fn date_value(cell: u32) -> Option<serde_json::Value> {
        Some(serde_json::json!(cell as f64))
    }
}

impl DateColumn for Option<u32> {
    fn date_value(cell: Option<u32>) -> Option<serde_json::Value> {
        cell.map(|ts| serde_json::json!(ts as f64))
    }
}

macro_rules! field_type {
    (value, $t:ty) => {
        <$t as FieldColumn>::FIELD_TYPE
    };
    (date, $t:ty) => {
        FieldType::Date
    };
    (len_of, $t:ty) => {
        FieldType::Number
    };
    (flag, $t:ty) => {
        FieldType::Boolean
    };
}

/// A built-in field's value on a row, by category, read through the row's typed column
/// reader. `None` is absence.
macro_rules! field_value {
    (value, $t:ty, $r:ident, $c:ident, $f:ident) => {
        <$t as FieldColumn>::field_value($r.$c())
    };
    (date, $t:ty, $r:ident, $c:ident, $f:ident) => {
        <$t as DateColumn>::date_value($r.$c())
    };
    (len_of, $t:ty, $r:ident, $c:ident, $f:ident) => {
        Some(serde_json::json!($r.$c().len()))
    };
    (flag, $t:ty, $r:ident, $c:ident, $f:ident) => {
        Some(serde_json::Value::Bool($r.$c().contains(LocationFlags::$f)))
    };
}

macro_rules! field_address {
    (flag, $c:ident, $f:ident) => {
        Some(Address::Flag(LocationFlags::$f))
    };
    (len_of, $c:ident, $f:ident) => {
        None
    };
    ($cat:ident, $c:ident, $f:ident) => {
        Some(Address::Column(|patch, value| {
            patch.$c = serde_json::from_value(value.clone())?;
            Ok(())
        }))
    };
}

fn remap_ids<T>(ids: &mut Vec<Id<T>>, mut map: impl FnMut(Id<T>) -> Option<Id<T>>) -> bool {
    let before = ids.len();
    let mut changed = false;
    let mut seen = HashSet::new();
    ids.retain_mut(|id| match map(*id) {
        Some(next) if seen.insert(next) => {
            changed |= next != *id;
            *id = next;
            true
        }
        _ => false,
    });
    changed || ids.len() != before
}

fn remap_value(
    value: &mut serde_json::Value,
    map: impl FnMut(Id<ValueRecord>) -> Option<Id<ValueRecord>>,
) -> bool {
    let Some(values) = value.as_array() else {
        return false;
    };
    let mut ids: Vec<_> = values
        .iter()
        .filter_map(|value| Some(Id::new(u32::try_from(value.as_u64()?).ok()?)))
        .collect();
    let changed = remap_ids(&mut ids, map);
    if changed {
        *value = ids
            .into_iter()
            .map(|id| serde_json::Value::from(id.get()))
            .collect();
    }
    changed
}

macro_rules! remap_interned {
    (interned, row, $row:ident, $col:ident, $key:literal, $map:ident) => {
        remap_ids(&mut $row.$col, |id| $map($key, id));
    };
    (interned, patch, $patch:ident, $col:ident, $key:literal, $map:ident) => {
        if let Some(ids) = &mut $patch.$col {
            remap_ids(ids, |id| $map($key, id));
        }
    };
    (not_interned, $kind:ident, $row:ident, $col:ident, $key:literal, $map:ident) => {};
}

macro_rules! expand_location_fields {
    ($({ $key:literal, $label:literal, $ty:ty, $kind:ident, $cmp:tt, $interned:ident,
         $cat:ident, $col:ident, $f:ident }),* $(,)?) => {
        impl FieldRegistry<'_> {
            /// Remap the references an edit writes, preserving its patch policies.
            pub fn remap(
                &self,
                mut edit: Edit<Location>,
                mut map: impl FnMut(&str, Id<ValueRecord>) -> Option<Id<ValueRecord>>,
            ) -> Edit<Location> {
                let interned = |key: &str| self.get(key)
                    .is_some_and(|def| def.interned && def.builtin.is_none());
                match &mut edit {
                    Op::Add(row) | Op::Set(row) => {
                        $(remap_interned!($interned, row, row, $col, $key, map);)*
                        if let Some(extra) = &row.extra {
                            let mut changed = serde_json::Map::new();
                            extra.for_each_field(|key, raw| {
                                if interned(key) {
                                    if let Ok(mut value) = serde_json::from_str(raw) {
                                        if remap_value(&mut value, |id| map(key, id)) {
                                            changed.insert(key.to_string(), value);
                                        }
                                    }
                                }
                            });
                            if !changed.is_empty() {
                                row.extra = row.extra.patched(&Field::Set(JsonWrite::Merge(
                                    serde_json::Value::Object(changed),
                                )));
                            }
                        }
                    }
                    Op::Put(patch) => {
                        $(remap_interned!($interned, patch, patch, $col, $key, map);)*
                        if let Field::Set(JsonWrite::Merge(value) | JsonWrite::Replace(value)) = &mut patch.extra {
                            if let Some(fields) = value.as_object_mut() {
                                for (key, value) in fields {
                                    if interned(key) {
                                        remap_value(value, |id| map(key, id));
                                    }
                                }
                            }
                        }
                    }
                    Op::Remove(_) => {}
                }
                edit
            }
        }

        /// Every built-in field's definition, in declaration order. Nullability is probed
        /// rather than declared: whatever a default location lacks, a row can lack.
        fn builtin_defs() -> Vec<(&'static str, FieldDef)> {
            let empty = Location::default();
            let empty = RowRef::from_loc(&empty);
            vec![$(($key, FieldDef {
                field_type: field_type!($cat, $ty),
                label: Some($label.into()),
                values: None,
                comparison: field_cmp!($cmp),
                interned: field_interned!($interned),
                builtin: Some(Builtin {
                    kind: field_kind!($kind),
                    clearable: <Location as mma_algebra::Patchable>::CLEARS.contains(&$key),
                    optional: builtin_value(&empty, $key).flatten().is_none(),
                    address: field_address!($cat, $col, $f),
                }),
            })),*]
        }

        /// A built-in field's value on `row`: `None` when `field` is no built-in, and
        /// `Some(None)` when the row lacks it. That inner `None` is the one meaning of
        /// absence: resolving an `extra` key holding JSON null agrees.
        pub(super) fn builtin_value(row: &RowRef, field: &str) -> Option<Option<serde_json::Value>> {
            match field {
                $($key => Some(field_value!($cat, $ty, row, $col, $f)),)*
                _ => None,
            }
        }
    };
}

location_fields!(expand_location_fields);

struct Builtins {
    order: Vec<&'static str>,
    defs: HashMap<&'static str, FieldDef>,
}

fn builtins() -> &'static Builtins {
    static BUILTINS: OnceLock<Builtins> = OnceLock::new();
    BUILTINS.get_or_init(|| {
        let defs = builtin_defs();
        Builtins {
            order: defs.iter().map(|(key, _)| *key).collect(),
            defs: defs.into_iter().collect(),
        }
    })
}

/// Every field a map's rows can hold, by key: the built-ins in declaration order, then
/// the map's own definitions. A built-in shadows a map definition of the same key.
#[derive(Clone, Copy)]
pub struct FieldRegistry<'a, F = fn(Option<&FieldDef>) -> bool> {
    map: &'a HashMap<String, FieldDef>,
    includes: F,
}

impl<'a> FieldRegistry<'a> {
    pub fn new(map: &'a HashMap<String, FieldDef>) -> Self {
        Self {
            map,
            includes: |_| true,
        }
    }

    /// The registry of a map that defines no fields of its own.
    pub fn builtins() -> FieldRegistry<'static> {
        static NONE: OnceLock<HashMap<String, FieldDef>> = OnceLock::new();
        FieldRegistry::new(NONE.get_or_init(HashMap::new))
    }

    /// Leave to assign `key`. A key no field declares is an `extra` key, always writable.
    pub fn assign<'k>(&self, key: &'k str) -> AppResult<FieldWriter<'k>> {
        self.grant(key, FieldDef::assignable, "assigned")
    }

    /// Leave to remove `key`. A key no field declares is an `extra` key, always removable.
    pub fn clear<'k>(&self, key: &'k str) -> AppResult<FieldWriter<'k>> {
        self.grant(key, FieldDef::clearable, "removed")
    }

    fn grant<'k>(
        &self,
        key: &'k str,
        allows: fn(&FieldDef) -> bool,
        verb: &str,
    ) -> AppResult<FieldWriter<'k>> {
        let address = match self.get(key) {
            None => Some(Address::Extra),
            Some(def) if allows(def) => def.address(),
            Some(_) => None,
        };
        address
            .map(|address| FieldWriter { key, address })
            .ok_or_else(|| AppError(format!("'{key}' cannot be {verb}")))
    }
}

impl<'a, F: Fn(Option<&FieldDef>) -> bool + Clone> FieldRegistry<'a, F> {
    pub fn filter(
        self,
        includes: impl Fn(&FieldDef) -> bool + Clone,
    ) -> FieldRegistry<'a, impl Fn(Option<&FieldDef>) -> bool + Clone> {
        FieldRegistry {
            map: self.map,
            includes: move |field: Option<&FieldDef>| {
                (self.includes)(field) && field.is_some_and(&includes)
            },
        }
    }

    pub fn interned(self) -> FieldRegistry<'a, impl Fn(Option<&FieldDef>) -> bool + Clone> {
        self.filter(|field| field.interned)
    }

    pub fn get(&self, key: &str) -> Option<&'a FieldDef> {
        builtins()
            .defs
            .get(key)
            .or_else(|| self.map.get(key))
            .filter(|def| (self.includes)(Some(def)))
    }

    pub fn keys(self) -> impl Iterator<Item = &'a str> {
        self.iter().map(|(key, _)| key)
    }

    pub fn iter(self) -> impl Iterator<Item = (&'a str, &'a FieldDef)> {
        let builtins = builtins();
        builtins
            .order
            .iter()
            .map(|key| (*key, &builtins.defs[key]))
            .chain(
                self.map
                    .iter()
                    .filter(|(key, _)| !builtins.defs.contains_key(key.as_str()))
                    .map(|(key, def)| (key.as_str(), def)),
            )
            .filter(move |(_, def)| (self.includes)(Some(def)))
    }
}

impl Serialize for FieldRegistry<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Entry<'d> {
            #[serde(flatten)]
            def: &'d FieldDef,
            #[serde(flatten)]
            builtin: Option<&'d Builtin>,
        }
        serializer.collect_map(self.iter().map(|(key, def)| {
            (
                key,
                Entry {
                    def,
                    builtin: def.builtin.as_ref(),
                },
            )
        }))
    }
}

/// Core comparison dispatch. An array field answers `contains`/`has` itself and is
/// otherwise compared by length. Ordering is numeric when both sides are numbers, else
/// lexicographic on their string forms.
pub(super) fn compare_filter(field_val: &serde_json::Value, op: &FilterOp) -> bool {
    if let Some(arr) = field_val.as_array() {
        return match op {
            FilterOp::Contains { value } => arr.iter().any(|el| val_eq(el, value)),
            FilterOp::Notcontains { value } => !arr.iter().any(|el| val_eq(el, value)),
            FilterOp::Has => true,
            FilterOp::Nothas => false,
            _ => compare_filter(&serde_json::Value::from(arr.len() as f64), op),
        };
    }
    match op {
        FilterOp::Eq { value } => val_eq(field_val, value),
        FilterOp::Neq { value } => !val_eq(field_val, value),
        FilterOp::Has => true,
        FilterOp::Nothas => false,
        FilterOp::Contains { .. } | FilterOp::Notcontains { .. } => false,
        FilterOp::Gt { value, .. } => order(field_val, value) == Ordering::Greater,
        FilterOp::Lt { value, .. } => order(field_val, value) == Ordering::Less,
        FilterOp::Gte { value, .. } => order(field_val, value) != Ordering::Less,
        FilterOp::Lte { value, .. } => order(field_val, value) != Ordering::Greater,
        FilterOp::Between { lo, hi, .. } => {
            order(field_val, lo) != Ordering::Less && order(field_val, hi) != Ordering::Greater
        }
        FilterOp::BetweenAnyyear { lo, hi, .. } => {
            let fv_md = if let Some(ts) = as_f64(field_val) {
                let (m, d) = unix_to_month_day(ts);
                format!("{m:02}-{d:02}")
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
            wraps(&fv_md, lo, hi)
        }
        FilterOp::BetweenAnytime { lo, hi, .. } => {
            let Some(ts) = as_f64(field_val) else {
                return false;
            };
            let (h, m) = unix_to_hour_min(ts);
            wraps(&format!("{h:02}:{m:02}"), lo, hi)
        }
    }
}

fn order(a: &serde_json::Value, b: &serde_json::Value) -> Ordering {
    match (as_f64(a), as_f64(b)) {
        (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
        _ => a.as_str().unwrap_or("").cmp(b.as_str().unwrap_or("")),
    }
}

/// `lo..=hi` on a cyclic key (month-day, hour-minute): a range past the wrap point
/// (`12-01..02-01`) is the union of its two arcs.
fn wraps(v: &str, lo: &str, hi: &str) -> bool {
    if lo <= hi {
        v >= lo && v <= hi
    } else {
        v >= lo || v <= hi
    }
}

/// A local-time filter buckets the location's absolute timestamp into its own timezone's
/// wall-clock before comparing. The shifted value runs through the normal
/// `compare_filter` dispatch, so a range compares against wall-clock instants encoded
/// as UTC-epoch seconds (the picker's wall-clock mode) and the anyyear/anytime shapes
/// bucket month-day / hour-min in the pano's local clock. The location's `timezone`
/// (IANA) supplies the DST-correct offset; locations lacking a resolvable `timezone` or
/// field value are excluded.
pub(super) fn compare_filter_local_tz(r: &RowRef, field: &str, op: &FilterOp) -> bool {
    let (fv, tz_name) = r.resolve_field_and_tz(field);
    let Some(ts) = fv.as_ref().and_then(as_f64) else {
        return false;
    };
    let Some(tz_name) = tz_name else {
        return false;
    };
    let Some(offset) = tz_offset_seconds(&tz_name, ts) else {
        return false;
    };
    compare_filter(&serde_json::Value::from(ts + offset as f64), op)
}

/// Equality comparison with type coercion: tries numeric, then string, then JSON equality.
pub(super) fn val_eq(a: &serde_json::Value, b: &serde_json::Value) -> bool {
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
pub(super) fn val_to_str(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// Try to extract an f64 from a JSON value: native number or parseable string.
pub(super) fn as_f64(v: &serde_json::Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}
