use super::*;
use crate::selections::tree::{SelectionInput, SelectionOp};
use crate::store::engine::{Holder, Store, Target, WindowLabel};
use crate::test_util::{loc, Host, Now};
use mma_algebra::{by_key, Id};
use std::future::Future;
use std::path::PathBuf;
use tauri::async_runtime;

const MAP: Target = Target::Map { id: None };

fn staged(name: &str) -> (Id<MapMeta, String>, PathBuf, PathBuf) {
    let map = storage::tests::map_on_disk(name);
    let base = storage::arrow_path(&map).unwrap();
    let delta = storage::arrow_delta_path(&map).unwrap();
    arrow::write_arrow_ipc(&base, &arrow::locations_to_batch(&[loc(1, 1.0, 1.0)])).unwrap();
    fs::write(&delta, b"uncommitted").unwrap();
    (map, base, delta)
}

fn open_in(window: &str, map: &Id<MapMeta, String>, store: Store) -> StoreManager {
    let mut mgr = StoreManager::new();
    mgr.stores.insert(map.clone(), store);
    mgr.holders
        .insert(Holder::Window(WindowLabel(window.into())), map.clone());
    mgr
}

fn restore(mgr: &mut StoreManager, locs: Vec<Location>) -> engine::Mutation {
    checkout(
        mgr,
        &WindowLabel("w".into()),
        &Id::new("m".into()),
        by_key(locs),
    )
    .unwrap()
    .expect("an open map restores through its store")
}

#[test]
fn checkout_refuses_a_map_another_window_has_open() {
    let (map, base, delta) = staged("checkout-open-elsewhere");
    let before = fs::read(&base).unwrap();
    let mut mgr = open_in("web-b", &map, Store::new());

    let restored = by_key([loc(1, 1.0, 1.0), loc(2, 2.0, 2.0)]);
    assert!(checkout(&mut mgr, &WindowLabel("w".into()), &map, restored).is_err());
    assert_eq!(fs::read(&base).unwrap(), before);
    assert!(delta.exists());
}

#[test]
fn checkout_refuses_a_map_another_window_is_opening() {
    let (map, base, delta) = staged("checkout-opening-elsewhere");
    let before = fs::read(&base).unwrap();
    let mut mgr = StoreManager::new();
    mgr.holders
        .insert(Holder::Window(WindowLabel("web-b".into())), map.clone());

    let restored = by_key([loc(1, 1.0, 1.0), loc(2, 2.0, 2.0)]);
    assert!(checkout(&mut mgr, &WindowLabel("w".into()), &map, restored).is_err());
    assert_eq!(fs::read(&base).unwrap(), before);
    assert!(delta.exists());
}

#[test]
fn checkout_refuses_a_map_this_window_is_still_opening() {
    let (map, base, delta) = staged("checkout-opening-here");
    let before = fs::read(&base).unwrap();
    let mut mgr = StoreManager::new();
    mgr.holders
        .insert(Holder::Window(WindowLabel("w".into())), map.clone());

    let restored = by_key([loc(1, 1.0, 1.0), loc(2, 2.0, 2.0)]);
    assert!(checkout(&mut mgr, &WindowLabel("w".into()), &map, restored).is_err());
    assert_eq!(fs::read(&base).unwrap(), before);
    assert!(delta.exists());
}

#[test]
fn checkout_refuses_a_replica() {
    let (_host, replica) = Host::pair("m", &[loc(0, 1.0, 1.0)]);
    let map = replica.meta.id.clone();
    let mut mgr = open_in("w", &map, replica);
    let version = mgr.stores[&map].version;

    let restored = by_key([loc(1, 2.0, 2.0), loc(2, 3.0, 3.0)]);
    assert!(checkout(&mut mgr, &WindowLabel("w".into()), &map, restored).is_err());
    let replica = mgr.stores.get_mut(&map).unwrap();
    assert_eq!(replica.version, version);
    let rows = replica
        .at(&engine::Target::Map { id: None })
        .rows(&Selector::Everything);
    assert_eq!(
        rows.iter().map(|row| (row.id, row.lat)).collect::<Vec<_>>(),
        [(Id::new(1), 1.0)]
    );
}

#[test]
fn checkout_of_a_closed_map_rewrites_the_base_and_drops_the_delta() {
    let (map, base, delta) = staged("checkout-closed");
    let mut mgr = open_in("w", &Id::new("other".into()), Store::new());

    let restored = by_key([loc(1, 1.0, 1.0), loc(2, 2.0, 2.0)]);
    assert!(checkout(&mut mgr, &WindowLabel("w".into()), &map, restored)
        .unwrap()
        .is_none());
    let batch = arrow::read_arrow_ipc(&base).unwrap();
    let ids: Vec<u32> = arrow::batch_to_locations(&batch)
        .iter()
        .map(|l| l.id)
        .map(Id::get)
        .collect();
    assert_eq!(ids, [1, 2]);
    assert!(!delta.exists());
}

#[test]
fn restoring_an_open_map_uses_history_and_clears_pending_and_selected_rows() {
    let mut store = Store::new();
    store
        .at(&Target::Map { id: None })
        .write(vec![mma_algebra::Op::Set(loc(1, 1.0, 1.0))])
        .now()
        .mutation;
    store
        .at(&MAP)
        .write(SelectionOp::Add {
            selections: vec![SelectionInput {
                selector: Selector::Everything,
                color: None,
            }],
        })
        .now();
    store
        .at(&engine::Target::Pending {
            name: "viewer".into(),
        })
        .write(vec![mma_algebra::Op::Set(loc(1, 3.0, 3.0))])
        .now();
    let mut mgr = open_in("w", &Id::new("m".into()), store);
    let result = restore(&mut mgr, vec![loc(7, 7.0, 7.0)]);
    let store = mgr.store_for_map(&Id::new("m".into())).unwrap();
    assert_eq!(result.version, store.version);
    assert!(store.get_loc_by_id(Id::new(1)).is_none());
    assert_eq!(store.get_loc_by_id(Id::new(7)).unwrap().lat, 7.0);
    assert!(store.selections.ids.is_empty());
    assert!(store.pending.is_empty());
    assert_eq!(store.next_id.take().unwrap(), Id::new(8));
    store
        .step(engine::Stack::Undo, engine::Timeline::Edits, |_| {
            panic!("in-memory edit")
        })
        .now()
        .unwrap();
    assert!(store.get_loc_by_id(Id::new(7)).is_none());
    assert_eq!(store.get_loc_by_id(Id::new(1)).unwrap().lat, 1.0);
    assert!(store.selections.ids.contains(Id::new(1)));
}

#[test]
fn restoring_after_a_delete_and_an_add_never_hands_out_a_restored_id() {
    let add = |mgr: &mut StoreManager, lat: f64| {
        mgr.store_for_map(&Id::new("m".into()))
            .unwrap()
            .at(&Target::Map { id: None })
            .write(vec![mma_algebra::Op::Add(loc(0, lat, lat))])
            .now()
            .mutation
            .keys[0]
    };
    let mut mgr = open_in("w", &Id::new("m".into()), Store::new());
    let first = add(&mut mgr, 1.0);
    mgr.store_for_map(&Id::new("m".into()))
        .unwrap()
        .at(&Target::Map { id: None })
        .write(vec![mma_algebra::Op::Remove(first)])
        .now()
        .mutation;
    let second = add(&mut mgr, 2.0);
    restore(&mut mgr, vec![loc(first.get(), 1.0, 1.0), loc(9, 9.0, 9.0)]);
    let third = add(&mut mgr, 3.0);
    assert!(first < second && third > Id::new(9));
    let store = mgr.store_for_map(&Id::new("m".into())).unwrap();
    assert_eq!(store.get_loc_by_id(first).unwrap().lat, 1.0);
}

#[test]
fn restoring_a_version_announces_the_pending_counts_it_leaves() {
    let mut store = Store::new();
    store.batch = Some(arrow::locations_to_batch(&[loc(1, 1.0, 1.0)]));
    let feed = engine::tests::FeedCapture::attach(&mut store);
    let mut mgr = open_in("w", &Id::new("m".into()), store);
    restore(&mut mgr, vec![loc(1, 1.0, 1.0), loc(9, 9.0, 9.0)]);
    assert_eq!(
        engine::tests::shipped::<Counts>(&feed.last(), &["pending"]),
        Some(Counts {
            added: 1,
            removed: 0,
            updated: 0,
        })
    );
}

#[test]
fn restoring_and_reading_a_version_are_spawned_off_the_main_thread() {
    fn checkout(
        state: State<'_, StoreState>,
        map_id: Id<MapMeta, String>,
        commit_id: Id<CommitInfo, String>,
    ) -> impl Future<Output = AppResult<Option<engine::Mutation>>> + '_ {
        store_checkout_commit(WindowLabel("w".into()), state, map_id, commit_id)
    }
    let _ = checkout;

    let map = storage::tests::map_on_disk("spawned-delta");
    let commit = Id::<CommitInfo, String>::new("c1".into());
    let rows = [loc(1, 1.0, 1.0), loc(2, 2.0, 2.0)];
    arrow::write_arrow_ipc(
        &storage::commit_delta_path(&map, &commit).unwrap(),
        &arrow::locations_to_batch(&rows),
    )
    .unwrap();

    let spawned = async_runtime::block_on(async_runtime::spawn(store_get_commit_delta(
        map.clone(),
        commit.clone(),
    )))
    .unwrap()
    .unwrap();
    let (created, removed) = read_commit_delta(&map, &commit).unwrap();
    assert_eq!(created.len(), 2);
    assert_eq!(
        serde_json::to_value(spawned).unwrap(),
        serde_json::to_value(Change::<Location>::from_sides(created, removed)).unwrap()
    );
}
