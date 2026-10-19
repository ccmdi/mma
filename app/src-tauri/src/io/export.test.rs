#![allow(clippy::needless_pass_by_value)]
use super::*;
use crate::test_util::tag_ids;
use crate::types::{Location, RawExtra};
use mma_algebra::Id;
use serde_json::json;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::fs::File;
use std::future::Future;
use std::path::PathBuf;

fn tags_named(names: &[(u32, &str)]) -> IncomingRecords {
    IncomingRecords::from([(
        "tags".to_string(),
        names
            .iter()
            .map(|&(id, name)| {
                let record = ValueRecord {
                    id: Id::new(id),
                    name: Some(name.into()),
                    ..Default::default()
                };
                (Id::new(id), record)
            })
            .collect(),
    )])
}

fn record(name: &str, order: Option<u32>, extra: serde_json::Value) -> ValueRecord {
    ValueRecord {
        id: Id::new(1),
        name: Some(name.into()),
        order,
        extra: extra.as_object().cloned().unwrap_or_default(),
    }
}

fn make_loc(
    flags: LocationFlags,
    tags: Vec<u32>,
    extra: Option<serde_json::Map<String, serde_json::Value>>,
) -> Location {
    Location {
        id: Id::new(1),
        lat: 10.0,
        lng: 20.0,
        pitch: 5.0,
        zoom: 3.0,
        pano_id: Some("PANO".into()),
        flags,
        tags: tag_ids(tags),
        extra: extra.as_ref().and_then(RawExtra::from_map),
        ..Default::default()
    }
}

#[test]
fn coord_hoists_country_state_and_nests_other_extra() {
    let mut extra = serde_json::Map::new();
    extra.insert("countryCode".into(), json!("US"));
    extra.insert("stateCode".into(), json!("CA"));
    extra.insert("note".into(), json!("hi"));
    let l = make_loc(LocationFlags::empty(), vec![1, 99], Some(extra));
    let records = tags_named(&[(1, "red")]);
    let co = CoordOpts {
        export_zoom: false,
        export_unpanned: true,
        shape: MapShape::Local,
    };
    let v = location_to_coord(&l, &records, &co);

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
    let records = tags_named(&[(1, "red")]);
    let co = CoordOpts {
        export_zoom: true,
        export_unpanned: false,
        shape: MapShape::Local,
    };
    let v = location_to_coord(&l, &records, &co);

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
    let records = IncomingRecords::new();
    let co = CoordOpts {
        export_zoom: true,
        export_unpanned: false,
        shape: MapShape::Local,
    };
    let v = location_to_coord(&l, &records, &co);
    assert_eq!(v["extra"]["tags"], json!(["7"]));
}

#[test]
fn record_meta_writes_color_as_rgb_and_order() {
    let red = record("red", Some(3), json!({ "color": "#ff0000" }));
    assert_eq!(
        record_meta(&red, MapShape::Local),
        json!({ "color": [255, 0, 0], "order": 3 })
    );
    let blue = record("blue", None, json!({ "color": "#0000ff" }));
    assert_eq!(
        record_meta(&blue, MapShape::Local),
        json!({ "color": [0, 0, 255] })
    );
}

#[test]
fn record_meta_keeps_every_other_key_only_with_app_data() {
    let antenna = record(
        "antenna",
        Some(2),
        json!({ "color": "#ff0000", "aliases": ["pole"], "icon": "mast" }),
    );
    assert_eq!(
        record_meta(&antenna, MapShape::Local),
        json!({
            "color": [255, 0, 0],
            "order": 2,
            "aliases": ["pole"],
            "icon": "mast"
        })
    );
    assert_eq!(
        record_meta(&antenna, MapShape::MapMaking),
        json!({ "color": [255, 0, 0], "order": 2 })
    );
}

#[test]
fn record_meta_keeps_a_value_without_a_color() {
    let plain = record("plain", Some(2), json!({ "icon": "dot" }));
    assert_eq!(
        record_meta(&plain, MapShape::Local),
        json!({"order": 2, "icon": "dot"})
    );
}

#[test]
fn rows_spell_every_interned_field_by_name() {
    let mut extra = serde_json::Map::new();
    extra.insert("habitat".into(), json!([2, 9]));
    extra.insert("score".into(), json!([2, 9]));
    let l = make_loc(LocationFlags::empty(), vec![], Some(extra));
    let records = IncomingRecords::from([(
        "habitat".to_string(),
        HashMap::from([(Id::new(2), record("Forest", None, json!({})))]),
    )]);
    let co = CoordOpts {
        export_zoom: true,
        export_unpanned: false,
        shape: MapShape::Local,
    };
    let v = location_to_coord(&l, &records, &co);
    assert_eq!(v["extra"]["habitat"], json!(["Forest", "9"]));
    assert_eq!(
        v["extra"]["score"],
        json!([2, 9]),
        "a field that interns nothing keeps its values"
    );
}

#[test]
fn upload_session_dir_rejects_outside_paths() {
    assert!(upload_session_dir("C:/somewhere/mma_upload_1_1").is_err());
    let not_pano = env::temp_dir().join("other_dir");
    assert!(upload_session_dir(&not_pano.to_string_lossy()).is_err());
    let nested = env::temp_dir().join("nested").join("mma_upload_1_1");
    assert!(upload_session_dir(&nested.to_string_lossy()).is_err());
}

#[test]
fn only_files_directly_inside_a_session_count_as_uploads() {
    assert!(!is_upload_file(Path::new("C:/Users/x/Pictures/photo.png")));
    assert!(!is_upload_file(Path::new("/etc/passwd")));
    assert!(!is_upload_file(
        &env::temp_dir().join("not_a_session").join("a.png")
    ));
    assert!(is_upload_file(
        &env::temp_dir().join("mma_upload_1_1").join("a.png")
    ));
}

#[test]
fn upload_session_begin_finish_multiple_zips_stored() {
    let session = store_upload_begin().unwrap();
    let dir = PathBuf::from(&session);
    assert!(dir.is_dir());
    assert!(upload_session_dir(&session).is_ok());

    fs::write(dir.join("1.jpg"), b"aaa").unwrap();
    fs::write(dir.join("2.jpg"), b"bbbb").unwrap();

    let out = store_upload_finish(session).unwrap();
    assert!(out.ends_with(".zip"));
    assert!(!dir.exists(), "session dir removed after finish");

    let file = File::open(&out).unwrap();
    let mut zip = zip::ZipArchive::new(file).unwrap();
    let names: Vec<String> = (0..zip.len())
        .map(|i| zip.by_index(i).unwrap().name().to_string())
        .collect();
    assert_eq!(names, vec!["1.jpg", "2.jpg"]);
    {
        use std::io::Read;
        let mut entry = zip.by_name("2.jpg").unwrap();
        assert_eq!(entry.compression(), zip::CompressionMethod::Stored);
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).unwrap();
        assert_eq!(buf, b"bbbb");
    }
    let _ = fs::remove_file(&out);
}

#[test]
fn upload_session_finish_single_file_passes_through() {
    let session = store_upload_begin().unwrap();
    let dir = PathBuf::from(&session);
    fs::write(dir.join("42.png"), b"img").unwrap();

    let out = store_upload_finish(session).unwrap();
    assert!(out.ends_with(".png"));
    assert!(!dir.exists());
    assert_eq!(fs::read(&out).unwrap(), b"img");
    let _ = fs::remove_file(&out);
}

#[test]
fn upload_session_finish_empty_errors_and_cleans_up() {
    let session = store_upload_begin().unwrap();
    let dir = PathBuf::from(&session);
    assert!(store_upload_finish(session).is_err());
    assert!(!dir.exists());
}

#[test]
fn upload_session_abort_removes_dir() {
    let session = store_upload_begin().unwrap();
    let dir = PathBuf::from(&session);
    fs::write(dir.join("1.jpg"), b"x").unwrap();
    store_upload_abort(session).unwrap();
    assert!(!dir.exists());
}

#[test]
fn exports_are_spawned_off_the_main_thread() {
    fn export(
        state: tauri::State<'_, StoreState>,
        selector: Selector<SelectionInput>,
        format: ExportFormat,
    ) -> impl Future<Output = AppResult<String>> + '_ {
        store_export(WindowLabel("w".into()), state, selector, format)
    }
    let _ = export;
}
