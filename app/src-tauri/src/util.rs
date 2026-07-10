//! Pure utility functions with no app-specific dependencies.
//!
//! Provides timestamps, color math, hashing, and deterministic tag color
//! assignment. No I/O, no state -- safe to call from any context.

use chrono::{DateTime, Datelike, Timelike, Utc};
use sha2::{Digest, Sha256};

/// Returns the current UTC time as an ISO 8601 string with millisecond precision.
pub fn now_iso() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Returns the current UTC time as a Unix timestamp in seconds. Location
/// timestamps use this compact form; ISO strings are only for SQLite metadata.
pub fn now_unix() -> u32 {
    Utc::now().timestamp() as u32
}

/// Parses an ISO 8601 datetime string (e.g. "2024-01-15T12:30:00Z") to Unix
/// timestamp in seconds. Accepts optional fractional seconds and trailing 'Z'.
pub fn iso_to_unix(s: &str) -> Option<f64> {
    let s = s.trim_end_matches('Z');
    chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S")
        .ok()
        .or_else(|| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f").ok())
        .map(|dt| dt.and_utc().timestamp() as f64)
}

/// Extracts (month, day) from a Unix timestamp in seconds.
pub fn unix_to_month_day(ts: f64) -> (u32, u32) {
    let dt = DateTime::<Utc>::from_timestamp(ts as i64, 0).unwrap_or_default();
    (dt.month(), dt.day())
}

/// Extracts (hour, minute) from a Unix timestamp in seconds.
pub fn unix_to_hour_min(ts: f64) -> (u32, u32) {
    let dt = DateTime::<Utc>::from_timestamp(ts as i64, 0).unwrap_or_default();
    (dt.hour(), dt.minute())
}

/// The DST-correct UTC offset (in seconds) of an IANA timezone at a given instant.
/// `None` if the timezone name doesn't parse. Used to bucket an absolute instant
/// into the wall-clock time at a location ("the date where the photo was taken").
pub fn tz_offset_seconds(tz_name: &str, ts: f64) -> Option<i32> {
    use chrono::{Offset, TimeZone};
    let tz: chrono_tz::Tz = tz_name.parse().ok()?;
    let dt = DateTime::<Utc>::from_timestamp(ts as i64, 0)?;
    Some(
        tz.offset_from_utc_datetime(&dt.naive_utc())
            .fix()
            .local_minus_utc(),
    )
}

/// Converts HSL to RGB. `h` is in degrees [0, 360), `s` and `l` in [0, 1].
pub fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (u8, u8, u8) {
    let a = s * l.min(1.0 - l);
    let f = |n: f64| -> u8 {
        let k = (n + h / 30.0) % 12.0;
        (255.0 * (l - a * (k - 3.0).min(9.0 - k).min(1.0).max(-1.0))).round() as u8
    };
    (f(0.0), f(8.0), f(4.0))
}

/// Generates a deterministic hex color string from a tag name.
///
/// Hashes the name bytes into a hue via a linear congruential generator,
/// then converts to RGB at fixed saturation/lightness (50%/50%) so every
/// tag gets a distinct, moderately saturated color that's stable across sessions.
pub fn color_for_name(name: &str) -> String {
    let mut h: i32 = 0;
    for b in name.bytes() {
        h = h.wrapping_add((b as i32).wrapping_add(h << 5));
    }
    h = h.wrapping_mul(214013).wrapping_add(2531011);
    let hue = (h.abs() % 360) as f64;
    let (r, g, b) = hsl_to_rgb(hue, 0.5, 0.5);
    format!("#{:02x}{:02x}{:02x}", r, g, b)
}

/// Parses a "#rrggbb" hex color string to an RGB byte array.
pub fn hex_to_rgb(hex: &str) -> Option<[u8; 3]> {
    let h = hex.trim_start_matches('#');
    if h.len() != 6 {
        return None;
    }
    Some([
        u8::from_str_radix(&h[0..2], 16).ok()?,
        u8::from_str_radix(&h[2..4], 16).ok()?,
        u8::from_str_radix(&h[4..6], 16).ok()?,
    ])
}

pub fn compute_bounds(coords: impl Iterator<Item = (f64, f64)>) -> Option<[f64; 4]> {
    let (mut w, mut s, mut e, mut n) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    let mut count = 0usize;
    for (lat, lng) in coords {
        if lng < w {
            w = lng;
        }
        if lat < s {
            s = lat;
        }
        if lng > e {
            e = lng;
        }
        if lat > n {
            n = lat;
        }
        count += 1;
    }
    if count == 0 {
        None
    } else {
        Some([w, s, e, n])
    }
}

/// SHA-256 hash of `bytes` as a lowercase hex string.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(digest.len() * 2);
    for b in digest.iter() {
        use std::fmt::Write;
        write!(&mut s, "{:02x}", b).unwrap();
    }
    s
}

#[cfg(test)]
#[path = "util.test.rs"]
mod tests;
