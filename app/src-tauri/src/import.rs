//! Import pipeline for JSON, CSV, and ZIP files containing map location data.
//!
//! Two import paths: **bulk import** creates new maps from files, and **editor
//! import** merges locations into the currently open map. JSON parsing uses
//! simd_json with parallel object deserialization via rayon. A two-phase
//! preview/confirm flow lets the user inspect data before committing.

use crate::types::AppResult;
use std::collections::HashMap;
use std::io::Read;
use std::sync::Mutex;

use rayon::prelude::*;
use rusqlite::Connection;
use serde_json::Value;
use uuid::Uuid;
use crate::util::{now_iso, now_unix};

use crate::arrow_bridge;
use crate::storage;
use crate::location_store;
use crate::types::{Tag, Location, LocationFlags};

/// Cached result from `bulk_import_preview` so `bulk_import_confirm` can
/// skip re-parsing. Keyed by file path to detect stale caches.
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
}

use crate::util::color_for_name;

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/// Parse CSV text into locations. Supports both named columns (lat/lng/heading/etc.)
/// and positional (first two numeric columns = lat, lng). Skips malformed rows silently.
fn parse_csv(text: &str) -> ParsedMap {
    let empty = || ParsedMap { name: String::new(), folder: None, locations: Vec::new(), tags: Vec::new(), fields: None, warnings: Vec::new() };
    let warn = |w: &str| { let mut m = empty(); m.warnings.push(w.into()); m };

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
    let lng_named = lower.iter().position(|h| h == "lng" || h == "longitude" || h == "lon");

    let (lat_idx, lng_idx, heading_idx, pitch_idx, zoom_idx, pano_idx, first_is_header) =
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
            let is_num = |s: &str| s.trim().parse::<f64>().map(f64::is_finite).unwrap_or(false);
            if !(first.get(0).is_some_and(is_num) && first.get(1).is_some_and(is_num)) {
                return warn("CSV missing lat/lng columns");
            }
            (0, 1, None, None, None, None, false)
        };

    let now = now_unix();
    let mut locations = Vec::new();

    let parse_row = |record: &csv::StringRecord| -> Option<Location> {
        let lat: f64 = record.get(lat_idx)?.trim().parse().ok().filter(|v: &f64| v.is_finite())?;
        let lng: f64 = record.get(lng_idx)?.trim().parse().ok().filter(|v: &f64| v.is_finite())?;
        let heading = heading_idx.and_then(|i| record.get(i)?.trim().parse().ok()).unwrap_or(0.0);
        let pitch = pitch_idx.and_then(|i| record.get(i)?.trim().parse().ok()).unwrap_or(0.0);
        let zoom = zoom_idx.and_then(|i| record.get(i)?.trim().parse().ok()).unwrap_or(0.0);
        let pano_id = pano_idx.and_then(|i| {
            let s = record.get(i)?.trim();
            if s.is_empty() { None } else { Some(s.to_string()) }
        });
        let flags = if pano_id.is_some() { LocationFlags::LOAD_AS_PANO_ID } else { LocationFlags::empty() };
        Some(Location {
            id: 0, lat, lng, heading, pitch, zoom, pano_id, flags,
            tags: Vec::new(), extra: None, created_at: now, modified_at: None,
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

    ParsedMap { name: String::new(), folder: None, locations, tags: Vec::new(), fields: None, warnings: Vec::new() }
}

struct ExtraTagMeta {
    color: Option<String>,
    order: Option<u32>,
}

/// Extract tag color/order metadata from the top-level `"extra"."tags"` block
/// without parsing the entire JSON. Uses a manual depth-tracking scanner to find
/// the `"extra"` key at depth 1, avoiding a full-document parse on multi-MB files.
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

/// Auto-detect format (JSON vs CSV) by first non-whitespace byte and dispatch.
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

/// Scan raw bytes for `{...}` object boundaries at depth 1 inside a JSON array.
/// Returns `(start, end)` byte offsets. This is the key to parallel parsing:
/// we find boundaries in a single pass, then hand each slice to rayon/simd_json.
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

/// Core JSON parser. Three-phase pipeline:
/// 1. **Scan** -- find metadata keys (`name`, `folder`) in the first 4-8KB,
///    then locate the coordinate array (`customCoordinates` or `locations`).
/// 2. **Boundary detection** -- single-pass scanner finds each `{...}` object
///    boundary inside the coordinate array.
/// 3. **Parallel parse** -- rayon hands each object slice to simd_json for
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

    let now = now_unix();
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
        let flags = if top_pano.is_some() { LocationFlags::LOAD_AS_PANO_ID } else { LocationFlags::empty() };

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
                created_at: now,
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

// ---------------------------------------------------------------------------
// Zip orchestration
// ---------------------------------------------------------------------------

fn read_zip_entries(path: &str) -> AppResult<Vec<(String, String)>> {
    let file = std::fs::File::open(path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip: {}", e))?;

    let mut entries = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if entry.is_dir() || !entry.name().ends_with(".json") { continue; }
        let name = entry.name().to_string();
        let mut text = String::new();
        entry.read_to_string(&mut text)?;
        entries.push((name, text));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}

fn read_single_json(path: &str) -> AppResult<Vec<(String, String)>> {
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

/// Persist a parsed map as a new database entry + Arrow IPC file.
/// Assigns sequential u32 location IDs starting at 1.
fn write_map_to_db(conn: &Connection, mut map: ParsedMap) -> AppResult<ImportedMapInfo> {
    let map_id = Uuid::new_v4().to_string();
    let now = now_iso();
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
        rusqlite::params![map_id, map.name, map.folder, crate::map_meta::default_settings_json(), extra_json, tags_json, loc_count, now, now],
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

        let results: Vec<ImportPreviewEntry> = maps.iter().map(|m| ImportPreviewEntry {
            name: if m.name.is_empty() { "Untitled".to_string() } else { m.name.clone() },
            folder: m.folder.clone(),
            location_count: m.locations.len() as u32,
            tag_count: m.tags.len() as u32,
            warnings: m.warnings.clone(),
        }).collect();

        *CACHED_PARSE.lock().unwrap() = Some(CachedImport { path, maps });

        Ok(results)
    }).await?
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
        let conn = Connection::open(&main_path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;

        let mut results = Vec::with_capacity(parsed_maps.len());
        for (i, map) in parsed_maps.into_iter().enumerate() {
            let map_name = map.name.clone();
            let info = write_map_to_db(&conn, map)?;
            crate::emit_event("bulk-import-progress", ImportProgress {
                current: (i + 1) as u32,
                total,
                map_name,
            });
            results.push(info);
        }

        Ok(results)
    }).await?
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
fn write_preview_positions(locs: &[Location]) -> AppResult<String> {
    let mut buf: Vec<u8> = Vec::with_capacity(locs.len() * 8);
    for l in locs {
        buf.extend_from_slice(&(l.lng as f32).to_le_bytes());
        buf.extend_from_slice(&(l.lat as f32).to_le_bytes());
    }
    let path = std::env::temp_dir().join("mma_import_preview.bin");
    std::fs::write(&path, &buf)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Build preview stats from a parsed map and cache the parse for commit.
fn build_preview(parsed: ParsedMap) -> AppResult<EditorImportPreview> {
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

    let preview_positions_path = write_preview_positions(&parsed.locations)?;

    let preview = EditorImportPreview {
        location_count: parsed.locations.len() as u32,
        tags: parsed.tags.clone(),
        fields,
        warnings: parsed.warnings.clone(),
        preview_positions_path,
        bounds: crate::util::compute_bounds(parsed.locations.iter().map(|l| (l.lat, l.lng))),
        will_auto_commit: parsed.locations.len() > IMPORT_AUTOCOMMIT_THRESHOLD,
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
    parsed.locations.get(index as usize).cloned().ok_or_else(|| "staged index out of range".into())
}

/// Parse a file and return field-level statistics + preview positions for the editor
/// import sidebar. Caches the parse result for `store_import_file` to consume on commit.
#[tauri::command]
#[specta::specta]
pub fn store_import_preview(path: String) -> AppResult<EditorImportPreview> {
    let t0 = std::time::Instant::now();
    let mut buf = std::fs::read(&path)?;
    let t_read = t0.elapsed();
    let parsed = parse_file(&mut buf);
    log::debug!("[import-preview] read={:.0}ms parse={:.0}ms locs={}", t_read.as_millis(), t0.elapsed().as_millis(), parsed.locations.len());
    build_preview(parsed)
}

/// Parse pasted text (JSON or CSV) and stage it for preview, exactly like
/// `store_import_preview` does for a file. Caches the parse for `store_import_file`.
#[tauri::command]
#[specta::specta]
pub fn store_import_paste_preview(text: String) -> AppResult<EditorImportPreview> {
    let t0 = std::time::Instant::now();
    let mut buf = text.into_bytes();
    let parsed = parse_file(&mut buf);
    if parsed.locations.is_empty() {
        return Err("no locations found".into());
    }
    log::debug!("[paste-preview] parse={:.0}ms locs={}", t0.elapsed().as_millis(), parsed.locations.len());
    build_preview(parsed)
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
}


/// Insert pre-deduped copied locations (cross-map copy) through the same path
/// as editor import: tag reconcile, id alloc, counts, field defs, undo entry,
/// and render cell registration. `tags` are the source tag defs referenced by
/// `locations`.
pub(crate) fn add_copied_to_store(
    store: &mut location_store::Store,
    locations: Vec<Location>,
    tags: Vec<Tag>,
) -> AppResult<()> {
    let mut parsed = ParsedMap {
        name: String::new(),
        folder: None,
        locations,
        tags,
        fields: None,
        warnings: Vec::new(),
    };
    add_parsed_to_store(store, &mut parsed, None)?;
    Ok(())
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
    let tag_id_remap = {
        let tags = &mut store.tags;
        let before = tags.all.len();
        let remap = location_store::reconcile_tags_by_name(&parsed.tags, &mut tags.all, &mut tags.next_id);
        if tags.all.len() > before {
            tags.dirty = true;
        }
        remap
    };

    for loc in &mut parsed.locations {
        loc.id = store.alloc_id();
        loc.tags = loc.tags.iter().filter_map(|&old| tag_id_remap.get(&old).copied()).collect();
    }

    // Find-or-create the bulk tag (case-insensitive) and apply it to every location.
    if let Some(name) = bulk_tag.map(str::trim).filter(|n| !n.is_empty()) {
        let tag_id = store.tags.all.values()
            .find(|t| t.name.eq_ignore_ascii_case(name))
            .map(|t| t.id)
            .unwrap_or_else(|| {
                let id = store.alloc_tag_id();
                store.tags.all.insert(id, Tag {
                    id,
                    name: name.to_string(),
                    color: crate::util::color_for_name(name),
                    visible: true,
                    order: None,
                    count: 0,
                });
                store.tags.dirty = true;
                id
            });
        for loc in &mut parsed.locations {
            if !loc.tags.contains(&tag_id) { loc.tags.push(tag_id); }
        }
    }

    store.add_tag_counts(&parsed.locations);

    // Discover new extra-field defs from the locations now, before we consume them.
    let new_field_defs = {
        let extras: Vec<&serde_json::Map<String, serde_json::Value>> = parsed.locations.iter()
            .filter_map(|l| l.extra.as_ref())
            .collect();
        crate::map_meta::auto_register_field_defs(&store.known_field_keys, &extras)
    };

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

    for loc in std::mem::take(&mut parsed.locations) {
        let ci = location_store::render_cell_idx(loc.lat, loc.lng);
        store.cell_add_render(ci, loc.id);
        store.overlay_add(loc);
    }

    let mut result = store.finish_mutation(
        location_store::ChangeSet { full_reset: true, ..Default::default() }
    );
    result.tags = Some(store.tags.all.clone());

    if let Some(new_defs) = new_field_defs {
        location_store::apply_field_defs(store, new_defs, &mut result);
    }
    Ok(result)
}

/// Commit a previously previewed editor import, optionally dropping fields and/or
/// applying a bulk tag to every imported location. Consumes the cached parse from
/// `store_import_preview`/`store_import_paste_preview`. Fields in `dropped_fields`
/// (e.g. `"heading"`, `"extra.countryCode"`) are zeroed/removed.
#[tauri::command]
#[specta::specta]
pub fn store_import_file(
    webview: tauri::Webview,
    state: tauri::State<'_, location_store::StoreState>,
    dropped_fields: Vec<String>,
    tag_name: Option<String>,
) -> AppResult<EditorImportResult> {
    let t0 = std::time::Instant::now();
    let mut parsed = EDITOR_IMPORT_CACHE.lock().unwrap().take()
        .ok_or("no cached import — call store_import_preview first")?;

    let drop_set: std::collections::HashSet<&str> = dropped_fields.iter().map(|s| s.as_str()).collect();
    if !drop_set.is_empty() {
        for loc in &mut parsed.locations {
            if drop_set.contains("heading") { loc.heading = 0.0; }
            if drop_set.contains("pitch") { loc.pitch = 0.0; }
            if drop_set.contains("zoom") { loc.zoom = 0.0; }
            if drop_set.contains("panoId") { loc.pano_id = None; loc.flags.remove(LocationFlags::LOAD_AS_PANO_ID); }
            if drop_set.contains("tags") { loc.tags.clear(); }
            if let Some(extra) = &mut loc.extra {
                extra.retain(|k, _| !drop_set.contains(format!("extra.{k}").as_str()));
                if extra.is_empty() { loc.extra = None; }
            }
        }
        if drop_set.contains("tags") { parsed.tags.clear(); }
    }
    // Capture before add_parsed_to_store, which consumes parsed.locations (moves them
    // into the overlay) leaving the vec empty.
    let imported_count = parsed.locations.len() as u32;
    let auto_commit = parsed.locations.len() > IMPORT_AUTOCOMMIT_THRESHOLD;
    log::debug!("[import] parse=cached locs={}", imported_count);

    with_store!(webview, state, |store| {
        let mutation = add_parsed_to_store(store, &mut parsed, tag_name.as_deref())?;

        log::debug!("[import] total={:.0}ms locs={}", t0.elapsed().as_millis(), imported_count);

        Ok(EditorImportResult {
            imported_count,
            auto_commit,
            warnings: parsed.warnings,
            mutation,
        })
    })
}

#[cfg(test)]
#[path = "import.test.rs"]
mod tests;
