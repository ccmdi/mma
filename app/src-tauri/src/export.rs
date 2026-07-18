//! Location data export in JSON, CSV, GeoJSON, and bulk ZIP formats.
//! All exports write to temp files and return the path -- the frontend
//! triggers a native save dialog to move the file to its final destination.

use crate::location_store::StoreState;
use crate::storage;
use crate::types::LocationFlags;
use crate::types::{AppError, AppResult};
use crate::util::hex_to_rgb;
use std::io::Write;

/// Configuration for JSON export. Controls which fields are included and
/// whether the export covers all locations or a specific selection.
#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportOpts {
    pub export_zoom: bool,
    pub export_unpanned: bool,
    pub export_extras: bool,
    /// When `Some`, restricts export to these location IDs (e.g. current selection).
    pub scope: Option<Vec<u32>>,
    pub map_name: String,
    /// Serialized `{id: {name, color}}` tag definitions from the store, used to
    /// convert numeric tag IDs back to human-readable names in the output.
    pub tags_json: String,
    pub extra_fields_json: Option<String>,
}

#[cfg(test)]
#[path = "export.test.rs"]
mod tests;

/// Unique temp path for an export file. A process-wide counter disambiguates
/// concurrent exports (PID alone collides).
fn export_temp_path(stem: &str, ext: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{stem}_{}_{n}.{ext}", std::process::id()))
}

/// Parse `{id: {name, color}}` tag definitions JSON into the raw defs map plus an id -> name lookup.
fn parse_tag_defs(
    tags_json: &str,
) -> (
    std::collections::HashMap<String, serde_json::Value>,
    std::collections::HashMap<u32, String>,
) {
    let tag_defs: std::collections::HashMap<String, serde_json::Value> =
        serde_json::from_str(tags_json).unwrap_or_default();
    let id_to_name = tag_defs
        .iter()
        .filter_map(|(k, v)| {
            let id = k.parse::<u32>().ok()?;
            let name = v.get("name")?.as_str()?.to_string();
            Some((id, name))
        })
        .collect();
    (tag_defs, id_to_name)
}

/// Convert tag defs to the export metadata shape `{name: {color: [r,g,b], order}}`.
fn tag_color_meta(
    tag_defs: &std::collections::HashMap<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut converted = serde_json::Map::new();
    for v in tag_defs.values() {
        if let (Some(name), Some(color)) = (
            v.get("name").and_then(|n| n.as_str()),
            v.get("color").and_then(|c| c.as_str()),
        ) {
            let mut entry = serde_json::Map::new();
            if let Some(rgb) = hex_to_rgb(color) {
                entry.insert("color".into(), serde_json::json!([rgb[0], rgb[1], rgb[2]]));
            }
            if let Some(order) = v.get("order").and_then(|o| o.as_u64()) {
                entry.insert("order".into(), serde_json::json!(order));
            }
            converted.insert(name.to_string(), serde_json::Value::Object(entry));
        }
    }
    converted
}

/// Toggles for rendering a `Location` into a map-making JSON coordinate object.
struct CoordOpts {
    export_zoom: bool,
    export_unpanned: bool,
    export_extras: bool,
}

/// Internal provider id → GeoGuessr-style JSON `source` value.
fn provider_to_wire_source(provider: &str) -> Option<&'static str> {
    match provider {
        "apple" => Some("apple_pano"),
        "baidu" => Some("baidu_pano"),
        "tencent" => Some("qq_pano"),
        "yandex" => Some("yandex_pano"),
        _ => None,
    }
}

/// Strip alt-provider pano id prefixes for export (storage wire format).
fn strip_export_pano_prefix(pano_id: &str) -> &str {
    const PREFIXES: &[&str] = &["APPLE:", "BAIDU:", "TENCENT:", "YANDEX:"];
    for prefix in PREFIXES {
        if let Some(raw) = pano_id.strip_prefix(prefix) {
            return raw;
        }
    }
    pano_id
}

/// Convert one location to a `{lat, lng, heading, ...}` coordinate object.
/// Single source of truth for the export wire shape shared by JSON and bulk ZIP.
/// `countryCode`/`stateCode` are always hoisted to the top level; all other
/// `extra` fields nest under `extra`.
/// Non-Google providers export as `source: "*_pano"` (never `provider`) with an
/// empty `extra` object — matching the alt-provider GeoGuessr wire format.
fn location_to_coord(
    loc: &crate::types::Location,
    id_to_name: &std::collections::HashMap<u32, String>,
    opts: &CoordOpts,
) -> serde_json::Value {
    use serde_json::{json, Value};
    let pinned = loc.flags.contains(LocationFlags::LOAD_AS_PANO_ID);
    let provider = loc.provider.as_deref().unwrap_or("google");
    let wire_source = provider_to_wire_source(provider);
    let is_alt = wire_source.is_some();
    let mut c = serde_json::Map::new();

    c.insert("lat".into(), json!(loc.lat));
    c.insert("lng".into(), json!(loc.lng));
    let heading = if opts.export_unpanned && loc.heading == 0.0 {
        0.001
    } else {
        loc.heading
    };
    c.insert("heading".into(), json!(heading));
    c.insert("pitch".into(), json!(loc.pitch));
    c.insert(
        "zoom".into(),
        json!(if opts.export_zoom { loc.zoom } else { 0.0 }),
    );
    c.insert(
        "panoId".into(),
        if pinned || (is_alt && loc.pano_id.is_some()) {
            json!(loc.pano_id.as_ref().map(|id| strip_export_pano_prefix(id)))
        } else {
            Value::Null
        },
    );
    if let Some(source) = wire_source {
        c.insert("source".into(), json!(source));
    }

    for k in ["countryCode", "stateCode"] {
        c.insert(
            k.into(),
            loc.extra
                .as_ref()
                .and_then(|e| e.get(k))
                .unwrap_or(Value::Null),
        );
    }

    if is_alt {
        // Alt-provider GG wire format: always emit an empty extra object; never
        // re-export internal tags / enrichment under `extra`.
        c.insert("extra".into(), Value::Object(serde_json::Map::new()));
    } else if opts.export_extras {
        let mut extra = serde_json::Map::new();
        if let Some(ref e) = loc.extra {
            for (k, v) in e.to_map() {
                if k == "countryCode" || k == "stateCode" {
                    continue;
                }
                extra.insert(k, v);
            }
        }
        if !loc.tags.is_empty() {
            let names: Vec<Value> = loc
                .tags
                .iter()
                .map(|id| {
                    json!(id_to_name
                        .get(id)
                        .cloned()
                        .unwrap_or_else(|| id.to_string()))
                })
                .collect();
            extra.insert("tags".into(), json!(names));
        }
        // Google historically kept unpinned panoId under extra.
        if !pinned && loc.pano_id.is_some() {
            extra.insert(
                "panoId".into(),
                json!(strip_export_pano_prefix(loc.pano_id.as_ref().unwrap())),
            );
        }
        if !extra.is_empty() {
            c.insert("extra".into(), Value::Object(extra));
        }
    }

    Value::Object(c)
}

/// Export locations as a JSON file.
///
/// Produces `{name, customCoordinates: [...]}` with optional `extra` block
/// containing tags (with colors as RGB arrays) and field definitions.
/// Heading of exactly 0 is written as 0.001 when `export_unpanned` is set,
/// the convention for "no heading specified".
#[tauri::command]
#[specta::specta]
pub fn store_export_json(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    opts: ExportOpts,
) -> AppResult<String> {
    with_store!(webview, state, |store| {
        let (tag_defs, id_to_name) = parse_tag_defs(&opts.tags_json);
        let locs = store.collect_scoped(opts.scope.as_deref());

        let co = CoordOpts {
            export_zoom: opts.export_zoom,
            export_unpanned: opts.export_unpanned,
            export_extras: opts.export_extras,
        };
        let coords: Vec<serde_json::Value> = locs
            .iter()
            .map(|loc| location_to_coord(loc, &id_to_name, &co))
            .collect();

        let mut parts = serde_json::Map::new();
        if !opts.map_name.is_empty() {
            parts.insert("name".into(), serde_json::json!(opts.map_name));
        }
        parts.insert("customCoordinates".into(), serde_json::Value::Array(coords));

        if opts.export_extras {
            let mut extra = serde_json::Map::new();
            if !tag_defs.is_empty() {
                let converted = tag_color_meta(&tag_defs);
                if !converted.is_empty() {
                    extra.insert("tags".into(), serde_json::Value::Object(converted));
                }
            }
            if let Some(ref fields_json) = opts.extra_fields_json {
                if let Ok(fields) = serde_json::from_str::<serde_json::Value>(fields_json) {
                    extra.insert("fields".into(), fields);
                }
            }
            if !extra.is_empty() {
                parts.insert("extra".into(), serde_json::Value::Object(extra));
            }
        }

        let json = serde_json::to_string(&serde_json::Value::Object(parts))?;

        let path = export_temp_path("mma_export", "json");
        std::fs::write(&path, &json)?;
        Ok(path.to_string_lossy().into_owned())
    })
}

/// Export locations as a minimal lat/lng CSV file.
#[tauri::command]
#[specta::specta]
pub fn store_export_csv(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    scope: Option<Vec<u32>>,
) -> AppResult<String> {
    with_store!(webview, state, |store| {
        let locs = store.collect_scoped(scope.as_deref());

        let mut buf = String::with_capacity(locs.len() * 30);
        buf.push_str("lat,lng\n");
        for loc in &locs {
            buf.push_str(&format!("{},{}\n", loc.lat, loc.lng));
        }

        let path = export_temp_path("mma_export", "csv");
        std::fs::write(&path, &buf)?;
        Ok(path.to_string_lossy().into_owned())
    })
}

/// Export locations as a GeoJSON FeatureCollection of Point features.
/// Each feature carries its tag names in `properties.tags`.
#[tauri::command]
#[specta::specta]
pub fn store_export_geojson(
    webview: tauri::Webview,
    state: tauri::State<'_, StoreState>,
    scope: Option<Vec<u32>>,
    tags_json: String,
) -> AppResult<String> {
    with_store!(webview, state, |store| {
        let (_, id_to_name) = parse_tag_defs(&tags_json);
        let locs = store.collect_scoped(scope.as_deref());

        let features: Vec<serde_json::Value> = locs
            .iter()
            .map(|l| {
                let tag_names: Vec<String> = l
                    .tags
                    .iter()
                    .map(|id| {
                        id_to_name
                            .get(id)
                            .cloned()
                            .unwrap_or_else(|| id.to_string())
                    })
                    .collect();
                serde_json::json!({
                    "type": "Feature",
                    "geometry": { "type": "Point", "coordinates": [l.lng, l.lat] },
                    "properties": { "tags": tag_names }
                })
            })
            .collect();

        let geojson = serde_json::json!({ "type": "FeatureCollection", "features": features });
        let json = serde_json::to_string(&geojson)?;

        let path = export_temp_path("mma_export", "geojson");
        std::fs::write(&path, &json)?;
        Ok(path.to_string_lossy().into_owned())
    })
}

/// Copy a temp export file to the destination chosen via the native save dialog,
/// then remove the temp source. `dest_path` comes from the frontend save dialog.
#[tauri::command]
#[specta::specta]
pub fn store_save_export_file(src_path: String, dest_path: String) -> AppResult<()> {
    std::fs::copy(&src_path, &dest_path)?;
    let _ = std::fs::remove_file(&src_path);
    Ok(())
}

/// Validate that `path` is an upload session dir: a direct child of the
/// system temp dir named `mma_upload_*`. Guards both the session commands and
/// the `mma-buf` POST handler against arbitrary file writes.
pub(crate) fn upload_session_dir(path: &str) -> AppResult<std::path::PathBuf> {
    let p = std::path::PathBuf::from(path);
    let valid = p.parent() == Some(std::env::temp_dir().as_path())
        && p.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("mma_upload_"));
    if !valid {
        return Err("invalid upload session dir".into());
    }
    Ok(p)
}

/// Create a temp session dir for binary uploads from the frontend. Files are
/// written into it via `mma-buf://` POST, then packaged by [`store_upload_finish`].
#[tauri::command]
#[specta::specta]
pub fn store_upload_begin() -> AppResult<String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("mma_upload_{}_{n}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Package an upload session and remove its dir: a single file is moved out
/// as-is, multiple are packed into a Stored ZIP (entries like JPEG/PNG are
/// already compressed). Returns a temp path for [`store_save_export_file`].
#[tauri::command]
#[specta::specta]
pub fn store_upload_finish(session_dir: String) -> AppResult<String> {
    let dir = upload_session_dir(&session_dir)?;
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    files.sort();

    if files.is_empty() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("no files in session".into());
    }

    let out = if let [single] = files.as_slice() {
        let ext = single
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_string();
        let out = export_temp_path("mma_upload_file", &ext);
        std::fs::rename(single, &out)?;
        out
    } else {
        let out = export_temp_path("mma_upload", "zip");
        let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(std::fs::File::create(&out)?));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for f in &files {
            let name = f.file_name().unwrap_or_default().to_string_lossy();
            zip.start_file(name, options)?;
            zip.write_all(&std::fs::read(f)?)?;
        }
        zip.finish()?.flush()?;
        out
    };

    let _ = std::fs::remove_dir_all(&dir);
    Ok(out.to_string_lossy().into_owned())
}

/// Remove an abandoned upload session dir (e.g. cancelled operation).
#[tauri::command]
#[specta::specta]
pub fn store_upload_abort(session_dir: String) -> AppResult<()> {
    let dir = upload_session_dir(&session_dir)?;
    let _ = std::fs::remove_dir_all(&dir);
    Ok(())
}

/// Export every map in the database as a deflate-compressed ZIP of JSON files.
///
/// Each map becomes one `{name}.json` file in the archive, with full location
/// data, tags, and extra fields. Reads Arrow IPC files directly from disk
/// (bypasses the in-memory store). Duplicate map names get a numeric suffix.
/// Runs on a blocking thread to avoid starving the async runtime.
#[tauri::command]
#[specta::specta]
pub async fn store_export_bulk_zip() -> AppResult<String> {
    let path = tokio::task::spawn_blocking(move || {
        use std::io::Cursor;

        let conn = storage::open_db()?;
        let mut stmt = conn.prepare("SELECT id, name, folder, tags, extra FROM maps")?;
        let maps: Vec<(String, String, Option<String>, String, String)> = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        drop(conn);
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);

            let mut used_names = std::collections::HashSet::new();
            let total = maps.len();

            for (i, (map_id, name, _folder, tags_json, extra_json)) in maps.iter().enumerate() {
                crate::emit_event(
                    "bulk-export-progress",
                    serde_json::json!({
                        "current": i + 1, "total": total, "mapName": name,
                    }),
                );
                // Base file + uncommitted delta sidecar = the map's full current state.
                let locs = crate::location_store::read_full_state_from_disk(map_id)?;

                let (tag_defs, id_to_name) = parse_tag_defs(tags_json);

                let co = CoordOpts {
                    export_zoom: true,
                    export_unpanned: false,
                    export_extras: true,
                };
                let coords: Vec<serde_json::Value> = locs
                    .iter()
                    .map(|loc| location_to_coord(loc, &id_to_name, &co))
                    .collect();

                let mut entry = serde_json::Map::new();
                entry.insert("name".into(), serde_json::json!(name));
                entry.insert("customCoordinates".into(), serde_json::Value::Array(coords));

                // Tag color metadata
                if !tag_defs.is_empty() {
                    let converted = tag_color_meta(&tag_defs);
                    let mut extra_meta = serde_json::Map::new();
                    extra_meta.insert("tags".into(), serde_json::Value::Object(converted));
                    if let Ok(fields) = serde_json::from_str::<serde_json::Value>(extra_json) {
                        if let Some(f) = fields.get("fields") {
                            extra_meta.insert("fields".into(), f.clone());
                        }
                    }
                    entry.insert("extra".into(), serde_json::Value::Object(extra_meta));
                }

                let json = serde_json::to_string(&serde_json::Value::Object(entry))?;

                let base = name.replace(|c: char| "<>:\"/\\|?*".contains(c), "_");
                let mut file_name = base.clone();
                let mut i = 2;
                while used_names.contains(&file_name.to_lowercase()) {
                    file_name = format!("{base} ({i})");
                    i += 1;
                }
                used_names.insert(file_name.to_lowercase());

                zip.start_file(format!("{file_name}.json"), options)?;
                zip.write_all(json.as_bytes())?;
            }
            zip.finish()?;
        }

        let path = export_temp_path("mma_backup", "zip");
        std::fs::write(&path, buf.into_inner())?;
        Ok::<_, AppError>(path.to_string_lossy().into_owned())
    })
    .await??;

    Ok(path)
}
