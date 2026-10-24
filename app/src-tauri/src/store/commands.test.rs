use super::*;
use crate::selections::PolygonGeometry;
use crate::test_util;
use crate::test_util::{Host, Now};
use crate::util::now_unix;
use mma_algebra::{IdRange, Patch};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::async_runtime;
use tauri::ipc::InvokeResponseBody;
use tokio::time::timeout;

const MAP: Target = Target::Map { id: None };

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

fn bounds(polygon: PolygonGeometry) -> Option<[f64; 4]> {
    async_runtime::block_on(polygon_bounds(polygon))
}

/// A band from `west` eastward through `span` degrees, in steps short enough that no edge
/// reads as a jump across the antimeridian.
fn band(west: f64, span: f64, s: f64, n: f64) -> Vec<[f64; 2]> {
    let edge: Vec<f64> = (0..=3).map(|i| west + span * f64::from(i) / 3.0).collect();
    let mut ring: Vec<[f64; 2]> = edge.iter().map(|&lng| [lng, s]).collect();
    ring.extend(edge.iter().rev().map(|&lng| [lng, n]));
    ring.push([west, s]);
    ring
}

#[test]
fn edit_rows_carrying_extra_fields_arrive_whole() {
    let row = serde_json::json!({
        "id": 7, "lat": 1, "lng": 2, "heading": 0, "pitch": 0, "zoom": 0, "panoId": null,
        "flags": 0, "tags": [3], "extra": { "k": "v" }, "createdAt": 0, "modifiedAt": 0,
    });
    let Rows::Inline(InlineRows(edits)) =
        serde_json::from_value(serde_json::json!([{ "add": row }])).unwrap()
    else {
        panic!("a list of edits is inline rows");
    };
    let [Op::Add(added)] = edits.as_slice() else {
        panic!("one add");
    };
    assert_eq!(
        serde_json::to_value(added).unwrap()["extra"],
        serde_json::json!({ "k": "v" })
    );

    let uploaded: Rows = serde_json::from_value(serde_json::json!({ "session": "s" })).unwrap();
    assert!(matches!(uploaded, Rows::Uploaded { session } if session == "s"));
}

#[test]
fn polygon_bounds_keeps_a_plain_box() {
    assert_eq!(
        bounds(geom(vec![square(10.0, 0.0, 20.0, 5.0)])),
        Some([10.0, 0.0, 20.0, 5.0])
    );
}

#[test]
fn polygon_bounds_folds_a_seam_box_to_west_past_east() {
    assert_eq!(
        bounds(geom(vec![square(170.0, -5.0, 190.0, 5.0)])),
        Some([170.0, -5.0, -170.0, 5.0])
    );
}

#[test]
fn polygon_bounds_spells_a_full_turn_as_the_whole_world() {
    assert_eq!(
        bounds(geom(vec![band(-180.0, 360.0, -85.0, -60.0)])),
        Some([-180.0, -85.0, 180.0, -60.0])
    );
    assert_eq!(
        bounds(geom(vec![band(100.0, 370.0, -85.0, -60.0)])),
        Some([-180.0, -85.0, 180.0, -60.0])
    );
}

#[test]
fn polygon_bounds_spans_the_extra_polygons_too() {
    let mut g = geom(vec![square(0.0, 0.0, 10.0, 10.0)]);
    g.extra_polygons = Some(vec![vec![square(40.0, 0.0, 50.0, 10.0)]]);
    assert_eq!(bounds(g), Some([0.0, 0.0, 50.0, 10.0]));
    assert!(bounds(geom(vec![])).is_none());
}

#[test]
fn seam_straddling_parts_merge_into_one_frame() {
    let mut g = geom(vec![square(170.0, -5.0, 180.0, 5.0)]);
    g.extra_polygons = Some(vec![vec![square(-180.0, -5.0, -170.0, 5.0)]]);
    assert_eq!(bounds(g), Some([170.0, -5.0, -170.0, 5.0]));
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
    let adds: Vec<_> = copies.into_iter().map(Op::Add).collect();
    source.at(&Target::Map { id: None }).write(adds).now();

    let closed = storage::tests::map_on_disk("copy-closed");
    let open = Id::<MapMeta, String>::new("copy-open".into());
    let window = WindowLabel("w".into());
    let mut mgr = StoreManager::new();
    mgr.stores.insert(source.meta.id.clone(), source);
    mgr.holders
        .insert(Holder::Window(window.clone()), Id::new("copy-src".into()));
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
        store
            .at(&MAP)
            .field("tags")
            .unwrap()
            .write(vec![Op::Add(shared)])
            .settled()
    })
    .unwrap();
    let steps = |store: &Store| store.steps[Timeline::Edits].len(Stack::Undo);
    let before = steps(&load_store(&closed).unwrap());

    let copy = |to: &Id<MapMeta, String>| {
        let c = async_runtime::block_on(copy_locations_to_map(
            &state,
            &window,
            to.clone(),
            Selector::Everything,
        ))
        .unwrap();
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
fn every_store_change_is_queued_in_call_order_and_replies_once_it_lands() {
    let _: for<'a> fn(WindowLabel, tauri::State<'a, Writes>, Edits, Reply<Edited>) = store_edit;
    let _: for<'a> fn(
        WindowLabel,
        tauri::State<'a, Writes>,
        Target,
        Selector<SelectionInput>,
        Work,
        Reply<WorkResult>,
    ) = store_work;
    let _: for<'a> fn(WindowLabel, tauri::State<'a, Writes>, Stack, Timeline, Reply<Mutation>) =
        store_step;
    let _: for<'a> fn(WindowLabel, tauri::State<'a, Writes>, String, Reply<Mutation>) =
        store_land_layer;
    let _: for<'a> fn(
        WindowLabel,
        tauri::State<'a, Writes>,
        String,
        Option<Id<MapMeta, String>>,
        Reply<()>,
    ) = store_close_layer;
    let _: for<'a> fn(tauri::State<'a, Writes>, Patch<MapMeta>, Reply<Option<Mutation>>) =
        crate::store::maps::store_update_map_meta;
}

#[test]
fn whole_map_reads_are_spawned_off_the_main_thread() {
    fn read(
        state: tauri::State<'_, StoreState>,
        target: Target,
        selectors: Vec<Selector<SelectionInput>>,
        ask: Ask,
    ) -> impl Future<Output = AppResult<Vec<Answer>>> + '_ {
        store_read(WindowLabel("w".into()), state, target, selectors, ask)
    }
    let _ = read;
}

#[test]
fn copying_to_another_map_is_spawned_off_the_main_thread() {
    fn spawned(
        state: tauri::State<'_, StoreState>,
        target_map_id: Id<MapMeta, String>,
        selector: Selector<SelectionInput>,
    ) -> impl Future<Output = AppResult<CopyToMapResult>> + '_ {
        store_copy_locations_to_map(WindowLabel("w".into()), state, target_map_id, selector)
    }
    let _ = spawned;
}

#[test]
fn spawned_work_applies_on_a_runtime_worker_like_a_blocking_command() {
    let window = WindowLabel("w".into());
    let map = Id::<MapMeta, String>::new("spawned".into());
    let mut mgr = StoreManager::new();
    let rows = [
        test_util::loc(1, 0.0, 0.0),
        test_util::loc(2, 1.0, 1.0),
        test_util::loc(3, 2.0, 2.0),
    ];
    mgr.stores.insert(map.clone(), with_rows("spawned", &rows));
    mgr.holders
        .insert(Holder::Window(window.clone()), map.clone());
    let state = Arc::new(StoreState::new(mgr));

    let work = Work::Locations(LocationOp::Set {
        key: "pitch".into(),
        value: serde_json::json!(10.0),
    });
    let worked = async_runtime::block_on(async_runtime::spawn({
        let state = state.clone();
        async move {
            reach_target(&state, &window, &Target::Map { id: None }, |store| {
                Ok(store
                    .at(&Target::Map { id: None })
                    .scope(&Selector::Everything)
                    .write(work))
            })
            .await
        }
    }))
    .unwrap()
    .unwrap();

    assert_eq!(worked.changed, 3);
    let mut mgr = state.lock().unwrap();
    let pitches: Vec<f64> = mgr
        .store_for_map(&map)
        .unwrap()
        .at(&Target::Map { id: None })
        .rows(&Selector::Everything)
        .iter()
        .map(|row| row.pitch)
        .collect();
    assert_eq!(pitches, [10.0, 10.0, 10.0]);
}

/// A host that answers only once it holds the manager lock, as a session adopting the
/// host's change must.
struct AnsweredUnderLock {
    host: Arc<Host>,
    state: Arc<StoreState>,
    map: Id<MapMeta, String>,
}

impl Upstream for AnsweredUnderLock {
    fn send(&self, intent: Intent, recording: &mut Recording) -> Reached<EditResult> {
        let answer = self.host.send(intent, recording);
        let (host, state, map) = (self.host.clone(), self.state.clone(), self.map.clone());
        thread::spawn(move || {
            let mut mgr = state.lock().unwrap();
            host.answer(mgr.store_for_map(&map).unwrap());
        });
        answer
    }

    fn lease(&self, len: u32) -> Reached<IdRange<Location>> {
        self.host.lease(len)
    }
}

#[test]
fn an_edit_waits_for_its_host_with_the_manager_unlocked() {
    let (host, replica) = Host::pair("hosted", &[test_util::loc(0, 1.0, 1.0)]);
    let map = replica.meta.id.clone();
    let window = WindowLabel("w".into());
    let mut mgr = StoreManager::new();
    mgr.stores.insert(map.clone(), replica);
    mgr.holders
        .insert(Holder::Window(window.clone()), map.clone());
    let state = Arc::new(StoreState::new(mgr));
    state
        .lock()
        .unwrap()
        .stores
        .get_mut(&map)
        .unwrap()
        .replicate(Arc::new(AnsweredUnderLock {
            host,
            state: state.clone(),
            map: map.clone(),
        }));

    let edited = async_runtime::block_on(async_runtime::spawn({
        let state = state.clone();
        async move {
            let editing = reach_target(&state, &window, &Target::Map { id: None }, |store| {
                Ok(store
                    .at(&Target::Map { id: None })
                    .write(vec![Op::Remove(Id::new(1))]))
            });
            timeout(Duration::from_secs(10), editing).await
        }
    }))
    .unwrap()
    .expect("the edit must not wait for its host while it holds the manager lock")
    .unwrap();

    let mut mgr = state.lock().unwrap();
    let replica = mgr.store_for_map(&map).unwrap();
    assert_eq!(edited.mutation.version, replica.version);
    assert!(replica
        .at(&Target::Map { id: None })
        .rows(&Selector::Everything)
        .is_empty());
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
            async_runtime::block_on(open_claimed_map(
                &WindowLabel("w".into()),
                &state,
                map,
                Channel::new(|_| Ok(())),
            ))
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
    let adds: Vec<_> = rows.iter().cloned().map(Op::Add).collect();
    store.at(&Target::Map { id: None }).write(adds).now();
    store
}

fn copy_over(existing: &[Location], sources: &[Location]) -> (Vec<Location>, u32) {
    let window = WindowLabel("w".into());
    let target = Id::<MapMeta, String>::new("dst".into());
    let mut mgr = StoreManager::new();
    mgr.stores
        .insert(Id::new("src".into()), with_rows("src", sources));
    mgr.holders
        .insert(Holder::Window(window.clone()), Id::new("src".into()));
    mgr.stores
        .insert(target.clone(), with_rows("dst", existing));
    let state = StoreState::new(mgr);
    let before = existing.len();
    let copied = async_runtime::block_on(copy_locations_to_map(
        &state,
        &window,
        target.clone(),
        Selector::Everything,
    ))
    .unwrap();
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
    let added = store
        .at(&Target::Map { id: None })
        .write(vec![Op::Add(at_pano(10.0, 20.0, "AAA"))])
        .now();
    assert_eq!(added.mutation.keys.len(), 1);
}

#[test]
fn an_edit_at_a_map_this_window_does_not_watch_settles_at_once() {
    let mut store = with_rows("other", &[]);
    let window = WindowLabel("w".into());
    let at_other = Target::Map {
        id: Some(Id::new("other".into())),
    };
    let edit = |store: &mut Store, target: &Target, lat: f64| {
        let edited = store
            .at(target)
            .write(vec![Op::Add(test_util::loc(0, lat, 2.0))])
            .now();
        receipt(store, &window, target)(edited.mutation)
    };
    let there = edit(&mut store, &at_other, 1.0);
    assert_eq!(there.version, 0);
    assert_eq!(there.keys.len(), 1);

    let here = edit(&mut store, &Target::Map { id: None }, 3.0);
    assert_eq!(here.version, store.version);
}

fn opened_on_disk(map: &Id<MapMeta, String>) -> Option<String> {
    crate::store::maps::read_map_meta(&storage::open_db().unwrap(), map)
        .unwrap()
        .last_opened_at
}

#[test]
fn opening_a_map_stamps_its_opened_time_and_leaves_it_saved() {
    let map = storage::tests::map_on_disk("open-stamps");
    let state = StoreState::new(StoreManager::new());
    async_runtime::block_on(open_claimed_map(
        &WindowLabel("w".into()),
        &state,
        map.clone(),
        Channel::new(|_| Ok(())),
    ))
    .unwrap();

    let mgr = state.lock().unwrap();
    let store = &mgr.stores[&map];
    assert!(store.meta.last_opened_at.is_some());
    assert_eq!(opened_on_disk(&map), store.meta.last_opened_at);
    assert!(!store.is_unsaved());
}

#[test]
fn a_map_that_fails_to_open_is_not_stamped() {
    let map = storage::tests::map_on_disk("open-fails");
    let base = storage::arrow_path(&map).unwrap();
    std::fs::create_dir_all(base.parent().unwrap()).unwrap();
    std::fs::write(&base, b"not arrow").unwrap();
    let state = StoreState::new(StoreManager::new());

    let opened = async_runtime::block_on(open_claimed_map(
        &WindowLabel("w".into()),
        &state,
        map.clone(),
        Channel::new(|_| Ok(())),
    ));
    assert!(opened.is_err());
    assert_eq!(opened_on_disk(&map), None);
}

fn change_versions() -> (Channel<ChangeEvent>, Arc<Mutex<Vec<u64>>>) {
    let got = Arc::new(Mutex::new(Vec::new()));
    let sink = got.clone();
    let channel = Channel::new(move |body| {
        let InvokeResponseBody::Json(s) = body else {
            panic!("change events travel as json");
        };
        let event: ChangeEvent = serde_json::from_str(&s).unwrap();
        sink.lock().unwrap().push(event.version);
        Ok(())
    });
    (channel, got)
}

fn add_one(state: &StoreState, map: &Id<MapMeta, String>) -> u64 {
    let mut mgr = state.lock().unwrap();
    let store = mgr.store_for_map(map).unwrap();
    store
        .at(&Target::Map { id: None })
        .write(vec![Op::Add(test_util::loc(0, 1.0, 2.0))])
        .now();
    store.version
}

#[test]
fn opening_an_open_map_in_another_window_shares_its_live_store() {
    let map = storage::tests::map_on_disk("open-twice");
    let state = StoreState::new(StoreManager::new());
    let open = |w: &str, changes| {
        async_runtime::block_on(open_claimed_map(
            &WindowLabel(w.into()),
            &state,
            map.clone(),
            changes,
        ))
        .unwrap()
    };
    let (a, got_a) = change_versions();
    open("a", a);
    add_one(&state, &map);
    let next_id = state.lock().unwrap().stores[&map].next_id.clone();

    let (b, got_b) = change_versions();
    let status = open("b", b);
    assert_eq!(status.derived.location_count, 1);
    {
        let mgr = state.lock().unwrap();
        assert_eq!(mgr.stores[&map].next_id, next_id);
        assert!(mgr.stores[&map].is_unsaved());
    }

    let version = add_one(&state, &map);
    assert_eq!(got_a.lock().unwrap().last(), Some(&version));
    assert_eq!(*got_b.lock().unwrap(), [version]);
}

#[test]
fn opening_a_map_delivers_every_later_change_to_the_window() {
    let map = storage::tests::map_on_disk("open-feeds");
    let state = StoreState::new(StoreManager::new());
    let (changes, got) = change_versions();
    let status = async_runtime::block_on(open_claimed_map(
        &WindowLabel("w".into()),
        &state,
        map.clone(),
        changes,
    ))
    .unwrap();
    assert!(got.lock().unwrap().is_empty());

    let version = add_one(&state, &map);
    assert!(version > status.version);
    assert_eq!(*got.lock().unwrap(), [version]);
}

#[test]
fn opening_another_map_stops_the_first_ones_changes_reaching_the_window() {
    let (first, second) = (
        storage::tests::map_on_disk("open-first"),
        storage::tests::map_on_disk("open-second"),
    );
    let state = StoreState::new(StoreManager::new());
    let window = WindowLabel("w".into());
    let (first_changes, from_first) = change_versions();
    async_runtime::block_on(open_claimed_map(
        &window,
        &state,
        first.clone(),
        first_changes,
    ))
    .unwrap();
    let (second_changes, from_second) = change_versions();
    async_runtime::block_on(open_claimed_map(
        &window,
        &state,
        second.clone(),
        second_changes,
    ))
    .unwrap();

    add_one(&state, &first);
    assert!(from_first.lock().unwrap().is_empty());
    assert!(from_second.lock().unwrap().is_empty());
    let version = add_one(&state, &second);
    assert_eq!(*from_second.lock().unwrap(), [version]);
}

#[test]
fn opening_the_scratch_map_creates_it() {
    storage::tests::map_on_disk("scratch-neighbour");
    let scratch = Id::<MapMeta, String>::new(SCRATCH_MAP_ID.into());
    let state = StoreState::new(StoreManager::new());
    let status = async_runtime::block_on(open_claimed_map(
        &WindowLabel("w".into()),
        &state,
        scratch.clone(),
        Channel::new(|_| Ok(())),
    ))
    .unwrap();

    assert_eq!(status.derived.map.0.id, scratch);
    assert!(opened_on_disk(&scratch).is_some());
}
