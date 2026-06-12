use super::*;
use crate::location_store::Store;

fn tag(id: u32, name: &str) -> Tag {
    Tag { id, name: name.into(), color: "#000".into(), visible: true, order: None, count: 0 }
}

fn loc_with_tags(id: u32, tags: Vec<u32>) -> Location {
    Location {
        id, lat: 0.0, lng: 0.0, heading: 0.0, pitch: 0.0, zoom: 1.0,
        pano_id: None, flags: crate::types::LocationFlags::empty(), tags, extra: None,
        created_at: 0, modified_at: None,
    }
}

// -----------------------------------------------------------------------
// Tag reconciliation (shared core: location_store::reconcile_tags_by_name)
// Import-flavored coverage; the core's own tests live in location_store.test.rs.
// -----------------------------------------------------------------------

/// Run the core against a store's tag table, as add_parsed_to_store does.
fn reconcile(store: &mut Store, tags: &[Tag]) -> HashMap<u32, u32> {
    let t = &mut store.tags;
    location_store::reconcile_tags_by_name(tags, &mut t.all, &mut t.next_id)
}

fn store_with_tags(tags: &[Tag]) -> Store {
    let mut store = Store::new();
    store.map_id = Some("test".into());
    for t in tags {
        store.tags.all.insert(t.id, t.clone());
    }
    store.tags.next_id = store.tags.all.keys().max().copied().unwrap_or(0) + 1;
    store
}

#[test]
fn reconcile_reuses_existing_tag_by_name() {
    let mut store = store_with_tags(&[tag(5, "Urban")]);
    let remap = reconcile(&mut store, &[tag(1, "Urban")]);
    assert_eq!(remap[&1], 5, "import tag 1 should remap to existing tag 5");
    assert_eq!(store.tags.all.len(), 1, "no new tag created");
}

#[test]
fn reconcile_case_insensitive() {
    let mut store = store_with_tags(&[tag(5, "Urban")]);
    let remap = reconcile(&mut store, &[tag(1, "urban")]);
    assert_eq!(remap[&1], 5);
    assert_eq!(store.tags.all.len(), 1);
}

#[test]
fn reconcile_new_tag_gets_fresh_id() {
    let mut store = store_with_tags(&[]);
    let remap = reconcile(&mut store, &[tag(99, "Rural")]);
    assert_ne!(remap[&99], 99, "new tag should get a fresh ID from store");
    assert_eq!(store.tags.all[&remap[&99]].name, "Rural");
}

#[test]
fn reconcile_mixed_existing_and_new() {
    let mut store = store_with_tags(&[tag(10, "Urban")]);
    let remap = reconcile(&mut store, &[tag(1, "Urban"), tag(2, "Rural")]);
    assert_eq!(remap[&1], 10, "Urban remaps to existing");
    assert_eq!(store.tags.all.len(), 2, "only Rural created");
    assert_eq!(store.tags.all[&remap[&2]].name, "Rural");
}

#[test]
fn reconcile_no_existing_tags() {
    let mut store = store_with_tags(&[]);
    let remap = reconcile(&mut store, &[tag(1, "Alpha"), tag(2, "Beta")]);
    assert_eq!(remap.len(), 2);
    assert_eq!(store.tags.all.len(), 2, "both tags are new");
}

#[test]
fn reconcile_all_existing() {
    let mut store = store_with_tags(&[tag(5, "Alpha"), tag(6, "Beta")]);
    let remap = reconcile(&mut store, &[tag(1, "Alpha"), tag(2, "Beta")]);
    assert_eq!(remap[&1], 5);
    assert_eq!(remap[&2], 6);
    assert_eq!(store.tags.all.len(), 2, "all tags already exist");
}

#[test]
fn reconcile_duplicate_import_tags_dedup_against_each_other() {
    let mut store = store_with_tags(&[]);
    // Two import tags with same name but different IDs (shouldn't happen from parse_file,
    // but the core should handle it: second one reuses the first's allocated ID)
    let remap = reconcile(&mut store, &[tag(1, "Dup"), tag(2, "Dup")]);
    assert_eq!(remap[&1], remap[&2], "both import IDs remap to same new ID");
    assert_eq!(store.tags.all.len(), 1, "second duplicate not created");
}

#[test]
fn reconcile_location_tags_remapped_correctly() {
    let mut store = store_with_tags(&[tag(10, "Urban")]);
    let remap = reconcile(&mut store, &[tag(1, "Urban"), tag(2, "Rural")]);

    // Apply the remap to locations (same as add_parsed_to_store does)
    let mut loc = loc_with_tags(1, vec![1, 2]);
    loc.tags = loc.tags.iter().filter_map(|&old| remap.get(&old).copied()).collect();

    assert_eq!(loc.tags.len(), 2);
    assert!(loc.tags.contains(&10), "Urban should map to existing ID 10");
    assert!(loc.tags.contains(&remap[&2]), "Rural should map to new ID");
}

#[test]
fn extract_tag_meta_reads_color_and_order() {
    let json = br#"{"customCoordinates":[],"extra":{"tags":{"Roof":{"color":[255,0,0],"order":3},"Wall":{"color":[0,128,255],"order":1}}}}"#;
    let meta = extract_tag_meta(json);
    assert_eq!(meta.len(), 2);

    let roof = &meta["Roof"];
    assert_eq!(roof.color.as_deref(), Some("#ff0000"));
    assert_eq!(roof.order, Some(3));

    let wall = &meta["Wall"];
    assert_eq!(wall.color.as_deref(), Some("#0080ff"));
    assert_eq!(wall.order, Some(1));
}

#[test]
fn extract_tag_meta_missing_order() {
    let json = br#"{"extra":{"tags":{"NoOrder":{"color":[10,20,30]}}}}"#;
    let meta = extract_tag_meta(json);
    let tag = &meta["NoOrder"];
    assert_eq!(tag.color.as_deref(), Some("#0a141e"));
    assert_eq!(tag.order, None);
}

#[test]
fn extract_tag_meta_missing_color() {
    let json = br#"{"extra":{"tags":{"OnlyOrder":{"order":5}}}}"#;
    let meta = extract_tag_meta(json);
    let tag = &meta["OnlyOrder"];
    assert_eq!(tag.color, None);
    assert_eq!(tag.order, Some(5));
}

#[test]
fn extract_tag_meta_no_extra() {
    let json = br#"{"customCoordinates":[]}"#;
    let meta = extract_tag_meta(json);
    assert!(meta.is_empty());
}

#[test]
fn parsed_tags_sorted_by_order() {
    let json = br#"{"name":"test","customCoordinates":[
        {"lat":1,"lng":2,"extra":{"tags":["Beta","Alpha","Gamma"]}},
        {"lat":3,"lng":4,"extra":{"tags":["Alpha"]}}
    ],"extra":{"tags":{"Alpha":{"color":[255,0,0],"order":2},"Beta":{"color":[0,255,0],"order":0},"Gamma":{"color":[0,0,255],"order":1}}}}"#;
    let mut buf = json.to_vec();
    let parsed = parse_single_json_mut(&mut buf);
    assert_eq!(parsed.tags.len(), 3);
    assert_eq!(parsed.tags[0].name, "Beta");
    assert_eq!(parsed.tags[0].order, Some(0));
    assert_eq!(parsed.tags[1].name, "Gamma");
    assert_eq!(parsed.tags[1].order, Some(1));
    assert_eq!(parsed.tags[2].name, "Alpha");
    assert_eq!(parsed.tags[2].order, Some(2));
}

#[test]
fn staged_location_fetch_by_index() {
    let json = br#"{"name":"Pasted URLs","customCoordinates":[
        {"lat":10.5,"lng":20.5,"heading":90,"panoId":"abcdefghijklmnopqrstuv"},
        {"lat":-3.25,"lng":7.75}
    ]}"#;
    let mut buf = json.to_vec();
    let parsed = parse_single_json_mut(&mut buf);
    *EDITOR_IMPORT_CACHE.lock().unwrap() = Some(parsed);

    let first = store_import_staged_location(0).unwrap();
    assert_eq!(first.id, 0); // staged sentinel id
    assert_eq!(first.lat, 10.5);
    assert_eq!(first.heading, 90.0);
    assert_eq!(first.pano_id.as_deref(), Some("abcdefghijklmnopqrstuv"));

    let second = store_import_staged_location(1).unwrap();
    assert_eq!(second.lng, 7.75);

    assert!(store_import_staged_location(2).is_err());

    *EDITOR_IMPORT_CACHE.lock().unwrap() = None;
    assert!(store_import_staged_location(0).is_err());
}
