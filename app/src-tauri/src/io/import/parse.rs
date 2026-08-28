//! Turning a file into a `ParsedMap`: SIMD JSON object scanning, CSV, zip, tag interning.

use crate::store::maps::MapSettings;
use crate::types;
use crate::types::AppResult;
use crate::types::RawExtra;
use crate::types::{is_ws, scan_fields_from, skip_string, Location, LocationFlags, Tag};
use crate::util::color_for_name;
use crate::util::now_unix;
use memchr::memmem;
use rayon::prelude::*;
use serde_json::value::RawValue;
use serde_json::Value;
use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::io::Read;
use std::path::Path;
use std::time::Instant;

/// Read a file with sequential-scan hints for better OS prefetch on cold reads.
pub(super) fn read_sequential(path: &str) -> io::Result<Vec<u8>> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_SEQUENTIAL_SCAN: u32 = 0x0800_0000;
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_SEQUENTIAL_SCAN)
            .open(path)?;
        let mut buf = Vec::with_capacity(file.metadata()?.len() as usize);
        Read::read_to_end(&mut file, &mut buf)?;
        Ok(buf)
    }
    #[cfg(not(windows))]
    {
        std::fs::read(path)
    }
}

/// Intermediate representation produced by all parsers (JSON, CSV, ZIP entry).
/// Locations have placeholder IDs (0) -- real IDs are assigned at insert time.
#[derive(Default)]
pub(super) struct ParsedMap {
    pub(super) name: String,
    pub(super) folder: Option<String>,
    pub(super) locations: Vec<Location>,
    pub(super) tags: Vec<Tag>,
    pub(super) fields: Option<Value>,
    pub(super) warnings: Vec<String>,
    /// Map settings carried by the import (`extra.settings`)
    pub(super) settings: serde_json::Map<String, Value>,
}

/// Parse CSV text into locations. Supports both named columns (lat/lng/heading/etc.)
/// and positional (first two numeric columns = lat, lng). Skips malformed rows silently.
pub(super) fn parse_csv(text: &str) -> ParsedMap {
    let warn = |w: &str| {
        let mut m = ParsedMap::default();
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
                Some(s.into())
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
        locations,
        ..Default::default()
    }
}

pub(super) struct ExtraTagMeta {
    pub(super) color: Option<String>,
    pub(super) order: Option<u32>,
    pub(super) doclinks: Vec<String>,
}

/// Parse the top-level `"extra"` object (sibling of the coordinate array) into a
/// JSON Value without parsing the entire document. Callers that already know where
/// the coordinate array ends pass
/// `start` (just past the last object) + `start_depth` (2, still inside the array)
/// so we scan only the tiny tail. Shared by tag-meta and settings extraction.
pub(super) fn find_top_level_extra(buf: &[u8], start: usize, start_depth: i32) -> Option<Value> {
    let mut out = None;
    scan_fields_from(buf, start, start_depth, |fs| {
        if &buf[fs.key.clone()] == b"extra" {
            out = serde_json::from_slice(&buf[fs.value.clone()]).ok();
            true
        } else {
            false
        }
    });
    out
}

/// Tag color/order metadata from a parsed top-level `"extra"."tags"` block.
pub(super) fn tag_meta_from_extra(extra: &Value) -> HashMap<String, ExtraTagMeta> {
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
                        Some(format!("#{r:02x}{g:02x}{b:02x}"))
                    } else {
                        None
                    }
                });
            let order = entry.get("order").and_then(Value::as_u64).map(|o| o as u32);
            // `doclinks` array is the convention; a bare `doclink` string is tolerated.
            let doclinks = match entry.get("doclinks") {
                Some(Value::Array(arr)) => arr
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect(),
                _ => entry
                    .get("doclink")
                    .and_then(|v| v.as_str())
                    .map(|s| vec![s.to_string()])
                    .unwrap_or_default(),
            };
            meta.insert(
                name.clone(),
                ExtraTagMeta {
                    color,
                    order,
                    doclinks,
                },
            );
        }
    }
    meta
}

/// Map settings carried by an import, from a parsed top-level `"extra"."settings"` block.
pub(super) fn settings_from_extra(extra: &Value) -> serde_json::Map<String, Value> {
    extra
        .get("settings")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

/// Auto-detect format (JSON vs CSV) by first non-whitespace byte and dispatch.
pub(super) fn parse_file(buf: &mut [u8]) -> ParsedMap {
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

pub(super) fn parse_single_json(text: &str) -> ParsedMap {
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
pub(super) fn find_object_boundaries(bytes: &[u8]) -> (Vec<(usize, usize)>, usize) {
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
pub(super) fn scan_range(
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
pub(super) fn resync_object_start(bytes: &[u8], from: usize) -> usize {
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
pub(super) fn parallel_find_object_boundaries(bytes: &[u8]) -> (Vec<(usize, usize)>, usize) {
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

/// Fast path: strip the top-level `tags` array from raw extra JSON `s`, interning its
/// strings into the chunk-local tag table, and return the remaining object as `RawExtra`
/// (the exact bytes minus the `tags` member; `None` if nothing is left). `tags` are
/// parsed with serde so escapes are handled correctly. Returns `Err(())` if `tags` isn't
/// a clean top-level string array, so the caller can fall back to the map path.
pub(super) fn strip_tags_fast(
    s: &str,
    names: &mut Vec<String>,
    name_to_local: &mut rustc_hash::FxHashMap<String, u32>,
    tags: &mut Vec<u32>,
) -> Result<Option<RawExtra>, ()> {
    let b = s.as_bytes();
    let mut span: Option<(usize, usize, usize)> = None;
    types::scan_fields(b, |fs| {
        let hit = &b[fs.key.clone()] == b"tags";
        if hit {
            span = Some((fs.key.start - 1, fs.value.start, fs.value.end));
        }
        hit
    });
    let Some((kstart, vstart, vend)) = span else {
        // No tags key: keep the extra bytes verbatim.
        return Ok(RawExtra::from_string(s.to_owned()));
    };
    if b.get(vstart) != Some(&b'[') {
        return Err(());
    }
    let Ok(list) = serde_json::from_str::<Vec<&str>>(&s[vstart..vend]) else {
        return Err(());
    };
    for name in list {
        tags.push(intern_tag_name(names, name_to_local, name));
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
    Ok(RawExtra::from_string(out))
}

pub(super) fn intern_tag_name(
    names: &mut Vec<String>,
    name_to_local: &mut rustc_hash::FxHashMap<String, u32>,
    name: &str,
) -> u32 {
    match name_to_local.get(name) {
        Some(&id) => id,
        None => {
            let id = names.len() as u32;
            names.push(name.to_owned());
            name_to_local.insert(name.to_owned(), id);
            id
        }
    }
}

/// Slow path: build a `serde_json::Map` from raw `extra`, fold in non-null top-level
/// `countryCode`/`stateCode`, intern + strip `tags`, and pull a nested `panoId` fallback
/// into `out_pano`. Used only when the fast byte path can't apply (rare).
pub(super) fn build_extra_via_map(
    extra_str: Option<&str>,
    country_code: Option<&RawValue>,
    state_code: Option<&RawValue>,
    names: &mut Vec<String>,
    name_to_local: &mut rustc_hash::FxHashMap<String, u32>,
    tags: &mut Vec<u32>,
    out_pano: &mut Option<String>,
) -> Option<RawExtra> {
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
            tags.push(intern_tag_name(names, name_to_local, &s));
        }
    }
    *out_pano = m.remove("panoId").and_then(|v| match v {
        Value::String(s) => Some(s),
        _ => None,
    });
    RawExtra::from_map(&m)
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
pub(super) fn parse_single_json_mut(buf: &mut [u8]) -> ParsedMap {
    let mut warnings = Vec::new();
    let t0 = Instant::now();

    // Top-level metadata and the coordinate array key sit in the first few KB, so the
    // field scan runs over that prefix only: the array value would otherwise be walked
    // to its end here and again by the boundary pass.
    let mut name = String::new();
    let mut folder: Option<String> = None;
    let mut arr_range: Option<(usize, usize)> = None;
    let header = &buf[..buf.len().min(8192)];
    types::scan_fields(header, |fs| {
        let value = &header[fs.value.clone()];
        match &header[fs.key.clone()] {
            b"name" => name = serde_json::from_slice(value).unwrap_or_default(),
            b"folder" => folder = serde_json::from_slice(value).ok(),
            b"customCoordinates" | b"locations" if value.first() == Some(&b'[') => {
                arr_range = Some((fs.value.start + 1, buf.len()));
            }
            _ => {}
        }
        arr_range.is_some()
    });
    if arr_range.is_none() {
        // A bare array file.
        let first = buf.iter().position(|&c| !is_ws(c));
        if let Some(i) = first.filter(|&i| buf[i] == b'[') {
            arr_range = Some((i + 1, buf.len()));
        }
    }

    let (arr_start, arr_end) = match arr_range {
        Some(r) => r,
        None => {
            warnings.push("No recognized coordinate array found".to_string());
            return ParsedMap {
                name,
                folder,
                warnings,
                ..Default::default()
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
        country_code: Option<&'a RawValue>,
        #[serde(borrow, rename = "stateCode")]
        state_code: Option<&'a RawValue>,
        #[serde(borrow)]
        extra: Option<&'a RawValue>,
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
                let top_pano = raw.pano_id.map(Cow::into_owned);
                let extra_str = raw.extra.map(RawValue::get);

                // Fast path unless we must edit `extra` beyond stripping tags: folding a
                // non-null top-level country/state code, or a `panoId` nested in `extra`.
                let need_map = raw.country_code.is_some()
                    || raw.state_code.is_some()
                    || extra_str
                        .is_some_and(|s| memmem::find(s.as_bytes(), b"\"panoId\"").is_some());

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

                let pano_id = top_pano
                    .or(extra_pano)
                    .map(compact_str::CompactString::from);
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
            let doclinks = meta.map(|m| m.doclinks.clone()).unwrap_or_default();
            Tag {
                id,
                name,
                color,
                visible: true,
                order,
                doclinks,
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
        warnings,
        settings,
        ..Default::default()
    }
}

pub(super) fn read_zip_entries(path: &str) -> AppResult<Vec<(String, String)>> {
    let file = File::open(path).map_err(|e| format!("Failed to open file: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip: {e}"))?;

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

pub(super) fn read_single_json(path: &str) -> AppResult<Vec<(String, String)>> {
    let text = fs::read_to_string(path).map_err(|e| format!("Failed to read file: {e}"))?;
    let filename = Path::new(path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(vec![(filename, text)])
}

/// Sole place an import's settings become `MapSettings`. Overlays the import's
/// settings keys (`extra.settings`) onto `base` (defaults for a new map, the open
/// map's current settings for editor import)
pub(super) fn merge_settings(
    base: MapSettings,
    overlay: &serde_json::Map<String, Value>,
) -> MapSettings {
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

/// Rebase ordered tags to dense 1..k, keeping their relative (order, name)
/// ordering; unordered tags stay `None`. Source order values are never stored.
pub(super) fn renumber_ordered_tags(tags: &mut [Tag]) {
    let mut ordered: Vec<usize> = (0..tags.len())
        .filter(|&i| tags[i].order.is_some())
        .collect();
    ordered.sort_by(|&a, &b| {
        tags[a]
            .order
            .cmp(&tags[b].order)
            .then_with(|| tags[a].name.cmp(&tags[b].name))
    });
    for (n, i) in ordered.into_iter().enumerate() {
        tags[i].order = Some(n as u32 + 1);
    }
}
