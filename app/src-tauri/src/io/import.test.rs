use super::*;
use crate::selections::Selector;
use crate::store::engine::frame::tests::Captured;
use crate::store::engine::tests::{shipped_count, shipped_record, FeedCapture};
use crate::store::engine::{Store, Target, ValueRecord, WindowLabel};
use crate::store::maps::{MapPreferences, MapSettings, VirtualTag};
use crate::store::{engine, maps};
use crate::test_util::{tag_ids, TempDir};
use crate::types::{Location, LocationFlags, RawExtra};
use crate::util::Rgb;
use mma_algebra::Id;
use std::collections::HashMap;
use std::time::Instant;
use std::{env, fs};
use tokio::runtime::Runtime;

fn tag(id: u32, name: &str) -> ValueRecord {
    ValueRecord {
        id: Id::new(id),
        name: Some(name.into()),
        extra: serde_json::Map::from_iter([("color".to_string(), "#000".into())]),
        ..Default::default()
    }
}

fn loc_with_tags(id: u32, tags: Vec<u32>) -> Location {
    Location {
        id: Id::new(id),
        zoom: 1.0,
        tags: tag_ids(tags),
        ..Default::default()
    }
}

// -----------------------------------------------------------------------
// Tag reconciliation (shared core: engine::reconcile_values_by_name), run against
// the map's display metadata the way import does.
// -----------------------------------------------------------------------

fn reconcile(
    meta: &mut HashMap<Id<ValueRecord>, ValueRecord>,
    tags: &[ValueRecord],
) -> HashMap<u32, u32> {
    engine::reconcile_values_by_name(tags, meta, 0)
        .into_iter()
        .map(|(from, to)| (from.get(), to.get()))
        .collect()
}

fn ordered_tag(id: u32, name: &str, order: u32) -> ValueRecord {
    ValueRecord {
        order: Some(order),
        ..tag(id, name)
    }
}

fn meta_with(tags: &[ValueRecord]) -> HashMap<Id<ValueRecord>, ValueRecord> {
    tags.iter().map(|t| (t.id, t.clone())).collect()
}

#[test]
fn reconcile_reuses_existing_tag_by_name() {
    let mut meta = meta_with(&[tag(5, "Urban")]);
    let remap = reconcile(&mut meta, &[tag(1, "Urban")]);
    assert_eq!(remap[&1], 5, "import tag 1 should remap to existing tag 5");
    assert_eq!(meta.len(), 1, "no new tag created");
}

#[test]
fn reconcile_case_insensitive() {
    let mut meta = meta_with(&[tag(5, "Urban")]);
    let remap = reconcile(&mut meta, &[tag(1, "urban")]);
    assert_eq!(remap[&1], 5);
    assert_eq!(meta.len(), 1);
}

#[test]
fn reconcile_new_tag_gets_fresh_id() {
    let mut meta = meta_with(&[]);
    let remap = reconcile(&mut meta, &[tag(99, "Rural")]);
    assert_ne!(remap[&99], 99, "new tag should get a fresh ID");
    assert_eq!(meta[&Id::new(remap[&99])].name.as_deref(), Some("Rural"));
}

#[test]
fn reconcile_new_ids_land_above_the_data_floor() {
    // Metadata is empty but the map's rows already carry tag ids up to 7 (metadata was
    // deleted out from under them); fresh ids must not collide with those.
    let mut meta = meta_with(&[]);
    let remap = engine::reconcile_values_by_name(&[tag(1, "New")], &mut meta, 7);
    assert_eq!(remap[&Id::new(1)], Id::new(8));
}

#[test]
fn reconcile_mixed_existing_and_new() {
    let mut meta = meta_with(&[tag(10, "Urban")]);
    let remap = reconcile(&mut meta, &[tag(1, "Urban"), tag(2, "Rural")]);
    assert_eq!(remap[&1], 10, "Urban remaps to existing");
    assert_eq!(meta.len(), 2, "only Rural created");
    assert_eq!(meta[&Id::new(remap[&2])].name.as_deref(), Some("Rural"));
}

#[test]
fn reconcile_no_existing_tags() {
    let mut meta = meta_with(&[]);
    let remap = reconcile(&mut meta, &[tag(1, "Alpha"), tag(2, "Beta")]);
    assert_eq!(remap.len(), 2);
    assert_eq!(meta.len(), 2, "both tags are new");
}

#[test]
fn reconcile_all_existing() {
    let mut meta = meta_with(&[tag(5, "Alpha"), tag(6, "Beta")]);
    let remap = reconcile(&mut meta, &[tag(1, "Alpha"), tag(2, "Beta")]);
    assert_eq!(remap[&1], 5);
    assert_eq!(remap[&2], 6);
    assert_eq!(meta.len(), 2, "all tags already exist");
}

#[test]
fn reconcile_duplicate_import_tags_dedup_against_each_other() {
    let mut meta = meta_with(&[]);
    // Two import tags with same name but different IDs (shouldn't happen from parse_file,
    // but the core should handle it: second one reuses the first's allocated ID)
    let remap = reconcile(&mut meta, &[tag(1, "Dup"), tag(2, "Dup")]);
    assert_eq!(remap[&1], remap[&2], "both import IDs remap to same new ID");
    assert_eq!(meta.len(), 1, "second duplicate not created");
}

#[test]
fn reconcile_location_tags_remapped_correctly() {
    let mut meta = meta_with(&[tag(10, "Urban")]);
    let remap = reconcile(&mut meta, &[tag(1, "Urban"), tag(2, "Rural")]);

    // Apply the remap to locations (same as reconcile_import_tags does)
    let mut loc = loc_with_tags(1, vec![1, 2]);
    loc.tags = loc
        .tags
        .iter()
        .filter_map(|old| remap.get(&old.get()).copied().map(Id::new))
        .collect();

    assert_eq!(loc.tags.len(), 2);
    assert!(
        loc.tags.contains(&Id::new(10)),
        "Urban should map to existing ID 10"
    );
    assert!(
        loc.tags.contains(&Id::new(remap[&2])),
        "Rural should map to new ID"
    );
}

// Order semantics: source order values are never stored verbatim; ordered
// source tags land dense after the target's max order, and existing unordered
// (order: None) tags are claimable by an ordered import of the same name.

#[test]
fn reconcile_rebases_new_ordered_tags_dense_from_one() {
    let mut meta = meta_with(&[]);
    let remap = reconcile(
        &mut meta,
        &[
            ordered_tag(1, "Zebra", 131),
            ordered_tag(2, "Mango", 132),
            ordered_tag(3, "Apple", 133),
        ],
    );
    assert_eq!(meta[&Id::new(remap[&1])].order, Some(1));
    assert_eq!(meta[&Id::new(remap[&2])].order, Some(2));
    assert_eq!(meta[&Id::new(remap[&3])].order, Some(3));
}

#[test]
fn reconcile_appends_new_ordered_tags_after_existing_max() {
    let mut meta = meta_with(&[ordered_tag(5, "Kept", 4)]);
    let remap = reconcile(&mut meta, &[ordered_tag(1, "New", 131)]);
    assert_eq!(meta[&Id::new(remap[&1])].order, Some(5));
}

#[test]
fn reconcile_ordered_source_claims_unordered_existing() {
    // Existing same-name tag with no order (e.g. imported without app data,
    // possibly now at count 0) must adopt the incoming file's ordering.
    let mut meta = meta_with(&[tag(5, "Zebra"), tag(6, "Apple"), ordered_tag(7, "Kept", 2)]);
    reconcile(
        &mut meta,
        &[ordered_tag(1, "Zebra", 131), ordered_tag(2, "Apple", 132)],
    );
    assert_eq!(meta[&Id::new(7)].order, Some(2), "ordered tag untouched");
    assert_eq!(meta[&Id::new(5)].order, Some(3), "Zebra first per file");
    assert_eq!(meta[&Id::new(6)].order, Some(4), "Apple second per file");
}

#[test]
fn reconcile_ordered_source_does_not_override_concrete_order() {
    let mut meta = meta_with(&[ordered_tag(5, "Urban", 2)]);
    reconcile(&mut meta, &[ordered_tag(1, "Urban", 131)]);
    assert_eq!(meta[&Id::new(5)].order, Some(2));
}

#[test]
fn reconcile_unordered_source_tags_join_the_end_of_the_order() {
    let mut meta = meta_with(&[ordered_tag(5, "Kept", 4)]);
    let remap = reconcile(&mut meta, &[tag(1, "Bare")]);
    assert_eq!(meta[&Id::new(remap[&1])].order, Some(5));
}

#[test]
fn renumber_ordered_tags_dense_and_leaves_none() {
    let mut tags = vec![
        ordered_tag(1, "C", 140),
        tag(2, "Bare"),
        ordered_tag(3, "A", 131),
    ];
    renumber_ordered_tags(&mut tags);
    assert_eq!(tags[0].order, Some(2), "C after A");
    assert_eq!(tags[1].order, None);
    assert_eq!(tags[2].order, Some(1), "A first");
}

/// Scan `extra` from a buffer and pull tag meta, as the parse path does internally.
fn tag_meta(buf: &[u8]) -> HashMap<String, ExtraTagMeta> {
    find_top_level_extra(buf, 0, 0)
        .as_ref()
        .map(tag_meta_from_extra)
        .unwrap_or_default()
}

#[test]
fn tag_meta_reads_color_and_order() {
    let json = br#"{"customCoordinates":[],"extra":{"tags":{"Roof":{"color":[255,0,0],"order":3},"Wall":{"color":[0,128,255],"order":1}}}}"#;
    let meta = tag_meta(json);
    assert_eq!(meta.len(), 2);

    let roof = &meta["Roof"];
    assert_eq!(roof.color, Some(Rgb([255, 0, 0])));
    assert_eq!(roof.order, Some(3));

    let wall = &meta["Wall"];
    assert_eq!(wall.color, Some(Rgb([0, 128, 255])));
    assert_eq!(wall.order, Some(1));
}

#[test]
fn tag_meta_missing_order() {
    let json = br#"{"extra":{"tags":{"NoOrder":{"color":[10,20,30]}}}}"#;
    let meta = tag_meta(json);
    let tag = &meta["NoOrder"];
    assert_eq!(tag.color, Some(Rgb([10, 20, 30])));
    assert_eq!(tag.order, None);
}

#[test]
fn tag_meta_missing_color() {
    let json = br#"{"extra":{"tags":{"OnlyOrder":{"order":5}}}}"#;
    let meta = tag_meta(json);
    let tag = &meta["OnlyOrder"];
    assert_eq!(tag.color, None);
    assert_eq!(tag.order, Some(5));
}

#[test]
fn tag_meta_reads_doclinks_array() {
    let json = br#"{"extra":{"tags":{"Antenna":{"color":[1,2,3],"doclinks":["https://docs.google.com/document/d/abc/edit#heading=h.x1","https://docs.google.com/document/d/def/edit#heading=h.y2"]}}}}"#;
    let meta = tag_meta(json);
    assert_eq!(
        meta["Antenna"].doclinks,
        vec![
            "https://docs.google.com/document/d/abc/edit#heading=h.x1",
            "https://docs.google.com/document/d/def/edit#heading=h.y2"
        ]
    );
}

#[test]
fn tag_meta_accepts_bare_doclink_string() {
    let json = br#"{"extra":{"tags":{"Pole":{"doclink":"https://docs.google.com/document/d/abc/edit#heading=h.z"}}}}"#;
    let meta = tag_meta(json);
    assert_eq!(
        meta["Pole"].doclinks,
        vec!["https://docs.google.com/document/d/abc/edit#heading=h.z"]
    );
}

#[test]
fn tag_meta_no_doclinks() {
    let json = br#"{"extra":{"tags":{"Plain":{"order":1}}}}"#;
    let meta = tag_meta(json);
    assert!(meta["Plain"].doclinks.is_empty());
}

#[test]
fn tag_meta_no_extra() {
    let json = br#"{"customCoordinates":[]}"#;
    let meta = tag_meta(json);
    assert!(meta.is_empty());
}

// -----------------------------------------------------------------------
// Map settings carried through import (extra.settings)
// -----------------------------------------------------------------------

#[test]
fn parse_captures_settings_overlay() {
    let json = br##"{"customCoordinates":[
        {"lat":1,"lng":2,"extra":{"tags":["Europe/France/Paris"]}}
    ],"extra":{"tags":{"Europe/France/Paris":{"color":[1,2,3]}},"settings":{"virtualTags":{"Europe":{"color":"#c0f0f8"},"Europe/France":{"color":"#183848"}}}}}"##;
    let mut buf = json.to_vec();
    let parsed = parse_single_json_mut(&mut buf);
    assert!(parsed.settings.contains_key("virtualTags"));

    let merged = merge_settings(MapSettings::default(), &parsed.settings);
    assert_eq!(
        merged.virtual_tags["Europe"].color.as_deref(),
        Some("#c0f0f8")
    );
    assert_eq!(
        merged.virtual_tags["Europe/France"].color.as_deref(),
        Some("#183848")
    );
}

#[test]
fn parse_no_settings_is_empty() {
    let json = br#"{"customCoordinates":[],"extra":{"tags":{}}}"#;
    let mut buf = json.to_vec();
    let parsed = parse_single_json_mut(&mut buf);
    assert!(parsed.settings.is_empty());
}

#[test]
fn merge_settings_overlays_present_keys_only() {
    let json = br##"{"customCoordinates":[{"lat":1,"lng":2}],"extra":{"settings":{"virtualTags":{"Asia":{"color":"#asia"}}}}}"##;
    let mut buf = json.to_vec();
    let parsed = parse_single_json_mut(&mut buf);

    let mut base = MapSettings {
        preferences: MapPreferences {
            point_along_road: false, // non-default, unrelated key
            ..MapPreferences::default()
        },
        ..MapSettings::default()
    };
    base.virtual_tags.insert(
        "Europe".into(),
        VirtualTag {
            color: Some("#existing".into()),
            ..VirtualTag::default()
        },
    );

    let merged = merge_settings(base, &parsed.settings);
    assert!(
        !merged.preferences.point_along_road,
        "key absent from the overlay keeps its base value"
    );
    assert_eq!(
        merged.virtual_tags["Asia"].color.as_deref(),
        Some("#asia"),
        "imported key applied"
    );
    // A present key replaces wholesale (shallow overlay), so base's Europe is gone.
    assert!(
        !merged.virtual_tags.contains_key("Europe"),
        "present key replaces the whole value"
    );
}

#[test]
fn imported_maps_start_from_the_saved_defaults_under_the_files_own_settings() {
    let conn = Connection::open_in_memory().unwrap();
    storage::run_migrations_on(&conn).unwrap();
    conn.execute(
        "INSERT INTO map_defaults (id, preferences) VALUES (1, ?1)",
        [r#"{"pointAlongRoad":false,"exportZoom":true}"#],
    )
    .unwrap();
    let json = br#"{"name":"Imported","customCoordinates":[{"lat":1,"lng":2}],"extra":{"settings":{"exportZoom":false}}}"#;
    let mut buf = json.to_vec();
    let parsed = parse_single_json_mut(&mut buf);
    let dir = TempDir::new("mma_test_import_defaults");

    write_map_to_db(
        &conn,
        parsed,
        &Id::new("imported".into()),
        &dir.join("imported.arrow"),
    )
    .unwrap();

    let settings: String = conn
        .query_row("SELECT settings FROM maps WHERE id = 'imported'", [], |r| {
            r.get(0)
        })
        .unwrap();
    let settings: MapSettings = serde_json::from_str(&settings).unwrap();
    assert!(
        !settings.preferences.point_along_road,
        "saved default applied"
    );
    assert!(
        !settings.preferences.export_zoom,
        "the file's own setting wins"
    );
}

#[test]
fn merge_settings_empty_overlay_is_base() {
    let base = MapSettings::default();
    let merged = merge_settings(base, &serde_json::Map::new());
    assert!(
        merged.preferences.point_along_road,
        "empty overlay leaves defaults untouched"
    );
}

// -----------------------------------------------------------------------
// Boundary scanner (find_object_boundaries) — string/escape correctness.
// A `{`/`}`/`]` inside a string value must never be read as structure.
// -----------------------------------------------------------------------

/// Parse a full doc and return the location count — exercises find_object_boundaries
/// + the parallel parse end to end.
fn parse_count(json: &[u8]) -> usize {
    let mut buf = json.to_vec();
    parse_single_json_mut(&mut buf).locations.len()
}

#[test]
fn boundaries_braces_in_string_value() {
    // The uploaderName contains { } , ] — none may be treated as structure.
    let json = br#"{"customCoordinates":[
        {"lat":1,"lng":2,"extra":{"uploaderName":"a},{b]["}},
        {"lat":3,"lng":4}
    ]}"#;
    assert_eq!(parse_count(json), 2);
}

#[test]
fn boundaries_escaped_quote_in_string() {
    // Escaped quote must not end the string early (which would expose the inner braces).
    let json = br#"{"customCoordinates":[
        {"lat":1,"lng":2,"extra":{"note":"he said \"}{,\" loudly"}},
        {"lat":3,"lng":4}
    ]}"#;
    assert_eq!(parse_count(json), 2);
}

#[test]
fn boundaries_escaped_backslash_before_quote() {
    // Trailing escaped backslash: the closing quote is real (even backslash count).
    let json = br#"{"customCoordinates":[
        {"lat":1,"lng":2,"extra":{"path":"C:\\"}},
        {"lat":3,"lng":4}
    ]}"#;
    assert_eq!(parse_count(json), 2);
}

#[test]
fn boundaries_empty_array() {
    assert_eq!(parse_count(br#"{"customCoordinates":[]}"#), 0);
    assert_eq!(
        parse_count(br#"{"customCoordinates":[],"extra":{"tags":{}}}"#),
        0
    );
}

#[test]
fn boundaries_bare_array_root() {
    let json = br#"[{"lat":1,"lng":2},{"lat":3,"lng":4},{"lat":5,"lng":6}]"#;
    assert_eq!(parse_count(json), 3);
}

#[test]
fn boundaries_tag_meta_after_brace_heavy_strings() {
    // extra.tags metadata must still be found even when object values held braces.
    let json = br#"{"customCoordinates":[
        {"lat":1,"lng":2,"extra":{"note":"}{}{","tags":["X"]}}
    ],"extra":{"tags":{"X":{"color":[1,2,3],"order":7}}}}"#;
    let mut buf = json.to_vec();
    let parsed = parse_single_json_mut(&mut buf);
    assert_eq!(parsed.locations.len(), 1);
    assert_eq!(parsed.tags.len(), 1);
    assert_eq!(parsed.tags[0].name.as_deref(), Some("X"));
    assert_eq!(parsed.tags[0].order, Some(7));
    assert_eq!(parsed.tags[0].color(), "#010203".parse().ok());
}

/// A nameless map previews as no name at all; naming the placeholder is JS's job.
#[test]
fn preview_leaves_an_unnamed_map_nameless() {
    let entry = |json: &[u8]| {
        let mut buf = json.to_vec();
        ImportPreviewEntry::from(&parse_single_json_mut(&mut buf))
    };
    assert_eq!(
        entry(br#"{"name":"Sweden","customCoordinates":[{"lat":1,"lng":2}]}"#).name,
        Some("Sweden".to_string())
    );
    assert_eq!(
        entry(br#"{"customCoordinates":[{"lat":1,"lng":2}]}"#).name,
        None
    );
    assert_eq!(
        entry(br#"{"name":"","customCoordinates":[{"lat":1,"lng":2}]}"#).name,
        None
    );
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
    assert_eq!(parsed.tags[0].name.as_deref(), Some("Beta"));
    assert_eq!(parsed.tags[0].order, Some(0));
    assert_eq!(parsed.tags[1].name.as_deref(), Some("Gamma"));
    assert_eq!(parsed.tags[1].order, Some(1));
    assert_eq!(parsed.tags[2].name.as_deref(), Some("Alpha"));
    assert_eq!(parsed.tags[2].order, Some(2));
}

// -----------------------------------------------------------------------
// Raw-extra parse: the fast byte path (strip `tags`, keep the rest as raw JSON) and
// its map-path fallbacks (non-null country/state fold, nested panoId) must produce
// the same semantic result the old map-building parser did.
// -----------------------------------------------------------------------

fn parse_one(json: &[u8]) -> (Location, Vec<ValueRecord>) {
    let mut buf = json.to_vec();
    let p = parse_single_json_mut(&mut buf);
    (
        p.locations.into_iter().next().expect("one location"),
        p.tags,
    )
}

#[test]
fn fast_path_strips_tags_keeps_rest() {
    let (loc, tags) = parse_one(br#"{"customCoordinates":[
        {"lat":1,"lng":2,"countryCode":null,"stateCode":null,"extra":{"tags":["A","B"],"panoDate":"2025-08"}}
    ]}"#);
    let e = loc.extra.as_ref().unwrap();
    assert_eq!(e.get("panoDate").unwrap(), "2025-08");
    assert!(e.get("tags").is_none(), "tags stripped from stored extra");
    assert!(
        e.get("countryCode").is_none(),
        "null country not folded (parity with old parser)"
    );
    assert_eq!(loc.tags.len(), 2);
    let mut names: Vec<_> = tags
        .iter()
        .map(|rec| rec.name.clone().unwrap_or_default())
        .collect();
    names.sort();
    assert_eq!(names, vec!["A", "B"]);
}

#[test]
fn fast_path_tags_with_special_chars() {
    // Tag strings contain `,` `]` `:` and an escaped quote — the array must be located
    // string-aware and parsed with serde (not a naive byte split).
    let (loc, _tags) = parse_one(
        br#"{"customCoordinates":[
        {"lat":1,"lng":2,"extra":{"tags":["a,b","c]d","e:f","q\"z"],"note":"keep"}}
    ]}"#,
    );
    assert_eq!(loc.tags.len(), 4);
    let e = loc.extra.as_ref().unwrap();
    assert_eq!(e.get("note").unwrap(), "keep");
    assert!(e.get("tags").is_none());
}

#[test]
fn ascii_escaped_field_names_survive_both_paths() {
    // A file written by an ensure_ascii encoder spells `café` as an escape. The fast
    // path keeps extra bytes verbatim and the map path decodes them, so without
    // canonicalization one file yields two spellings of the same field -- and a filter
    // on either matches only half the map. Loc 2's countryCode forces the map path.
    let bs = '\\';
    let json = format!(
        r#"{{"customCoordinates":[
        {{"lat":1,"lng":2,"extra":{{"caf{bs}u00e9":"au lait"}}}},
        {{"lat":3,"lng":4,"countryCode":"FR","extra":{{"caf{bs}u00e9":"noir"}}}}
    ]}}"#
    );
    let mut buf = json.into_bytes();
    let parsed = parse_single_json_mut(&mut buf);
    assert_eq!(parsed.locations.len(), 2);
    for loc in &parsed.locations {
        assert!(
            loc.extra.as_ref().unwrap().get("café").is_some(),
            "field must resolve under its decoded name"
        );
    }

    let extras: Vec<&RawExtra> = parsed
        .locations
        .iter()
        .filter_map(|l| l.extra.as_ref())
        .collect();
    let defs = maps::infer_field_defs(|_| false, &extras).unwrap();
    let mut keys: Vec<&str> = defs.keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(keys, vec!["café", "countryCode"]);
}

#[test]
fn nested_tags_key_not_stripped() {
    // A `tags` key nested inside a value object must be left intact; only the depth-1
    // `tags` array is stripped.
    let (loc, _tags) = parse_one(
        br#"{"customCoordinates":[
        {"lat":1,"lng":2,"extra":{"meta":{"tags":5},"tags":["X"]}}
    ]}"#,
    );
    assert_eq!(loc.tags.len(), 1);
    let e = loc.extra.as_ref().unwrap();
    assert_eq!(e.get("meta").unwrap(), serde_json::json!({"tags":5}));
    assert!(e.get("tags").is_none(), "top-level tags stripped");
}

#[test]
fn value_containing_tags_word_is_not_a_key() {
    let (loc, _tags) = parse_one(
        br#"{"customCoordinates":[
        {"lat":1,"lng":2,"extra":{"note":"my tags here","panoDate":"x"}}
    ]}"#,
    );
    assert!(loc.tags.is_empty());
    let e = loc.extra.as_ref().unwrap();
    assert_eq!(e.get("note").unwrap(), "my tags here");
    assert_eq!(e.get("panoDate").unwrap(), "x");
}

#[test]
fn non_null_country_state_folded_into_extra() {
    let (loc, _tags) = parse_one(
        br#"{"customCoordinates":[
        {"lat":1,"lng":2,"countryCode":"US","stateCode":"CA","extra":{"tags":["X"]}}
    ]}"#,
    );
    let e = loc.extra.as_ref().unwrap();
    assert_eq!(e.get("countryCode").unwrap(), "US");
    assert_eq!(e.get("stateCode").unwrap(), "CA");
    assert_eq!(loc.tags.len(), 1);
}

#[test]
fn pano_id_nested_in_extra_extracted() {
    let (loc, _tags) = parse_one(
        br#"{"customCoordinates":[
        {"lat":1,"lng":2,"extra":{"panoId":"PANO123","tags":["X"]}}
    ]}"#,
    );
    assert_eq!(loc.pano_id.as_deref(), Some("PANO123"));
    assert!(
        !loc.flags.contains(LocationFlags::LOAD_AS_PANO_ID),
        "nested panoId is not a top-level pano"
    );
    assert_eq!(loc.tags.len(), 1);
    assert_eq!(loc.extra, None);
}

#[test]
fn extra_with_only_tags_leaves_no_extra() {
    let (loc, _tags) = parse_one(
        br#"{"customCoordinates":[
        {"lat":1,"lng":2,"extra":{"tags":["X"]}}
    ]}"#,
    );
    assert_eq!(loc.extra, None);
    assert_eq!(loc.tags.len(), 1);
}

#[test]
fn no_extra_at_all() {
    let (loc, _tags) = parse_one(br#"{"customCoordinates":[{"lat":1,"lng":2}]}"#);
    assert!(loc.extra.is_none());
    assert!(loc.tags.is_empty());
}

// -----------------------------------------------------------------------
// Parallel boundary scan (parallel_find_object_boundaries) must be byte-identical
// to the serial find_object_boundaries. Correctness is a hard invariant: the
// parallel scanner is only ever a speed optimization over the serial one.
// -----------------------------------------------------------------------

/// Assert the parallel scan returns exactly the serial scan's ranges + array close.
fn assert_parallel_matches_serial(arr: &[u8]) {
    let (ser_r, ser_c) = find_object_boundaries(arr);
    let (par_r, par_c) = parallel_find_object_boundaries(arr);
    assert_eq!(par_r, ser_r, "parallel ranges differ from serial");
    assert_eq!(par_c, ser_c, "parallel array-close differs from serial");
}

/// Build a synthetic array slice (the bytes between `[` and `]`) of `n` objects.
/// `sep` is the inter-object separator (e.g. `,` minified or `,\n` delimited).
fn synth_array(n: usize, sep: &str, with_extra: bool) -> Vec<u8> {
    let mut s = String::from("[");
    for i in 0..n {
        if i > 0 {
            s.push_str(sep);
        }
        if with_extra {
            // extra with braces/commas inside strings to stress skip_string across ranges
            s.push_str(&format!(
                r#"{{"lat":{}.5,"lng":{}.25,"panoId":"pano{}","extra":{{"note":"a}},{{b][{}","tags":["T{}","common"]}}}}"#,
                i % 90, i % 180, i, i, i % 7));
        } else {
            s.push_str(&format!(
                r#"{{"lat":{}.5,"lng":{}.25,"heading":0,"panoId":null}}"#,
                i % 90,
                i % 180
            ));
        }
    }
    s.push(']');
    s.into_bytes()
}

#[test]
fn parallel_scan_matches_serial_small_fixtures() {
    // Reuse the tricky serial-correctness fixtures — braces/quotes/escapes in strings.
    let arr = br#"[{"lat":1,"lng":2,"extra":{"uploaderName":"a},{b]["}},{"lat":3,"lng":4}]"#;
    assert_parallel_matches_serial(arr);
    let arr = br#"[{"lat":1,"lng":2,"extra":{"note":"he said \"}{,\" loudly"}},{"lat":3,"lng":4}]"#;
    assert_parallel_matches_serial(arr);
    let arr = br#"[{"lat":1,"lng":2,"extra":{"path":"C:\\"}},{"lat":3,"lng":4}]"#;
    assert_parallel_matches_serial(arr);
    assert_parallel_matches_serial(br#"[]"#);
    assert_parallel_matches_serial(br#"[{"lat":1,"lng":2}]"#);
}

#[test]
fn parallel_scan_matches_serial_large_minified() {
    // Big enough to exceed the 2MB parallel threshold; minified (no interior newlines),
    // so it exercises the `},{` resync path.
    let arr = synth_array(60_000, ",", false);
    assert!(
        arr.len() > 2_000_000,
        "fixture must cross the parallel threshold"
    );
    assert_parallel_matches_serial(&arr);
}

#[test]
fn parallel_scan_matches_serial_large_delimited_with_extra() {
    // Newline-delimited + extra whose string values contain `}`, `{`, `,`, `]` — the
    // resync must land on real boundaries and skip_string must span range seams.
    let arr = synth_array(40_000, ",\n", true);
    assert!(arr.len() > 2_000_000);
    assert_parallel_matches_serial(&arr);
}

#[test]
fn parallel_scan_matches_serial_trailing_sibling_key() {
    // Full doc shape: the array is followed by a sibling "extra" key. Both scanners
    // must stop at the array's `]`, not read the sibling object as a coordinate.
    let mut doc = Vec::from(&b"{\"customCoordinates\":"[..]);
    doc.extend_from_slice(&synth_array(30_000, ",", false));
    doc.extend_from_slice(br#","extra":{"tags":{"X":{"color":[1,2,3]}}}}"#);
    // Slice from just after the array-open `[` to end, as parse_single_json_mut passes it.
    let arr_start = doc.iter().position(|&b| b == b'[').unwrap() + 1;
    assert_parallel_matches_serial(&doc[arr_start..]);
}

// -----------------------------------------------------------------------
// Parse benchmark (ignored; run explicitly against a real large file)
//   cargo test --release -p app_lib import::tests::bench_parse_real -- --ignored --nocapture
// Override the file with MMA_BENCH_FILE=/path/to/file.json
// -----------------------------------------------------------------------
struct StderrLog;
impl log::Log for StderrLog {
    fn enabled(&self, _: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        eprintln!("{}", record.args());
    }
    fn flush(&self) {}
}
static STDERR_LOG: StderrLog = StderrLog;

#[test]
#[ignore]
fn bench_parse_real() {
    let _ = log::set_logger(&STDERR_LOG);
    log::set_max_level(log::LevelFilter::Debug);
    let Ok(path) = env::var("MMA_BENCH_FILE") else {
        eprintln!("SKIP bench: MMA_BENCH_FILE not set");
        return;
    };

    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("SKIP bench: cannot read {path}: {e}");
            return;
        }
    };
    eprintln!("file={} size={:.1}MB", path, bytes.len() as f64 / 1e6);

    let iters = 5;
    let mut best_parse = f64::MAX;
    let mut best_build = f64::MAX;
    let mut locs = 0usize;
    for i in 0..iters {
        let mut buf = bytes.clone();
        let t0 = Instant::now();
        let parsed = parse_file(&mut buf);
        let t_parse = t0.elapsed().as_secs_f64() * 1e3;
        locs = parsed.locations.len();

        let t1 = Instant::now();
        let _preview = build_preview(&parsed, "bench").expect("build_preview");
        let t_build = t1.elapsed().as_secs_f64() * 1e3;

        eprintln!("iter {i}: parse={t_parse:.0}ms build_preview={t_build:.0}ms");
        best_parse = best_parse.min(t_parse);
        best_build = best_build.min(t_build);
    }
    eprintln!("BEST: parse={best_parse:.0}ms build_preview={best_build:.0}ms locs={locs}");
}

#[test]
fn a_bulk_preview_keeps_every_file_it_parsed() {
    let dir = tempfile::tempdir().unwrap();
    let paths: Vec<String> = ["bulk-cache-a", "bulk-cache-b"]
        .iter()
        .map(|name| {
            let path = dir.path().join(format!("{name}.json"));
            fs::write(
                &path,
                br#"{"name":"m","customCoordinates":[{"lat":1,"lng":2}]}"#,
            )
            .unwrap();
            path.to_string_lossy().into_owned()
        })
        .collect();
    let rt = Runtime::new().unwrap();
    for path in &paths {
        rt.block_on(bulk_import_preview(path.clone())).unwrap();
    }
    {
        let cache = CACHED_PARSE.lock().unwrap();
        assert!(paths.iter().all(|p| cache.contains_key(p)));
    }
    rt.block_on(bulk_import_cancel()).unwrap();
    assert!(CACHED_PARSE.lock().unwrap().is_empty());
}

#[test]
fn a_bulk_import_defines_every_field_its_rows_carry() {
    let mut buf = br#"{"name":"m","customCoordinates":[
        {"lat":1,"lng":2,"extra":{"elevation":10,"countryCode":"US"}},
        {"lat":3,"lng":4,"extra":{"region":"west"}}
    ],"extra":{"fields":{"elevation":{"type":"number","label":"Height"}}}}"#
        .to_vec();
    let mut map = parse_single_json_mut(&mut buf);
    let fields = maps::MapExtra::from_json(&map_extra_json(&mut map).unwrap()).fields;
    assert!(
        fields.contains_key("countryCode"),
        "a key only the rows carry is defined"
    );
    assert!(fields.contains_key("region"));
    assert_eq!(
        fields["elevation"].label.as_deref(),
        Some("Height"),
        "the file's own definition is kept"
    );
}

#[test]
fn staged_rows_take_real_sequential_ids_and_read_through_the_import_layer() {
    let json = br#"{"name":"Pasted URLs","customCoordinates":[
        {"lat":10.5,"lng":20.5,"heading":90,"panoId":"abcdefghijklmnopqrstuv"},
        {"lat":-3.25,"lng":7.75}
    ]}"#;
    let mut buf = json.to_vec();
    let parsed = parse_single_json_mut(&mut buf);
    let mut store = Store::new();
    store.meta = engine::Tracked::new(MapMeta {
        id: Id::new("test".into()),
        ..Default::default()
    });

    let keys = stage_parsed(&mut store, "staged-fetch", parsed);
    let target = import_target("staged-fetch");
    let first = store.at(&target).rows(&Selector::Locations {
        locations: vec![keys.nth(0).unwrap()],
        name: None,
    })[0]
        .clone();
    assert_eq!(first.lat, 10.5);
    assert_eq!(first.heading, 90.0);
    assert_eq!(first.pano_id.as_deref(), Some("abcdefghijklmnopqrstuv"));
    let second = store.at(&target).rows(&Selector::Locations {
        locations: vec![keys.nth(1).unwrap()],
        name: None,
    })[0]
        .clone();
    assert_eq!(second.lng, 7.75);
    // Staged rows are held by the layer, not on the map.
    assert!(store
        .at(&Target::Map { id: None })
        .rows(&Selector::Everything)
        .is_empty());
}

#[test]
fn a_staged_imports_range_covers_exactly_its_staged_rows() {
    let mut store = Store::new();
    store.meta = engine::Tracked::new(MapMeta {
        id: Id::new("test".into()),
        ..Default::default()
    });
    let held = store
        .at(&Target::Map { id: None })
        .edit(
            vec![mma_algebra::Op::Add(loc_with_tags(0, Vec::new()))],
            Default::default(),
            &mut None,
        )
        .keys[0];
    let parsed = ParsedMap {
        locations: vec![loc_with_tags(0, Vec::new()); 3],
        ..Default::default()
    };
    let run = stage_parsed(&mut store, "range-win", parsed);
    assert_eq!(run.len, 3);
    assert!(!run.contains(held));
    let staged: Vec<_> = store
        .at(&import_target("range-win"))
        .rows(&Selector::Everything)
        .into_iter()
        .map(|l| l.id)
        .filter(|&id| id != held)
        .collect();
    assert_eq!(staged, run.iter().collect::<Vec<_>>());
    let next = store
        .at(&Target::Map { id: None })
        .edit(
            vec![mma_algebra::Op::Add(loc_with_tags(0, Vec::new()))],
            Default::default(),
            &mut None,
        )
        .keys[0];
    assert!(!run.contains(next));
}

#[test]
fn cancelling_a_staged_import_drops_its_layer() {
    let mut buf = br#"{"customCoordinates":[{"lat":1,"lng":2}]}"#.to_vec();
    let parsed = parse_single_json_mut(&mut buf);
    let mut store = Store::new();
    store.meta = engine::Tracked::new(MapMeta {
        id: Id::new("test".into()),
        ..Default::default()
    });
    stage_parsed(&mut store, "cancel-me", parsed);
    store.close_layer(&import_layer("cancel-me"));
    assert!(store
        .at(&import_target("cancel-me"))
        .rows(&Selector::Everything)
        .is_empty());
}

#[test]
fn two_windows_previewing_at_once_keep_their_own_import() {
    let mut store = Store::new();
    store.meta = engine::Tracked::new(MapMeta {
        id: Id::new("test".into()),
        ..Default::default()
    });
    let stage = |store: &mut Store, window: &str, lat: f64| {
        let json = format!(r#"{{"customCoordinates":[{{"lat":{lat},"lng":1}}]}}"#);
        let mut buf = json.into_bytes();
        let parsed = parse_single_json_mut(&mut buf);
        let preview = build_preview(&parsed, window).unwrap();
        assert!(preview.target == import_target(window));
        stage_parsed(store, window, parsed).first
    };
    let a = stage(&mut store, "preview-a", 11.0);
    let b = stage(&mut store, "preview-b", 22.0);
    assert_ne!(
        preview_positions_path("preview-a"),
        preview_positions_path("preview-b")
    );
    assert_eq!(
        store
            .at(&import_target("preview-a"))
            .rows(&Selector::Locations {
                locations: [a].to_vec(),
                name: None
            })[0]
            .lat,
        11.0
    );
    assert_eq!(
        store
            .at(&import_target("preview-b"))
            .rows(&Selector::Locations {
                locations: [b].to_vec(),
                name: None
            })[0]
            .lat,
        22.0
    );
    let _ = fs::remove_file(preview_positions_path("preview-a"));
    let _ = fs::remove_file(preview_positions_path("preview-b"));
}

#[test]
fn editor_import_reports_marker_additions_only_when_it_lands() {
    let mut store = Store::new();
    store.meta = engine::Tracked::new(MapMeta {
        id: Id::new("test".into()),
        ..Default::default()
    });
    let parsed = ParsedMap {
        locations: vec![loc_with_tags(0, Vec::new()), loc_with_tags(0, Vec::new())],
        ..Default::default()
    };

    let frames = Captured::default();
    store
        .frames
        .insert(WindowLabel("test".into()), frames.sink());
    stage_parsed(&mut store, "frames-win", parsed);
    assert!(frames.frames().is_empty());

    store.land(&import_layer("frames-win"), &mut None);
    let cells = frames.last().cells;
    assert_eq!(cells.iter().map(|c| c.add.len()).sum::<usize>(), 2);
    assert!(cells
        .iter()
        .all(|c| c.remove.is_empty() && c.patch.len() == 0));
}

// Cross-map copy into an open target: reconcile tags and publish counts on the change feed.
// The closed-target path is covered by e2e tests.

#[test]
fn copied_locations_reconcile_tags_and_report_counts() {
    // Target metadata already defines "Shared" (id 5). The copies reference the *source*
    // map's own tag ids (1 = Shared, 2 = Unique), as a real cross-map copy would.
    let mut store = Store::new();
    store.meta = engine::Tracked::new(MapMeta {
        id: Id::new("test".into()),
        ..Default::default()
    });
    store.records.insert(
        "tags".into(),
        engine::Tracked::new(meta_with(&[tag(5, "Shared")])),
    );
    let parsed = ParsedMap {
        locations: vec![loc_with_tags(1, vec![1]), loc_with_tags(2, vec![1, 2])],
        tags: vec![tag(1, "Shared"), tag(2, "Unique")],
        ..Default::default()
    };

    let feed = FeedCapture::attach(&mut store);
    store.at(&Target::Map { id: None }).edit(
        parsed
            .locations
            .into_iter()
            .map(mma_algebra::Op::Add)
            .collect(),
        engine::IncomingRecords::from([(
            "tags".to_string(),
            parsed.tags.into_iter().map(|t| (t.id, t)).collect(),
        )]),
        &mut None,
    );
    let event = feed
        .all()
        .into_iter()
        .find(|event| event.derived.location_count.is_some())
        .unwrap();

    // Both copies landed in the target store.
    assert_eq!(event.derived.location_count, Some(2));
    let stored = store
        .at(&Target::Map { id: None })
        .rows(&Selector::Everything);
    assert_eq!(stored.len(), 2);

    // "Shared" reconciled to the target's existing id 5 (no duplicate created);
    // "Unique" got a fresh id, not the source's.
    let meta = &store.records["tags"];
    let (unique_id, _) = meta
        .iter()
        .find(|(_, rec)| rec.name.as_deref() == Some("Unique"))
        .expect("Unique created");
    let unique_id = *unique_id;
    assert_ne!(unique_id, Id::new(2));
    assert_eq!(
        meta.values()
            .filter(|rec| rec.name.as_deref() == Some("Shared"))
            .count(),
        1
    );

    // Copies carry the reconciled *target* tag ids, not the source ids.
    let two_tag = stored.iter().find(|l| l.tags.len() == 2).unwrap();
    assert!(two_tag.tags.contains(&Id::new(5)));
    assert!(two_tag.tags.contains(&unique_id));

    // The change feed reports Shared on both copies and Unique on one.
    assert_eq!(shipped_count(&event.derived, "tags", "5"), Some(2));
    assert_eq!(
        shipped_count(&event.derived, "tags", &unique_id.to_string()),
        Some(1)
    );

    // The same event includes the reconciled tag metadata.
    assert!(shipped_record(&event.derived, "tags", unique_id.get()).is_some());
}

#[test]
fn bulk_tags_apply_every_name_to_every_import() {
    // "shared" reuses the existing "Shared" (id 5); blanks drop and repeats collapse.
    let mut store = Store::new();
    store.meta = engine::Tracked::new(MapMeta {
        id: Id::new("test".into()),
        ..Default::default()
    });
    store.records.insert(
        "tags".into(),
        engine::Tracked::new(meta_with(&[tag(5, "Shared")])),
    );
    let parsed = ParsedMap {
        locations: vec![loc_with_tags(1, vec![]), loc_with_tags(2, vec![])],
        ..Default::default()
    };
    let names = ["shared", " France ", "", "france"].map(String::from);

    stage_parsed(&mut store, "bulk-win", parsed);
    confirm_staged(&mut store, "bulk-win", &[], &names).unwrap();

    let meta = &store.records["tags"];
    let (france, _) = meta
        .iter()
        .find(|(_, rec)| rec.name.as_deref() == Some("France"))
        .expect("France created");
    let france = *france;
    assert_eq!(meta.values().count(), 2);
    let stored = store
        .at(&Target::Map { id: None })
        .rows(&Selector::Everything);
    assert_eq!(stored.len(), 2);
    for l in &stored {
        assert_eq!(l.tags, vec![Id::new(5), france]);
    }
}

fn store_tagged(tags: &[ValueRecord]) -> Store {
    let mut store = Store::new();
    store.meta = engine::Tracked::new(MapMeta {
        id: Id::new("test".into()),
        ..Default::default()
    });
    store
        .records
        .insert("tags".into(), engine::Tracked::new(meta_with(tags)));
    store
}

#[test]
fn a_confirmed_import_lands_the_files_tags_matched_to_the_maps_by_name() {
    let mut store = store_tagged(&[tag(5, "Shared")]);
    let parsed = ParsedMap {
        locations: vec![loc_with_tags(0, vec![1]), loc_with_tags(0, vec![1, 2])],
        tags: vec![tag(1, "shared"), tag(2, "Unique")],
        ..Default::default()
    };
    stage_parsed(&mut store, "tags-win", parsed);
    assert_eq!(store.records["tags"].len(), 1);

    let confirmed = confirm_staged(&mut store, "tags-win", &[], &[]).unwrap();
    assert!(!confirmed.auto_commit);
    assert_eq!(confirmed.imported_count, 2);
    let unique = store.records["tags"]
        .iter()
        .find_map(|(&id, rec)| (rec.name.as_deref() == Some("Unique")).then_some(id))
        .expect("Unique created");
    assert_eq!(store.records["tags"].len(), 2);
    let mut held: Vec<_> = store
        .at(&Target::Map { id: None })
        .rows(&Selector::Everything)
        .into_iter()
        .map(|l| l.tags)
        .collect();
    held.sort();
    assert_eq!(held, vec![vec![Id::new(5)], vec![Id::new(5), unique]]);
}

#[test]
fn dropping_tags_on_confirm_creates_none_of_the_files_tags() {
    let mut store = store_tagged(&[]);
    let parsed = ParsedMap {
        locations: vec![loc_with_tags(0, vec![1])],
        tags: vec![tag(1, "Unwanted")],
        ..Default::default()
    };
    stage_parsed(&mut store, "drop-win", parsed);
    confirm_staged(&mut store, "drop-win", &["tags".to_string()], &[]).unwrap();
    assert!(store.records["tags"].is_empty());
    let stored = store
        .at(&Target::Map { id: None })
        .rows(&Selector::Everything);
    assert_eq!(stored.len(), 1);
    assert!(stored[0].tags.is_empty());
}

#[test]
fn dropping_the_files_tags_still_applies_the_named_tags() {
    let mut store = store_tagged(&[tag(5, "Shared")]);
    let parsed = ParsedMap {
        locations: vec![loc_with_tags(0, vec![1]), loc_with_tags(0, vec![])],
        tags: vec![tag(1, "Unwanted")],
        ..Default::default()
    };
    let names = ["shared", "France"].map(String::from);
    stage_parsed(&mut store, "drop-bulk-win", parsed);
    confirm_staged(&mut store, "drop-bulk-win", &["tags".to_string()], &names).unwrap();

    let meta = &store.records["tags"];
    let france = meta
        .iter()
        .find_map(|(&id, rec)| (rec.name.as_deref() == Some("France")).then_some(id))
        .expect("France created");
    assert_eq!(meta.len(), 2);
    let stored = store
        .at(&Target::Map { id: None })
        .rows(&Selector::Everything);
    assert_eq!(stored.len(), 2);
    for l in &stored {
        assert_eq!(l.tags, vec![Id::new(5), france]);
    }
}

#[test]
fn header_keys_are_read_as_fields_not_substrings() {
    // A name that quotes the array key, and an escaped quote inside it, must not fool the
    // header scan: the array is the `customCoordinates` field, not the first matching bytes.
    let mut buf = br#"{"name":"say \"customCoordinates\" here","folder":"f","customCoordinates":[{"lat":1,"lng":2}]}"#.to_vec();
    let parsed = parse_single_json_mut(&mut buf);
    assert_eq!(parsed.name, "say \"customCoordinates\" here");
    assert_eq!(parsed.folder.as_deref(), Some("f"));
    assert_eq!(parsed.locations.len(), 1);
}

// -----------------------------------------------------------------------
// CSV named-header parsing
// -----------------------------------------------------------------------

#[test]
fn csv_named_headers_standard_order() {
    let csv = "lat,lng,heading,pitch,zoom,panoId\n48.8566,2.3522,90.0,-5.0,2.0,CAoSK0FGtest\n";
    let parsed = parse_csv(csv);
    assert_eq!(parsed.locations.len(), 1);
    let l = &parsed.locations[0];
    assert_eq!(l.lat, 48.8566);
    assert_eq!(l.lng, 2.3522);
    assert_eq!(l.heading, 90.0);
    assert_eq!(l.pitch, -5.0);
    assert_eq!(l.zoom, 2.0);
    assert_eq!(l.pano_id.as_deref(), Some("CAoSK0FGtest"));
    assert!(l.flags.contains(LocationFlags::LOAD_AS_PANO_ID));
}

#[test]
fn csv_named_headers_reordered_columns() {
    let csv = "heading,lng,pitch,lat,zoom\n90.0,2.3522,-5.0,48.8566,2.0\n";
    let parsed = parse_csv(csv);
    assert_eq!(parsed.locations.len(), 1);
    let l = &parsed.locations[0];
    assert_eq!(l.lat, 48.8566);
    assert_eq!(l.lng, 2.3522);
    assert_eq!(l.heading, 90.0);
    assert_eq!(l.pitch, -5.0);
    assert_eq!(l.zoom, 2.0);
}

#[test]
fn csv_named_headers_missing_optional_columns() {
    let csv = "lat,lng\n10.0,20.0\n30.0,40.0\n";
    let parsed = parse_csv(csv);
    assert_eq!(parsed.locations.len(), 2);
    assert_eq!(parsed.locations[0].heading, 0.0);
    assert_eq!(parsed.locations[0].pitch, 0.0);
    assert_eq!(parsed.locations[0].zoom, 0.0);
    assert!(parsed.locations[0].pano_id.is_none());
    assert!(!parsed.locations[0]
        .flags
        .contains(LocationFlags::LOAD_AS_PANO_ID));
}

#[test]
fn csv_named_headers_case_insensitive() {
    let csv = "Latitude,Longitude,Heading\n48.0,2.0,90.0\n";
    let parsed = parse_csv(csv);
    assert_eq!(parsed.locations.len(), 1);
    assert_eq!(parsed.locations[0].lat, 48.0);
    assert_eq!(parsed.locations[0].lng, 2.0);
    assert_eq!(parsed.locations[0].heading, 90.0);
}

#[test]
fn csv_named_headers_alternative_column_names() {
    let csv = "lat,lon,panoid\n10.0,20.0,PANO123\n";
    let parsed = parse_csv(csv);
    assert_eq!(parsed.locations.len(), 1);
    assert_eq!(parsed.locations[0].lng, 20.0);
    assert_eq!(parsed.locations[0].pano_id.as_deref(), Some("PANO123"));
}

#[test]
fn csv_named_headers_empty_pano_field() {
    let csv = "lat,lng,panoId\n10.0,20.0,\n30.0,40.0,PANO\n";
    let parsed = parse_csv(csv);
    assert_eq!(parsed.locations.len(), 2);
    assert!(
        parsed.locations[0].pano_id.is_none(),
        "empty pano stays None"
    );
    assert_eq!(parsed.locations[1].pano_id.as_deref(), Some("PANO"));
}

#[test]
fn csv_named_headers_whitespace_in_header() {
    let csv = " lat , lng , heading \n10.0,20.0,45.0\n";
    let parsed = parse_csv(csv);
    assert_eq!(parsed.locations.len(), 1);
    assert_eq!(parsed.locations[0].lat, 10.0);
    assert_eq!(parsed.locations[0].heading, 45.0);
}

#[test]
fn csv_skips_rows_with_non_numeric_lat() {
    let csv = "lat,lng\n10.0,20.0\nbad,30.0\n50.0,60.0\n";
    let parsed = parse_csv(csv);
    assert_eq!(parsed.locations.len(), 2);
    assert_eq!(parsed.locations[0].lat, 10.0);
    assert_eq!(parsed.locations[1].lat, 50.0);
}

#[test]
fn csv_positional_fallback_first_row_is_data() {
    let csv = "10.0,20.0\n30.0,40.0\n";
    let parsed = parse_csv(csv);
    assert_eq!(parsed.locations.len(), 2);
    assert_eq!(parsed.locations[0].lat, 10.0);
    assert_eq!(parsed.locations[0].lng, 20.0);
}

// -----------------------------------------------------------------------
// UTF-8 BOM handling
// -----------------------------------------------------------------------

#[test]
fn csv_with_utf8_bom_parses_correctly() {
    let csv = "\u{FEFF}lat,lng,heading\n48.8566,2.3522,90.0\n";
    let parsed = parse_csv(csv);
    assert_eq!(parsed.locations.len(), 1);
    assert_eq!(parsed.locations[0].lat, 48.8566);
    assert_eq!(parsed.locations[0].heading, 90.0);
}

#[test]
fn json_with_utf8_bom_parses_via_parse_file() {
    let mut buf = vec![0xEF, 0xBB, 0xBF];
    buf.extend_from_slice(br#"{"customCoordinates":[{"lat":1,"lng":2}]}"#);
    let parsed = parse_file(&mut buf);
    assert_eq!(parsed.locations.len(), 1);
    assert_eq!(parsed.locations[0].lat, 1.0);
}

#[test]
fn csv_with_bom_via_parse_file() {
    let mut buf = vec![0xEF, 0xBB, 0xBF];
    buf.extend_from_slice(b"lat,lng\n10.0,20.0\n");
    let parsed = parse_file(&mut buf);
    assert_eq!(parsed.locations.len(), 1);
    assert_eq!(parsed.locations[0].lat, 10.0);
}
