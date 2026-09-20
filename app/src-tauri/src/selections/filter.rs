//! Field filters: the built-in field table and value comparison rules.

use super::*;
use crate::store::maps::{ComparisonType, FieldType};
use crate::types::Location;
use crate::util::{tz_offset_seconds, unix_to_hour_min, unix_to_month_day};
use arrow_array::Array;
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

/// A field's value off a `Location`, by category. `None` is absence.
macro_rules! field_loc_value {
    (f64, $l:ident, $f:ident) => {
        Some(serde_json::json!($l.$f))
    };
    (u32, $l:ident, $f:ident) => {
        Some(serde_json::json!($l.$f))
    };
    (date_u32, $l:ident, $f:ident) => {
        Some(serde_json::json!($l.$f as f64))
    };
    (opt_date_u32, $l:ident, $f:ident) => {
        $l.$f.map(|ts| serde_json::json!(ts as f64))
    };
    (opt_str_empty, $l:ident, $f:ident) => {
        $l.$f
            .as_deref()
            .filter(|p| !p.is_empty())
            .map(|p| serde_json::json!(p))
    };
    (u32_list_empty, $l:ident, $f:ident) => {
        (!$l.$f.is_empty()).then(|| serde_json::json!($l.$f))
    };
    (len_of, $l:ident, $f:ident) => {
        Some(serde_json::json!($l.$f.len()))
    };
    (flag, $l:ident, $f:ident) => {
        Some(flag_value($l.flags, LocationFlags::$f))
    };
}

/// The same value off the Arrow columns, via `LocView`'s cached refs.
macro_rules! field_arrow_value {
    (f64, $v:ident, $i:ident, $c:ident, $f:ident) => {
        $v.$c.map(|c| serde_json::json!(c.value($i)))
    };
    (u32, $v:ident, $i:ident, $c:ident, $f:ident) => {
        $v.$c.map(|c| serde_json::json!(c.value($i)))
    };
    (date_u32, $v:ident, $i:ident, $c:ident, $f:ident) => {
        $v.$c.map(|c| serde_json::json!(c.value($i) as f64))
    };
    (opt_date_u32, $v:ident, $i:ident, $c:ident, $f:ident) => {
        $v.$c
            .and_then(|c| (!c.is_null($i)).then(|| serde_json::json!(c.value($i) as f64)))
    };
    (opt_str_empty, $v:ident, $i:ident, $c:ident, $f:ident) => {
        $v.$c.and_then(|c| {
            (!c.is_null($i) && !c.value($i).is_empty()).then(|| serde_json::json!(c.value($i)))
        })
    };
    (u32_list_empty, $v:ident, $i:ident, $c:ident, $f:ident) => {
        $v.$c.and_then(|c| {
            let list = c.value($i);
            let ids = list.as_any().downcast_ref::<UInt32Array>().unwrap();
            (!ids.is_empty()).then(|| {
                serde_json::json!((0..ids.len()).map(|k| ids.value(k)).collect::<Vec<_>>())
            })
        })
    };
    (len_of, $v:ident, $i:ident, $c:ident, $f:ident) => {
        $v.$c.map(|c| serde_json::json!(c.value($i).len()))
    };
    (flag, $v:ident, $i:ident, $c:ident, $f:ident) => {
        $v.$c.map(|c| {
            flag_value(
                LocationFlags::from_bits_retain(c.value($i)),
                LocationFlags::$f,
            )
        })
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

        /// Resolve a field name to its JSON value from a `Location` struct. Unknown fields
        /// fall through to `loc.extra`. `None` is the one meaning of absence: a builtin
        /// without a value and an `extra` key holding JSON null both resolve to it.
        pub(crate) fn resolve_field_loc(loc: &Location, field: &str) -> Option<serde_json::Value> {
            match field {
                $($key => field_loc_value!($cat, loc, $f),)*
                _ => loc.extra.as_ref().and_then(|e| e.get(field)).filter(|v| !v.is_null()),
            }
        }

        /// Resolve a field name to its JSON value directly from Arrow columns (avoids
        /// materializing a full `Location`). Falls through to `extras` JSON otherwise.
        pub(super) fn resolve_field_arrow(view: &LocView, idx: usize, field: &str) -> Option<serde_json::Value> {
            match field {
                $($key => field_arrow_value!($cat, view, idx, $col, $f),)*
                _ => {
                    let extras = view.extras?;
                    if extras.is_null(idx) {
                        return None;
                    }
                    // Byte-scan for the one key; parses only its value slice instead of
                    // the whole extras document per row.
                    crate::types::json_field(extras.value(idx), field).filter(|v| !v.is_null())
                }
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
            .filter(|f| resolve_field_loc(&empty, f.key).is_none())
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
