use super::*;
use crate::store::arrow;
use crate::test_util::{loc, TempDir};
use mma_algebra::Op;
use rusqlite::Connection;
use std::fs;

fn database(path: &std::path::Path) -> Connection {
    let conn = Connection::open(path).unwrap();
    crate::store::storage::run_migrations_on(&conn).unwrap();
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
    store.batch = Some(arrow::empty_batch());
    store.write([Op::Set(loc(1, 11.0, 11.0))], &mut None, Entry::default());
    store
}

fn rows(path: &std::path::Path) -> Vec<Location> {
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

    store.write([Op::Set(loc(2, 12.0, 12.0))], &mut None, Entry::default());
    store.write([Op::Set(loc(3, 13.0, 13.0))], &mut None, Entry::default());
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
    let fetched = history
        .step(Stack::Undo, |seq| {
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
fn close_flush_waits_for_the_shared_file_writer_lock() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();

    runtime.block_on(async {
        let store = Store::new();
        let files = store.files.clone();
        let writing = files.lock().await;
        let close = tokio::spawn(flush_closed_store(Id::new("m".into()), store));

        tokio::task::yield_now().await;
        assert!(
            !close.is_finished(),
            "close must wait for the active file writer"
        );

        drop(writing);
        close.await.unwrap().unwrap();
    });
}
