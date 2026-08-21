//! Map metadata CRUD and extra-field registration.
//!
//! Each map's metadata (name, settings, tags, extra field definitions) lives in
//! SQLite. This module provides the IPC commands for listing, creating, updating,
//! and deleting maps, plus the auto-registration logic that discovers new
//! `Location.extra` fields and persists their type definitions.

use crate::location_store::StoreState;
use crate::storage::{self, push_field};
use crate::types::AppResult;
use crate::types::Tag;
use crate::util::now_iso;
use rusqlite::params;
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Typed sub-structs for MapMeta
// ---------------------------------------------------------------------------

/// Action performed by a per-map key binding on the active location.
/// New action kinds (e.g. copy-to-map) are added as variants here.
#[derive(Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MapKeyAction {
    #[serde(rename_all = "camelCase")]
    ApplyTag { tag_id: u32 },
    #[serde(rename_all = "camelCase")]
    CopyToMap { map_id: String },
}

/// One user-defined per-map key binding. `key` is a combo string in the same
/// canonical format as global hotkey bindings (e.g. "m", "Mod+Shift+x").
#[derive(Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MapKeyBinding {
    pub key: String,
    pub action: MapKeyAction,
}

/// Per-map config for a virtual tag-tree node — a folder node with no underlying
/// tag (e.g. "a" when only "a/b" and "a/c" exist). Keyed by the node's full slash
/// path in `MapSettings::virtual_tags`. Tree-view only; never creates a real tag.
#[derive(Clone, Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct VirtualTag {
    pub color: Option<String>,
}

/// Per-map editor preferences. Controls Street View lookup behavior (official vs
/// unofficial, camera type filters), export defaults, and metadata enrichment.
#[derive(Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct MapSettings {
    pub point_along_road: bool,
    pub prefer_direction: Option<String>,
    pub prefer_official: bool,
    pub prefer_higher_quality: bool,
    pub only_official: bool,
    pub camera_types: Option<Vec<String>>,
    pub default_pano_id: bool,
    pub export_zoom: bool,
    pub export_unpanned: bool,
    pub export_extras: bool,
    pub search_radius: Option<u32>,
    pub enrich_metadata: bool,
    pub enrich_fields: Option<Vec<String>>,
    pub key_bindings: Vec<MapKeyBinding>,
    /// Virtual tag-tree nodes keyed by full slash path. Tree-view only.
    pub virtual_tags: HashMap<String, VirtualTag>,
    /// Tag aliases: a second tree location (full slash path) -> the real tag id shown
    /// there. Tree-view only; clicking the alias leaf toggles the real tag.
    pub aliases: HashMap<String, u32>,
}

/// Canonical default map settings.
impl Default for MapSettings {
    fn default() -> Self {
        Self {
            point_along_road: true,
            prefer_direction: None,
            prefer_official: true,
            prefer_higher_quality: false,
            only_official: false,
            camera_types: None,
            default_pano_id: false,
            export_zoom: false,
            export_unpanned: true,
            export_extras: true,
            search_radius: None,
            enrich_metadata: false,
            enrich_fields: None,
            key_bindings: Vec::new(),
            virtual_tags: HashMap::new(),
            aliases: HashMap::new(),
        }
    }
}

/// Serialized default settings JSON for a new map row.
pub fn default_settings_json() -> String {
    serde_json::to_string(&MapSettings::default()).expect("MapSettings serializes")
}

/// Type discriminant for `Location.extra` field definitions.
/// Determines how the field is displayed and filtered in the UI.
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
    #[serde(rename = "array")]
    Array,
}

/// Schema definition for a single `Location.extra` field. Stored in the map's
/// `extra.fields` JSON. For enum types, `values` lists valid options and `labels`
/// provides display names.
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
    /// Optional override for how this field is compared during disambiguation.
    /// `None` => inferred from `field_type` on the analysis side.
    #[serde(default)]
    pub comparison: Option<ComparisonType>,
}

/// How a field's values are compared when measuring how strongly it separates
/// groups (selection disambiguation). The only un-inferrable property a field can
/// declare is circularity (heading/azimuth=360, hour-of-day=24, month=12);
/// everything else is inferred from `ExtraFieldType`.
#[derive(Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ComparisonType {
    Linear,
    Circular { period: f64 },
    Categorical,
}

/// Top-level `extra` JSON blob on a map row. Currently only holds field definitions,
/// but structured as an object to allow future extensions.
#[derive(Clone, Default, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MapExtra {
    #[serde(default)]
    pub fields: Option<HashMap<String, ExtraFieldDef>>,
}

impl MapExtra {
    /// Parse from the `maps.extra` JSON column. Field defs registered before ingest
    /// canonicalized keys can carry escapes and match no location, so decode them
    /// here; the next def write persists the repair. Default on invalid JSON.
    pub fn from_json(s: &str) -> Self {
        let mut extra: MapExtra = serde_json::from_str(s).unwrap_or_default();
        if let Some(fields) = extra.fields.take() {
            extra.fields = Some(
                fields
                    .into_iter()
                    .map(|(k, v)| (crate::types::decode_json_key(&k).into_owned(), v))
                    .collect(),
            );
        }
        extra
    }
}

/// Score bounding box: either `"auto"` (computed from locations) or an
/// explicit `[south, west, north, east]` rectangle.
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

/// One entry of the SV metadata field catalog. Exported to TS as the `KNOWN_FIELDS`
/// constant, which is the only field list the frontend has.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnownField {
    pub key: &'static str,
    #[serde(rename = "type")]
    pub field_type: ExtraFieldType,
    pub label: &'static str,
    pub values: &'static [&'static str],
    pub labels: &'static [(&'static str, &'static str)],
    pub circular_period: Option<f64>,
    /// Excluded from the default enrich set; the user must opt in.
    pub default_off: bool,
}

impl KnownField {
    const fn simple(key: &'static str, field_type: ExtraFieldType, label: &'static str) -> Self {
        Self {
            key,
            field_type,
            label,
            values: &[],
            labels: &[],
            circular_period: None,
            default_off: false,
        }
    }

    const fn off(mut self) -> Self {
        self.default_off = true;
        self
    }
}

macro_rules! camera_types {
    ($($variant:ident => $value:literal, $label:literal;)*) => {
        #[derive(Clone, Copy, serde::Serialize, serde::Deserialize, specta::Type)]
        pub enum CameraType {
            $(#[serde(rename = $value)] $variant),*
        }

        const CAMERA_TYPE_VALUES: &[&str] = &[$($value),*];
        const CAMERA_TYPE_LABELS: &[(&str, &str)] = &[$(($value, $label)),*];
    };
}

camera_types! {
    Gen1 => "gen1", "Gen 1";
    Gen2 => "gen2", "Gen 2/3";
    Gen4 => "gen4", "Gen 4";
    Badcam => "badcam", "Bad cam";
    Tripod => "tripod", "Tripod";
    Trekker => "trekker", "Trekker";
}

pub static KNOWN_FIELDS: &[KnownField] = &[
    KnownField::simple("altitude", ExtraFieldType::Number, "Altitude"),
    KnownField::simple("countryCode", ExtraFieldType::String, "Country code"),
    KnownField {
        key: "cameraType",
        field_type: ExtraFieldType::Enum,
        label: "Camera type",
        values: CAMERA_TYPE_VALUES,
        labels: CAMERA_TYPE_LABELS,
        circular_period: None,
        default_off: false,
    },
    KnownField {
        key: "panoType",
        field_type: ExtraFieldType::Enum,
        label: "Pano type",
        values: &["2", "3", "10"],
        labels: &[("2", "Official"), ("3", "Unknown"), ("10", "User uploaded")],
        circular_period: None,
        default_off: false,
    },
    KnownField::simple("imageDate", ExtraFieldType::Month, "Image date"),
    KnownField::simple("datetime", ExtraFieldType::Date, "Exact date").off(),
    KnownField::simple("timezone", ExtraFieldType::Enum, "Timezone").off(),
    KnownField {
        key: "drivingDirection",
        field_type: ExtraFieldType::Number,
        label: "Driving direction",
        values: &[],
        labels: &[],
        circular_period: Some(360.0),
        default_off: true,
    },
    KnownField::simple("uploaderName", ExtraFieldType::String, "Uploader").off(),
    KnownField::simple("coverageDates", ExtraFieldType::Array, "Coverage dates").off(),
    KnownField::simple("subdivision", ExtraFieldType::String, "Subdivision").off(),
];

/// Returns a curated field definition for well-known SV metadata keys
/// (altitude, countryCode, cameraType, etc.). Falls back to `None` for
/// user-defined fields, which get type-inferred instead.
pub fn known_field_def(key: &str) -> Option<ExtraFieldDef> {
    KNOWN_FIELDS
        .iter()
        .find(|f| f.key == key)
        .map(|f| ExtraFieldDef {
            field_type: f.field_type.clone(),
            label: Some(f.label.into()),
            values: if f.values.is_empty() {
                None
            } else {
                Some(f.values.iter().map(|s| (*s).into()).collect())
            },
            labels: if f.labels.is_empty() {
                None
            } else {
                Some(
                    f.labels
                        .iter()
                        .map(|(k, v)| ((*k).into(), (*v).into()))
                        .collect(),
                )
            },
            comparison: f
                .circular_period
                .map(|p| ComparisonType::Circular { period: p }),
        })
}

/// Infer an `ExtraFieldType` from a sample JSON value. Numbers become `Number`,
/// strings matching `YYYY-MM` become `Month`, everything else becomes `String`.
pub fn infer_field_type(value: &serde_json::Value) -> ExtraFieldType {
    if value.is_array() {
        return ExtraFieldType::Array;
    }
    if value.is_number() {
        return ExtraFieldType::Number;
    }
    if let Some(s) = value.as_str() {
        let b = s.as_bytes();
        if b.len() == 7
            && b[4] == b'-'
            && b[..4].iter().all(|c| c.is_ascii_digit())
            && b[5..].iter().all(|c| c.is_ascii_digit())
        {
            let month = (b[5] - b'0') * 10 + (b[6] - b'0');
            if (1..=12).contains(&month) {
                return ExtraFieldType::Month;
            }
        }
    }
    ExtraFieldType::String
}

/// Scan extra maps for keys not yet in `known_keys` and produce field definitions.
/// Known SV metadata keys get curated definitions; unknown keys get type-inferred ones.
/// Returns `None` if no new fields are discovered.
pub fn auto_register_field_defs(
    known_keys: &std::collections::HashSet<String>,
    extras: &[&crate::types::RawExtra],
) -> Option<HashMap<String, ExtraFieldDef>> {
    let mut new_defs: HashMap<String, ExtraFieldDef> = HashMap::new();
    for extra in extras {
        // Byte key-scan (no per-loc map alloc). A value is only deep-parsed for genuinely
        // new keys — the common case short-circuits on known_keys.
        extra.for_each_field(|key, raw_value| {
            if known_keys.contains(key) || new_defs.contains_key(key) {
                return;
            }
            let def = known_field_def(key).unwrap_or_else(|| {
                let value: serde_json::Value =
                    serde_json::from_str(raw_value).unwrap_or(serde_json::Value::Null);
                ExtraFieldDef {
                    field_type: infer_field_type(&value),
                    label: None,
                    values: None,
                    labels: None,
                    comparison: None,
                }
            });
            new_defs.insert(key.to_owned(), def);
        });
    }
    if new_defs.is_empty() {
        None
    } else {
        Some(new_defs)
    }
}

/// Persist new field defs — skips keys that already exist. Used for auto-registration.
pub fn persist_field_defs(
    conn: &rusqlite::Connection,
    map_id: &str,
    new_defs: &HashMap<String, ExtraFieldDef>,
) -> AppResult<()> {
    let extra_str: String = conn.query_row(
        "SELECT extra FROM maps WHERE id = ?1",
        params![map_id],
        |row| row.get(0),
    )?;
    let mut extra = MapExtra::from_json(&extra_str);
    let fields = extra.fields.get_or_insert_with(HashMap::new);
    for (k, v) in new_defs {
        fields.entry(k.clone()).or_insert_with(|| v.clone());
    }
    let json = serde_json::to_string(&extra).unwrap_or_default();
    conn.execute(
        "UPDATE maps SET extra = ?1 WHERE id = ?2",
        params![json, map_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// MapMeta
// ---------------------------------------------------------------------------

/// Full metadata for a map, deserialized from the SQLite `maps` row.
/// JSON columns (settings, tags, extra, etc.) are parsed into typed structs.
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

/// Partial update for map metadata. Only non-`None` fields are written.
/// `folder: Some(None)` explicitly unsets the folder (moves to root).
#[derive(Default, serde::Deserialize, specta::Type)]
#[serde(default, rename_all = "camelCase")]
pub struct MapMetaPatch {
    pub name: Option<String>,
    pub description: Option<String>,
    #[serde(deserialize_with = "deserialize_double_option", default)]
    #[specta(type = Option<String>)]
    pub folder: Option<Option<String>>,
    pub settings: Option<MapSettings>,
    pub score_bounds: Option<ScoreBounds>,
    pub extra: Option<MapExtra>,
    pub tags: Option<HashMap<String, Tag>>,
    pub labels: Option<Vec<String>>,
}

fn deserialize_double_option<'de, D>(de: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(serde::Deserialize::deserialize(de)?))
}

/// Deserialize a SQLite row into `MapMeta`, parsing JSON columns with
/// fallback defaults for forward compatibility.
fn row_to_map_meta(row: &rusqlite::Row<'_>) -> Result<MapMeta, rusqlite::Error> {
    Ok(MapMeta {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        folder: row.get("folder")?,
        settings: storage::json_col(row, "settings")?,
        score_bounds: storage::json_col(row, "score_bounds")?,
        extra: storage::json_col(row, "extra")?,
        tags: storage::json_col(row, "tags")?,
        labels: storage::json_col(row, "labels")?,
        location_count: row.get("location_count")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        last_opened_at: row.get("last_opened_at")?,
    })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Return metadata for every map in the database.
#[tauri::command]
#[specta::specta]
pub fn store_list_maps() -> AppResult<Vec<MapMeta>> {
    let conn = storage::open_db()?;
    let mut stmt = conn.prepare("SELECT * FROM maps")?;
    let rows = stmt.query_map([], |row| row_to_map_meta(row))?;
    let mut maps = Vec::new();
    for row in rows {
        maps.push(row?);
    }
    Ok(maps)
}

/// Fetch a single map's metadata by ID. Returns `None` if not found.
#[tauri::command]
#[specta::specta]
pub fn store_get_map(id: String) -> AppResult<Option<MapData>> {
    let conn = storage::open_db()?;
    let result = conn.query_row("SELECT * FROM maps WHERE id = ?1", params![id], |row| {
        row_to_map_meta(row)
    });
    match result {
        Ok(meta) => Ok(Some(MapData { meta })),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Create a new empty map with default settings. Returns the full metadata
/// (including the generated UUID) so the frontend can navigate to it immediately.
#[tauri::command]
#[specta::specta]
pub fn store_create_map(name: String, folder: Option<String>) -> AppResult<MapData> {
    let conn = storage::open_db()?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    conn.execute(
        "INSERT INTO maps (id, name, folder, settings, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, folder, default_settings_json(), now, now],
    )?;

    let meta = conn.query_row("SELECT * FROM maps WHERE id = ?1", params![id], |row| {
        row_to_map_meta(row)
    })?;
    Ok(MapData { meta })
}

/// Delete a map and all its data: database rows and files on disk.
// Evicts live in-memory state so an open window or racing autosave can't flush the overlay
// back after the files are gone. The manager lock is held across the whole delete so a
// concurrent store_open_map can't reload the map mid-deletion and resurrect it.
#[tauri::command]
#[specta::specta]
pub fn store_delete_map(state: tauri::State<'_, StoreState>, id: String) -> AppResult<()> {
    let mut mgr = state.lock()?;
    mgr.stores.remove(&id);
    mgr.window_map.retain(|_, v| v != &id);

    let conn = storage::open_db()?;
    conn.execute("DELETE FROM maps WHERE id = ?1", params![id])?;
    conn.execute("DELETE FROM edit_history WHERE map_id = ?1", params![id])?;
    conn.execute("DELETE FROM commits WHERE map_id = ?1", params![id])?;

    if let Ok(path) = storage::arrow_path(&id) {
        let _ = std::fs::remove_file(path);
    }
    if let Ok(path) = storage::arrow_delta_path(&id) {
        let _ = std::fs::remove_file(path);
    }
    // Remove the map's per-commit VCS delta files.
    if let Ok(dir) = storage::arrow_dir() {
        let _ = std::fs::remove_dir_all(dir.join("commits").join(&id));
    }
    Ok(())
}

/// Apply a partial update to a map's metadata; `None` fields are left unchanged.
// Also syncs known_field_keys on the in-memory store when extra fields change, so
// auto-registration doesn't re-discover fields the user explicitly defined.
#[tauri::command]
#[specta::specta]
pub fn store_update_map_meta(
    state: tauri::State<'_, StoreState>,
    id: String,
    patch: MapMetaPatch,
) -> AppResult<()> {
    let mut sets: Vec<&str> = Vec::new();
    let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    push_field!(sets, values, patch, "name", name);
    push_field!(sets, values, patch, "description", description);
    push_field!(sets, values, patch, "folder", folder);
    push_field!(json sets, values, patch, "settings", settings);
    push_field!(json sets, values, patch, "score_bounds", score_bounds);
    push_field!(json sets, values, patch, "extra", extra);
    push_field!(json sets, values, patch, "tags", tags);
    push_field!(json sets, values, patch, "labels", labels);

    if sets.is_empty() {
        return Ok(());
    }

    let now = now_iso();
    sets.push("updated_at = ?");
    values.push(Box::new(now));
    let id_clone = id.clone();
    values.push(Box::new(id));

    let sql = format!("UPDATE maps SET {} WHERE id = ?", sets.join(", "));
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|b| b.as_ref()).collect();
    let conn = storage::open_db()?;
    let old_extra = if patch.extra.is_some() {
        let s: String = conn
            .query_row("SELECT extra FROM maps WHERE id = ?", [&id_clone], |r| {
                r.get(0)
            })
            .unwrap_or_default();
        Some(MapExtra::from_json(&s))
    } else {
        None
    };
    conn.execute(&sql, param_refs.as_slice())?;
    if let Some(ref extra) = patch.extra {
        let mut mgr = state.lock()?;
        if let Ok(store) = mgr.store_for_map(&id_clone) {
            if let Some(ref new_fields) = extra.fields {
                if let Some(ref old_fields) = old_extra.and_then(|e| e.fields) {
                    for key in old_fields.keys() {
                        if !new_fields.contains_key(key) {
                            store.known_field_keys.remove(key);
                        }
                    }
                }
                for key in new_fields.keys() {
                    store.known_field_keys.insert(key.clone());
                }
            }
        }
    }
    Ok(())
}

/// Update `last_opened_at` to the current timestamp. Used to sort the map
/// list by recency in the dashboard.
#[tauri::command]
#[specta::specta]
pub fn store_touch_map_opened(map_id: String) -> AppResult<()> {
    let conn = storage::open_db()?;
    let now = now_iso();
    conn.execute(
        "UPDATE maps SET last_opened_at = ?1 WHERE id = ?2",
        params![now, map_id],
    )?;
    Ok(())
}

/// Rename a folder across all maps that reference it.
#[tauri::command]
#[specta::specta]
pub fn store_rename_folder(from: String, to: String) -> AppResult<()> {
    let conn = storage::open_db()?;
    conn.execute(
        "UPDATE maps SET folder = ?1 WHERE folder = ?2",
        params![to, from],
    )?;
    Ok(())
}

/// Delete a folder by setting all its maps' folder to `NULL` (moves them to root).
#[tauri::command]
#[specta::specta]
pub fn store_delete_folder(name: String) -> AppResult<()> {
    let conn = storage::open_db()?;
    conn.execute(
        "UPDATE maps SET folder = NULL WHERE folder = ?1",
        params![name],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Debug / diagnostics
// ---------------------------------------------------------------------------

/// Aggregate database statistics for the debug panel.
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

/// Compute aggregate database statistics (map/location/tag/commit counts,
/// database file size, journal mode). Tag count is summed across all maps
/// by parsing each map's tags JSON column.
#[tauri::command]
#[specta::specta]
pub fn store_db_stats() -> AppResult<DbStats> {
    let conn = storage::open_db()?;
    let maps: i64 = conn
        .query_row("SELECT COUNT(*) FROM maps", [], |r| r.get(0))
        .unwrap_or(0);
    let locations: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(location_count), 0) FROM maps",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let tags: i64 = {
        let mut stmt = conn.prepare("SELECT tags FROM maps")?;
        let rows: Vec<String> = stmt
            .query_map([], |r| r.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        rows.iter()
            .map(|t| {
                serde_json::from_str::<serde_json::Value>(t)
                    .ok()
                    .and_then(|v| v.as_object().map(|o| o.len() as i64))
                    .unwrap_or(0)
            })
            .sum()
    };
    let commits: i64 = conn
        .query_row("SELECT COUNT(*) FROM commits", [], |r| r.get(0))
        .unwrap_or(0);
    let page_count: i64 = conn
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .unwrap_or(0);
    let page_size: i64 = conn
        .query_row("PRAGMA page_size", [], |r| r.get(0))
        .unwrap_or(4096);
    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap_or_default();
    let fk: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap_or(0);
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
    fn map_settings_never_serializes_absent_keys() {
        // JS reads settings with no fallback, so every key must survive an old
        // settings row: missing on disk means the Rust default, present on the wire.
        let settings: MapSettings = serde_json::from_str(r#"{"pointAlongRoad":true}"#).unwrap();
        assert!(!settings.enrich_metadata);
        let value: serde_json::Value = serde_json::to_value(&settings).unwrap();
        assert_eq!(value["enrichMetadata"], serde_json::Value::Bool(false));
    }

    #[test]
    fn map_settings_key_bindings_default_empty() {
        // Old settings JSON (no keyBindings) must deserialize with an empty list.
        let old_json = r#"{"pointAlongRoad":true}"#;
        let settings: MapSettings = serde_json::from_str(old_json).unwrap();
        assert!(settings.key_bindings.is_empty());
        assert!(MapSettings::default().key_bindings.is_empty());
    }

    #[test]
    fn map_extra_decodes_escaped_field_keys() {
        // Defs registered before ingest canonicalized keys spell the field with its raw
        // JSON escape; reading them back must yield the name the location data uses.
        let bs = '\\';
        let json = format!(r#"{{"fields":{{"caf{bs}{bs}u00e9":{{"type":"string"}}}}}}"#);
        let extra = MapExtra::from_json(&json);
        let fields = extra.fields.unwrap();
        assert!(fields.contains_key("café"), "got {:?}", fields.keys());
    }

    #[test]
    fn map_settings_virtual_tags_default_empty() {
        // Old settings JSON (no virtualTags) must deserialize with an empty map.
        let old_json = r#"{"pointAlongRoad":true}"#;
        let settings: MapSettings = serde_json::from_str(old_json).unwrap();
        assert!(settings.virtual_tags.is_empty());
        assert!(MapSettings::default().virtual_tags.is_empty());

        // Round-trips a configured virtual node.
        let json = r##"{"virtualTags":{"a":{"color":"#ff0000"}}}"##;
        let settings: MapSettings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.virtual_tags["a"].color.as_deref(), Some("#ff0000"));
    }

    #[test]
    fn map_settings_aliases_default_empty() {
        // Old settings JSON (no aliases) must deserialize with an empty map.
        let old_json = r#"{"pointAlongRoad":true}"#;
        let settings: MapSettings = serde_json::from_str(old_json).unwrap();
        assert!(settings.aliases.is_empty());
        assert!(MapSettings::default().aliases.is_empty());

        // Round-trips an alias path -> tag id.
        let json = r#"{"aliases":{"d/e/c":42}}"#;
        let settings: MapSettings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.aliases["d/e/c"], 42);
    }

    #[test]
    fn map_key_binding_wire_format_round_trip() {
        // Wire shape is the contract with the TS bindings: tagged union, camelCase.
        let json = r#"{"key":"Mod+Shift+x","action":{"type":"applyTag","tagId":5}}"#;
        let binding: MapKeyBinding = serde_json::from_str(json).unwrap();
        assert_eq!(binding.key, "Mod+Shift+x");
        let MapKeyAction::ApplyTag { tag_id } = &binding.action else {
            panic!("expected applyTag");
        };
        assert_eq!(*tag_id, 5);
        assert_eq!(serde_json::to_string(&binding).unwrap(), json);

        let json = r#"{"key":"m","action":{"type":"copyToMap","mapId":"abc"}}"#;
        let binding: MapKeyBinding = serde_json::from_str(json).unwrap();
        let MapKeyAction::CopyToMap { map_id } = &binding.action else {
            panic!("expected copyToMap");
        };
        assert_eq!(map_id, "abc");
        assert_eq!(serde_json::to_string(&binding).unwrap(), json);
    }

    #[test]
    fn infer_number() {
        assert!(matches!(
            infer_field_type(&serde_json::json!(42)),
            ExtraFieldType::Number
        ));
        assert!(matches!(
            infer_field_type(&serde_json::json!(2.75)),
            ExtraFieldType::Number
        ));
    }

    #[test]
    fn infer_month() {
        assert!(matches!(
            infer_field_type(&serde_json::json!("2023-05")),
            ExtraFieldType::Month
        ));
        assert!(matches!(
            infer_field_type(&serde_json::json!("1999-12")),
            ExtraFieldType::Month
        ));
    }

    #[test]
    fn infer_not_month() {
        assert!(matches!(
            infer_field_type(&serde_json::json!("2023-5")),
            ExtraFieldType::String
        ));
        assert!(matches!(
            infer_field_type(&serde_json::json!("hello")),
            ExtraFieldType::String
        ));
        assert!(matches!(
            infer_field_type(&serde_json::json!("2023-123")),
            ExtraFieldType::String
        ));
        assert!(matches!(
            infer_field_type(&serde_json::json!("9999-99")),
            ExtraFieldType::String
        ));
        assert!(matches!(
            infer_field_type(&serde_json::json!("2023-00")),
            ExtraFieldType::String
        ));
        assert!(matches!(
            infer_field_type(&serde_json::json!("2023-13")),
            ExtraFieldType::String
        ));
    }

    #[test]
    fn infer_string_fallback() {
        assert!(matches!(
            infer_field_type(&serde_json::json!("hello")),
            ExtraFieldType::String
        ));
        assert!(matches!(
            infer_field_type(&serde_json::json!(true)),
            ExtraFieldType::String
        ));
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
        assert!(known_field_def("drivingDirection").is_some());
        assert!(known_field_def("uploaderName").is_some());
        assert!(known_field_def("plumbus").is_none());
    }

    #[test]
    fn known_field_types() {
        assert!(matches!(
            known_field_def("altitude").unwrap().field_type,
            ExtraFieldType::Number
        ));
        assert!(matches!(
            known_field_def("imageDate").unwrap().field_type,
            ExtraFieldType::Month
        ));
        assert!(matches!(
            known_field_def("datetime").unwrap().field_type,
            ExtraFieldType::Date
        ));
        assert!(matches!(
            known_field_def("cameraType").unwrap().field_type,
            ExtraFieldType::Enum
        ));
    }

    fn raw(json: &str) -> crate::types::RawExtra {
        crate::types::RawExtra::from_string(json.to_string()).unwrap()
    }

    #[test]
    fn auto_register_no_new_keys() {
        let known: HashSet<String> = ["altitude", "countryCode"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert!(auto_register_field_defs(&known, &[&raw(r#"{"altitude": 100}"#)]).is_none());
    }

    #[test]
    fn auto_register_known_key() {
        let known: HashSet<String> = HashSet::new();
        let result = auto_register_field_defs(&known, &[&raw(r#"{"altitude": 500}"#)]).unwrap();
        assert_eq!(result.len(), 1);
        let def = &result["altitude"];
        assert!(matches!(def.field_type, ExtraFieldType::Number));
        assert_eq!(def.label.as_deref(), Some("Altitude"));
    }

    #[test]
    fn auto_register_unknown_number() {
        let known: HashSet<String> = HashSet::new();
        let result = auto_register_field_defs(&known, &[&raw(r#"{"plumbus": 1}"#)]).unwrap();
        assert_eq!(result.len(), 1);
        let def = &result["plumbus"];
        assert!(matches!(def.field_type, ExtraFieldType::Number));
        assert!(def.label.is_none());
    }

    #[test]
    fn auto_register_unknown_string() {
        let known: HashSet<String> = HashSet::new();
        let result = auto_register_field_defs(&known, &[&raw(r#"{"region": "EU"}"#)]).unwrap();
        assert!(matches!(
            result["region"].field_type,
            ExtraFieldType::String
        ));
    }

    #[test]
    fn auto_register_unknown_month() {
        let known: HashSet<String> = HashSet::new();
        let result =
            auto_register_field_defs(&known, &[&raw(r#"{"captured": "2024-03"}"#)]).unwrap();
        assert!(matches!(
            result["captured"].field_type,
            ExtraFieldType::Month
        ));
    }

    #[test]
    fn auto_register_mixed() {
        let known: HashSet<String> = ["altitude"].iter().map(|s| s.to_string()).collect();
        let extra = raw(r#"{"altitude": 100, "countryCode": "US", "plumbus": 42}"#);
        let result = auto_register_field_defs(&known, &[&extra]).unwrap();
        // altitude is already known → skipped
        assert!(!result.contains_key("altitude"));
        // countryCode is new but in known_field_def → gets label
        assert_eq!(result["countryCode"].label.as_deref(), Some("Country code"));
        // plumbus is unknown → inferred as Number, no label
        assert!(matches!(
            result["plumbus"].field_type,
            ExtraFieldType::Number
        ));
        assert!(result["plumbus"].label.is_none());
    }

    #[test]
    fn auto_register_deduplicates_across_extras() {
        let known: HashSet<String> = HashSet::new();
        let result = auto_register_field_defs(
            &known,
            &[&raw(r#"{"foo": 1}"#), &raw(r#"{"foo": 2, "bar": "x"}"#)],
        )
        .unwrap();
        assert_eq!(result.len(), 2);
        assert!(result.contains_key("foo"));
        assert!(result.contains_key("bar"));
    }

    #[test]
    fn for_each_field_skips_nested_and_handles_specials() {
        // Only depth-1 keys are visited; nested object/array keys are jumped over. Value
        // slices capture strings (incl. braces/commas/escaped quotes) and nested structures whole.
        let e = raw(r#"{"a":1,"b":"x,y}z","c":{"nested":true,"tags":[1]},"d":[1,2],"e":"q\"r"}"#);
        let mut fields: Vec<(String, String)> = Vec::new();
        e.for_each_field(|k, v| fields.push((k.to_owned(), v.trim().to_owned())));
        let keys: Vec<&str> = fields.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            keys,
            vec!["a", "b", "c", "d", "e"],
            "nested keys must not be visited"
        );
        assert_eq!(fields[0].1, "1");
        assert_eq!(fields[1].1, r#""x,y}z""#);
        assert_eq!(fields[2].1, r#"{"nested":true,"tags":[1]}"#);
        assert_eq!(fields[3].1, "[1,2]");
        assert_eq!(fields[4].1, r#""q\"r""#);
    }

    #[test]
    fn camera_type_has_enum_values() {
        let def = known_field_def("cameraType").unwrap();
        let values = def.values.unwrap();
        assert!(values.contains(&"gen1".to_string()));
        assert!(values.contains(&"tripod".to_string()));
        assert!(values.contains(&"trekker".to_string()));
        let labels = def.labels.unwrap();
        assert_eq!(labels.get("gen1").unwrap(), "Gen 1");
        // every offered value is labelled
        assert_eq!(labels.len(), values.len());
    }

    #[test]
    fn infer_array() {
        assert!(matches!(
            infer_field_type(&serde_json::json!([1, 2, 3])),
            ExtraFieldType::Array
        ));
        assert!(matches!(
            infer_field_type(&serde_json::json!([])),
            ExtraFieldType::Array
        ));
    }

    #[test]
    fn infer_object_and_null() {
        assert!(matches!(
            infer_field_type(&serde_json::json!({"a": 1})),
            ExtraFieldType::String
        ));
        assert!(matches!(
            infer_field_type(&serde_json::Value::Null),
            ExtraFieldType::String
        ));
    }

    #[test]
    fn infer_month_wrong_dash_position_is_string() {
        assert!(matches!(
            infer_field_type(&serde_json::json!("2024/06")),
            ExtraFieldType::String
        ));
    }

    #[test]
    fn infer_month_wrong_length_is_string() {
        assert!(matches!(
            infer_field_type(&serde_json::json!("202-06")),
            ExtraFieldType::String
        ));
        assert!(matches!(
            infer_field_type(&serde_json::json!("20244-06")),
            ExtraFieldType::String
        ));
    }

    #[test]
    fn driving_direction_is_circular_360() {
        let def = known_field_def("drivingDirection").unwrap();
        assert!(matches!(def.field_type, ExtraFieldType::Number));
        assert!(matches!(
            def.comparison,
            Some(ComparisonType::Circular { period }) if period == 360.0
        ));
    }

    #[test]
    fn coverage_dates_is_array() {
        assert!(matches!(
            known_field_def("coverageDates").unwrap().field_type,
            ExtraFieldType::Array
        ));
    }

    #[test]
    fn uploader_name_is_string() {
        assert!(matches!(
            known_field_def("uploaderName").unwrap().field_type,
            ExtraFieldType::String
        ));
    }

    #[test]
    fn timezone_is_enum_without_values() {
        let def = known_field_def("timezone").unwrap();
        assert!(matches!(def.field_type, ExtraFieldType::Enum));
        assert!(def.values.is_none());
        assert!(def.labels.is_none());
    }

    #[test]
    fn known_field_def_case_mismatch_is_none() {
        assert!(known_field_def("CountryCode").is_none());
        assert!(known_field_def("").is_none());
    }

    #[test]
    fn auto_register_intra_call_dedup_first_value_wins_for_inference() {
        // Two extras introduce the same new key "foo" with values of different
        // inferred type; the first extra processed determines the def.
        let known: HashSet<String> = HashSet::new();
        let result = auto_register_field_defs(
            &known,
            &[&raw(r#"{"foo": 5}"#), &raw(r#"{"foo": "2024-01"}"#)],
        )
        .unwrap();
        assert!(matches!(result["foo"].field_type, ExtraFieldType::Number));
    }

    #[test]
    fn auto_register_curated_beats_inference_for_string_value() {
        // altitude's curated def is Number even though the sample value here is a string.
        let known: HashSet<String> = HashSet::new();
        let result =
            auto_register_field_defs(&known, &[&raw(r#"{"altitude": "not a number"}"#)]).unwrap();
        assert!(matches!(
            result["altitude"].field_type,
            ExtraFieldType::Number
        ));
        assert_eq!(result["altitude"].label.as_deref(), Some("Altitude"));
    }

    fn setup_maps_table() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE maps (id TEXT PRIMARY KEY, extra TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn persist_field_defs_inserts_missing() {
        let conn = setup_maps_table();
        conn.execute("INSERT INTO maps (id, extra) VALUES ('m1', '{}')", [])
            .unwrap();
        let mut new_defs = HashMap::new();
        new_defs.insert("altitude".to_string(), known_field_def("altitude").unwrap());
        persist_field_defs(&conn, "m1", &new_defs).unwrap();

        let extra_str: String = conn
            .query_row("SELECT extra FROM maps WHERE id = 'm1'", [], |r| r.get(0))
            .unwrap();
        let extra: MapExtra = serde_json::from_str(&extra_str).unwrap();
        let fields = extra.fields.unwrap();
        assert!(matches!(
            fields["altitude"].field_type,
            ExtraFieldType::Number
        ));
    }

    #[test]
    fn persist_field_defs_never_overwrites_existing() {
        let conn = setup_maps_table();
        let seed = r#"{"fields":{"countryCode":{"type":"string","label":"Custom"}}}"#;
        conn.execute(
            "INSERT INTO maps (id, extra) VALUES ('m1', ?1)",
            params![seed],
        )
        .unwrap();

        let mut new_defs = HashMap::new();
        new_defs.insert(
            "countryCode".to_string(),
            known_field_def("countryCode").unwrap(),
        );
        persist_field_defs(&conn, "m1", &new_defs).unwrap();

        let extra_str: String = conn
            .query_row("SELECT extra FROM maps WHERE id = 'm1'", [], |r| r.get(0))
            .unwrap();
        let extra: MapExtra = serde_json::from_str(&extra_str).unwrap();
        let fields = extra.fields.unwrap();
        // Original label survives; not clobbered by the curated "Country code" label.
        assert_eq!(fields["countryCode"].label.as_deref(), Some("Custom"));
    }

    #[test]
    fn persist_field_defs_missing_map_row_errors() {
        let conn = setup_maps_table();
        let new_defs = HashMap::new();
        assert!(persist_field_defs(&conn, "does-not-exist", &new_defs).is_err());
    }

    #[test]
    fn persist_field_defs_corrupt_extra_json_defaults_and_succeeds() {
        let conn = setup_maps_table();
        conn.execute("INSERT INTO maps (id, extra) VALUES ('m1', 'not json')", [])
            .unwrap();
        let mut new_defs = HashMap::new();
        new_defs.insert("altitude".to_string(), known_field_def("altitude").unwrap());
        persist_field_defs(&conn, "m1", &new_defs).unwrap();

        let extra_str: String = conn
            .query_row("SELECT extra FROM maps WHERE id = 'm1'", [], |r| r.get(0))
            .unwrap();
        let extra: MapExtra = serde_json::from_str(&extra_str).unwrap();
        let fields = extra.fields.unwrap();
        assert!(fields.contains_key("altitude"));
        assert_eq!(fields.len(), 1);
    }

    #[test]
    fn default_settings_json_round_trips_to_default() {
        let json = default_settings_json();
        let parsed: MapSettings = serde_json::from_str(&json).unwrap();
        let default = MapSettings::default();

        assert_eq!(parsed.point_along_road, default.point_along_road);
        assert_eq!(parsed.prefer_official, default.prefer_official);
        assert_eq!(parsed.prefer_higher_quality, default.prefer_higher_quality);
        assert_eq!(parsed.only_official, default.only_official);
        assert_eq!(parsed.default_pano_id, default.default_pano_id);
        assert_eq!(parsed.export_zoom, default.export_zoom);
        assert_eq!(parsed.export_unpanned, default.export_unpanned);
        assert_eq!(parsed.export_extras, default.export_extras);
        assert_eq!(parsed.enrich_metadata, default.enrich_metadata);
        assert!(parsed.prefer_direction.is_none());
        assert!(parsed.camera_types.is_none());
        assert!(parsed.search_radius.is_none());
        assert!(parsed.enrich_fields.is_none());
        assert!(parsed.key_bindings.is_empty());
        assert!(parsed.virtual_tags.is_empty());
        assert!(parsed.aliases.is_empty());
    }
}
