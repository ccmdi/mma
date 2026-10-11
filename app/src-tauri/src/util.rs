//! Pure utility functions with no app-specific dependencies.
//!
//! Provides timestamps, color math, hashing, and deterministic tag color
//! assignment. No I/O, no state -- safe to call from any context.

use crate::types::{AppError, AppResult};
use chrono::{DateTime, Datelike, Timelike, Utc};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;
use std::sync::OnceLock;
use tauri::async_runtime;

/// The ISO 8601 form every SQLite timestamp column is written in.
const ISO_FMT: &str = "%Y-%m-%dT%H:%M:%S%.3fZ";

/// Returns the current UTC time as an ISO 8601 string with millisecond precision.
pub fn now_iso() -> String {
    Utc::now().format(ISO_FMT).to_string()
}

/// Formats a Unix timestamp in milliseconds the same way [`now_iso`] does.
pub fn unix_ms_to_iso(ms: i64) -> Option<String> {
    DateTime::from_timestamp_millis(ms).map(|d| d.format(ISO_FMT).to_string())
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

pub fn unix_to_month_day(ts: f64) -> (u32, u32) {
    let dt = DateTime::<Utc>::from_timestamp(ts as i64, 0).unwrap_or_default();
    (dt.month(), dt.day())
}

pub fn unix_to_hour_min(ts: f64) -> (u32, u32) {
    let dt = DateTime::<Utc>::from_timestamp(ts as i64, 0).unwrap_or_default();
    (dt.hour(), dt.minute())
}

/// The DST-correct UTC offset (in seconds) of an IANA timezone at a given instant.
/// `None` if the timezone name doesn't parse. Used to bucket an absolute instant
/// into the wall-clock time at a location ("the date where the photo was taken").
/// The name→Tz parse is memoized per thread (called per row in filter resolves);
/// the offset itself is always computed per instant so DST stays correct.
/// The shared coordinate->IANA-zone grid (used by the `timezone_at` command and the
/// procedure sandbox's `mma.tz`).
pub fn tz_grid() -> &'static mma_tz::TzGrid<'static> {
    static GRID_TABLE: &[u8] = include_bytes!("../data/tzgrid.bin");
    static GRID: OnceLock<mma_tz::TzGrid<'static>> = OnceLock::new();
    GRID.get_or_init(|| mma_tz::TzGrid::new(GRID_TABLE).expect("tzgrid.bin: invalid table"))
}

/// Show the window with the system open animation, maximized if `maximized` is set.
// A true first show() (DWM plays its pop-in), then maximize back-to-back while the shell is
// still blank. The show must come first: maximize on a hidden window reveals it without
// setting tao's visible flag, and the window gets re-hidden a frame later.
#[tauri::command]
#[specta::specta]
#[allow(
    clippy::needless_pass_by_value,
    reason = "tauri injects the calling window by value"
)]
pub fn reveal_window(window: tauri::WebviewWindow, maximized: bool) {
    let _ = window.show();
    if maximized {
        let _ = window.maximize();
    }
    let _ = window.set_focus();
}

/// IANA timezone at a coordinate, or `null` outside the valid range.
#[tauri::command]
#[specta::specta]
pub fn timezone_at(lat: f64, lng: f64) -> Option<String> {
    tz_grid().zone_at(lat, lng).map(str::to_owned)
}

pub fn tz_offset_seconds(tz_name: &str, ts: f64) -> Option<i32> {
    static TZ_TABLE: &[u8] = include_bytes!("../data/tz.bin");
    static TABLE: OnceLock<mma_tz::Tz<'static>> = OnceLock::new();
    thread_local! {
        static TZ_CACHE: RefCell<HashMap<String, Option<usize>>> = RefCell::new(HashMap::new());
    }
    let table = TABLE.get_or_init(|| mma_tz::Tz::new(TZ_TABLE).expect("tz.bin: invalid table"));
    let zone = TZ_CACHE.with(|c| {
        let mut m = c.borrow_mut();
        match m.get(tz_name) {
            Some(v) => *v,
            None => {
                let v = table.zone_index(tz_name);
                m.insert(tz_name.to_owned(), v);
                v
            }
        }
    })?;
    Some(table.offset_at(zone, ts as i64))
}

/// A colour as red, green and blue bytes, serialized as `[r, g, b]`.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, specta::Type,
)]
#[serde(transparent)]
#[serde(rename = "RGB")]
pub struct Rgb(pub [u8; 3]);

impl Rgb {
    /// `h` is in degrees [0, 360), `s` and `l` in [0, 1].
    #[allow(
        clippy::manual_clamp,
        reason = "the min/max chain scrubs a NaN that clamp would carry into the u8 cast"
    )]
    pub fn hsl(h: f64, s: f64, l: f64) -> Self {
        let a = s * l.min(1.0 - l);
        Rgb([0.0, 8.0, 4.0].map(|n| {
            let k = (n + h / 30.0) % 12.0;
            (255.0 * (l - a * (k - 3.0).min(9.0 - k).min(1.0).max(-1.0))).round() as u8
        }))
    }

    /// A tag's colour when it has none of its own: a hue hashed from its name, stable
    /// across sessions.
    pub fn for_name(name: &str) -> Self {
        let mut h: i32 = 0;
        for b in name.bytes() {
            h = h.wrapping_add((b as i32).wrapping_add(h << 5));
        }
        h = h.wrapping_mul(214013).wrapping_add(2531011);
        Rgb::hsl((h.abs() % 360) as f64, 0.5, 0.5)
    }
}

/// `#rrggbb` or `#rgb`, with or without the `#`.
impl FromStr for Rgb {
    type Err = AppError;

    fn from_str(hex: &str) -> AppResult<Self> {
        let h = hex.trim_start_matches('#');
        let h: String = match h.len() {
            3 => h.chars().flat_map(|c| [c, c]).collect(),
            6 => h.into(),
            _ => return Err(AppError(format!("'{hex}' is not a hex colour"))),
        };
        let n = u32::from_str_radix(&h, 16)
            .map_err(|_| AppError(format!("'{hex}' is not a hex colour")))?;
        Ok(Rgb([(n >> 16) as u8, (n >> 8) as u8, n as u8]))
    }
}

/// `#rrggbb`.
impl fmt::Display for Rgb {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let [r, g, b] = self.0;
        write!(f, "#{r:02x}{g:02x}{b:02x}")
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = sha256(bytes);
    let mut s = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write;
        write!(&mut s, "{b:02x}").unwrap();
    }
    s
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Run a blocking body off the async runtime's worker thread.
///
/// The HTTP clients are `reqwest::blocking`, so every command that reaches the network needs
/// this; awaiting one inline would stall the runtime.
pub async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> AppResult<T> {
    async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("task failed: {e}").into())
}

#[cfg(test)]
#[path = "util.test.rs"]
mod tests;
