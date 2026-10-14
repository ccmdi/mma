use super::*;
use crate::selections::saved;

#[test]
fn selection_tree_preserves_existing_behavior() {
    let fixtures: serde_json::Value =
        serde_json::from_str(include_str!("tree.fixtures.json")).unwrap();
    for (index, case) in fixtures["build"].as_array().unwrap().iter().enumerate() {
        let expected: Selection = serde_json::from_value(case["expected"].clone()).unwrap();
        let input: SelectionInput =
            serde_json::from_value(serde_json::json!({"selector": case["selector"]})).unwrap();
        let actual = input.compile();
        assert_eq!(actual.key, expected.key, "build {index}");
        if !matches!(actual.selector, Selector::Polygon { .. }) {
            assert_eq!(actual.color, expected.color, "color {index}");
        }
    }
    for (index, case) in fixtures["ops"].as_array().unwrap().iter().enumerate() {
        let before: Vec<ListedSelection> = serde_json::from_value(case["before"].clone()).unwrap();
        let expected: Vec<ListedSelection> = serde_json::from_value(case["after"].clone()).unwrap();
        let actual = if case["op"]["kind"] == "rewriteFields" {
            let from = case["op"]["from"].as_str().unwrap();
            let to = case["op"]["to"].as_str();
            before
                .iter()
                .filter_map(|row| {
                    rewrite(&row.selection, from, to).map(|selection| ListedSelection {
                        selection,
                        ghosted: row.ghosted,
                    })
                })
                .collect()
        } else {
            let op: SelectionOp = serde_json::from_value(case["op"].clone()).unwrap();
            op.apply(&before)
        };
        assert_eq!(actual, expected, "operation {index}: {}", case["op"]);
    }
}

#[test]
fn number_keys_match_javascript_number_boundaries() {
    assert_eq!(number(-0.0), "0");
    assert_eq!(number(1e-6), "0.000001");
    assert_eq!(number(1e-7), "1e-7");
    assert_eq!(number(1e21), "1e+21");
}

#[test]
fn base36_key_encoding_handles_digit_boundaries_and_u32_max() {
    assert_eq!(base36(0), "0");
    assert_eq!(base36(35), "z");
    assert_eq!(base36(36), "10");
    assert_eq!(base36(u32::MAX), "1z141z3");
}

#[test]
fn location_keys_ignore_the_display_name_but_preserve_id_order() {
    let named = Selector::Locations {
        locations: vec![Id::new(4), Id::new(9), Id::new(12)],
        name: Some("first label".into()),
    };
    let renamed = Selector::Locations {
        locations: vec![Id::new(4), Id::new(9), Id::new(12)],
        name: Some("new label".into()),
    };
    let reordered = Selector::Locations {
        locations: vec![Id::new(12), Id::new(9), Id::new(4)],
        name: None,
    };
    assert_eq!(key(&named), key(&renamed));
    assert_ne!(key(&named), key(&reordered));
    assert_eq!(key(&named), key(&named));
}

#[test]
fn location_keys_include_the_list_length_and_repeated_ids() {
    let one = Selector::Locations {
        locations: vec![Id::new(8)],
        name: None,
    };
    let repeated = Selector::Locations {
        locations: vec![Id::new(8), Id::new(8)],
        name: None,
    };
    assert_ne!(key(&one), key(&repeated));
}

#[test]
fn numeric_selector_keys_use_normalized_decimal_and_exponent_forms() {
    let selector = Selector::Nearby {
        selection: None,
        lat: -0.0,
        lng: 1e-6,
        radius_m: 1e21,
    };
    assert_eq!(key(&selector), "nearby:0:0.000001:1e+21:");
}

#[test]
fn tree_path_lookup_accepts_only_existing_child_indices() {
    let leaf = Selection::of(Selector::Filter {
        field: "tags".into(),
        test: FilterOp::Has,
    });
    let group = Selection::of(Selector::Union {
        selections: vec![leaf.clone()],
    });
    let rows = [ListedSelection {
        selection: group.clone(),
        ghosted: false,
    }];
    assert_eq!(at(&rows, &[0]), Some(&group));
    assert_eq!(at(&rows, &[0, 0]), Some(&leaf));
    assert_eq!(at(&rows, &[]), None);
    assert_eq!(at(&rows, &[1]), None);
    assert_eq!(at(&rows, &[0, 1]), None);
}

fn listed(selectors: impl IntoIterator<Item = Selector>) -> Vec<ListedSelection> {
    selectors
        .into_iter()
        .map(|selector| ListedSelection {
            selection: Selection::of(selector),
            ghosted: false,
        })
        .collect()
}

fn tagged(id: u32) -> Selector {
    Selector::tag(id)
}

#[test]
fn compose_groups_the_dragged_row_into_the_target_by_the_group_it_names() {
    let rows = listed([tagged(1), tagged(2)]);
    for (group, expected) in [
        (
            Group::Union,
            Selector::Union {
                selections: vec![Selection::of(tagged(2)), Selection::of(tagged(1))],
            },
        ),
        (
            Group::Intersection,
            Selector::Intersection {
                selections: vec![Selection::of(tagged(2)), Selection::of(tagged(1))],
            },
        ),
    ] {
        let out = SelectionOp::Compose {
            drag: vec![0],
            drop: vec![1],
            group,
        }
        .apply(&rows);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].selection.selector, expected);
    }
    let inverted = serde_json::from_value::<SelectionOp>(serde_json::json!({
        "kind": "compose", "drag": [0], "drop": [1], "group": "Invert"
    }));
    assert!(inverted.is_err(), "an inverted compose is unwritable");
}

#[test]
fn complement_replaces_the_rows_with_what_none_of_them_selects() {
    let rows = listed([tagged(1), tagged(2)]);
    let out = SelectionOp::Complement { keys: None }.apply(&rows);
    assert_eq!(out.len(), 1);
    assert_eq!(
        out[0].selection.selector,
        Selector::Invert {
            selections: vec![Selection::of(Selector::Union {
                selections: vec![Selection::of(tagged(1)), Selection::of(tagged(2))],
            })],
        }
    );
    let back = SelectionOp::Complement { keys: None }.apply(&out);
    assert_eq!(
        back[0].selection.selector,
        Selector::Union {
            selections: vec![Selection::of(tagged(1)), Selection::of(tagged(2))],
        }
    );
}

#[test]
fn move_places_the_row_before_or_after_its_target() {
    let rows = listed([tagged(1), tagged(2), tagged(3)]);
    let keys = |out: Vec<ListedSelection>| -> Vec<String> {
        out.into_iter().map(|r| r.selection.key).collect()
    };
    let key_of = |id| Selection::of(tagged(id)).key;
    let before = SelectionOp::Move {
        from: vec![2],
        to: vec![0],
        place: Place::Before,
    }
    .apply(&rows);
    assert_eq!(keys(before), [key_of(3), key_of(1), key_of(2)]);
    let after = SelectionOp::Move {
        from: vec![0],
        to: vec![1],
        place: Place::After,
    }
    .apply(&rows);
    assert_eq!(keys(after), [key_of(2), key_of(1), key_of(3)]);
}

#[test]
fn a_stored_review_mode_string_reads_as_its_mode_and_keeps_its_key() {
    for (stored, mode) in [
        ("reviewed", ReviewMode::Reviewed),
        ("unreviewed", ReviewMode::Unreviewed),
    ] {
        let selector: Selector = serde_json::from_value(saved::modernize(
            serde_json::json!({"type": "Reviewed", "locations": [1], "sessionId": "s", "mode": stored}),
        ))
        .unwrap();
        assert!(matches!(selector, Selector::Reviewed { mode: m, .. } if m == mode));
        assert_eq!(key(&selector), format!("review:s:{stored}"));
    }
}

#[test]
fn a_selector_takes_the_same_default_colour_by_every_path_that_builds_it() {
    let reviewed = Selector::Reviewed {
        locations: vec![Id::new(1)],
        session_id: "s".into(),
        mode: ReviewMode::Unreviewed,
    };
    for selector in [tagged(1), reviewed] {
        let key = key(&selector);
        let expected = default_color(&selector, &key);
        assert_eq!(Selection::of(selector.clone()).color, expected);
        let compiled =
            serde_json::from_value::<SelectionInput>(serde_json::json!({ "selector": selector }))
                .unwrap()
                .compile();
        assert_eq!(compiled.color, expected);
        let read: Selection =
            serde_json::from_value(serde_json::json!({ "selector": selector })).unwrap();
        assert_eq!(read.color, expected);
    }
    let rows = listed([tagged(1), tagged(2)]);
    let combined = SelectionOp::Combine {
        group: Group::Union,
        keys: None,
    }
    .apply(&rows);
    let group = Selection::of(combined[0].selection.selector.clone());
    assert_eq!(combined[0].selection.color, group.color);
}

#[test]
fn a_rewrite_keeps_a_leafs_colour_and_a_groups_colour_only_while_its_key_holds() {
    let mut leaf = Selection::of(tagged(1));
    leaf.color = Rgb([1, 2, 3]);
    let renamed = leaf.rebuilt(tagged(2));
    assert_eq!(renamed.key, Selection::of(tagged(2)).key);
    assert_eq!(
        renamed.color,
        Rgb([1, 2, 3]),
        "a rewritten leaf keeps its colour"
    );

    let mut group = Selection::of(Selector::Union {
        selections: vec![leaf.clone(), Selection::of(tagged(3))],
    });
    group.color = Rgb([4, 5, 6]);
    let mut recoloured_child = leaf.clone();
    recoloured_child.color = Rgb([7, 8, 9]);
    let same_key = group.rebuilt(Selector::Union {
        selections: vec![recoloured_child, Selection::of(tagged(3))],
    });
    assert_eq!(same_key.color, Rgb([4, 5, 6]), "same members, same colour");

    let new_members = Selector::Union {
        selections: vec![leaf, Selection::of(tagged(4))],
    };
    let regrouped = group.rebuilt(new_members.clone());
    assert_eq!(
        regrouped.color,
        Selection::of(new_members).color,
        "a group whose members changed is new"
    );
}
