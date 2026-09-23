//! Field filters: the built-in field table and value comparison rules.

use super::*;
use crate::store::maps::{ComparisonType, FieldType};
use crate::types::Location;
use crate::util::{tz_offset_seconds, unix_to_hour_min, unix_to_month_day};
use serde::Serialize;
use std::cmp::Ordering;

/// How a built-in field may be accessed by the field system on the TS side.
/// `None` means listable and filterable but read-only.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum BuiltinFieldKind {
    /// Composes the location itself. Never writable, never offered in pickers.
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
    pub field_type: FieldType,
    pub kind: Option<BuiltinFieldKind>,
    pub comparison: Option<ComparisonType>,
    /// The field's values are ids the store allocates, wearing per-value display
    /// metadata (`store_patch_field_values`). Tags are the first such field.
    pub interned: bool,
}

// The field vocabulary is declared once, on the `Location` struct (`#[derive(Fields)]`,
// see `mma-fields`): `location_fields!` hands the declared table to the callback below,
// which expands it into the exported field table, `is_builtin_field`, and both
// resolvers. The helper macros translate each row's tokens; resolver bodies are chosen
// by the row's category, so a quirk is a declared category, never a one-off closure.

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
    (u32_list_empty, $r:ident, $c:ident, $f:ident) => {{
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

macro_rules! field_flag_bit {
    (flag, $f:ident) => {
        Some(LocationFlags::$f)
    };
    ($cat:ident, $f:ident) => {
        None
    };
}

macro_rules! expand_location_fields {
    ($({ $key:literal, $label:literal, $ty:ident, $kind:ident, $cmp:tt, $interned:ident,
         $cat:ident, $col:ident, $f:ident }),* $(,)?) => {
        pub const BUILTIN_FIELDS: &[BuiltinField] = &[$(BuiltinField {
            key: $key,
            label: $label,
            field_type: FieldType::$ty,
            kind: field_kind!($kind),
            comparison: field_cmp!($cmp),
            interned: field_interned!($interned),
        }),*];

        /// True for fields backed by a Location column rather than the `extras` blob.
        pub fn is_builtin_field(field: &str) -> bool {
            matches!(field, $($key)|*)
        }

        /// The flag bit a built-in field reads and writes as a boolean.
        pub fn flag_field(field: &str) -> Option<LocationFlags> {
            match field {
                $($key => field_flag_bit!($cat, $f),)*
                _ => None,
            }
        }

        /// A built-in field's value on `row`, `None` when the row lacks it. `None` is the
        /// one meaning of absence: resolving an `extra` key holding JSON null agrees.
        pub(super) fn builtin_value(row: &RowRef, field: &str) -> Option<serde_json::Value> {
            match field {
                $($key => field_value!($cat, row, $col, $f),)*
                _ => None,
            }
        }
    };
}

use crate::types::location_fields;
location_fields!(expand_location_fields);

/// True for the built-in columns a bulk set may assign (`heading`, `pitch`, `zoom`, `tags`).
pub fn is_writable_builtin(field: &str) -> bool {
    BUILTIN_FIELDS
        .iter()
        .any(|f| f.key == field && matches!(f.kind, Some(BuiltinFieldKind::Writable)))
}

/// The columns a row can lack, derived from the resolvers rather than declared
/// beside them: a default location holds every always-present field, so whatever
/// it answers `None` for is a column an op may clear.
pub fn optional_builtins() -> &'static [&'static str] {
    use std::sync::OnceLock;
    static KEYS: OnceLock<Vec<&'static str>> = OnceLock::new();
    KEYS.get_or_init(|| {
        let empty = Location::default();
        BUILTIN_FIELDS
            .iter()
            .filter(|f| RowRef::from_loc(&empty).resolve_field(f.key).is_none())
            .map(|f| f.key)
            .collect()
    })
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
