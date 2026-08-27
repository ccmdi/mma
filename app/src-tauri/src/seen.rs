//! "Seen" history -- a capped log of Street View panoramas the user has visited.
//!
//! Stored in SQLite (the `seen` table), capped at 10,000 entries with oldest-first
//! eviction. Provides paginated listing, filtering by country/map/search, and
//! aggregate queries for the history UI. All functions are Tauri IPC commands.

use crate::storage;
use crate::types::AppResult;
use rusqlite::params_from_iter;
use rusqlite::types::ToSql;

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
#[derive(serde::Deserialize, specta::Type, Default)]
#[serde(default)]
pub struct SeenFilter {
    pub country: Option<String>,
    #[serde(rename = "mapId")]
    pub map_id: Option<String>,
    pub search: Option<String>,
}

/// Map id + display name pair for the "filter by map" dropdown.
/// Name is resolved from the `maps` table when available, falling back to raw id.
#[derive(serde::Serialize, specta::Type)]
pub struct SeenMapInfo {
    pub id: String,
    pub name: String,
}

/// SELECT column list shared by all readers, matching [`row_to_seen`]. The
/// thumbnail is appended separately: the map overlay omits that blob.
const COLS: &str = "id, pano_id, lat, lng, heading, pitch, zoom, entered_at, map_id, location_id, country_code, address";

/// Decode a row (selected via [`COLS`]) into a `SeenEntry`.
fn row_to_seen(row: &rusqlite::Row) -> rusqlite::Result<SeenEntry> {
    Ok(SeenEntry {
        id: row.get("id")?,
        pano_id: row.get("pano_id")?,
        lat: row.get("lat")?,
        lng: row.get("lng")?,
        heading: row.get("heading")?,
        pitch: row.get("pitch")?,
        zoom: row.get("zoom")?,
        entered_at: row.get("entered_at")?,
        map_id: row.get("map_id")?,
        location_id: row.get("location_id")?,
        country_code: row.get("country_code")?,
        address: row.get("address")?,
        thumbnail: row.get("thumbnail")?,
    })
}

/// Builds a SQL WHERE clause and parameter list from the optional filter.
/// Returns an empty string (no WHERE) when no filter fields are set.
fn build_where_clause(filter: &Option<SeenFilter>) -> (String, Vec<Box<dyn ToSql>>) {
    let mut conditions: Vec<&str> = Vec::new();
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();
    let f = filter.as_ref();

    for (cond, value) in [
        ("country_code = ?", f.and_then(|f| f.country.clone())),
        ("map_id = ?", f.and_then(|f| f.map_id.clone())),
        (
            "address LIKE ?",
            f.and_then(|f| f.search.as_ref().map(|s| format!("%{s}%"))),
        ),
    ] {
        if let Some(v) = value {
            conditions.push(cond);
            params.push(Box::new(v));
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

/// Record a panorama visit. Oldest entries beyond `MAX_SEEN` are evicted.
#[tauri::command]
#[specta::specta]
pub async fn store_seen_write(entry: SeenWriteEntry) -> AppResult<()> {
    storage::with_db(move |db| {

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
    })
    .await
}

/// Returns a page of seen entries, newest first, with optional filtering.
#[tauri::command]
#[specta::specta]
pub async fn store_seen_list(
    limit: u32,
    offset: u32,
    filter: Option<SeenFilter>,
    thumbnails: bool,
) -> AppResult<Vec<SeenEntry>> {
    storage::with_db(move |db| {
        let (where_clause, mut params) = build_where_clause(&filter);

        // The thumbnail blob dominates the payload; the map overlay omits it (thumbnails=false).
        let thumb_col = if thumbnails { "thumbnail" } else { "NULL" };
        let sql = format!(
            "SELECT {COLS}, {thumb_col} AS thumbnail FROM seen{where_clause} ORDER BY entered_at DESC LIMIT ? OFFSET ?"
        );

        params.push(Box::new(limit));
        params.push(Box::new(offset));

        let mut stmt = db.prepare(&sql)?;
        let rows = stmt.query_map(
            params_from_iter(params.iter().map(|p| p.as_ref())),
            row_to_seen,
        )?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(row?);
        }
        Ok(entries)
    })
    .await
}

/// Returns the total number of seen entries matching the filter (for pagination).
#[tauri::command]
#[specta::specta]
pub async fn store_seen_count(filter: Option<SeenFilter>) -> AppResult<u32> {
    storage::with_db(move |db| {
        let (where_clause, params) = build_where_clause(&filter);

        let sql = format!("SELECT COUNT(*) FROM seen{}", where_clause);

        let mut stmt = db.prepare(&sql)?;
        let count: u32 = stmt
            .query_row(params_from_iter(params.iter().map(|p| p.as_ref())), |row| {
                row.get(0)
            })?;

        Ok(count)
    })
    .await
}

/// Returns all distinct country codes present in the seen table, sorted alphabetically.
/// Used to populate the country filter dropdown.
#[tauri::command]
#[specta::specta]
pub async fn store_seen_countries() -> AppResult<Vec<String>> {
    storage::with_db(move |db| {
        let mut stmt = db
            .prepare("SELECT DISTINCT country_code FROM seen WHERE country_code IS NOT NULL ORDER BY country_code")?;

        let rows = stmt.query_map([], |row| row.get(0))?;

        let mut countries = Vec::new();
        for row in rows {
            countries.push(row?);
        }
        Ok(countries)
    })
    .await
}

/// Returns all distinct maps that have seen entries, with resolved display names.
#[tauri::command]
#[specta::specta]
pub async fn store_seen_maps() -> AppResult<Vec<SeenMapInfo>> {
    storage::with_db(move |db| {
        let mut stmt = db.prepare(
            "SELECT DISTINCT s.map_id AS id, m.name \
                 FROM seen s JOIN maps m ON m.id = s.map_id \
                 WHERE s.map_id IS NOT NULL ORDER BY m.name",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(SeenMapInfo {
                id: row.get("id")?,
                name: row.get("name")?,
            })
        })?;

        let mut maps = Vec::new();
        for row in rows {
            maps.push(row?);
        }
        Ok(maps)
    })
    .await
}

/// Deletes all seen history entries.
#[tauri::command]
#[specta::specta]
pub async fn store_seen_clear() -> AppResult<()> {
    storage::with_db(move |db| {
        db.execute("DELETE FROM seen", [])?;
        Ok(())
    })
    .await
}
