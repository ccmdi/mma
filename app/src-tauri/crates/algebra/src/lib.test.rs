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

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
struct RowPatch {
    name: Option<String>,
    extra: Option<Option<Json>>,
}

impl Patchable for Row {
    type Patch = RowPatch;
    const WRITES: &'static [(&'static str, &'static str)] = &[("name", "name"), ("extra", "extra")];
    const MERGED: &'static [&'static str] = &["extra"];

    fn patched(&self, patch: &RowPatch) -> Self {
        let mut out = self.clone();
        if let Some(v) = &patch.name {
            out.name = v.clone();
        }
        if let Some(v) = &patch.extra {
            out.extra = Merge::merged(&out.extra, v);
        }
        out
    }

    fn between(old: &Self, new: &Self) -> RowPatch {
        RowPatch {
            name: (old.name != new.name).then(|| new.name.clone()),
            extra: Merge::between(&old.extra, &new.extra),
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
fn merging_the_patch_between_two_maps_yields_the_second() {
    let cases = [
        None,
        json!({ "a": 1 }).as_object().cloned(),
        json!({ "a": 2, "b": [1] }).as_object().cloned(),
    ];
    for old in &cases {
        for new in &cases {
            match Merge::between(old, new) {
                Some(patch) => assert_eq!(Merge::merged(old, &patch), *new),
                None => assert!(same_field_value(
                    old.clone().map(Value::Object).as_ref(),
                    new.clone().map(Value::Object).as_ref(),
                )),
            }
        }
    }
}

#[test]
fn a_change_drops_rows_that_did_not_change() {
    let change = Change::from_rows([
        (None, Some(row(1, "a"))),
        (Some(row(2, "b")), None),
        (Some(row(3, "c")), Some(row(3, "c"))),
        (Some(row(4, "d")), Some(row(4, "e"))),
        (None, None),
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
    let first = Change::from_rows([
        (None, Some(row(1, "a"))),
        (Some(row(2, "old")), Some(row(2, "mid"))),
    ]);
    let second = Change::from_rows([
        (Some(row(2, "mid")), Some(row(2, "new"))),
        (Some(row(1, "a")), None),
    ]);
    let both = first.then(second);
    assert!(both.added.is_empty() && both.removed.is_empty());
    assert_eq!(both.updated, vec![(row(2, "old"), row(2, "new"))]);

    let there = Change::from_rows([(Some(row(5, "x")), Some(row(5, "y")))]);
    let back = there.clone().inverse();
    assert!(there.then(back).is_empty());
}

fn rename(name: &str) -> RowPatch {
    RowPatch {
        name: Some(name.into()),
        extra: None,
    }
}

fn apply(r: &Row, p: &RowPatch) -> Row {
    r.patched(p)
}

#[test]
fn a_layer_reads_its_intents_over_the_row_below_as_it_is_now() {
    let mut layer: Layer<Row> = Layer::default();
    layer.push(1, Op::Put(rename("mine")));
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
    layer.push(1, Op::Put(rename("first")));
    layer.push(1, Op::Put(rename("second")));
    assert_eq!(
        layer.get(1, Some(row(1, "below")), apply),
        Some(row(1, "second"))
    );

    layer.push(1, Op::Remove);
    assert_eq!(layer.get(1, Some(row(1, "below")), apply), None);
    layer.push(1, Op::Put(rename("after remove")));
    assert_eq!(layer.get(1, Some(row(1, "below")), apply), None);

    layer.push(1, Op::Set(row(1, "set")));
    layer.push(1, Op::Put(rename("edited")));
    assert_eq!(layer.get(1, None, apply), Some(row(1, "edited")));
}

#[test]
fn resolving_a_layer_pairs_each_key_with_its_row_before_and_after() {
    let mut layer: Layer<Row> = Layer::default();
    layer.push(1, Op::Put(rename("new")));
    layer.push(2, Op::Remove);
    layer.push(3, Op::Set(row(3, "added")));
    let below = |key: u32| (key < 3).then(|| row(key, "old"));
    let resolved: Vec<_> = layer.resolve(below, apply).collect();
    assert_eq!(
        resolved,
        vec![
            (1, Some(row(1, "old")), Some(row(1, "new"))),
            (2, Some(row(2, "old")), None),
            (3, None, Some(row(3, "added"))),
        ]
    );
    let change = Change::from_rows(resolved.into_iter().map(|(_, b, a)| (b, a)));
    assert_eq!(change.len(), 3);
    assert!(layer.holds(2) && !layer.holds(4));
}
