//! Location data export in JSON, CSV, GeoJSON, and bulk ZIP formats.
//! All exports write to temp files and return the path -- the frontend
//! triggers a native save dialog to move the file to its final destination.

use crate::selections::{tree::SelectionInput, Selector};
use crate::store::engine::{with_store, StoreState, ValueRecord, WindowLabel};
use crate::store::{engine, storage};
use crate::types::shape::{MapPart, MapShape};
use crate::types::{AppError, AppResult, Location, LocationFlags};
use crate::util::Rgb;
use mma_algebra::Id;
use serde::de::DeserializeOwned;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::{env, fs, process};
use tokio::task;
use zip::write::SimpleFileOptions;

/// The kind of file an export writes, with what that kind needs.
#[derive(serde::Deserialize, specta::Type)]
#[serde(
    tag = "format",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExportFormat {
    /// A `{name, customCoordinates}` map file with its tags and field definitions.
    Json(JsonExport),
    /// A minimal lat/lng CSV file.
    Csv,
    /// A GeoJSON FeatureCollection of points, each carrying its tag names in `properties.tags`.
    Geojson {
        /// Serialized `{id: {name, color}}` tag definitions from the store.
        tags_json: String,
    },
}

/// A map-making JSON export: how its coordinates render, and the map they belong to.
#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonExport {
    #[serde(flatten)]
    pub coords: CoordOpts,
    pub map_name: String,
    /// Serialized `{id: {name, color}}` tag definitions from the store, used to
    /// convert numeric tag IDs back to human-readable names in the output.
    pub tags_json: String,
    pub extra_fields_json: Option<String>,
}

#[cfg(test)]
#[path = "export.test.rs"]
mod tests;

/// Unique temp path for an export file or upload session. A process-wide counter disambiguates
/// concurrent ones (PID alone collides).
fn unique_temp_path(stem: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    env::temp_dir().join(format!("{stem}_{}_{n}", process::id()))
}

/// Parse `{id: {name, color}}` tag definitions JSON into the raw defs map plus an id -> name lookup.
fn parse_tag_defs(
    tags_json: &str,
) -> (
    HashMap<String, serde_json::Value>,
    HashMap<Id<ValueRecord>, String>,
) {
    let tag_defs: HashMap<String, serde_json::Value> =
        serde_json::from_str(tags_json).unwrap_or_default();
    let id_to_name = tag_defs
        .iter()
        .filter_map(|(k, v)| {
            let id = Id::new(k.parse::<u32>().ok()?);
            let name = v.get("name")?.as_str()?.to_string();
            Some((id, name))
        })
        .collect();
    (tag_defs, id_to_name)
}

/// Convert tag defs to the export metadata shape `{name: {color: [r,g,b], order}}`.
fn tag_color_meta(
    tag_defs: &HashMap<String, serde_json::Value>,
    shape: MapShape,
) -> serde_json::Map<String, serde_json::Value> {
    let mut converted = serde_json::Map::new();
    for v in tag_defs.values() {
        if let Some(name) = v.get("name").and_then(|n| n.as_str()) {
            let mut entry = serde_json::Map::new();
            if let Some(Ok(rgb)) = v
                .get("color")
                .and_then(|c| c.as_str())
                .map(str::parse::<Rgb>)
            {
                entry.insert("color".into(), serde_json::json!(rgb));
            }
            if let Some(order) = v.get("order").and_then(serde_json::Value::as_u64) {
                entry.insert("order".into(), serde_json::json!(order));
            }
            if let Some(links) = v.get("doclinks").and_then(|d| d.as_array()) {
                if !links.is_empty() && shape.keeps(MapPart::AppData) {
                    entry.insert("doclinks".into(), serde_json::Value::Array(links.clone()));
                }
            }
            converted.insert(name.to_string(), serde_json::Value::Object(entry));
        }
    }
    converted
}

/// How a location renders into a map-making JSON coordinate object.
#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CoordOpts {
    pub export_zoom: bool,
    pub export_unpanned: bool,
    /// How much of the map the file keeps.
    pub shape: MapShape,
}

/// Convert one location to a `{lat, lng, heading, ...}` coordinate object.
/// Single source of truth for the export wire shape shared by JSON and bulk ZIP.
/// `countryCode`/`stateCode` are always hoisted to the top level; all other
/// `extra` fields nest under `extra`.
fn location_to_coord(
    loc: &Location,
    id_to_name: &HashMap<Id<ValueRecord>, String>,
    opts: &CoordOpts,
) -> serde_json::Value {
    use serde_json::{json, Value};
    let pinned = loc.flags.contains(LocationFlags::LOAD_AS_PANO_ID);
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
        if pinned {
            json!(loc.pano_id)
        } else {
            Value::Null
        },
    );

    for k in ["countryCode", "stateCode"] {
        c.insert(
            k.into(),
            loc.extra
                .as_ref()
                .and_then(|e| e.get(k))
                .unwrap_or(Value::Null),
        );
    }

    let shape = opts.shape;
    let mut extra = serde_json::Map::new();
    if let Some(ref e) = loc.extra {
        if shape.keeps(MapPart::AppData) {
            for (k, v) in e.to_map() {
                if k == "countryCode" || k == "stateCode" {
                    continue;
                }
                extra.insert(k, v);
            }
        } else if shape.keeps(MapPart::PanoDate) {
            if let Some(date) = e.get("panoDate") {
                extra.insert("panoDate".into(), date);
            }
        }
    }
    if shape.keeps(MapPart::Tags) && !loc.tags.is_empty() {
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
    if shape.keeps(MapPart::UnpinnedPano) && !pinned && loc.pano_id.is_some() {
        extra.insert("panoId".into(), json!(loc.pano_id));
    }
    if !extra.is_empty() {
        c.insert("extra".into(), Value::Object(extra));
    }

    Value::Object(c)
}

/// The map-making JSON document: `name`, every location as a coordinate object, and under
/// `extra` the tag metadata and field definitions. The one shape both the single-map
/// export and the bulk zip write; the parser reads it back.
pub(crate) fn export_document(
    name: &str,
    locs: &[Location],
    tags_json: &str,
    fields: Option<serde_json::Value>,
    co: &CoordOpts,
) -> serde_json::Value {
    let (tag_defs, id_to_name) = parse_tag_defs(tags_json);
    let coords: Vec<serde_json::Value> = locs
        .iter()
        .map(|loc| location_to_coord(loc, &id_to_name, co))
        .collect();

    let mut parts = serde_json::Map::new();
    if !name.is_empty() {
        parts.insert("name".into(), serde_json::json!(name));
    }
    parts.insert("customCoordinates".into(), serde_json::Value::Array(coords));

    let mut extra = serde_json::Map::new();
    if co.shape.keeps(MapPart::Tags) && !tag_defs.is_empty() {
        let converted = tag_color_meta(&tag_defs, co.shape);
        if !converted.is_empty() {
            extra.insert("tags".into(), serde_json::Value::Object(converted));
        }
    }
    if let Some(fields) = fields.filter(|_| co.shape.keeps(MapPart::AppData)) {
        extra.insert("fields".into(), fields);
    }
    if !extra.is_empty() {
        parts.insert("extra".into(), serde_json::Value::Object(extra));
    }
    serde_json::Value::Object(parts)
}

/// The minimal `lat,lng` CSV.
pub(crate) fn csv_document(locs: &[Location]) -> String {
    let mut buf = String::with_capacity(locs.len() * 30);
    buf.push_str("lat,lng\n");
    for loc in locs {
        buf.push_str(&format!("{},{}\n", loc.lat, loc.lng));
    }
    buf
}

/// A GeoJSON FeatureCollection of Point features, each carrying its tag names.
pub(crate) fn geojson_document(locs: &[Location], tags_json: &str) -> serde_json::Value {
    let (_, id_to_name) = parse_tag_defs(tags_json);
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
    serde_json::json!({ "type": "FeatureCollection", "features": features })
}

/// Write the selected locations to a temporary file in `format` and return its path.
// Heading of exactly 0 is written as 0.001 when `export_unpanned` is set ("no heading" convention).
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
#[specta::specta]
pub async fn store_export(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector<SelectionInput>,
    format: ExportFormat,
) -> AppResult<String> {
    task::block_in_place(|| {
        with_store!(label, state, |store| {
            let locs = store
                .at(&engine::Target::Map { id: None })
                .rows(&selector.map_children(SelectionInput::compile));
            let (ext, body) = match format {
                ExportFormat::Json(json) => {
                    let fields = json
                        .extra_fields_json
                        .as_deref()
                        .and_then(|f| serde_json::from_str(f).ok());
                    let doc = export_document(
                        &json.map_name,
                        &locs,
                        &json.tags_json,
                        fields,
                        &json.coords,
                    );
                    ("json", serde_json::to_string(&doc)?)
                }
                ExportFormat::Csv => ("csv", csv_document(&locs)),
                ExportFormat::Geojson { tags_json } => (
                    "geojson",
                    serde_json::to_string(&geojson_document(&locs, &tags_json))?,
                ),
            };
            let path = unique_temp_path("mma_export").with_extension(ext);
            fs::write(&path, &body)?;
            Ok(path.to_string_lossy().into_owned())
        })
    })
}

/// Move a temp export file to `destPath` and remove the temp source.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
#[specta::specta]
pub fn store_save_export_file(src_path: String, dest_path: String) -> AppResult<()> {
    fs::copy(&src_path, &dest_path)?;
    let _ = fs::remove_file(&src_path);
    Ok(())
}

/// Validate that `path` is an upload session dir: a direct child of the
/// system temp dir named `mma_upload_*`. Guards both the session commands and
/// the `mma-buf` POST handler against arbitrary file writes.
pub(crate) fn upload_session_dir(path: &str) -> AppResult<PathBuf> {
    let p = PathBuf::from(path);
    let valid = p.parent() == Some(env::temp_dir().as_path())
        && p.file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("mma_upload_"));
    if !valid {
        return Err("invalid upload session dir".into());
    }
    Ok(p)
}

/// Whether `path` is a file directly inside an upload session dir.
pub(crate) fn is_upload_file(path: &Path) -> bool {
    path.parent()
        .and_then(|p| p.to_str())
        .is_some_and(|p| upload_session_dir(p).is_ok())
}

/// Create a temp session directory for binary uploads. Files written into it are
/// packaged by `storeUploadFinish`.
#[tauri::command]
#[specta::specta]
pub fn store_upload_begin() -> AppResult<String> {
    let dir = unique_temp_path("mma_upload");
    fs::create_dir_all(&dir)?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Package an upload session's files into a single output and remove the session
/// directory. Returns a temp path for `storeSaveExportFile`.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
#[specta::specta]
pub fn store_upload_finish(session_dir: String) -> AppResult<String> {
    let dir = upload_session_dir(&session_dir)?;
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    files.sort();

    if files.is_empty() {
        let _ = fs::remove_dir_all(&dir);
        return Err("no files in session".into());
    }

    let out = if let [single] = files.as_slice() {
        let ext = single
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_string();
        let out = unique_temp_path("mma_upload_file").with_extension(&ext);
        fs::rename(single, &out)?;
        out
    } else {
        let out = unique_temp_path("mma_upload").with_extension("zip");
        let mut zip = zip::ZipWriter::new(BufWriter::new(File::create(&out)?));
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for f in &files {
            let name = f.file_name().unwrap_or_default().to_string_lossy();
            zip.start_file(name, options)?;
            zip.write_all(&fs::read(f)?)?;
        }
        zip.finish()?.flush()?;
        out
    };

    let _ = fs::remove_dir_all(&dir);
    Ok(out.to_string_lossy().into_owned())
}

/// Read a session's `<n>.json` chunks in index order, concatenated. Indices must run
/// 0..len-1 with no gaps -- a chunk whose POST was dropped would otherwise silently
/// truncate the result. The dir is removed either way.
pub(crate) fn read_uploaded_chunks<T: DeserializeOwned>(session_dir: &str) -> AppResult<Vec<T>> {
    let dir = upload_session_dir(session_dir)?;
    let result = collect_chunks(&dir);
    let _ = fs::remove_dir_all(&dir);
    result
}

fn collect_chunks<T: DeserializeOwned>(dir: &Path) -> AppResult<Vec<T>> {
    let mut chunks: Vec<(u32, PathBuf)> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let index = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<u32>().ok())
            .ok_or_else(|| AppError::from("uploaded chunk: non-numeric name"))?;
        chunks.push((index, path));
    }
    chunks.sort_by_key(|(i, _)| *i);
    if chunks.iter().enumerate().any(|(n, (i, _))| n as u32 != *i) {
        return Err("uploaded chunk: missing chunk".into());
    }

    let mut out = Vec::new();
    for (_, path) in &chunks {
        out.append(&mut serde_json::from_slice::<Vec<T>>(&fs::read(path)?)?);
    }
    Ok(out)
}

/// Remove an abandoned upload session dir (e.g. cancelled operation).
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
#[specta::specta]
pub fn store_upload_abort(session_dir: String) -> AppResult<()> {
    let dir = upload_session_dir(&session_dir)?;
    let _ = fs::remove_dir_all(&dir);
    Ok(())
}

/// Progress of a bulk export, emitted once per map.
#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "bulk-export-progress")]
pub struct ExportProgress {
    pub current: u32,
    pub total: u32,
    pub map_name: String,
}

/// Export every map as a ZIP of JSON files. Duplicate map names get a numeric suffix.
/// Emits `bulk-export-progress` per map.
// Reads Arrow IPC files directly from disk (bypasses the in-memory store); runs on a blocking thread.
#[tauri::command]
#[specta::specta]
pub async fn store_export_bulk_zip() -> AppResult<String> {
    let path = task::spawn_blocking(move || {
        use std::io::Cursor;

        let conn = storage::open_db()?;
        let mut stmt = conn.prepare(
            "SELECT m.id, m.name, m.folder, COALESCE(r.records, '{}'), m.extra FROM maps m
             LEFT JOIN value_records r ON r.map_id = m.id AND r.field = 'tags'",
        )?;
        let maps: Vec<_> = stmt
            .query_map([], |row| {
                Ok((
                    Id::new(row.get::<_, String>(0)?),
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?
            .filter_map(Result::ok)
            .collect();
        drop(stmt);
        drop(conn);
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

            let mut used_names = HashSet::new();
            let total = maps.len();

            for (i, (map_id, name, _folder, tags_json, extra_json)) in maps.iter().enumerate() {
                crate::emit_event(ExportProgress {
                    current: (i + 1) as u32,
                    total: total as u32,
                    map_name: name.clone(),
                });
                // Base file + uncommitted delta sidecar = the map's full current state.
                let locs = engine::read_full_state_from_disk(map_id)?;

                let co = CoordOpts {
                    export_zoom: true,
                    export_unpanned: false,
                    shape: MapShape::Local,
                };
                let fields = serde_json::from_str::<serde_json::Value>(extra_json)
                    .ok()
                    .and_then(|e| e.get("fields").cloned());
                let doc = export_document(name, &locs, tags_json, fields, &co);
                let json = serde_json::to_string(&doc)?;

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

        let path = unique_temp_path("mma_backup").with_extension("zip");
        fs::write(&path, buf.into_inner())?;
        Ok::<_, AppError>(path.to_string_lossy().into_owned())
    })
    .await??;

    Ok(path)
}
