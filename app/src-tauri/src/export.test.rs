use super::*;
use serde_json::json;

fn make_loc(
    flags: LocationFlags,
    tags: Vec<u32>,
    extra: Option<serde_json::Map<String, serde_json::Value>>,
) -> crate::types::Location {
    crate::types::Location {
        id: 1,
        lat: 10.0,
        lng: 20.0,
        heading: 0.0,
        pitch: 5.0,
        zoom: 3.0,
        pano_id: Some("PANO".into()),
        flags,
        tags,
        extra: extra.as_ref().and_then(crate::types::RawExtra::from_map),
        created_at: 0,
        modified_at: None,
    }
}

#[test]
fn hex_to_rgb_with_hash() {
    assert_eq!(hex_to_rgb("#ff8800"), Some([255, 136, 0]));
}

#[test]
fn hex_to_rgb_without_hash() {
    assert_eq!(hex_to_rgb("00ff00"), Some([0, 255, 0]));
}

#[test]
fn hex_to_rgb_black() {
    assert_eq!(hex_to_rgb("#000000"), Some([0, 0, 0]));
}

#[test]
fn hex_to_rgb_white() {
    assert_eq!(hex_to_rgb("#ffffff"), Some([255, 255, 255]));
}

#[test]
fn hex_to_rgb_invalid_length() {
    assert_eq!(hex_to_rgb("#fff"), None);
    assert_eq!(hex_to_rgb(""), None);
}

#[test]
fn hex_to_rgb_invalid_chars() {
    assert_eq!(hex_to_rgb("#gggggg"), None);
}

#[test]
fn coord_hoists_country_state_and_nests_other_extra() {
    let mut extra = serde_json::Map::new();
    extra.insert("countryCode".into(), json!("US"));
    extra.insert("stateCode".into(), json!("CA"));
    extra.insert("note".into(), json!("hi"));
    let l = make_loc(LocationFlags::empty(), vec![1, 99], Some(extra));
    let id_to_name = std::collections::HashMap::from([(1u32, "red".to_string())]);
    let co = CoordOpts { export_zoom: false, export_unpanned: true, export_extras: true };
    let v = location_to_coord(&l, &id_to_name, &co);

    assert_eq!(v["heading"], json!(0.001)); // unpanned convention
    assert_eq!(v["zoom"], json!(0.0)); // gated off
    assert_eq!(v["panoId"], serde_json::Value::Null); // not pinned
    assert_eq!(v["countryCode"], json!("US")); // hoisted to top level
    assert_eq!(v["stateCode"], json!("CA"));
    assert_eq!(v["extra"]["note"], json!("hi")); // other extra fields nest
    assert!(v["extra"].get("countryCode").is_none()); // not duplicated into extra
    assert_eq!(v["extra"]["tags"], json!(["red", "99"])); // unknown id -> stringified
    assert_eq!(v["extra"]["panoId"], json!("PANO"));
}

#[test]
fn coord_keeps_zoom_and_pano_when_pinned() {
    let mut extra = serde_json::Map::new();
    extra.insert("note".into(), json!("hi"));
    let l = make_loc(LocationFlags::LOAD_AS_PANO_ID, vec![1], Some(extra));
    let id_to_name = std::collections::HashMap::from([(1u32, "red".to_string())]);
    let co = CoordOpts { export_zoom: true, export_unpanned: false, export_extras: true };
    let v = location_to_coord(&l, &id_to_name, &co);

    assert_eq!(v["note"], serde_json::Value::Null); // NOT spread at top level
    assert_eq!(v["extra"]["note"], json!("hi")); // nested instead
    assert_eq!(v["zoom"], json!(3.0)); // exported
    assert_eq!(v["heading"], json!(0.0)); // no unpanned convention
    assert_eq!(v["panoId"], json!("PANO")); // pinned
    assert_eq!(v["extra"]["tags"], json!(["red"]));
    assert!(v["extra"].get("panoId").is_none()); // pinned -> no panoId in extra
}

#[test]
fn unknown_tag_id_falls_back_to_stringified_id() {
    let l = make_loc(LocationFlags::empty(), vec![7], None);
    let id_to_name = std::collections::HashMap::new();
    let co = CoordOpts { export_zoom: true, export_unpanned: false, export_extras: true };
    let v = location_to_coord(&l, &id_to_name, &co);
    assert_eq!(v["extra"]["tags"], json!(["7"]));
}

#[test]
fn tag_meta_roundtrips_color_and_order() {
    let (tag_defs, _) = parse_tag_defs(
        r##"{"1": {"name": "red", "color": "#ff0000", "order": 3}, "2": {"name": "blue", "color": "#0000ff"}}"##,
    );
    let meta = tag_color_meta(&tag_defs);
    assert_eq!(meta["red"]["color"], serde_json::json!([255, 0, 0]));
    assert_eq!(meta["red"]["order"], serde_json::json!(3));
    assert_eq!(meta["blue"]["color"], serde_json::json!([0, 0, 255]));
    assert!(meta["blue"].get("order").is_none());
}
