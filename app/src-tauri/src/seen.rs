//! "Seen" history -- a capped log of Street View panoramas the user has visited.
//!
//! Stored in SQLite (the `seen` table), capped at 10,000 entries with oldest-first
//! eviction. Provides paginated listing, filtering by country/map/search, and
//! aggregate queries for the history UI. All functions are Tauri IPC commands.

use crate::storage;
use crate::types::AppResult;
use rusqlite::params_from_iter;

/// A panorama visit record as returned to the frontend.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SeenEntry {
    pub id: u32,
    pub pano_id: String,
    pub lat: f64,
    pub lng: f64,
    pub heading: f64,
    pub pitch: f64,
    pub zoom: f64,
    pub entered_at: i64,
    pub map_id: Option<String>,
    pub location_id: Option<u32>,
    pub country_code: Option<String>,
    pub address: Option<String>,
    pub thumbnail: Option<String>,
}

/// Inbound payload for recording a new panorama visit. Same shape as `SeenEntry`
/// minus the auto-assigned `id`.
#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SeenWriteEntry {
    pub pano_id: String,
    pub lat: f64,
    pub lng: f64,
    pub heading: f64,
    pub pitch: f64,
    pub zoom: f64,
    pub entered_at: i64,
    pub map_id: Option<String>,
    pub location_id: Option<u32>,
    pub country_code: Option<String>,
    pub address: Option<String>,
    pub thumbnail: Option<String>,
}

/// Optional filters for seen-history queries. All fields are AND-combined.
/// `search` does a substring match on the `address` column.
#[derive(serde::Deserialize, specta::Type)]
#[serde(default)]
pub struct SeenFilter {
    pub country: Option<String>,
    #[serde(rename = "mapId")]
    pub map_id: Option<String>,
    pub search: Option<String>,
}

impl Default for SeenFilter {
    fn default() -> Self {
        Self {
            country: None,
            map_id: None,
            search: None,
        }
    }
}

/// Map id + display name pair for the "filter by map" dropdown.
/// Name is resolved from the `maps` table when available, falling back to raw id.
#[derive(serde::Serialize, specta::Type)]
pub struct SeenMapInfo {
    pub id: String,
    pub name: String,
}

/// Builds a SQL WHERE clause and parameter list from the optional filter.
/// Returns an empty string (no WHERE) when no filter fields are set.
fn build_where_clause(
    filter: &Option<SeenFilter>,
) -> (String, Vec<Box<dyn rusqlite::types::ToSql>>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(f) = filter {
        if let Some(ref country) = f.country {
            conditions.push("country_code = ?".to_string());
            params.push(Box::new(country.clone()));
        }
        if let Some(ref map_id) = f.map_id {
            conditions.push("map_id = ?".to_string());
            params.push(Box::new(map_id.clone()));
        }
        if let Some(ref search) = f.search {
            conditions.push("address LIKE ?".to_string());
            params.push(Box::new(format!("%{search}%")));
        }
    }

    let clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    (clause, params)
}

/// Maximum number of seen entries retained. Once exceeded, the oldest entries
/// are evicted in the same write transaction.
const MAX_SEEN: i64 = 10_000;

/// Records a panorama visit and evicts excess entries beyond `MAX_SEEN`.
///
/// Eviction deletes the oldest rows by `entered_at`, so the table acts as a
/// bounded ring buffer without requiring explicit rotation.
#[tauri::command]
#[specta::specta]
pub fn store_seen_write(entry: SeenWriteEntry) -> AppResult<()> {
    let db = storage::open_db()?;

    db.execute(
        "INSERT INTO seen (pano_id, lat, lng, heading, pitch, zoom, entered_at, map_id, location_id, country_code, address, thumbnail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            entry.pano_id, entry.lat, entry.lng, entry.heading, entry.pitch, entry.zoom,
            entry.entered_at, entry.map_id, entry.location_id, entry.country_code, entry.address, entry.thumbnail,
        ],
    )?;

    let count: i64 = db.query_row("SELECT COUNT(*) FROM seen", [], |row| row.get(0))?;

    if count > MAX_SEEN {
        let excess = count - MAX_SEEN;
        db.execute(
            "DELETE FROM seen WHERE id IN (SELECT id FROM seen ORDER BY entered_at ASC LIMIT ?)",
            rusqlite::params![excess],
        )?;
    }

    Ok(())
}

/// Returns a page of seen entries, newest first, with optional filtering.
#[tauri::command]
#[specta::specta]
pub fn store_seen_list(
    limit: u32,
    offset: u32,
    filter: Option<SeenFilter>,
    thumbnails: bool,
) -> AppResult<Vec<SeenEntry>> {
    let db = storage::open_db()?;
    let (where_clause, mut params) = build_where_clause(&filter);

    // The thumbnail blob dominates the payload; the map overlay omits it (thumbnails=false).
    let thumb_col = if thumbnails { "thumbnail" } else { "NULL" };
    let sql = format!(
        "SELECT id, pano_id, lat, lng, heading, pitch, zoom, entered_at, map_id, location_id, country_code, address, {thumb_col} FROM seen{where_clause} ORDER BY entered_at DESC LIMIT ? OFFSET ?"
    );

    params.push(Box::new(limit));
    params.push(Box::new(offset));

    let mut stmt = db.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(params.iter().map(|p| p.as_ref())), |row| {
        Ok(SeenEntry {
            id: row.get(0)?,
            pano_id: row.get(1)?,
            lat: row.get(2)?,
            lng: row.get(3)?,
            heading: row.get(4)?,
            pitch: row.get(5)?,
            zoom: row.get(6)?,
            entered_at: row.get(7)?,
            map_id: row.get(8)?,
            location_id: row.get(9)?,
            country_code: row.get(10)?,
            address: row.get(11)?,
            thumbnail: row.get(12)?,
        })
    })?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

/// Returns the total number of seen entries matching the filter (for pagination).
#[tauri::command]
#[specta::specta]
pub fn store_seen_count(filter: Option<SeenFilter>) -> AppResult<u32> {
    let db = storage::open_db()?;
    let (where_clause, params) = build_where_clause(&filter);

    let sql = format!("SELECT COUNT(*) FROM seen{}", where_clause);

    let mut stmt = db.prepare(&sql)?;
    let count: u32 = stmt
        .query_row(params_from_iter(params.iter().map(|p| p.as_ref())), |row| {
            row.get(0)
        })?;

    Ok(count)
}

/// Returns all distinct country codes present in the seen table, sorted alphabetically.
/// Used to populate the country filter dropdown.
#[tauri::command]
#[specta::specta]
pub fn store_seen_countries() -> AppResult<Vec<String>> {
    let db = storage::open_db()?;
    let mut stmt = db
        .prepare("SELECT DISTINCT country_code FROM seen WHERE country_code IS NOT NULL ORDER BY country_code")?;

    let rows = stmt.query_map([], |row| row.get(0))?;

    let mut countries = Vec::new();
    for row in rows {
        countries.push(row?);
    }
    Ok(countries)
}

/// Returns all distinct maps that have seen entries, with resolved display names.
/// Returns maps that have seen entries. Only includes maps that still exist.
#[tauri::command]
#[specta::specta]
pub fn store_seen_maps() -> AppResult<Vec<SeenMapInfo>> {
    let db = storage::open_db()?;
    let mut stmt = db.prepare(
        "SELECT DISTINCT s.map_id AS id, m.name \
             FROM seen s JOIN maps m ON m.id = s.map_id \
             WHERE s.map_id IS NOT NULL ORDER BY m.name",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok(SeenMapInfo {
            id: row.get(0)?,
            name: row.get(1)?,
        })
    })?;

    let mut maps = Vec::new();
    for row in rows {
        maps.push(row?);
    }
    Ok(maps)
}

/// Deletes all seen history entries.
#[tauri::command]
#[specta::specta]
pub fn store_seen_clear() -> AppResult<()> {
    let db = storage::open_db()?;
    db.execute("DELETE FROM seen", [])?;
    Ok(())
}
