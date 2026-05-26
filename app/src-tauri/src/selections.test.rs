use super::*;
use crate::types::Location;
use crate::arrow_bridge::locations_to_batch;

fn loc(id: u32, lat: f64, lng: f64) -> Location {
    Location {
        id, lat, lng, heading: 0.0, pitch: 0.0, zoom: 1.0,
        pano_id: None, flags: 0, tags: vec![], extra: None,
        created_at: String::new(), modified_at: None,
    }
}

fn make_view<'a>(
    batch: Option<&'a RecordBatch>,
    dead: &'a HashSet<u32>,
    patches: &'a HashMap<u32, Location>,
    adds: &'a [Location],
) -> LocView<'a> {
    LocView::new(batch, dead, patches, adds)
}

// -----------------------------------------------------------------------
// Geometry: point_in_ring / point_in_polygon
// -----------------------------------------------------------------------

#[test]
fn point_inside_square() {
    let ring = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0], [0.0, 0.0]];
    assert!(point_in_ring(5.0, 5.0, &ring));
}

#[test]
fn point_outside_square() {
    let ring = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0], [0.0, 0.0]];
    assert!(!point_in_ring(15.0, 5.0, &ring));
}

#[test]
fn point_in_polygon_with_hole() {
    let outer = vec![[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0], [0.0, 0.0]];
    let hole = vec![[5.0, 5.0], [15.0, 5.0], [15.0, 15.0], [5.0, 15.0], [5.0, 5.0]];
    let coords = vec![outer, hole];
    assert!(point_in_polygon(2.0, 2.0, &coords)); // outside hole, inside outer
    assert!(!point_in_polygon(10.0, 10.0, &coords)); // inside hole
}

#[test]
fn point_in_geometry_extra_polygons() {
    let main = vec![vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0], [0.0, 0.0]]];
    let extra = vec![vec![[20.0, 20.0], [30.0, 20.0], [30.0, 30.0], [20.0, 30.0], [20.0, 20.0]]];
    let geom = PolygonGeometry {
        coordinates: main,
        extra_polygons: Some(vec![extra]),
        properties: None,
    };
    assert!(point_in_geometry(5.0, 5.0, &geom));
    assert!(point_in_geometry(25.0, 25.0, &geom));
    assert!(!point_in_geometry(15.0, 15.0, &geom));
}

// -----------------------------------------------------------------------
// Haversine
// -----------------------------------------------------------------------

#[test]
fn haversine_zero_distance() {
    assert_eq!(haversine_m(0.0, 0.0, 0.0, 0.0), 0.0);
}

#[test]
fn haversine_known_distance() {
    // London to Paris ~ 343 km
    let d = haversine_m(51.5074, -0.1278, 48.8566, 2.3522);
    assert!((d - 343_500.0).abs() < 5000.0, "London-Paris should be ~343km, got {:.0}m", d);
}

// -----------------------------------------------------------------------
// iso_to_unix
// -----------------------------------------------------------------------

#[test]
fn iso_unix_epoch() {
    assert_eq!(iso_to_unix("1970-01-01T00:00:00Z"), Some(0.0));
}

#[test]
fn iso_known_date() {
    // 2024-01-01T00:00:00Z = 1704067200
    let ts = iso_to_unix("2024-01-01T00:00:00Z").unwrap();
    assert_eq!(ts, 1704067200.0);
}

#[test]
fn iso_invalid_returns_none() {
    assert!(iso_to_unix("not-a-date").is_none());
}

// -----------------------------------------------------------------------
// compare_filter
// -----------------------------------------------------------------------

#[test]
fn filter_eq_string() {
    assert!(compare_filter(&serde_json::json!("BR"), "eq", &serde_json::json!("BR"), None));
    assert!(!compare_filter(&serde_json::json!("US"), "eq", &serde_json::json!("BR"), None));
}

#[test]
fn filter_neq() {
    assert!(compare_filter(&serde_json::json!("US"), "neq", &serde_json::json!("BR"), None));
    assert!(!compare_filter(&serde_json::json!("BR"), "neq", &serde_json::json!("BR"), None));
}

#[test]
fn filter_gt_numeric() {
    assert!(compare_filter(&serde_json::json!(100), "gt", &serde_json::json!(50), None));
    assert!(!compare_filter(&serde_json::json!(50), "gt", &serde_json::json!(100), None));
}

#[test]
fn filter_between() {
    assert!(compare_filter(&serde_json::json!(500), "between", &serde_json::json!(100), Some(&serde_json::json!(1000))));
    assert!(!compare_filter(&serde_json::json!(50), "between", &serde_json::json!(100), Some(&serde_json::json!(1000))));
}

#[test]
fn filter_between_anyyear_normal_range() {
    // April 15 2023 00:00 UTC = 1681516800
    let apr15 = serde_json::json!(1681516800.0);
    // May 1 2021 00:00 UTC = 1619827200
    let may1 = serde_json::json!(1619827200.0);
    // June 10 2020 00:00 UTC = 1591747200
    let jun10 = serde_json::json!(1591747200.0);

    let lo = serde_json::json!("04-15");
    let hi = serde_json::json!("05-15");

    assert!(compare_filter(&apr15, "between_anyyear", &lo, Some(&hi)));
    assert!(compare_filter(&may1, "between_anyyear", &lo, Some(&hi)));
    assert!(!compare_filter(&jun10, "between_anyyear", &lo, Some(&hi)));
}

#[test]
fn filter_between_anyyear_wrapping_range() {
    // Dec 1 2022 00:00 UTC = 1669852800
    let dec1 = serde_json::json!(1669852800.0);
    // Jan 15 2023 00:00 UTC = 1673740800
    let jan15 = serde_json::json!(1673740800.0);
    // July 4 2021 00:00 UTC = 1625356800
    let jul4 = serde_json::json!(1625356800.0);

    let lo = serde_json::json!("11-15");
    let hi = serde_json::json!("02-15");

    assert!(compare_filter(&dec1, "between_anyyear", &lo, Some(&hi)));
    assert!(compare_filter(&jan15, "between_anyyear", &lo, Some(&hi)));
    assert!(!compare_filter(&jul4, "between_anyyear", &lo, Some(&hi)));
}

#[test]
fn filter_between_anyyear_string_field() {
    let ym = serde_json::json!("2023-04");
    let lo = serde_json::json!("03-01");
    let hi = serde_json::json!("05-01");
    assert!(compare_filter(&ym, "between_anyyear", &lo, Some(&hi)));

    let ym_out = serde_json::json!("2023-07");
    assert!(!compare_filter(&ym_out, "between_anyyear", &lo, Some(&hi)));
}

#[test]
fn filter_has_nothas() {
    assert!(compare_filter(&serde_json::json!("anything"), "has", &serde_json::json!(null), None));
    assert!(!compare_filter(&serde_json::json!("anything"), "nothas", &serde_json::json!(null), None));
}

#[test]
fn val_eq_same_type() {
    assert!(val_eq(&serde_json::json!("BR"), &serde_json::json!("BR")));
    assert!(val_eq(&serde_json::json!(42), &serde_json::json!(42)));
    assert!(!val_eq(&serde_json::json!("a"), &serde_json::json!("b")));
}

// TODO: val_eq's comment claims cross-type comparison (e.g. Number(2) vs
// String("2")), but it doesn't work. The cross-type branch extracts the
// &str from the String side and compares via serde_json's PartialEq<&str>
// for Value, which only matches Value::String — it won't coerce Number to
// string. The entire cross-type block is effectively dead code; the
// function reduces to just `a == b`. This means Filter "eq" with
// mismatched types (e.g. altitude stored as Number(100), filter value
// String("100")) will silently match nothing.
#[test]
#[should_panic]
fn val_eq_cross_type_is_broken() {
    assert!(val_eq(&serde_json::json!(2), &serde_json::json!("2")));
    assert!(val_eq(&serde_json::json!("2"), &serde_json::json!(2)));
}

// -----------------------------------------------------------------------
// resolve with LocView (overlay adds only, no batch)
// -----------------------------------------------------------------------

#[test]
fn resolve_everything() {
    let dead = HashSet::new();
    let patches = HashMap::new();
    let adds = vec![loc(1, 10.0, 20.0), loc(2, 30.0, 40.0)];
    let view = make_view(None, &dead, &patches, &adds);
    let ids = resolve(&view, &SelectionProps::Everything);
    assert_eq!(ids.len(), 2);
}

#[test]
fn resolve_tag_on_adds() {
    let dead = HashSet::new();
    let patches = HashMap::new();
    let mut l1 = loc(1, 0.0, 0.0);
    l1.tags = vec![10];
    let l2 = loc(2, 0.0, 0.0);
    let adds = vec![l1, l2];
    let view = make_view(None, &dead, &patches, &adds);
    let ids = resolve(&view, &SelectionProps::Tag { tag_id: 10 });
    assert_eq!(ids, vec![1]);
}

#[test]
fn resolve_untagged() {
    let dead = HashSet::new();
    let patches = HashMap::new();
    let mut l1 = loc(1, 0.0, 0.0);
    l1.tags = vec![10];
    let l2 = loc(2, 0.0, 0.0);
    let adds = vec![l1, l2];
    let view = make_view(None, &dead, &patches, &adds);
    let ids = resolve(&view, &SelectionProps::Untagged);
    assert_eq!(ids, vec![2]);
}

#[test]
fn resolve_unpanned() {
    let dead = HashSet::new();
    let patches = HashMap::new();
    let l1 = loc(1, 0.0, 0.0); // heading = 0
    let mut l2 = loc(2, 0.0, 0.0);
    l2.heading = 90.0;
    let adds = vec![l1, l2];
    let view = make_view(None, &dead, &patches, &adds);
    let ids = resolve(&view, &SelectionProps::Unpanned);
    assert_eq!(ids, vec![1]);
}

#[test]
fn resolve_panoids() {
    let dead = HashSet::new();
    let patches = HashMap::new();
    let mut l1 = loc(1, 0.0, 0.0);
    l1.flags = LOAD_AS_PANO_ID;
    let l2 = loc(2, 0.0, 0.0);
    let adds = vec![l1, l2];
    let view = make_view(None, &dead, &patches, &adds);
    let pano = resolve(&view, &SelectionProps::PanoIds);
    let not_pano = resolve(&view, &SelectionProps::NotPanoIds);
    assert_eq!(pano, vec![1]);
    assert_eq!(not_pano, vec![2]);
}

#[test]
fn resolve_with_dead_batch_rows() {
    let locs = vec![loc(1, 10.0, 20.0), loc(2, 30.0, 40.0), loc(3, 50.0, 60.0)];
    let batch = locations_to_batch(&locs);
    let mut dead = HashSet::new();
    dead.insert(2);
    let patches = HashMap::new();
    let adds: Vec<Location> = vec![];
    let view = make_view(Some(&batch), &dead, &patches, &adds);
    let ids = resolve(&view, &SelectionProps::Everything);
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&1));
    assert!(ids.contains(&3));
    assert!(!ids.contains(&2));
}

#[test]
fn resolve_with_patched_tags() {
    let locs = vec![loc(1, 0.0, 0.0), loc(2, 0.0, 0.0)];
    let batch = locations_to_batch(&locs);
    let dead = HashSet::new();
    let mut patched = loc(1, 0.0, 0.0);
    patched.tags = vec![10];
    let mut patches = HashMap::new();
    patches.insert(1, patched);
    let adds: Vec<Location> = vec![];
    let view = make_view(Some(&batch), &dead, &patches, &adds);
    let ids = resolve(&view, &SelectionProps::Tag { tag_id: 10 });
    assert_eq!(ids, vec![1]);
}

// -----------------------------------------------------------------------
// Composite selections
// -----------------------------------------------------------------------

#[test]
fn resolve_intersection() {
    let dead = HashSet::new();
    let patches = HashMap::new();
    let mut l1 = loc(1, 0.0, 0.0);
    l1.tags = vec![10];
    l1.flags = LOAD_AS_PANO_ID;
    let mut l2 = loc(2, 0.0, 0.0);
    l2.tags = vec![10];
    let mut l3 = loc(3, 0.0, 0.0);
    l3.flags = LOAD_AS_PANO_ID;
    let adds = vec![l1, l2, l3];
    let view = make_view(None, &dead, &patches, &adds);
    let props = SelectionProps::Intersection {
        selections: vec![
            Selection { key: "a".into(), color: [0,0,0], count: None, props: SelectionProps::Tag { tag_id: 10 } },
            Selection { key: "b".into(), color: [0,0,0], count: None, props: SelectionProps::PanoIds },
        ],
    };
    let ids = resolve(&view, &props);
    assert_eq!(ids, vec![1]); // only l1 has both tag 10 and PanoId flag
}

#[test]
fn resolve_union() {
    let dead = HashSet::new();
    let patches = HashMap::new();
    let mut l1 = loc(1, 0.0, 0.0);
    l1.tags = vec![10];
    let mut l2 = loc(2, 0.0, 0.0);
    l2.flags = LOAD_AS_PANO_ID;
    let l3 = loc(3, 0.0, 0.0);
    let adds = vec![l1, l2, l3];
    let view = make_view(None, &dead, &patches, &adds);
    let props = SelectionProps::Union {
        selections: vec![
            Selection { key: "a".into(), color: [0,0,0], count: None, props: SelectionProps::Tag { tag_id: 10 } },
            Selection { key: "b".into(), color: [0,0,0], count: None, props: SelectionProps::PanoIds },
        ],
    };
    let ids = resolve(&view, &props);
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&1));
    assert!(ids.contains(&2));
}

#[test]
fn resolve_invert() {
    let dead = HashSet::new();
    let patches = HashMap::new();
    let mut l1 = loc(1, 0.0, 0.0);
    l1.flags = LOAD_AS_PANO_ID;
    let l2 = loc(2, 0.0, 0.0);
    let l3 = loc(3, 0.0, 0.0);
    let adds = vec![l1, l2, l3];
    let view = make_view(None, &dead, &patches, &adds);
    let props = SelectionProps::Invert {
        selections: vec![
            Selection { key: "a".into(), color: [0,0,0], count: None, props: SelectionProps::PanoIds },
        ],
    };
    let ids = resolve(&view, &props);
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&2));
    assert!(ids.contains(&3));
}

// -----------------------------------------------------------------------
// Duplicates
// -----------------------------------------------------------------------

#[test]
fn duplicates_finds_nearby() {
    let dead = HashSet::new();
    let patches = HashMap::new();
    let adds = vec![
        loc(1, 51.5000, -0.1000),
        loc(2, 51.5000, -0.1000), // exact same
        loc(3, 0.0, 0.0),         // far away
    ];
    let view = make_view(None, &dead, &patches, &adds);
    let ids = resolve(&view, &SelectionProps::Duplicates { distance: 1.0 });
    assert!(ids.contains(&1));
    assert!(ids.contains(&2));
    assert!(!ids.contains(&3));
}

// -----------------------------------------------------------------------
// Filter on adds
// -----------------------------------------------------------------------

#[test]
fn extra_filter_eq_on_adds() {
    let dead = HashSet::new();
    let patches = HashMap::new();
    let mut l1 = loc(1, 0.0, 0.0);
    l1.extra = Some(serde_json::from_str(r#"{"country":"BR"}"#).unwrap());
    let mut l2 = loc(2, 0.0, 0.0);
    l2.extra = Some(serde_json::from_str(r#"{"country":"US"}"#).unwrap());
    let adds = vec![l1, l2];
    let view = make_view(None, &dead, &patches, &adds);
    let ids = resolve(&view, &SelectionProps::Filter {
        field: "country".into(), op: "eq".into(),
        value: serde_json::json!("BR"), value2: None,
    });
    assert_eq!(ids, vec![1]);
}
