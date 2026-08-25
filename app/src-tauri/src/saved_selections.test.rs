use super::*;
use crate::selections::Selection;
use rusqlite::Connection;

/// In-memory DB with the v21 `saved_selections` schema.
fn setup() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE saved_selections (
            id         TEXT PRIMARY KEY NOT NULL,
            name       TEXT NOT NULL,
            selector   TEXT NOT NULL,
            tag_names  TEXT NOT NULL DEFAULT '{}',
            color      TEXT NOT NULL,
            created_at TEXT NOT NULL
         );",
    )
    .unwrap();
    conn
}

fn tag_names(pairs: &[(u32, &str)]) -> HashMap<u32, String> {
    pairs.iter().map(|(id, n)| (*id, n.to_string())).collect()
}

/// Every rule's body, via the two primitives the frontend uses: index, then bodies.
fn all(conn: &Connection) -> Vec<SavedSelection> {
    let ids: Vec<String> = list_info(conn).unwrap().into_iter().map(|i| i.id).collect();
    get(conn, &ids).unwrap()
}

#[test]
fn create_round_trips_the_selector_tree_and_tag_names() {
    let conn = setup();
    let created = create(
        &conn,
        "Japan dupes".into(),
        Selector::Union {
            selections: vec![
                Selection {
                    key: "tag:4".into(),
                    color: [1, 2, 3],
                    selector: Selector::Tag { tag_id: 4 },
                },
                Selection {
                    key: "untagged".into(),
                    color: [4, 5, 6],
                    selector: Selector::Untagged,
                },
            ],
        },
        tag_names(&[(4, "Japan")]),
        [9, 9, 9],
    )
    .unwrap();

    let all = all(&conn);
    assert_eq!(all.len(), 1);
    let got = &all[0];
    assert_eq!(got.info.id, created.info.id);
    assert_eq!(got.info.name, "Japan dupes");
    assert_eq!(got.info.color, [9, 9, 9]);
    assert_eq!(got.tag_names.get(&4).map(String::as_str), Some("Japan"));
    match &got.selector {
        Selector::Union { selections } => {
            assert_eq!(selections.len(), 2);
            assert!(matches!(
                selections[0].selector,
                Selector::Tag { tag_id: 4 }
            ));
            assert_eq!(selections[0].color, [1, 2, 3]);
        }
        _ => panic!("expected a Union"),
    }
}

#[test]
fn delete_removes_only_the_named_rule() {
    let conn = setup();
    let a = create(
        &conn,
        "a".into(),
        Selector::Untagged,
        HashMap::new(),
        [0; 3],
    )
    .unwrap();
    create(
        &conn,
        "b".into(),
        Selector::Unpanned,
        HashMap::new(),
        [0; 3],
    )
    .unwrap();
    delete(&conn, &a.info.id).unwrap();
    let names: Vec<String> = all(&conn).into_iter().map(|s| s.info.name).collect();
    assert_eq!(names, vec!["b"]);
}

#[test]
fn an_unreadable_row_is_skipped_not_fatal() {
    let conn = setup();
    create(
        &conn,
        "good".into(),
        Selector::Untagged,
        HashMap::new(),
        [0; 3],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO saved_selections VALUES ('bad', 'bad', '{\"type\":\"NoSuchVariant\"}', '{}', '[0,0,0]', '2026-01-01')",
        [],
    )
    .unwrap();
    let names: Vec<String> = all(&conn).into_iter().map(|s| s.info.name).collect();
    assert_eq!(names, vec!["good"]);
}

#[test]
fn the_index_carries_identity_without_reading_any_tree() {
    let conn = setup();
    create(
        &conn,
        "heavy".into(),
        Selector::Polygon {
            polygon: crate::selections::PolygonGeometry {
                coordinates: vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]],
                extra_polygons: None,
                properties: None,
            },
            include_informational: false,
        },
        HashMap::new(),
        [4, 5, 6],
    )
    .unwrap();

    let index = list_info(&conn).unwrap();
    assert_eq!(index.len(), 1);
    assert_eq!(index[0].name, "heavy");
    assert_eq!(index[0].color, [4, 5, 6]);
    // The body is a separate read; asking for none does no query at all.
    assert!(get(&conn, &[]).unwrap().is_empty());
    assert_eq!(get(&conn, &[index[0].id.clone()]).unwrap().len(), 1);
}

#[test]
fn get_ignores_ids_that_are_not_there() {
    let conn = setup();
    let a = create(
        &conn,
        "a".into(),
        Selector::Untagged,
        HashMap::new(),
        [0; 3],
    )
    .unwrap();
    let got = get(&conn, &[a.info.id.clone(), "nope".into()]).unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].info.id, a.info.id);
}
