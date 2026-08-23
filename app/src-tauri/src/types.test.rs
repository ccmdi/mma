use super::*;

// The delta sidecar / undo-blob field that actually hit the wire: Option<Option<RawExtra>>.
type ExtraField = Option<Option<RawExtra>>;

fn extra(json: &str) -> RawExtra {
    RawExtra::wrap(serde_json::value::RawValue::from_string(json.to_owned()).unwrap())
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

/// The field `café` with its key ASCII-escaped, as an ensure_ascii encoder writes it.
fn escaped_key_extra() -> String {
    let bs = '\\';
    format!("{{\"caf{bs}u00e9\":\"au lait\"}}")
}

// Keys are matched on raw bytes, so an escaped key has to be decoded at every ingest
// point or it silently matches nothing.
#[test]
fn escaped_keys_are_canonicalized_on_ingest() {
    let escaped = escaped_key_extra();

    let from_str = RawExtra::from_string(escaped.clone()).unwrap();
    assert_eq!(from_str.as_str(), "{\"café\":\"au lait\"}");
    assert_eq!(from_str.get("café"), Some(serde_json::json!("au lait")));

    // IPC / on-disk JSON.
    let ipc: RawExtra = serde_json::from_str(&escaped).unwrap();
    assert_eq!(ipc.get("café"), Some(serde_json::json!("au lait")));

    // Delta sidecar / undo blob (rmp string form).
    let field: ExtraField = Some(Some(extra(&escaped)));
    let bytes = rmp_serde::to_vec_named(&field).unwrap();
    let back: ExtraField = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(
        back.unwrap().unwrap().get("café"),
        Some(serde_json::json!("au lait"))
    );

    // Field discovery reports the decoded name, so it registers as one field.
    let mut keys: Vec<String> = Vec::new();
    from_str.for_each_field(|k, _| keys.push(k.to_owned()));
    assert_eq!(keys, vec!["café"]);
}

#[test]
fn canonicalization_leaves_everything_else_byte_identical() {
    // No escaped key -> the exact input bytes survive (values keep their escapes, and
    // the common path never pays a reserialize).
    for src in [
        r#"{"café":"noir","n":1.50,"s":"a\"b\\cé"}"#,
        r#"{"a":1,"b":[1,2]}"#,
    ] {
        assert_eq!(RawExtra::from_string(src.to_owned()).unwrap().as_str(), src);
    }
    // A key that JSON *requires* to be escaped keeps the escape (shortest legal form).
    let bs = '\\';
    let quoted = RawExtra::from_string(format!("{{\"a{bs}u0022b\":1}}")).unwrap();
    assert_eq!(quoted.as_str(), r#"{"a\"b":1}"#);
    assert_eq!(quoted.get("a\"b"), None); // still unmatchable by raw-byte compare
}

#[test]
fn decode_json_key_decodes_only_escapes() {
    let bs = '\\';
    assert_eq!(decode_json_key("plain"), "plain");
    assert_eq!(decode_json_key(&format!("caf{bs}u00e9")), "café");
    assert_eq!(decode_json_key(&format!("a{bs}\"b")), "a\"b");
    // Undecodable input is passed through rather than mangled.
    assert_eq!(decode_json_key(&format!("a{bs}zb")), format!("a{bs}zb"));
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

// -----------------------------------------------------------------------
// Property-based JSON round trip
// -----------------------------------------------------------------------

use proptest::prelude::*;

fn finite_f64() -> impl Strategy<Value = f64> {
    prop_oneof![
        1 => Just(0.0),
        1 => Just(-0.0),
        1 => Just(f64::MIN),
        1 => Just(f64::MAX),
        1 => Just(1.0 / 3.0),
        5 => -1.0e6f64..1.0e6,
    ]
}

fn arb_lat() -> impl Strategy<Value = f64> {
    prop_oneof![
        1 => Just(0.0),
        1 => Just(-0.0),
        1 => Just(90.0),
        1 => Just(-90.0),
        1 => Just(48.858_222_222_195_44),
        5 => -90.0f64..=90.0,
    ]
}

fn arb_lng() -> impl Strategy<Value = f64> {
    prop_oneof![
        1 => Just(0.0),
        1 => Just(-0.0),
        1 => Just(180.0),
        1 => Just(-180.0),
        1 => Just(2.352_222_222_195_44),
        5 => -180.0f64..=180.0,
    ]
}

fn arb_heading() -> impl Strategy<Value = f64> {
    prop_oneof![
        1 => Just(0.0),
        1 => Just(-0.0),
        1 => Just(360.0),
        1 => Just(123.456_789_012_3),
        5 => 0.0f64..=360.0,
    ]
}

fn arb_string() -> impl Strategy<Value = String> {
    prop_oneof![
        3 => "[a-zA-Z0-9_]{0,16}",
        2 => ".{0,12}",
        1 => Just(String::new()),
        1 => Just("caf\u{00e9}_\u{4e2d}\u{6587}_\u{1f600}".to_string()),
        1 => Just("\u{0000}\u{001f}".to_string()),
    ]
}

fn arb_pano_id() -> impl Strategy<Value = Option<String>> {
    prop_oneof![1 => Just(None), 3 => arb_string().prop_map(Some)]
}

fn arb_tags() -> impl Strategy<Value = Vec<u32>> {
    prop::collection::vec(any::<u32>(), 0..64)
}

fn arb_extra_map() -> impl Strategy<Value = serde_json::Map<String, serde_json::Value>> {
    prop::collection::vec((arb_string(), arb_string()), 1..5).prop_map(|pairs| {
        pairs
            .into_iter()
            .map(|(k, v)| (k, serde_json::Value::String(v)))
            .collect()
    })
}

fn arb_extra() -> impl Strategy<Value = Option<RawExtra>> {
    prop_oneof![
        1 => Just(None),
        3 => arb_extra_map().prop_map(|m| RawExtra::from_map(&m)),
    ]
}

fn arb_modified_at() -> impl Strategy<Value = Option<u32>> {
    prop_oneof![1 => Just(None), 3 => any::<u32>().prop_map(Some)]
}

fn arb_location() -> impl Strategy<Value = Location> {
    (
        any::<u32>(),
        arb_lat(),
        arb_lng(),
        arb_heading(),
        finite_f64(),
        finite_f64(),
        arb_pano_id(),
        any::<u32>().prop_map(LocationFlags::from_bits_retain),
        arb_tags(),
        arb_extra(),
        any::<u32>(),
        arb_modified_at(),
    )
        .prop_map(
            |(
                id,
                lat,
                lng,
                heading,
                pitch,
                zoom,
                pano_id,
                flags,
                tags,
                extra,
                created_at,
                modified_at,
            )| {
                Location {
                    id,
                    lat,
                    lng,
                    heading,
                    pitch,
                    zoom,
                    pano_id,
                    flags,
                    tags,
                    extra,
                    created_at,
                    modified_at,
                }
            },
        )
}

proptest! {
    #[test]
    fn prop_location_json_round_trip(loc in arb_location()) {
        let json = serde_json::to_string(&loc).unwrap();
        let back: Location = serde_json::from_str(&json).unwrap();
        prop_assert_eq!(loc, back);
    }

    #[test]
    fn prop_location_json_timestamps_are_numbers(loc in arb_location()) {
        let value = serde_json::to_value(&loc).unwrap();
        prop_assert!(value["createdAt"].is_number());
        if loc.modified_at.is_some() {
            prop_assert!(value["modifiedAt"].is_number());
        } else {
            prop_assert!(value["modifiedAt"].is_null());
        }
    }
}
