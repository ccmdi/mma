use std::collections::HashMap;
use std::io::Read;
use std::sync::Mutex;

use rayon::prelude::*;
use rusqlite::Connection;
use serde_json::Value;
use uuid::Uuid;

use tauri::Emitter;
use crate::arrow_bridge;
use crate::fast_io;
use crate::location_store;
use crate::types::{Tag, Location};

static CACHED_PARSE: Mutex<Option<CachedImport>> = Mutex::new(None);

struct CachedImport {
    path: String,
    maps: Vec<ParsedMap>,
}

const DEFAULT_SETTINGS: &str = r#"{"pointAlongRoad":true,"preferDirection":null,"preferOfficial":true,"preferHigherQuality":false,"onlyOfficial":false,"cameraTypes":null,"defaultPanoId":false,"exportZoom":false,"exportUnpanned":true,"enrichMetadata":true}"#;

// ---------------------------------------------------------------------------
// Types returned to JS
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewEntry {
    pub name: String,
    pub folder: Option<String>,
    pub location_count: u32,
    pub tag_count: u32,
    pub warnings: Vec<String>,
}

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


struct ParsedMap {
    name: String,
    folder: Option<String>,
    locations: Vec<Location>,
    tags: Vec<Tag>,
    fields: Option<Value>,
    warnings: Vec<String>,
}

use crate::util::color_for_name;

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

fn parse_csv(text: &str) -> ParsedMap {
    let warn = |w: &str| ParsedMap { name: String::new(), folder: None, locations: Vec::new(), tags: Vec::new(), fields: None, warnings: vec![w.into()] };

    let first = match text.lines().next() {
        Some(h) => h,
        None => return warn("Empty CSV"),
    };
    let cols: Vec<&str> = first.split(',').map(|h| h.trim()).collect();
    let lower: Vec<String> = cols.iter().map(|h| h.to_lowercase()).collect();

    let lat_named = lower.iter().position(|h| h == "lat" || h == "latitude");
    let lng_named = lower.iter().position(|h| h == "lng" || h == "longitude" || h == "lon");

    // The first line is a header only if it names lat/lng columns.
    let (lat_idx, lng_idx, heading_idx, pitch_idx, zoom_idx, pano_idx, has_header) =
        if let (Some(la), Some(ln)) = (lat_named, lng_named) {
            (
                la, ln,
                lower.iter().position(|h| h == "heading"),
                lower.iter().position(|h| h == "pitch"),
                lower.iter().position(|h| h == "zoom"),
                lower.iter().position(|h| h == "pano" || h == "panoid" || h == "pano_id"),
                true,
            )
        } else {
            let is_num = |s: &&str| s.parse::<f64>().map(f64::is_finite).unwrap_or(false);
            if !(cols.first().is_some_and(is_num) && cols.get(1).is_some_and(is_num)) {
                return warn("CSV missing lat/lng columns");
            }
            (0, 1, None, None, None, None, false)
        };

    let now = chrono_now();
    let mut locations = Vec::new();
    for line in text.lines().skip(if has_header { 1 } else { 0 }) {
        let fields: Vec<&str> = line.split(',').map(|f| f.trim()).collect();
        let lat: f64 = match fields.get(lat_idx).and_then(|s| s.parse::<f64>().ok()) {
            Some(v) if v.is_finite() => v,
            _ => continue,
        };
        let lng: f64 = match fields.get(lng_idx).and_then(|s| s.parse::<f64>().ok()) {
            Some(v) if v.is_finite() => v,
            _ => continue,
        };
        let heading = heading_idx.and_then(|i| fields.get(i)?.parse().ok()).unwrap_or(0.0);
        let pitch = pitch_idx.and_then(|i| fields.get(i)?.parse().ok()).unwrap_or(0.0);
        let zoom = zoom_idx.and_then(|i| fields.get(i)?.parse().ok()).unwrap_or(0.0);
        let pano_id = pano_idx.and_then(|i| {
            let s = fields.get(i)?.trim();
            if s.is_empty() { None } else { Some(s.to_string()) }
        });
        let flags = if pano_id.is_some() { 1u32 } else { 0u32 };

        locations.push(Location {
            id: 0,
            lat, lng, heading, pitch, zoom,
            pano_id, flags,
            tags: Vec::new(),
            extra: None,
            created_at: now.clone(),
            modified_at: None,
        });
    }

    ParsedMap { name: String::new(), folder: None, locations, tags: Vec::new(), fields: None, warnings: Vec::new() }
}

struct ExtraTagMeta {
    color: Option<String>,
    order: Option<u32>,
}

fn extract_tag_meta(buf: &[u8]) -> HashMap<String, ExtraTagMeta> {
    let mut meta = HashMap::new();
    let needle = b"\"extra\"";
    // Find "extra" at depth 1 (top-level key, not inside customCoordinates)
    let mut i = 0;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc2 = false;
    let mut pos = None;
    while i < buf.len() {
        if esc2 { esc2 = false; i += 1; continue; }
        if buf[i] == b'\\' && in_str { esc2 = true; i += 1; continue; }
        if !in_str && depth == 1 && buf[i] == b'"' && i + needle.len() <= buf.len() && &buf[i..i + needle.len()] == needle {
            pos = Some(i);
            break;
        }
        if buf[i] == b'"' { in_str = !in_str; i += 1; continue; }
        if in_str { i += 1; continue; }
        if buf[i] == b'{' || buf[i] == b'[' { depth += 1; }
        if buf[i] == b'}' || buf[i] == b']' { depth -= 1; }
        i += 1;
    }
    let pos = match pos { Some(p) => p, None => return meta };
    let mut j = pos + needle.len();
    while j < buf.len() && matches!(buf[j], b' ' | b':' | b'\n' | b'\r' | b'\t') { j += 1; }
    if j >= buf.len() || buf[j] != b'{' { return meta; }
    let obj_start = j;
    let mut depth = 1i32;
    let mut k = obj_start + 1;
    let mut in_str = false;
    let mut esc = false;
    while k < buf.len() && depth > 0 {
        if esc { esc = false; k += 1; continue; }
        if buf[k] == b'\\' && in_str { esc = true; k += 1; continue; }
        if buf[k] == b'"' { in_str = !in_str; k += 1; continue; }
        if in_str { k += 1; continue; }
        if buf[k] == b'{' { depth += 1; }
        if buf[k] == b'}' { depth -= 1; }
        k += 1;
    }
    let extra: serde_json::Value = match serde_json::from_slice(&buf[obj_start..k]) {
        Ok(v) => v,
        Err(_) => return meta,
    };
    if let Some(tags_obj) = extra.get("tags").and_then(|t| t.as_object()) {
        for (name, entry) in tags_obj {
            let color = entry.get("color").and_then(|c| c.as_array()).and_then(|arr| {
                if arr.len() >= 3 {
                    let r = arr[0].as_u64().unwrap_or(0) as u8;
                    let g = arr[1].as_u64().unwrap_or(0) as u8;
                    let b = arr[2].as_u64().unwrap_or(0) as u8;
                    Some(format!("#{:02x}{:02x}{:02x}", r, g, b))
                } else { None }
            });
            let order = entry.get("order").and_then(|o| o.as_u64()).map(|o| o as u32);
            meta.insert(name.clone(), ExtraTagMeta { color, order });
        }
    }
    meta
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

fn parse_file(buf: &mut [u8]) -> ParsedMap {
    let trimmed = buf.iter().position(|&b| !b.is_ascii_whitespace()).unwrap_or(0);
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

// Scan raw bytes for object `{...}` boundaries at depth 1 inside an array.
// Returns (start, end) byte offsets relative to the input slice.
fn find_object_boundaries(bytes: &[u8]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    let mut obj_start = 0usize;

    for (i, &b) in bytes.iter().enumerate() {
        if escape { escape = false; continue; }
        if b == b'\\' && in_string { escape = true; continue; }
        if b == b'"' { in_string = !in_string; continue; }
        if in_string { continue; }
        match b {
            b'{' => {
                if depth == 0 { obj_start = i; }
                depth += 1;
            }
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    ranges.push((obj_start, i + 1));
                }
            }
            _ => {}
        }
    }
    ranges
}

// Find the byte range of a JSON key's array value in raw bytes.
// Returns (array_content_start, array_content_end) — inside the [ ].
fn find_key_array_range(bytes: &[u8], key: &str) -> Option<(usize, usize)> {
    let needle = format!("\"{}\"", key);
    let needle_bytes = needle.as_bytes();
    let mut i = 0;
    let mut in_string = false;
    let mut escape = false;

    while i < bytes.len() {
        if escape { escape = false; i += 1; continue; }
        if bytes[i] == b'\\' && in_string { escape = true; i += 1; continue; }
        if bytes[i] == b'"' { in_string = !in_string; i += 1; continue; }
        if in_string { i += 1; continue; }
        if i + needle_bytes.len() <= bytes.len() && &bytes[i..i + needle_bytes.len()] == needle_bytes {
            // Found key — skip past the colon and whitespace to find [
            let mut j = i + needle_bytes.len();
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b':' || bytes[j] == b'\n' || bytes[j] == b'\r' || bytes[j] == b'\t') { j += 1; }
            if j < bytes.len() && bytes[j] == b'[' {
                let arr_start = j + 1;
                // Find matching ]
                let mut depth = 1i32;
                let mut k = arr_start;
                let mut s = false;
                let mut esc = false;
                while k < bytes.len() && depth > 0 {
                    if esc { esc = false; k += 1; continue; }
                    if bytes[k] == b'\\' && s { esc = true; k += 1; continue; }
                    if bytes[k] == b'"' { s = !s; k += 1; continue; }
                    if s { k += 1; continue; }
                    if bytes[k] == b'[' { depth += 1; }
                    if bytes[k] == b']' { depth -= 1; }
                    k += 1;
                }
                return Some((arr_start, k - 1));
            }
        }
        i += 1;
    }
    None
}

// Extract lightweight metadata from raw JSON bytes without full parse.
fn extract_string_field(bytes: &[u8], key: &str) -> Option<String> {
    let needle = format!("\"{}\"", key);
    let needle_bytes = needle.as_bytes();
    let mut i = 0;
    let mut in_string = false;
    let mut escape = false;
    let mut depth = 0i32;

    while i < bytes.len() {
        if escape { escape = false; i += 1; continue; }
        if bytes[i] == b'\\' && in_string { escape = true; i += 1; continue; }
        if bytes[i] == b'"' { in_string = !in_string; i += 1; continue; }
        if in_string { i += 1; continue; }
        if bytes[i] == b'{' || bytes[i] == b'[' { depth += 1; }
        if bytes[i] == b'}' || bytes[i] == b']' { depth -= 1; }
        // Only match at top level
        if depth == 1 && i + needle_bytes.len() <= bytes.len() && &bytes[i..i + needle_bytes.len()] == needle_bytes {
            let mut j = i + needle_bytes.len();
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b':' || bytes[j] == b'\n' || bytes[j] == b'\r' || bytes[j] == b'\t') { j += 1; }
            if j < bytes.len() && bytes[j] == b'"' {
                j += 1;
                let start = j;
                let mut esc2 = false;
                while j < bytes.len() {
                    if esc2 { esc2 = false; j += 1; continue; }
                    if bytes[j] == b'\\' { esc2 = true; j += 1; continue; }
                    if bytes[j] == b'"' { break; }
                    j += 1;
                }
                return Some(String::from_utf8_lossy(&bytes[start..j]).to_string());
            }
        }
        i += 1;
    }
    None
}

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
            if buf[i] == b'"' && buf[i+1..].starts_with(key) && buf[i + 1 + key.len()] == b'"' {
                return Some(i + key.len() + 2);
            }
            i += 1;
        }
        None
    }

    fn read_string_at(buf: &[u8], pos: usize) -> Option<(String, usize)> {
        let mut i = pos;
        while i < buf.len() && (buf[i] == b' ' || buf[i] == b':' || buf[i] == b'\n' || buf[i] == b'\r' || buf[i] == b'\t') { i += 1; }
        if i >= buf.len() || buf[i] != b'"' { return None; }
        i += 1;
        let start = i;
        let mut esc = false;
        while i < buf.len() {
            if esc { esc = false; i += 1; continue; }
            if buf[i] == b'\\' { esc = true; i += 1; continue; }
            if buf[i] == b'"' { return Some((String::from_utf8_lossy(&buf[start..i]).to_string(), i + 1)); }
            i += 1;
        }
        None
    }

    fn find_array_start(buf: &[u8], pos: usize) -> Option<usize> {
        let mut i = pos;
        while i < buf.len() && (buf[i] == b' ' || buf[i] == b':' || buf[i] == b'\n' || buf[i] == b'\r' || buf[i] == b'\t') { i += 1; }
        if i >= buf.len() || buf[i] != b'[' { return None; }
        Some(i + 1)
    }

    // Top-level metadata keys are always in the first few KB
    let header = &buf[..buf.len().min(4096)];
    if let Some(pos) = find_key_value_fast(header, b"name") {
        if let Some((s, _)) = read_string_at(header, pos) { name = s; }
    }
    if let Some(pos) = find_key_value_fast(header, b"folder") {
        if let Some((s, _)) = read_string_at(header, pos) { folder = Some(s); }
    }

    // Array key is also near the top — search first 8KB, fall back to full scan
    let key_search = &buf[..buf.len().min(8192)];
    if let Some(pos) = find_key_value_fast(key_search, b"customCoordinates") {
        if let Some(s) = find_array_start(buf, pos) { arr_range = Some((s, buf.len())); }
    }
    if arr_range.is_none() {
        if let Some(pos) = find_key_value_fast(key_search, b"locations") {
            if let Some(s) = find_array_start(buf, pos) { arr_range = Some((s, buf.len())); }
        }
    }
    if arr_range.is_none() {
        if let Some(s) = find_array_start(buf, 0) { arr_range = Some((s, buf.len())); }
    }

    let (arr_start, arr_end) = match arr_range {
        Some(r) => r,
        None => {
            warnings.push("No recognized coordinate array found".to_string());
            return ParsedMap { name, folder, locations: Vec::new(), tags: Vec::new(), fields: None, warnings };
        }
    };

    let t_scan = t0.elapsed();

    // Find object boundaries within the array
    let obj_ranges = find_object_boundaries(&buf[arr_start..arr_end]);
    let t_boundaries = t0.elapsed();

    let now = chrono_now();
    let known_keys: &[&str] = &["lat", "latitude", "lng", "longitude", "lon", "heading", "pitch",
        "zoom", "panoId", "pano", "pano_id", "extra", "countryCode", "stateCode",
        "flags", "tags", "id", "createdAt", "modifiedAt"];

    struct RawLoc {
        loc: Location,
        raw_tags: Vec<String>,
    }

    // Parse each object in parallel — each thread gets its own byte slice copy
    let arr_slice = &buf[arr_start..arr_end];
    let raw_results: Vec<Option<RawLoc>> = obj_ranges.par_iter().map(|&(start, end)| {
        let mut slice = arr_slice[start..end].to_vec();
        let obj: serde_json::Map<String, Value> = simd_json::serde::from_slice(&mut slice).ok()?;

        let lat = get_f64(&obj, &["lat", "latitude"]);
        let lng = get_f64(&obj, &["lng", "longitude", "lon"]);
        let (lat, lng) = match (lat, lng) {
            (Some(la), Some(ln)) if la.is_finite() && ln.is_finite() => (la, ln),
            _ => return None,
        };

        let heading = get_f64(&obj, &["heading"]).unwrap_or(0.0);
        let pitch = get_f64(&obj, &["pitch"]).unwrap_or(0.0);
        let zoom = get_f64(&obj, &["zoom"]).unwrap_or(0.0);

        let top_pano = get_str(&obj, &["panoId", "pano", "pano_id"]);
        let extra_pano = obj.get("extra")
            .and_then(|e| e.as_object())
            .and_then(|e| get_str(e, &["panoId"]));
        let pano_id = top_pano.or(extra_pano);
        let flags = if top_pano.is_some() { 1u32 } else { 0u32 };

        let raw_tags: Vec<String> = obj.get("extra")
            .and_then(|e| e.get("tags"))
            .and_then(|t| t.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();

        let mut extra_map = serde_json::Map::new();
        for (k, v) in &obj {
            if !known_keys.contains(&k.as_str()) {
                extra_map.insert(k.clone(), v.clone());
            }
        }
        if let Some(item_extra) = obj.get("extra").and_then(|e| e.as_object()) {
            for (k, v) in item_extra {
                if k == "tags" || k == "panoId" { continue; }
                extra_map.insert(k.clone(), v.clone());
            }
        }

        Some(RawLoc {
            loc: Location {
                id: 0, // placeholder; assigned by store on add
                lat, lng, heading, pitch, zoom,
                pano_id: pano_id.map(|s| s.to_string()),
                flags,
                tags: Vec::new(),
                extra: if extra_map.is_empty() { None } else { Some(extra_map) },
                created_at: now.clone(),
                modified_at: None,
            },
            raw_tags,
        })
    }).collect();

    let t_parse = t0.elapsed();

    let tag_meta = extract_tag_meta(buf);

    let mut tags_by_name: HashMap<String, u32> = HashMap::new();
    let mut next_tag: u32 = 1;
    let mut locations = Vec::with_capacity(raw_results.len());
    for raw in raw_results.into_iter().flatten() {
        let mut loc = raw.loc;
        for tag_name in raw.raw_tags {
            let id = *tags_by_name.entry(tag_name)
                .or_insert_with(|| { let id = next_tag; next_tag += 1; id });
            loc.tags.push(id);
        }
        locations.push(loc);
    }

    let mut tags: Vec<Tag> = tags_by_name.into_iter().map(|(name, id)| {
        let meta = tag_meta.get(&name);
        let color = meta.and_then(|m| m.color.clone())
            .unwrap_or_else(|| color_for_name(&name));
        let order = meta.and_then(|m| m.order);
        Tag { id, name, color, visible: true, order, count: 0 }
    }).collect();
    tags.sort_by(|a, b| {
        a.order.unwrap_or(u32::MAX).cmp(&b.order.unwrap_or(u32::MAX))
            .then_with(|| a.name.cmp(&b.name))
    });

    log::debug!("[parse] scan={:.0}ms boundaries={:.0}ms parallel_parse={:.0}ms total={:.0}ms objs={}",
        t_scan.as_millis(), t_boundaries.as_millis(), t_parse.as_millis(),
        t0.elapsed().as_millis(), locations.len());

    ParsedMap { name, folder, locations, tags, fields: None, warnings }
}

fn get_f64(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<f64> {
    for k in keys {
        if let Some(v) = obj.get(*k) {
            if let Some(n) = v.as_f64() { return Some(n); }
        }
    }
    None
}

fn get_str<'a>(obj: &'a serde_json::Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    for k in keys {
        if let Some(v) = obj.get(*k) {
            if let Some(s) = v.as_str() { return Some(s); }
        }
    }
    None
}

fn chrono_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    // ISO 8601 format matching JS new Date().toISOString()
    let secs = (now / 1000) as i64;
    let millis = (now % 1000) as u32;
    
    time_to_iso(secs, millis)
}

fn time_to_iso(secs: i64, millis: u32) -> String {
    const DAYS_PER_400Y: i64 = 146097;

    let total_days = secs / 86400 + 719468; // days from year 0 to unix epoch
    let time_of_day = secs.rem_euclid(86400);

    let era = if total_days >= 0 { total_days } else { total_days - DAYS_PER_400Y + 1 } / DAYS_PER_400Y;
    let doe = (total_days - era * DAYS_PER_400Y) as u32;
    let yoe = (doe - doe / 1461 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    let h = time_of_day / 3600;
    let min = (time_of_day % 3600) / 60;
    let s = time_of_day % 60;

    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", y, m, d, h, min, s, millis)
}

// ---------------------------------------------------------------------------
// Zip orchestration
// ---------------------------------------------------------------------------

fn read_zip_entries(path: &str) -> Result<Vec<(String, String)>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip: {}", e))?;

    let mut entries = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() || !entry.name().ends_with(".json") { continue; }
        let name = entry.name().to_string();
        let mut text = String::new();
        entry.read_to_string(&mut text).map_err(|e| e.to_string())?;
        entries.push((name, text));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}

fn read_single_json(path: &str) -> Result<Vec<(String, String)>, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    let filename = std::path::Path::new(path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(vec![(filename, text)])
}

// ---------------------------------------------------------------------------
// DB write
// ---------------------------------------------------------------------------

fn write_map_to_db(conn: &Connection, app: &tauri::AppHandle, mut map: ParsedMap) -> Result<ImportedMapInfo, String> {
    let map_id = Uuid::new_v4().to_string();
    let now = chrono_now();
    let loc_count = map.locations.len() as u32;
    let tag_count = map.tags.len() as u32;

    let extra_json = if let Some(fields) = &map.fields {
        format!(r#"{{"fields":{}}}"#, serde_json::to_string(fields).unwrap_or_else(|_| "{}".into()))
    } else {
        "{}".to_string()
    };

    // Assign sequential u32 IDs
    for (i, loc) in map.locations.iter_mut().enumerate() {
        loc.id = (i as u32) + 1;
    }

    // Write Arrow IPC file
    let batch = arrow_bridge::locations_to_batch(&map.locations);
    let arrow_path = fast_io::arrow_path(app, &map_id)?;
    fast_io::write_arrow_ipc(&arrow_path, &batch)?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    // Build tags JSON for the maps row
    let tags_json = {
        let mut tag_map = serde_json::Map::new();
        for tag in &map.tags {
            tag_map.insert(tag.id.to_string(), serde_json::to_value(tag).unwrap());
        }
        serde_json::Value::Object(tag_map).to_string()
    };

    // Insert map with location_count + tags
    tx.execute(
        "INSERT INTO maps (id, name, description, folder, settings, score_bounds, extra, tags, location_count, created_at, updated_at) VALUES (?1, ?2, '', ?3, ?4, '\"auto\"', ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![map_id, map.name, map.folder, DEFAULT_SETTINGS, extra_json, tags_json, loc_count, now, now],
    ).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;

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

#[tauri::command]
#[specta::specta]
pub async fn bulk_import_preview(path: String) -> Result<Vec<ImportPreviewEntry>, String> {
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

        let results: Vec<ImportPreviewEntry> = maps.iter().map(|m| ImportPreviewEntry {
            name: if m.name.is_empty() { "Untitled".to_string() } else { m.name.clone() },
            folder: m.folder.clone(),
            location_count: m.locations.len() as u32,
            tag_count: m.tags.len() as u32,
            warnings: m.warnings.clone(),
        }).collect();

        *CACHED_PARSE.lock().unwrap() = Some(CachedImport { path, maps });

        Ok(results)
    }).await.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub current: u32,
    pub total: u32,
    pub map_name: String,
}

#[tauri::command]
#[specta::specta]
pub async fn bulk_import_confirm(
    app: tauri::AppHandle,
    path: String,
    selected_indices: Vec<u32>,
) -> Result<Vec<ImportedMapInfo>, String> {
    let main_path = fast_io::db_path(&app)?;
    let app_handle = app.clone();

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
                entries.par_iter().map(|(_, text)| parse_single_json(text)).collect::<Vec<_>>()
            }
        };

        let selected_set: std::collections::HashSet<u32> = selected_indices.into_iter().collect();
        let parsed_maps: Vec<ParsedMap> = all_maps.into_iter()
            .enumerate()
            .filter(|(i, _)| selected_set.contains(&(*i as u32)))
            .map(|(_, m)| m)
            .collect();
        let total = parsed_maps.len() as u32;

        // Open DB once for all maps
        let conn = Connection::open(&main_path).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
            .map_err(|e| e.to_string())?;

        let mut results = Vec::with_capacity(parsed_maps.len());
        for (i, map) in parsed_maps.into_iter().enumerate() {
            let map_name = map.name.clone();
            let info = write_map_to_db(&conn, &app_handle, map)?;
            let _ = app_handle.emit("bulk-import-progress", ImportProgress {
                current: (i + 1) as u32,
                total,
                map_name,
            });
            results.push(info);
        }

        Ok(results)
    }).await.map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Single-file import into open map (editor import)
// ---------------------------------------------------------------------------


#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldCount {
    pub key: String,
    pub count: u32,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EditorImportPreview {
    pub location_count: u32,
    pub tags: Vec<Tag>,
    pub fields: Vec<FieldCount>,
    pub warnings: Vec<String>,
}

static EDITOR_IMPORT_CACHE: Mutex<Option<ParsedMap>> = Mutex::new(None);

#[tauri::command]
#[specta::specta]
pub fn store_import_preview(path: String) -> Result<EditorImportPreview, String> {
    let t0 = std::time::Instant::now();
    let mut buf = std::fs::read(&path).map_err(|e| e.to_string())?;
    let t_read = t0.elapsed();
    let parsed = parse_file(&mut buf);
    log::debug!("[import-preview] read={:.0}ms parse={:.0}ms locs={}", t_read.as_millis(), t0.elapsed().as_millis(), parsed.locations.len());

    let mut field_counts: HashMap<String, u32> = HashMap::new();
    for loc in &parsed.locations {
        if loc.heading != 0.0 { *field_counts.entry("heading".into()).or_default() += 1; }
        if loc.pitch != 0.0 { *field_counts.entry("pitch".into()).or_default() += 1; }
        if loc.zoom != 0.0 { *field_counts.entry("zoom".into()).or_default() += 1; }
        if loc.pano_id.is_some() { *field_counts.entry("panoId".into()).or_default() += 1; }
        if !loc.tags.is_empty() { *field_counts.entry("tags".into()).or_default() += 1; }
        if let Some(extra) = &loc.extra {
            for k in extra.keys() {
                *field_counts.entry(format!("extra.{k}")).or_default() += 1;
            }
        }
    }

    let fields: Vec<FieldCount> = field_counts.into_iter()
        .map(|(key, count)| FieldCount { key, count })
        .collect();

    let preview = EditorImportPreview {
        location_count: parsed.locations.len() as u32,
        tags: parsed.tags.clone(),
        fields,
        warnings: parsed.warnings.clone(),
    };

    *EDITOR_IMPORT_CACHE.lock().unwrap() = Some(parsed);
    Ok(preview)
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EditorImportResult {
    #[serde(flatten)]
    pub mutation: location_store::MutationResult,
    pub imported_count: u32,
    pub warnings: Vec<String>,
}

fn reconcile_tags(
    store: &mut location_store::Store,
    parsed: &mut ParsedMap,
    existing_tags: &HashMap<u32, Tag>,
) -> HashMap<u32, u32> {
    let mut name_to_id: HashMap<String, u32> = HashMap::new();
    for (_, tag) in existing_tags {
        name_to_id.insert(tag.name.to_lowercase(), tag.id);
    }

    let mut remap: HashMap<u32, u32> = HashMap::new();
    parsed.tags.retain_mut(|tag| {
        if let Some(&existing_id) = name_to_id.get(&tag.name.to_lowercase()) {
            remap.insert(tag.id, existing_id);
            false
        } else {
            let new_id = store.alloc_tag_id();
            remap.insert(tag.id, new_id);
            name_to_id.insert(tag.name.to_lowercase(), new_id);
            tag.id = new_id;
            true
        }
    });

    remap
}

fn add_parsed_to_store(
    app: &tauri::AppHandle,
    store: &mut location_store::Store,
    parsed: &mut ParsedMap,
) -> Result<location_store::MutationResult, String> {
    let existing_tags = store.tags.clone();

    let tag_id_remap = reconcile_tags(store, parsed, &existing_tags);

    if !parsed.tags.is_empty() {
        for tag in &parsed.tags {
            store.tags.insert(tag.id, tag.clone());
        }
        store.tags_dirty = true;
    }

    for loc in &mut parsed.locations {
        loc.id = store.alloc_id();
        loc.tags = loc.tags.iter().filter_map(|&old| tag_id_remap.get(&old).copied()).collect();
    }

    if parsed.locations.len() <= 100_000 {
        for loc in &parsed.locations {
            let ci = location_store::render_cell_idx(loc.lat, loc.lng);
            store.cell_add_render(ci, loc.id);
            store.overlay_add(loc.clone());
            store.add_tag_counts(&[loc.clone()]);
        }
        store.push_undo(location_store::EditEntry {
            created: parsed.locations.clone(),
            removed: Vec::new(),
        });
    } else {
        store.bake_overlay();
        let import_batch = arrow_bridge::locations_to_batch(&parsed.locations);
        let new_batch = if let Some(existing) = store.batch.take() {
            if existing.num_rows() == 0 {
                import_batch
            } else {
                let s = std::sync::Arc::new(arrow_bridge::location_schema());
                arrow::compute::concat_batches(&s, &[existing, import_batch])
                    .map_err(|e| e.to_string())?
            }
        } else {
            import_batch
        };

        let map_id = store.map_id.as_ref().ok_or("no map open")?.clone();
        let path = fast_io::arrow_path(app, &map_id)?;
        fast_io::write_arrow_ipc(&path, &new_batch)?;

        for loc in &parsed.locations {
            store.add_tag_counts(&[loc.clone()]);
            let ci = location_store::render_cell_idx(loc.lat, loc.lng);
            store.cell_add_render(ci, loc.id);
        }
        store.alive_count += parsed.locations.len();

        store.batch = Some(new_batch);
        store.rebuild_index();

        if let Ok(delta_path) = fast_io::arrow_delta_path(app, &map_id) {
            let _ = std::fs::remove_file(delta_path);
        }
        let conn = fast_io::open_db(app)?;
        conn.execute("UPDATE maps SET location_count = ?1 WHERE id = ?2",
            rusqlite::params![store.alive_count, map_id]).map_err(|e| e.to_string())?;
        store.dirty = false;

        store.undo_stack.clear();
    }
    store.redo_stack.clear();

    let mut result = store.finish_mutation(
        location_store::ChangeSet { full_reset: true, ..Default::default() }
    );
    result.tags = Some(store.tags.clone());

    let extras: Vec<&serde_json::Map<String, serde_json::Value>> = parsed.locations.iter()
        .filter_map(|l| l.extra.as_ref())
        .collect();
    location_store::auto_register_extras(app, store, &extras, &mut result);
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn store_import_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, location_store::StoreState>,
    dropped_fields: Vec<String>,
) -> Result<EditorImportResult, String> {
    let t0 = std::time::Instant::now();
    let mut parsed = EDITOR_IMPORT_CACHE.lock().unwrap().take()
        .ok_or("no cached import — call store_import_preview first")?;

    let drop_set: std::collections::HashSet<&str> = dropped_fields.iter().map(|s| s.as_str()).collect();
    if !drop_set.is_empty() {
        for loc in &mut parsed.locations {
            if drop_set.contains("heading") { loc.heading = 0.0; }
            if drop_set.contains("pitch") { loc.pitch = 0.0; }
            if drop_set.contains("zoom") { loc.zoom = 0.0; }
            if drop_set.contains("panoId") { loc.pano_id = None; loc.flags &= !1; }
            if drop_set.contains("tags") { loc.tags.clear(); }
            if let Some(extra) = &mut loc.extra {
                extra.retain(|k, _| !drop_set.contains(format!("extra.{k}").as_str()));
                if extra.is_empty() { loc.extra = None; }
            }
        }
        if drop_set.contains("tags") { parsed.tags.clear(); }
    }
    log::debug!("[import] parse=cached locs={}", parsed.locations.len());

    let mut store = state.lock().map_err(|e| e.to_string())?;
    let mutation = add_parsed_to_store(&app, &mut store, &mut parsed)?;

    log::debug!("[import] total={:.0}ms locs={}", t0.elapsed().as_millis(), parsed.locations.len());

    Ok(EditorImportResult {
        imported_count: parsed.locations.len() as u32,
        warnings: parsed.warnings,
        mutation,
    })
}

/// Parse raw text (JSON or CSV) as locations and import into the open map.
/// Handles tag reconciliation, ID allocation, and render delta in one shot.
#[tauri::command]
#[specta::specta]
pub fn store_import_paste(
    app: tauri::AppHandle,
    state: tauri::State<'_, location_store::StoreState>,
    text: String,
) -> Result<(EditorImportResult, Option<u32>), String> {
    let t0 = std::time::Instant::now();
    let mut buf = text.into_bytes();
    let mut parsed = parse_file(&mut buf);
    if parsed.locations.is_empty() {
        return Err("no locations found".into());
    }
    log::debug!("[paste-import] parse={:.0}ms locs={}", t0.elapsed().as_millis(), parsed.locations.len());

    let mut store = state.lock().map_err(|e| e.to_string())?;
    let mutation = add_parsed_to_store(&app, &mut store, &mut parsed)?;

    log::debug!("[paste-import] total={:.0}ms locs={}", t0.elapsed().as_millis(), parsed.locations.len());

    let single_id = if parsed.locations.len() == 1 { parsed.locations.first().map(|l| l.id) } else { None };

    Ok((EditorImportResult {
        imported_count: parsed.locations.len() as u32,
        warnings: parsed.warnings,
        mutation,
    }, single_id))
}

#[cfg(test)]
#[path = "import.test.rs"]
mod tests;
