//! Field filters: the built-in field table and value comparison rules.

use super::*;
use crate::store::maps::{ComparisonType, FieldDef, FieldType};
use crate::types::{location_fields, AppError, AppResult, Location};
use crate::util::{tz_offset_seconds, unix_to_hour_min, unix_to_month_day};
use mma_algebra::Patch;
use serde::Serialize;
use std::cmp::Ordering;
use std::collections::HashMap;
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
                let mut extra = match &patch.extra {
                    mma_algebra::Field::Set(raw) => raw.as_object().cloned().unwrap_or_default(),
                    _ => serde_json::Map::new(),
                };
                extra.insert(self.key.to_string(), value.clone());
                patch.extra = mma_algebra::Field::Set(serde_json::Value::Object(extra));
                Ok(())
            }
        }
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
// macros translate each row's tokens; resolver bodies are chosen by the row's category,
// so a quirk is a declared category, never a one-off closure.

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

/// A built-in field's value on a row, by category, read through the row's typed column
/// reader. `None` is absence.
macro_rules! field_value {
    (f64, $r:ident, $c:ident, $f:ident) => {
        Some(serde_json::json!($r.$c()))
    };
    (id, $r:ident, $c:ident, $f:ident) => {
        Some(serde_json::json!($r.$c()))
    };
    (u32, $r:ident, $c:ident, $f:ident) => {
        Some(serde_json::json!($r.$c()))
    };
    (date_u32, $r:ident, $c:ident, $f:ident) => {
        Some(serde_json::json!($r.$c() as f64))
    };
    (opt_date_u32, $r:ident, $c:ident, $f:ident) => {
        $r.$c().map(|ts| serde_json::json!(ts as f64))
    };
    (opt_str_empty, $r:ident, $c:ident, $f:ident) => {
        $r.$c()
            .filter(|s| !s.is_empty())
            .map(|s| serde_json::json!(s))
    };
    (id_list_empty, $r:ident, $c:ident, $f:ident) => {{
        let list = $r.$c();
        (!list.is_empty()).then(|| serde_json::json!(list))
    }};
    (len_of, $r:ident, $c:ident, $f:ident) => {
        Some(serde_json::json!($r.$c().len()))
    };
    (flag, $r:ident, $c:ident, $f:ident) => {
        Some(flag_value($r.$c(), LocationFlags::$f))
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

macro_rules! expand_location_fields {
    ($({ $key:literal, $label:literal, $ty:ident, $kind:ident, $cmp:tt, $interned:ident,
         $cat:ident, $col:ident, $f:ident }),* $(,)?) => {
        /// Every built-in field's definition, in declaration order. Nullability is probed
        /// rather than declared: whatever a default location lacks, a row can lack.
        fn builtin_defs() -> Vec<(&'static str, FieldDef)> {
            let empty = Location::default();
            let empty = RowRef::from_loc(&empty);
            vec![$(($key, FieldDef {
                field_type: FieldType::$ty,
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
                $($key => Some(field_value!($cat, row, $col, $f)),)*
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
pub struct FieldRegistry<'a> {
    map: &'a HashMap<String, FieldDef>,
}

impl<'a> FieldRegistry<'a> {
    pub fn new(map: &'a HashMap<String, FieldDef>) -> Self {
        Self { map }
    }

    /// The registry of a map that defines no fields of its own.
    pub fn builtins() -> FieldRegistry<'static> {
        static NONE: OnceLock<HashMap<String, FieldDef>> = OnceLock::new();
        FieldRegistry::new(NONE.get_or_init(HashMap::new))
    }

    pub fn get(&self, key: &str) -> Option<&'a FieldDef> {
        builtins().defs.get(key).or_else(|| self.map.get(key))
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

    /// The fields whose values are ids the map allocates.
    pub fn interned(&self) -> impl Iterator<Item = &'a str> + 'a {
        self.iter()
            .filter(|(_, def)| def.interned)
            .map(|(key, _)| key)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&'a str, &'a FieldDef)> + 'a {
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

/// A flag bit as the boolean its field holds.
fn flag_value(flags: LocationFlags, bit: LocationFlags) -> serde_json::Value {
    serde_json::Value::Bool(flags.contains(bit))
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
