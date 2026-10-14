use super::*;
use crate::selections::PolygonGeometry;
use crate::test_util;
use crate::util::now_unix;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::async_runtime;

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
    let pieces = async_runtime::block_on(polygon_fill(drawn.clone()));
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
    assert!(async_runtime::block_on(polygon_fill(flat)).is_empty());
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

fn named_rows(store: &mut Store) -> Vec<(f64, f64, Vec<String>)> {
    let rows = store
        .at(&Target::Map { id: None })
        .rows(&Selector::Everything);
    rows.iter()
        .map(|row| {
            let names = row
                .tags
                .iter()
                .map(|&id| {
                    let record = store.value_record("tags", id).unwrap();
                    record.name.clone().unwrap()
                })
                .collect();
            (row.lat, row.lng, names)
        })
        .collect()
}

fn tag_names(store: &Store) -> Vec<String> {
    let mut names: Vec<_> = store.records["tags"]
        .values()
        .filter_map(|r| r.name.clone())
        .collect();
    names.sort();
    names
}

#[test]
fn a_copy_lands_the_same_in_an_open_and_a_closed_target() {
    let mut source = tagged_map(
        "copy-src",
        &[(1, "shared"), (2, "Only here"), (3, "Unused")],
    );
    let mut copies = vec![test_util::loc(0, 1.0, 1.0), test_util::loc(0, 2.0, 2.0)];
    copies[0].tags = test_util::tag_ids([1]);
    copies[1].tags = test_util::tag_ids([1, 2]);
    let adds = copies.into_iter().map(Op::Add).collect();
    source
        .at(&Target::Map { id: None })
        .edit(adds, IncomingRecords::new(), &mut None);

    let closed = storage::tests::map_on_disk("copy-closed");
    let open = Id::<MapMeta, String>::new("copy-open".into());
    let window = WindowLabel("w".into());
    let mut mgr = StoreManager::new();
    mgr.stores.insert(source.meta.id.clone(), source);
    mgr.window_map
        .insert(window.clone(), Id::new("copy-src".into()));
    mgr.stores
        .insert(open.clone(), tagged_map("copy-open", &[(7, "Shared")]));
    let state = StoreState::new(mgr);
    let at_closed = Target::Map {
        id: Some(closed.clone()),
    };
    with_target(&state, &window, &at_closed, |store| {
        let shared = ValueRecord {
            name: Some("Shared".into()),
            ..Default::default()
        };
        store.edit_values("tags", vec![Op::Add(shared)])
    })
    .unwrap();
    let steps = |store: &Store| store.steps[Timeline::Edits].len(Stack::Undo);
    let before = steps(&load_store(&closed).unwrap());

    let copy = |to: &Id<MapMeta, String>| {
        let c = copy_locations_to_map(&state, &window, to.clone(), Selector::Everything).unwrap();
        (c.copied, c.skipped)
    };
    assert_eq!(copy(&open), (2, 0));
    assert_eq!(copy(&closed), (2, 0));

    let mut reopened = load_store(&closed).unwrap();
    assert_eq!(steps(&reopened), before + 1);
    let mut mgr = state.lock().unwrap();
    let live = mgr.store_for_map(&open).unwrap();
    assert_eq!(named_rows(live), named_rows(&mut reopened));
    assert_eq!(
        named_rows(live)[1].2,
        ["Shared".to_string(), "Only here".to_string()]
    );
    assert_eq!(tag_names(live), ["Only here", "Shared"]);
    assert_eq!(tag_names(&reopened), ["Only here", "Shared"]);
    assert!(live.pending.is_empty() && reopened.pending.is_empty());
    drop(mgr);

    assert_eq!(copy(&closed), (0, 2));
    assert_eq!(copy(&open), (0, 2));
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
        IncomingRecords,
    ) -> AppResult<MutationResult> = store_edit;
}

#[test]
fn opening_a_map_waits_while_its_files_are_being_written() {
    let map = storage::tests::map_on_disk("open-locked");
    let state = Arc::new(StoreState::new(StoreManager::new()));
    let files = state.lock().unwrap().files(&map);
    let writing = files.blocking_lock();

    let opening = thread::spawn({
        let (state, map) = (state.clone(), map.clone());
        move || {
            async_runtime::block_on(open_claimed_map(&WindowLabel("w".into()), &state, map))
                .unwrap();
        }
    });
    thread::sleep(Duration::from_millis(100));
    assert!(!opening.is_finished(), "the open must wait for the writer");
    assert!(!state.lock().unwrap().stores.contains_key(&map));

    drop(writing);
    opening.join().unwrap();
    assert!(state.lock().unwrap().stores.contains_key(&map));
}

fn with_rows(id: &str, rows: &[Location]) -> Store {
    let mut store = tagged_map(id, &[]);
    let adds = rows.iter().cloned().map(Op::Add).collect();
    store
        .at(&Target::Map { id: None })
        .edit(adds, IncomingRecords::new(), &mut None);
    store
}

fn copy_over(existing: &[Location], sources: &[Location]) -> (Vec<Location>, u32) {
    let window = WindowLabel("w".into());
    let target = Id::<MapMeta, String>::new("dst".into());
    let mut mgr = StoreManager::new();
    mgr.stores
        .insert(Id::new("src".into()), with_rows("src", sources));
    mgr.window_map.insert(window.clone(), Id::new("src".into()));
    mgr.stores
        .insert(target.clone(), with_rows("dst", existing));
    let state = StoreState::new(mgr);
    let before = existing.len();
    let copied =
        copy_locations_to_map(&state, &window, target.clone(), Selector::Everything).unwrap();
    let mut mgr = state.lock().unwrap();
    let rows = mgr
        .store_for_map(&target)
        .unwrap()
        .at(&Target::Map { id: None })
        .rows(&Selector::Everything);
    assert_eq!(rows.len() - before, copied.copied as usize);
    (rows[before..].to_vec(), copied.skipped)
}

fn at_pano(lat: f64, lng: f64, pano: &str) -> Location {
    Location {
        pano_id: Some(pano.into()),
        ..test_util::loc(0, lat, lng)
    }
}

#[test]
fn a_copy_skips_by_pano_id_before_coordinates() {
    let existing = [at_pano(10.0, 20.0, "AAA")];
    // Same pano, different coords: held. Different pano, same coords: copied.
    let sources = [at_pano(99.0, 99.0, "AAA"), at_pano(10.0, 20.0, "BBB")];
    let (fresh, skipped) = copy_over(&existing, &sources);
    assert_eq!(skipped, 1);
    assert_eq!(fresh.len(), 1);
    assert_eq!(fresh[0].pano_id.as_deref(), Some("BBB"));
}

#[test]
fn a_copy_skips_a_panoless_location_by_its_exact_coordinates() {
    let existing = [test_util::loc(0, 10.0, 20.0), at_pano(30.0, 40.0, "CCC")];
    let sources = [
        test_util::loc(0, 10.0, 20.0),
        test_util::loc(0, 30.0, 40.0),
        test_util::loc(0, 10.0, 20.000001),
    ];
    let (fresh, skipped) = copy_over(&existing, &sources);
    // The first matches pano-less coords, the second CCC's coords; the third is off by
    // 1e-6, and only exact bits match.
    assert_eq!(skipped, 2);
    assert_eq!(fresh.len(), 1);
    assert_eq!((fresh[0].lat, fresh[0].lng), (10.0, 20.000001));
}

#[test]
fn a_copy_treats_an_empty_pano_as_none() {
    let existing = [at_pano(10.0, 20.0, "")];
    let (_, skipped) = copy_over(&existing, &[at_pano(10.0, 20.0, "")]);
    assert_eq!(skipped, 1);
}

#[test]
fn a_copied_location_is_created_now() {
    let source = Location {
        created_at: 5,
        ..test_util::loc(0, 10.0, 20.0)
    };
    let now = now_unix();
    let (fresh, _) = copy_over(&[], &[source]);
    assert_eq!(fresh.len(), 1);
    assert!(fresh[0].created_at >= now);
    assert_eq!(fresh[0].modified_at, None);
}

#[test]
fn a_plain_add_on_the_open_map_never_skips_a_row_it_holds() {
    let mut store = with_rows("m", &[at_pano(10.0, 20.0, "AAA")]);
    let added = store.at(&Target::Map { id: None }).edit(
        vec![Op::Add(at_pano(10.0, 20.0, "AAA"))],
        IncomingRecords::new(),
        &mut None,
    );
    assert_eq!(added.keys.len(), 1);
}

#[test]
fn an_edit_at_a_map_this_window_does_not_watch_settles_at_once() {
    let mut store = with_rows("other", &[]);
    let window = WindowLabel("w".into());
    let at_other = Target::Map {
        id: Some(Id::new("other".into())),
    };
    let edit = |store: &mut Store, target: &Target, lat: f64| {
        let mutation = store.at(target).edit(
            vec![Op::Add(test_util::loc(0, lat, 2.0))],
            IncomingRecords::new(),
            &mut None,
        );
        receipt(store, &window, target, mutation)
    };
    let there = edit(&mut store, &at_other, 1.0);
    assert_eq!(there.mutation.version, 0);
    assert_eq!(there.mutation.keys.len(), 1);

    let here = edit(&mut store, &Target::Map { id: None }, 3.0);
    assert_eq!(here.mutation.version, store.version);
}
