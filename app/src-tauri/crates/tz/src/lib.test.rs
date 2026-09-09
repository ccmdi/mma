use super::*;
use chrono::{Offset, TimeZone};

static TABLE: &[u8] = include_bytes!("../../../data/tz.bin");

/// The u32 Unix-second domain every timestamp in the app lives in.
const TS_MIN: i64 = 0;
const TS_MAX: i64 = u32::MAX as i64;

fn oracle_offset(tz: chrono_tz::Tz, ts: i64) -> i32 {
    let dt = chrono::DateTime::from_timestamp(ts, 0).unwrap();
    tz.offset_from_utc_datetime(&dt.naive_utc()).fix().local_minus_utc()
}

fn table() -> Tz<'static> {
    Tz::new(TABLE).unwrap()
}

#[test]
fn every_chrono_tz_zone_is_present() {
    let t = table();
    assert_eq!(t.zone_count(), chrono_tz::TZ_VARIANTS.len());
    for tz in chrono_tz::TZ_VARIANTS.iter().copied() {
        assert!(t.zone_index(tz.name()).is_some(), "missing {}", tz.name());
    }
    assert_eq!(t.zone_index("Not/AZone"), None);
}

/// Every zone, sampled monthly across the whole u32 range.
#[test]
fn agrees_with_chrono_tz_everywhere() {
    let t = table();
    for tz in chrono_tz::TZ_VARIANTS.iter().copied() {
        let zone = t.zone_index(tz.name()).unwrap();
        let mut ts = TS_MIN;
        while ts < TS_MAX {
            assert_eq!(
                t.offset_at(zone, ts),
                oracle_offset(tz, ts),
                "{} at {ts}",
                tz.name()
            );
            ts += 30 * 86_400;
        }
    }
}

/// One second on either side of every stored transition -- the boundaries are where an
/// off-by-one would hide.
#[test]
fn agrees_with_chrono_tz_at_every_stored_transition() {
    let t = table();
    for tz in chrono_tz::TZ_VARIANTS.iter().copied() {
        let zone = t.zone_index(tz.name()).unwrap();
        let a = t.u32_at(t.trans_idx_at + zone * 8) as usize;
        let b = t.u32_at(t.trans_idx_at + zone * 8 + 4) as usize;
        for e in a + 1..b {
            let at = t.trans_at + e * ENTRY;
            let ts = i64::from_le_bytes(t.data[at..at + 8].try_into().unwrap());
            for probe in [ts - 1, ts, ts + 1] {
                assert_eq!(
                    t.offset_at(zone, probe),
                    oracle_offset(tz, probe),
                    "{} at {probe}",
                    tz.name()
                );
            }
        }
    }
}

#[test]
fn known_offsets() {
    let t = table();
    let winter = 1_705_276_800; // 2024-01-15
    let summer = 1_721_088_000; // 2024-07-16
    assert_eq!(t.offset_seconds("Asia/Tokyo", winter), Some(9 * 3600));
    assert_eq!(t.offset_seconds("America/New_York", winter), Some(-5 * 3600));
    assert_eq!(t.offset_seconds("America/New_York", summer), Some(-4 * 3600));
}

/// Rebuild `data/tz.bin` from chrono-tz: walk every zone in 6-hour steps across the u32
/// range, bisect each offset change to the exact second, and dedupe identical
/// transition runs across aliased zones. Run with:
/// `cargo test --manifest-path crates/tz/Cargo.toml --release -- --ignored regenerate_table`
#[test]
#[ignore]
fn regenerate_table() {
    use std::collections::HashMap;

    let mut zones: Vec<(&str, chrono_tz::Tz)> =
        chrono_tz::TZ_VARIANTS.iter().map(|tz| (tz.name(), *tz)).collect();
    zones.sort_by_key(|(name, _)| *name);

    let mut runs: HashMap<Vec<(i64, i32)>, u32> = HashMap::new();
    let mut all_entries: Vec<(i64, i32)> = Vec::new();
    let mut zone_runs: Vec<(u32, u32)> = Vec::new(); // (start entry, len) per zone

    for &(_, tz) in &zones {
        let mut entries: Vec<(i64, i32)> = vec![(i64::MIN, oracle_offset(tz, TS_MIN))];
        let mut prev_ts = TS_MIN;
        let mut prev_off = entries[0].1;
        let mut ts = TS_MIN + 21_600;
        while prev_ts < TS_MAX {
            let ts_c = ts.min(TS_MAX);
            let off = oracle_offset(tz, ts_c);
            if off != prev_off {
                // Bisect to the first second with the new offset.
                let (mut lo, mut hi) = (prev_ts, ts_c);
                while hi - lo > 1 {
                    let mid = (lo + hi) / 2;
                    if oracle_offset(tz, mid) == prev_off {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                entries.push((hi, off));
                prev_off = off;
            }
            prev_ts = ts_c;
            ts += 21_600;
        }
        let run = *runs.entry(entries.clone()).or_insert_with(|| {
            let start = all_entries.len() as u32;
            all_entries.extend_from_slice(&entries);
            start
        });
        zone_runs.push((run, entries.len() as u32));
    }

    let mut names = Vec::new();
    let mut names_idx: Vec<u32> = vec![0];
    for &(name, _) in &zones {
        names.extend_from_slice(name.as_bytes());
        names_idx.push(names.len() as u32);
    }
    // Runs are shared across aliased zones, so trans_idx stores explicit (start, end)
    // entry-index pairs rather than CSR.
    let mut out = Vec::new();
    out.extend_from_slice(b"MMTZ");
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&(zones.len() as u32).to_le_bytes());
    let names_idx_at = 32u32;
    let trans_idx_at = names_idx_at + (names_idx.len() as u32) * 4;
    let names_at = trans_idx_at + (zones.len() as u32) * 8;
    let trans_at = names_at + names.len() as u32;
    out.extend_from_slice(&names_idx_at.to_le_bytes());
    out.extend_from_slice(&trans_idx_at.to_le_bytes());
    out.extend_from_slice(&names_at.to_le_bytes());
    out.extend_from_slice(&trans_at.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    assert_eq!(out.len(), 32);
    for v in &names_idx {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for &(start, len) in &zone_runs {
        out.extend_from_slice(&start.to_le_bytes());
        out.extend_from_slice(&(start + len).to_le_bytes());
    }
    out.extend_from_slice(&names);
    for &(ts, off) in &all_entries {
        out.extend_from_slice(&ts.to_le_bytes());
        out.extend_from_slice(&off.to_le_bytes());
    }
    std::fs::write(concat!(env!("CARGO_MANIFEST_DIR"), "/../../data/tz.bin"), &out).unwrap();
    panic!(
        "regenerated: {} zones, {} entries ({} unique runs), {} bytes -- rerun the real tests now",
        zones.len(),
        all_entries.len(),
        runs.len(),
        out.len()
    );
}
