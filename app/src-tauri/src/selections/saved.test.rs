use super::*;
use crate::selections::tree::SelectionOp;
use crate::selections::{FilterOp, PolygonGeometry, Selection, Selector};
use crate::store::engine::{Tracked, ValueRecord};
use crate::store::maps::{FieldDef, FieldType};
use crate::test_util;
use crate::test_util::{loc_ids, tag_ids};
use crate::types::{Location, RawExtra};
use crate::util::Rgb;
use mma_algebra::Id;
use rusqlite::Connection;

/// In-memory DB with the current `saved_selections` schema.
fn setup() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE saved_selections (
            id         TEXT PRIMARY KEY NOT NULL,
            name       TEXT NOT NULL,
            selector   TEXT NOT NULL,
            value_names TEXT NOT NULL DEFAULT '{}',
            color      TEXT NOT NULL,
            created_at TEXT NOT NULL
         );",
    )
    .unwrap();
    conn
}

fn tag_names(pairs: &[(u32, &str)]) -> ValueNames {
    ValueNames::from([(
        "tags".to_string(),
        pairs
            .iter()
            .map(|(id, n)| (Id::new(*id), n.to_string()))
            .collect(),
    )])
}

/// Every rule's body, via the two primitives the frontend uses: index, then bodies.
fn all(conn: &Connection) -> Vec<SavedSelection> {
    let ids: Vec<_> = list_info(conn).unwrap().into_iter().map(|i| i.id).collect();
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
                    color: Rgb([1, 2, 3]),
                    selector: Selector::tag(4),
                },
                Selection {
                    key: "untagged".into(),
                    color: Rgb([4, 5, 6]),
                    selector: Selector::untagged(),
                },
            ],
        },
        tag_names(&[(4, "Japan")]),
        Rgb([9, 9, 9]),
    )
    .unwrap();

    let all = all(&conn);
    assert_eq!(all.len(), 1);
    let got = &all[0];
    assert_eq!(got.info.id, created.info.id);
    assert_eq!(got.info.name, "Japan dupes");
    assert_eq!(got.info.color, Rgb([9, 9, 9]));
    assert_eq!(
        got.value_names["tags"].get(&Id::new(4)).map(String::as_str),
        Some("Japan")
    );
    match &got.selector {
        Selector::Union { selections } => {
            assert_eq!(selections.len(), 2);
            assert_eq!(
                serde_json::to_value(&selections[0].selector).unwrap(),
                serde_json::to_value(Selector::tag(4)).unwrap()
            );
            assert_eq!(selections[0].color, Rgb([1, 2, 3]));
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
        Selector::untagged(),
        HashMap::new(),
        Rgb([0; 3]),
    )
    .unwrap();
    create(
        &conn,
        "b".into(),
        Selector::unpanned(),
        HashMap::new(),
        Rgb([0; 3]),
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
        Selector::untagged(),
        HashMap::new(),
        Rgb([0; 3]),
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
            polygon: PolygonGeometry {
                coordinates: vec![vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]],
                extra_polygons: None,
                properties: None,
            },
        },
        HashMap::new(),
        Rgb([4, 5, 6]),
    )
    .unwrap();

    let index = list_info(&conn).unwrap();
    assert_eq!(index.len(), 1);
    assert_eq!(index[0].name, "heavy");
    assert_eq!(index[0].color, Rgb([4, 5, 6]));
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
        Selector::untagged(),
        HashMap::new(),
        Rgb([0; 3]),
    )
    .unwrap();
    let got = get(&conn, &[a.info.id.clone(), Id::new("nope".into())]).unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].info.id, a.info.id);
}

#[test]
fn a_topk_row_reads_as_a_ranked_over_the_rows_that_hold_the_field() {
    let old = r#"{"type":"TopK","field":"altitude","k":10,"ascending":true}"#;
    let selector: Selector =
        serde_json::from_value::<Selector>(modernize(serde_json::from_str(old).unwrap())).unwrap();
    let Selector::Ranked {
        selection,
        expr,
        k,
        ascending,
    } = selector
    else {
        panic!("not a ranked");
    };
    assert_eq!(expr, "altitude");
    assert_eq!(k, Some(10));
    assert!(ascending);
    // TopK never offered a row lacking the field; the child is what withholds it now.
    let child = selection.expect("ranks a filtered child");
    assert_eq!(child.key, "filter:altitude:has:null");
    assert!(matches!(
        child.selector,
        Selector::Filter { ref field, test: FilterOp::Has } if field == "altitude"
    ));
}

#[test]
fn a_filter_row_written_before_0_10_2_still_reads() {
    let old = r#"{"type":"Intersection","selections":[
        {"key":"a","color":[0,0,0],"selector":{"type":"Filter","field":"altitude","op":"between","value":1,"value2":2,"tzLocal":true}},
        {"key":"b","color":[0,0,0],"selector":{"type":"Filter","field":"panoId","op":"has","value":null,"value2":null,"tzLocal":false}},
        {"key":"c","color":[0,0,0],"selector":{"type":"Filter","field":"country","op":"neq","value":"US"}}
    ]}"#;
    let Selector::Intersection { selections } =
        serde_json::from_value::<Selector>(modernize(serde_json::from_str(old).unwrap())).unwrap()
    else {
        panic!("not an intersection");
    };
    let tests: Vec<FilterOp> = selections
        .into_iter()
        .map(|s| match s.selector {
            Selector::Filter { test, .. } => test,
            _ => panic!("not a filter"),
        })
        .collect();
    assert_eq!(
        tests,
        vec![
            FilterOp::Between {
                lo: serde_json::json!(1),
                hi: serde_json::json!(2),
                tz_local: true
            },
            FilterOp::Has,
            FilterOp::Neq {
                value: serde_json::json!("US")
            },
        ]
    );
}

#[test]
fn a_flag_filter_row_written_as_zero_or_one_reads_as_a_boolean() {
    for (stored, expected) in [
        (
            r#"{"type":"Filter","field":"loadAsPanoId","test":{"op":"eq","value":1}}"#,
            true,
        ),
        (
            r#"{"type":"Filter","field":"loadAsPanoId","test":{"op":"eq","value":0}}"#,
            false,
        ),
        (
            r#"{"type":"Filter","field":"loadAsPanoId","op":"eq","value":1}"#,
            true,
        ),
    ] {
        let selector: Selector =
            serde_json::from_value(modernize(serde_json::from_str(stored).unwrap())).unwrap();
        let Selector::Filter { test, .. } = selector else {
            panic!("not a filter");
        };
        assert_eq!(
            test,
            FilterOp::Eq {
                value: serde_json::Value::Bool(expected)
            }
        );
    }
}

#[test]
fn a_flag_filter_row_under_a_range_operator_keeps_its_meaning() {
    let eq = |value: bool| FilterOp::Eq {
        value: serde_json::Value::Bool(value),
    };
    for (op, value, expected) in [
        ("gt", 0, Some(eq(true))),
        ("gte", 1, Some(eq(true))),
        ("lt", 1, Some(eq(false))),
        ("lte", 0, Some(eq(false))),
        ("neq", 0, Some(eq(true))),
        ("neq", 1, Some(eq(false))),
        ("gt", 1, None),
        ("gte", 0, None),
        ("lt", 0, None),
        ("lte", 1, None),
    ] {
        let stored =
            format!(r#"{{"type":"Filter","field":"loadAsPanoId","op":"{op}","value":{value}}}"#);
        let selector: Selector =
            serde_json::from_value(modernize(serde_json::from_str(&stored).unwrap())).unwrap();
        let Selector::Filter { test, .. } = selector else {
            panic!("not a filter");
        };
        let unchanged = serde_json::from_value::<FilterOp>(
            serde_json::json!({"op": op, "value": value, "tzLocal": false}),
        )
        .unwrap();
        assert_eq!(test, expected.unwrap_or(unchanged), "{op} {value}");
    }
}

fn map_with_records() -> Store {
    let mut store = Store::new();
    let record = |id: u32, name: &str| {
        (
            Id::new(id),
            ValueRecord {
                id: Id::new(id),
                name: Some(name.into()),
                ..Default::default()
            },
        )
    };
    let records = HashMap::from([record(9, "japan"), record(3, "Coastal")]);
    store.records.insert("tags".into(), Tracked::new(records));
    let mut row = test_util::loc(1, 0.0, 0.0);
    row.tags = tag_ids([9]);
    store.write([mma_algebra::Op::Set(row)], &mut None, Default::default());
    store
}

#[test]
fn saved_membership_follows_visible_names_without_rewriting_the_rule() {
    let conn = setup();
    let saved = create(
        &conn,
        "rule".into(),
        Selector::tag(5),
        tag_names(&[(5, "Japan")]),
        Rgb([1, 2, 3]),
    )
    .unwrap();
    let mut store = map_with_records();
    let before = serde_json::to_value(&saved).unwrap();
    assert_eq!(saved.resolved(&mut store), Selector::tag(9));
    store
        .records
        .get_mut("tags")
        .unwrap()
        .edit()
        .get_mut(&Id::new(9))
        .unwrap()
        .name = Some("Asia/Japan".into());
    assert_eq!(
        saved.resolved(&mut store),
        Selector::Locations {
            locations: loc_ids([]),
            name: None
        }
    );
    assert_eq!(serde_json::to_value(&saved).unwrap(), before);
}

#[test]
fn saved_names_do_not_resurrect_dark_records() {
    let conn = setup();
    let saved = create(
        &conn,
        "rule".into(),
        Selector::tag(3),
        tag_names(&[(3, "Coastal")]),
        Rgb([1, 2, 3]),
    )
    .unwrap();
    assert_eq!(
        saved.resolved(&mut map_with_records()),
        Selector::Locations {
            locations: loc_ids([]),
            name: None
        }
    );
}

#[test]
fn a_missing_saved_leaf_preserves_its_composite_and_child_colors() {
    let conn = setup();
    let mut alive = Selection::of(Selector::tag(5));
    alive.color = Rgb([8, 7, 6]);
    let saved = create(
        &conn,
        "rule".into(),
        Selector::Intersection {
            selections: vec![alive, Selection::of(Selector::tag(8))],
        },
        tag_names(&[(5, "Japan"), (8, "Gone")]),
        Rgb([1, 2, 3]),
    )
    .unwrap();
    let Selector::Intersection { selections } = saved.resolved(&mut map_with_records()) else {
        panic!("composite lost")
    };
    assert_eq!(selections[0].selector, Selector::tag(9));
    assert_eq!(selections[0].color, Rgb([8, 7, 6]));
    assert_eq!(
        selections[1].selector,
        Selector::Locations {
            locations: loc_ids([]),
            name: None
        }
    );
}

#[test]
fn portable_names_are_captured_at_every_depth() {
    let store = map_with_records();
    let selector = Selector::Intersection {
        selections: vec![
            Selection::of(Selector::tag(9)),
            Selection::of(Selector::Invert {
                selections: vec![Selection::of(Selector::tag(3))],
            }),
        ],
    };
    assert_eq!(
        capture_names(&selector, &store),
        tag_names(&[(9, "japan"), (3, "Coastal")])
    );
}

fn map_with_plates(records: &[(u32, &str)], held: &[u32]) -> Store {
    let mut store = Store::new();
    store.field_defs = Tracked::new(HashMap::from([(
        "plates".to_string(),
        FieldDef {
            field_type: FieldType::Array,
            label: None,
            values: None,
            comparison: None,
            interned: true,
            builtin: None,
        },
    )]));
    let records = records
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
    store.records.insert("plates".into(), Tracked::new(records));
    let row = Location {
        extra: RawExtra::from_value(&serde_json::json!({ "plates": held, "codes": [4] })),
        ..test_util::loc(1, 0.0, 0.0)
    };
    store.write([mma_algebra::Op::Set(row)], &mut None, Default::default());
    store
}

#[test]
fn a_rule_over_any_interned_field_carries_its_values_to_another_map_by_name() {
    let conn = setup();
    let contains = |field: &str, id: u32| Selector::Filter {
        field: field.into(),
        test: FilterOp::Contains { value: id.into() },
    };
    let selector = Selector::Intersection {
        selections: vec![
            Selection::of(contains("plates", 4)),
            Selection::of(contains("codes", 4)),
        ],
    };
    let source = map_with_plates(&[(4, "AB-123")], &[4]);
    let names = capture_names(&selector, &source);
    assert_eq!(
        names,
        ValueNames::from([(
            "plates".to_string(),
            HashMap::from([(Id::new(4), "AB-123".to_string())])
        )])
    );
    let id = create(&conn, "rule".into(), selector, names, Rgb([1, 2, 3]))
        .unwrap()
        .info
        .id;
    let saved = get(&conn, &[id]).unwrap().remove(0);

    let mut target = map_with_plates(&[(4, "XY-999"), (7, "ab-123")], &[7]);
    let Selector::Intersection { selections } = saved.resolved(&mut target) else {
        panic!("composite lost")
    };
    assert_eq!(selections[0].selector, contains("plates", 7));
    assert_eq!(
        selections[1].selector,
        contains("codes", 4),
        "a list field that interns nothing keeps its literal test"
    );
}

#[test]
fn adding_a_saved_selection_reads_it_and_adds_its_parts() {
    storage::tests::map_on_disk("add-saved");
    let saved = create(
        &storage::open_db().unwrap(),
        "everything".into(),
        Selector::Everything,
        ValueNames::new(),
        Rgb([1, 2, 3]),
    )
    .unwrap();
    let edit: SelectionEdit =
        serde_json::from_value(serde_json::json!({ "kind": "addSaved", "id": saved.info.id }))
            .unwrap();
    let mut store = Store::new();
    let op = edit.resolved(&mut store).unwrap();
    store.edit_selections(&op);
    let listed = store.selections.list();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].selection.selector, Selector::Everything);
    assert_eq!(listed[0].selection.color, Rgb([1, 2, 3]));
}

#[test]
fn any_other_selection_edit_passes_through_as_it_was_asked() {
    let edit: SelectionEdit =
        serde_json::from_value(serde_json::json!({ "kind": "remove", "keys": ["a"] })).unwrap();
    let op = edit.resolved(&mut Store::new()).unwrap();
    assert!(matches!(op, SelectionOp::Remove { keys } if keys == ["a"]));
}
