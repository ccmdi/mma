//! Grouping a set by field: key projection, date parts, numeric binning, count-by.

use super::*;
use crate::store::maps::ExtraFieldType;
use crate::util::tz_offset_seconds;
use chrono::{DateTime, Datelike, Timelike, Utc};
use roaring::RoaringBitmap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
    pub applies_to: &'static [ExtraFieldType],
    /// Date projections read in the location's own timezone when asked to.
    pub needs_tz: bool,
}

pub const PROJECTIONS: &[Projection] = {
    use crate::store::maps::ExtraFieldType::*;
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

pub(super) const MONTH_NAMES: [&str; 12] = [
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

pub(super) const MAX_BINS_WITH_EMPTIES: usize = 100;

pub(super) fn partition_numeric(
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
    if groups.len() > MAX_BINS_WITH_EMPTIES {
        groups.retain(|g| !g.ids.is_empty());
    }
    groups
}

pub(super) fn partition_keyed(
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

/// JS `String(value)` for the key: strings verbatim (empty -> skip), numbers without a
/// trailing ".0", bools as "true"/"false". Null/other -> skip.
pub(super) fn value_key(v: &serde_json::Value) -> Option<String> {
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
pub(super) fn date_part_key(
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

pub(super) fn parts_to_key(y: i32, mo: u32, d: u32, h: u32, part: DatePart) -> String {
    match part {
        DatePart::Year => format!("{y}"),
        DatePart::YearMonth => format!("{y}-{mo:02}"),
        DatePart::Day => format!("{y}-{mo:02}-{d:02}"),
        DatePart::MonthOfYear => MONTH_NAMES[(mo.clamp(1, 12) - 1) as usize].to_string(),
        DatePart::HourOfDay => format!("{h:02}:00"),
    }
}

/// Parse a strict "YYYY-MM" string into (year, month). `None` for any other shape (e.g. a
/// numeric date string), which the caller then treats as epoch seconds.
pub(super) fn parse_year_month(s: &str) -> Option<(i32, u32)> {
    let b = s.as_bytes();
    if s.len() != 7 || b[4] != b'-' {
        return None;
    }
    Some((s[0..4].parse().ok()?, s[5..7].parse().ok()?))
}

pub(super) fn utc_parts(ts: f64) -> (i32, u32, u32, u32) {
    let dt = DateTime::<Utc>::from_timestamp(ts as i64, 0).unwrap_or_default();
    (dt.year(), dt.month(), dt.day(), dt.hour())
}

/// JS `String(number)`: integer-valued floats print without a decimal.
pub(super) fn js_number_string(f: f64) -> String {
    if f.is_finite() && f.fract() == 0.0 {
        format!("{}", f as i64)
    } else {
        format!("{f}")
    }
}

/// Equal-width numeric bins, mirroring JS `binNumeric`.
pub(super) struct NumBuckets {
    pub(super) bounds: Vec<(f64, f64)>,
    pub(super) mode: BinMode,
}

pub(super) enum BinMode {
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

pub(super) fn bin_numeric(values: &[f64], binning: &NumericBinning) -> Option<NumBuckets> {
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
pub(super) fn bound_label(lo: f64, hi: f64) -> String {
    format!("{}–{}", fmt_bound(lo), fmt_bound(hi))
}

pub(super) fn fmt_bound(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{}", (n * 100.0).round() / 100.0)
    }
}
