//! "Seen" history -- a capped log of Street View panoramas the user has visited.
//!
//! Stored in SQLite (the `seen` table), capped at 10,000 entries with oldest-first
//! eviction. Provides paginated listing, filtering by country/map/search, and
//! aggregate queries for the history UI.

use crate::store::maps::MapMeta;
use crate::store::storage;
use crate::types::{AppResult, Location};
use mma_algebra::Id;
use rusqlite::params_from_iter;
use rusqlite::types::ToSql;

/// A panorama visit record.
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
    pub map_id: Option<Id<MapMeta, String>>,
    pub location_id: Option<Id<Location>>,
    pub country_code: Option<String>,
    pub address: Option<String>,
    pub thumbnail: Option<String>,
}

/// Parameters for recording a panorama visit.
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
    pub map_id: Option<Id<MapMeta, String>>,
    pub location_id: Option<Id<Location>>,
    pub country_code: Option<String>,
    pub address: Option<String>,
    pub thumbnail: Option<String>,
}

/// Filters for seen-history queries. All fields are AND-combined.
/// `search` matches against the address.
#[derive(serde::Deserialize, specta::Type, Default)]
#[serde(default)]
pub struct SeenFilter {
    pub country: Option<String>,
    #[serde(rename = "mapId")]
    pub map_id: Option<Id<MapMeta, String>>,
    pub search: Option<String>,
    #[serde(rename = "locationIds")]
    pub location_ids: Option<Vec<Id<Location>>>,
    pub since: Option<i64>,
}

/// A page of seen entries, newest first, and how many entries match the filter in all.
#[derive(serde::Serialize, specta::Type)]
pub struct SeenPage {
    pub entries: Vec<SeenEntry>,
    pub total: u32,
}

/// Map ID and display name for seen-history filtering.
#[derive(serde::Serialize, specta::Type)]
pub struct SeenMapInfo {
    pub id: Id<MapMeta, String>,
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
        map_id: row.get::<_, Option<String>>("map_id")?.map(Id::new),
        location_id: row.get::<_, Option<u32>>("location_id")?.map(Id::new),
        country_code: row.get("country_code")?,
        address: row.get("address")?,
        thumbnail: row.get("thumbnail")?,
    })
}

/// Builds a SQL WHERE clause and parameter list from the optional filter.
/// Returns an empty string (no WHERE) when no filter fields are set.
fn build_where_clause(filter: &Option<SeenFilter>) -> (String, Vec<Box<dyn ToSql>>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();
    let f = filter.as_ref();

    for (cond, value) in [
        ("country_code = ?", f.and_then(|f| f.country.clone())),
        (
            "map_id = ?",
            f.and_then(|f| f.map_id.as_ref().map(|id| id.raw().clone())),
        ),
        (
            "address LIKE ?",
            f.and_then(|f| f.search.as_ref().map(|s| format!("%{s}%"))),
        ),
    ] {
        if let Some(v) = value {
            conditions.push(cond.to_string());
            params.push(Box::new(v));
        }
    }
    if let Some(since) = f.and_then(|f| f.since) {
        conditions.push("entered_at >= ?".to_string());
        params.push(Box::new(since));
    }
    if let Some(ids) = f.and_then(|f| f.location_ids.as_ref()) {
        conditions.push(format!(
            "location_id IN ({})",
            vec!["?"; ids.len()].join(", ")
        ));
        params.extend(ids.iter().map(|&id| Box::new(id.get()) as Box<dyn ToSql>));
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

/// Record a panorama visit. The history is capped; oldest entries are evicted when full.
#[tauri::command]
#[specta::specta]
pub async fn store_seen_write(entry: SeenWriteEntry) -> AppResult<()> {
    storage::with_db(move |conn| {
        conn.execute(
            "INSERT INTO seen (pano_id, lat, lng, heading, pitch, zoom, entered_at, map_id, location_id, country_code, address, thumbnail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                entry.pano_id, entry.lat, entry.lng, entry.heading, entry.pitch, entry.zoom,
                entry.entered_at, entry.map_id.as_ref().map(Id::raw), entry.location_id.map(Id::get), entry.country_code, entry.address, entry.thumbnail,
            ],
        )?;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM seen", [], |row| row.get(0))?;
        if count > MAX_SEEN {
            conn.execute(
                "DELETE FROM seen WHERE id IN (SELECT id FROM seen ORDER BY entered_at ASC LIMIT ?)",
                rusqlite::params![count - MAX_SEEN],
            )?;
        }
        Ok(())
    })
    .await
}

/// Returns a page of seen entries, newest first, and the number of entries matching the filter.
#[tauri::command]
#[specta::specta]
pub async fn store_seen_list(
    limit: u32,
    offset: u32,
    filter: Option<SeenFilter>,
    thumbnails: bool,
) -> AppResult<SeenPage> {
    storage::with_db(move |conn| {
        let (where_clause, mut params) = build_where_clause(&filter);
        let total: u32 = conn.query_row(
            &format!("SELECT COUNT(*) FROM seen{where_clause}"),
            params_from_iter(params.iter().map(AsRef::as_ref)),
            |row| row.get(0),
        )?;
        let thumb_col = if thumbnails { "thumbnail" } else { "NULL" };
        let sql = format!(
            "SELECT {COLS}, {thumb_col} AS thumbnail FROM seen{where_clause} ORDER BY entered_at DESC LIMIT ? OFFSET ?"
        );
        params.push(Box::new(limit));
        params.push(Box::new(offset));
        let mut stmt = conn.prepare(&sql)?;
        let entries = stmt
            .query_map(
                params_from_iter(params.iter().map(AsRef::as_ref)),
                row_to_seen,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(SeenPage { entries, total })
    })
    .await
}

/// Return all distinct country codes in the seen history, sorted alphabetically.
#[tauri::command]
#[specta::specta]
pub async fn store_seen_countries() -> AppResult<Vec<String>> {
    storage::with_db(move |conn| {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT country_code FROM seen WHERE country_code IS NOT NULL ORDER BY country_code",
        )?;
        let countries = stmt
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?;
        Ok(countries)
    })
    .await
}

/// Returns all distinct maps that have seen entries, with resolved display names.
#[tauri::command]
#[specta::specta]
pub async fn store_seen_maps() -> AppResult<Vec<SeenMapInfo>> {
    storage::with_db(move |conn| {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT s.map_id AS id, m.name FROM seen s JOIN maps m ON m.id = s.map_id WHERE s.map_id IS NOT NULL ORDER BY m.name",
        )?;
        let maps = stmt
            .query_map([], |row| {
                Ok(SeenMapInfo {
                    id: Id::new(row.get("id")?),
                    name: row.get("name")?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(maps)
    })
    .await
}

/// Deletes all seen history entries.
#[tauri::command]
#[specta::specta]
pub async fn store_seen_clear() -> AppResult<()> {
    storage::with_db(move |conn| {
        conn.execute("DELETE FROM seen", [])?;
        Ok(())
    })
    .await
}

#[cfg(test)]
#[path = "seen.test.rs"]
mod tests;
