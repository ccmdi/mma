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
fn map_settings_duplicate_score_defaults_unset() {
    // Old settings JSON (no duplicateScore) must deserialize as "built-in ranking".
    let old_json = r#"{"pointAlongRoad":true}"#;
    let settings: MapSettings = serde_json::from_str(old_json).unwrap();
    assert!(settings.duplicate_score.is_none());
    assert!(MapSettings::default().duplicate_score.is_none());

    let json = r#"{"duplicateScore":"tagCount + 2 * zoom"}"#;
    let settings: MapSettings = serde_json::from_str(json).unwrap();
    assert_eq!(
        settings.duplicate_score.as_deref(),
        Some("tagCount + 2 * zoom")
    );
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

fn raw(json: &str) -> RawExtra {
    RawExtra::from_string(json.to_string()).unwrap()
}

#[test]
fn auto_register_no_new_keys() {
    let known: HashSet<String> = ["altitude", "countryCode"]
        .iter()
        .map(ToString::to_string)
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
    let result = auto_register_field_defs(&known, &[&raw(r#"{"captured": "2024-03"}"#)]).unwrap();
    assert!(matches!(
        result["captured"].field_type,
        ExtraFieldType::Month
    ));
}

#[test]
fn auto_register_mixed() {
    let known: HashSet<String> = ["altitude"].iter().map(ToString::to_string).collect();
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

// --- scratch map ---

/// A real schema in memory, plus one ordinary map to prove nothing else is touched.
fn setup_real_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    storage::run_migrations_on(&conn).unwrap();
    conn.execute(
        "INSERT INTO maps (id, name, settings, created_at, updated_at)
         VALUES ('m1', 'Real', '{}', '2020-01-01', '2020-01-01')",
        [],
    )
    .unwrap();
    conn
}

#[test]
fn scratch_map_is_adopted_not_recreated() {
    let conn = setup_real_db();
    let first = scratch_map_row(&conn).unwrap();
    assert_eq!(first.name, "", "a reserved map has no name of its own");
    conn.execute(
        "UPDATE maps SET name = 'renamed' WHERE id = ?1",
        params![SCRATCH_MAP_ID],
    )
    .unwrap();
    let second = scratch_map_row(&conn).unwrap();
    assert_eq!(first.id, SCRATCH_MAP_ID);
    // Re-entering the map during a session must keep whatever is in it.
    assert_eq!(second.name, "renamed");
    assert_eq!(second.created_at, first.created_at);
}

#[test]
fn scratch_map_is_hidden_from_the_map_list() {
    let conn = setup_real_db();
    scratch_map_row(&conn).unwrap();
    let listed = list_map_rows(&conn).unwrap();
    // Hiding it here is what also keeps it out of the counts, the copy-to-map
    // targets, and session restore.
    assert_eq!(
        listed.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["m1"]
    );
}

#[test]
fn deleting_the_scratch_map_leaves_other_maps_alone() {
    let conn = setup_real_db();
    scratch_map_row(&conn).unwrap();
    assert!(delete_map_data(&conn, SCRATCH_MAP_ID).unwrap());
    // Nothing to drop on the next startup.
    assert!(!delete_map_data(&conn, SCRATCH_MAP_ID).unwrap());
    assert_eq!(list_map_rows(&conn).unwrap().len(), 1);
}

fn setup_maps_table() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
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
