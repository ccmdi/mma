use super::*;
use crate::selections::Selector;
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

/// Every imported rule's body, read back through the parent module's primitives.
fn all(conn: &Connection) -> Vec<SavedSelection> {
    let ids: Vec<String> = super::super::list_info(conn)
        .unwrap()
        .into_iter()
        .map(|i| i.id)
        .collect();
    super::super::get(conn, &ids).unwrap()
}

const LEGACY: &str = r#"[
    {
        "id": "old-1",
        "name": "two rules",
        "createdAt": 1700000000000,
        "items": [
            { "props": { "type": "TagName", "tagName": "Japan" }, "color": [1, 2, 3] },
            { "props": { "type": "Untagged" }, "color": [4, 5, 6] }
        ]
    },
    {
        "id": "old-2",
        "name": "one rule",
        "createdAt": 1700000001000,
        "items": [{ "props": { "type": "Duplicates", "distance": 25 }, "color": [7, 7, 7] }]
    }
]"#;

#[test]
fn import_unions_multi_item_rules_and_keeps_single_ones_flat() {
    let mut conn = setup();
    assert_eq!(import(&mut conn, LEGACY).unwrap(), 2);

    let all = all(&conn);
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].info.name, "two rules");
    assert_eq!(all[0].info.color, [1, 2, 3]);
    match &all[0].selector {
        Selector::Union { selections } => {
            assert_eq!(selections.len(), 2);
            assert_eq!(selections[1].color, [4, 5, 6]);
        }
        _ => panic!("expected a Union"),
    }
    assert!(matches!(
        all[1].selector,
        Selector::Duplicates { distance: 25.0 }
    ));
}

#[test]
fn import_captures_every_tag_name_under_a_distinct_id() {
    let mut conn = setup();
    let json = r#"[{
        "name": "n",
        "items": [{ "props": { "type": "Union", "selections": [
            { "type": "TagName", "tagName": "Japan" },
            { "type": "TagName", "tagName": "Brazil" },
            { "type": "TagName", "tagName": "Japan" }
        ] } }]
    }]"#;
    import(&mut conn, json).unwrap();

    let saved = all(&conn).remove(0);
    let mut names: Vec<&str> = saved.tag_names.values().map(String::as_str).collect();
    names.sort();
    assert_eq!(names, vec!["Brazil", "Japan"]);

    let Selector::Union { selections } = &saved.selector else {
        panic!("expected a Union")
    };
    let ids: Vec<u32> = selections
        .iter()
        .map(|s| match s.selector {
            Selector::Tag { tag_id } => tag_id,
            _ => panic!("expected Tag leaves"),
        })
        .collect();
    // The same name reuses its id; a different name never collides with it.
    assert_eq!(ids[0], ids[2]);
    assert_ne!(ids[0], ids[1]);
    assert_eq!(saved.tag_names[&ids[1]], "Brazil");
}

#[test]
fn import_preserves_the_legacy_creation_time() {
    let mut conn = setup();
    import(&mut conn, LEGACY).unwrap();
    assert!(all(&conn)[0].info.created_at.starts_with("2023-11-14T"));
}

#[test]
fn import_is_a_no_op_once_the_table_holds_rules() {
    let mut conn = setup();
    assert_eq!(import(&mut conn, LEGACY).unwrap(), 2);
    assert_eq!(import(&mut conn, LEGACY).unwrap(), 0);
    assert_eq!(all(&conn).len(), 2);
}

#[test]
fn import_skips_rules_with_no_items() {
    let mut conn = setup();
    let n = import(&mut conn, r#"[{ "name": "empty", "items": [] }]"#).unwrap();
    assert_eq!(n, 0);
    assert!(all(&conn).is_empty());
}
