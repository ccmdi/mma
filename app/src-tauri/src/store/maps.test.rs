use super::*;
use crate::test_util::{loc_ids, tag_ids, TempDir};
use crate::types::Location;
use mma_algebra::Id;
use std::collections::HashSet;

#[test]
fn map_settings_never_serializes_absent_keys() {
    // JS reads settings with no fallback, so every key must survive an old
    // settings row: missing on disk means the Rust default, present on the wire.
    let settings: MapSettings = serde_json::from_str(r#"{"pointAlongRoad":true}"#).unwrap();
    assert!(!settings.preferences.enrich_metadata);
    let value: serde_json::Value = serde_json::to_value(&settings).unwrap();
    assert_eq!(value["enrichMetadata"], serde_json::Value::Bool(false));
}

#[test]
fn legacy_flat_settings_round_trip_unchanged() {
    let legacy = serde_json::json!({
        "pointAlongRoad": false,
        "preferDirection": "north",
        "preferOfficial": false,
        "preferHigherQuality": true,
        "onlyOfficial": true,
        "cameraTypes": ["gen4"],
        "defaultPanoId": true,
        "exportZoom": true,
        "exportUnpanned": false,
        "exportShape": "local",
        "searchRadius": 75,
        "enrichMetadata": true,
        "enrichFields": ["altitude"],
        "keyBindings": [{"key": "m", "action": {"type": "applyTag", "tagId": 7}}],
        "virtualTags": {"Europe": {"color": "#123456", "order": null}},
        "aliases": {"Europe/France": 7},
        "pluginData": {"heatmap": {"project": {"layers": []}}},
        "duplicateScore": "zoom",
        "reviewOrder": "-year",
        "pinResolve": false,
        "pinCapture": "oldest"
    });
    let settings: MapSettings = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(&settings).unwrap(), legacy);
}

#[test]
fn map_preferences_leave_out_what_refers_to_the_map() {
    let settings: MapSettings = serde_json::from_value(serde_json::json!({
        "pointAlongRoad": false,
        "keyBindings": [{"key": "m", "action": {"type": "applyTag", "tagId": 7}}],
        "virtualTags": {"Europe": {"color": "#123456"}},
        "aliases": {"Europe/France": 7},
        "pluginData": {"heatmap": {"project": {"layers": []}}}
    }))
    .unwrap();
    let value = serde_json::to_value(&settings.preferences).unwrap();
    assert_eq!(value["pointAlongRoad"], false);
    for key in ["keyBindings", "virtualTags", "aliases", "pluginData"] {
        assert!(value.get(key).is_none(), "{key} leaked into preferences");
    }
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
    let fields = extra.fields;
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
    assert!(settings.preferences.duplicate_score.is_none());
    assert!(MapPreferences::default().duplicate_score.is_none());

    let json = r#"{"duplicateScore":"tagCount + 2 * zoom"}"#;
    let settings: MapSettings = serde_json::from_str(json).unwrap();
    assert_eq!(
        settings.preferences.duplicate_score.as_deref(),
        Some("tagCount + 2 * zoom")
    );
}

#[test]
fn map_settings_review_order_defaults_unset() {
    // Old settings JSON (no reviewOrder) must deserialize as "selection order".
    let old_json = r#"{"pointAlongRoad":true}"#;
    let settings: MapSettings = serde_json::from_str(old_json).unwrap();
    assert!(settings.preferences.review_order.is_none());
    assert!(MapPreferences::default().review_order.is_none());

    let json = r#"{"reviewOrder":"-year"}"#;
    let settings: MapSettings = serde_json::from_str(json).unwrap();
    assert_eq!(settings.preferences.review_order.as_deref(), Some("-year"));
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
    assert_eq!(map_id.raw(), "abc");
    assert_eq!(serde_json::to_string(&binding).unwrap(), json);
}

#[test]
fn infer_number() {
    assert!(matches!(
        infer_field_type(&serde_json::json!(42)),
        FieldType::Number
    ));
    assert!(matches!(
        infer_field_type(&serde_json::json!(2.75)),
        FieldType::Number
    ));
}

#[test]
fn infer_month() {
    assert!(matches!(
        infer_field_type(&serde_json::json!("2023-05")),
        FieldType::Month
    ));
    assert!(matches!(
        infer_field_type(&serde_json::json!("1999-12")),
        FieldType::Month
    ));
}

#[test]
fn infer_not_month() {
    assert!(matches!(
        infer_field_type(&serde_json::json!("2023-5")),
        FieldType::String
    ));
    assert!(matches!(
        infer_field_type(&serde_json::json!("hello")),
        FieldType::String
    ));
    assert!(matches!(
        infer_field_type(&serde_json::json!("2023-123")),
        FieldType::String
    ));
    assert!(matches!(
        infer_field_type(&serde_json::json!("9999-99")),
        FieldType::String
    ));
    assert!(matches!(
        infer_field_type(&serde_json::json!("2023-00")),
        FieldType::String
    ));
    assert!(matches!(
        infer_field_type(&serde_json::json!("2023-13")),
        FieldType::String
    ));
}

#[test]
fn infer_string_fallback() {
    assert!(matches!(
        infer_field_type(&serde_json::json!("hello")),
        FieldType::String
    ));
    assert!(matches!(
        infer_field_type(&serde_json::json!(true)),
        FieldType::String
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
        FieldType::Number
    ));
    assert!(matches!(
        known_field_def("imageDate").unwrap().field_type,
        FieldType::Month
    ));
    assert!(matches!(
        known_field_def("datetime").unwrap().field_type,
        FieldType::Date
    ));
    assert!(matches!(
        known_field_def("cameraType").unwrap().field_type,
        FieldType::Enum
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
    assert!(infer_field_defs(|k| known.contains(k), &[&raw(r#"{"altitude": 100}"#)]).is_none());
}

#[test]
fn auto_register_known_key() {
    let known: HashSet<String> = HashSet::new();
    let result = infer_field_defs(|k| known.contains(k), &[&raw(r#"{"altitude": 500}"#)]).unwrap();
    assert_eq!(result.len(), 1);
    let def = &result["altitude"];
    assert!(matches!(def.field_type, FieldType::Number));
    assert_eq!(def.label.as_deref(), Some("Altitude"));
}

#[test]
fn auto_register_unknown_number() {
    let known: HashSet<String> = HashSet::new();
    let result = infer_field_defs(|k| known.contains(k), &[&raw(r#"{"plumbus": 1}"#)]).unwrap();
    assert_eq!(result.len(), 1);
    let def = &result["plumbus"];
    assert!(matches!(def.field_type, FieldType::Number));
    assert!(def.label.is_none());
}

#[test]
fn auto_register_unknown_string() {
    let known: HashSet<String> = HashSet::new();
    let result = infer_field_defs(|k| known.contains(k), &[&raw(r#"{"region": "EU"}"#)]).unwrap();
    assert!(matches!(result["region"].field_type, FieldType::String));
}

#[test]
fn auto_register_unknown_month() {
    let known: HashSet<String> = HashSet::new();
    let result =
        infer_field_defs(|k| known.contains(k), &[&raw(r#"{"captured": "2024-03"}"#)]).unwrap();
    assert!(matches!(result["captured"].field_type, FieldType::Month));
}

#[test]
fn auto_register_mixed() {
    let known: HashSet<String> = ["altitude"].iter().map(ToString::to_string).collect();
    let extra = raw(r#"{"altitude": 100, "countryCode": "US", "plumbus": 42}"#);
    let result = infer_field_defs(|k| known.contains(k), &[&extra]).unwrap();
    // altitude is already known → skipped
    assert!(!result.contains_key("altitude"));
    // countryCode is new but in known_field_def → gets label
    assert_eq!(result["countryCode"].label.as_deref(), Some("Country code"));
    // plumbus is unknown → inferred as Number, no label
    assert!(matches!(result["plumbus"].field_type, FieldType::Number));
    assert!(result["plumbus"].label.is_none());
}

#[test]
fn auto_register_deduplicates_across_extras() {
    let known: HashSet<String> = HashSet::new();
    let result = infer_field_defs(
        |k| known.contains(k),
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
    let by_value = |v: &str| values.iter().find(|fv| fv.value == v);
    assert!(by_value("gen1").is_some());
    assert!(by_value("tripod").is_some());
    assert!(by_value("trekker").is_some());
    assert_eq!(by_value("gen1").unwrap().label.as_deref(), Some("Gen 1"));
    // every offered value carries its own label
    assert!(values.iter().all(|v| v.label.is_some()));
}

#[test]
fn a_legacy_def_folds_its_labels_map_into_its_values() {
    let extra = MapExtra::from_json(
        r#"{"fields":{"cam":{"type":"enum","label":"Camera","values":["gen1","gen2"],"labels":{"gen1":"Gen 1"}}}}"#,
    );
    let values = extra.fields["cam"].values.clone().unwrap();
    assert_eq!(values.len(), 2);
    assert_eq!(values[0].value, "gen1");
    assert_eq!(values[1].value, "gen2");
    assert!(values[1].label.is_none(), "an unlabelled value stays bare");
    assert_eq!(values[0].label.as_deref(), Some("Gen 1"));
}

#[test]
fn infer_array() {
    assert!(matches!(
        infer_field_type(&serde_json::json!([1, 2, 3])),
        FieldType::Array
    ));
    assert!(matches!(
        infer_field_type(&serde_json::json!([])),
        FieldType::Array
    ));
}

#[test]
fn infer_object_and_null() {
    assert!(matches!(
        infer_field_type(&serde_json::json!({"a": 1})),
        FieldType::String
    ));
    assert!(matches!(
        infer_field_type(&serde_json::Value::Null),
        FieldType::String
    ));
}

#[test]
fn infer_month_wrong_dash_position_is_string() {
    assert!(matches!(
        infer_field_type(&serde_json::json!("2024/06")),
        FieldType::String
    ));
}

#[test]
fn infer_month_wrong_length_is_string() {
    assert!(matches!(
        infer_field_type(&serde_json::json!("202-06")),
        FieldType::String
    ));
    assert!(matches!(
        infer_field_type(&serde_json::json!("20244-06")),
        FieldType::String
    ));
}

#[test]
fn driving_direction_is_circular_360() {
    let def = known_field_def("drivingDirection").unwrap();
    assert!(matches!(def.field_type, FieldType::Number));
    assert!(matches!(
        def.comparison,
        Some(ComparisonType::Circular { period }) if period == 360.0
    ));
}

#[test]
fn coverage_dates_is_array() {
    assert!(matches!(
        known_field_def("coverageDates").unwrap().field_type,
        FieldType::Array
    ));
}

#[test]
fn uploader_name_is_string() {
    assert!(matches!(
        known_field_def("uploaderName").unwrap().field_type,
        FieldType::String
    ));
}

#[test]
fn timezone_is_enum_without_values() {
    let def = known_field_def("timezone").unwrap();
    assert!(matches!(def.field_type, FieldType::Enum));
    assert!(def.values.is_none());
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
    let result = infer_field_defs(
        |k| known.contains(k),
        &[&raw(r#"{"foo": 5}"#), &raw(r#"{"foo": "2024-01"}"#)],
    )
    .unwrap();
    assert!(matches!(result["foo"].field_type, FieldType::Number));
}

#[test]
fn auto_register_curated_beats_inference_for_string_value() {
    // altitude's curated def is Number even though the sample value here is a string.
    let known: HashSet<String> = HashSet::new();
    let result = infer_field_defs(
        |k| known.contains(k),
        &[&raw(r#"{"altitude": "not a number"}"#)],
    )
    .unwrap();
    assert!(matches!(result["altitude"].field_type, FieldType::Number));
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
    assert_eq!(first.id.raw(), SCRATCH_MAP_ID);
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
        listed
            .iter()
            .map(|m| m.id.raw().as_str())
            .collect::<Vec<_>>(),
        ["m1"]
    );
}

#[test]
fn deleting_the_scratch_map_leaves_other_maps_alone() {
    let conn = setup_real_db();
    scratch_map_row(&conn).unwrap();
    assert!(delete_map_data(&conn, &Id::new(SCRATCH_MAP_ID.into())).unwrap());
    // Nothing to drop on the next startup.
    assert!(!delete_map_data(&conn, &Id::new(SCRATCH_MAP_ID.into())).unwrap());
    assert_eq!(list_map_rows(&conn).unwrap().len(), 1);
}

#[test]
fn default_settings_json_round_trips_to_default() {
    let json = default_settings_json();
    let parsed: MapSettings = serde_json::from_str(&json).unwrap();
    let default = MapSettings::default();

    assert_eq!(
        parsed.preferences.point_along_road,
        default.preferences.point_along_road
    );
    assert_eq!(
        parsed.preferences.prefer_official,
        default.preferences.prefer_official
    );
    assert_eq!(
        parsed.preferences.prefer_higher_quality,
        default.preferences.prefer_higher_quality
    );
    assert_eq!(
        parsed.preferences.only_official,
        default.preferences.only_official
    );
    assert_eq!(
        parsed.preferences.default_pano_id,
        default.preferences.default_pano_id
    );
    assert_eq!(
        parsed.preferences.export_zoom,
        default.preferences.export_zoom
    );
    assert_eq!(
        parsed.preferences.export_unpanned,
        default.preferences.export_unpanned
    );
    assert_eq!(
        parsed.preferences.export_shape,
        default.preferences.export_shape
    );
    assert_eq!(
        parsed.preferences.enrich_metadata,
        default.preferences.enrich_metadata
    );
    assert!(parsed.preferences.prefer_direction.is_none());
    assert!(parsed.preferences.camera_types.is_none());
    assert!(parsed.preferences.search_radius.is_none());
    assert!(parsed.preferences.enrich_fields.is_none());
    assert!(parsed.key_bindings.is_empty());
    assert!(parsed.virtual_tags.is_empty());
    assert!(parsed.aliases.is_empty());
}

#[test]
fn a_database_is_sized_with_the_sidecars_its_writes_sit_in() {
    let dir = TempDir::new("mma_test_dbsize");
    let db = dir.join("mma.db");
    fs::write(&db, vec![0u8; 400]).unwrap();
    assert_eq!(sqlite_bytes(&db), 400);

    fs::write(dir.join("mma.db-wal"), vec![0u8; 90]).unwrap();
    fs::write(dir.join("mma.db-shm"), vec![0u8; 10]).unwrap();
    assert_eq!(sqlite_bytes(&db), 500);

    // A database that does not exist yet is not an error, it is nothing on disk.
    assert_eq!(sqlite_bytes(&dir.join("absent.db")), 0);
}

#[test]
fn location_data_is_sized_down_through_the_commit_folders() {
    let dir = TempDir::new("mma_test_arrowsize");
    assert_eq!(dir_bytes(&dir), 0);

    fs::write(dir.join("a.arrow"), vec![0u8; 128]).unwrap();
    fs::write(dir.join("a_delta.arrow"), vec![0u8; 32]).unwrap();
    let commits = dir.join("commits").join("a");
    fs::create_dir_all(&commits).unwrap();
    fs::write(commits.join("c1.arrow"), vec![0u8; 64]).unwrap();

    assert_eq!(dir_bytes(&dir), 224);
    assert_eq!(dir_bytes(&dir.join("absent")), 0);
}

#[test]
fn new_maps_start_from_the_saved_defaults_and_existing_maps_keep_theirs() {
    let conn = setup_real_db();
    conn.execute(
        "INSERT INTO map_defaults (id, preferences) VALUES (1, ?1)",
        [r#"{"pointAlongRoad":false}"#],
    )
    .unwrap();

    let created = create_map_row(&conn, "New", None).unwrap();
    let scratch = scratch_map_row(&conn).unwrap();
    let existing = conn
        .query_row("SELECT * FROM maps WHERE id = 'm1'", [], MapMeta::read)
        .unwrap();

    assert!(!created.settings.preferences.point_along_road);
    assert!(!scratch.settings.preferences.point_along_road);
    assert!(existing.settings.preferences.point_along_road);
}

#[test]
fn a_duplicate_is_an_independent_copy_without_the_originals_history() {
    let conn = setup_real_db();
    let settings = r##"{"pointAlongRoad":false,"aliases":{"A/B":1},"pluginData":{"vali":{"project":{"tag":"T"}}}}"##;
    conn.execute(
        "UPDATE maps SET description = 'about', folder = 'Europe', settings = ?1, extra = ?2,
             tags = ?3, labels = '[\"wip\"]', pending_added = 4 WHERE id = 'm1'",
        params![
            settings,
            r#"{"fields":{"altitude":{"type":"number","label":"Altitude","values":null,"comparison":null}}}"#,
            r##"{"1":{"name":"A","color":"#ff0000"}}"##
        ],
    )
    .unwrap();
    conn.execute_batch(
        "INSERT INTO commits (id, map_id, location_count, created_at) VALUES ('c1', 'm1', 2, 'now');
         INSERT INTO edit_entries (map_id, seq, stack, max_id, entry) VALUES ('m1', 0, 0, 0, x'90');
         INSERT INTO remote_mapping (provider, map_id, local_id, remote_id, hash) VALUES ('mm', 'm1', 1, 9, 'h');
         INSERT INTO sync_log (map_id, provider, started_at, entry) VALUES ('m1', 'mm', 0, '{}');
         INSERT INTO review_sessions (id, map_id, source_key, ordering, cursor_id, created_at, updated_at)
             VALUES ('r1', 'm1', 'k', '[]', 1, 'now', 'now');
         INSERT INTO seen (pano_id, lat, lng, heading, pitch, zoom, entered_at, map_id)
             VALUES ('p', 0, 0, 0, 0, 0, 0, 'm1');",
    )
    .unwrap();
    let locations: Vec<Location> = (1..=2)
        .map(|id| Location {
            id: Id::new(id),
            lat: f64::from(id),
            tags: tag_ids([1]),
            ..Location::default()
        })
        .collect();
    let dir = TempDir::new("mma_test_duplicate");
    let path = dir.join("copy.arrow");

    let copy = duplicate_map_row(
        &conn,
        &Id::new("m1".into()),
        None,
        &Id::new("copy".into()),
        "Real (copy)",
        &arrow::locations_to_batch(&locations),
        &path,
    )
    .unwrap();

    let source = conn
        .query_row("SELECT * FROM maps WHERE id = 'm1'", [], MapMeta::read)
        .unwrap();
    assert_eq!(copy.name, "Real (copy)");
    assert_eq!(copy.description, "about");
    assert_eq!(copy.folder.as_deref(), Some("Europe"));
    assert_eq!(copy.labels, vec!["wip"]);
    assert_eq!(
        serde_json::to_value(&copy.settings).unwrap(),
        serde_json::to_value(&source.settings).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&copy.extra).unwrap(),
        serde_json::to_value(&source.extra).unwrap()
    );
    assert_eq!(copy.tags.len(), 1);
    assert_eq!(copy.location_count, 2);
    assert_eq!(
        copy.pending.added, 0,
        "the copy's locations are its baseline"
    );
    let written = arrow::batch_to_locations(&arrow::read_arrow_ipc(&path).unwrap());
    assert_eq!(
        written.iter().map(|l| l.id).collect::<Vec<_>>(),
        loc_ids([1, 2])
    );
    assert_eq!(written[0].tags, tag_ids([1]));

    for table in [
        "commits",
        "edit_entries",
        "remote_mapping",
        "sync_log",
        "review_sessions",
        "seen",
    ] {
        let n: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE map_id = 'copy'"),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "{table} came along");
    }

    let mut copy_row = read_map_meta(&conn, &Id::new("copy".into())).unwrap();
    copy_row.name = "Renamed".into();
    copy_row.settings = MapSettings::default();
    storage::update_row::<MapMeta>(&conn, "maps", "copy", &copy_row).unwrap();
    let source = conn
        .query_row("SELECT * FROM maps WHERE id = 'm1'", [], MapMeta::read)
        .unwrap();
    assert_eq!(source.name, "Real");
    assert!(!source.settings.preferences.point_along_road);
}

#[test]
fn duplicating_a_missing_map_writes_nothing() {
    let conn = setup_real_db();
    let dir = TempDir::new("mma_test_duplicate_missing");
    let path = dir.join("copy.arrow");
    let empty = RecordBatch::new_empty(arrow::schema());
    assert!(duplicate_map_row(
        &conn,
        &Id::new("nope".into()),
        None,
        &Id::new("copy".into()),
        "x",
        &empty,
        &path
    )
    .is_err());
    assert!(!path.exists());
    let maps: i64 = conn
        .query_row("SELECT COUNT(*) FROM maps", [], |r| r.get(0))
        .unwrap();
    assert_eq!(maps, 1);
}

#[test]
fn tag_records_read_and_write_the_one_column_format() {
    let stored = r#"{"7":{"id":7,"name":"a","visible":true,"color":"red"},"x":{"name":"b"}}"#;
    let records: HashMap<Id<ValueRecord>, ValueRecord> =
        crate::io::records::decode(&mut serde_json::Deserializer::from_str(stored)).unwrap();
    assert_eq!(
        records,
        HashMap::from([(
            Id::new(7),
            ValueRecord {
                id: Id::new(7),
                name: Some("a".into()),
                extra: serde_json::Map::from_iter([("color".to_string(), "red".into())]),
                ..Default::default()
            }
        )])
    );
    let written = serde_json::to_value(&records).unwrap();
    assert_eq!(
        written,
        serde_json::json!({ "7": { "id": 7, "name": "a", "order": null, "color": "red" } })
    );
}

/// A manager with map `m1` open, its store seeded from the row as opening does.
fn open_m1(conn: &Connection) -> StoreManager {
    let mut store = engine::Store::new();
    let mut meta = read_map_meta(conn, &Id::new("m1".into())).unwrap();
    store.value_meta.insert(
        "tags".into(),
        engine::Tracked::new(std::mem::take(&mut meta.tags)),
    );
    store.meta = engine::Tracked::new(meta);
    let mut mgr = StoreManager::new();
    mgr.stores.insert(Id::new("m1".into()), store);
    mgr
}

fn name_on_disk(conn: &Connection) -> String {
    conn.query_row("SELECT name FROM maps WHERE id = 'm1'", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn an_open_maps_meta_lands_on_disk_only_through_the_save_path() {
    let conn = setup_real_db();
    let mut mgr = open_m1(&conn);
    let patch = Patch::<MapMeta> {
        id: Id::new("m1".into()),
        name: Some("Renamed".into()),
        ..Default::default()
    };
    update_map_meta(&mut mgr, &conn, patch).unwrap();

    assert_eq!(mgr.stores[&Id::new("m1".into())].map().name, "Renamed");
    assert_eq!(name_on_disk(&conn), "Real");
    let store = mgr.store_for_map(&Id::new("m1".into())).unwrap();
    assert_eq!(store.meta.name, "Renamed");
    let unsaved = store.unsaved().unwrap().expect("the row is owed to disk");

    let dir = TempDir::new("mma_test_meta_save_path");
    unsaved
        .write(&conn, &Id::new("m1".into()), &dir.join("m1_delta.arrow"))
        .unwrap();
    store.saved(&unsaved);
    assert_eq!(name_on_disk(&conn), "Renamed");
    assert!(store.unsaved().unwrap().is_none());
}

#[test]
fn an_open_maps_tags_and_field_definitions_save_with_its_row() {
    let conn = setup_real_db();
    let mut mgr = open_m1(&conn);
    let store = mgr.store_for_map(&Id::new("m1".into())).unwrap();
    let rec = ValueRecord {
        id: Id::new(1),
        name: Some("A".into()),
        ..Default::default()
    };
    store
        .value_meta
        .get_mut("tags")
        .unwrap()
        .edit()
        .insert(Id::new(1), rec);
    store
        .meta
        .edit()
        .extra
        .fields
        .insert("altitude".into(), known_field_def("altitude").unwrap());

    let unsaved = store.unsaved().unwrap().unwrap();
    let dir = TempDir::new("mma_test_meta_tags_save");
    unsaved
        .write(&conn, &Id::new("m1".into()), &dir.join("m1_delta.arrow"))
        .unwrap();
    store.saved(&unsaved);

    let row = read_map_meta(&conn, &Id::new("m1".into())).unwrap();
    assert_eq!(row.tags.len(), 1);
    assert!(row.extra.fields.contains_key("altitude"));
    assert!(store.unsaved().unwrap().is_none());
}

#[test]
fn an_open_maps_tags_cannot_be_patched_behind_their_values() {
    let conn = setup_real_db();
    let mut mgr = open_m1(&conn);
    let patch = Patch::<MapMeta> {
        id: Id::new("m1".into()),
        tags: Some(HashMap::new()),
        ..Default::default()
    };
    assert!(update_map_meta(&mut mgr, &conn, patch).is_err());
    assert!(mgr
        .store_for_map(&Id::new("m1".into()))
        .unwrap()
        .unsaved()
        .unwrap()
        .is_none());
}

#[test]
fn a_closed_maps_meta_is_written_directly() {
    let conn = setup_real_db();
    let mut mgr = StoreManager::new();
    let patch = Patch::<MapMeta> {
        id: Id::new("m1".into()),
        name: Some("Renamed".into()),
        ..Default::default()
    };
    update_map_meta(&mut mgr, &conn, patch).unwrap();
    assert_eq!(name_on_disk(&conn), "Renamed");
}

#[test]
fn a_settings_patch_changes_only_the_keys_it_names_on_open_and_closed_maps() {
    let conn = setup_real_db();
    let set = |patch: serde_json::Value| Patch::<MapMeta> {
        id: Id::new("m1".into()),
        settings: serde_json::from_value(patch).unwrap(),
        ..Default::default()
    };
    for mut mgr in [StoreManager::new(), open_m1(&conn)] {
        update_map_meta(
            &mut mgr,
            &conn,
            set(serde_json::json!({ "searchRadius": 50 })),
        )
        .unwrap();
        update_map_meta(
            &mut mgr,
            &conn,
            set(serde_json::json!({ "exportZoom": true })),
        )
        .unwrap();
        let settings = match mgr.store_for_map(&Id::new("m1".into())) {
            Ok(store) => store.meta.settings.clone(),
            Err(_) => {
                read_map_meta(&conn, &Id::new("m1".into()))
                    .unwrap()
                    .settings
            }
        };
        assert_eq!(settings.preferences.search_radius, Some(50));
        assert!(settings.preferences.export_zoom);
    }
}

#[test]
fn an_open_maps_field_definitions_ship_when_patched() {
    let conn = setup_real_db();
    let mut mgr = open_m1(&conn);
    let fields = HashMap::from([("altitude".to_string(), known_field_def("altitude").unwrap())]);
    let patch = Patch::<MapMeta> {
        id: Id::new("m1".into()),
        extra: Some(MapExtra {
            fields: fields.clone(),
        }),
        ..Default::default()
    };
    let before = mgr.store_for_map(&Id::new("m1".into())).unwrap().version;
    update_map_meta(&mut mgr, &conn, patch).unwrap();
    let store = mgr.store_for_map(&Id::new("m1".into())).unwrap();
    assert_eq!(store.meta.extra.fields, fields);
    assert!(store.version > before, "the change landed and shipped");
}

#[test]
fn a_duplicate_of_an_open_map_carries_its_unsaved_row() {
    let conn = setup_real_db();
    let mut mgr = open_m1(&conn);
    let patch = Patch::<MapMeta> {
        id: Id::new("m1".into()),
        description: Some("unsaved".into()),
        ..Default::default()
    };
    update_map_meta(&mut mgr, &conn, patch).unwrap();
    let dir = TempDir::new("mma_test_duplicate_live");
    let live = Some(mgr.store_for_map(&Id::new("m1".into())).unwrap().map());
    let empty = RecordBatch::new_empty(arrow::schema());
    let copy = duplicate_map_row(
        &conn,
        &Id::new("m1".into()),
        live,
        &Id::new("copy".into()),
        "Copy",
        &empty,
        &dir.join("c.arrow"),
    )
    .unwrap();
    assert_eq!(copy.name, "Copy");
    assert_eq!(copy.description, "unsaved");
}

#[test]
fn a_whole_row_as_a_patch_writes_every_column_back() {
    let conn = setup_real_db();
    let mut row = read_map_meta(&conn, &Id::new("m1".into())).unwrap();
    row.name = "Other".into();
    row.folder = Some("F".into());
    row.labels = vec!["x".into()];
    row.settings.plugin_data = HashMap::from([(
        "plugin".into(),
        HashMap::from([
            ("null".into(), serde_json::Value::Null),
            ("count".into(), serde_json::json!(2)),
        ]),
    )]);
    storage::update_row::<MapMeta>(&conn, "maps", "m1", &row).unwrap();
    let back = read_map_meta(&conn, &Id::new("m1".into())).unwrap();
    assert!(back == row);
}

#[test]
fn declared_map_schema_matches_migration_history() {
    let conn = setup_real_db();
    let mut query = conn.prepare("PRAGMA table_info(maps)").unwrap();
    let mut migrated: Vec<_> = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)? == 0,
                row.get::<_, i64>(5)? != 0,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let mut declared: Vec<_> = MapMeta::COLUMNS
        .iter()
        .map(|column| {
            (
                column.name.to_string(),
                column.sql_type.to_string(),
                column.nullable,
                column.primary_key,
                column.default.map(str::to_string),
            )
        })
        .collect();
    migrated.sort();
    declared.sort();
    assert_eq!(declared, migrated);
}

#[test]
fn a_stored_field_def_without_interned_reads_as_not_interned() {
    let stored = r#"{"type":"enum","label":"Camera","values":null,"comparison":null}"#;
    let def: FieldDef = serde_json::from_str(stored).unwrap();
    assert!(!def.interned);
    assert_eq!(def.builtin, None);
    assert_eq!(
        serde_json::to_string(&def).unwrap(),
        r#"{"type":"enum","label":"Camera","values":null,"comparison":null,"interned":false}"#
    );

    let interned = FieldDef {
        interned: true,
        ..def
    };
    let json = serde_json::to_string(&interned).unwrap();
    assert_eq!(
        json,
        r#"{"type":"enum","label":"Camera","values":null,"comparison":null,"interned":true}"#
    );
    assert_eq!(serde_json::from_str::<FieldDef>(&json).unwrap(), interned);
}

#[test]
fn a_builtins_physical_address_never_serializes_with_its_definition() {
    let tags = crate::selections::FieldRegistry::builtins()
        .get("tags")
        .unwrap();
    assert!(tags.builtin.is_some());
    assert_eq!(
        serde_json::to_value(tags).unwrap(),
        serde_json::json!({
            "type": "array",
            "label": "Tags",
            "values": null,
            "comparison": null,
            "interned": true,
        })
    );
}

#[test]
fn an_interned_map_field_is_refused_whether_the_map_is_open_or_not() {
    let conn = setup_real_db();
    let patch = || Patch::<MapMeta> {
        id: Id::new("m1".into()),
        extra: Some(MapExtra {
            fields: HashMap::from([(
                "plates".to_string(),
                FieldDef {
                    interned: true,
                    ..known_field_def("altitude").unwrap()
                },
            )]),
        }),
        ..Default::default()
    };
    let refused = |result: AppResult<Option<engine::MutationResult>>| {
        assert!(result
            .err()
            .unwrap()
            .0
            .contains("interned map fields are not supported yet"));
    };

    let mut mgr = open_m1(&conn);
    refused(update_map_meta(&mut mgr, &conn, patch()));
    let store = mgr.store_for_map(&Id::new("m1".into())).unwrap();
    assert!(!store.meta.extra.fields.contains_key("plates"));
    assert!(store.unsaved().unwrap().is_none());

    refused(update_map_meta(&mut StoreManager::new(), &conn, patch()));
    assert!(!read_map_meta(&conn, &Id::new("m1".into()))
        .unwrap()
        .extra
        .fields
        .contains_key("plates"));
}

#[test]
fn plugin_settings_patch_changes_only_named_keys_and_keeps_null_values() {
    let mut old = MapSettings::default();
    old.plugin_data.insert(
        "first".into(),
        HashMap::from([
            ("keep".into(), serde_json::json!(1)),
            ("remove".into(), serde_json::json!(2)),
        ]),
    );
    old.plugin_data.insert(
        "other".into(),
        HashMap::from([("keep".into(), serde_json::json!(true))]),
    );

    let mut new = old.clone();
    new.plugin_data
        .get_mut("first")
        .unwrap()
        .insert("nullable".into(), serde_json::Value::Null);
    new.plugin_data.get_mut("first").unwrap().remove("remove");
    new.plugin_data
        .get_mut("other")
        .unwrap()
        .insert("keep".into(), serde_json::json!(false));

    let wire = serde_json::json!({ "pluginData": {
        "first": { "put": {
            "nullable": { "set": null },
            "remove": { "remove": null }
        } },
        "other": { "put": { "keep": { "set": false } } }
    } });
    let decoded: <MapSettings as Patchable>::Patch = serde_json::from_value(wire).unwrap();
    assert_eq!(old.patched(&decoded), new);
    assert_eq!(old.patched(&MapSettings::between(&old, &new)), new);
}

#[test]
fn an_open_maps_view_uses_its_current_locations_and_owned_records() {
    let conn = setup_real_db();
    let mut mgr = open_m1(&conn);
    let store = mgr.store_for_map(&Id::new("m1".into())).unwrap();
    store.write(
        [mma_algebra::Op::Set(crate::test_util::loc(1, 1.0, 1.0))],
        &mut None,
        engine::Entry::default(),
    );
    let current = store.map();
    assert_eq!(current.location_count, 1);
    assert_eq!(current.pending.added, 1);
    assert_eq!(current.tags, **store.value_meta.get("tags").unwrap());
    assert_eq!(current.updated_at, store.meta.updated_at);
    let before = read_map_meta(&conn, &current.id).unwrap();
    assert_eq!(before.location_count, 0);
    assert_eq!(before.pending.added, 0);
    let dir = TempDir::new("mma_current_map_view");
    store
        .unsaved()
        .unwrap()
        .unwrap()
        .write(&conn, &current.id, &dir.join("delta.arrow"))
        .unwrap();
    let saved = read_map_meta(&conn, &current.id).unwrap();
    assert_eq!(saved.location_count, current.location_count);
    assert_eq!(saved.pending, current.pending);
    assert_eq!(saved.tags, current.tags);
}

#[test]
fn derived_optional_struct_fields_compose_their_generated_patches() {
    #[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize, mma_fields::Patch)]
    struct OptionalSettings {
        #[patch(merge)]
        settings: Option<MapSettings>,
    }
    let mut settings = MapSettings::default();
    settings.preferences.export_zoom = true;
    let before = OptionalSettings {
        settings: Some(settings),
    };
    let patch: Patch<OptionalSettings> = serde_json::from_value(serde_json::json!({
        "settings": { "searchRadius": 25 }
    }))
    .unwrap();
    let after = before.patched(&patch);
    let result = after.settings.as_ref().unwrap();
    assert!(result.preferences.export_zoom);
    assert_eq!(result.preferences.search_radius, Some(25));
    assert_eq!(
        before.patched(&OptionalSettings::between(&before, &after)),
        after
    );
    assert_eq!(
        after.patched(&OptionalSettings::between(&after, &before)),
        before
    );
    let absent = OptionalSettings::default();
    assert_eq!(
        absent
            .patched(&patch)
            .settings
            .unwrap()
            .preferences
            .search_radius,
        Some(25)
    );
    assert!(before
        .patched(&OptionalSettings::between(&before, &absent))
        .settings
        .is_none());
}
