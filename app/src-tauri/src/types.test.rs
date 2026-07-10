use super::*;

// The delta sidecar / undo-blob field that actually hit the wire: Option<Option<RawExtra>>.
type ExtraField = Option<Option<RawExtra>>;

fn extra(json: &str) -> RawExtra {
    RawExtra(serde_json::value::RawValue::from_string(json.to_owned()).unwrap())
}

#[test]
fn binary_string_encoding_round_trips() {
    let field: ExtraField = Some(Some(extra(r#"{"a":1,"b":"x"}"#)));
    let bytes = rmp_serde::to_vec_named(&field).unwrap();
    let back: ExtraField = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(back.unwrap().unwrap().as_str(), r#"{"a":1,"b":"x"}"#);
}

#[test]
fn reads_legacy_map_encoded_blob() {
    // What pre-RawExtra shipped builds wrote: extra as a real msgpack map.
    let mut legacy = serde_json::Map::new();
    legacy.insert("a".into(), serde_json::json!(1));
    legacy.insert("b".into(), serde_json::json!("x"));
    let legacy_field: Option<Option<serde_json::Map<String, serde_json::Value>>> =
        Some(Some(legacy));
    let bytes = rmp_serde::to_vec_named(&legacy_field).unwrap();

    // The current reader must accept it, not fail with "expected a string".
    let back: ExtraField = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(
        back.unwrap().unwrap().to_map(),
        extra(r#"{"a":1,"b":"x"}"#).to_map()
    );
}

#[test]
fn get_scans_only_top_level_keys() {
    let e = extra(
        r#"{ "a" : 1, "nested": {"a": 99, "deep": [{"a": 5}]}, "arr": [1, 2], "s": "not:{\"a\":7}", "tz": "Asia/Tokyo" }"#,
    );
    assert_eq!(e.get("a"), Some(serde_json::json!(1)));
    assert_eq!(e.get("arr"), Some(serde_json::json!([1, 2])));
    assert_eq!(e.get("tz"), Some(serde_json::json!("Asia/Tokyo")));
    assert_eq!(e.get("s"), Some(serde_json::json!("not:{\"a\":7}")));
    assert_eq!(e.get("deep"), None); // exists only nested
    assert_eq!(e.get("missing"), None);
}

#[test]
fn get_handles_escapes_and_non_objects() {
    let e = extra(r#"{"q\"uote": 1, "b": "ends with \\", "c": true}"#);
    assert_eq!(e.get("b"), Some(serde_json::json!("ends with \\")));
    assert_eq!(e.get("c"), Some(serde_json::json!(true)));
    // Non-object extra (legacy passthrough): no fields to find.
    assert_eq!(extra(r#""just a string""#).get("a"), None);
}

#[test]
fn human_readable_json_round_trips_transparently() {
    let field: ExtraField = Some(Some(extra(r#"{"k":[1,2,3]}"#)));
    let json = serde_json::to_string(&field).unwrap();
    // Emitted inline as an object, not a quoted string.
    assert_eq!(json, r#"{"k":[1,2,3]}"#);
    let back: ExtraField = serde_json::from_str(&json).unwrap();
    assert_eq!(back.unwrap().unwrap().as_str(), r#"{"k":[1,2,3]}"#);
}
