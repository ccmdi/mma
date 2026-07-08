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

/// Scan `extra` from a buffer and pull tag meta, as the parse path does internally.
fn tag_meta(buf: &[u8]) -> HashMap<String, ExtraTagMeta> {
    find_top_level_extra(buf, 0, 0).as_ref().map(tag_meta_from_extra).unwrap_or_default()
}

#[test]
fn tag_meta_reads_color_and_order() {
    let json = br#"{"customCoordinates":[],"extra":{"tags":{"Roof":{"color":[255,0,0],"order":3},"Wall":{"color":[0,128,255],"order":1}}}}"#;
    let meta = tag_meta(json);
    assert_eq!(meta.len(), 2);

    let roof = &meta["Roof"];
    assert_eq!(roof.color.as_deref(), Some("#ff0000"));
    assert_eq!(roof.order, Some(3));

    let wall = &meta["Wall"];
    assert_eq!(wall.color.as_deref(), Some("#0080ff"));
    assert_eq!(wall.order, Some(1));
}

#[test]
fn tag_meta_missing_order() {
    let json = br#"{"extra":{"tags":{"NoOrder":{"color":[10,20,30]}}}}"#;
    let meta = tag_meta(json);
    let tag = &meta["NoOrder"];
    assert_eq!(tag.color.as_deref(), Some("#0a141e"));
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

    let merged = merge_settings(crate::map_meta::MapSettings::default(), &parsed.settings);
    assert_eq!(merged.virtual_tags["Europe"].color.as_deref(), Some("#c0f0f8"));
    assert_eq!(merged.virtual_tags["Europe/France"].color.as_deref(), Some("#183848"));
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

    let mut base = crate::map_meta::MapSettings::default();
    base.point_along_road = false; // non-default, unrelated key
    base.virtual_tags.insert("Europe".into(), crate::map_meta::VirtualTag { color: Some("#existing".into()) });

    let merged = merge_settings(base, &parsed.settings);
    assert!(!merged.point_along_road, "key absent from the overlay keeps its base value");
    assert_eq!(merged.virtual_tags["Asia"].color.as_deref(), Some("#asia"), "imported key applied");
    // A present key replaces wholesale (shallow overlay), so base's Europe is gone.
    assert!(!merged.virtual_tags.contains_key("Europe"), "present key replaces the whole value");
}

#[test]
fn merge_settings_empty_overlay_is_base() {
    let base = crate::map_meta::MapSettings::default();
    let merged = merge_settings(base, &serde_json::Map::new());
    assert!(merged.point_along_road, "empty overlay leaves defaults untouched");
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
    assert_eq!(parse_count(br#"{"customCoordinates":[],"extra":{"tags":{}}}"#), 0);
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
    assert_eq!(parsed.tags[0].name, "X");
    assert_eq!(parsed.tags[0].order, Some(7));
    assert_eq!(parsed.tags[0].color, "#010203");
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

// -----------------------------------------------------------------------
// Raw-extra parse: the fast byte path (strip `tags`, keep the rest as raw JSON) and
// its map-path fallbacks (non-null country/state fold, nested panoId) must produce
// the same semantic result the old map-building parser did.
// -----------------------------------------------------------------------

fn parse_one(json: &[u8]) -> (Location, Vec<Tag>) {
    let mut buf = json.to_vec();
    let p = parse_single_json_mut(&mut buf);
    (p.locations.into_iter().next().expect("one location"), p.tags)
}

#[test]
fn fast_path_strips_tags_keeps_rest() {
    let (loc, tags) = parse_one(br#"{"customCoordinates":[
        {"lat":1,"lng":2,"countryCode":null,"stateCode":null,"extra":{"tags":["A","B"],"panoDate":"2025-08"}}
    ]}"#);
    let e = loc.extra.as_ref().unwrap();
    assert_eq!(e.get("panoDate").unwrap(), "2025-08");
    assert!(e.get("tags").is_none(), "tags stripped from stored extra");
    assert!(e.get("countryCode").is_none(), "null country not folded (parity with old parser)");
    assert_eq!(loc.tags.len(), 2);
    let mut names: Vec<_> = tags.iter().map(|t| t.name.clone()).collect();
    names.sort();
    assert_eq!(names, vec!["A", "B"]);
}

#[test]
fn fast_path_tags_with_special_chars() {
    // Tag strings contain `,` `]` `:` and an escaped quote — the array must be located
    // string-aware and parsed with serde (not a naive byte split).
    let (loc, _tags) = parse_one(br#"{"customCoordinates":[
        {"lat":1,"lng":2,"extra":{"tags":["a,b","c]d","e:f","q\"z"],"note":"keep"}}
    ]}"#);
    assert_eq!(loc.tags.len(), 4);
    let e = loc.extra.as_ref().unwrap();
    assert_eq!(e.get("note").unwrap(), "keep");
    assert!(e.get("tags").is_none());
}

#[test]
fn nested_tags_key_not_stripped() {
    // A `tags` key nested inside a value object must be left intact; only the depth-1
    // `tags` array is stripped.
    let (loc, _tags) = parse_one(br#"{"customCoordinates":[
        {"lat":1,"lng":2,"extra":{"meta":{"tags":5},"tags":["X"]}}
    ]}"#);
    assert_eq!(loc.tags.len(), 1);
    let e = loc.extra.as_ref().unwrap();
    assert_eq!(e.get("meta").unwrap(), serde_json::json!({"tags":5}));
    assert!(e.get("tags").is_none(), "top-level tags stripped");
}

#[test]
fn value_containing_tags_word_is_not_a_key() {
    let (loc, _tags) = parse_one(br#"{"customCoordinates":[
        {"lat":1,"lng":2,"extra":{"note":"my tags here","panoDate":"x"}}
    ]}"#);
    assert!(loc.tags.is_empty());
    let e = loc.extra.as_ref().unwrap();
    assert_eq!(e.get("note").unwrap(), "my tags here");
    assert_eq!(e.get("panoDate").unwrap(), "x");
}

#[test]
fn non_null_country_state_folded_into_extra() {
    let (loc, _tags) = parse_one(br#"{"customCoordinates":[
        {"lat":1,"lng":2,"countryCode":"US","stateCode":"CA","extra":{"tags":["X"]}}
    ]}"#);
    let e = loc.extra.as_ref().unwrap();
    assert_eq!(e.get("countryCode").unwrap(), "US");
    assert_eq!(e.get("stateCode").unwrap(), "CA");
    assert_eq!(loc.tags.len(), 1);
}

#[test]
fn pano_id_nested_in_extra_extracted() {
    let (loc, _tags) = parse_one(br#"{"customCoordinates":[
        {"lat":1,"lng":2,"extra":{"panoId":"PANO123","tags":["X"]}}
    ]}"#);
    assert_eq!(loc.pano_id.as_deref(), Some("PANO123"));
    assert!(!loc.flags.contains(LocationFlags::LOAD_AS_PANO_ID), "nested panoId is not a top-level pano");
    assert_eq!(loc.tags.len(), 1);
    // panoId consumed out of extra, only tags were there → no extra left
    assert!(loc.extra.is_none());
}

#[test]
fn extra_with_only_tags_becomes_none() {
    let (loc, _tags) = parse_one(br#"{"customCoordinates":[
        {"lat":1,"lng":2,"extra":{"tags":["X"]}}
    ]}"#);
    assert!(loc.extra.is_none());
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
        if i > 0 { s.push_str(sep); }
        if with_extra {
            // extra with braces/commas inside strings to stress skip_string across ranges
            s.push_str(&format!(
                r#"{{"lat":{}.5,"lng":{}.25,"panoId":"pano{}","extra":{{"note":"a}},{{b][{}","tags":["T{}","common"]}}}}"#,
                i % 90, i % 180, i, i, i % 7));
        } else {
            s.push_str(&format!(r#"{{"lat":{}.5,"lng":{}.25,"heading":0,"panoId":null}}"#, i % 90, i % 180));
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
    assert!(arr.len() > 2_000_000, "fixture must cross the parallel threshold");
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
    fn enabled(&self, _: &log::Metadata) -> bool { true }
    fn log(&self, record: &log::Record) { eprintln!("{}", record.args()); }
    fn flush(&self) {}
}
static STDERR_LOG: StderrLog = StderrLog;

#[test]
#[ignore]
fn bench_parse_real() {
    let _ = log::set_logger(&STDERR_LOG);
    log::set_max_level(log::LevelFilter::Debug);
    let path = match std::env::var("MMA_BENCH_FILE") {
        Ok(p) => p,
        Err(_) => { eprintln!("SKIP bench: MMA_BENCH_FILE not set"); return; }
    };

    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => { eprintln!("SKIP bench: cannot read {path}: {e}"); return; }
    };
    eprintln!("file={} size={:.1}MB", path, bytes.len() as f64 / 1e6);

    let iters = 5;
    let mut best_parse = f64::MAX;
    let mut best_build = f64::MAX;
    let mut locs = 0usize;
    for i in 0..iters {
        let mut buf = bytes.clone();
        let t0 = std::time::Instant::now();
        let parsed = parse_file(&mut buf);
        let t_parse = t0.elapsed().as_secs_f64() * 1e3;
        locs = parsed.locations.len();

        let t1 = std::time::Instant::now();
        let _preview = build_preview(parsed).expect("build_preview");
        let t_build = t1.elapsed().as_secs_f64() * 1e3;

        eprintln!("iter {i}: parse={t_parse:.0}ms build_preview={t_build:.0}ms");
        best_parse = best_parse.min(t_parse);
        best_build = best_build.min(t_build);
    }
    eprintln!("BEST: parse={best_parse:.0}ms build_preview={best_build:.0}ms locs={locs}");
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

// -----------------------------------------------------------------------
// Cross-map copy producer (add_copied_to_store): the core of the open-target
// branch of store_copy_locations_to_map. The cross-window event ships exactly
// this MutationResult for the receiving window's mutate(), so it must carry the
// copied locations with allocated ids, name-reconciled tags, and bumped counts.
// (The open-target branch is two-window-only, unreachable from a single webview,
// so this is its sole regression guard. e2e covers the closed-target branch.)
// -----------------------------------------------------------------------

#[test]
fn add_copied_reconciles_tags_and_reports_counts() {
    // Target already defines "Shared" (id 5). The copies reference the *source*
    // map's own tag ids (1 = Shared, 2 = Unique), as a real cross-map copy would.
    let mut store = store_with_tags(&[tag(5, "Shared")]);
    let copies = vec![loc_with_tags(1, vec![1]), loc_with_tags(2, vec![1, 2])];
    let source_tags = vec![tag(1, "Shared"), tag(2, "Unique")];

    let r = add_copied_to_store(&mut store, copies, source_tags).unwrap();

    // Both copies landed in the target store.
    assert_eq!(r.status.location_count, 2);
    let stored = store.collect_scoped(None);
    assert_eq!(stored.len(), 2);

    // "Shared" reconciled to the target's existing id 5 (no duplicate tag created).
    let shared: Vec<_> = store.tags.all.values().filter(|t| t.name == "Shared").collect();
    assert_eq!(shared.len(), 1);
    assert_eq!(shared[0].id, 5);
    // "Unique" created fresh, not reusing the source id.
    let unique = store.tags.all.values().find(|t| t.name == "Unique").expect("Unique created");
    assert_ne!(unique.id, 2);

    // Copies carry the reconciled *target* tag ids, not the source ids.
    let two_tag = stored.iter().find(|l| l.tags.len() == 2).unwrap();
    assert!(two_tag.tags.contains(&5));
    assert!(two_tag.tags.contains(&unique.id));

    // Counts in the result match membership: Shared on both copies, Unique on one.
    assert_eq!(r.status.tag_counts[&5], 2);
    assert_eq!(r.status.tag_counts[&unique.id], 1);

    // The new tag def is shipped on the result (the receiver needs it to render).
    assert!(r.tags.as_ref().and_then(|m| m.get(&unique.id)).is_some());
}
