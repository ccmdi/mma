use super::*;
use crate::location_store::Store;

fn tag(id: u32, name: &str) -> Tag {
    Tag { id, name: name.into(), color: "#000".into(), visible: true, order: None, count: 0 }
}

fn make_parsed(tags: Vec<Tag>, locations: Vec<Location>) -> ParsedMap {
    ParsedMap {
        name: "test".into(),
        folder: None,
        locations,
        tags,
        fields: None,
        warnings: vec![],
    }
}

fn loc_with_tags(id: u32, tags: Vec<u32>) -> Location {
    Location {
        id, lat: 0.0, lng: 0.0, heading: 0.0, pitch: 0.0, zoom: 1.0,
        pano_id: None, flags: 0, tags, extra: None,
        created_at: String::new(), modified_at: None,
    }
}

// -----------------------------------------------------------------------
// Tag reconciliation (reconcile_tags)
// -----------------------------------------------------------------------

#[test]
fn reconcile_reuses_existing_tag_by_name() {
    let mut store = Store::new();
    store.map_id = Some("test".into());
    let existing: HashMap<u32, Tag> = [(5, tag(5, "Urban"))].into();
    let mut parsed = make_parsed(vec![tag(1, "Urban")], vec![loc_with_tags(1, vec![1])]);

    let remap = reconcile_tags(&mut store, &mut parsed, &existing);

    assert!(parsed.tags.is_empty(), "existing tag should be removed from parsed.tags");
    assert_eq!(remap[&1], 5, "import tag 1 should remap to existing tag 5");
}

#[test]
fn reconcile_case_insensitive() {
    let mut store = Store::new();
    store.map_id = Some("test".into());
    let existing: HashMap<u32, Tag> = [(5, tag(5, "Urban"))].into();
    let mut parsed = make_parsed(vec![tag(1, "urban")], vec![loc_with_tags(1, vec![1])]);

    let remap = reconcile_tags(&mut store, &mut parsed, &existing);

    assert!(parsed.tags.is_empty());
    assert_eq!(remap[&1], 5);
}

#[test]
fn reconcile_new_tag_gets_fresh_id() {
    let mut store = Store::new();
    store.map_id = Some("test".into());
    let existing: HashMap<u32, Tag> = HashMap::new();
    let mut parsed = make_parsed(vec![tag(99, "Rural")], vec![loc_with_tags(1, vec![99])]);

    let remap = reconcile_tags(&mut store, &mut parsed, &existing);

    assert_eq!(parsed.tags.len(), 1, "new tag should remain in parsed.tags");
    assert_ne!(parsed.tags[0].id, 99, "new tag should get a fresh ID from store");
    assert_eq!(remap[&99], parsed.tags[0].id);
}

#[test]
fn reconcile_mixed_existing_and_new() {
    let mut store = Store::new();
    store.map_id = Some("test".into());
    let existing: HashMap<u32, Tag> = [(10, tag(10, "Urban"))].into();
    let mut parsed = make_parsed(
        vec![tag(1, "Urban"), tag(2, "Rural")],
        vec![loc_with_tags(1, vec![1, 2])],
    );

    let remap = reconcile_tags(&mut store, &mut parsed, &existing);

    assert_eq!(parsed.tags.len(), 1, "only new tag should remain");
    assert_eq!(parsed.tags[0].name, "Rural");
    assert_eq!(remap[&1], 10, "Urban remaps to existing");
    assert_eq!(remap[&2], parsed.tags[0].id, "Rural remaps to new ID");
}

#[test]
fn reconcile_no_existing_tags() {
    let mut store = Store::new();
    store.map_id = Some("test".into());
    let existing: HashMap<u32, Tag> = HashMap::new();
    let mut parsed = make_parsed(
        vec![tag(1, "Alpha"), tag(2, "Beta")],
        vec![loc_with_tags(1, vec![1, 2])],
    );

    let remap = reconcile_tags(&mut store, &mut parsed, &existing);

    assert_eq!(parsed.tags.len(), 2, "both tags are new");
    assert_eq!(remap.len(), 2);
}

#[test]
fn reconcile_all_existing() {
    let mut store = Store::new();
    store.map_id = Some("test".into());
    let existing: HashMap<u32, Tag> = [
        (5, tag(5, "Alpha")),
        (6, tag(6, "Beta")),
    ].into();
    let mut parsed = make_parsed(
        vec![tag(1, "Alpha"), tag(2, "Beta")],
        vec![loc_with_tags(1, vec![1, 2])],
    );

    let remap = reconcile_tags(&mut store, &mut parsed, &existing);

    assert!(parsed.tags.is_empty(), "all tags already exist");
    assert_eq!(remap[&1], 5);
    assert_eq!(remap[&2], 6);
}

#[test]
fn reconcile_duplicate_import_tags_dedup_against_each_other() {
    let mut store = Store::new();
    store.map_id = Some("test".into());
    let existing: HashMap<u32, Tag> = HashMap::new();
    // Two import tags with same name but different IDs (shouldn't happen from parse_file,
    // but reconcile_tags should handle it: second one reuses the first's allocated ID)
    let mut parsed = make_parsed(
        vec![tag(1, "Dup"), tag(2, "Dup")],
        vec![loc_with_tags(1, vec![1]), loc_with_tags(2, vec![2])],
    );

    let remap = reconcile_tags(&mut store, &mut parsed, &existing);

    assert_eq!(parsed.tags.len(), 1, "second duplicate removed");
    assert_eq!(remap[&1], remap[&2], "both import IDs remap to same new ID");
}

#[test]
fn reconcile_location_tags_remapped_correctly() {
    let mut store = Store::new();
    store.map_id = Some("test".into());
    let existing: HashMap<u32, Tag> = [(10, tag(10, "Urban"))].into();
    let mut parsed = make_parsed(
        vec![tag(1, "Urban"), tag(2, "Rural")],
        vec![loc_with_tags(1, vec![1, 2])],
    );

    let remap = reconcile_tags(&mut store, &mut parsed, &existing);

    // Apply the remap to locations (same as add_parsed_to_store does)
    for loc in &mut parsed.locations {
        loc.tags = loc.tags.iter().filter_map(|&old| remap.get(&old).copied()).collect();
    }

    assert_eq!(parsed.locations[0].tags.len(), 2);
    assert!(parsed.locations[0].tags.contains(&10), "Urban should map to existing ID 10");
    let rural_id = parsed.tags[0].id;
    assert!(parsed.locations[0].tags.contains(&rural_id), "Rural should map to new ID");
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
