use super::*;
use crate::test_util::loc;
use mma_algebra::Change;

fn row_edit(before: Option<Location>, after: Option<Location>) -> Arc<Entry> {
    Arc::new(Entry {
        locations: Change::from_iter([mma_algebra::Transition::new(before, after)]),
        ..Entry::default()
    })
}

#[test]
fn persisted_stack_rows_are_sorted_into_undo_and_redo_order() {
    let mut stacks = EditStacks::on_disk(vec![
        (8, Stack::Redo),
        (2, Stack::Undo),
        (6, Stack::Redo),
        (4, Stack::Undo),
    ]);
    let order: Vec<_> = stacks
        .iter()
        .map(|(stack, edit)| (stack, edit.seq))
        .collect();
    assert_eq!(
        order,
        vec![
            (Stack::Undo, 2),
            (Stack::Undo, 4),
            (Stack::Redo, 8),
            (Stack::Redo, 6),
        ]
    );
    assert_eq!(stacks.record(Arc::new(Entry::default())), 9);
}

#[test]
fn undo_and_redo_move_the_same_edit_and_invert_its_rows() {
    let before = loc(7, 1.0, 2.0);
    let after = loc(7, 3.0, 4.0);
    let mut stacks = EditStacks::default();
    stacks.record(row_edit(Some(before.clone()), Some(after.clone())));

    let undone = stacks
        .step(Stack::Undo, |_| panic!("resident edit must not fetch"))
        .unwrap()
        .unwrap();
    assert_eq!(undone.locations.updated, [(after.clone(), before.clone())]);
    assert_eq!(stacks.len(Stack::Undo), 0);
    assert_eq!(stacks.len(Stack::Redo), 1);

    let redone = stacks
        .step(Stack::Redo, |_| panic!("moved edit stays resident"))
        .unwrap()
        .unwrap();
    assert_eq!(redone.locations.updated, [(before, after)]);
}

#[test]
fn a_disk_only_edit_is_fetched_once_then_kept_resident() {
    let mut stacks = EditStacks::on_disk(vec![(42, Stack::Undo)]);
    let before = loc(4, 1.0, 1.0);
    let after = loc(4, 2.0, 2.0);
    let mut fetches = Vec::new();
    let fetched = stacks
        .step(Stack::Undo, |seq| {
            fetches.push(seq);
            Ok(Entry {
                locations: Change::from_iter([mma_algebra::Transition::new(
                    Some(before.clone()),
                    Some(after.clone()),
                )]),
                ..Entry::default()
            })
        })
        .unwrap();
    assert!(fetched.is_some());
    let redone = stacks
        .step(Stack::Redo, |seq| {
            fetches.push(seq);
            Err("unexpected second fetch".into())
        })
        .unwrap();
    assert!(redone.is_some());
    assert_eq!(fetches, [42]);
}

#[test]
fn a_failed_disk_history_read_clears_both_stacks_instead_of_crossing_a_gap() {
    let mut stacks = EditStacks::on_disk(vec![(1, Stack::Undo), (2, Stack::Redo)]);
    assert!(stacks
        .step(Stack::Undo, |_| Err("corrupt history".into()))
        .is_err());
    assert_eq!(stacks.len(Stack::Undo), 0);
    assert_eq!(stacks.len(Stack::Redo), 0);
}

#[test]
fn recording_after_undo_discards_redo_without_reusing_a_sequence() {
    let mut stacks = EditStacks::default();
    let first = stacks.record(Arc::new(Entry::default()));
    stacks
        .step(Stack::Undo, |_| panic!("resident edit"))
        .unwrap();
    let second = stacks.record(Arc::new(Entry::default()));
    assert_eq!(second, first + 1);
    assert_eq!(stacks.len(Stack::Undo), 1);
    assert_eq!(stacks.len(Stack::Redo), 0);
    assert_eq!(
        stacks.iter().map(|(_, edit)| edit.seq).collect::<Vec<_>>(),
        [second]
    );
}

#[test]
fn folding_adjacent_writes_keeps_the_first_before_and_last_after() {
    let a = loc(1, 1.0, 1.0);
    let b = loc(1, 2.0, 2.0);
    let c = loc(1, 3.0, 3.0);
    let mut stacks = EditStacks::default();
    let first_seq = stacks.record(row_edit(Some(a.clone()), Some(b.clone())));
    let folded_seq = stacks
        .fold_into_newest(
            first_seq,
            Entry {
                locations: Change::from_iter([mma_algebra::Transition::new(
                    Some(b),
                    Some(c.clone()),
                )]),
                ..Entry::default()
            },
        )
        .unwrap();
    assert!(folded_seq > first_seq);
    assert_eq!(stacks.len(Stack::Undo), 1);
    let entry = stacks.undo.last().unwrap().entry.as_ref().unwrap();
    assert_eq!(entry.locations.updated, [(a, c)]);
}

#[test]
fn a_non_adjacent_write_cannot_corrupt_the_newest_history_entry() {
    let a = loc(1, 1.0, 1.0);
    let b = loc(1, 2.0, 2.0);
    let unrelated = loc(1, 9.0, 9.0);
    let mut stacks = EditStacks::default();
    let seq = stacks.record(row_edit(Some(a.clone()), Some(b.clone())));
    let later = Entry {
        locations: Change::from_iter([mma_algebra::Transition::new(
            Some(unrelated),
            Some(a.clone()),
        )]),
        ..Entry::default()
    };
    assert!(stacks.fold_into_newest(seq, later).is_err());
    assert_eq!(stacks.undo.last().unwrap().seq, seq);
    assert_eq!(
        stacks
            .undo
            .last()
            .unwrap()
            .entry
            .as_ref()
            .unwrap()
            .locations
            .updated,
        [(a, b)]
    );
}

#[test]
fn the_history_entry_limit_discards_oldest_undo_rows_only() {
    let mut stacks = EditStacks::default();
    for _ in 0..=MAX_UNDO_ENTRIES {
        stacks.record(Arc::new(Entry::default()));
    }
    assert_eq!(stacks.len(Stack::Undo), MAX_UNDO_ENTRIES);
    assert_eq!(stacks.undo.first().unwrap().seq, 1);
    assert_eq!(stacks.undo.last().unwrap().seq, MAX_UNDO_ENTRIES as u64);
}

#[test]
fn next_id_reserves_the_highest_id_reachable_from_any_durable_layer() {
    let adds = [loc(31, 0.0, 0.0), loc(19, 0.0, 0.0)];
    let next = |base, adds, history| *seed_next_id(base, adds, history).next();
    let id = |raw| Some(Id::new(raw));
    assert_eq!(next(id(8), &adds, id(22)), Id::new(32));
    assert_eq!(next(id(40), &adds, id(22)), Id::new(41));
    assert_eq!(next(id(8), &[], id(50)), Id::new(51));
    assert_eq!(next(None, &[], None), Id::new(1));
}

#[test]
fn stepping_an_empty_stack_does_not_call_the_loader() {
    let mut stacks = EditStacks::default();
    assert!(stacks
        .step(Stack::Undo, |_| panic!("empty stack must not fetch"))
        .unwrap()
        .is_none());
    assert!(stacks
        .step(Stack::Redo, |_| panic!("empty stack must not fetch"))
        .unwrap()
        .is_none());
}

#[test]
fn clearing_history_does_not_reuse_edit_sequence_numbers() {
    let mut stacks = EditStacks::default();
    let first = stacks.record(Arc::new(Entry::default()));
    stacks.clear();
    assert_eq!(stacks.len(Stack::Undo), 0);
    assert_eq!(stacks.len(Stack::Redo), 0);
    assert_eq!(stacks.record(Arc::new(Entry::default())), first + 1);
}

#[test]
fn folding_a_newest_write_clears_an_existing_redo_branch() {
    let a = loc(1, 1.0, 1.0);
    let b = loc(1, 2.0, 2.0);
    let c = loc(1, 3.0, 3.0);
    let d = loc(1, 4.0, 4.0);
    let mut stacks = EditStacks::default();
    let first = stacks.record(row_edit(Some(a.clone()), Some(b.clone())));
    stacks.record(row_edit(Some(b.clone()), Some(c.clone())));
    stacks
        .step(Stack::Undo, |_| panic!("resident edit"))
        .unwrap();
    assert_eq!(stacks.len(Stack::Redo), 1);

    assert!(stacks
        .fold_into_newest(
            first,
            Entry {
                locations: Change::from_iter([mma_algebra::Transition::new(Some(b), Some(d))]),
                ..Entry::default()
            }
        )
        .is_ok());
    assert_eq!(stacks.len(Stack::Redo), 0);
}

#[test]
fn a_stale_fold_sequence_cannot_join_a_different_newest_edit() {
    let first = loc(1, 1.0, 1.0);
    let second = loc(1, 2.0, 2.0);
    let later = loc(1, 3.0, 3.0);
    let mut stacks = EditStacks::default();
    let stale_seq = stacks.record(row_edit(Some(first.clone()), Some(second.clone())));
    let current_seq = stacks.record(row_edit(Some(second.clone()), Some(later.clone())));
    let rejected = stacks.fold_into_newest(
        stale_seq,
        Entry {
            locations: Change::from_iter([mma_algebra::Transition::new(
                Some(later.clone()),
                Some(first.clone()),
            )]),
            ..Entry::default()
        },
    );
    assert!(rejected.is_err());
    assert_eq!(stacks.undo.last().unwrap().seq, current_seq);
    assert_eq!(
        stacks
            .undo
            .last()
            .unwrap()
            .entry
            .as_ref()
            .unwrap()
            .locations
            .updated,
        [(second, later)]
    );
}
