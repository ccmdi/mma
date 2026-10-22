use super::*;
use crate::store::arrow;
use crate::test_util::{loc, Now, TempDir};
use crate::types::ErrCode;
use mma_algebra::Op;
use rusqlite::Connection;
use std::fs;
use std::time::Duration;
use tokio::runtime::Builder;
use tokio::time;

const MAP: Target = Target::Map { id: None };

fn database(path: &Path) -> Connection {
    let conn = Connection::open(path).unwrap();
    storage::run_migrations_on(&conn).unwrap();
    conn.execute(
        "INSERT INTO maps (id, name, created_at, updated_at) VALUES ('m', 'before', '', '')",
        [],
    )
    .unwrap();
    conn
}

fn store_with_one_edit() -> Store {
    let mut store = Store::new();
    store.meta = Tracked::new(MapMeta {
        id: Id::new("m".into()),
        ..Default::default()
    });
    store.meta.edit().name = "after".into();
    store.batch = Some(RecordBatch::new_empty(arrow::schema()));
    store
        .at(&MAP)
        .write(vec![Op::Set(loc(1, 11.0, 11.0))])
        .now()
        .mutation;
    store
}

fn rows(path: &Path) -> Vec<Location> {
    if path.exists() {
        arrow::batch_to_locations(&arrow::read_arrow_ipc(path).unwrap())
    } else {
        Vec::new()
    }
}

#[test]
fn failed_delta_write_leaves_database_and_history_unchanged() {
    let dir = TempDir::new("mma_failed_delta_write_recovery");
    let db_path = dir.join("map.sqlite");
    let delta_path = dir.join("delta.arrow");
    let conn = database(&db_path);
    fs::create_dir(&delta_path).unwrap();
    let store = store_with_one_edit();
    let unsaved = store.unsaved().unwrap().unwrap();

    assert!(unsaved
        .write(&conn, &Id::new("m".into()), &delta_path)
        .is_err());
    drop(conn);

    let reopened = Connection::open(&db_path).unwrap();
    let history_rows: i64 = reopened
        .query_row(
            "SELECT COUNT(*) FROM edit_entries WHERE map_id = 'm'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let (count, name): (i64, String) = reopened
        .query_row(
            "SELECT location_count, name FROM maps WHERE id = 'm'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(history_rows, 0);
    assert_eq!(count, 0);
    assert_eq!(name, "before");
    assert!(delta_path.is_dir());
}

#[test]
fn a_counts_failure_after_delta_write_reopens_data_without_ahead_history() {
    let dir = TempDir::new("mma_counts_failure_recovery");
    let db_path = dir.join("map.sqlite");
    let delta_path = dir.join("delta.arrow");
    let conn = database(&db_path);
    conn.execute_batch(
        "CREATE TRIGGER reject_counts BEFORE UPDATE OF location_count ON maps
         BEGIN SELECT RAISE(ABORT, 'injected counts failure'); END;",
    )
    .unwrap();
    let store = store_with_one_edit();
    let expected = store.get_loc_by_id(Id::new(1)).unwrap();
    let unsaved = store.unsaved().unwrap().unwrap();

    assert!(unsaved
        .write(&conn, &Id::new("m".into()), &delta_path)
        .is_err());
    assert_eq!(rows(&delta_path), vec![expected.clone()]);
    drop(conn);

    let reopened = Connection::open(&db_path).unwrap();
    let history_rows: i64 = reopened
        .query_row(
            "SELECT COUNT(*) FROM edit_entries WHERE map_id = 'm'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let count: i64 = reopened
        .query_row("SELECT location_count FROM maps WHERE id = 'm'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(history_rows, 0);
    assert_eq!(count, 0);
    assert_eq!(load_delta(&delta_path).unwrap().added, vec![expected]);
}

#[test]
fn metadata_failure_keeps_new_delta_and_counts_without_writing_history() {
    let dir = TempDir::new("mma_meta_failure_recovery");
    let db_path = dir.join("map.sqlite");
    let delta_path = dir.join("delta.arrow");
    let conn = database(&db_path);
    conn.execute_batch(
        "CREATE TRIGGER reject_name BEFORE UPDATE OF name ON maps
         WHEN NEW.name = 'after'
         BEGIN SELECT RAISE(ABORT, 'injected metadata failure'); END;",
    )
    .unwrap();
    let store = store_with_one_edit();
    let expected = store.get_loc_by_id(Id::new(1)).unwrap();
    let unsaved = store.unsaved().unwrap().unwrap();

    assert!(unsaved
        .write(&conn, &Id::new("m".into()), &delta_path)
        .is_err());
    assert_eq!(rows(&delta_path), vec![expected]);
    drop(conn);

    let reopened = Connection::open(&db_path).unwrap();
    let (count, name): (i64, String) = reopened
        .query_row(
            "SELECT location_count, name FROM maps WHERE id = 'm'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let history_rows: i64 = reopened
        .query_row(
            "SELECT COUNT(*) FROM edit_entries WHERE map_id = 'm'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!((count, name.as_str(), history_rows), (1, "before", 0));
}

#[test]
fn history_write_failure_rolls_back_partial_entries_and_keeps_prior_stack() {
    let dir = TempDir::new("mma_history_failure_recovery");
    let db_path = dir.join("map.sqlite");
    let delta_path = dir.join("delta.arrow");
    let conn = database(&db_path);
    let mut store = store_with_one_edit();
    let first = store.unsaved().unwrap().unwrap();
    first
        .write(&conn, &Id::new("m".into()), &delta_path)
        .unwrap();
    store.saved(&first);
    assert_eq!(
        load_edit_history(&conn, &Id::new("m".into()))
            .unwrap()
            .len(Stack::Undo),
        1
    );

    store
        .at(&MAP)
        .write(vec![Op::Set(loc(2, 12.0, 12.0))])
        .now()
        .mutation;
    store
        .at(&MAP)
        .write(vec![Op::Set(loc(3, 13.0, 13.0))])
        .now()
        .mutation;
    let expected = vec![
        store.get_loc_by_id(Id::new(1)).unwrap(),
        store.get_loc_by_id(Id::new(2)).unwrap(),
        store.get_loc_by_id(Id::new(3)).unwrap(),
    ];
    conn.execute_batch(
        "CREATE TRIGGER reject_third_history BEFORE INSERT ON edit_entries
         WHEN NEW.seq = 2
         BEGIN SELECT RAISE(ABORT, 'injected history failure'); END;",
    )
    .unwrap();
    let second = store.unsaved().unwrap().unwrap();

    assert!(second
        .write(&conn, &Id::new("m".into()), &delta_path)
        .is_err());
    assert_eq!(rows(&delta_path), expected);
    drop(conn);

    let reopened = Connection::open(&db_path).unwrap();
    let sequences: Vec<i64> = reopened
        .prepare("SELECT seq FROM edit_entries WHERE map_id = 'm' ORDER BY seq")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(sequences, [0]);
    let mut history = load_edit_history(&reopened, &Id::new("m".into())).unwrap();
    assert_eq!(history.len(Stack::Undo), 1);
    assert_eq!(history.len(Stack::Redo), 0);
    let (fetched, _) = history
        .take(Stack::Undo, |seq| {
            load_edit(&reopened, &Id::new("m".into()), seq)
        })
        .unwrap()
        .unwrap();
    assert_eq!(fetched.locations.removed, vec![expected[0].clone()]);
    assert_eq!(fetched.locations.added, Vec::<Location>::new());
}

#[test]
fn an_unreadable_delta_is_quarantined_and_not_replayed() {
    let dir = TempDir::new("mma_corrupt_delta_recovery");
    let path = dir.join("map_delta.arrow");
    fs::write(&path, b"truncated arrow sidecar").unwrap();

    assert!(load_delta(&path).is_none());
    assert!(!path.exists());
    assert_eq!(
        fs::read(path.with_extension("corrupt")).unwrap(),
        b"truncated arrow sidecar"
    );
}

#[test]
fn closing_a_window_waits_for_the_maps_files_lock_before_its_store_leaves() {
    let runtime = Builder::new_current_thread().enable_time().build().unwrap();
    let map = Id::<MapMeta, String>::new("m".into());
    let window = WindowLabel("w".into());
    let state = StoreState::new(StoreManager::new());
    {
        let mut mgr = state.lock().unwrap();
        mgr.stores.insert(map.clone(), Store::new());
        mgr.holders
            .insert(Holder::Window(window.clone()), map.clone());
    }
    let files = state.lock().unwrap().files(&map);

    runtime.block_on(async {
        let writing = files.lock().await;
        let holder = Holder::Window(window.clone());
        let close = release(&state, &holder);
        tokio::pin!(close);
        let waited = time::timeout(Duration::from_millis(50), &mut close).await;
        assert!(
            waited.is_err(),
            "close must wait for the active file writer"
        );
        assert!(state.lock().unwrap().stores.contains_key(&map));

        drop(writing);
        close.await.unwrap();
    });
    assert!(state.lock().unwrap().stores.is_empty());
}

fn set_row(state: &StoreState, map: &Id<MapMeta, String>, row: Location) {
    let mut mgr = state.lock().unwrap();
    let store = mgr.store_for_map(map).unwrap();
    store.at(&MAP).write(vec![Op::Set(row)]).now().mutation;
}

#[test]
fn a_held_store_outlives_its_last_window_and_leaves_saved_when_let_go() {
    let runtime = Builder::new_current_thread().build().unwrap();
    let map = storage::tests::map_on_disk("held-past-its-window");
    let window = WindowLabel("w".into());
    let state: &'static StoreState = Box::leak(Box::new(StoreState::new(StoreManager::new())));

    let held = runtime
        .block_on(hold(state, Holder::Session(map.clone()), &map))
        .unwrap();
    state
        .lock()
        .unwrap()
        .holders
        .insert(Holder::Window(window.clone()), map.clone());
    set_row(state, &map, loc(1, 1.0, 1.0));
    runtime
        .block_on(release(state, &Holder::Window(window.clone())))
        .unwrap();
    assert!(state.lock().unwrap().stores.contains_key(&map));

    set_row(state, &map, loc(2, 2.0, 2.0));
    runtime.block_on(held.release()).unwrap();
    assert!(state.lock().unwrap().stores.is_empty());
    assert_eq!(load_store(&map).unwrap().all().rows().count(), 2);
}

#[test]
fn letting_go_of_a_store_a_window_has_open_saves_it_and_leaves_it_to_the_window() {
    let runtime = Builder::new_current_thread().build().unwrap();
    let map = storage::tests::map_on_disk("held-under-a-window");
    let window = WindowLabel("w".into());
    let state: &'static StoreState = Box::leak(Box::new(StoreState::new(StoreManager::new())));
    {
        let mut mgr = state.lock().unwrap();
        mgr.stores.insert(map.clone(), load_store(&map).unwrap());
        mgr.holders
            .insert(Holder::Window(window.clone()), map.clone());
    }

    let sessions = [
        Holder::Session(map.clone()),
        Holder::Session(Id::new("other".into())),
    ];
    let holds: Vec<Hold> = sessions
        .into_iter()
        .map(|session| runtime.block_on(hold(state, session, &map)).unwrap())
        .collect();
    set_row(state, &map, loc(1, 1.0, 1.0));
    for held in holds {
        runtime.block_on(held.release()).unwrap();
    }
    {
        let mut mgr = state.lock().unwrap();
        assert!(!mgr.store_for_map(&map).unwrap().is_unsaved());
    }
    assert_eq!(load_store(&map).unwrap().all().rows().count(), 1);

    runtime
        .block_on(release(state, &Holder::Window(window.clone())))
        .unwrap();
    assert!(state.lock().unwrap().stores.is_empty());
}

#[test]
fn records_stored_by_older_versions_load_with_ids_from_their_keys_and_no_visibility() {
    let dir = TempDir::new("mma_test_legacy_records");
    let conn = database(&dir.join("db.sqlite"));
    conn.execute(
        "INSERT INTO value_records (map_id, field, records) VALUES ('m', 'tags', ?1)",
        [r#"{"7":{"id":3,"name":"a","visible":true,"color":"red"},"x":{"name":"b"}}"#],
    )
    .unwrap();
    let map = Id::new("m".to_string());
    let a = ValueRecord {
        id: Id::new(7),
        name: Some("a".into()),
        extra: serde_json::Map::from_iter([("color".to_string(), "red".into())]),
        ..Default::default()
    };
    let loaded = load_value_records(&conn, &map).unwrap();
    assert_eq!(loaded["tags"], HashMap::from([(Id::new(7), a.clone())]));

    save_value_records(&conn, &map, "tags", &loaded["tags"]).unwrap();
    assert_eq!(
        load_value_records(&conn, &map).unwrap()["tags"],
        HashMap::from([(Id::new(7), a)])
    );
}

#[test]
fn opening_a_deleted_map_is_map_missing() {
    let map = storage::tests::map_on_disk("deleted-map");
    storage::open_db()
        .unwrap()
        .execute("DELETE FROM maps WHERE id = ?1", [map.raw()])
        .unwrap();

    let Err(err) = load_store(&map) else {
        panic!("a deleted map opened");
    };
    assert_eq!(err.0, ErrCode::MapMissing.wire());
}

#[test]
fn opening_a_map_whose_base_file_is_damaged_is_map_unreadable() {
    let map = storage::tests::map_on_disk("damaged-base");
    let path = storage::arrow_path(&map).unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"not an arrow file, just some damaged bytes").unwrap();

    let Err(err) = load_store(&map) else {
        panic!("a damaged base file opened");
    };
    fs::remove_file(&path).unwrap();
    assert_eq!(err.0, ErrCode::MapUnreadable.wire());
}

#[test]
fn a_hold_reaches_its_store_until_it_lets_go() {
    let runtime = Builder::new_current_thread().build().unwrap();
    let map = storage::tests::map_on_disk("reached-through-a-hold");
    let state: &'static StoreState = Box::leak(Box::new(StoreState::new(StoreManager::new())));
    let held = runtime
        .block_on(hold(state, Holder::Session(map.clone()), &map))
        .unwrap();

    assert_eq!(held.store(|store| Ok(store.meta.id.clone())).unwrap(), map);
    runtime.block_on(held.release()).unwrap();
    assert!(held.store(|_| Ok(())).is_err());
}
