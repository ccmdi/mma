use std::collections::HashMap;
use rusqlite::params;
use crate::fast_io;
use crate::location_store::StoreState;
use crate::types::Tag;
use crate::util::now_iso;

// ---------------------------------------------------------------------------
// Typed sub-structs for MapMeta
// ---------------------------------------------------------------------------

#[derive(Clone, Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MapSettings {
    pub point_along_road: bool,
    pub prefer_direction: Option<f64>,
    pub prefer_official: bool,
    pub prefer_higher_quality: bool,
    pub only_official: bool,
    pub camera_types: Option<Vec<String>>,
    pub default_pano_id: bool,
    pub export_zoom: bool,
    pub export_unpanned: bool,
    pub enrich_metadata: bool,
    pub enrich_fields: Option<Vec<String>>,
    pub generated_location_tag: Option<String>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ExtraFieldType {
    #[serde(rename = "string")]
    String,
    #[serde(rename = "number")]
    Number,
    #[serde(rename = "date")]
    Date,
    #[serde(rename = "month")]
    Month,
    #[serde(rename = "enum")]
    Enum,
}

#[derive(Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExtraFieldDef {
    #[serde(rename = "type")]
    pub field_type: ExtraFieldType,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub values: Option<Vec<String>>,
    #[serde(default)]
    pub labels: Option<HashMap<String, String>>,
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MapExtra {
    #[serde(default)]
    pub fields: Option<HashMap<String, ExtraFieldDef>>,
}

#[derive(Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(untagged)]
pub enum ScoreBounds {
    Auto(String),
    Bounds([f64; 4]),
}

impl Default for ScoreBounds {
    fn default() -> Self {
        ScoreBounds::Auto("auto".into())
    }
}

// ---------------------------------------------------------------------------
// Known field defs + auto-registration
// ---------------------------------------------------------------------------

pub fn known_field_def(key: &str) -> Option<ExtraFieldDef> {
    match key {
        "altitude" => Some(ExtraFieldDef {
            field_type: ExtraFieldType::Number,
            label: Some("Altitude".into()),
            values: None,
            labels: None,
        }),
        "countryCode" => Some(ExtraFieldDef {
            field_type: ExtraFieldType::String,
            label: Some("Country code".into()),
            values: None,
            labels: None,
        }),
        "cameraType" => Some(ExtraFieldDef {
            field_type: ExtraFieldType::Enum,
            label: Some("Camera type".into()),
            values: Some(vec!["gen1".into(), "gen2".into(), "gen4".into(), "badcam".into(), "tripod".into()]),
            labels: Some([("gen1", "Gen 1"), ("gen2", "Gen 2"), ("gen4", "Gen 4"), ("badcam", "Bad cam"), ("tripod", "Tripod")]
                .into_iter().map(|(k, v)| (k.into(), v.into())).collect()),
        }),
        "panoType" => Some(ExtraFieldDef {
            field_type: ExtraFieldType::Enum,
            label: Some("Pano type".into()),
            values: Some(vec!["2".into(), "3".into(), "10".into()]),
            labels: Some([("2", "Official"), ("3", "Unknown"), ("10", "User uploaded")]
                .into_iter().map(|(k, v)| (k.into(), v.into())).collect()),
        }),
        "imageDate" => Some(ExtraFieldDef {
            field_type: ExtraFieldType::Month,
            label: Some("Image date".into()),
            values: None,
            labels: None,
        }),
        "datetime" => Some(ExtraFieldDef {
            field_type: ExtraFieldType::Date,
            label: Some("Exact date".into()),
            values: None,
            labels: None,
        }),
        "timezone" => Some(ExtraFieldDef {
            field_type: ExtraFieldType::Enum,
            label: Some("Timezone".into()),
            values: None,
            labels: None,
        }),
        _ => None,
    }
}

pub fn infer_field_type(value: &serde_json::Value) -> ExtraFieldType {
    if value.is_number() {
        return ExtraFieldType::Number;
    }
    if let Some(s) = value.as_str() {
        let b = s.as_bytes();
        if b.len() == 7 && b[4] == b'-'
            && b[..4].iter().all(|c| c.is_ascii_digit())
            && b[5..].iter().all(|c| c.is_ascii_digit())
        {
            return ExtraFieldType::Month;
        }
    }
    ExtraFieldType::String
}

pub fn auto_register_field_defs(
    known_keys: &std::collections::HashSet<String>,
    extras: &[&serde_json::Map<String, serde_json::Value>],
) -> Option<HashMap<String, ExtraFieldDef>> {
    let mut new_defs: HashMap<String, ExtraFieldDef> = HashMap::new();
    for extra in extras {
        for (key, value) in *extra {
            if known_keys.contains(key) || new_defs.contains_key(key) {
                continue;
            }
            let def = known_field_def(key).unwrap_or_else(|| ExtraFieldDef {
                field_type: infer_field_type(value),
                label: None,
                values: None,
                labels: None,
            });
            new_defs.insert(key.clone(), def);
        }
    }
    if new_defs.is_empty() { None } else { Some(new_defs) }
}

/// Upsert field defs — overwrites existing entries. Used for explicit user edits.
fn upsert_field_defs(
    conn: &rusqlite::Connection,
    map_id: &str,
    new_defs: &HashMap<String, ExtraFieldDef>,
) -> Result<(), String> {
    let extra_str: String = conn.query_row(
        "SELECT extra FROM maps WHERE id = ?1", params![map_id], |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    let mut extra: MapExtra = serde_json::from_str(&extra_str).unwrap_or_default();
    let fields = extra.fields.get_or_insert_with(HashMap::new);
    for (k, v) in new_defs {
        fields.insert(k.clone(), v.clone());
    }
    let json = serde_json::to_string(&extra).unwrap_or_default();
    conn.execute("UPDATE maps SET extra = ?1 WHERE id = ?2", params![json, map_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Persist new field defs — skips keys that already exist. Used for auto-registration.
pub fn persist_field_defs(
    conn: &rusqlite::Connection,
    map_id: &str,
    new_defs: &HashMap<String, ExtraFieldDef>,
) -> Result<(), String> {
    let extra_str: String = conn.query_row(
        "SELECT extra FROM maps WHERE id = ?1",
        params![map_id],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    let mut extra: MapExtra = serde_json::from_str(&extra_str).unwrap_or_default();
    let fields = extra.fields.get_or_insert_with(HashMap::new);
    for (k, v) in new_defs {
        fields.entry(k.clone()).or_insert_with(|| v.clone());
    }
    let json = serde_json::to_string(&extra).unwrap_or_default();
    conn.execute(
        "UPDATE maps SET extra = ?1 WHERE id = ?2",
        params![json, map_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// MapMeta
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MapMeta {
    pub id: String,
    pub name: String,
    pub description: String,
    pub folder: Option<String>,
    pub settings: MapSettings,
    pub score_bounds: ScoreBounds,
    pub extra: MapExtra,
    pub tags: HashMap<String, Tag>,
    pub labels: Vec<String>,
    pub location_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub last_opened_at: Option<String>,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MapData {
    pub meta: MapMeta,
}

#[derive(Default, serde::Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct MapMetaPatch {
    pub name: Option<String>,
    pub description: Option<String>,
    pub folder: Option<Option<String>>,
    pub settings: Option<MapSettings>,
    pub score_bounds: Option<ScoreBounds>,
    pub extra: Option<MapExtra>,
    pub tags: Option<HashMap<String, Tag>>,
    pub labels: Option<Vec<String>>,
}

fn row_to_map_meta(row: &rusqlite::Row<'_>) -> Result<MapMeta, rusqlite::Error> {
    let settings_str: String = row.get("settings")?;
    let score_bounds_str: String = row.get("score_bounds")?;
    let extra_str: String = row.get("extra")?;
    let tags_str: String = row.get("tags")?;
    let labels_str: String = row.get("labels")?;

    Ok(MapMeta {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        folder: row.get("folder")?,
        settings: serde_json::from_str(&settings_str).unwrap_or_default(),
        score_bounds: serde_json::from_str(&score_bounds_str).unwrap_or_default(),
        extra: serde_json::from_str(&extra_str).unwrap_or_default(),
        tags: serde_json::from_str(&tags_str).unwrap_or_default(),
        labels: serde_json::from_str(&labels_str).unwrap_or_default(),
        location_count: row.get("location_count")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        last_opened_at: row.get("last_opened_at")?,
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub fn store_list_maps(app: tauri::AppHandle) -> Result<Vec<MapMeta>, String> {
    let conn = fast_io::open_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT * FROM maps")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row_to_map_meta(row))
        .map_err(|e| e.to_string())?;
    let mut maps = Vec::new();
    for row in rows {
        maps.push(row.map_err(|e| e.to_string())?);
    }
    Ok(maps)
}

#[tauri::command]
#[specta::specta]
pub fn store_get_map(app: tauri::AppHandle, id: String) -> Result<Option<MapData>, String> {
    let conn = fast_io::open_db(&app)?;
    let result = conn.query_row("SELECT * FROM maps WHERE id = ?1", params![id], |row| {
        row_to_map_meta(row)
    });
    match result {
        Ok(meta) => Ok(Some(MapData { meta })),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

const DEFAULT_SETTINGS: &str = r#"{"pointAlongRoad":true,"preferDirection":null,"preferOfficial":true,"preferHigherQuality":false,"onlyOfficial":false,"cameraTypes":null,"defaultPanoId":false,"exportZoom":false,"exportUnpanned":true,"enrichMetadata":false}"#;

#[tauri::command]
#[specta::specta]
pub fn store_create_map(
    app: tauri::AppHandle,
    name: String,
    folder: Option<String>,
) -> Result<MapData, String> {
    let conn = fast_io::open_db(&app)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    conn.execute(
        "INSERT INTO maps (id, name, folder, settings, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, folder, DEFAULT_SETTINGS, now, now],
    )
    .map_err(|e| e.to_string())?;

    let meta = conn
        .query_row("SELECT * FROM maps WHERE id = ?1", params![id], |row| {
            row_to_map_meta(row)
        })
        .map_err(|e| e.to_string())?;
    Ok(MapData { meta })
}

#[tauri::command]
#[specta::specta]
pub fn store_delete_map(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let conn = fast_io::open_db(&app)?;
    conn.execute("DELETE FROM maps WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM edit_history WHERE map_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM commits WHERE map_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM commit_trees WHERE commit_id NOT IN (SELECT id FROM commits)",
        [],
    )
    .map_err(|e| e.to_string())?;

    if let Ok(path) = fast_io::arrow_path(&app, &id) {
        let _ = std::fs::remove_file(path);
    }
    if let Ok(path) = fast_io::arrow_delta_path(&app, &id) {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn store_update_map_meta(
    app: tauri::AppHandle,
    state: tauri::State<'_, StoreState>,
    id: String,
    patch: MapMetaPatch,
) -> Result<(), String> {
    let mut sets: Vec<String> = Vec::new();
    let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref v) = patch.name {
        sets.push("name = ?".into());
        values.push(Box::new(v.clone()));
    }
    if let Some(ref v) = patch.description {
        sets.push("description = ?".into());
        values.push(Box::new(v.clone()));
    }
    if let Some(ref v) = patch.folder {
        sets.push("folder = ?".into());
        values.push(Box::new(v.clone()));
    }
    if let Some(ref v) = patch.settings {
        sets.push("settings = ?".into());
        values.push(Box::new(serde_json::to_string(v).unwrap_or_default()));
    }
    if let Some(ref v) = patch.score_bounds {
        sets.push("score_bounds = ?".into());
        values.push(Box::new(serde_json::to_string(v).unwrap_or_default()));
    }
    if let Some(ref v) = patch.extra {
        sets.push("extra = ?".into());
        values.push(Box::new(serde_json::to_string(v).unwrap_or_default()));
    }
    if let Some(ref v) = patch.tags {
        sets.push("tags = ?".into());
        values.push(Box::new(serde_json::to_string(&v).unwrap_or_default()));
    }
    if let Some(ref v) = patch.labels {
        sets.push("labels = ?".into());
        values.push(Box::new(serde_json::to_string(v).unwrap_or_default()));
    }

    if sets.is_empty() {
        return Ok(());
    }

    let now = now_iso();
    sets.push("updated_at = ?".to_string());
    values.push(Box::new(now));
    values.push(Box::new(id));

    let sql = format!(
        "UPDATE maps SET {} WHERE id = ?",
        sets.join(", ")
    );
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|b| b.as_ref()).collect();
    let conn = fast_io::open_db(&app)?;
    conn.execute(&sql, param_refs.as_slice())
        .map_err(|e| e.to_string())?;
    if let Some(ref extra) = patch.extra {
        let mut store = state.lock().map_err(|e| e.to_string())?;
        store.known_field_keys = extra.fields.as_ref()
            .map(|f| f.keys().cloned().collect())
            .unwrap_or_default();
    }
    Ok(())
}


#[tauri::command]
#[specta::specta]
pub fn store_touch_map_opened(app: tauri::AppHandle, map_id: String) -> Result<(), String> {
    let conn = fast_io::open_db(&app)?;
    let now = now_iso();
    conn.execute(
        "UPDATE maps SET last_opened_at = ?1 WHERE id = ?2",
        params![now, map_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn store_rename_folder(app: tauri::AppHandle, from: String, to: String) -> Result<(), String> {
    let conn = fast_io::open_db(&app)?;
    conn.execute(
        "UPDATE maps SET folder = ?1 WHERE folder = ?2",
        params![to, from],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn store_delete_folder(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let conn = fast_io::open_db(&app)?;
    conn.execute(
        "UPDATE maps SET folder = NULL WHERE folder = ?1",
        params![name],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn store_move_map_to_folder(
    app: tauri::AppHandle,
    map_id: String,
    folder: Option<String>,
) -> Result<(), String> {
    let conn = fast_io::open_db(&app)?;
    conn.execute(
        "UPDATE maps SET folder = ?1 WHERE id = ?2",
        params![folder, map_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn store_update_map_labels(
    app: tauri::AppHandle,
    map_id: String,
    labels: Vec<String>,
) -> Result<(), String> {
    let conn = fast_io::open_db(&app)?;
    let now = now_iso();
    let json = serde_json::to_string(&labels).unwrap_or_default();
    conn.execute(
        "UPDATE maps SET labels = ?1, updated_at = ?2 WHERE id = ?3",
        params![json, now, map_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn store_get_pano_date(app: tauri::AppHandle, pano_id: String) -> Result<Option<i64>, String> {
    let conn = fast_io::open_db(&app)?;
    let result = conn.query_row(
        "SELECT timestamp FROM pano_date_cache WHERE pano_id = ?1",
        params![pano_id],
        |row| row.get::<_, i64>(0),
    );
    match result {
        Ok(ts) => Ok(Some(ts)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
#[specta::specta]
pub fn store_set_pano_date(
    app: tauri::AppHandle,
    pano_id: String,
    timestamp: i64,
) -> Result<(), String> {
    let conn = fast_io::open_db(&app)?;
    conn.execute(
        "INSERT OR REPLACE INTO pano_date_cache (pano_id, timestamp) VALUES (?1, ?2)",
        params![pano_id, timestamp],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}


// ---------------------------------------------------------------------------
// Debug / diagnostics
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DbTableInfo {
    pub name: String,
    pub rows: i64,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DbStats {
    pub maps: i64,
    pub locations: i64,
    pub tags: i64,
    pub commits: i64,
    pub db_size_bytes: i64,
    pub journal_mode: String,
    pub foreign_keys: bool,
}

#[tauri::command]
#[specta::specta]
pub fn store_db_table_info(app: tauri::AppHandle) -> Result<Vec<DbTableInfo>, String> {
    let conn = fast_io::open_db(&app)?;
    let mut stmt = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_sqlx_%' AND name NOT LIKE '_mma_%' ORDER BY name"
    ).map_err(|e| e.to_string())?;
    let names: Vec<String> = stmt.query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    let mut results = Vec::new();
    for name in names {
        let rows: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM \"{}\"", name.replace('"', "")),
            [], |r| r.get(0),
        ).unwrap_or(-1);
        results.push(DbTableInfo { name, rows });
    }
    Ok(results)
}

#[tauri::command]
#[specta::specta]
pub fn store_db_clear_table(app: tauri::AppHandle, table: String) -> Result<i64, String> {
    let safe = table.replace('"', "");
    let conn = fast_io::open_db(&app)?;
    let deleted = conn.execute(&format!("DELETE FROM \"{}\"", safe), [])
        .map_err(|e| e.to_string())?;
    Ok(deleted as i64)
}

#[tauri::command]
#[specta::specta]
pub fn store_db_stats(app: tauri::AppHandle) -> Result<DbStats, String> {
    let conn = fast_io::open_db(&app)?;
    let maps: i64 = conn.query_row("SELECT COUNT(*) FROM maps", [], |r| r.get(0)).unwrap_or(0);
    let locations: i64 = conn.query_row("SELECT COALESCE(SUM(location_count), 0) FROM maps", [], |r| r.get(0)).unwrap_or(0);
    let tags: i64 = {
        let mut stmt = conn.prepare("SELECT tags FROM maps").map_err(|e| e.to_string())?;
        let rows: Vec<String> = stmt.query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows.iter().map(|t| {
            serde_json::from_str::<serde_json::Value>(t)
                .ok()
                .and_then(|v| v.as_object().map(|o| o.len() as i64))
                .unwrap_or(0)
        }).sum()
    };
    let commits: i64 = conn.query_row("SELECT COUNT(*) FROM commits", [], |r| r.get(0)).unwrap_or(0);
    let page_count: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap_or(0);
    let page_size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap_or(4096);
    let journal_mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap_or_default();
    let fk: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap_or(0);
    Ok(DbStats {
        maps,
        locations,
        tags,
        commits,
        db_size_bytes: page_count * page_size,
        journal_mode,
        foreign_keys: fk != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn infer_number() {
        assert!(matches!(infer_field_type(&serde_json::json!(42)), ExtraFieldType::Number));
        assert!(matches!(infer_field_type(&serde_json::json!(3.14)), ExtraFieldType::Number));
    }

    #[test]
    fn infer_month() {
        assert!(matches!(infer_field_type(&serde_json::json!("2023-05")), ExtraFieldType::Month));
        assert!(matches!(infer_field_type(&serde_json::json!("1999-12")), ExtraFieldType::Month));
    }

    #[test]
    fn infer_not_month() {
        assert!(matches!(infer_field_type(&serde_json::json!("2023-5")), ExtraFieldType::String));
        assert!(matches!(infer_field_type(&serde_json::json!("hello")), ExtraFieldType::String));
        assert!(matches!(infer_field_type(&serde_json::json!("2023-123")), ExtraFieldType::String));
    }

    #[test]
    fn infer_string_fallback() {
        assert!(matches!(infer_field_type(&serde_json::json!("hello")), ExtraFieldType::String));
        assert!(matches!(infer_field_type(&serde_json::json!(true)), ExtraFieldType::String));
    }

    #[test]
    fn known_enrichment_keys() {
        assert!(known_field_def("altitude").is_some());
        assert!(known_field_def("countryCode").is_some());
        assert!(known_field_def("cameraType").is_some());
        assert!(known_field_def("panoType").is_some());
        assert!(known_field_def("imageDate").is_some());
        assert!(known_field_def("datetime").is_some());
        assert!(known_field_def("timezone").is_some());
        assert!(known_field_def("plumbus").is_none());
    }

    #[test]
    fn known_field_types() {
        assert!(matches!(known_field_def("altitude").unwrap().field_type, ExtraFieldType::Number));
        assert!(matches!(known_field_def("imageDate").unwrap().field_type, ExtraFieldType::Month));
        assert!(matches!(known_field_def("datetime").unwrap().field_type, ExtraFieldType::Date));
        assert!(matches!(known_field_def("cameraType").unwrap().field_type, ExtraFieldType::Enum));
    }

    #[test]
    fn auto_register_no_new_keys() {
        let known: HashSet<String> = ["altitude", "countryCode"].iter().map(|s| s.to_string()).collect();
        let extra: serde_json::Map<String, serde_json::Value> = serde_json::from_str(r#"{"altitude": 100}"#).unwrap();
        assert!(auto_register_field_defs(&known, &[&extra]).is_none());
    }

    #[test]
    fn auto_register_known_key() {
        let known: HashSet<String> = HashSet::new();
        let extra: serde_json::Map<String, serde_json::Value> = serde_json::from_str(r#"{"altitude": 500}"#).unwrap();
        let result = auto_register_field_defs(&known, &[&extra]).unwrap();
        assert_eq!(result.len(), 1);
        let def = &result["altitude"];
        assert!(matches!(def.field_type, ExtraFieldType::Number));
        assert_eq!(def.label.as_deref(), Some("Altitude"));
    }

    #[test]
    fn auto_register_unknown_number() {
        let known: HashSet<String> = HashSet::new();
        let extra: serde_json::Map<String, serde_json::Value> = serde_json::from_str(r#"{"plumbus": 1}"#).unwrap();
        let result = auto_register_field_defs(&known, &[&extra]).unwrap();
        assert_eq!(result.len(), 1);
        let def = &result["plumbus"];
        assert!(matches!(def.field_type, ExtraFieldType::Number));
        assert!(def.label.is_none());
    }

    #[test]
    fn auto_register_unknown_string() {
        let known: HashSet<String> = HashSet::new();
        let extra: serde_json::Map<String, serde_json::Value> = serde_json::from_str(r#"{"region": "EU"}"#).unwrap();
        let result = auto_register_field_defs(&known, &[&extra]).unwrap();
        assert!(matches!(result["region"].field_type, ExtraFieldType::String));
    }

    #[test]
    fn auto_register_unknown_month() {
        let known: HashSet<String> = HashSet::new();
        let extra: serde_json::Map<String, serde_json::Value> = serde_json::from_str(r#"{"captured": "2024-03"}"#).unwrap();
        let result = auto_register_field_defs(&known, &[&extra]).unwrap();
        assert!(matches!(result["captured"].field_type, ExtraFieldType::Month));
    }

    #[test]
    fn auto_register_mixed() {
        let known: HashSet<String> = ["altitude"].iter().map(|s| s.to_string()).collect();
        let extra: serde_json::Map<String, serde_json::Value> = serde_json::from_str(
            r#"{"altitude": 100, "countryCode": "US", "plumbus": 42}"#
        ).unwrap();
        let result = auto_register_field_defs(&known, &[&extra]).unwrap();
        // altitude is already known → skipped
        assert!(!result.contains_key("altitude"));
        // countryCode is new but in known_field_def → gets label
        assert_eq!(result["countryCode"].label.as_deref(), Some("Country code"));
        // plumbus is unknown → inferred as Number, no label
        assert!(matches!(result["plumbus"].field_type, ExtraFieldType::Number));
        assert!(result["plumbus"].label.is_none());
    }

    #[test]
    fn auto_register_deduplicates_across_extras() {
        let known: HashSet<String> = HashSet::new();
        let e1: serde_json::Map<String, serde_json::Value> = serde_json::from_str(r#"{"foo": 1}"#).unwrap();
        let e2: serde_json::Map<String, serde_json::Value> = serde_json::from_str(r#"{"foo": 2, "bar": "x"}"#).unwrap();
        let result = auto_register_field_defs(&known, &[&e1, &e2]).unwrap();
        assert_eq!(result.len(), 2);
        assert!(result.contains_key("foo"));
        assert!(result.contains_key("bar"));
    }

    #[test]
    fn camera_type_has_enum_values() {
        let def = known_field_def("cameraType").unwrap();
        assert!(def.values.is_some());
        let values = def.values.unwrap();
        assert!(values.contains(&"gen1".to_string()));
        assert!(values.contains(&"tripod".to_string()));
        assert!(def.labels.is_some());
        assert_eq!(def.labels.as_ref().unwrap().get("gen1").unwrap(), "Gen 1");
    }
}
