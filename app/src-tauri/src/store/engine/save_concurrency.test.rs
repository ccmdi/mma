use super::*;
use crate::store::{arrow, storage};
use crate::test_util::{loc, Now, TempDir};
use mma_algebra::Op;
use rusqlite::Connection;
use std::path::Path;

fn database() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    storage::run_migrations_on(&conn).unwrap();
    conn.execute(
        "INSERT INTO maps (id, name, settings, created_at, updated_at) VALUES ('m', '', '{}', '', '')",
        [],
    ).unwrap();
    conn
}

fn add(store: &mut Store, lat: f64) {
    store
        .at(&Target::Map { id: None })
        .write(vec![Op::Add(loc(0, lat, 0.0))])
        .now();
}

fn disk_latitudes(path: &Path) -> Vec<f64> {
    let batch = arrow::read_arrow_ipc(path).unwrap();
    let mut rows = arrow::batch_to_locations(&batch);
    rows.sort_by_key(|row| row.id);
    rows.into_iter().map(|row| row.lat).collect()
}

#[test]
fn acknowledging_an_inflight_save_preserves_later_rows_and_history_as_dirty() {
    let dir = TempDir::new("mma_save_concurrency_rows");
    let path = dir.join("delta.arrow");
    let conn = database();
    let mut store = Store::new();
    add(&mut store, 1.0);
    let inflight = store.unsaved().unwrap().unwrap();
    add(&mut store, 2.0);
    inflight.write(&conn, &Id::new("m".into()), &path).unwrap();
    store.saved(&inflight);

    assert_eq!(disk_latitudes(&path), [1.0]);
    assert_eq!(
        load_edit_history(&conn, &Id::new("m".into()))
            .unwrap()
            .len(Stack::Undo),
        1
    );
    assert!(store.overlay.is_unsaved());
    assert!(store.steps[Timeline::Edits].is_unsaved());
    assert_eq!(store.view().len(), 2);

    let remaining = store.unsaved().unwrap().unwrap();
    remaining.write(&conn, &Id::new("m".into()), &path).unwrap();
    store.saved(&remaining);
    assert_eq!(disk_latitudes(&path), [1.0, 2.0]);
    assert_eq!(
        load_edit_history(&conn, &Id::new("m".into()))
            .unwrap()
            .len(Stack::Undo),
        2
    );
    assert!(store.unsaved().unwrap().is_none());
}

#[test]
fn acknowledging_an_inflight_save_preserves_later_map_metadata_as_dirty() {
    let dir = TempDir::new("mma_save_concurrency_meta");
    let path = dir.join("delta.arrow");
    let conn = database();
    let mut store = Store::new();
    store.meta.edit().name = "before".into();
    let inflight = store.unsaved().unwrap().unwrap();
    store.meta.edit().name = "after".into();
    inflight.write(&conn, &Id::new("m".into()), &path).unwrap();
    store.saved(&inflight);
    let name = || {
        conn.query_row("SELECT name FROM maps WHERE id = 'm'", [], |row| {
            row.get::<_, String>(0)
        })
        .unwrap()
    };
    assert_eq!(name(), "before");
    assert_eq!(store.meta.name, "after");
    assert!(store.meta.is_unsaved());

    let remaining = store.unsaved().unwrap().unwrap();
    remaining.write(&conn, &Id::new("m".into()), &path).unwrap();
    store.saved(&remaining);
    assert_eq!(name(), "after");
    assert!(store.unsaved().unwrap().is_none());
}

#[test]
fn a_repeated_old_acknowledgement_cannot_rewind_a_newer_completed_save() {
    let dir = TempDir::new("mma_save_concurrency_ack");
    let path = dir.join("delta.arrow");
    let conn = database();
    let mut store = Store::new();
    add(&mut store, 1.0);
    let older = store.unsaved().unwrap().unwrap();
    older.write(&conn, &Id::new("m".into()), &path).unwrap();
    add(&mut store, 2.0);
    let newer = store.unsaved().unwrap().unwrap();
    newer.write(&conn, &Id::new("m".into()), &path).unwrap();
    store.saved(&newer);
    store.saved(&older);
    store.saved(&older);
    assert!(store.unsaved().unwrap().is_none());
    assert_eq!(disk_latitudes(&path), [1.0, 2.0]);
    add(&mut store, 3.0);
    store.saved(&older);
    assert!(store.overlay.is_unsaved());
    assert!(store.steps[Timeline::Edits].is_unsaved());
    assert_eq!(store.view().len(), 3);
}
