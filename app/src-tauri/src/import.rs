//! Import pipeline for JSON, CSV, and ZIP files containing map location data.
//!
//! Two import paths: **bulk import** creates new maps from files, and **editor
//! import** merges locations into the currently open map. JSON parsing uses
//! serde_json with parallel object deserialization via rayon. A two-phase
//! preview/confirm flow lets the user inspect data before committing.

use crate::types::AppResult;
use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Read;
use std::sync::Mutex;

use crate::util::{now_iso, now_unix};
use rayon::prelude::*;
use rusqlite::Connection;
use serde_json::Value;
use uuid::Uuid;

use crate::arrow_bridge;
use crate::location_store;
use crate::storage;
use crate::types::{is_ws, skip_string, Location, LocationFlags, Tag};

/// Read a file with sequential-scan hints for better OS prefetch on cold reads.
fn read_sequential(path: &str) -> std::io::Result<Vec<u8>> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_SEQUENTIAL_SCAN: u32 = 0x0800_0000;
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_SEQUENTIAL_SCAN)
            .open(path)?;
        let mut buf = Vec::with_capacity(file.metadata()?.len() as usize);
        std::io::Read::read_to_end(&mut file, &mut buf)?;
        Ok(buf)
    }
    #[cfg(not(windows))]
    {
        std::fs::read(path)
    }
}

/// Cached result from `bulk_import_preview` so `bulk_import_confirm` can
/// skip re-parsing. Keyed by file path to detect stale caches.
// TODO: single slot — multi-file bulk import only caches the last file; earlier ones re-parse.
static CACHED_PARSE: Mutex<Option<CachedImport>> = Mutex::new(None);

struct CachedImport {
    path: String,
    maps: Vec<ParsedMap>,
}

// ---------------------------------------------------------------------------
// Types returned to JS
// ---------------------------------------------------------------------------

/// Summary of a single map found during bulk import preview.
/// Shown in the import dialog so the user can select which maps to import.
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewEntry {
    pub name: String,
    pub folder: Option<String>,
    pub location_count: u32,
    pub tag_count: u32,
    pub warnings: Vec<String>,
}

/// Result returned per map after a successful bulk import.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMapInfo {
    pub id: String,
    pub name: String,
    pub location_count: u32,
    pub tag_count: u32,
}

// ---------------------------------------------------------------------------
// Internal parsed structures
// ---------------------------------------------------------------------------

/// Intermediate representation produced by all parsers (JSON, CSV, ZIP entry).
/// Locations have placeholder IDs (0) -- real IDs are assigned at insert time.
struct ParsedMap {
    name: String,
    folder: Option<String>,
    locations: Vec<Location>,
    tags: Vec<Tag>,
    fields: Option<Value>,
    warnings: Vec<String>,
    /// Map settings carried by the import (`extra.settings`)
    settings: serde_json::Map<String, Value>,
}

use crate::util::color_for_name;

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/// Parse CSV text into locations. Supports both named columns (lat/lng/heading/etc.)
/// and positional (first two numeric columns = lat, lng). Skips malformed rows silently.
fn parse_csv(text: &str) -> ParsedMap {
    let empty = || ParsedMap {
        name: String::new(),
        folder: None,
        locations: Vec::new(),
        tags: Vec::new(),
        fields: None,
        warnings: Vec::new(),
        settings: serde_json::Map::new(),
    };
    let warn = |w: &str| {
        let mut m = empty();
        m.warnings.push(w.into());
        m
    };

    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());

    let mut rows = rdr.records();
    let first = match rows.next() {
        Some(Ok(r)) => r,
        _ => return warn("Empty CSV"),
    };

    let lower: Vec<String> = first.iter().map(|f| f.trim().to_lowercase()).collect();
    let lat_named = lower.iter().position(|h| h == "lat" || h == "latitude");
    let lng_named = lower
        .iter()
        .position(|h| h == "lng" || h == "longitude" || h == "lon");

    let (lat_idx, lng_idx, heading_idx, pitch_idx, zoom_idx, pano_idx, first_is_header) =
        if let (Some(la), Some(ln)) = (lat_named, lng_named) {
            (
                la,
                ln,
                lower.iter().position(|h| h == "heading"),
                lower.iter().position(|h| h == "pitch"),
                lower.iter().position(|h| h == "zoom"),
                lower
                    .iter()
                    .position(|h| h == "pano" || h == "panoid" || h == "pano_id"),
                true,
            )
        } else {
            let is_num = |s: &str| s.trim().parse::<f64>().map(f64::is_finite).unwrap_or(false);
            if !(first.get(0).is_some_and(is_num) && first.get(1).is_some_and(is_num)) {
                return warn("CSV missing lat/lng columns");
            }
            (0, 1, None, None, None, None, false)
        };

    let now = now_unix();
    let mut locations = Vec::new();

    let parse_row = |record: &csv::StringRecord| -> Option<Location> {
        let lat: f64 = record
            .get(lat_idx)?
            .trim()
            .parse()
            .ok()
            .filter(|v: &f64| v.is_finite())?;
        let lng: f64 = record
            .get(lng_idx)?
            .trim()
            .parse()
            .ok()
            .filter(|v: &f64| v.is_finite())?;
        let heading = heading_idx
            .and_then(|i| record.get(i)?.trim().parse().ok())
            .unwrap_or(0.0);
        let pitch = pitch_idx
            .and_then(|i| record.get(i)?.trim().parse().ok())
            .unwrap_or(0.0);
        let zoom = zoom_idx
            .and_then(|i| record.get(i)?.trim().parse().ok())
            .unwrap_or(0.0);
        let pano_id = pano_idx.and_then(|i| {
            let s = record.get(i)?.trim();
            if s.is_empty() {
                None
            } else {
                Some(s.to_string())
            }
        });
        let flags = if pano_id.is_some() {
            LocationFlags::LOAD_AS_PANO_ID
        } else {
            LocationFlags::empty()
        };
        Some(Location {
            id: 0,
            lat,
            lng,
            heading,
            pitch,
            zoom,
            pano_id,
            flags,
            tags: Vec::new(),
            extra: None,
            created_at: now,
            modified_at: None,
        })
    };

    if !first_is_header {
        if let Some(loc) = parse_row(&first) {
            locations.push(loc);
        }
    }

    for result in rows {
        let Ok(record) = result else { continue };
        if let Some(loc) = parse_row(&record) {
            locations.push(loc);
        }
    }

    ParsedMap {
        name: String::new(),
        folder: None,
        locations,
        tags: Vec::new(),
        fields: None,
        warnings: Vec::new(),
        settings: serde_json::Map::new(),
    }
}

struct ExtraTagMeta {
    color: Option<String>,
    order: Option<u32>,
}

/// Parse the top-level `"extra"` object (sibling of the coordinate array) into a
/// JSON Value without parsing the entire document. Uses a manual depth-tracking
/// scanner to find the `"extra"` key at depth 1, avoiding a full-document parse on
/// multi-MB files. Callers that already know where the coordinate array ends pass
/// `start` (just past the last object) + `start_depth` (2, still inside the array)
/// so we scan only the tiny tail. Shared by tag-meta and settings extraction.
fn find_top_level_extra(buf: &[u8], start: usize, start_depth: i32) -> Option<serde_json::Value> {
    let needle = b"\"extra\"";
    let mut i = start;
    let mut depth = start_depth;
    let mut in_str = false;
    let mut esc2 = false;
    let mut pos = None;
    while i < buf.len() {
        if esc2 {
            esc2 = false;
            i += 1;
            continue;
        }
        if buf[i] == b'\\' && in_str {
            esc2 = true;
            i += 1;
            continue;
        }
        if !in_str
            && depth == 1
            && buf[i] == b'"'
            && i + needle.len() <= buf.len()
            && &buf[i..i + needle.len()] == needle
        {
            pos = Some(i);
            break;
        }
        if buf[i] == b'"' {
            in_str = !in_str;
            i += 1;
            continue;
        }
        if in_str {
            i += 1;
            continue;
        }
        if buf[i] == b'{' || buf[i] == b'[' {
            depth += 1;
        }
        if buf[i] == b'}' || buf[i] == b']' {
            depth -= 1;
        }
        i += 1;
    }
    let pos = pos?;
    let mut j = pos + needle.len();
    while j < buf.len() && matches!(buf[j], b' ' | b':' | b'\n' | b'\r' | b'\t') {
        j += 1;
    }
    if j >= buf.len() || buf[j] != b'{' {
        return None;
    }
    let obj_start = j;
    let mut depth = 1i32;
    let mut k = obj_start + 1;
    let mut in_str = false;
    let mut esc = false;
    while k < buf.len() && depth > 0 {
        if esc {
            esc = false;
            k += 1;
            continue;
        }
        if buf[k] == b'\\' && in_str {
            esc = true;
            k += 1;
            continue;
        }
        if buf[k] == b'"' {
            in_str = !in_str;
            k += 1;
            continue;
        }
        if in_str {
            k += 1;
            continue;
        }
        if buf[k] == b'{' {
            depth += 1;
        }
        if buf[k] == b'}' {
            depth -= 1;
        }
        k += 1;
    }
    serde_json::from_slice(&buf[obj_start..k]).ok()
}

/// Tag color/order metadata from a parsed top-level `"extra"."tags"` block.
fn tag_meta_from_extra(extra: &serde_json::Value) -> HashMap<String, ExtraTagMeta> {
    let mut meta = HashMap::new();
    if let Some(tags_obj) = extra.get("tags").and_then(|t| t.as_object()) {
        for (name, entry) in tags_obj {
            let color = entry
                .get("color")
                .and_then(|c| c.as_array())
                .and_then(|arr| {
                    if arr.len() >= 3 {
                        let r = arr[0].as_u64().unwrap_or(0) as u8;
                        let g = arr[1].as_u64().unwrap_or(0) as u8;
                        let b = arr[2].as_u64().unwrap_or(0) as u8;
                        Some(format!("#{:02x}{:02x}{:02x}", r, g, b))
                    } else {
                        None
                    }
                });
            let order = entry
                .get("order")
                .and_then(|o| o.as_u64())
                .map(|o| o as u32);
            meta.insert(name.clone(), ExtraTagMeta { color, order });
        }
    }
    meta
}

/// Map settings carried by an import, from a parsed top-level `"extra"."settings"` block.
fn settings_from_extra(extra: &serde_json::Value) -> serde_json::Map<String, Value> {
    extra
        .get("settings")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/// Auto-detect format (JSON vs CSV) by first non-whitespace byte and dispatch.
fn parse_file(buf: &mut [u8]) -> ParsedMap {
    let trimmed = buf
        .iter()
        .position(|&b| !b.is_ascii_whitespace())
        .unwrap_or(0);
    match buf.get(trimmed) {
        Some(b'{') | Some(b'[') => parse_single_json_mut(buf),
        _ => {
            let text = String::from_utf8_lossy(buf);
            parse_csv(&text)
        }
    }
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

fn parse_single_json(text: &str) -> ParsedMap {
    let mut buf = text.as_bytes().to_vec();
    parse_single_json_mut(&mut buf)
}

/// Scan raw bytes for `{...}` object boundaries inside a JSON array.
/// Returns `(ranges, array_end)` where `array_end` is the offset of the array's
/// closing `]` (or `bytes.len()` if unterminated). Stops there so trailing
/// top-level keys (e.g. a sibling `"extra"`) aren't mistaken for objects.
///
/// SIMD-accelerated via memchr: we jump directly between the structural bytes
/// (`"`, `{`, `}`) and skip string bodies wholesale, instead of branching on
/// every byte. This is the precursor to parallel parsing — we find boundaries
/// in one pass, then hand each slice to rayon.
fn find_object_boundaries(bytes: &[u8]) -> (Vec<(usize, usize)>, usize) {
    let mut ranges = Vec::with_capacity(bytes.len() / 96);
    let mut depth = 0i32;
    let mut obj_start = 0usize;
    let mut i = 0usize;

    // The array's closing `]` is the first `]` at or after the end of the last
    // top-level object (nested `extra.tags` arrays close at depth > 0, before it).
    let array_close = |ranges: &[(usize, usize)]| -> usize {
        let from = ranges.last().map_or(0, |r| r.1);
        memchr::memchr(b']', &bytes[from..]).map_or(bytes.len(), |o| from + o)
    };

    while let Some(off) = memchr::memchr3(b'"', b'{', b'}', &bytes[i..]) {
        let pos = i + off;
        match bytes[pos] {
            b'{' => {
                if depth == 0 {
                    obj_start = pos;
                }
                depth += 1;
                i = pos + 1;
            }
            b'}' => {
                depth -= 1;
                i = pos + 1;
                if depth == 0 {
                    ranges.push((obj_start, pos + 1));
                } else if depth < 0 {
                    // Root object's `}` after the array — array already ended.
                    let close = array_close(&ranges);
                    return (ranges, close);
                }
            }
            // A quote at array level (depth 0) is a sibling key like "extra" —
            // we've passed the array's `]`. Inside an object, skip the string.
            _ => {
                if depth == 0 {
                    let close = array_close(&ranges);
                    return (ranges, close);
                }
                i = skip_string(bytes, pos + 1);
            }
        }
    }
    (ranges, bytes.len())
}

/// Boundary scan of `[start, limit)` for depth-0 `{...}` objects (absolute offsets).
/// Returns `(ranges, end_depth, terminated_close)`. `terminated_close` is `Some`
/// only when the array's end is reached (`}` past depth 0, or a depth-0 sibling key
/// quote) — that happens in the final chunk. A well-formed non-final chunk ends with
/// `end_depth == 0` and `terminated_close == None`; anything else means the chunk's
/// start landed at a false boundary and the caller falls back to serial.
fn scan_range(
    bytes: &[u8],
    start: usize,
    limit: usize,
) -> (Vec<(usize, usize)>, i32, Option<usize>) {
    let mut ranges: Vec<(usize, usize)> = Vec::with_capacity((limit - start) / 96);
    let mut depth = 0i32;
    let mut obj_start = 0usize;
    let mut i = start;
    let array_close = |ranges: &[(usize, usize)]| -> usize {
        let from = ranges.last().map_or(start, |r| r.1);
        memchr::memchr(b']', &bytes[from..]).map_or(bytes.len(), |o| from + o)
    };
    while i < limit {
        let Some(off) = memchr::memchr3(b'"', b'{', b'}', &bytes[i..limit]) else {
            break;
        };
        let pos = i + off;
        match bytes[pos] {
            b'{' => {
                if depth == 0 {
                    obj_start = pos;
                }
                depth += 1;
                i = pos + 1;
            }
            b'}' => {
                depth -= 1;
                i = pos + 1;
                if depth == 0 {
                    ranges.push((obj_start, pos + 1));
                } else if depth < 0 {
                    let c = array_close(&ranges);
                    return (ranges, depth, Some(c));
                }
            }
            _ => {
                if depth == 0 {
                    let c = array_close(&ranges);
                    return (ranges, depth, Some(c));
                }
                i = skip_string(bytes, pos + 1); // may cross `limit`; a string stays within its object
            }
        }
    }
    (ranges, depth, None)
}

/// Find the start `{` of the next top-level object at/after `from`. Prefers a
/// newline boundary (a raw newline never appears inside a JSON string, so this is
/// always a safe split for newline-delimited exports); falls back to a `}`,`{`
/// separator scan for minified single-line input. A wrong guess can't corrupt the
/// result — `parallel_find_object_boundaries` validates and falls back to serial.
fn resync_object_start(bytes: &[u8], from: usize) -> usize {
    let len = bytes.len();
    if let Some(nl) = memchr::memchr(b'\n', &bytes[from..]) {
        let mut j = from + nl + 1;
        while j < len && is_ws(bytes[j]) {
            j += 1;
        }
        if j < len && bytes[j] == b'{' {
            return j;
        }
    }
    let mut i = from;
    while let Some(off) = memchr::memchr(b'}', &bytes[i..]) {
        let p = i + off;
        let mut k = p + 1;
        while k < len && is_ws(bytes[k]) {
            k += 1;
        }
        if k < len && bytes[k] == b',' {
            let mut m = k + 1;
            while m < len && is_ws(bytes[m]) {
                m += 1;
            }
            if m < len && bytes[m] == b'{' {
                return m;
            }
        }
        i = p + 1;
    }
    len
}

/// Parallel counterpart to `find_object_boundaries`. Splits the array bytes into
/// per-core ranges, resyncs each range start to a real object boundary, scans them
/// concurrently, then validates (each non-final range ends at depth 0; no overlaps).
/// On any inconsistency — or for small inputs — it falls back to the serial scan, so
/// the output is always byte-identical to `find_object_boundaries`.
fn parallel_find_object_boundaries(bytes: &[u8]) -> (Vec<(usize, usize)>, usize) {
    let len = bytes.len();
    let threads = rayon::current_num_threads();
    if len < 2_000_000 || threads < 2 {
        return find_object_boundaries(bytes);
    }

    let mut starts = Vec::with_capacity(threads + 1);
    starts.push(0usize);
    for i in 1..threads {
        let s = resync_object_start(bytes, (len / threads) * i);
        if s >= len {
            break;
        }
        if s > *starts.last().unwrap() {
            starts.push(s);
        }
    }
    starts.push(len);
    let k = starts.len() - 1;
    if k < 2 {
        return find_object_boundaries(bytes);
    }

    let parts: Vec<(Vec<(usize, usize)>, i32, Option<usize>)> = (0..k)
        .into_par_iter()
        .map(|i| scan_range(bytes, starts[i], starts[i + 1]))
        .collect();

    // A false split shows up as the *previous* range not ending cleanly at depth 0.
    for p in &parts[..k - 1] {
        if p.1 != 0 || p.2.is_some() {
            return find_object_boundaries(bytes);
        }
    }
    let mut ranges: Vec<(usize, usize)> = Vec::with_capacity(len / 96);
    for (r, _, _) in &parts[..k - 1] {
        ranges.extend_from_slice(r);
    }
    let (last_r, last_depth, last_close) = &parts[k - 1];
    ranges.extend_from_slice(last_r);
    if *last_depth > 0 && last_close.is_none() {
        return find_object_boundaries(bytes);
    }
    for w in ranges.windows(2) {
        if w[0].1 > w[1].0 {
            return find_object_boundaries(bytes);
        }
    }
    (ranges, last_close.unwrap_or(len))
}

// ---------------------------------------------------------------------------
// Raw extra fast path: strip `tags` from an object's raw JSON without building a
// map. All scans are string/escape aware (a `[`/`]`/`"` inside a value never counts
// as structure), so this is correct on arbitrary extra content.
// ---------------------------------------------------------------------------

/// Fast path: strip the top-level `tags` array from raw extra JSON `s`, interning its
/// strings into the chunk-local tag table, and return the remaining object as `RawExtra`
/// (the exact bytes minus the `tags` member; `None` if nothing is left). `tags` are
/// parsed with serde so escapes are handled correctly. Returns `Err(())` if `tags` isn't
/// a clean top-level string array, so the caller can fall back to the map path.
fn strip_tags_fast(
    s: &str,
    names: &mut Vec<String>,
    name_to_local: &mut rustc_hash::FxHashMap<String, u32>,
    tags: &mut Vec<u32>,
) -> Result<Option<crate::types::RawExtra>, ()> {
    let b = s.as_bytes();
    let mut span: Option<(usize, usize, usize)> = None;
    crate::types::scan_fields(b, |fs| {
        let hit = &b[fs.key.clone()] == b"tags";
        if hit {
            span = Some((fs.key.start - 1, fs.value.start, fs.value.end));
        }
        hit
    });
    let Some((kstart, vstart, vend)) = span else {
        // No tags key: keep the extra bytes verbatim.
        return Ok(crate::types::RawExtra::from_string(s.to_owned()));
    };
    if b.get(vstart) != Some(&b'[') {
        return Err(());
    }
    let Ok(list) = serde_json::from_str::<Vec<&str>>(&s[vstart..vend]) else {
        return Err(());
    };
    for name in list {
        let id = match name_to_local.get(name) {
            Some(&id) => id,
            None => {
                let id = names.len() as u32;
                names.push(name.to_owned());
                name_to_local.insert(name.to_owned(), id);
                id
            }
        };
        tags.push(id);
    }
    // Strip `"tags":[...]` plus one adjacent comma.
    let (mut mstart, mut mend) = (kstart, vend);
    let mut p = mstart;
    while p > 0 && is_ws(b[p - 1]) {
        p -= 1;
    }
    if p > 0 && b[p - 1] == b',' {
        mstart = p - 1;
    } else {
        let mut q = mend;
        while q < b.len() && is_ws(b[q]) {
            q += 1;
        }
        if q < b.len() && b[q] == b',' {
            mend = q + 1;
        }
    }
    let mut out = String::with_capacity(s.len() - (mend - mstart));
    out.push_str(&s[..mstart]);
    out.push_str(&s[mend..]);
    Ok(crate::types::RawExtra::from_string(out))
}

/// Slow path: build a `serde_json::Map` from raw `extra`, fold in non-null top-level
/// `countryCode`/`stateCode`, intern + strip `tags`, and pull a nested `panoId` fallback
/// into `out_pano`. Used only when the fast byte path can't apply (rare).
fn build_extra_via_map(
    extra_str: Option<&str>,
    country_code: Option<&serde_json::value::RawValue>,
    state_code: Option<&serde_json::value::RawValue>,
    names: &mut Vec<String>,
    name_to_local: &mut rustc_hash::FxHashMap<String, u32>,
    tags: &mut Vec<u32>,
    out_pano: &mut Option<String>,
) -> Option<crate::types::RawExtra> {
    let mut m: serde_json::Map<String, Value> = extra_str
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_default();
    if let Some(cc) = country_code {
        m.entry("countryCode")
            .or_insert_with(|| serde_json::from_str(cc.get()).unwrap_or(Value::Null));
    }
    if let Some(sc) = state_code {
        m.entry("stateCode")
            .or_insert_with(|| serde_json::from_str(sc.get()).unwrap_or(Value::Null));
    }
    if let Some(Value::Array(arr)) = m.remove("tags") {
        for v in arr {
            let Value::String(s) = v else { continue };
            let id = match name_to_local.get(s.as_str()) {
                Some(&id) => id,
                None => {
                    let id = names.len() as u32;
                    names.push(s.clone());
                    name_to_local.insert(s, id);
                    id
                }
            };
            tags.push(id);
        }
    }
    *out_pano = m.remove("panoId").and_then(|v| match v {
        Value::String(s) => Some(s),
        _ => None,
    });
    crate::types::RawExtra::from_map(&m)
}

/// Core JSON parser. Three-phase pipeline:
/// 1. **Scan** -- find metadata keys (`name`, `folder`) in the first 4-8KB,
///    then locate the coordinate array (`customCoordinates` or `locations`).
/// 2. **Boundary detection** -- single-pass scanner finds each `{...}` object
///    boundary inside the coordinate array.
/// 3. **Parallel parse** -- rayon hands each object slice to serde_json for
///    deserialization. Non-coordinate fields are collected into `extra`.
///
/// Tag names from `extra.tags` arrays are collected and deduplicated; tag
/// metadata (colors, order) is extracted separately from the top-level `extra`.
fn parse_single_json_mut(buf: &mut [u8]) -> ParsedMap {
    let mut warnings = Vec::new();
    let t0 = std::time::Instant::now();

    // Single pass: find top-level keys and the coordinate array.
    // Only scan until we find what we need — once we hit the array,
    // we know the rest is coordinates and can stop scanning keys.
    let mut name = String::new();
    let mut folder: Option<String> = None;
    let mut arr_range: Option<(usize, usize)> = None;
    fn find_key_value_fast(buf: &[u8], key: &[u8]) -> Option<usize> {
        let mut i = 0;
        while i + key.len() + 3 < buf.len() {
            if buf[i] == b'"' && buf[i + 1..].starts_with(key) && buf[i + 1 + key.len()] == b'"' {
                return Some(i + key.len() + 2);
            }
            i += 1;
        }
        None
    }

    fn read_string_at(buf: &[u8], pos: usize) -> Option<(String, usize)> {
        let mut i = pos;
        while i < buf.len()
            && (buf[i] == b' '
                || buf[i] == b':'
                || buf[i] == b'\n'
                || buf[i] == b'\r'
                || buf[i] == b'\t')
        {
            i += 1;
        }
        if i >= buf.len() || buf[i] != b'"' {
            return None;
        }
        i += 1;
        let start = i;
        let mut esc = false;
        while i < buf.len() {
            if esc {
                esc = false;
                i += 1;
                continue;
            }
            if buf[i] == b'\\' {
                esc = true;
                i += 1;
                continue;
            }
            if buf[i] == b'"' {
                return Some((String::from_utf8_lossy(&buf[start..i]).to_string(), i + 1));
            }
            i += 1;
        }
        None
    }

    fn find_array_start(buf: &[u8], pos: usize) -> Option<usize> {
        let mut i = pos;
        while i < buf.len()
            && (buf[i] == b' '
                || buf[i] == b':'
                || buf[i] == b'\n'
                || buf[i] == b'\r'
                || buf[i] == b'\t')
        {
            i += 1;
        }
        if i >= buf.len() || buf[i] != b'[' {
            return None;
        }
        Some(i + 1)
    }

    // Top-level metadata keys are always in the first few KB
    let header = &buf[..buf.len().min(4096)];
    if let Some(pos) = find_key_value_fast(header, b"name") {
        if let Some((s, _)) = read_string_at(header, pos) {
            name = s;
        }
    }
    if let Some(pos) = find_key_value_fast(header, b"folder") {
        if let Some((s, _)) = read_string_at(header, pos) {
            folder = Some(s);
        }
    }

    // Array key is also near the top — search first 8KB, fall back to full scan
    let key_search = &buf[..buf.len().min(8192)];
    if let Some(pos) = find_key_value_fast(key_search, b"customCoordinates") {
        if let Some(s) = find_array_start(buf, pos) {
            arr_range = Some((s, buf.len()));
        }
    }
    if arr_range.is_none() {
        if let Some(pos) = find_key_value_fast(key_search, b"locations") {
            if let Some(s) = find_array_start(buf, pos) {
                arr_range = Some((s, buf.len()));
            }
        }
    }
    if arr_range.is_none() {
        if let Some(s) = find_array_start(buf, 0) {
            arr_range = Some((s, buf.len()));
        }
    }

    let (arr_start, arr_end) = match arr_range {
        Some(r) => r,
        None => {
            warnings.push("No recognized coordinate array found".to_string());
            return ParsedMap {
                name,
                folder,
                locations: Vec::new(),
                tags: Vec::new(),
                fields: None,
                warnings,
                settings: serde_json::Map::new(),
            };
        }
    };

    let t_scan = t0.elapsed();

    // Find object boundaries within the array (parallel; falls back to serial on any
    // inconsistency, so the result is always identical to find_object_boundaries).
    let (obj_ranges, arr_close) = parallel_find_object_boundaries(&buf[arr_start..arr_end]);
    let t_boundaries = t0.elapsed();

    let now = now_unix();

    #[derive(serde::Deserialize)]
    struct RawObj<'a> {
        #[serde(alias = "latitude")]
        lat: Option<f64>,
        #[serde(alias = "longitude", alias = "lon")]
        lng: Option<f64>,
        #[serde(default)]
        heading: f64,
        #[serde(default)]
        pitch: f64,
        #[serde(default)]
        zoom: f64,
        #[serde(borrow, rename = "panoId", alias = "pano", alias = "pano_id")]
        pano_id: Option<Cow<'a, str>>,
        // Raw slices (no value tree). `null` deserializes to `None`, so `Some` means a
        // real value that must be folded into `extra`.
        #[serde(borrow, rename = "countryCode")]
        country_code: Option<&'a serde_json::value::RawValue>,
        #[serde(borrow, rename = "stateCode")]
        state_code: Option<&'a serde_json::value::RawValue>,
        #[serde(borrow)]
        extra: Option<&'a serde_json::value::RawValue>,
    }

    // Each worker parses a contiguous chunk and dedups tag names *locally*: the
    // ~millions of duplicate tag strings serde allocates are freed inside the
    // parallel region (only the few distinct names per chunk survive), and each
    // Location stores chunk-local tag ids. The serial merge below maps locals to
    // globals — a cheap pass over u32s, no string work.
    struct ChunkOut {
        locs: Vec<Location>,
        names: Vec<String>, // local id (index) -> tag name
    }

    let arr_slice = &buf[arr_start..arr_end];
    let chunk_size = (obj_ranges.len() / (rayon::current_num_threads() * 4)).max(1);
    let chunks: Vec<ChunkOut> = obj_ranges
        .par_chunks(chunk_size)
        .map(|chunk| {
            let mut names: Vec<String> = Vec::new();
            let mut name_to_local: rustc_hash::FxHashMap<String, u32> =
                rustc_hash::FxHashMap::default();
            let mut locs: Vec<Location> = Vec::with_capacity(chunk.len());

            for &(start, end) in chunk {
                let Ok(raw) = serde_json::from_slice::<RawObj<'_>>(&arr_slice[start..end]) else {
                    continue;
                };
                let (lat, lng) = match (raw.lat, raw.lng) {
                    (Some(la), Some(ln)) if la.is_finite() && ln.is_finite() => (la, ln),
                    _ => continue,
                };

                let has_top_pano = raw.pano_id.is_some();
                let top_pano = raw.pano_id.map(|c| c.into_owned());
                let extra_str = raw.extra.map(|rv| rv.get());

                // Fast path unless we must edit `extra` beyond stripping tags: folding a
                // non-null top-level country/state code, or a `panoId` nested in `extra`.
                let need_map = raw.country_code.is_some()
                    || raw.state_code.is_some()
                    || extra_str.is_some_and(|s| {
                        memchr::memmem::find(s.as_bytes(), b"\"panoId\"").is_some()
                    });

                let mut tags: Vec<u32> = Vec::new();
                let mut extra_pano: Option<String> = None;
                let fast = !need_map && extra_str.is_some();
                let extra = if fast {
                    match strip_tags_fast(
                        extra_str.unwrap(),
                        &mut names,
                        &mut name_to_local,
                        &mut tags,
                    ) {
                        Ok(extra) => extra,
                        Err(()) => build_extra_via_map(
                            extra_str,
                            raw.country_code,
                            raw.state_code,
                            &mut names,
                            &mut name_to_local,
                            &mut tags,
                            &mut extra_pano,
                        ),
                    }
                } else if need_map {
                    build_extra_via_map(
                        extra_str,
                        raw.country_code,
                        raw.state_code,
                        &mut names,
                        &mut name_to_local,
                        &mut tags,
                        &mut extra_pano,
                    )
                } else {
                    None // no extra at all
                };

                let pano_id = top_pano.or(extra_pano);
                let flags = if has_top_pano {
                    LocationFlags::LOAD_AS_PANO_ID
                } else {
                    LocationFlags::empty()
                };

                locs.push(Location {
                    id: 0,
                    lat,
                    lng,
                    heading: raw.heading,
                    pitch: raw.pitch,
                    zoom: raw.zoom,
                    pano_id,
                    flags,
                    tags,
                    extra,
                    created_at: now,
                    modified_at: None,
                });
            }
            ChunkOut { locs, names }
        })
        .collect();

    let t_parse = t0.elapsed();

    // Top-level "extra" sits after the coordinate array; start the scan at the
    // array's closing `]` (depth 2, the `]` drops it to 1) instead of rescanning
    // the whole buffer. Parse it once, derive both tag meta and virtual tags.
    let extra_val = find_top_level_extra(buf, arr_start + arr_close, 2);
    let tag_meta = extra_val
        .as_ref()
        .map(tag_meta_from_extra)
        .unwrap_or_default();
    let settings = extra_val
        .as_ref()
        .map(settings_from_extra)
        .unwrap_or_default();

    // Merge chunk-local tag tables into one global table, remapping each chunk's
    // local ids to global ids in place.
    let total: usize = chunks.iter().map(|c| c.locs.len()).sum();
    let mut tags_by_name: HashMap<String, u32> = HashMap::new();
    let mut next_tag: u32 = 1;
    let mut locations = Vec::with_capacity(total);
    for chunk in chunks {
        let ChunkOut { mut locs, names } = chunk;
        let local_to_global: Vec<u32> = names
            .into_iter()
            .map(|name| {
                *tags_by_name.entry(name).or_insert_with(|| {
                    let id = next_tag;
                    next_tag += 1;
                    id
                })
            })
            .collect();
        for loc in &mut locs {
            for t in &mut loc.tags {
                *t = local_to_global[*t as usize];
            }
        }
        locations.append(&mut locs);
    }
    let t_merge = t0.elapsed();

    let mut tags: Vec<Tag> = tags_by_name
        .into_iter()
        .map(|(name, id)| {
            let meta = tag_meta.get(&name);
            let color = meta
                .and_then(|m| m.color.clone())
                .unwrap_or_else(|| color_for_name(&name));
            let order = meta.and_then(|m| m.order);
            Tag {
                id,
                name,
                color,
                visible: true,
                order,
                count: 0,
            }
        })
        .collect();
    tags.sort_by(|a, b| {
        a.order
            .unwrap_or(u32::MAX)
            .cmp(&b.order.unwrap_or(u32::MAX))
            .then_with(|| a.name.cmp(&b.name))
    });

    log::debug!(
        "[parse] scan={:.0}ms boundaries={:.0}ms parse={:.0}ms merge={:.0}ms total={:.0}ms objs={}",
        t_scan.as_millis(),
        (t_boundaries - t_scan).as_millis(),
        (t_parse - t_boundaries).as_millis(),
        (t_merge - t_parse).as_millis(),
        t0.elapsed().as_millis(),
        locations.len()
    );

    ParsedMap {
        name,
        folder,
        locations,
        tags,
        fields: None,
        warnings,
        settings,
    }
}

// ---------------------------------------------------------------------------
// Zip orchestration
// ---------------------------------------------------------------------------

fn read_zip_entries(path: &str) -> AppResult<Vec<(String, String)>> {
    let file = std::fs::File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip: {}", e))?;

    let mut entries = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if entry.is_dir() || !entry.name().ends_with(".json") {
            continue;
        }
        let name = entry.name().to_string();
        let mut text = String::new();
        entry.read_to_string(&mut text)?;
        entries.push((name, text));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}

fn read_single_json(path: &str) -> AppResult<Vec<(String, String)>> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("Failed to read file: {}", e))?;
    let filename = std::path::Path::new(path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(vec![(filename, text)])
}

// ---------------------------------------------------------------------------
// DB write
// ---------------------------------------------------------------------------

/// Sole place an import's settings become `MapSettings`. Overlays the import's
/// settings keys (`extra.settings`) onto `base` (defaults for a new map, the open
/// map's current settings for editor import)
fn merge_settings(
    base: crate::map_meta::MapSettings,
    overlay: &serde_json::Map<String, Value>,
) -> crate::map_meta::MapSettings {
    if overlay.is_empty() {
        return base;
    }
    let mut v = serde_json::to_value(&base).unwrap_or_default();
    if let Some(obj) = v.as_object_mut() {
        for (k, val) in overlay {
            obj.insert(k.clone(), val.clone());
        }
    }
    serde_json::from_value(v).unwrap_or(base)
}

/// Persist a parsed map as a new database entry + Arrow IPC file.
/// Assigns sequential u32 location IDs starting at 1.
fn write_map_to_db(conn: &Connection, mut map: ParsedMap) -> AppResult<ImportedMapInfo> {
    let map_id = Uuid::new_v4().to_string();
    let now = now_iso();
    let loc_count = map.locations.len() as u32;
    let tag_count = map.tags.len() as u32;

    let extra_json = if let Some(fields) = &map.fields {
        format!(
            r#"{{"fields":{}}}"#,
            serde_json::to_string(fields).unwrap_or_else(|_| "{}".into())
        )
    } else {
        "{}".to_string()
    };

    let settings = merge_settings(crate::map_meta::MapSettings::default(), &map.settings);
    let settings_json = serde_json::to_string(&settings)
        .unwrap_or_else(|_| crate::map_meta::default_settings_json());

    // Assign sequential u32 IDs
    for (i, loc) in map.locations.iter_mut().enumerate() {
        loc.id = (i as u32) + 1;
    }

    let batch = arrow_bridge::locations_to_batch(&map.locations);
    let arrow_path = storage::arrow_path(&map_id)?;
    storage::write_arrow_ipc(&arrow_path, &batch)?;

    let tx = conn.unchecked_transaction()?;

    // Build tags JSON for the maps row
    let tags_json = {
        let mut tag_map = serde_json::Map::new();
        for tag in &map.tags {
            tag_map.insert(tag.id.to_string(), serde_json::to_value(tag).unwrap());
        }
        serde_json::Value::Object(tag_map).to_string()
    };

    tx.execute(
        "INSERT INTO maps (id, name, description, folder, settings, score_bounds, extra, tags, location_count, created_at, updated_at) VALUES (?1, ?2, '', ?3, ?4, '\"auto\"', ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![map_id, map.name, map.folder, settings_json, extra_json, tags_json, loc_count, now, now],
    )?;

    tx.commit()?;

    Ok(ImportedMapInfo {
        id: map_id,
        name: map.name,
        location_count: loc_count,
        tag_count,
    })
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Parse a file (JSON or ZIP of JSONs) and return previews without persisting.
/// Results are cached in `CACHED_PARSE` so `bulk_import_confirm` can skip re-parsing.
/// ZIP files have each `.json` entry parsed in parallel via rayon.
#[tauri::command]
#[specta::specta]
pub async fn bulk_import_preview(path: String) -> AppResult<Vec<ImportPreviewEntry>> {
    tokio::task::spawn_blocking(move || {
        let entries = if path.ends_with(".zip") {
            read_zip_entries(&path)?
        } else {
            read_single_json(&path)?
        };

        let maps: Vec<ParsedMap> = entries
            .par_iter()
            .map(|(_, text)| parse_single_json(text))
            .collect();

        let results: Vec<ImportPreviewEntry> = maps
            .iter()
            .map(|m| ImportPreviewEntry {
                name: if m.name.is_empty() {
                    "Untitled".to_string()
                } else {
                    m.name.clone()
                },
                folder: m.folder.clone(),
                location_count: m.locations.len() as u32,
                tag_count: m.tags.len() as u32,
                warnings: m.warnings.clone(),
            })
            .collect();

        *CACHED_PARSE.lock().unwrap() = Some(CachedImport { path, maps });

        Ok(results)
    })
    .await?
}

/// Progress event emitted per-map during bulk import, consumed by the frontend
/// to drive a progress indicator.
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub current: u32,
    pub total: u32,
    pub map_name: String,
}

/// Persist selected maps from a previously previewed import.
/// Uses the cached parse if available; otherwise re-parses the file.
/// Each map gets a new UUID, Arrow IPC file, and SQLite row.
/// Emits `bulk-import-progress` events per map for UI feedback.
#[tauri::command]
#[specta::specta]
pub async fn bulk_import_confirm(
    path: String,
    selected_indices: Vec<u32>,
) -> AppResult<Vec<ImportedMapInfo>> {
    let main_path = storage::db_path()?;

    tokio::task::spawn_blocking(move || {
        let all_maps = {
            let mut cache = CACHED_PARSE.lock().unwrap();
            if cache.as_ref().map(|c| c.path.as_str()) == Some(path.as_str()) {
                cache.take().unwrap().maps
            } else {
                drop(cache);
                let entries = if path.ends_with(".zip") {
                    read_zip_entries(&path)?
                } else {
                    read_single_json(&path)?
                };
                entries
                    .par_iter()
                    .map(|(_, text)| parse_single_json(text))
                    .collect::<Vec<_>>()
            }
        };

        let selected_set: std::collections::HashSet<u32> = selected_indices.into_iter().collect();
        let parsed_maps: Vec<ParsedMap> = all_maps
            .into_iter()
            .enumerate()
            .filter(|(i, _)| selected_set.contains(&(*i as u32)))
            .map(|(_, m)| m)
            .collect();
        let total = parsed_maps.len() as u32;

        // Open DB once for all maps
        let conn = Connection::open(&main_path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;

        let mut results = Vec::with_capacity(parsed_maps.len());
        for (i, map) in parsed_maps.into_iter().enumerate() {
            let map_name = map.name.clone();
            let info = write_map_to_db(&conn, map)?;
            crate::emit_event(
                "bulk-import-progress",
                ImportProgress {
                    current: (i + 1) as u32,
                    total,
                    map_name,
                },
            );
            results.push(info);
        }

        Ok(results)
    })
    .await?
}

/// Drop the cached parse from `bulk_import_preview` when the user dismisses the
/// import dialog without confirming, instead of holding it until the next preview.
#[tauri::command]
#[specta::specta]
pub async fn bulk_import_cancel() -> AppResult<()> {
    *CACHED_PARSE.lock().unwrap() = None;
    Ok(())
}

// ---------------------------------------------------------------------------
// Single-file import into open map (editor import)
// ---------------------------------------------------------------------------

/// Imports larger than this are committed automatically instead of kept as a
/// reversible undo diff (the undo entry would clone every imported location and
/// bloat the persisted edit history). Raise to keep bigger imports undoable.
pub const IMPORT_AUTOCOMMIT_THRESHOLD: usize = 500_000;

/// Field presence count for the editor import preview dialog, letting
/// the user see which optional fields exist and decide which to keep/drop.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldCount {
    pub key: String,
    pub count: u32,
}

/// Preview data for importing a file into the currently open map.
/// Unlike bulk import, this shows per-field counts so the user can
/// selectively drop fields (heading, panoId, etc.) before importing.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EditorImportPreview {
    pub location_count: u32,
    pub tags: Vec<Tag>,
    pub fields: Vec<FieldCount>,
    pub warnings: Vec<String>,
    /// Temp-file path to preview positions: interleaved LE f32 `[lng, lat]` pairs.
    pub preview_positions_path: String,
    /// `[west, south, east, north]` bounding box of the import, for map auto-focus.
    pub bounds: Option<[f64; 4]>,
    /// True when this import exceeds `IMPORT_AUTOCOMMIT_THRESHOLD` and will be
    /// committed automatically (not undoable). Drives the import warning modal.
    pub will_auto_commit: bool,
}

/// Write interleaved LE f32 `[lng, lat]` for every location to a temp file.
/// Build preview stats from a parsed map and cache the parse for commit.
/// Single pass: field counts, positions buffer, and bounds are computed together.
fn build_preview(parsed: ParsedMap) -> AppResult<EditorImportPreview> {
    let n = parsed.locations.len();
    let (mut h, mut p, mut z, mut pano_c, mut tag_c) = (0u32, 0u32, 0u32, 0u32, 0u32);
    let mut extra_counts: HashMap<String, u32> = HashMap::new();
    let mut pos_buf: Vec<u8> = Vec::with_capacity(n * 8);
    let (mut west, mut south, mut east, mut north) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);

    for loc in &parsed.locations {
        if loc.heading != 0.0 {
            h += 1;
        }
        if loc.pitch != 0.0 {
            p += 1;
        }
        if loc.zoom != 0.0 {
            z += 1;
        }
        if loc.pano_id.is_some() {
            pano_c += 1;
        }
        if !loc.tags.is_empty() {
            tag_c += 1;
        }
        if let Some(extra) = &loc.extra {
            // Byte key-scan (no per-loc map alloc); only allocate a String the first
            // time each distinct key is seen.
            extra.for_each_field(|k, _| {
                if let Some(c) = extra_counts.get_mut(k) {
                    *c += 1;
                } else {
                    extra_counts.insert(k.to_owned(), 1);
                }
            });
        }
        pos_buf.extend_from_slice(&(loc.lng as f32).to_le_bytes());
        pos_buf.extend_from_slice(&(loc.lat as f32).to_le_bytes());
        if loc.lng < west {
            west = loc.lng;
        }
        if loc.lat < south {
            south = loc.lat;
        }
        if loc.lng > east {
            east = loc.lng;
        }
        if loc.lat > north {
            north = loc.lat;
        }
    }

    let mut fields: Vec<FieldCount> = Vec::with_capacity(5 + extra_counts.len());
    for (key, count) in [
        ("heading", h),
        ("pitch", p),
        ("zoom", z),
        ("panoId", pano_c),
        ("tags", tag_c),
    ] {
        if count > 0 {
            fields.push(FieldCount {
                key: key.into(),
                count,
            });
        }
    }
    for (key, count) in extra_counts {
        fields.push(FieldCount {
            key: format!("extra.{key}"),
            count,
        });
    }

    let path = std::env::temp_dir().join("mma_import_preview.bin");
    std::fs::write(&path, &pos_buf)?;

    let preview = EditorImportPreview {
        location_count: n as u32,
        tags: parsed.tags.clone(),
        fields,
        warnings: parsed.warnings.clone(),
        preview_positions_path: path.to_string_lossy().into_owned(),
        bounds: if n == 0 {
            None
        } else {
            Some([west, south, east, north])
        },
        will_auto_commit: n > IMPORT_AUTOCOMMIT_THRESHOLD,
    };

    *EDITOR_IMPORT_CACHE.lock().unwrap() = Some(parsed);
    Ok(preview)
}

static EDITOR_IMPORT_CACHE: Mutex<Option<ParsedMap>> = Mutex::new(None);

/// Fetch one staged (not yet imported) location by its preview index, for read-only
/// preview in the editor. Indexes follow the preview positions order.
#[tauri::command]
#[specta::specta]
pub fn store_import_staged_location(index: u32) -> AppResult<Location> {
    let cache = EDITOR_IMPORT_CACHE.lock().unwrap();
    let parsed = cache.as_ref().ok_or("no staged import")?;
    parsed
        .locations
        .get(index as usize)
        .cloned()
        .ok_or_else(|| "staged index out of range".into())
}

/// Parse a file and return field-level statistics + preview positions for the editor
/// import sidebar. Caches the parse result for `store_import_file` to consume on commit.
#[tauri::command]
#[specta::specta]
pub async fn store_import_preview(path: String) -> AppResult<EditorImportPreview> {
    // CPU-bound parse runs on a blocking thread so it never stalls the main/event-loop
    // thread (which the webview shares — a sync command here freezes the window).
    tokio::task::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let mut buf = read_sequential(&path)?;
        let t_read = t0.elapsed();
        let parsed = parse_file(&mut buf);
        let t_parse = t0.elapsed();
        let preview = build_preview(parsed)?;
        log::debug!(
            "[import-preview] read={:.0}ms parse={:.0}ms build={:.0}ms locs={}",
            t_read.as_millis(),
            (t_parse - t_read).as_millis(),
            (t0.elapsed() - t_parse).as_millis(),
            preview.location_count
        );
        Ok(preview)
    })
    .await?
}

/// Parse pasted text (JSON or CSV) and stage it for preview, exactly like
/// `store_import_preview` does for a file. Caches the parse for `store_import_file`.
#[tauri::command]
#[specta::specta]
pub async fn store_import_paste_preview(text: String) -> AppResult<EditorImportPreview> {
    tokio::task::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        let mut buf = text.into_bytes();
        let parsed = parse_file(&mut buf);
        if parsed.locations.is_empty() {
            return Err("no locations found".into());
        }
        log::debug!(
            "[paste-preview] parse={:.0}ms locs={}",
            t0.elapsed().as_millis(),
            parsed.locations.len()
        );
        build_preview(parsed)
    })
    .await?
}

/// Combined result of an editor import: the mutation delta (for render pipeline)
/// plus import-specific metadata.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EditorImportResult {
    #[serde(flatten)]
    pub mutation: location_store::MutationResult,
    pub imported_count: u32,
    pub warnings: Vec<String>,
    /// True when the import was large enough to autocommit; the caller commits it.
    pub auto_commit: bool,
    /// Settings carried by the import (`extra.settings`)
    #[specta(type = std::collections::HashMap<String, specta_typescript::Any>)]
    pub settings: serde_json::Map<String, Value>,
}

/// Insert pre-deduped copied locations (cross-map copy) through the same path
/// as editor import: tag reconcile, id alloc, counts, field defs, undo entry,
/// and render cell registration. `tags` are the source tag defs referenced by
/// `locations`.
pub(crate) fn add_copied_to_store(
    store: &mut location_store::Store,
    locations: Vec<Location>,
    tags: Vec<Tag>,
) -> AppResult<location_store::MutationResult> {
    let mut parsed = ParsedMap {
        name: String::new(),
        folder: None,
        locations,
        tags,
        fields: None,
        warnings: Vec::new(),
        settings: serde_json::Map::new(),
    };
    add_parsed_to_store(store, &mut parsed, None)
}

/// Insert parsed locations into the open map's store via the overlay.
///
/// Imports up to `IMPORT_AUTOCOMMIT_THRESHOLD` get a single undo entry (reversible).
/// Larger imports skip the undo entry; the caller autocommits them instead, so the
/// baseline advances through the normal commit path rather than diverging silently.
///
/// Tag reconciliation, render cell registration, and extra-field auto-registration
/// happen regardless of size.
fn add_parsed_to_store(
    store: &mut location_store::Store,
    parsed: &mut ParsedMap,
    bulk_tag: Option<&str>,
) -> AppResult<location_store::MutationResult> {
    let _t = std::time::Instant::now();
    let n = parsed.locations.len();
    let tag_id_remap = {
        let tags = &mut store.tags;
        let before = tags.all.len();
        let remap =
            location_store::reconcile_tags_by_name(&parsed.tags, &mut tags.all, &mut tags.next_id);
        if tags.all.len() > before {
            tags.dirty = true;
        }
        remap
    };

    for loc in &mut parsed.locations {
        loc.id = store.alloc_id();
        loc.tags = loc
            .tags
            .iter()
            .filter_map(|&old| tag_id_remap.get(&old).copied())
            .collect();
    }
    let t_reconcile = _t.elapsed();

    // Find-or-create the bulk tag (case-insensitive) and apply it to every location.
    if let Some(name) = bulk_tag.map(str::trim).filter(|n| !n.is_empty()) {
        let tag_id = store
            .tags
            .all
            .values()
            .find(|t| t.name.eq_ignore_ascii_case(name))
            .map(|t| t.id)
            .unwrap_or_else(|| {
                let id = store.alloc_tag_id();
                store.tags.all.insert(
                    id,
                    Tag {
                        id,
                        name: name.to_string(),
                        color: crate::util::color_for_name(name),
                        visible: true,
                        order: None,
                        count: 0,
                    },
                );
                store.tags.dirty = true;
                id
            });
        for loc in &mut parsed.locations {
            if !loc.tags.contains(&tag_id) {
                loc.tags.push(tag_id);
            }
        }
    }

    store.add_tag_counts(&parsed.locations);
    let t_counts = _t.elapsed();

    // Discover new extra-field defs from the locations now, before we consume them.
    let new_field_defs = {
        let extras: Vec<&crate::types::RawExtra> = parsed
            .locations
            .iter()
            .filter_map(|l| l.extra.as_ref())
            .collect();
        crate::map_meta::auto_register_field_defs(&store.known_field_keys, &extras)
    };
    let t_autoreg = _t.elapsed();

    // Small imports keep a reversible undo entry (needs a copy of the locations). Large
    // imports autocommit and skip undo, so the locations are MOVED into the overlay
    // below instead of cloning each one.
    if parsed.locations.len() <= IMPORT_AUTOCOMMIT_THRESHOLD {
        store.push_undo(location_store::EditEntry {
            created: parsed.locations.clone(),
            removed: Vec::new(),
        });
    }
    store.edits.redo.clear();

    let t_undo = _t.elapsed();

    for loc in std::mem::take(&mut parsed.locations) {
        let ci = location_store::render_cell_idx(loc.lat, loc.lng);
        store.cell_add_render(ci, loc.id);
        store.overlay_add(loc);
    }
    let t_overlay = _t.elapsed();

    let mut result = store.finish_mutation(location_store::ChangeSet {
        full_reset: true,
        ..Default::default()
    });
    result.tags = Some(store.tags.all.clone());

    if let Some(new_defs) = new_field_defs {
        location_store::apply_field_defs(store, new_defs, &mut result);
    }
    log::debug!("[import-insert] n={n} reconcile+alloc={:.0}ms counts={:.0}ms auto_reg={:.0}ms undo={:.0}ms overlay_add={:.0}ms finish={:.0}ms total={:.0}ms",
        t_reconcile.as_millis(), (t_counts - t_reconcile).as_millis(), (t_autoreg - t_counts).as_millis(),
        (t_undo - t_autoreg).as_millis(), (t_overlay - t_undo).as_millis(), (_t.elapsed() - t_overlay).as_millis(), _t.elapsed().as_millis());
    Ok(result)
}

/// Commit a previously previewed editor import, optionally dropping fields and/or
/// applying a bulk tag to every imported location. Consumes the cached parse from
/// `store_import_preview`/`store_import_paste_preview`. Fields in `dropped_fields`
/// (e.g. `"heading"`, `"extra.countryCode"`) are zeroed/removed.
// `async` so the insert + render-buffer registration runs off the main (event-loop)
// thread; as a sync command it froze the webview for the duration of the import insert.
#[tauri::command]
#[specta::specta]
pub async fn store_import_file(
    webview: tauri::Webview,
    state: tauri::State<'_, location_store::StoreState>,
    dropped_fields: Vec<String>,
    tag_name: Option<String>,
) -> AppResult<EditorImportResult> {
    let t0 = std::time::Instant::now();
    let mut parsed = EDITOR_IMPORT_CACHE
        .lock()
        .unwrap()
        .take()
        .ok_or("no cached import — call store_import_preview first")?;

    let drop_set: std::collections::HashSet<&str> =
        dropped_fields.iter().map(|s| s.as_str()).collect();
    if !drop_set.is_empty() {
        for loc in &mut parsed.locations {
            if drop_set.contains("heading") {
                loc.heading = 0.0;
            }
            if drop_set.contains("pitch") {
                loc.pitch = 0.0;
            }
            if drop_set.contains("zoom") {
                loc.zoom = 0.0;
            }
            if drop_set.contains("panoId") {
                loc.pano_id = None;
                loc.flags.remove(LocationFlags::LOAD_AS_PANO_ID);
            }
            if drop_set.contains("tags") {
                loc.tags.clear();
            }
            if let Some(extra) = &loc.extra {
                let mut m = extra.to_map();
                m.retain(|k, _| !drop_set.contains(format!("extra.{k}").as_str()));
                loc.extra = crate::types::RawExtra::from_map(&m);
            }
        }
        if drop_set.contains("tags") {
            parsed.tags.clear();
        }
    }
    // Capture before add_parsed_to_store, which consumes parsed.locations (moves them
    // into the overlay) leaving the vec empty.
    let imported_count = parsed.locations.len() as u32;
    let auto_commit = parsed.locations.len() > IMPORT_AUTOCOMMIT_THRESHOLD;
    log::debug!("[import] parse=cached locs={}", imported_count);

    with_store!(webview, state, |store| {
        let mutation = add_parsed_to_store(store, &mut parsed, tag_name.as_deref())?;

        log::debug!(
            "[import] total={:.0}ms locs={}",
            t0.elapsed().as_millis(),
            imported_count
        );

        Ok(EditorImportResult {
            imported_count,
            auto_commit,
            warnings: parsed.warnings,
            settings: parsed.settings,
            mutation,
        })
    })
}

#[cfg(test)]
#[path = "import.test.rs"]
mod tests;
