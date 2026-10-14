use super::*;
use crate::selections::PolygonGeometry;

fn square(w: f64, s: f64, e: f64, n: f64) -> Vec<[f64; 2]> {
    vec![[w, s], [e, s], [e, n], [w, n], [w, s]]
}

fn geom(coordinates: Vec<Vec<[f64; 2]>>) -> PolygonGeometry {
    PolygonGeometry {
        coordinates,
        extra_polygons: None,
        properties: None,
    }
}

#[test]
fn crossing_bounds_keeps_a_plain_box() {
    assert_eq!(
        crossing_bounds([10.0, 0.0, 20.0, 5.0]),
        [10.0, 0.0, 20.0, 5.0]
    );
}

#[test]
fn crossing_bounds_folds_a_seam_box_to_west_past_east() {
    assert_eq!(
        crossing_bounds([170.0, -5.0, 190.0, 5.0]),
        [170.0, -5.0, -170.0, 5.0]
    );
}

#[test]
fn crossing_bounds_spells_a_full_turn_as_the_whole_world() {
    assert_eq!(
        crossing_bounds([-180.0, -85.0, 180.0, -60.0]),
        [-180.0, -85.0, 180.0, -60.0]
    );
    assert_eq!(
        crossing_bounds([100.0, -85.0, 470.0, -60.0]),
        [-180.0, -85.0, 180.0, -60.0]
    );
}

#[test]
fn polygon_bounds_spans_the_extra_polygons_too() {
    let mut g = geom(vec![square(0.0, 0.0, 10.0, 10.0)]);
    g.extra_polygons = Some(vec![vec![square(40.0, 0.0, 50.0, 10.0)]]);
    let bb = crossing_bounds(g.prepared().bbox().unwrap());
    assert_eq!(bb, [0.0, 0.0, 50.0, 10.0]);
    assert!(geom(vec![]).prepared().bbox().is_none());
}

#[test]
fn polygon_fill_covers_exactly_what_the_polygon_selects() {
    let mut drawn = geom(vec![vec![
        [0.0, 0.0],
        [2.0, 2.0],
        [2.0, 0.0],
        [0.0, 2.0],
        [0.0, 0.0],
    ]]);
    drawn.extra_polygons = Some(vec![vec![
        square(40.0, 0.0, 50.0, 10.0),
        square(44.0, 4.0, 46.0, 6.0),
    ]]);
    let pieces = tauri::async_runtime::block_on(polygon_fill(drawn.clone()));
    assert_eq!(pieces.len(), 3);
    let (first, rest) = pieces.split_first().unwrap();
    let mut fill = geom(first.clone());
    fill.extra_polygons = Some(rest.to_vec());
    let (drawn, fill) = (drawn.prepared(), fill.prepared());
    for lng in (0..=100).map(|i| f64::from(i) * 0.51 - 0.5) {
        for lat in (0..=24).map(|i| f64::from(i) * 0.47 - 0.5) {
            assert_eq!(
                fill.contains(lng, lat),
                drawn.contains(lng, lat),
                "at ({lng}, {lat})"
            );
        }
    }
}

#[test]
fn polygon_fill_of_nothing_is_empty() {
    let flat = geom(vec![vec![[0.0, 0.0], [1.0, 1.0], [2.0, 2.0], [0.0, 0.0]]]);
    assert!(tauri::async_runtime::block_on(polygon_fill(flat)).is_empty());
}

#[test]
fn seam_straddling_parts_merge_into_one_frame() {
    let mut g = geom(vec![square(170.0, -5.0, 180.0, 5.0)]);
    g.extra_polygons = Some(vec![vec![square(-180.0, -5.0, -170.0, 5.0)]]);
    let bb = crossing_bounds(g.prepared().bbox().unwrap());
    assert_eq!(bb, [170.0, -5.0, -170.0, 5.0]);
}

fn tagged_map(id: &str, tags: &[(u32, &str)]) -> Store {
    let mut store = Store::new();
    store.meta = Tracked::new(MapMeta {
        id: Id::new(id.into()),
        ..Default::default()
    });
    let records = tags
        .iter()
        .map(|&(id, name)| {
            (
                Id::new(id),
                ValueRecord {
                    id: Id::new(id),
                    name: Some(name.into()),
                    ..Default::default()
                },
            )
        })
        .collect();
    store.records.insert("tags".into(), Tracked::new(records));
    store
}

#[test]
fn a_copy_lands_the_same_in_an_open_and_a_closed_target() {
    let source = tagged_map("source", &[(1, "shared"), (2, "Only here"), (3, "Unused")]);
    let mut copies = vec![
        crate::test_util::loc(0, 1.0, 1.0),
        crate::test_util::loc(0, 2.0, 2.0),
    ];
    copies[0].tags = crate::test_util::tag_ids([1]);
    copies[1].tags = crate::test_util::tag_ids([1, 2]);
    let records = source.held_value_records();

    let mut open = tagged_map("target", &[(7, "Shared")]);
    let mut closed = tagged_map("target", &[(7, "Shared")]);
    let copied = copy_into(&mut open, copies.clone(), &records);
    assert_eq!((copied.copied, copied.skipped), (2, 0));
    copy_into(&mut closed, copies.clone(), &records);

    let landed = open.collect(&Target::Map, &Selector::Everything);
    assert!(landed == closed.collect(&Target::Map, &Selector::Everything));
    let mut names: Vec<_> = open.records["tags"]
        .values()
        .filter_map(|r| r.name.clone())
        .collect();
    names.sort();
    assert_eq!(names, ["Only here", "Shared"]);
    let only = open.records["tags"]
        .iter()
        .find_map(|(&id, r)| (r.name.as_deref() == Some("Only here")).then_some(id))
        .unwrap();
    assert_eq!(landed[1].tags, vec![Id::new(7), only]);
    assert!(open.pending.is_empty() && closed.pending.is_empty());
    assert!(closed.unsaved().unwrap().is_some());

    let again = copy_into(&mut open, copies, &records);
    assert_eq!((again.copied, again.skipped), (0, 2));
}

#[test]
fn store_edit_is_a_blocking_command_so_edits_apply_in_call_order() {
    // Sync commands run one at a time on the main thread, in the order they were invoked;
    // an async one would be spawned and could take the store lock out of order.
    let _: for<'a> fn(
        WindowLabel,
        tauri::State<'a, StoreState>,
        Target,
        Vec<Edit<Location>>,
    ) -> AppResult<MutationResult> = store_edit;
}
