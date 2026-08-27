use super::*;
use rusqlite::Connection;

/// In-memory DB with the v17 `review_sessions` schema (and a `maps` stub for the FK).
fn setup() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE maps (id TEXT PRIMARY KEY NOT NULL);
         CREATE TABLE review_sessions (
            id           TEXT PRIMARY KEY NOT NULL,
            map_id       TEXT NOT NULL,
            name         TEXT NOT NULL DEFAULT '',
            source_key   TEXT NOT NULL,
            source_props TEXT NOT NULL DEFAULT '{}',
            ordering     TEXT NOT NULL,
            reviewed     TEXT NOT NULL DEFAULT '[]',
            cursor_id    INTEGER NOT NULL,
            status       TEXT NOT NULL DEFAULT 'active',
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
         );",
    )
    .unwrap();
    conn
}

fn mk(map_id: &str, source_key: &str, order: Vec<u32>) -> ReviewCreate {
    ReviewCreate {
        map_id: map_id.into(),
        name: "Tag: red".into(),
        source_key: source_key.into(),
        source_props: serde_json::json!({ "type": "Tag", "tagId": 1 }),
        order,
    }
}

#[test]
fn create_starts_cursor_at_first_id_with_empty_reviewed() {
    let conn = setup();
    let s = create(&conn, mk("m1", "tag:1", vec![10, 20, 30])).unwrap();
    assert_eq!(s.cursor_id, 10);
    assert!(s.reviewed.is_empty());
    assert_eq!(s.order, vec![10, 20, 30]);
    assert_eq!(s.status, "active");
}

#[test]
fn create_rejects_empty_worklist() {
    let conn = setup();
    assert!(create(&conn, mk("m1", "tag:1", vec![])).is_err());
}

#[test]
fn get_returns_active_session_by_source_key() {
    let conn = setup();
    let created = create(&conn, mk("m1", "tag:1", vec![1, 2, 3])).unwrap();
    let got = get(&conn, "m1", "tag:1").unwrap().expect("session present");
    assert_eq!(got.id, created.id);
    assert_eq!(got.order, vec![1, 2, 3]);
    // source_props round-trips as the original Selector json.
    assert_eq!(got.source_props["type"], "Tag");
    assert_eq!(got.source_props["tagId"], 1);
}

#[test]
fn get_is_none_for_unknown_or_wrong_map() {
    let conn = setup();
    create(&conn, mk("m1", "tag:1", vec![1])).unwrap();
    assert!(get(&conn, "m1", "tag:2").unwrap().is_none());
    assert!(get(&conn, "m2", "tag:1").unwrap().is_none());
}

#[test]
fn update_persists_cursor_reviewed_and_ordering() {
    let conn = setup();
    let s = create(&conn, mk("m1", "tag:1", vec![1, 2, 3, 4])).unwrap();
    update(
        &conn,
        ReviewUpdate {
            id: s.id.clone(),
            name: None,
            cursor_id: Some(3),
            reviewed: Some(vec![1, 2]),
            ordering: None,
            status: None,
        },
    )
    .unwrap();
    let got = get(&conn, "m1", "tag:1").unwrap().unwrap();
    assert_eq!(got.cursor_id, 3);
    assert_eq!(got.reviewed, vec![1, 2]);
    assert_eq!(got.order, vec![1, 2, 3, 4]);
}

#[test]
fn pruning_ordering_and_reviewed_does_not_disturb_cursor() {
    // Reconciliation contract: removing non-cursor ids prunes the arrays but the
    // cursor id is left untouched (it survives because it wasn't pruned).
    let conn = setup();
    let s = create(&conn, mk("m1", "tag:1", vec![1, 2, 3, 4, 5])).unwrap();
    update(
        &conn,
        ReviewUpdate {
            id: s.id.clone(),
            name: None,
            cursor_id: Some(3),
            reviewed: Some(vec![1, 2]),
            ordering: None,
            status: None,
        },
    )
    .unwrap();
    // Locations 2 and 4 deleted: prune them from ordering + reviewed, cursor stays 3.
    update(
        &conn,
        ReviewUpdate {
            id: s.id.clone(),
            name: None,
            cursor_id: None,
            reviewed: Some(vec![1]),
            ordering: Some(vec![1, 3, 5]),
            status: None,
        },
    )
    .unwrap();
    let got = get(&conn, "m1", "tag:1").unwrap().unwrap();
    assert_eq!(got.cursor_id, 3);
    assert_eq!(got.order, vec![1, 3, 5]);
    assert_eq!(got.reviewed, vec![1]);
}

#[test]
fn done_sessions_are_excluded_from_get_but_listable() {
    let conn = setup();
    let s = create(&conn, mk("m1", "tag:1", vec![1, 2])).unwrap();
    update(
        &conn,
        ReviewUpdate {
            id: s.id.clone(),
            name: None,
            cursor_id: None,
            reviewed: None,
            ordering: None,
            status: Some("done".into()),
        },
    )
    .unwrap();
    assert!(get(&conn, "m1", "tag:1").unwrap().is_none());
    assert_eq!(list(&conn, "m1", Some("done")).unwrap().len(), 1);
    assert_eq!(list(&conn, "m1", Some("active")).unwrap().len(), 0);
}

#[test]
fn list_scopes_to_map_and_filters_status() {
    let conn = setup();
    create(&conn, mk("m1", "tag:1", vec![1])).unwrap();
    create(&conn, mk("m1", "tag:2", vec![2])).unwrap();
    create(&conn, mk("m2", "tag:1", vec![3])).unwrap();
    assert_eq!(list(&conn, "m1", None).unwrap().len(), 2);
    assert_eq!(list(&conn, "m2", None).unwrap().len(), 1);
}

#[test]
fn delete_removes_the_session() {
    let conn = setup();
    let s = create(&conn, mk("m1", "tag:1", vec![1, 2])).unwrap();
    delete(&conn, &s.id).unwrap();
    assert!(get(&conn, "m1", "tag:1").unwrap().is_none());
    assert_eq!(list(&conn, "m1", None).unwrap().len(), 0);
}
