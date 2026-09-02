//! Field filters: the built-in field table and value comparison rules.

use super::*;
use crate::store::maps::{ComparisonType, ExtraFieldType};
use crate::types::Location;
use crate::util::{tz_offset_seconds, unix_to_hour_min, unix_to_month_day};
use arrow_array::Array;
use serde::Serialize;

/// How a built-in field may be accessed by the field system on the TS side.
/// `None` means listable and filterable but read-only.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum BuiltinFieldKind {
    /// Composes the location itself. Never writable, never offered in pickers.
    Identity,
    /// Derived, not stored on the location. Never writable.
    Virtual,
    /// Only a term in a field expression. Never writable, never offered in pickers.
    Term,
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
    pub field_type: ExtraFieldType,
    pub kind: Option<BuiltinFieldKind>,
    pub comparison: Option<ComparisonType>,
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

        /// The columns a row can lack, derived from the resolvers rather than declared
        /// beside them: a default location holds every always-present field, so whatever
        /// it answers `None` for is a column an op may clear.
        pub fn optional_builtins() -> &'static [&'static str] {
            static KEYS: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();
            KEYS.get_or_init(|| {
                let empty = Location::default();
                BUILTIN_FIELDS
                    .iter()
                    .filter(|f| resolve_field_loc(&empty, f.key).is_none())
                    .map(|f| f.key)
                    .collect()
            })
        }

        /// Resolve a field name to its JSON value from a `Location` struct. Unknown fields
        /// fall through to `loc.extra`. `None` is the one meaning of absence: a builtin
        /// without a value and an `extra` key holding JSON null both resolve to it.
        pub(crate) fn resolve_field_loc(loc: &Location, field: &str) -> Option<serde_json::Value> {
            match field {
                $($key => { let $l = loc; $loc_expr })*
                _ => loc.extra.as_ref().and_then(|e| e.get(field)).filter(|v| !v.is_null()),
            }
        }

        /// Resolve a field name to its JSON value directly from Arrow columns (avoids
        /// materializing a full `Location`). Falls through to `extras` JSON otherwise.
        pub(super) fn resolve_field_arrow(view: &LocView, idx: usize, field: &str) -> Option<serde_json::Value> {
            match field {
                $($key => { let ($v, $i) = (view, idx); $arrow_expr })*
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
        |l| l.pano_id.as_deref().filter(|p| !p.is_empty()).map(|p| serde_json::json!(p)),
        |v, i| v.pano_ids.and_then(|c| {
            (!c.is_null(i) && !c.value(i).is_empty()).then(|| serde_json::json!(c.value(i)))
        });
    "tagCount", "Tag count", ExtraFieldType::Number, Some(BuiltinFieldKind::Virtual), None,
        |l| Some(serde_json::json!(l.tags.len())),
        |v, i| v.tags.map(|c| serde_json::json!(c.value(i).len()));
    "loadAsPanoId", "Load as pano ID", ExtraFieldType::Number, Some(BuiltinFieldKind::Term), None,
        |l| Some(flag_value(l.flags, LocationFlags::LOAD_AS_PANO_ID)),
        |v, i| v.flags.map(|c| flag_value(LocationFlags::from_bits_retain(c.value(i)),
            LocationFlags::LOAD_AS_PANO_ID));
    "informational", "Informational", ExtraFieldType::Number, Some(BuiltinFieldKind::Term), None,
        |l| Some(flag_value(l.flags, LocationFlags::INFORMATIONAL)),
        |v, i| v.flags.map(|c| flag_value(LocationFlags::from_bits_retain(c.value(i)),
            LocationFlags::INFORMATIONAL));
}

/// Flags read as 0/1 numbers: the expression language has no booleans, so a flag term
/// adds itself to a score directly.
fn flag_value(flags: LocationFlags, bit: LocationFlags) -> serde_json::Value {
    serde_json::json!(u8::from(flags.contains(bit)))
}

/// Core comparison dispatch. Supports eq, neq, has, nothas, gt, lt, gte, lte, between,
/// between_anyyear (month-day range ignoring year), and between_anytime (time-of-day range).
/// Numeric comparison is attempted first; falls back to lexicographic string comparison.
pub(super) fn compare_filter(
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
                format!("{h:02}:{m:02}")
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
pub(super) fn compare_filter_local_tz(
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
