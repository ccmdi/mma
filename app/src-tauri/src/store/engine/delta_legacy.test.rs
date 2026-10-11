use super::*;
use crate::test_util::{loc, TempDir};
use crate::types::RawExtra;
use mma_algebra::Id;
use std::collections::HashMap;
use std::fs;

type ExtraField = mma_algebra::Field<RawExtra>;

fn extra(json: &str) -> RawExtra {
    RawExtra::from_string_uncanonicalized(json).unwrap()
}

fn write_msgpack(path: &Path, delta: &MsgpackDelta) {
    fs::write(path, rmp_serde::to_vec_named(delta).unwrap()).unwrap();
}

fn reload(path: &Path) -> Overlay {
    Overlay::from_delta(&arrow::read_arrow_ipc(path).unwrap())
}

#[test]
fn a_msgpack_sidecar_converts_to_an_arrow_delta_that_reloads_to_the_same_overlay() {
    let dir = TempDir::new("mma_test_delta_legacy_convert");
    let base_path = dir.join("m.arrow");
    let delta_path = dir.join("m_delta.arrow");
    arrow::write_arrow_ipc(
        &base_path,
        &arrow::locations_to_batch(&[loc(1, 1.0, 1.0), loc(2, 2.0, 2.0), loc(3, 3.0, 3.0)]),
    )
    .unwrap();
    let mut patched = loc(1, 5.0, 5.0);
    patched.extra = Some(extra(r#"{"k":"v"}"#));
    write_msgpack(
        &delta_path,
        &MsgpackDelta {
            adds: vec![loc(11, 11.0, 11.0), loc(10, 10.0, 10.0)],
            dead_ids: vec![Id::new(2), Id::new(12)],
            patches: vec![patched.clone()],
        },
    );

    assert!(!convert_msgpack_delta(&delta_path, &base_path).unwrap());

    assert!(is_arrow(&delta_path));
    assert_eq!(
        reload(&delta_path),
        Overlay {
            adds: vec![loc(10, 10.0, 10.0), loc(11, 11.0, 11.0)],
            dead: [2].into_iter().map(Id::new).collect(),
            patches: HashMap::from([(Id::new(1), patched)]),
        },
        "id 12 was added then removed, so no base row stands behind it"
    );
}

#[test]
fn a_msgpack_sidecar_of_a_map_with_no_base_converts_to_its_adds() {
    let dir = TempDir::new("mma_test_delta_legacy_no_base");
    let delta_path = dir.join("m_delta.arrow");
    write_msgpack(
        &delta_path,
        &MsgpackDelta {
            adds: vec![loc(1, 1.0, 1.0), loc(2, 2.0, 2.0)],
            dead_ids: vec![Id::new(3)],
            patches: vec![],
        },
    );

    assert!(!convert_msgpack_delta(&delta_path, &dir.join("m.arrow")).unwrap());

    assert_eq!(
        reload(&delta_path),
        Overlay {
            adds: vec![loc(1, 1.0, 1.0), loc(2, 2.0, 2.0)],
            ..Overlay::default()
        }
    );
}

#[test]
fn an_unreadable_sidecar_is_set_aside_as_corrupt() {
    let dir = TempDir::new("mma_test_delta_legacy_corrupt");
    let delta_path = dir.join("m_delta.arrow");
    fs::write(&delta_path, b"definitely not msgpack").unwrap();

    assert!(convert_msgpack_delta(&delta_path, &dir.join("m.arrow")).unwrap());

    assert!(!delta_path.exists());
    assert_eq!(
        fs::read(dir.join("m_delta.corrupt")).unwrap(),
        b"definitely not msgpack"
    );
}

#[test]
fn a_sidecar_whose_base_does_not_read_is_left_in_place_and_fails_the_conversion() {
    let dir = TempDir::new("mma_test_delta_legacy_bad_base");
    let base_path = dir.join("m.arrow");
    let delta_path = dir.join("m_delta.arrow");
    fs::write(&base_path, b"not an arrow file").unwrap();
    write_msgpack(
        &delta_path,
        &MsgpackDelta {
            adds: vec![loc(10, 10.0, 10.0)],
            dead_ids: vec![],
            patches: vec![],
        },
    );
    let before = fs::read(&delta_path).unwrap();

    assert!(convert_msgpack_delta(&delta_path, &base_path).is_err());

    assert_eq!(fs::read(&delta_path).unwrap(), before);
    assert!(!dir.join("m_delta.corrupt").exists());
}

#[test]
fn an_arrow_sidecar_is_left_untouched() {
    let dir = TempDir::new("mma_test_delta_legacy_arrow");
    let delta_path = dir.join("m_delta.arrow");
    arrow::write_arrow_ipc(
        &delta_path,
        &arrow::delta_to_batch(&[loc(4, 4.0, 4.0)], &[loc(1, 1.0, 1.0)]),
    )
    .unwrap();
    let before = fs::read(&delta_path).unwrap();

    assert!(!convert_msgpack_delta(&delta_path, &dir.join("m.arrow")).unwrap());

    assert_eq!(fs::read(&delta_path).unwrap(), before);
    assert!(!dir.join("m_delta.corrupt").exists());
}

#[test]
fn a_missing_sidecar_stays_missing() {
    let dir = TempDir::new("mma_test_delta_legacy_missing");
    let delta_path = dir.join("m_delta.arrow");

    assert!(!convert_msgpack_delta(&delta_path, &dir.join("m.arrow")).unwrap());

    assert!(!delta_path.exists());
    assert!(!dir.join("m_delta.corrupt").exists());
}

#[test]
fn binary_string_encoding_round_trips() {
    let field: ExtraField = mma_algebra::Field::Set(extra(r#"{"a":1,"b":"x"}"#));
    let bytes = rmp_serde::to_vec_named(&field).unwrap();
    let mma_algebra::Field::Set(back) = rmp_serde::from_slice::<ExtraField>(&bytes).unwrap() else {
        panic!("the extra round-trips as a value");
    };
    assert_eq!(back.as_str(), r#"{"a":1,"b":"x"}"#);
}

#[test]
fn reads_legacy_map_encoded_extra() {
    let mut legacy = serde_json::Map::new();
    legacy.insert("a".into(), serde_json::json!(1));
    legacy.insert("b".into(), serde_json::json!("x"));
    let legacy_field: Option<Option<serde_json::Map<String, serde_json::Value>>> =
        Some(Some(legacy));
    let bytes = rmp_serde::to_vec_named(&legacy_field).unwrap();

    let mma_algebra::Field::Set(back) = rmp_serde::from_slice::<ExtraField>(&bytes).unwrap() else {
        panic!("the extra round-trips as a value");
    };
    assert_eq!(back.to_map(), extra(r#"{"a":1,"b":"x"}"#).to_map());
}

#[test]
fn escaped_keys_in_the_binary_string_form_are_canonicalized() {
    let bs = '\\';
    let escaped = format!("{{\"caf{bs}u00e9\":\"au lait\"}}");
    let field: ExtraField = mma_algebra::Field::Set(extra(&escaped));
    let bytes = rmp_serde::to_vec_named(&field).unwrap();
    let mma_algebra::Field::Set(back) = rmp_serde::from_slice::<ExtraField>(&bytes).unwrap() else {
        panic!("the extra round-trips as a value");
    };
    assert_eq!(back.get("café"), Some(serde_json::json!("au lait")));
}
