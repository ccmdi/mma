use super::*;
use mma_algebra::Delta;

#[derive(Clone, PartialEq)]
struct Row {
    id: u32,
    labels: Option<Vec<String>>,
}

struct Labels;

impl Projection<Row> for Labels {
    type Key = String;
    fn project(&self, row: &Row, mut emit: impl FnMut(String)) -> bool {
        let Some(labels) = &row.labels else {
            return false;
        };
        for label in labels {
            emit(label.clone());
        }
        true
    }
}

fn row(id: u32, labels: Option<&[&str]>) -> Row {
    Row {
        id,
        labels: labels.map(|items| items.iter().map(|item| (*item).to_string()).collect()),
    }
}

#[test]
fn indexes_arbitrary_rows_and_counts_a_repeated_key_once() {
    let mut index = Index::<String, Row, _>::new(Labels);
    index.insert(Id::new(1), &row(1, Some(&["a", "a", "b"])));
    index.insert(Id::new(2), &row(2, Some(&["a"])));
    index.insert(Id::new(3), &row(3, None));
    index.insert(Id::new(4), &row(4, Some(&[])));
    assert_eq!(index.count("a"), 2);
    assert_eq!(index.count("b"), 1);
    assert!(!index.contains("missing"));
    assert_eq!(
        index.rows.len(),
        3,
        "presence is independent of emitted keys"
    );
}

#[test]
fn membership_and_posting_indexes_recognize_the_same_keys() {
    let mut membership = Index::<String, Row, _>::membership(Labels);
    let mut postings = Index::<String, Row, _>::new(Labels);
    for value in [
        row(1, Some(&["a", "a", "b"])),
        row(2, Some(&["a"])),
        row(3, None),
        row(4, Some(&[])),
    ] {
        membership.insert(Id::new(value.id), &value);
        postings.insert(Id::new(value.id), &value);
    }
    for key in ["a", "b", "missing"] {
        assert_eq!(membership.contains(key), postings.contains(key));
    }
    assert_eq!(membership.by_value.len(), 2);
    assert_eq!(membership.rows, postings.rows);
}

#[test]
fn incremental_updates_match_a_fresh_build() {
    let before = [row(1, Some(&["a", "b"])), row(2, Some(&["a"]))];
    let after = [row(1, Some(&["b", "c", "c"])), row(3, Some(&[]))];
    let mut index = Index::<String, Row, _>::new(Labels);
    for value in &before {
        index.insert(Id::new(value.id), value);
    }
    let change = Change {
        added: vec![after[1].clone()],
        removed: vec![before[1].clone()],
        updated: vec![(before[0].clone(), after[0].clone())],
    };
    let contribution = index.project(&change, |row| Id::new(row.id));
    assert_eq!(
        index.apply(&contribution),
        BTreeSet::from(["a".into(), "b".into(), "c".into()])
    );
    let mut rebuilt = Index::<String, Row, _>::new(Labels);
    for value in &after {
        rebuilt.insert(Id::new(value.id), value);
    }
    assert_eq!(index.rows, rebuilt.rows);
    for key in ["a", "b", "c"] {
        assert_eq!(index.count(key), rebuilt.count(key));
    }
}

#[test]
fn unchanged_key_membership_produces_no_contribution_change() {
    let index = Index::<String, Row, _>::new(Labels);
    let change = Change {
        updated: vec![(row(1, Some(&["a", "b"])), row(1, Some(&["b", "a", "a"])))],
        ..Default::default()
    };
    assert!(index.project(&change, |row| Id::new(row.id)).is_empty());
}

#[test]
fn composite_keys_use_the_components_projections() {
    let value = row(1, Some(&["a", "b"]));
    let mut index = Index::<(String, String), Row, _>::new((Labels, Labels));
    index.insert(Id::new(1), &value);
    assert!(index.contains(&(String::from("a"), String::from("b"))));
    assert_eq!(index.by_value.len(), 4);
    assert_eq!(index.rows.len(), 1);
}

struct RowId;

impl Projection<Row> for RowId {
    type Key = u32;

    fn project(&self, row: &Row, mut emit: impl FnMut(u32)) -> bool {
        emit(row.id);
        true
    }
}

#[test]
fn preferred_choice_falls_back_only_when_the_first_projection_is_absent() {
    let keys = Choice(Labels, RowId);
    let mut index = Index::<_, Row, _>::membership(&keys);
    index.insert(Id::new(1), &row(1, Some(&["a"])));

    assert!(index.matches(&keys.preferred(), &row(2, Some(&["a"]))));
    assert!(index.matches(&keys.preferred(), &row(1, None)));
    assert!(!index.matches(&keys.preferred(), &row(1, Some(&["other"]))));
    assert!(!index.matches(&keys.preferred(), &row(2, None)));
    // Presence without keys still takes precedence; a miss is not a fallback.
    assert!(!index.matches(&keys.preferred(), &row(1, Some(&[]))));
    // Querying every alternative remains available independently of precedence.
    assert!(index.matches(&keys, &row(1, Some(&["other"]))));
}

#[test]
fn choices_keep_equal_keys_from_different_projections_distinct() {
    let keys = Choice(Labels, Labels);
    let mut index = Index::<_, Row, _>::membership(&keys);
    index.insert(Id::new(1), &row(1, Some(&["a"])));
    assert_eq!(index.by_value.len(), 2);
    assert!(index.contains(&Key::First(String::from("a"))));
    assert!(index.contains(&Key::Second(String::from("a"))));
}
