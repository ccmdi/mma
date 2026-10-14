use super::*;
use crate::selections::tree::{SelectionInput, SelectionOp};
use crate::store::engine::{Finished, Store, WindowLabel};
use crate::test_util::loc;
use mma_algebra::Id;
use std::path::PathBuf;

fn staged(dir: &Path) -> (PathBuf, PathBuf) {
    let base = dir.join("m.arrow");
    let delta = dir.join("m_delta.arrow");
    arrow::write_arrow_ipc(&base, &arrow::locations_to_batch(&[loc(1, 1.0, 1.0)])).unwrap();
    fs::write(&delta, b"uncommitted").unwrap();
    (base, delta)
}

#[test]
fn checkout_refuses_a_map_with_a_live_store() {
    let dir = tempfile::tempdir().unwrap();
    let (base, delta) = staged(dir.path());
    let before = fs::read(&base).unwrap();
    let mut mgr = StoreManager::new();
    mgr.stores.insert(Id::new("m".into()), Store::new());

    let restored = [loc(1, 1.0, 1.0), loc(2, 2.0, 2.0)];
    assert!(write_checkout(&mgr, &Id::new("m".into()), &restored, &base, &delta).is_err());
    assert_eq!(fs::read(&base).unwrap(), before);
    assert!(delta.exists());
}

#[test]
fn checkout_refuses_a_map_another_window_is_opening() {
    let dir = tempfile::tempdir().unwrap();
    let (base, delta) = staged(dir.path());
    let before = fs::read(&base).unwrap();
    let mut mgr = StoreManager::new();
    mgr.window_map
        .insert(WindowLabel("web-b".into()), Id::new("m".into()));

    let restored = [loc(1, 1.0, 1.0), loc(2, 2.0, 2.0)];
    assert!(write_checkout(&mgr, &Id::new("m".into()), &restored, &base, &delta).is_err());
    assert_eq!(fs::read(&base).unwrap(), before);
    assert!(delta.exists());
}

#[test]
fn checkout_of_a_closed_map_rewrites_the_base_and_drops_the_delta() {
    let dir = tempfile::tempdir().unwrap();
    let (base, delta) = staged(dir.path());
    let mut mgr = StoreManager::new();
    mgr.stores.insert(Id::new("other".into()), Store::new());

    let restored = [loc(1, 1.0, 1.0), loc(2, 2.0, 2.0)];
    write_checkout(&mgr, &Id::new("m".into()), &restored, &base, &delta).unwrap();
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
    store.write(
        [mma_algebra::Op::Set(loc(1, 1.0, 1.0))],
        &mut None,
        Default::default(),
    );
    store.edit_selections(&SelectionOp::Add {
        selections: vec![SelectionInput {
            selector: Selector::Everything,
            color: None,
        }],
    });
    store
        .at(&engine::Target::Pending {
            name: "viewer".into(),
        })
        .edit(
            vec![mma_algebra::Op::Set(loc(1, 3.0, 3.0))],
            Default::default(),
            &mut None,
        );
    let result = restore_rows(&mut store, vec![loc(7, 7.0, 7.0)]);
    assert_eq!(result.mutation.version, store.version);
    assert!(store.get_loc_by_id(Id::new(1)).is_none());
    assert_eq!(store.get_loc_by_id(Id::new(7)).unwrap().lat, 7.0);
    assert!(store.selections.ids.is_empty());
    assert!(store.pending.is_empty());
    assert_eq!(store.next_id.take(), Id::new(8));
    let entry = store
        .step(engine::Stack::Undo, engine::Timeline::Edits, |_| {
            panic!("in-memory edit")
        })
        .unwrap()
        .unwrap();
    store.finish(Finished::Entry(&entry));
    assert!(store.get_loc_by_id(Id::new(7)).is_none());
    assert_eq!(store.get_loc_by_id(Id::new(1)).unwrap().lat, 1.0);
    assert!(store.selections.ids.contains(Id::new(1)));
}

#[test]
fn restoring_after_a_delete_and_an_add_never_hands_out_a_restored_id() {
    let mut store = Store::new();
    let add = |store: &mut Store, lat: f64| {
        store
            .write(
                [mma_algebra::Op::Add(loc(0, lat, lat))],
                &mut None,
                Default::default(),
            )
            .keys[0]
    };
    let first = add(&mut store, 1.0);
    store.write(
        [mma_algebra::Op::Remove(first)],
        &mut None,
        Default::default(),
    );
    let second = add(&mut store, 2.0);
    restore_rows(
        &mut store,
        vec![loc(first.get(), 1.0, 1.0), loc(9, 9.0, 9.0)],
    );
    let third = add(&mut store, 3.0);
    assert!(first < second && third > Id::new(9));
    assert_eq!(store.get_loc_by_id(first).unwrap().lat, 1.0);
}

#[test]
fn restoring_a_version_announces_the_pending_counts_it_leaves() {
    let mut store = Store::new();
    store.batch = Some(arrow::locations_to_batch(&[loc(1, 1.0, 1.0)]));
    let feed = engine::tests::FeedCapture::attach(&mut store);
    restore_rows(&mut store, vec![loc(1, 1.0, 1.0), loc(9, 9.0, 9.0)]);
    assert_eq!(
        feed.last().derived.pending,
        Some(Counts {
            added: 1,
            removed: 0,
            updated: 0,
        })
    );
}
