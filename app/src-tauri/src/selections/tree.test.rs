use super::*;

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
