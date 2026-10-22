use super::*;
use serde_json::json;
use std::collections::HashSet;

#[derive(Clone, Debug, Default, PartialEq)]
struct Row {
    id: u32,
    name: String,
    extra: Option<Object>,
}

impl Keyed for Row {
    type Key = u32;
    fn key(&self) -> u32 {
        self.id
    }
    fn set_key(&mut self, key: u32) {
        self.id = key;
    }
}

#[derive(Clone, Debug, Default, PartialEq, serde::Deserialize)]
struct RowPatch {
    id: u32,
    name: Option<String>,
    extra: Patch<Option<Object>>,
}

impl Keyed for RowPatch {
    type Key = u32;
    fn key(&self) -> u32 {
        self.id
    }
    fn set_key(&mut self, key: u32) {
        self.id = key;
    }
}

impl Patchable for Row {
    type Patch = RowPatch;
    const WRITES: &'static [(&'static str, &'static str)] = &[("name", "name"), ("extra", "extra")];
    const CLEARS: &'static [&'static str] = &[];

    fn patched(&self, patch: &RowPatch) -> Self {
        let mut out = self.clone();
        if let Some(v) = &patch.name {
            out.name = v.clone();
        }
        out.extra = out.extra.patched(&patch.extra);
        out
    }

    fn between(old: &Self, new: &Self) -> RowPatch {
        RowPatch {
            id: new.id,
            name: (old.name != new.name).then(|| new.name.clone()),
            extra: Patchable::between(&old.extra, &new.extra),
        }
    }

    fn to_patch(&self) -> RowPatch {
        RowPatch {
            id: self.id,
            name: Some(self.name.clone()),
            extra: self.extra.to_patch(),
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
            match Patchable::between(old, new) {
                Field::Keep => assert!(same_field_value(
                    old.clone().map(Value::Object).as_ref(),
                    new.clone().map(Value::Object).as_ref(),
                )),
                patch => assert_eq!(old.patched(&patch), *new),
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
    assert_eq!(change.after().map(|r| r.id).collect::<Vec<_>>(), [1, 4]);
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
    layer.write([Op::Put(rename(1, "mine"))]);
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
    layer.write([Op::Put(rename(1, "first"))]);
    layer.write([Op::Put(rename(1, "second"))]);
    assert_eq!(
        layer.get(1, Some(row(1, "below")), apply),
        Some(row(1, "second"))
    );

    layer.write([Op::Remove(1)]);
    assert_eq!(layer.get(1, Some(row(1, "below")), apply), None);
    layer.write([Op::Put(rename(1, "after remove"))]);
    assert_eq!(layer.get(1, Some(row(1, "below")), apply), None);

    layer.write([Op::Set(row(1, "set"))]);
    layer.write([Op::Put(rename(1, "edited"))]);
    assert_eq!(layer.get(1, None, apply), Some(row(1, "edited")));
}

#[test]
fn resolving_a_layer_pairs_each_key_with_its_row_before_and_after() {
    let mut layer: Layer<Row> = Layer::default();
    layer.write([Op::Put(rename(1, "new"))]);
    layer.write([Op::Remove(2)]);
    layer.write([Op::Set(row(3, "added"))]);
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
    assert_eq!(layer.keys().collect::<Vec<_>>(), [1, 2, 3]);
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
    let there_and_back = up.clone().then(up.clone().inverse()).unwrap();
    assert_eq!(there_and_back.before, there_and_back.after);
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

/// Deterministic sparse tables with varied adds, updates and deletes.
fn generated_table(mut seed: u32) -> HashMap<u32, i16> {
    let mut table = HashMap::new();
    for key in 0..24 {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        if seed & 3 != 0 {
            table.insert(key, (seed >> 16) as i16);
        }
    }
    table
}

#[test]
fn sparse_changes_apply_and_inverse_restore_generated_tables() {
    for seed in 0..96 {
        let before = generated_table(seed * 3 + 1);
        let after = generated_table(seed * 3 + 2);
        let keys: BTreeSet<u32> = before.keys().chain(after.keys()).copied().collect();
        let change = Change::at(&before, &after, keys.iter().copied());
        let mut actual = before.clone();
        change.apply_to(&mut actual);
        assert_eq!(actual, after, "forward delta for seed {seed}");
        change.inverse().apply_to(&mut actual);
        assert_eq!(actual, before, "inverse delta for seed {seed}");
    }
}

#[test]
fn composing_sparse_changes_equals_the_direct_change_for_generated_tables() {
    for seed in 0..96 {
        let first = generated_table(seed * 3 + 1);
        let middle = generated_table(seed * 3 + 2);
        let last = generated_table(seed * 3 + 3);
        let keys: BTreeSet<u32> = first
            .keys()
            .chain(middle.keys())
            .chain(last.keys())
            .copied()
            .collect();
        let key_list: Vec<_> = keys.iter().copied().collect();
        let composed = Change::at(&first, &middle, key_list.iter().copied())
            .then(Change::at(&middle, &last, key_list.iter().copied()))
            .expect("adjacent states compose");
        let mut composed = composed;
        let mut direct = Change::at(&first, &last, key_list);
        composed.added.sort_by_key(|row| row.0);
        composed.removed.sort_by_key(|row| row.0);
        composed.updated.sort_by_key(|(before, _)| before.0);
        direct.added.sort_by_key(|row| row.0);
        direct.removed.sort_by_key(|row| row.0);
        direct.updated.sort_by_key(|(before, _)| before.0);
        assert_eq!(composed, direct, "composed delta for seed {seed}");
    }
}
#[test]
fn merged_arrays_replace_whole_values_without_mutating_the_inputs() {
    let original = json!({ "shape": [1, 2], "extra": { "keep": true } })
        .as_object()
        .cloned()
        .unwrap();
    let patch = json!({ "shape": [3], "new": "value" })
        .as_object()
        .cloned()
        .unwrap();
    let original_before = original.clone();
    let patch_before = patch.clone();

    let result = Some(original.clone())
        .patched(&Field::Set(patch.clone().into()))
        .unwrap();
    assert_eq!(
        Value::Object(result),
        json!({
            "shape": [3], "extra": { "keep": true }, "new": "value"
        })
    );
    assert_eq!(
        original, original_before,
        "merging must not mutate the old value"
    );
    assert_eq!(
        patch, patch_before,
        "merging must not consume or mutate the patch"
    );
}

#[test]
fn a_null_patch_key_removes_one_key_while_clear_removes_the_entire_map() {
    let original = json!({ "first": 1, "last": [2, 3] }).as_object().cloned();
    let remove_first = json!({ "first": null }).as_object().cloned().unwrap();
    assert_eq!(
        original.patched(&Field::Set(remove_first.into())),
        json!({ "last": [2, 3] }).as_object().cloned()
    );

    let remove_last = json!({ "last": null }).as_object().cloned().unwrap();
    assert_eq!(
        original.patched(&Field::Set(remove_last.into())),
        json!({ "first": 1 }).as_object().cloned()
    );
    let only_entry = json!({ "last": [2, 3] }).as_object().cloned();
    let remove_only = json!({ "last": null }).as_object().cloned().unwrap();
    assert_eq!(
        only_entry.patched(&Field::Set(remove_only.into())),
        Some(Object::new())
    );
    assert_eq!(original.patched(&Field::Clear), None);
    assert_eq!(Option::<Object>::None.patched(&Field::Clear), None);
}

#[test]
fn an_empty_key_patch_is_a_no_op_but_a_clear_is_not() {
    let original = json!({ "x": [1, 2] }).as_object().cloned();
    assert_eq!(
        original.patched(&Field::Set(Object::new().into())),
        original
    );
    assert_eq!(original.patched(&Field::Clear), None);
}

#[test]
fn change_at_deduplicates_requested_keys_and_ignores_keys_absent_on_both_sides() {
    let before = HashMap::from([(1u32, 10i16)]);
    let after = HashMap::from([(1u32, 11i16), (2, 20)]);
    let change = Change::at(&before, &after, [1, 1, 2, 999, 999]);
    assert_eq!(
        change.counts(),
        Counts {
            added: 1,
            removed: 0,
            updated: 1
        }
    );
    assert_eq!(change.keys().added, [2]);
    assert_eq!(change.keys().updated, [1]);
}

#[test]
fn dependency_invalidation_walks_a_transitive_chain_and_keeps_other_roots() {
    let deps = Dependents::new(HashMap::from([
        ("lat".to_string(), vec!["timezone".to_string()]),
        ("timezone".to_string(), vec!["sunrise".to_string()]),
        ("lng".to_string(), vec!["country".to_string()]),
    ]));
    let stale = deps.invalidated(vec!["lat".into()], |_| false);
    assert_eq!(
        stale,
        HashSet::from(["timezone".to_string(), "sunrise".to_string()])
    );
}

#[test]
fn explicitly_rewritten_outputs_break_their_invalidation_branch() {
    let deps = Dependents::new(HashMap::from([
        (
            "source".to_string(),
            vec!["rewritten".to_string(), "sibling".to_string()],
        ),
        ("rewritten".to_string(), vec!["downstream".to_string()]),
        (
            "sibling".to_string(),
            vec!["sibling_downstream".to_string()],
        ),
    ]));
    let stale = deps.invalidated(vec!["source".into()], |output| output == "rewritten");
    assert_eq!(
        stale,
        HashSet::from(["sibling".to_string(), "sibling_downstream".to_string()])
    );
}

#[test]
fn dependency_cycles_terminate_and_mark_each_reachable_output_once() {
    let deps = Dependents::new(HashMap::from([
        ("a".to_string(), vec!["b".to_string()]),
        ("b".to_string(), vec!["c".to_string()]),
        ("c".to_string(), vec!["a".to_string(), "b".to_string()]),
        ("unrelated".to_string(), vec!["other".to_string()]),
    ]));
    let stale = deps.invalidated(vec!["a".into()], |_| false);
    assert_eq!(
        stale,
        HashSet::from(["a".to_string(), "b".to_string(), "c".to_string()])
    );
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Named {
    id: u32,
    name: Option<String>,
    order: Option<u32>,
    note: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
struct NamedPatch {
    id: u32,
    name: Field<String>,
    order: Field<u32>,
    note: Field<String>,
}

impl Keyed for Named {
    type Key = u32;
    fn key(&self) -> u32 {
        self.id
    }
    fn set_key(&mut self, key: u32) {
        self.id = key;
    }
}

impl Keyed for NamedPatch {
    type Key = u32;
    fn key(&self) -> u32 {
        self.id
    }
    fn set_key(&mut self, key: u32) {
        self.id = key;
    }
}

impl Patchable for Named {
    type Patch = NamedPatch;
    const WRITES: &'static [(&'static str, &'static str)] = &[];
    const CLEARS: &'static [&'static str] = &[];

    fn patched(&self, patch: &NamedPatch) -> Self {
        Named {
            id: self.id,
            name: patch.name.applied(&self.name),
            order: patch.order.applied(&self.order),
            note: patch.note.applied(&self.note),
        }
    }

    fn between(old: &Self, new: &Self) -> NamedPatch {
        NamedPatch {
            id: new.id,
            name: Field::between(&old.name, &new.name),
            order: Field::between(&old.order, &new.order),
            note: Field::between(&old.note, &new.note),
        }
    }

    fn to_patch(&self) -> NamedPatch {
        Named::between(&Named::default(), self)
    }
}

impl Constrained for Named {
    fn unique(&self) -> Option<String> {
        self.name.as_deref().and_then(unique_name)
    }

    fn sequence<'a>(&mut self, rows: impl Iterator<Item = &'a Self> + Clone) {
        if self.order.is_none() {
            self.order = Some(
                rows.filter_map(|r| r.order)
                    .max()
                    .unwrap_or_default()
                    .after(),
            );
        }
    }

    fn filled(&self, from: &Self) -> Self {
        Named {
            id: self.id,
            name: self.name.clone().or_else(|| from.name.clone()),
            order: self.order.or(from.order),
            note: self.note.clone().or_else(|| from.note.clone()),
        }
    }
}

fn named(id: u32, name: &str, order: Option<u32>) -> Named {
    Named {
        id,
        name: Some(name.into()),
        order,
        note: None,
    }
}

fn named_table(rows: &[Named]) -> HashMap<u32, Named> {
    rows.iter().map(|v| (v.id, v.clone())).collect()
}

#[test]
fn an_added_row_takes_a_fresh_key_and_the_next_place_in_sequence() {
    let mut table = named_table(&[named(1, "a", Some(4))]);
    let applied = crate::apply(
        &mut table,
        [Op::Add(named(0, "b", None)), Op::Add(named(0, "c", None))],
        9,
    );
    assert_eq!(applied.keys, vec![10, 11]);
    assert_eq!(table[&10], named(10, "b", Some(5)));
    assert_eq!(table[&11], named(11, "c", Some(6)));
}

#[test]
fn an_added_row_lands_on_the_row_holding_its_unique_value_and_fills_its_gaps() {
    let mut held = named(1, "Urban", None);
    held.note = Some("kept".into());
    let mut table = named_table(&[held, named(2, "rural", Some(3))]);
    let mut incoming = named(0, " URBAN ", Some(9));
    incoming.note = Some("ignored".into());
    let applied = crate::apply(&mut table, [Op::Add(incoming)], 5);
    assert_eq!(applied.keys, vec![1], "no key is spent on a landing");
    assert_eq!(table.len(), 2);
    assert_eq!(table[&1].name.as_deref(), Some("Urban"));
    assert_eq!(table[&1].note.as_deref(), Some("kept"), "the held row wins");
    assert_eq!(
        table[&1].order,
        Some(9),
        "an empty field takes the set's value"
    );
}

#[test]
fn a_landing_numbers_a_held_row_that_has_no_place_yet() {
    let mut table = named_table(&[named(1, "a", None), named(2, "b", Some(7))]);
    crate::apply(&mut table, [Op::Add(named(0, "A", None))], 5);
    assert_eq!(table[&1].order, Some(8));
}

#[test]
fn a_write_that_takes_another_rows_unique_value_is_redirected_and_leaves_its_row() {
    let mut table = named_table(&[named(1, "a", Some(1)), named(2, "b", Some(2))]);
    let before = table.clone();
    let applied = crate::apply(
        &mut table,
        [Op::Put(NamedPatch {
            id: 1,
            name: Field::Set("B".into()),
            note: Field::Set("dropped".into()),
            ..Default::default()
        })],
        5,
    );
    assert_eq!(applied.redirects, HashMap::from([(1, 2)]));
    assert_eq!(table, before);
}

#[test]
fn a_write_that_keeps_its_unique_value_is_never_redirected_even_beside_a_duplicate() {
    let mut table = named_table(&[named(1, "a", Some(1)), named(2, "A", Some(2))]);
    let applied = crate::apply(
        &mut table,
        [Op::Put(NamedPatch {
            id: 2,
            order: Field::Set(0),
            ..Default::default()
        })],
        5,
    );
    assert!(applied.redirects.is_empty());
    assert_eq!(table[&2].order, Some(0));
}

#[test]
fn a_renamed_row_frees_its_old_value_for_a_later_set_in_the_same_batch() {
    let mut table = named_table(&[named(1, "a", Some(1))]);
    let applied = crate::apply(
        &mut table,
        [
            Op::Put(NamedPatch {
                id: 1,
                name: Field::Set("z".into()),
                ..Default::default()
            }),
            Op::Add(named(0, "a", None)),
        ],
        5,
    );
    assert_eq!(applied.keys, vec![6]);
    assert_eq!(table[&1].name.as_deref(), Some("z"));
    assert_eq!(table[&6].name.as_deref(), Some("a"));
}

#[test]
fn a_patch_to_a_missing_row_does_nothing() {
    let mut table = named_table(&[named(1, "a", Some(1))]);
    let before = table.clone();
    crate::apply(
        &mut table,
        [Op::Put(NamedPatch {
            id: 4,
            name: Field::Set("x".into()),
            ..Default::default()
        })],
        5,
    );
    assert_eq!(table, before);
}

#[test]
fn an_id_is_its_raw_value_on_the_wire() {
    let id: Id<Named> = Id::new(7);
    assert_eq!(serde_json::to_string(&id).unwrap(), "7");
    assert_eq!(serde_json::from_str::<Id<Named>>("7").unwrap(), id);
    let text: Id<Named, String> = Id::new("abc".into());
    assert_eq!(serde_json::to_string(&text).unwrap(), "\"abc\"");
}

#[test]
fn ids_order_and_hash_by_their_raw_value() {
    let (a, b): (Id<Named>, Id<Named>) = (Id::new(1), Id::new(2));
    assert!(a < b);
    assert_eq!(HashMap::from([(a, "a")])[&Id::new(1)], "a");
}

#[test]
fn nested_map_edits_compose_and_preserve_json_null() {
    type Entries = HashMap<String, HashMap<String, Json>>;
    let old = Entries::from([(
        "first".into(),
        HashMap::from([
            ("kept".into(), Json(json!(1))),
            ("removed".into(), Json(json!(2))),
        ]),
    )]);
    let patch: Patch<Entries> = serde_json::from_value(json!({
        "first": { "put": {
            "kept": { "set": 3 },
            "removed": { "remove": null },
            "null": { "set": null }
        }},
        "second": { "put": { "independent": { "set": true } } }
    }))
    .unwrap();
    let updated = old.patched(&patch);
    assert_eq!(*updated["first"]["kept"], json!(3));
    assert!(!updated["first"].contains_key("removed"));
    assert_eq!(*updated["first"]["null"], Value::Null);
    assert_eq!(*updated["second"]["independent"], json!(true));
    assert_eq!(old.patched(&Entries::between(&old, &updated)), updated);
    assert_eq!(updated.patched(&Entries::between(&updated, &old)), old);
}

#[test]
fn map_set_replaces_while_put_preserves_other_entries() {
    type Entries = HashMap<String, HashMap<String, Json>>;
    let old = Entries::from([(
        "first".into(),
        HashMap::from([
            ("keep".into(), Json(json!(1))),
            ("change".into(), Json(json!(2))),
        ]),
    )]);
    let set: Patch<Entries> =
        serde_json::from_value(json!({ "first": { "set": { "change": 3 } } })).unwrap();
    let put: Patch<Entries> =
        serde_json::from_value(json!({ "first": { "put": { "change": { "set": 3 } } } })).unwrap();
    assert!(!old.patched(&set)["first"].contains_key("keep"));
    assert_eq!(*old.patched(&put)["first"]["keep"], json!(1));
    assert_eq!(*old.patched(&put)["first"]["change"], json!(3));
    let empty: Patch<Entries> = serde_json::from_value(json!({ "first": { "set": {} } })).unwrap();
    assert!(old.patched(&empty)["first"].is_empty());
}

#[test]
fn optional_maps_delegate_keyed_edits_and_preserve_present_empty_values() {
    type Entries = HashMap<String, Json>;
    let old = Some(Entries::from([
        ("keep".into(), Json(json!(1))),
        ("change".into(), Json(json!(2))),
    ]));
    let patch = Field::Set(<Entries as Patchable>::Patch::from([(
        "change".into(),
        Op::Set(Json(json!(3))),
    )]));
    let updated = old.patched(&patch).unwrap();
    assert_eq!(*updated["keep"], json!(1));
    assert_eq!(*updated["change"], json!(3));
    assert_eq!(
        Option::<Entries>::None.patched(&patch).unwrap(),
        Entries::from([("change".into(), Json(json!(3)))])
    );
    assert_eq!(old.patched(&Field::Keep), old);
    assert_eq!(old.patched(&Field::Clear), None);
    for before in [None, Some(Entries::new()), old] {
        for after in [None, Some(Entries::new()), Some(updated.clone())] {
            assert_eq!(
                before.patched(&Option::<Entries>::between(&before, &after)),
                after
            );
        }
    }
}

#[test]
fn optional_json_patches_keep_present_empty_objects_and_use_normal_equality() {
    let absent: Option<Object> = None;
    let empty = Some(Object::new());
    assert_eq!(
        absent.patched(&Option::<Object>::between(&absent, &empty)),
        empty
    );
    assert_eq!(Option::<Object>::between(&empty, &absent), Field::Clear);
    let integer = json!({ "n": 1 }).as_object().cloned();
    let decimal = json!({ "n": 1.0 }).as_object().cloned();
    assert_eq!(
        integer.patched(&Option::<Object>::between(&integer, &decimal)),
        decimal
    );
    let scalar = Some(Json(json!(true)));
    let null = Some(Json(Value::Null));
    assert_eq!(
        scalar.patched(&Option::<Json>::between(&scalar, &null)),
        null
    );
}

#[test]
fn rfc_7396_appendix_a() {
    let cases = [
        (json!({"a":"b"}), json!({"a":"c"}), json!({"a":"c"})),
        (json!({"a":"b"}), json!({"b":"c"}), json!({"a":"b","b":"c"})),
        (json!({"a":"b"}), json!({"a":null}), json!({})),
        (
            json!({"a":"b","b":"c"}),
            json!({"a":null}),
            json!({"b":"c"}),
        ),
        (json!({"a":["b"]}), json!({"a":"c"}), json!({"a":"c"})),
        (json!({"a":"c"}), json!({"a":["b"]}), json!({"a":["b"]})),
        (
            json!({"a":{"b":"c"}}),
            json!({"a":{"b":"d","c":null}}),
            json!({"a":{"b":"d"}}),
        ),
        (json!({"a":[{"b":"c"}]}), json!({"a":[1]}), json!({"a":[1]})),
        (json!(["a", "b"]), json!(["c", "d"]), json!(["c", "d"])),
        (json!({"a":"b"}), json!(["c"]), json!(["c"])),
        (json!({"a":"foo"}), Value::Null, Value::Null),
        (json!({"a":"foo"}), json!("bar"), json!("bar")),
        (json!({"e":null}), json!({"a":1}), json!({"e":null,"a":1})),
        (json!([1, 2]), json!({"a":"b","c":null}), json!({"a":"b"})),
        (
            json!({}),
            json!({"a":{"bb":{"ccc":null}}}),
            json!({"a":{"bb":{}}}),
        ),
    ];
    for (target, patch, expected) in cases {
        assert_eq!(merge_patch(&target, &patch), expected);
        assert_eq!(*Json(target).patched(&patch.clone().into()), expected);
    }
}

#[test]
fn recursive_merge_diffs_and_replacement_preserve_exact_states() {
    let old = Json(json!({"child":{"keep":1,"change":2,"drop":3},"array":[1,2]}));
    let new = Json(json!({"child":{"keep":1,"change":4},"array":[3]}));
    let patch = Json::between(&old, &new);
    assert_eq!(
        patch,
        JsonWrite::Merge(json!({"child":{"change":4,"drop":null},"array":[3]}))
    );
    assert_eq!(old.patched(&patch), new);
    assert_eq!(new.patched(&Json::between(&new, &old)), old);
    let nullable = Json(json!({"child":{"literal":null}}));
    assert_eq!(
        Json::between(&old, &nullable),
        JsonWrite::Replace(nullable.0.clone())
    );
    assert_eq!(old.patched(&Json::between(&old, &nullable)), nullable);
    let before = HashMap::from([("row".to_owned(), old)]);
    let after = HashMap::from([("row".to_owned(), nullable)]);
    let edits = HashMap::between(&before, &after);
    assert_eq!(before.patched(&edits), after);
    assert_eq!(after.patched(&HashMap::between(&after, &before)), before);
}

#[test]
fn an_optional_merged_slot_reaches_every_value_from_every_other() {
    let cases = [
        None,
        json!({ "a": 1 }).as_object().cloned(),
        json!({ "a": { "b": null } }).as_object().cloned(),
        json!({ "c": [null, { "d": null }] }).as_object().cloned(),
    ];
    for old in &cases {
        for new in &cases {
            assert_eq!(old.patched(&Option::<Object>::between(old, new)), *new);
        }
    }
}

#[test]
fn a_json_write_is_read_as_a_merge() {
    assert_eq!(
        serde_json::from_value::<JsonWrite>(json!({ "a": { "b": null } })).unwrap(),
        JsonWrite::Merge(json!({ "a": { "b": null } }))
    );
}

fn binary<T: Encode + serde::de::DeserializeOwned>(value: &T) -> T {
    postcard::from_bytes(&postcard::to_stdvec(&Encoded(value)).unwrap()).unwrap()
}

#[test]
fn every_patch_shape_survives_a_binary_round_trip_exactly() {
    let nested = json!({ "a": { "b": null } });
    let object = nested.as_object().cloned().unwrap();
    for write in [
        JsonWrite::Merge(nested.clone()),
        JsonWrite::Replace(nested.clone()),
    ] {
        assert_eq!(binary(&write), write);
    }
    let fields: [Patch<Option<Object>>; 4] = [
        Field::Keep,
        Field::Clear,
        Field::Set(JsonWrite::Merge(object.clone())),
        Field::Set(JsonWrite::Replace(object)),
    ];
    for field in fields {
        assert_eq!(binary(&field), field);
    }
    let edits: Patch<HashMap<String, Json>> = HashMap::from([
        ("kept".to_string(), Op::Put(JsonWrite::Replace(nested))),
        ("gone".to_string(), Op::Remove(())),
        ("new".to_string(), Op::Set(Json(json!(1.5)))),
        ("null".to_string(), Op::Set(Json(Value::Null))),
    ]);
    assert_eq!(binary(&edits), edits);
    let plugins: Patch<HashMap<String, HashMap<String, Json>>> =
        HashMap::from([("plugin".to_string(), Op::Put(edits))]);
    assert_eq!(binary(&plugins), plugins);
}

#[test]
fn a_field_reads_null_as_a_clear_and_writes_a_set_as_its_value_in_json() {
    let field: Field<u32> = serde_json::from_value(json!(null)).unwrap();
    assert_eq!(field, Field::Clear);
    assert_eq!(serde_json::to_value(Field::Set(2)).unwrap(), json!(2));
}

#[test]
fn ids_hand_out_keys_above_every_key_they_have_seen() {
    let mut ids: Ids<u32> = Ids::above([3, 9, 1]);
    assert_eq!(ids.take(), Ok(10));
    ids.saw(&4);
    assert_eq!(ids.take(), Ok(11));
    ids.saw(&20);
    assert_eq!(ids.take(), Ok(21));
    assert_eq!(Ids::<u32>::default().take(), Ok(1));
}

#[test]
fn a_leased_ids_hands_out_only_keys_inside_its_lease() {
    let mut ids: Ids<Id<()>> = Ids::above([Id::new(3)]);
    ids.lease(IdRange {
        first: Id::new(100),
        len: 3,
    });
    assert_eq!(ids.take(), Ok(Id::new(100)));
    ids.saw(&Id::new(4));
    ids.saw(&Id::new(500));
    assert_eq!(ids.take(), Ok(Id::new(101)));
    ids.saw(&Id::new(102));
    assert_eq!(ids.take(), Err(Exhausted));
    assert_eq!(ids.take_run(1), Err(Exhausted));
}

#[test]
fn a_lease_refuses_a_run_or_an_added_row_it_cannot_fit() {
    let mut ids: Ids<Id<()>> = Ids::default();
    ids.lease(IdRange {
        first: Id::new(10),
        len: 4,
    });
    assert_eq!(ids.take_run(5), Err(Exhausted));
    assert_eq!(ids.next(), &Id::new(10), "a refused run takes nothing");
    let run = ids.take_run(3).unwrap();
    assert_eq!(run.iter().map(Id::get).collect::<Vec<_>>(), [10, 11, 12]);
    assert_eq!(ids.take_run(1).map(|run| run.first), Ok(Id::new(13)));

    assert_eq!(ids.remaining(), Some(0));

    let mut ids: Ids<u32> = Ids::default();
    ids.end = Some(3);
    let three: [Edit<Row>; 3] = [
        Op::Add(row(0, "a")),
        Op::Add(row(0, "b")),
        Op::Add(row(0, "c")),
    ];
    let keyed = ids.key_all(three).map(|(_, added)| added);
    assert_eq!(keyed, Err(Exhausted));
    assert_eq!(ids.next(), &1, "a refused batch takes nothing");
}

#[test]
fn a_run_past_the_last_id_is_refused_and_takes_nothing() {
    let mut ids: Ids<Id<()>> = Ids::starting_at(Id::new(u32::MAX - 2));
    assert_eq!(ids.take_run(u32::MAX), Err(Exhausted));
    assert_eq!(ids.next(), &Id::new(u32::MAX - 2));
    assert_eq!(
        ids.take_run(2).map(|run| run.first),
        Ok(Id::new(u32::MAX - 2))
    );
}

#[test]
fn an_unleased_ids_never_runs_out() {
    let mut ids: Ids<Id<()>> = Ids::default();
    assert_eq!(ids.take_run(1_000_000).map(|run| run.first), Ok(Id::new(1)));
    ids.saw(&Id::new(4_000_000));
    assert_eq!(ids.take(), Ok(Id::new(4_000_001)));
    assert_eq!(ids, Ids::starting_at(Id::new(4_000_002)));
}

#[test]
fn keying_a_batch_keys_each_added_row_and_keeps_later_keys_above_a_set_one() {
    let mut ids: Ids<u32> = Ids::above([2]);
    let (edits, added) = ids
        .key_all([
            Op::Add(row(0, "a")),
            Op::Set(row(7, "b")),
            Op::Add(row(0, "c")),
        ])
        .unwrap();
    let mut layer: Layer<Row> = Layer::default();
    layer.write(edits);
    assert_eq!(added, [3, 8]);
    assert_eq!(layer.keys().collect::<Vec<_>>(), [3, 7, 8]);
    assert_eq!(layer.get(8, None, apply), Some(row(8, "c")));
}

#[test]
fn an_added_row_never_takes_a_key_set_earlier_in_the_same_batch() {
    let mut table = named_table(&[named(1, "a", Some(1))]);
    let applied = crate::apply(
        &mut table,
        [Op::Set(named(4, "d", None)), Op::Add(named(0, "e", None))],
        0,
    );
    assert_eq!(applied.keys, vec![5]);
    assert_eq!(table[&4].name.as_deref(), Some("d"));
}

#[test]
fn a_unique_name_is_trimmed_case_folded_and_absent_when_blank() {
    assert_eq!(unique_name("  Urban "), Some("urban".into()));
    assert_eq!(unique_name("   "), None);
    assert_eq!(trimmed_name(" Urban "), Some("Urban"));
}

#[test]
fn a_child_slot_visits_maps_and_refills_its_children_in_order() {
    let list = vec![1, 2, 3];
    assert_eq!(list.held(), [&1, &2, &3]);
    assert_eq!(list.mapped_ref(|n| n * 10), [10, 20, 30]);
    assert_eq!(list.mapped(|n| n + 1), [2, 3, 4]);
    assert_eq!(
        <Vec<u8> as ChildSlot<u8>>::filled(&mut [7, 8].into_iter()),
        [7, 8]
    );

    let one = Some(Box::new(5));
    assert_eq!(one.held(), [&5]);
    assert_eq!(one.mapped_ref(|n| n * 2), Some(Box::new(10)));
    assert_eq!(None::<Box<u8>>.held(), Vec::<&u8>::new());
    let mut rest = [1, 2].into_iter();
    assert_eq!(
        <Option<Box<u8>> as ChildSlot<u8>>::filled(&mut rest),
        Some(Box::new(1))
    );
    assert_eq!(rest.next(), Some(2), "an optional slot takes one child");
}

#[test]
fn a_run_of_ids_is_contiguous_and_later_ids_go_above_it() {
    let mut ids: Ids<Id<()>> = Ids::starting_at(Id::new(5));
    let run = ids.take_run(3).unwrap();
    assert_eq!(run.iter().map(Id::get).collect::<Vec<_>>(), vec![5, 6, 7]);
    assert_eq!(run.nth(2), Some(Id::new(7)));
    assert_eq!(run.nth(3), None);
    assert!(run.contains(Id::new(5)) && run.contains(Id::new(7)));
    assert!(!run.contains(Id::new(4)) && !run.contains(Id::new(8)));
    assert_eq!(ids.take(), Ok(Id::new(8)));
}

#[test]
fn the_change_between_two_tables_of_keyed_rows_turns_one_into_the_other_and_back() {
    let before = by_key([row(3, "c"), row(1, "a"), row(2, "b")]);
    let after = by_key([row(4, "d"), row(2, "B"), row(1, "a")]);
    let change = Change::between(&before, &after);
    assert_eq!(
        change,
        Change {
            added: vec![row(4, "d")],
            removed: vec![row(3, "c")],
            updated: vec![(row(2, "b"), row(2, "B"))],
        }
    );
    assert_eq!(change, Change::at(&before, &after, [4, 3, 2, 1]));

    let mut table = before.clone();
    change.apply_to(&mut table);
    assert_eq!(table, after);
    change.inverse().apply_to(&mut table);
    assert_eq!(table, before);
    assert!(Change::between(&after, &after).is_empty());
}

#[test]
fn the_change_between_value_tables_covers_every_key_either_holds_in_key_order() {
    let before: HashMap<u32, i16> = HashMap::from([(5, 1), (1, 1), (3, 3)]);
    let after: HashMap<u32, i16> = HashMap::from([(3, 4), (2, 2), (4, 4)]);
    let change = Change::between(&before, &after);
    assert_eq!(change.added, [(2, 2), (4, 4)]);
    assert_eq!(change.removed, [(1, 1), (5, 1)]);
    assert_eq!(change.updated, [((3, 3), (3, 4))]);
    assert_eq!(change, Change::at(&before, &after, [1, 2, 3, 4, 5]));
}

#[test]
fn rows_written_on_both_sides_of_a_change_replace_the_row_under_their_key() {
    let mut table = by_key([row(1, "a"), row(2, "b")]);
    Change::from_sides(
        vec![row(2, "B"), row(3, "c")],
        vec![row(1, "a"), row(2, "b")],
    )
    .apply_to(&mut table);
    assert_eq!(table, by_key([row(2, "B"), row(3, "c")]));
    assert_eq!(table.keys().copied().collect::<Vec<_>>(), [2, 3]);
}

#[test]
fn a_change_stands_only_on_a_table_holding_every_state_it_starts_from() {
    let change = Change::from_sides(
        vec![row(1, "added"), row(2, "updated"), row(4, "kept")],
        vec![row(2, "before"), row(3, "removed"), row(4, "old")],
    );
    let untouched = by_key([row(2, "before"), row(3, "removed"), row(4, "old")]);
    assert_eq!(change.standing_on(&untouched), Ok(()));

    let since = by_key([row(1, "taken"), row(2, "edited"), row(4, "old")]);
    let Err(Moved(mut moved)) = change.standing_on(&since) else {
        panic!("a change does not stand on rows edited since");
    };
    moved.sort_unstable();
    assert_eq!(moved, [1, 2, 3]);
}

#[test]
fn a_json_pointer_escapes_tilde_before_slash() {
    assert_eq!(json_pointer(["a/b", "~1", "c"]), "/a~1b/~01/c");
    assert_eq!(json_pointer([] as [&str; 0]), "");
}

#[test]
fn patch_ops_travel_in_the_standard_shape() {
    assert_eq!(
        serde_json::to_value(PatchOp::add(["fieldValues", "tags"], json!({}))).unwrap(),
        json!({ "op": "add", "path": "/fieldValues/tags", "value": {} })
    );
    assert_eq!(
        serde_json::to_value(PatchOp::Move {
            from: "/a".into(),
            path: "/b".into()
        })
        .unwrap(),
        json!({ "op": "move", "from": "/a", "path": "/b" })
    );
}

#[test]
fn recent_holds_the_newest_values_up_to_its_cap_in_key_order() {
    let mut recent = Recent::new(2);
    for key in 1..=3 {
        recent.put(key, key * 10);
    }
    assert_eq!(recent.get(&1), None);
    assert_eq!(recent.get(&2), Some(&20));
    assert_eq!((recent.oldest(), recent.newest()), (Some(&2), Some(&3)));
    assert_eq!(recent.after(&2).collect::<Vec<_>>(), [&30]);
    recent.clear();
    assert_eq!(recent.newest(), None);
}
