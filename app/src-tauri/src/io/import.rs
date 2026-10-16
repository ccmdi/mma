//! Import pipeline for JSON, CSV, and ZIP files containing map location data.
//!
//! Two import paths: **bulk import** creates new maps from files, and **editor
//! import** merges locations into the currently open map. JSON parsing uses
//! serde_json with parallel object deserialization via rayon. A two-phase
//! preview/confirm flow lets the user inspect data before committing.

use crate::store::maps::MapMeta;
use crate::types::{AppResult, RawExtra};
use mma_algebra::Id;
use std::collections::{BTreeMap, HashSet};
use std::sync::Mutex;

pub(crate) mod parse;
mod stage;
use parse::*;
pub use stage::*;

use crate::util::now_iso;
use rayon::prelude::*;
use rusqlite::Connection;
use uuid::Uuid;

use crate::store::{arrow, engine, map_defaults, maps, storage};
use std::path::Path;
use tokio::task;

/// Every file `bulk_import_preview` parsed, keyed by path, so `bulk_import_confirm`
/// skips re-parsing each one.
static CACHED_PARSE: Mutex<BTreeMap<String, Vec<ParsedMap>>> = Mutex::new(BTreeMap::new());

// ---------------------------------------------------------------------------
// Types returned to JS
// ---------------------------------------------------------------------------

/// Summary of a single map found during bulk import preview.
/// Shown in the import dialog so the user can select which maps to import.
#[derive(serde::Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewEntry {
    /// `null` when the file doesn't name the map.
    pub name: Option<String>,
    pub folder: Option<String>,
    pub location_count: u32,
    pub tag_count: u32,
    pub warnings: Vec<String>,
}

impl From<&ParsedMap> for ImportPreviewEntry {
    fn from(m: &ParsedMap) -> Self {
        ImportPreviewEntry {
            name: (!m.name.is_empty()).then(|| m.name.clone()),
            folder: m.folder.clone(),
            location_count: m.locations.len() as u32,
            tag_count: m.tags.len() as u32,
            warnings: m.warnings.clone(),
        }
    }
}

/// Result returned per map after a successful bulk import.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMapInfo {
    pub id: Id<MapMeta, String>,
    pub name: String,
    pub location_count: u32,
    pub tag_count: u32,
}

/// The `extra` a bulk-imported map starts with: the file's own field definitions, plus
/// an inferred one for every key its rows carry that the file does not define.
fn map_extra_json(map: &mut ParsedMap) -> AppResult<String> {
    let mut fields: serde_json::Map<String, serde_json::Value> = map
        .fields
        .take()
        .and_then(|f| f.as_object().cloned())
        .unwrap_or_default();
    let extras: Vec<&RawExtra> = map
        .locations
        .iter()
        .filter_map(|l| l.extra.as_ref())
        .collect();
    if let Some(found) = maps::infer_field_defs(|k| fields.contains_key(k), &extras) {
        for (key, def) in found {
            fields.insert(key, serde_json::to_value(def)?);
        }
    }
    Ok(if fields.is_empty() {
        "{}".to_string()
    } else {
        serde_json::json!({ "fields": fields }).to_string()
    })
}

fn write_map_to_db(
    conn: &Connection,
    mut map: ParsedMap,
    map_id: &Id<MapMeta, String>,
    arrow_path: &Path,
) -> AppResult<ImportedMapInfo> {
    renumber_ordered_tags(&mut map.tags);
    let now = now_iso();
    let loc_count = map.locations.len() as u32;
    let tag_count = map.tags.len() as u32;

    let extra_json = map_extra_json(&mut map)?;

    let settings = merge_settings(map_defaults::new_map_settings(conn)?, &map.settings);
    let settings_json =
        serde_json::to_string(&settings).unwrap_or_else(|_| maps::default_settings_json());

    // Assign sequential u32 IDs
    for (i, loc) in map.locations.iter_mut().enumerate() {
        loc.id = Id::new((i as u32) + 1);
    }

    let batch = arrow::locations_to_batch(&map.locations);
    arrow::write_arrow_ipc(arrow_path, &batch)?;

    let tx = conn.unchecked_transaction()?;

    tx.execute(
        "INSERT INTO maps (id, name, description, folder, settings, score_bounds, extra, location_count, created_at, updated_at) VALUES (?1, ?2, '', ?3, ?4, '\"auto\"', ?5, ?6, ?7, ?8)",
        rusqlite::params![map_id.raw(), map.name, map.folder, settings_json, extra_json, loc_count, now, now],
    )?;
    if !map.tags.is_empty() {
        engine::save_value_records(
            &tx,
            map_id,
            "tags",
            &map.tags.iter().map(|t| (t.id, t.clone())).collect(),
        )?;
    }

    tx.commit()?;

    Ok(ImportedMapInfo {
        id: map_id.clone(),
        name: map.name,
        location_count: loc_count,
        tag_count,
    })
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Read a file (JSON, or a ZIP of JSONs parsed in parallel) into its maps.
fn read_and_parse_maps(path: &str) -> AppResult<Vec<ParsedMap>> {
    let files = if path.ends_with(".zip") {
        read_zip_entries(path)?
    } else {
        vec![read_sequential(path)?]
    };
    Ok(files
        .into_par_iter()
        .map(|mut bytes| parse_file(&mut bytes))
        .collect())
}

/// Parse a file (JSON or ZIP of JSONs) and return a preview of each map found,
/// without persisting anything. Call `bulkImportConfirm` to import the maps.
#[tauri::command]
#[specta::specta]
pub async fn bulk_import_preview(path: String) -> AppResult<Vec<ImportPreviewEntry>> {
    task::spawn_blocking(move || {
        let maps = read_and_parse_maps(&path)?;

        let results: Vec<ImportPreviewEntry> = maps.iter().map(ImportPreviewEntry::from).collect();

        CACHED_PARSE.lock().unwrap().insert(path, maps);

        Ok(results)
    })
    .await?
}

/// Progress of a bulk import, emitted once per map.
#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "bulk-import-progress")]
pub struct ImportProgress {
    pub current: u32,
    pub total: u32,
    pub map_name: String,
}

/// Import the maps at `selectedIndices` from a previously previewed file.
/// Emits `bulk-import-progress` per map.
// Uses the cached parse if available; each map gets a new UUID, Arrow IPC file, and SQLite row.
#[tauri::command]
#[specta::specta]
pub async fn bulk_import_confirm(
    path: String,
    selected_indices: Vec<u32>,
) -> AppResult<Vec<ImportedMapInfo>> {
    let main_path = storage::db_path()?;

    task::spawn_blocking(move || {
        let cached = CACHED_PARSE.lock().unwrap().remove(&path);
        let all_maps = match cached {
            Some(maps) => maps,
            None => read_and_parse_maps(&path)?,
        };

        let selected_set: HashSet<u32> = selected_indices.into_iter().collect();
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
            let map_id = Id::new(Uuid::new_v4().to_string());
            let info = write_map_to_db(&conn, map, &map_id, &storage::arrow_path(&map_id)?)?;
            crate::emit_event(ImportProgress {
                current: (i + 1) as u32,
                total,
                map_name,
            });
            results.push(info);
        }

        Ok(results)
    })
    .await?
}

/// Discard the previewed import without importing. Call when the user cancels the
/// import dialog.
#[tauri::command]
#[specta::specta]
pub async fn bulk_import_cancel() -> AppResult<()> {
    CACHED_PARSE.lock().unwrap().clear();
    Ok(())
}

#[cfg(test)]
#[allow(clippy::print_stdout, clippy::print_stderr)]
#[path = "import.test.rs"]
mod tests;

#[cfg(test)]
#[path = "roundtrip.test.rs"]
mod roundtrip_tests;
