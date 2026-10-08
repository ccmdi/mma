use super::*;
use crate::store::engine::Store;
use crate::test_util::loc;

fn staged(dir: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
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
    mgr.stores.insert("m".into(), Store::new());

    let restored = [loc(1, 1.0, 1.0), loc(2, 2.0, 2.0)];
    assert!(write_checkout(&mgr, "m", &restored, &base, &delta).is_err());
    assert_eq!(fs::read(&base).unwrap(), before);
    assert!(delta.exists());
}

#[test]
fn checkout_refuses_a_map_another_window_is_opening() {
    let dir = tempfile::tempdir().unwrap();
    let (base, delta) = staged(dir.path());
    let before = fs::read(&base).unwrap();
    let mut mgr = StoreManager::new();
    mgr.window_map.insert("web-b".into(), "m".into());

    let restored = [loc(1, 1.0, 1.0), loc(2, 2.0, 2.0)];
    assert!(write_checkout(&mgr, "m", &restored, &base, &delta).is_err());
    assert_eq!(fs::read(&base).unwrap(), before);
    assert!(delta.exists());
}

#[test]
fn checkout_of_a_closed_map_rewrites_the_base_and_drops_the_delta() {
    let dir = tempfile::tempdir().unwrap();
    let (base, delta) = staged(dir.path());
    let mut mgr = StoreManager::new();
    mgr.stores.insert("other".into(), Store::new());

    let restored = [loc(1, 1.0, 1.0), loc(2, 2.0, 2.0)];
    write_checkout(&mgr, "m", &restored, &base, &delta).unwrap();
    let batch = arrow::read_arrow_ipc(&base).unwrap();
    let ids: Vec<u32> = arrow::batch_to_locations(&batch)
        .iter()
        .map(|l| l.id)
        .collect();
    assert_eq!(ids, [1, 2]);
    assert!(!delta.exists());
}

#[test]
fn restoring_an_open_map_uses_history_and_clears_pending_and_selected_rows() {
    let mut store = Store::new();
    store.write(
        [engine::Edit::Set(loc(1, 1.0, 1.0))],
        &mut None,
        Default::default(),
    );
    store.edit_selections(&crate::selections::tree::SelectionOp::Add {
        selections: vec![crate::selections::tree::SelectionInput {
            selector: Selector::Everything,
            color: None,
        }],
    });
    store.edit(
        &engine::Target::Pending {
            name: "viewer".into(),
        },
        vec![engine::Edit::Set(loc(1, 3.0, 3.0))],
        false,
        &mut None,
    );
    let result = restore_rows(&mut store, vec![loc(7, 7.0, 7.0)]);
    assert_eq!(result.mutation.version, store.version);
    assert!(store.get_loc_by_id(1).is_none());
    assert_eq!(store.get_loc_by_id(7).unwrap().lat, 7.0);
    assert!(store.selections.ids.is_empty());
    assert!(store.pending.is_empty());
    assert_eq!(store.alloc_id(), 8);
    let entry = store
        .step(engine::Stack::Undo, |_| panic!("in-memory edit"))
        .unwrap()
        .unwrap();
    store.finish_entry(&entry);
    assert!(store.get_loc_by_id(7).is_none());
    assert_eq!(store.get_loc_by_id(1).unwrap().lat, 1.0);
    assert!(store.selections.ids.contains(1));
}
