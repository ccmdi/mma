use super::*;
use crate::collab::support::nested_null;
use crate::selections::{Selection, Selector};
use crate::store::engine::{ListedSelection, Listing, LocationOp, Work};
use crate::store::maps::{
    ComparisonType, FieldChoice, FieldType, MapKeyAction, MapKeyBinding, MapSettings, ScoreBounds,
};
use crate::test_util::{loc, patch};
use crate::types::RawExtra;
use mma_algebra::{Change, Edit, Field, JsonWrite, Op, Patch, Transition};
use serde_json::json;

fn tripped(intent: Intent) -> Intent {
    let call = Up::Call {
        id: 1,
        call: Call::Write(intent),
    };
    let Ok(Up::Call {
        call: Call::Write(intent),
        ..
    }) = Up::decode(&call.encode().unwrap())
    else {
        panic!("a write arrives as one");
    };
    intent
}

fn ups() -> Vec<Up> {
    vec![
        Up::Hello {
            protocol: PROTOCOL,
            resume: Some(Resume { session: 9, seq: 4 }),
        },
        Up::Call {
            id: 3,
            call: Call::Lease(50),
        },
        Up::Call {
            id: 4,
            call: Call::Write(Intent::Edit {
                edits: location_edits(),
                records: records(),
            }),
        },
        Up::Call {
            id: 5,
            call: Call::Write(Intent::Values {
                field: "tags".into(),
                edits: value_edits(),
            }),
        },
        Up::Call {
            id: 6,
            call: Call::Write(Intent::Meta(Box::new(details()))),
        },
        Up::Call {
            id: 7,
            call: Call::Write(Intent::Work {
                selector: Selector::Locations {
                    locations: vec![Id::new(1), Id::new(4)],
                    name: None,
                },
                work: Work::Locations(LocationOp::ListSet {
                    key: "tags".into(),
                    add: vec![json!(3)],
                    remove: vec![nested_null()],
                }),
            }),
        },
        Up::Presence(
            serde_json::from_value::<Shown>(
                serde_json::json!({ "cursor": { "lat": 1.0, "lng": 2.0 } }),
            )
            .unwrap(),
        ),
        Up::Bye,
    ]
}

fn downs() -> Vec<Down> {
    vec![
        Down::Welcome {
            session: 9,
            roster: vec![
                Member {
                    login: "host".into(),
                    guest: false,
                },
                Member {
                    login: "guest--a1b2c3".into(),
                    guest: true,
                },
            ],
            catchup: Catchup::Snapshot,
        },
        Down::Snapshot(Part::Head(Box::new(Head {
            seq: 4,
            meta: details(),
            defs: HashMap::new(),
            records: HashMap::from([(
                "tags".to_string(),
                HashMap::from([(
                    Id::new(1),
                    ValueRecord {
                        id: Id::new(1),
                        name: Some("Rural".into()),
                        ..Default::default()
                    },
                )]),
            )]),
            total: 1,
        }))),
        Down::Snapshot(Part::Rows(vec![loc(1, 1.5, -2.5)])),
        Down::Snapshot(Part::End),
        Down::Reply {
            id: 3,
            reply: Ok(Reply::Wrote(Wrote {
                seq: Some(5),
                keys: vec![Id::new(7)],
                changed: 2,
                failed: vec![Id::new(4)],
            })),
        },
        Down::Reply {
            id: 4,
            reply: Err("every id this map can give is taken".into()),
        },
        Down::Presence {
            login: "octocat".into(),
            data: serde_json::from_value::<Shown>(serde_json::json!({ "cursor": null })).unwrap(),
        },
        Down::End(End::Ended("the host closed the map".into())),
    ]
}

#[test]
fn every_frame_decodes_to_what_was_encoded() {
    for frame in ups() {
        assert_eq!(Up::decode(&frame.encode().unwrap()).unwrap(), frame);
    }
    for frame in downs() {
        assert_eq!(Down::decode(&frame.encode().unwrap()).unwrap(), frame);
    }
}

#[test]
fn a_frame_over_the_limit_is_refused_both_ways() {
    let huge = Down::End(End::Refused("x".repeat(MAX_FRAME)));
    assert!(huge.encode().is_err());
    assert!(Down::decode(&vec![0; MAX_FRAME + 1]).is_err());
}

#[test]
fn bytes_that_hold_no_frame_are_an_error() {
    assert!(Up::decode(b"not a frame").is_err());
}

fn extra_row(id: u32) -> Location {
    Location {
        extra: RawExtra::from_value(&nested_null()),
        pano_id: Some("pano".into()),
        ..loc(id, 1.000_000_000_000_1, -2.5)
    }
}

fn record(name: &str) -> ValueRecord {
    ValueRecord {
        id: Id::new(3),
        name: Some(name.into()),
        order: Some(1),
        extra: nested_null().as_object().cloned().unwrap(),
    }
}

fn defs() -> Change<(String, FieldDef)> {
    Change::from_iter([Transition::new(
        None,
        Some((
            "kind".to_string(),
            FieldDef {
                field_type: FieldType::String,
                label: Some("Kind".into()),
                values: Some(vec![FieldChoice::labelled("a", "A")]),
                comparison: Some(ComparisonType::Circular { period: 360.0 }),
                interned: false,
                builtin: None,
            },
        )),
    )])
}

fn selections() -> Change<(String, Listing)> {
    let row = ListedSelection {
        selection: Selection::of(Selector::Everything),
        ghosted: false,
    };
    Change::from_iter([Transition::new(
        None,
        Some(("all".to_string(), Listing { order: 0, row })),
    )])
}

fn location_edits() -> Vec<Edit<Location>> {
    vec![
        Op::Add(extra_row(0)),
        Op::Set(extra_row(4)),
        Op::Put(patch!(4;
            heading: 90.0,
            pano_id: None,
            extra: Field::Set(JsonWrite::Replace(nested_null())),
        )),
        Op::Put(patch!(5; extra: Field::Set(JsonWrite::Merge(json!({ "gone": null }))))),
        Op::Remove(Id::new(6)),
    ]
}

fn records() -> HashMap<String, HashMap<Id<ValueRecord>, ValueRecord>> {
    HashMap::from([(
        "tags".to_string(),
        HashMap::from([(Id::new(3), record("Rural"))]),
    )])
}

fn value_edits() -> Vec<Edit<ValueRecord>> {
    vec![
        Op::Add(record("Urban")),
        Op::Put(Patch::<ValueRecord> {
            id: Id::new(3),
            name: Field::Set("Renamed".into()),
            order: Field::Clear,
            extra: JsonWrite::Replace(nested_null().as_object().cloned().unwrap()),
        }),
        Op::Remove(Id::new(9)),
    ]
}

fn details() -> Patch<MapMeta> {
    let plugin_data = HashMap::from([(
        "plugin".to_string(),
        Op::Put(HashMap::from([
            (
                "kept".to_string(),
                Op::Put(JsonWrite::Replace(nested_null())),
            ),
            ("gone".to_string(), Op::Remove(())),
        ])),
    )]);
    Patch::<MapMeta> {
        id: Id::new("shared".into()),
        name: Some("Renamed".into()),
        folder: Field::Clear,
        score_bounds: Some(ScoreBounds::Bounds([1.0, 2.0, 3.0, 4.0])),
        settings: Patch::<MapSettings> {
            plugin_data,
            key_bindings: Some(vec![MapKeyBinding {
                key: "m".into(),
                action: MapKeyAction::ApplyTag { tag_id: 3 },
            }]),
            ..Default::default()
        },
        ..Default::default()
    }
}

#[test]
fn an_entry_arrives_whole_without_its_selections() {
    let before = MapMeta {
        id: Id::new("shared".into()),
        name: "Before".into(),
        ..Default::default()
    };
    let mut after = MapMeta {
        name: "After".into(),
        score_bounds: ScoreBounds::Bounds([1.0, 2.0, 3.0, 4.0]),
        ..before.clone()
    };
    after.settings.key_bindings = vec![MapKeyBinding {
        key: "m".into(),
        action: MapKeyAction::ApplyTag { tag_id: 3 },
    }];
    after.settings.plugin_data = HashMap::from([(
        "plugin".into(),
        HashMap::from([("kept".into(), Json(nested_null()))]),
    )]);
    let entry = Entry {
        locations: Change {
            added: vec![extra_row(1)],
            removed: vec![loc(2, 3.0, 3.0)],
            updated: vec![(loc(4, 4.0, 4.0), extra_row(4))],
        },
        records: HashMap::from([(
            "tags".to_string(),
            Change::from_iter([Transition::new(
                Some((Id::new(3), record("Rural"))),
                Some((Id::new(3), record("Urban"))),
            )]),
        )]),
        defs: defs(),
        meta: Change::from_iter([Transition::new(Some(before), Some(after))]),
        selections: selections(),
    };

    let change = Down::Change {
        seq: 1,
        change: Arc::new(entry.clone()),
    };
    let Ok(Down::Change {
        change: arrived, ..
    }) = Down::decode(&change.encode().unwrap())
    else {
        panic!("a change arrives as one");
    };
    let Intent::Entry(written) = tripped(Intent::Entry(Box::new(entry.clone()))) else {
        panic!("a whole change arrives as one");
    };

    let shared = Entry {
        selections: Default::default(),
        ..entry
    };
    assert_eq!(*arrived, shared);
    assert_eq!(*written, shared);
}
