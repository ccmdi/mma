use super::*;
use serde_json::json;

#[derive(Clone, Debug, Default, PartialEq)]
struct Row {
    id: u32,
    name: String,
    extra: Option<Json>,
}

impl Keyed for Row {
    type Key = u32;
    fn key(&self) -> u32 {
        self.id
    }
}

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
struct RowPatch {
    id: u32,
    name: Option<String>,
    extra: Field<Json>,
}

impl Keyed for RowPatch {
    type Key = u32;
    fn key(&self) -> u32 {
        self.id
    }
}

impl Patchable for Row {
    type Patch = RowPatch;
    const WRITES: &'static [(&'static str, &'static str)] = &[("name", "name"), ("extra", "extra")];
    const MERGED: &'static [&'static str] = &["extra"];
    const CLEARS: &'static [&'static str] = &[];

    fn patched(&self, patch: &RowPatch) -> Self {
        let mut out = self.clone();
        if let Some(v) = &patch.name {
            out.name = v.clone();
        }
        out.extra = Merge::merged(&out.extra, &patch.extra);
        out
    }

    fn between(old: &Self, new: &Self) -> RowPatch {
        RowPatch {
            id: new.id,
            name: (old.name != new.name).then(|| new.name.clone()),
            extra: Merge::between(&old.extra, &new.extra),
        }
    }

    fn to_patch(&self) -> RowPatch {
        RowPatch {
            id: self.id,
            name: Some(self.name.clone()),
            extra: self.extra.clone().into(),
        }
    }
}

fn row(id: u32, name: &str) -> Row {
    Row {
        id,
        name: name.into(),
        extra: None,
    }
}

#[test]
fn a_value_is_the_same_however_its_numbers_and_keys_are_spelled() {
    let a = json!({ "n": 45, "list": [1, { "x": 2 }], "s": "a" });
    let b = json!({ "s": "a", "list": [1.0, { "x": 2.0 }], "n": 45.0 });
    assert!(same_field_value(Some(&a), Some(&b)));
    assert_eq!(canonical(&a), canonical(&b));
    assert!(!same_field_value(
        Some(&json!([1, 2])),
        Some(&json!([2, 1]))
    ));
    assert!(!same_field_value(Some(&json!(45)), None));
}

#[test]
fn the_patch_between_two_values_turns_one_into_the_other() {
    let old = Row {
        extra: json!({ "a": 1, "b": 2 }).as_object().cloned(),
        ..row(1, "old")
    };
    let new = Row {
        extra: json!({ "a": 1, "c": 3 }).as_object().cloned(),
        ..row(1, "new")
    };
    assert_eq!(old.patched(&Row::between(&old, &new)), new);
    assert_eq!(new.patched(&Row::between(&new, &old)), old);
}

#[test]
fn a_whole_value_as_a_patch_writes_it_over_any_row_with_nothing_merged_in() {
    let v = Row {
        extra: json!({ "a": 1 }).as_object().cloned(),
        ..row(1, "v")
    };
    assert_eq!(row(1, "other").patched(&v.to_patch()), v);
    assert_eq!(v.patched(&row(1, "w").to_patch()), row(1, "w"));
    assert_eq!(
        Row::between(&v, &v.patched(&v.to_patch())),
        RowPatch {
            id: 1,
            ..RowPatch::default()
        }
    );
}

#[test]
fn a_field_written_over_its_old_value_yields_the_new_one() {
    let cases = [None, Some(1), Some(2)];
    for old in &cases {
        for new in &cases {
            assert_eq!(Field::between(old, new).applied(old), *new);
        }
    }
}

#[test]
fn a_field_is_absent_null_or_a_value_on_the_wire() {
    #[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
    struct Slot {
        #[serde(default, skip_serializing_if = "Field::is_keep")]
        v: Field<u32>,
    }
    for (field, wire) in [
        (Field::Keep, json!({})),
        (Field::Clear, json!({ "v": null })),
        (Field::Set(7), json!({ "v": 7 })),
    ] {
        let slot = Slot { v: field };
        assert_eq!(serde_json::to_value(&slot).unwrap(), wire);
        assert_eq!(serde_json::from_value::<Slot>(wire).unwrap(), slot);
    }
}

#[test]
fn merging_the_patch_between_two_maps_yields_the_second() {
    let cases = [
        None,
        json!({ "a": 1 }).as_object().cloned(),
        json!({ "a": 2, "b": [1] }).as_object().cloned(),
    ];
    for old in &cases {
        for new in &cases {
            match Merge::between(old, new) {
                Field::Keep => assert!(same_field_value(
                    old.clone().map(Value::Object).as_ref(),
                    new.clone().map(Value::Object).as_ref(),
                )),
                patch => assert_eq!(Merge::merged(old, &patch), *new),
            }
        }
    }
}

#[test]
fn a_change_drops_rows_that_did_not_change() {
    let change = Change::from_iter([
        t(None, Some(row(1, "a"))),
        t(Some(row(2, "b")), None),
        t(Some(row(3, "c")), Some(row(3, "c"))),
        t(Some(row(4, "d")), Some(row(4, "e"))),
        t(None, None),
    ]);
    assert_eq!(change.added, vec![row(1, "a")]);
    assert_eq!(change.removed, vec![row(2, "b")]);
    assert_eq!(change.updated, vec![(row(4, "d"), row(4, "e"))]);
    assert_eq!(change.len(), 3);
    assert!(change.touches(1) && change.touches(4) && !change.touches(2) && !change.touches(3));
    assert_eq!(change.max_key(), Some(4));
    assert!(Change::<Row>::default().is_empty());
}

#[test]
fn the_inverse_of_an_inverse_is_the_change_itself() {
    let change = Change::from_sides(
        vec![row(1, "a"), row(2, "new")],
        vec![row(2, "old"), row(3, "c")],
    );
    assert_eq!(change.added, vec![row(1, "a")]);
    assert_eq!(change.removed, vec![row(3, "c")]);
    assert_eq!(change.updated, vec![(row(2, "old"), row(2, "new"))]);
    assert_eq!(change.inverse().inverse(), change);
    let (created, removed) = change.sides();
    assert_eq!(Change::from_sides(removed, created), change.inverse());
}

#[test]
fn composed_changes_keep_the_first_before_and_the_last_after() {
    let first = Change::from_iter([
        t(None, Some(row(1, "a"))),
        t(Some(row(2, "old")), Some(row(2, "mid"))),
    ]);
    let second = Change::from_iter([
        t(Some(row(2, "mid")), Some(row(2, "new"))),
        t(Some(row(1, "a")), None),
    ]);
    let both = first.then(second).unwrap();
    assert!(both.added.is_empty() && both.removed.is_empty());
    assert_eq!(both.updated, vec![(row(2, "old"), row(2, "new"))]);

    let there = Change::from_iter([t(Some(row(5, "x")), Some(row(5, "y")))]);
    let back = there.clone().inverse();
    assert!(there.then(back).unwrap().is_empty());
}

fn t(before: Option<Row>, after: Option<Row>) -> Transition<Row> {
    Transition::new(before, after)
}

fn rename(id: u32, name: &str) -> RowPatch {
    RowPatch {
        id,
        name: Some(name.into()),
        extra: Field::Keep,
    }
}

fn apply(r: &Row, p: &RowPatch) -> Row {
    r.patched(p)
}

#[test]
fn a_layer_reads_its_intents_over_the_row_below_as_it_is_now() {
    let mut layer: Layer<Row> = Layer::default();
    layer.extend([Op::Put(rename(1, "mine"))]);
    assert_eq!(
        layer.get(1, Some(row(1, "below")), apply),
        Some(row(1, "mine"))
    );
    assert_eq!(
        layer.get(
            1,
            Some(Row {
                extra: json!({ "k": 1 }).as_object().cloned(),
                ..row(1, "newer")
            }),
            apply
        ),
        Some(Row {
            extra: json!({ "k": 1 }).as_object().cloned(),
            ..row(1, "mine")
        }),
    );
    assert_eq!(layer.get(1, None, apply), None);
    assert_eq!(layer.get(2, Some(row(2, "b")), apply), Some(row(2, "b")));
}

#[test]
fn intents_land_in_order_and_a_set_or_remove_replaces_what_came_before() {
    let mut layer: Layer<Row> = Layer::default();
    layer.extend([Op::Put(rename(1, "first"))]);
    layer.extend([Op::Put(rename(1, "second"))]);
    assert_eq!(
        layer.get(1, Some(row(1, "below")), apply),
        Some(row(1, "second"))
    );

    layer.extend([Op::Remove(1)]);
    assert_eq!(layer.get(1, Some(row(1, "below")), apply), None);
    layer.extend([Op::Put(rename(1, "after remove"))]);
    assert_eq!(layer.get(1, Some(row(1, "below")), apply), None);

    layer.extend([Op::Set(row(1, "set"))]);
    layer.extend([Op::Put(rename(1, "edited"))]);
    assert_eq!(layer.get(1, None, apply), Some(row(1, "edited")));
}

#[test]
fn resolving_a_layer_pairs_each_key_with_its_row_before_and_after() {
    let mut layer: Layer<Row> = Layer::default();
    layer.extend([Op::Put(rename(1, "new"))]);
    layer.extend([Op::Remove(2)]);
    layer.extend([Op::Set(row(3, "added"))]);
    let below = |key: u32| (key < 3).then(|| row(key, "old"));
    let resolved: Vec<_> = layer.resolve(below, apply).collect();
    assert_eq!(
        resolved,
        vec![
            t(Some(row(1, "old")), Some(row(1, "new"))),
            t(Some(row(2, "old")), None),
            t(None, Some(row(3, "added"))),
        ]
    );
    let change = Change::from_iter(resolved);
    assert_eq!(change.len(), 3);
    assert!(layer.holds(2) && !layer.holds(4));
}

#[test]
fn the_change_between_two_tables_turns_one_into_the_other_and_back() {
    let before: HashMap<u32, &str> = HashMap::from([(1, "a"), (2, "b"), (3, "c")]);
    let after: HashMap<u32, &str> = HashMap::from([(1, "a"), (2, "B"), (4, "d")]);
    let change = Change::at(&before, &after, [1, 2, 3, 4]);
    assert_eq!(
        change.counts(),
        Counts {
            added: 1,
            removed: 1,
            updated: 1
        }
    );

    let mut table = before.clone();
    change.apply_to(&mut table);
    assert_eq!(table, after);
    change.inverse().apply_to(&mut table);
    assert_eq!(table, before);

    assert!(
        Change::at(&before, &after, [1]).is_empty(),
        "an untouched key is no change"
    );
}

#[test]
fn a_change_round_trips_through_its_serialized_form() {
    let change = Change::at(
        &HashMap::from([(1u32, 5)]),
        &HashMap::from([(1, 6), (2, 7)]),
        [1, 2],
    );
    let back: Change<(u32, i32)> =
        serde_json::from_str(&serde_json::to_string(&change).unwrap()).unwrap();
    assert_eq!(back, change);
}

#[test]
fn an_owned_key_composes_like_a_copied_one() {
    let before: HashMap<String, i32> = HashMap::from([("a".into(), 1), ("b".into(), 2)]);
    let mid: HashMap<String, i32> = HashMap::from([("b".into(), 2), ("c".into(), 1)]);
    let after: HashMap<String, i32> = HashMap::from([("c".into(), 9)]);
    let keys = || ["a", "b", "c"].map(String::from);
    let both = Change::at(&before, &mid, keys())
        .then(Change::at(&mid, &after, keys()))
        .unwrap();
    assert_eq!(both, Change::at(&before, &after, keys()));

    let mut table = before.clone();
    both.apply_to(&mut table);
    assert_eq!(table, after);
    both.inverse().apply_to(&mut table);
    assert_eq!(table, before);
}

#[test]
fn field_writes_compose_with_the_later_winning() {
    let writes = [Field::Keep, Field::Clear, Field::Set(1), Field::Set(2)];
    for old in [None, Some(0)] {
        for a in &writes {
            for b in &writes {
                let both = a.clone().then(b.clone());
                assert_eq!(both.applied(&old), b.applied(&a.applied(&old)));
            }
            assert_eq!(Field::Keep.then(a.clone()), *a);
            assert_eq!(a.clone().then(Field::Keep), *a);
        }
    }
}

#[test]
fn a_transition_composes_only_from_where_the_last_one_ended() {
    let up = Transition::new(Some(1), Some(2));
    let on = Transition::new(Some(2), None);
    assert_eq!(
        up.clone().then(on.clone()),
        Some(Transition::new(Some(1), None))
    );
    assert_eq!(on.clone().then(up.clone()), None);
    assert!(up.clone().then(up.clone().inverse()).unwrap().is_identity());
}

fn table(rows: &[(u32, i32)]) -> HashMap<u32, i32> {
    rows.iter().copied().collect()
}

#[test]
fn changes_form_a_groupoid() {
    let states = [
        table(&[(1, 1), (2, 2)]),
        table(&[(1, 5), (3, 3)]),
        table(&[(3, 4)]),
        table(&[(1, 1), (2, 7), (3, 4)]),
    ];
    let keys = [1, 2, 3];
    let step = |i: usize, j: usize| Change::at(&states[i], &states[j], keys);
    let (a, b, c) = (step(0, 1), step(1, 2), step(2, 3));

    let left = a.clone().then(b.clone()).unwrap().then(c.clone()).unwrap();
    let right = a.clone().then(b.clone().then(c.clone()).unwrap()).unwrap();
    assert_eq!(left, right, "composition is associative");

    let mut reached = states[0].clone();
    left.apply_to(&mut reached);
    assert_eq!(reached, states[3], "composing steps walks the whole way");

    assert_eq!(Change::default().then(a.clone()).unwrap(), a);
    assert_eq!(a.clone().then(Change::default()).unwrap(), a);
    assert!(a.clone().then(a.inverse()).unwrap().is_empty());

    let undone = a.clone().then(b.clone()).unwrap().inverse();
    let mut table = states[2].clone();
    undone.apply_to(&mut table);
    let mut stepped = states[2].clone();
    b.inverse()
        .then(a.inverse())
        .unwrap()
        .apply_to(&mut stepped);
    assert_eq!(
        table, stepped,
        "the inverse of a composite undoes it in reverse"
    );
    assert_eq!(table, states[0]);

    assert!(
        a.clone().then(c.clone()).is_err(),
        "a change that does not start where the last ended does not compose"
    );
}
