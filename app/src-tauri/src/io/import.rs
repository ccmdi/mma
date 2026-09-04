//! Import pipeline for JSON, CSV, and ZIP files containing map location data.
//!
//! Two import paths: **bulk import** creates new maps from files, and **editor
//! import** merges locations into the currently open map. JSON parsing uses
//! serde_json with parallel object deserialization via rayon. A two-phase
//! preview/confirm flow lets the user inspect data before committing.

use crate::types::AppResult;
use std::sync::Mutex;

mod parse;
mod stage;
use parse::*;
pub use stage::*;

use crate::util::now_iso;
use rayon::prelude::*;
use rusqlite::Connection;
use serde_json::Value;
use uuid::Uuid;

use crate::store::arrow;
use crate::store::maps;
use crate::store::maps::MapSettings;
use crate::store::storage;
use std::collections::HashSet;
use tokio::task;

/// Cached result from `bulk_import_preview` so `bulk_import_confirm` can
/// skip re-parsing. Keyed by file path to detect stale caches.
// TODO: single slot - multi-file bulk import only caches the last file; earlier ones re-parse.
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

fn write_map_to_db(conn: &Connection, mut map: ParsedMap) -> AppResult<ImportedMapInfo> {
    renumber_ordered_tags(&mut map.tags);
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

    let settings = merge_settings(MapSettings::default(), &map.settings);
    let settings_json =
        serde_json::to_string(&settings).unwrap_or_else(|_| maps::default_settings_json());

    // Assign sequential u32 IDs
    for (i, loc) in map.locations.iter_mut().enumerate() {
        loc.id = (i as u32) + 1;
    }

    let batch = arrow::locations_to_batch(&map.locations);
    let arrow_path = storage::arrow_path(&map_id)?;
    arrow::write_arrow_ipc(&arrow_path, &batch)?;

    let tx = conn.unchecked_transaction()?;

    // Build tags JSON for the maps row
    let tags_json = {
        let mut tag_map = serde_json::Map::new();
        for tag in &map.tags {
            tag_map.insert(tag.id.to_string(), serde_json::to_value(tag).unwrap());
        }
        Value::Object(tag_map).to_string()
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
    task::spawn_blocking(move || {
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
#[derive(serde::Serialize, Clone, specta::Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "bulk-import-progress")]
pub struct ImportProgress {
    pub current: u32,
    pub total: u32,
    pub map_name: String,
}

/// Import the selected maps from a previously previewed file. Emits `bulk-import-progress` per map.
// Uses the cached parse if available; each map gets a new UUID, Arrow IPC file, and SQLite row.
#[tauri::command]
#[specta::specta]
pub async fn bulk_import_confirm(
    path: String,
    selected_indices: Vec<u32>,
) -> AppResult<Vec<ImportedMapInfo>> {
    let main_path = storage::db_path()?;

    task::spawn_blocking(move || {
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
            let info = write_map_to_db(&conn, map)?;
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

#[cfg(test)]
#[allow(clippy::print_stdout, clippy::print_stderr)]
#[path = "import.test.rs"]
mod tests;
