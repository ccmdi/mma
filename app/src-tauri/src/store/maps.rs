//! Map metadata CRUD and extra-field registration.
//!
//! Each map's metadata (name, settings, tags, extra field definitions) lives in
//! SQLite. This module provides the IPC commands for listing, creating, updating,
//! and deleting maps, plus the auto-registration logic that discovers new
//! `Location.extra` fields and persists their type definitions.

use crate::store::engine;
use crate::store::engine::StoreState;
use crate::store::engine::ValueRecord;
use crate::store::storage::{self, push_field};
use crate::sv::schema::PanoType;
use crate::types;
use crate::types::wire_str_enum;
use crate::types::AppResult;
use crate::types::RawExtra;
use crate::util::now_iso;
use rusqlite::types::ToSql;
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

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

/// Per-map config for a virtual tag-tree node - a folder node with no underlying
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
    /// Which member of a duplicate group survives a merge: a field expression scoring the
    /// location, highest wins. `null` (or blank) keeps the built-in ranking.
    pub duplicate_score: Option<String>,
    /// The order a review pass walks its worklist: a field expression scoring the location,
    /// highest first. `null` (or blank) keeps the order the selection resolved in.
    pub review_order: Option<String>,
    /// Whether a bulk pin resolves pano ids before pinning.
    pub pin_resolve: bool,
    /// Which capture a bulk pin's resolve settles on; `null` keeps the pano as found.
    pub pin_capture: Option<CapturePick>,
}

wire_str_enum! {
    /// A capture of a pano's timeline to settle on.
    derive(Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)
    pub enum CapturePick {
        /// The newest official capture.
        Newest = "newest",
        /// The oldest official capture.
        Oldest = "oldest",
    }
}

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
            duplicate_score: None,
            review_order: None,
            pin_resolve: true,
            pin_capture: None,
        }
    }
}

/// Serialized default settings JSON for a new map row.
pub fn default_settings_json() -> String {
    serde_json::to_string(&MapSettings::default()).expect("MapSettings serializes")
}

wire_str_enum! {
    /// Type discriminant for `Location.extra` field definitions.
    /// Determines how the field is displayed and filtered in the UI.
    derive(Clone, serde::Serialize, serde::Deserialize, specta::Type)
    pub enum FieldType {
        /// Text.
        String = "string",
        /// A number.
        Number = "number",
        /// True or false.
        Boolean = "boolean",
        /// A point in time.
        Date = "date",
        /// A year and month.
        Month = "month",
        /// One of a fixed set of values.
        Enum = "enum",
        /// A list of values.
        Array = "array",
    }
}

/// How a field's values decompose into index keys, if at all. The single place that
/// decides both *whether* a field can be indexed and *how* its postings are built.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IndexShape {
    /// One key per row: the value itself.
    Scalar,
    /// One key per member of the row's list.
    Multi,
    /// Not indexable.
    None,
}

impl FieldType {
    /// An inverted index is well-defined only over an enumerable value space: one bitmap
    /// per distinct value, sized by cardinality rather than by row count. The unbounded
    /// types are excluded because that bitmap is either degenerate (cardinality ~ N) or
    /// useless for the operators they are actually queried with (`gt`/`lt`/`between`).
    pub const fn index_shape(&self) -> IndexShape {
        match self {
            Self::Enum | Self::Boolean => IndexShape::Scalar,
            Self::Array => IndexShape::Multi,
            Self::String | Self::Number | Self::Date | Self::Month => IndexShape::None,
        }
    }
}

/// Schema definition for a single `Location.extra` field. Stored in the map's
/// `extra.fields` JSON. For enumerable types, `values` declares the value space in
/// display order, each member carrying its own display name.
#[derive(Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldDef {
    #[serde(rename = "type")]
    pub field_type: FieldType,
    pub label: Option<String>,
    /// The declared value space, in display order.
    pub values: Option<Vec<FieldValue>>,
    /// How this field is compared during disambiguation. `null` infers it from the field type.
    pub comparison: Option<ComparisonType>,
}

/// One member of an enumerable field's value space: the stored value plus its display
/// name. The value is the identity, so a rename is a label change and membership is
/// untouched.
#[derive(Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldValue {
    pub value: String,
    pub label: Option<String>,
}

impl FieldValue {
    pub fn new(value: impl Into<String>) -> Self {
        FieldValue {
            value: value.into(),
            label: None,
        }
    }

    pub fn labelled(value: impl Into<String>, label: impl Into<String>) -> Self {
        FieldValue {
            label: Some(label.into()),
            ..FieldValue::new(value)
        }
    }
}

/// How a field's values are compared when measuring how strongly it separates
/// groups (selection disambiguation). The only un-inferrable property a field can
/// declare is circularity (heading/azimuth=360, hour-of-day=24, month=12);
/// everything else is inferred from `FieldType`.
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
    pub fields: Option<HashMap<String, FieldDef>>,
}

/// Rows written before the per-value collapse spell a field's value space as a bare string
/// list beside a separate `labels` map. Folded here, at the one boundary persisted defs
/// enter through, so the stored row is never touched and the wire has a single shape.
fn modernize_field_defs(raw: &mut serde_json::Value) {
    let Some(fields) = raw
        .get_mut("fields")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    for def in fields.values_mut() {
        let Some(obj) = def.as_object_mut() else {
            continue;
        };
        let labels = obj.remove("labels").unwrap_or(serde_json::Value::Null);
        let Some(values) = obj
            .get_mut("values")
            .and_then(serde_json::Value::as_array_mut)
        else {
            continue;
        };
        for v in values.iter_mut() {
            let Some(name) = v.as_str().map(str::to_owned) else {
                continue;
            };
            let label = labels.get(&name).and_then(serde_json::Value::as_str);
            *v = serde_json::json!({ "value": name, "label": label });
        }
    }
}

impl MapExtra {
    /// Parse from the `maps.extra` JSON column. Field defs registered before ingest
    /// canonicalized keys can carry escapes and match no location, so decode them
    /// here; the next def write persists the repair. Default on invalid JSON.
    pub fn from_json(s: &str) -> Self {
        let mut raw: serde_json::Value = serde_json::from_str(s).unwrap_or_default();
        modernize_field_defs(&mut raw);
        let mut extra: MapExtra = serde_json::from_value(raw).unwrap_or_default();
        if let Some(fields) = extra.fields.take() {
            extra.fields = Some(
                fields
                    .into_iter()
                    .map(|(k, v)| (types::decode_json_key(&k).into_owned(), v))
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
    pub field_type: FieldType,
    pub label: &'static str,
    pub values: &'static [&'static str],
    pub labels: &'static [(&'static str, &'static str)],
    pub circular_period: Option<f64>,
    /// Excluded from the default enrich set; the user must opt in.
    pub default_off: bool,
}

impl KnownField {
    const fn simple(key: &'static str, field_type: FieldType, label: &'static str) -> Self {
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

wire_str_enum! {
    derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)
    pub enum CameraType {
        /// First-generation Street View camera.
        Gen1 = "gen1" => "Gen 1",
        /// Second- or third-generation camera.
        Gen2 = "gen2" => "Gen 2/3",
        /// Fourth-generation camera.
        Gen4 = "gen4" => "Gen 4",
        /// A capture from a known bad camera.
        Badcam = "badcam" => "Bad cam",
        /// An indoor capture from a tripod.
        Tripod = "tripod" => "Tripod",
        /// A special collect carried on foot or on another vehicle, such as a trekker.
        Trekker = "trekker" => "Trekker",
    }
}

pub static KNOWN_FIELDS: &[KnownField] = &[
    KnownField::simple("altitude", FieldType::Number, "Altitude"),
    KnownField::simple("countryCode", FieldType::String, "Country code"),
    KnownField {
        key: "cameraType",
        field_type: FieldType::Enum,
        label: "Camera type",
        values: CameraType::VALUES,
        labels: CameraType::LABELS,
        circular_period: None,
        default_off: false,
    },
    KnownField {
        key: "panoType",
        field_type: FieldType::Enum,
        label: "Pano type",
        values: PanoType::VALUES,
        labels: PanoType::LABELS,
        circular_period: None,
        default_off: false,
    },
    KnownField::simple("imageDate", FieldType::Month, "Image date"),
    KnownField::simple("datetime", FieldType::Date, "Exact date").off(),
    KnownField::simple("timezone", FieldType::Enum, "Timezone").off(),
    KnownField {
        key: "drivingDirection",
        field_type: FieldType::Number,
        label: "Driving direction",
        values: &[],
        labels: &[],
        circular_period: Some(360.0),
        default_off: true,
    },
    KnownField::simple("uploaderName", FieldType::String, "Uploader").off(),
    KnownField::simple("coverageDates", FieldType::Array, "Coverage dates").off(),
    KnownField::simple("subdivision", FieldType::String, "Subdivision").off(),
];

/// Returns a curated field definition for well-known SV metadata keys
/// (altitude, countryCode, cameraType, etc.). Falls back to `None` for
/// user-defined fields, which get type-inferred instead.
pub fn known_field_def(key: &str) -> Option<FieldDef> {
    KNOWN_FIELDS
        .iter()
        .find(|f| f.key == key)
        .map(|f| FieldDef {
            field_type: f.field_type.clone(),
            label: Some(f.label.into()),
            values: (!f.values.is_empty()).then(|| {
                f.values
                    .iter()
                    .map(|v| match f.labels.iter().find(|(k, _)| k == v) {
                        Some((_, label)) => FieldValue::labelled(*v, *label),
                        None => FieldValue::new(*v),
                    })
                    .collect()
            }),
            comparison: f
                .circular_period
                .map(|p| ComparisonType::Circular { period: p }),
        })
}

/// Infer an `FieldType` from a sample JSON value. Numbers become `Number`,
/// strings matching `YYYY-MM` become `Month`, everything else becomes `String`.
pub fn infer_field_type(value: &serde_json::Value) -> FieldType {
    if value.is_array() {
        return FieldType::Array;
    }
    if value.is_number() {
        return FieldType::Number;
    }
    if let Some(s) = value.as_str() {
        let b = s.as_bytes();
        if b.len() == 7
            && b[4] == b'-'
            && b[..4].iter().all(u8::is_ascii_digit)
            && b[5..].iter().all(u8::is_ascii_digit)
        {
            let month = (b[5] - b'0') * 10 + (b[6] - b'0');
            if (1..=12).contains(&month) {
                return FieldType::Month;
            }
        }
    }
    FieldType::String
}

/// Scan extra maps for keys not yet in `known_keys` and produce field definitions.
/// Known SV metadata keys get curated definitions; unknown keys get type-inferred ones.
/// Returns `None` if no new fields are discovered.
pub fn auto_register_field_defs(
    is_known: impl Fn(&str) -> bool,
    extras: &[&RawExtra],
) -> Option<HashMap<String, FieldDef>> {
    let mut new_defs: HashMap<String, FieldDef> = HashMap::new();
    for extra in extras {
        // Byte key-scan (no per-loc map alloc). A value is only deep-parsed for genuinely
        // new keys - the common case short-circuits on known_keys.
        extra.for_each_field(|key, raw_value| {
            if is_known(key) || new_defs.contains_key(key) {
                return;
            }
            let def = known_field_def(key).unwrap_or_else(|| {
                let value: serde_json::Value =
                    serde_json::from_str(raw_value).unwrap_or(serde_json::Value::Null);
                FieldDef {
                    field_type: infer_field_type(&value),
                    label: None,
                    values: None,
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

/// Persist new field defs - skips keys that already exist. Used for auto-registration.
pub fn persist_field_defs(
    conn: &Connection,
    map_id: &str,
    new_defs: &HashMap<String, FieldDef>,
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

/// Full metadata for a map.
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
    /// The map's tag value records (opaque piles keyed by id-as-string), an open-time
    /// snapshot of the `maps.tags` column. JS coerces them to its tag view.
    #[specta(type = HashMap<String, HashMap<String, specta_typescript::Unknown>>)]
    pub tags: HashMap<String, ValueRecord>,
    pub labels: Vec<String>,
    pub location_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub last_opened_at: Option<String>,
}

/// Partial update for map metadata. Omitted fields are left unchanged.
/// Setting `folder` to null moves the map to root.
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
    #[specta(type = Option<HashMap<String, HashMap<String, specta_typescript::Unknown>>>)]
    pub tags: Option<HashMap<String, ValueRecord>>,
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
pub async fn store_list_maps() -> AppResult<Vec<MapMeta>> {
    storage::with_db(move |conn| Ok(list_map_rows(conn)?)).await
}

/// The one ephemeral map. A reserved id rather than a flag column: the row is an
/// ordinary map that four call sites agree to treat as disposable -- this module's
/// create and list queries, and the startup purge.
pub const SCRATCH_MAP_ID: &str = "scratch";

/// Every map except the scratch one.
fn list_map_rows(conn: &Connection) -> rusqlite::Result<Vec<MapMeta>> {
    let mut stmt = conn.prepare("SELECT * FROM maps WHERE id != ?1")?;
    let rows = stmt.query_map(params![SCRATCH_MAP_ID], row_to_map_meta)?;
    rows.collect()
}

/// The scratch map's row, inserted on first use. A later call adopts the existing
/// row, so re-entering the map during a session keeps whatever is in it. It is created
/// nameless: a reserved map is not the user's to name, and every surface that renders a
/// map name already degrades when there isn't one.
fn scratch_map_row(conn: &Connection) -> rusqlite::Result<MapMeta> {
    let now = now_iso();
    conn.execute(
        "INSERT OR IGNORE INTO maps (id, name, folder, settings, created_at, updated_at)
         VALUES (?1, '', NULL, ?2, ?3, ?3)",
        params![SCRATCH_MAP_ID, default_settings_json(), now],
    )?;
    conn.query_row(
        "SELECT * FROM maps WHERE id = ?1",
        params![SCRATCH_MAP_ID],
        row_to_map_meta,
    )
}

/// Open the scratch map, creating it if this is its first use. Ordinary in every way
/// except that `storeListMaps` leaves it out and it is emptied on every launch.
#[tauri::command]
#[specta::specta]
pub async fn store_scratch_map() -> AppResult<MapMeta> {
    storage::with_db(move |conn| Ok(scratch_map_row(conn)?)).await
}

/// Drop last session's scratch map. Startup-only: nothing is open yet, so there is no
/// live store to evict first. Returns whether a map was actually there.
pub fn purge_scratch_map() -> AppResult<bool> {
    let conn = storage::open_db()?;
    delete_map_data(&conn, SCRATCH_MAP_ID)
}

/// Fetch a single map's metadata by ID. Returns `null` if not found.
#[tauri::command]
#[specta::specta]
pub async fn store_get_map(id: String) -> AppResult<Option<MapMeta>> {
    storage::with_db(move |conn| {
        let result = conn.query_row("SELECT * FROM maps WHERE id = ?1", params![id], |row| {
            row_to_map_meta(row)
        });
        match result {
            Ok(meta) => Ok(Some(meta)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    })
    .await
}

/// Create a new empty map with default settings. Returns the full metadata.
#[tauri::command]
#[specta::specta]
pub async fn store_create_map(name: String, folder: Option<String>) -> AppResult<MapMeta> {
    storage::with_db(move |conn| {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_iso();
        conn.execute(
            "INSERT INTO maps (id, name, folder, settings, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, name, folder, default_settings_json(), now, now],
        )?;

        conn.query_row("SELECT * FROM maps WHERE id = ?1", params![id], |row| {
            row_to_map_meta(row)
        })
        .map_err(Into::into)
    })
    .await
}

/// Drop a map's rows and its files on disk. Returns whether the map was there at all.
/// Callers evict any live in-memory store first -- this only touches persistence.
fn delete_map_data(conn: &Connection, id: &str) -> AppResult<bool> {
    let removed = conn.execute("DELETE FROM maps WHERE id = ?1", params![id])?;
    conn.execute("DELETE FROM edit_history WHERE map_id = ?1", params![id])?;
    conn.execute("DELETE FROM commits WHERE map_id = ?1", params![id])?;

    if let Ok(path) = storage::arrow_path(id) {
        let _ = fs::remove_file(path);
    }
    if let Ok(path) = storage::arrow_delta_path(id) {
        let _ = fs::remove_file(path);
    }
    // Remove the map's per-commit VCS delta files.
    if let Ok(dir) = storage::arrow_dir() {
        let _ = fs::remove_dir_all(dir.join("commits").join(id));
    }
    Ok(removed > 0)
}

/// Delete a map and all its data permanently.
// Evicts live in-memory state so an open window or racing autosave can't flush the overlay
// back after the files are gone. The manager lock is held across the whole delete so a
// concurrent store_open_map can't reload the map mid-deletion and resurrect it.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
#[specta::specta]
pub fn store_delete_map(state: tauri::State<'_, StoreState>, id: String) -> AppResult<()> {
    let mut mgr = state.lock()?;
    mgr.stores.remove(&id);
    mgr.window_map.retain(|_, v| v != &id);

    let conn = storage::open_db()?;
    delete_map_data(&conn, &id)?;
    Ok(())
}

/// Apply a partial update to a map's metadata. Omitted fields are left unchanged.
/// Returns a mutation result when the open map's field definitions changed.
#[tauri::command]
#[specta::specta]
pub async fn store_update_map_meta(
    state: tauri::State<'_, StoreState>,
    id: String,
    patch: MapMetaPatch,
) -> AppResult<Option<engine::MutationResult>> {
    let new_fields = patch.extra.as_ref().and_then(|e| e.fields.clone());
    let row_id = id.clone();
    storage::with_db(move |conn| update_map_meta_row(conn, &row_id, &patch)).await?;
    let Some(new_fields) = new_fields else {
        return Ok(None);
    };
    let mut mgr = state.lock()?;
    let Ok(store) = mgr.store_for_map(&id) else {
        return Ok(None);
    };
    store.field_defs.replace(new_fields);
    Ok(Some(store.finish_mutation(&engine::ChangeSet::default())))
}

/// Apply the patch to the `maps` row.
fn update_map_meta_row(conn: &Connection, id: &str, patch: &MapMetaPatch) -> AppResult<()> {
    let mut sets: Vec<&str> = Vec::new();
    let mut values: Vec<Box<dyn ToSql>> = Vec::new();

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
    values.push(Box::new(id.to_string()));

    let sql = format!("UPDATE maps SET {} WHERE id = ?", sets.join(", "));
    let param_refs: Vec<&dyn ToSql> = values.iter().map(AsRef::as_ref).collect();
    conn.execute(&sql, param_refs.as_slice())?;
    Ok(())
}

/// Mark a map as opened now, for sorting the map list by recency.
#[tauri::command]
#[specta::specta]
pub async fn store_touch_map_opened(map_id: String) -> AppResult<()> {
    storage::with_db(move |conn| {
        let now = now_iso();
        conn.execute(
            "UPDATE maps SET last_opened_at = ?1 WHERE id = ?2",
            params![now, map_id],
        )?;
        Ok(())
    })
    .await
}

/// Rename a folder across all maps that reference it.
#[tauri::command]
#[specta::specta]
pub async fn store_rename_folder(from: String, to: String) -> AppResult<()> {
    storage::with_db(move |conn| {
        conn.execute(
            "UPDATE maps SET folder = ?1 WHERE folder = ?2",
            params![to, from],
        )?;
        Ok(())
    })
    .await
}

/// Delete a folder, moving its maps to the root level.
#[tauri::command]
#[specta::specta]
pub async fn store_delete_folder(name: String) -> AppResult<()> {
    storage::with_db(move |conn| {
        conn.execute(
            "UPDATE maps SET folder = NULL WHERE folder = ?1",
            params![name],
        )?;
        Ok(())
    })
    .await
}

// ---------------------------------------------------------------------------
// Debug / diagnostics
// ---------------------------------------------------------------------------

/// Aggregate database statistics for the debug panel.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DbStats {
    pub maps: i64,
    /// Locations across every map as of the last time each was saved.
    pub locations: i64,
    pub tags: i64,
    pub commits: i64,
    /// Bytes the metadata database occupies, its write-ahead log included.
    pub db_size_bytes: i64,
    /// Bytes every map's location data occupies, saved commits included.
    pub location_size_bytes: i64,
    pub journal_mode: String,
    pub foreign_keys: bool,
}

/// Bytes a file occupies, or zero where there is no such file.
fn file_bytes(path: &Path) -> i64 {
    fs::metadata(path).map_or(0, |m| m.len() as i64)
}

/// Bytes the files under `dir` occupy, nested directories included. A directory that
/// cannot be read contributes nothing rather than failing the count.
fn dir_bytes(dir: &Path) -> i64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|e| {
            let path = e.path();
            if path.is_dir() {
                dir_bytes(&path)
            } else {
                file_bytes(&path)
            }
        })
        .sum()
}

/// Bytes a SQLite database occupies: the file plus the sidecars WAL mode keeps beside it,
/// which hold every write that has not been checkpointed back yet.
fn sqlite_bytes(db: &Path) -> i64 {
    let sidecar = |suffix: &str| {
        let mut name = db.as_os_str().to_os_string();
        name.push(suffix);
        file_bytes(Path::new(&name))
    };
    file_bytes(db) + sidecar("-wal") + sidecar("-shm")
}

/// Return aggregate database statistics: counts, file size, and configuration.
#[tauri::command]
#[specta::specta]
pub async fn store_db_stats() -> AppResult<DbStats> {
    storage::with_db(move |conn| {
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
                .filter_map(Result::ok)
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
            db_size_bytes: storage::db_path().map_or(0, |p| sqlite_bytes(&p)),
            location_size_bytes: storage::arrow_dir().map_or(0, |d| dir_bytes(&d)),
            journal_mode,
            foreign_keys: fk != 0,
        })
    })
    .await
}

#[cfg(test)]
#[path = "maps.test.rs"]
mod tests;
