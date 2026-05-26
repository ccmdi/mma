use rusqlite::params_from_iter;
use crate::fast_io;

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
        Self { country: None, map_id: None, search: None }
    }
}

#[derive(serde::Serialize, specta::Type)]
pub struct SeenMapInfo {
    pub id: String,
    pub name: String,
}

fn build_where_clause(filter: &Option<SeenFilter>) -> (String, Vec<Box<dyn rusqlite::types::ToSql>>) {
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

const MAX_SEEN: i64 = 10_000;

#[tauri::command]
#[specta::specta]
pub fn store_seen_write(app: tauri::AppHandle, entry: SeenWriteEntry) -> Result<(), String> {
    let db = fast_io::open_db(&app)?;

    db.execute(
        "INSERT INTO seen (pano_id, lat, lng, heading, pitch, zoom, entered_at, map_id, location_id, country_code, address, thumbnail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            entry.pano_id, entry.lat, entry.lng, entry.heading, entry.pitch, entry.zoom,
            entry.entered_at, entry.map_id, entry.location_id, entry.country_code, entry.address, entry.thumbnail,
        ],
    ).map_err(|e| e.to_string())?;

    let count: i64 = db
        .query_row("SELECT COUNT(*) FROM seen", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    if count > MAX_SEEN {
        let excess = count - MAX_SEEN;
        db.execute(
            "DELETE FROM seen WHERE id IN (SELECT id FROM seen ORDER BY entered_at ASC LIMIT ?)",
            rusqlite::params![excess],
        ).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn store_seen_list(
    app: tauri::AppHandle,
    limit: u32,
    offset: u32,
    filter: Option<SeenFilter>,
) -> Result<Vec<SeenEntry>, String> {
    let db = fast_io::open_db(&app)?;
    let (where_clause, mut params) = build_where_clause(&filter);

    let sql = format!(
        "SELECT id, pano_id, lat, lng, heading, pitch, zoom, entered_at, map_id, location_id, country_code, address, thumbnail FROM seen{} ORDER BY entered_at DESC LIMIT ? OFFSET ?",
        where_clause
    );

    params.push(Box::new(limit));
    params.push(Box::new(offset));

    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(params.iter().map(|p| p.as_ref())), |row| {
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
        })
        .map_err(|e| e.to_string())?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(|e| e.to_string())?);
    }
    Ok(entries)
}

#[tauri::command]
#[specta::specta]
pub fn store_seen_count(app: tauri::AppHandle, filter: Option<SeenFilter>) -> Result<u32, String> {
    let db = fast_io::open_db(&app)?;
    let (where_clause, params) = build_where_clause(&filter);

    let sql = format!("SELECT COUNT(*) FROM seen{}", where_clause);

    let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
    let count: u32 = stmt
        .query_row(params_from_iter(params.iter().map(|p| p.as_ref())), |row| row.get(0))
        .map_err(|e| e.to_string())?;

    Ok(count)
}

#[tauri::command]
#[specta::specta]
pub fn store_seen_countries(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let db = fast_io::open_db(&app)?;
    let mut stmt = db
        .prepare("SELECT DISTINCT country_code FROM seen WHERE country_code IS NOT NULL ORDER BY country_code")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    let mut countries = Vec::new();
    for row in rows {
        countries.push(row.map_err(|e| e.to_string())?);
    }
    Ok(countries)
}

#[tauri::command]
#[specta::specta]
pub fn store_seen_maps(app: tauri::AppHandle) -> Result<Vec<SeenMapInfo>, String> {
    let db = fast_io::open_db(&app)?;
    let mut stmt = db
        .prepare(
            "SELECT DISTINCT s.map_id AS id, COALESCE(m.name, s.map_id) AS name \
             FROM seen s LEFT JOIN maps m ON m.id = s.map_id \
             WHERE s.map_id IS NOT NULL ORDER BY name",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(SeenMapInfo {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut maps = Vec::new();
    for row in rows {
        maps.push(row.map_err(|e| e.to_string())?);
    }
    Ok(maps)
}

#[tauri::command]
#[specta::specta]
pub fn store_seen_clear(app: tauri::AppHandle) -> Result<(), String> {
    let db = fast_io::open_db(&app)?;
    db.execute("DELETE FROM seen", []).map_err(|e| e.to_string())?;
    Ok(())
}
