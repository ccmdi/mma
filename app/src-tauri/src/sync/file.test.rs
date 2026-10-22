use super::*;
use crate::store::engine::ValueRecord;
use crate::sync::engine::{plan, ReconcileInput};
use crate::sync::remote_mapping::RemoteMappingRow;
use crate::sync::sync_hash;
use crate::types::{Location, RawExtra};
use mma_algebra::Id;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicU32, Ordering};

fn source(doc: &Value) -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let path = env::temp_dir().join(format!(
        "mma_file_source_{}_{}.json",
        process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&path, doc.to_string()).unwrap();
    path
}

fn coord(lat: f64, extra: &Value) -> Value {
    json!({ "lat": lat, "lng": 1.0, "heading": 0, "pitch": 0, "zoom": 0, "panoId": null, "extra": extra })
}

fn pull(path: &Path) -> Vec<NormalizedSyncLocation> {
    FileProvider.pull(path.to_str().unwrap()).unwrap().locations
}

#[test]
fn pull_reads_tags_by_name_and_custom_fields_without_nulls() {
    let path = source(&json!({
        "customCoordinates": [coord(10.0, &json!({ "tags": ["Rural"], "score": 3, "gone": null }))]
    }));
    let locs = pull(&path);
    assert_eq!(locs.len(), 1);
    assert_eq!(locs[0].tags, vec!["Rural".to_string()]);
    assert_eq!(
        locs[0].extra,
        json!({ "score": 3 }).as_object().cloned(),
        "tags leave extra, and a null field is an absent one"
    );
}

fn by_name<'a>(
    snap: &'a RemoteSnapshot<NormalizedSyncLocation>,
    field: &str,
    name: &str,
) -> &'a ValueRecord {
    snap.records[field]
        .values()
        .find(|r| r.name.as_deref() == Some(name))
        .unwrap()
}

#[test]
fn pull_carries_the_source_tag_catalog() {
    let path = source(&json!({
        "customCoordinates": [coord(1.0, &json!({ "tags": ["A", "B"] }))],
        "extra": { "tags": {
            "A": { "color": [255, 0, 0], "order": 2 },
            "B": { "color": [0, 255, 0], "order": 1 }
        } }
    }));
    let snap = FileProvider.pull(path.to_str().unwrap()).unwrap();
    assert_eq!(by_name(&snap, "tags", "A").color(), "#ff0000".parse().ok());
    assert_eq!(by_name(&snap, "tags", "A").order, Some(2));
    assert_eq!(by_name(&snap, "tags", "B").color(), "#00ff00".parse().ok());
    assert_eq!(by_name(&snap, "tags", "B").order, Some(1));
}

#[test]
fn pull_reads_a_plugin_fields_values_by_name_with_their_records() {
    let path = source(&json!({
        "customCoordinates": [coord(1.0, &json!({ "habitat": ["Wetland", "Forest"] }))],
        "extra": {
            "fields": { "habitat": { "type": "array", "interned": true } },
            "habitat": { "Wetland": { "color": [0, 255, 0], "icon": "reed" } }
        }
    }));
    let snap = FileProvider.pull(path.to_str().unwrap()).unwrap();
    assert_eq!(
        snap.locations[0].extra,
        json!({ "habitat": ["Wetland", "Forest"] })
            .as_object()
            .cloned()
    );
    assert_eq!(by_name(&snap, "habitat", "Wetland").extra["icon"], "reed");
}

#[test]
fn a_github_page_address_means_the_raw_file() {
    assert_eq!(
        resolved("https://github.com/o/r/blob/main/maps/a%20b.json"),
        "https://raw.githubusercontent.com/o/r/main/maps/a%20b.json"
    );
    assert_eq!(
        resolved("https://github.com/o/r/releases"),
        "https://github.com/o/r/releases"
    );
    assert_eq!(
        resolved("https://example.com/blob/x.json"),
        "https://example.com/blob/x.json"
    );
}

#[test]
fn a_web_page_answer_is_refused() {
    let path = env::temp_dir().join(format!("mma_file_source_{}_page.html", process::id()));
    fs::write(&path, "\n <!DOCTYPE html><html></html>").unwrap();
    let Err(err) = FileProvider.pull(path.to_str().unwrap()) else {
        panic!("a web page parsed as a map");
    };
    assert!(err.0.contains("web page"), "{}", err.0);
}

#[test]
fn a_source_that_holds_no_map_is_an_error() {
    let path = source(&json!({ "customCoordinates": "nope" }));
    assert!(FileProvider.pull(path.to_str().unwrap()).is_err());
}

#[test]
fn an_edited_custom_field_pulls_as_a_merge_patch() {
    let path = source(&json!({
        "customCoordinates": [coord(10.0, &json!({ "score": 3, "note": "a" }))]
    }));
    let first = plan(&ReconcileInput {
        provider: &FileProvider,
        local_locs: &[],
        remote: FileProvider.pull(path.to_str().unwrap()).unwrap(),
        mapping: &[],
        records: &HashMap::new(),
        first_sync: None,
        resolutions: &[],
    })
    .unwrap();
    let created = &first.pull_creates[0];
    assert_eq!(
        created.fields.extra,
        json!({ "score": 3, "note": "a" }).as_object().cloned()
    );

    let local = Location {
        id: Id::new(1),
        lat: created.fields.lat,
        lng: created.fields.lng,
        extra: created.fields.extra.as_ref().and_then(RawExtra::from_map),
        ..Location::default()
    };
    let mapping = [RemoteMappingRow {
        local_id: Id::new(1),
        remote_id: created.remote_id,
        hash: created.hash.clone(),
    }];

    fs::write(
        &path,
        json!({ "customCoordinates": [coord(10.0, &json!({ "score": 4 }))] }).to_string(),
    )
    .unwrap();
    let second = plan(&ReconcileInput {
        provider: &FileProvider,
        local_locs: &[local],
        remote: FileProvider.pull(path.to_str().unwrap()).unwrap(),
        mapping: &mapping,
        records: &HashMap::new(),
        first_sync: None,
        resolutions: &[],
    })
    .unwrap();
    assert_eq!(second.pull_updates.len(), 1);
    assert_eq!(
        second.pull_updates[0].patch.extra,
        json!({ "score": 4, "note": null })
            .as_object()
            .cloned()
            .map(mma_algebra::JsonWrite::Merge)
            .into()
    );
    assert!(second.push_batch.is_none());
}

#[test]
fn custom_field_key_order_is_not_a_difference() {
    let a = source(
        &json!({ "customCoordinates": [coord(1.0, &json!({ "x": 1, "y": { "p": 1, "q": 2 } }))] }),
    );
    let b = source(
        &json!({ "customCoordinates": [coord(1.0, &json!({ "y": { "q": 2, "p": 1 }, "x": 1 }))] }),
    );
    assert_eq!(sync_hash(&pull(&a)[0]), sync_hash(&pull(&b)[0]));
}
