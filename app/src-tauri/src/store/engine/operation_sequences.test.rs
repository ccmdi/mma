use super::*;
use crate::selections::tree::{SelectionInput, SelectionOp};

#[test]
fn seeded_public_operation_traces_match_rows_indexes_selections_and_saved_history() {
    let mut store = setup_store_with(&[]);
    let mut model = BTreeMap::<Id<Location>, Location>::new();
    let mut selection_active = true;
    let mut undo = Vec::<(BTreeMap<Id<Location>, Location>, bool)>::new();
    let mut redo = Vec::<(BTreeMap<Id<Location>, Location>, bool)>::new();
    let mut next_id = 1;
    let set_tag_one_selection = |store: &mut Store, active: bool| {
        store.edit_selections(&SelectionOp::Set {
            selections: if active {
                vec![SelectionInput {
                    selector: Selector::Filter {
                        field: "tags".into(),
                        test: selections::FilterOp::Contains { value: 1.into() },
                    },
                    color: Some(Rgb([17, 91, 203])),
                }]
            } else {
                vec![]
            },
        });
    };
    set_tag_one_selection(&mut store, selection_active);

    let check = |store: &mut Store,
                 model: &BTreeMap<Id<Location>, Location>,
                 selection_active: bool,
                 undo: usize,
                 redo: usize,
                 context: &str| {
        assert_eq!(
            store_snapshot(store),
            model_snapshot(model),
            "rows diverged: {context}"
        );
        assert_eq!(*store.alive_count, model.len(), "alive count: {context}");
        assert_eq!(store.edits.len(Stack::Undo), undo, "undo length: {context}");
        assert_eq!(store.edits.len(Stack::Redo), redo, "redo length: {context}");
        for tag in 0..4 {
            let expected = model
                .values()
                .filter(|row| row.tags.contains(&Id::new(tag)))
                .count();
            assert_eq!(
                tag_count(store, tag),
                expected,
                "tag index {tag}: {context}"
            );
        }
        assert_eq!(
            store.selections.list().len(),
            usize::from(selection_active),
            "tag selection configuration: {context}"
        );
        let selected: Vec<_> = store.selections.ids.iter().collect();
        let expected: Vec<_> = if selection_active {
            model
                .values()
                .filter(|row| row.tags.contains(&Id::new(1)))
                .map(|row| row.id)
                .collect()
        } else {
            vec![]
        };
        assert_eq!(selected, expected, "tag selection membership: {context}");
    };

    for (seed, steps) in [
        (0x6d6d_6102_u32, 110),
        (0x5eed_cafe, 110),
        (0x1020_3040, 110),
        (0xdead_beef, 110),
    ] {
        let mut random = seed;
        let mut rng = || {
            random = random.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            random
        };
        for step in 0..steps {
            let choice = rng() % 11;
            let context = format!("seed=0x{seed:08x} step={step} choice={choice}");
            let tag_one_before = model
                .values()
                .filter(|row| row.tags.contains(&Id::new(1)))
                .count();
            match choice {
                0..=1 if model.len() < 32 => {
                    let id = next_id;
                    next_id += 1;
                    let row = loc(
                        id,
                        (rng() % 160) as f64 - 80.0,
                        (rng() % 340) as f64 - 170.0,
                    );
                    let before = (model.clone(), selection_active);
                    assert_eq!(store.alloc_id(), Id::new(id), "id allocation: {context}");
                    store.write([Op::Set(row.clone())], &mut None, Entry::default());
                    model.insert(row.id, row);
                    undo.push(before);
                    redo.clear();
                }
                2 if !model.is_empty() => {
                    let id = *model.keys().nth((rng() as usize) % model.len()).unwrap();
                    let before = (model.clone(), selection_active);
                    store.write([Op::Remove(id)], &mut None, Entry::default());
                    model.remove(&id);
                    undo.push(before);
                    redo.clear();
                }
                3..=5 if !model.is_empty() => {
                    let id = *model.keys().nth((rng() as usize) % model.len()).unwrap();
                    let mut row = model[&id].clone();
                    match choice {
                        3 => row.heading += 1.25,
                        4 => row.lat = (rng() % 160) as f64 - 80.0,
                        _ => {
                            row.extra =
                                RawExtra::from_string(format!(r#"{{"sequence":{}}}"#, rng()))
                        }
                    }
                    let before = (model.clone(), selection_active);
                    store.write([Op::Set(row.clone())], &mut None, Entry::default());
                    model.insert(row.id, row);
                    undo.push(before);
                    redo.clear();
                }
                6..=8 if !model.is_empty() => {
                    let id = *model.keys().nth((rng() as usize) % model.len()).unwrap();
                    let tag = rng() % 4;
                    let has_tag = model[&id].tags.contains(&Id::new(tag));
                    let op = Work::Locations(LocationOp::ListSet {
                        key: "tags".into(),
                        add: if has_tag {
                            vec![]
                        } else {
                            vec![serde_json::json!(tag)]
                        },
                        remove: if has_tag {
                            vec![serde_json::json!(tag)]
                        } else {
                            vec![]
                        },
                    });
                    let before = (model.clone(), selection_active);
                    apply_work(
                        &mut store,
                        &Selector::Locations {
                            locations: vec![id],
                            name: None,
                        },
                        &op,
                    )
                    .unwrap();
                    let row = model.get_mut(&id).unwrap();
                    if has_tag {
                        row.tags.retain(|current| *current != Id::new(tag));
                    } else {
                        row.tags.push(Id::new(tag));
                    }
                    undo.push(before);
                    redo.clear();
                }
                9 if !undo.is_empty() => {
                    let previous = undo.pop().unwrap();
                    redo.push((model.clone(), selection_active));
                    undo_and_finish(&mut store);
                    (model, selection_active) = previous;
                }
                10 if !redo.is_empty() => {
                    let next = redo.pop().unwrap();
                    undo.push((model.clone(), selection_active));
                    let changes = store.step(Stack::Redo, fetch_stored).unwrap().unwrap();
                    store.finish_entry(&changes);
                    (model, selection_active) = next;
                }
                _ => {}
            }
            if tag_one_before > 0
                && model.values().all(|row| !row.tags.contains(&Id::new(1)))
                && !matches!(choice, 9 | 10)
            {
                selection_active = false;
            }
            check(
                &mut store,
                &model,
                selection_active,
                undo.len(),
                redo.len(),
                &context,
            );
            if step % 37 == 36 {
                store = close_and_reopen(&store);
                set_tag_one_selection(&mut store, selection_active);
                check(
                    &mut store,
                    &model,
                    selection_active,
                    undo.len(),
                    redo.len(),
                    &format!("{context} after save/reopen"),
                );
            }
        }
    }
}
