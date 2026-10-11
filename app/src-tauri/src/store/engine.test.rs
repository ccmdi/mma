#![allow(clippy::needless_pass_by_value)]
use super::*;
use crate::io::export;
use crate::selections::field_expr;
use crate::selections::field_expr::Expr;
use crate::selections::{self, Selection, Selector, Thinning};
use crate::store::arrow::empty_batch;
use crate::store::engine::query::rows_file_path;
use crate::store::maps::IndexShape;
use crate::test_util::Fx;
use crate::test_util::TempDir;
use crate::test_util::{loc, patch};
use crate::types::LocationFlags;
use crate::types::RawExtra;
use frame::tests::Captured;
use mma_algebra::{Delta, Edit, Op, Patch};
use proptest::collection;
use proptest::prelude::ProptestConfig;
use proptest::strategy::Strategy;
use std::array;
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::panic;
use std::path::Path;
use std::path::PathBuf;
use std::slice;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::Mutex;

fn net(added: u32, removed: u32, updated: u32) -> mma_algebra::Counts {
    mma_algebra::Counts {
        added,
        removed,
        updated,
    }
}

fn apply_updates(
    store: &mut Store,
    updates: &[Patch<Location>],
    join: &mut Option<u64>,
) -> Mutation {
    store.write(updates.iter().cloned().map(Op::Put), join, Entry::default())
}

fn entry(rows: Change) -> Entry {
    Entry {
        rows,
        ..Default::default()
    }
}

fn add_rows(store: &mut Store, locs: Vec<Location>) -> Mutation {
    let edits = locs
        .into_iter()
        .map(|mut l| {
            l.id = 0;
            Op::Set(l)
        })
        .collect();
    store.edit(&Target::Map, edits, false, &mut None)
}

fn overlay_update(store: &mut Store, patch: &Patch<Location>) -> Option<(Location, Location)> {
    let old = store.get_loc_by_id(patch.id)?;
    let mut new = store.applied(&old, patch);
    if new != old {
        touch(&mut new);
    }
    store.put(&Change::from_iter([mma_algebra::Transition::new(
        Some(old.clone()),
        Some(new),
    )]));
    Some((old, store.get_loc_by_id(patch.id)?))
}

fn apply_edit(store: &mut Store, remove: Vec<Location>, create: Vec<Location>) -> Change {
    let change = Change::from_sides(create, remove);
    store.put(&change);
    change
}

fn forward(store: &mut Store, change: &Change) -> Change {
    store.put(change);
    change.clone()
}

fn reverse(store: &mut Store, change: &Change) -> Change {
    let undo = change.inverse();
    store.put(&undo);
    undo
}

fn undoable(store: &mut Store, remove: Vec<Location>, create: Vec<Location>) -> Mutation {
    let removes = remove.into_iter().map(|l| Op::Remove(l.id));
    store.write(
        removes.chain(create.into_iter().map(Op::Set)),
        &mut None,
        Entry::default(),
    )
}

fn loc_with_tags(id: u32, lat: f64, lng: f64, tags: Vec<u32>) -> Location {
    Location {
        tags,
        ..loc(id, lat, lng)
    }
}

/// Rows carrying tag `id`, off the postings.
fn tag_count(store: &mut Store, id: u32) -> usize {
    store.fields(["tags"])[0].count(&id.to_string())
}

/// Replay a row change and update derived state, as undo and redo do.
fn edit_and_finish(store: &mut Store, entry: &Change, forward: bool) {
    let changes = if forward {
        self::forward(store, entry)
    } else {
        reverse(store, entry)
    };
    store.finish_mutation(&changes);
}

fn loc_with_heading(id: u32, lat: f64, lng: f64, heading: f64) -> Location {
    Location {
        heading,
        ..loc(id, lat, lng)
    }
}

fn setup_store_with(locs: &[Location]) -> Store {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let mut store = Store::new();
    store.meta = Tracked::new(maps::MapMeta {
        id: format!("test-{}", SEQ.fetch_add(1, Ordering::Relaxed)),
        ..Default::default()
    });
    store.batch = Some(empty_batch());
    for l in locs {
        store.overlay_add(vec![l.clone()]);
        let ci = render_cell_idx(l.lat, l.lng);
        store.cell_add_render(ci, l.id);
    }
    store
}

// -----------------------------------------------------------------------
// Overlay basics
// -----------------------------------------------------------------------

#[test]
fn overlay_add_increments_alive_count() {
    let mut store = setup_store_with(&[]);
    let l = loc(1, 10.0, 20.0);
    store.overlay_add(vec![l]);
    assert_eq!(*store.alive_count, 1);
}

#[test]
fn overlay_add_then_get() {
    let mut store = setup_store_with(&[]);
    let l = loc(1, 10.0, 20.0);
    store.overlay_add(vec![l.clone()]);
    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 10.0);
    assert_eq!(got.lng, 20.0);
}

#[test]
fn overlay_add_batch_merges_into_sorted_adds() {
    let even: Vec<Location> = (1..=500).map(|i| loc(i * 2, 0.0, 0.0)).collect();
    let mut store = setup_store_with(&even);
    // Odd ids, handed over unsorted, all below/among/above the existing range.
    let mut odd: Vec<Location> = (0..=500).map(|i| loc(i * 2 + 1, 1.0, 1.0)).collect();
    odd.reverse();
    store.overlay_add(odd);

    let ids: Vec<u32> = store.overlay.adds.iter().map(|l| l.id).collect();
    assert_eq!(ids, (1..=1001).collect::<Vec<u32>>());
    assert_eq!(*store.alive_count, 1001);
    assert_eq!(store.get_loc_by_id(1).unwrap().lat, 1.0);
    assert_eq!(store.get_loc_by_id(1000).unwrap().lat, 0.0);
    assert_eq!(store.get_loc_by_id(1001).unwrap().lat, 1.0);
}

#[test]
fn a_no_op_edit_pushes_no_undo_entry_and_keeps_redo() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    undoable(&mut store, vec![], vec![loc(2, 0.0, 0.0)]);
    press_undo(&mut store);
    let rev = store.overlay.rev();

    undoable(&mut store, vec![], vec![]);

    assert!(store.edits.len(Stack::Undo) == 0);
    assert_eq!(store.edits.len(Stack::Redo), 1);
    assert_eq!(store.overlay.rev(), rev);
}

#[test]
fn undo_of_a_page_keeps_the_overlay_sorted() {
    let rows: Vec<Location> = (1..=2000).map(|i| loc(i, 0.0, 0.0)).collect();
    let mut store = setup_store_with(&rows);
    let before: Vec<Location> = rows[499..1499].to_vec();
    let after: Vec<Location> = before.iter().map(|l| loc(l.id, 5.0, 0.0)).collect();
    undoable(&mut store, before, after);
    assert_eq!(store.get_loc_by_id(700).unwrap().lat, 5.0);

    press_undo(&mut store);
    let ids: Vec<u32> = store.overlay.adds.iter().map(|l| l.id).collect();
    assert_eq!(ids, (1..=2000).collect::<Vec<u32>>());
    assert_eq!(store.get_loc_by_id(700).unwrap().lat, 0.0);
    assert_eq!(*store.alive_count, 2000);
}

#[test]
fn overlay_remove_decrements_alive_count() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    assert_eq!(*store.alive_count, 1);
    store.overlay_remove([l].iter());
    assert_eq!(*store.alive_count, 0);
}

#[test]
fn overlay_remove_makes_get_return_none() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    store.overlay_remove([l].iter());
    assert!(store.get_loc_by_id(1).is_none());
}

#[test]
fn overlay_update_changes_fields() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    overlay_update(&mut store, &patch!(1; lat: 50.0, heading: 90.0));
    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 50.0);
    assert_eq!(got.heading, 90.0);
    assert_eq!(got.lng, 20.0); // unchanged
}

fn raw_extra(s: &str) -> Option<RawExtra> {
    RawExtra::from_string(s.to_string())
}

#[test]
fn overlay_update_extra_merges_keys() {
    let mut l = loc(1, 10.0, 20.0);
    l.extra = raw_extra(r#"{"a":1,"b":2}"#);
    let mut store = setup_store_with(&[l]);
    overlay_update(&mut store, &patch!(1; extra: raw_extra(r#"{"b":3,"c":4}"#)));
    let got = store.get_loc_by_id(1).unwrap().extra.unwrap();
    assert_eq!(got.get("a"), Some(serde_json::json!(1)));
    assert_eq!(got.get("b"), Some(serde_json::json!(3)));
    assert_eq!(got.get("c"), Some(serde_json::json!(4)));
}

#[test]
fn overlay_update_extra_null_value_deletes_key() {
    let mut l = loc(1, 10.0, 20.0);
    l.extra = raw_extra(r#"{"a":1,"b":2}"#);
    let mut store = setup_store_with(&[l]);
    overlay_update(&mut store, &patch!(1; extra: raw_extra(r#"{"a":null}"#)));
    let got = store.get_loc_by_id(1).unwrap().extra.unwrap();
    assert_eq!(got.get("a"), None);
    assert_eq!(got.get("b"), Some(serde_json::json!(2)));
}

#[test]
fn overlay_update_extra_creates_extra_when_none() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    overlay_update(&mut store, &patch!(1; extra: raw_extra(r#"{"a":1}"#)));
    let got = store.get_loc_by_id(1).unwrap().extra.unwrap();
    assert_eq!(got.get("a"), Some(serde_json::json!(1)));
}

#[test]
fn overlay_update_extra_empty_after_deletes_is_none() {
    let mut l = loc(1, 10.0, 20.0);
    l.extra = raw_extra(r#"{"a":1}"#);
    let mut store = setup_store_with(&[l]);
    overlay_update(&mut store, &patch!(1; extra: raw_extra(r#"{"a":null}"#)));
    assert!(store.get_loc_by_id(1).unwrap().extra.is_none());
}

#[test]
fn overlay_update_extra_top_level_null_clears() {
    let mut l = loc(1, 10.0, 20.0);
    l.extra = raw_extra(r#"{"a":1}"#);
    let mut store = setup_store_with(&[l]);
    overlay_update(&mut store, &patch!(1; extra: None));
    assert!(store.get_loc_by_id(1).unwrap().extra.is_none());
}

#[test]
fn overlay_update_nonexistent_is_noop() {
    let mut store = setup_store_with(&[]);
    overlay_update(&mut store, &patch!(999; lat: 50.0));
    assert!(store.get_loc_by_id(999).is_none());
}

#[test]
fn overlay_update_stamps_modified_at_on_session_added_row() {
    // Row lives in overlay.adds (not yet baked): an edit must stamp modified_at,
    // same as an edit to a committed base row.
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    assert!(store.get_loc_by_id(1).unwrap().modified_at.is_none());
    overlay_update(&mut store, &patch!(1; lat: 50.0));
    assert!(store.get_loc_by_id(1).unwrap().modified_at.is_some());
}

#[test]
fn overlay_update_noop_does_not_stamp_session_added_row() {
    // A patch that changes nothing must not stamp (or it fabricates undo entries).
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    let rev = store.overlay.rev();
    overlay_update(&mut store, &patch!(1; lat: 10.0));
    assert!(store.get_loc_by_id(1).unwrap().modified_at.is_none());
    assert_eq!(store.overlay.rev(), rev);
}

#[test]
fn overlay_update_noop_on_base_row_does_not_touch_overlay() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    store.bake_overlay();
    let rev = store.overlay.rev();
    assert!(!store.overlay.is_unsaved());

    overlay_update(&mut store, &patch!(1; lat: 10.0));

    assert_eq!(store.overlay.rev(), rev);
    assert!(!store.overlay.is_unsaved());
}

#[test]
fn overlay_update_stamps_modified_at_on_base_row() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    store.bake_overlay();
    overlay_update(&mut store, &patch!(1; lat: 50.0));
    assert!(store.get_loc_by_id(1).unwrap().modified_at.is_some());
}

#[test]
fn overlay_update_returns_the_location_as_stored() {
    // The pair's `new` half feeds undo entries and selection membership re-tests, so it
    // must be exactly what the store now holds -- including the modified_at stamp.
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    store.bake_overlay();
    let (_, new_loc) = overlay_update(&mut store, &patch!(1; lat: 50.0)).unwrap();
    assert!(new_loc.modified_at.is_some());
    assert_eq!(new_loc, store.get_loc_by_id(1).unwrap());
}

#[test]
fn overlay_update_noop_on_patched_row_stays_a_noop() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    store.bake_overlay();
    overlay_update(&mut store, &patch!(1; lat: 50.0));
    // Re-applying the identical patch must return an equal pair (no undo entry) and leave
    // the stored row untouched.
    let stored = store.get_loc_by_id(1).unwrap();
    let rev = store.overlay.rev();
    let (old, new_loc) = overlay_update(&mut store, &patch!(1; lat: 50.0)).unwrap();
    assert_eq!(old, new_loc);
    assert_eq!(store.get_loc_by_id(1).unwrap(), stored);
    assert_eq!(store.overlay.rev(), rev);
}

#[test]
fn collect_everything() {
    let locs = vec![loc(1, 10.0, 20.0), loc(2, 30.0, 40.0)];
    let mut store = setup_store_with(&locs);
    let all = store.collect(&crate::store::engine::Target::Map, &Selector::Everything);
    assert_eq!(all.len(), 2);
}

#[test]
fn named_id_ordering_is_consumer_defined() {
    // Pins the documented divergence on `Selector::Locations`: `collect` honours the
    // caller's order and duplicates, set projections sort and dedup.
    let locs = vec![loc(3, 0.0, 0.0), loc(7, 1.0, 1.0)];
    let mut store = setup_store_with(&locs);
    let selector = Selector::Locations {
        locations: vec![7, 3, 3],
        name: None,
    };
    let rows: Vec<u32> = store
        .collect(&crate::store::engine::Target::Map, &selector)
        .iter()
        .map(|l| l.id)
        .collect();
    assert_eq!(rows, vec![7, 3, 3]);
    let set = store.scope(&selector).ids();
    assert_eq!(set.iter().collect::<Vec<u32>>(), vec![3, 7]);
}

// -----------------------------------------------------------------------
// Overlay dirty lifecycle (autosave rev guard)
// -----------------------------------------------------------------------

#[test]
fn overlay_rev_bumps_on_every_mutation() {
    let mut store = setup_store_with(&[]);
    let r0 = store.overlay.rev();
    store.overlay_add(vec![loc(1, 0.0, 0.0)]);
    let r1 = store.overlay.rev();
    assert!(r1 > r0);
    overlay_update(&mut store, &patch!(1; lat: 5.0));
    let r2 = store.overlay.rev();
    assert!(r2 > r1);
    store.overlay_remove([store.get_loc_by_id(1).unwrap()].iter());
    assert!(store.overlay.rev() > r2);
}

#[test]
fn bake_proceeds_when_clean_but_nonempty() {
    // Simulate a completed autosave (dirty cleared) with content still in the
    // overlay: a commit's bake must still fold it into the base batch.
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0)]);
    store.overlay.mark_saved();
    assert!(!store.overlay.is_empty());
    store.bake_overlay();
    assert!(store.overlay.is_empty());
    assert_eq!(store.batch.as_ref().unwrap().num_rows(), 1);
}

#[test]
fn bake_skips_empty_overlay() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0)]);
    store.bake_overlay();
    let rows_before = store.batch.as_ref().unwrap().num_rows();
    store.overlay.edit(); // stale flag with no content must not re-bake
    store.bake_overlay();
    assert_eq!(store.batch.as_ref().unwrap().num_rows(), rows_before);
}

// -----------------------------------------------------------------------
// Commit diff (overlay-derived)
// -----------------------------------------------------------------------

#[test]
fn commit_diff_counts_session_adds() {
    let store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 1.0, 1.0)]);
    assert_eq!(store.overlay_diff_counts(), net(2, 0, 0));
}

#[test]
fn commit_diff_counts_patch_on_base_row_without_undo() {
    // An overlay edit that never touches the undo stack still shows up in the commit diff.
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    store.bake_overlay();
    assert_eq!(store.overlay_diff_counts(), net(0, 0, 0));
    overlay_update(&mut store, &patch!(1; lat: 5.0));
    assert!(store.edits.len(Stack::Undo) == 0);
    assert_eq!(store.overlay_diff_counts(), net(0, 0, 1));
}

#[test]
fn commit_diff_counts_removed_base_row() {
    let l = loc(1, 0.0, 0.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    store.bake_overlay();
    store.overlay_remove([l].iter());
    assert_eq!(store.overlay_diff_counts(), net(0, 1, 0));
}

#[test]
fn commit_diff_add_then_remove_is_noop() {
    let l = loc(1, 0.0, 0.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    store.overlay_remove([l].iter());
    assert_eq!(store.overlay_diff_counts(), net(0, 0, 0));
}

// -----------------------------------------------------------------------
// Tag counts
// -----------------------------------------------------------------------

#[test]
fn tag_counts_after_add() {
    let l1 = loc_with_tags(1, 0.0, 0.0, vec![10, 20]);
    let l2 = loc_with_tags(2, 1.0, 1.0, vec![10]);
    let mut store = setup_store_with(&[l1, l2]);
    assert_eq!(tag_count(&mut store, 10), 2);
    assert_eq!(tag_count(&mut store, 20), 1);
}

#[test]
fn tag_counts_after_remove() {
    let l1 = loc_with_tags(1, 0.0, 0.0, vec![10, 20]);
    let l2 = loc_with_tags(2, 1.0, 1.0, vec![10]);
    let mut store = setup_store_with(&[l1.clone(), l2]);
    assert_eq!(
        tag_count(&mut store, 10),
        2,
        "postings built before the edit"
    );
    store.overlay_remove(slice::from_ref(&l1).iter());
    store.finish_mutation(&Change {
        removed: vec![l1],
        ..Default::default()
    });
    assert_eq!(tag_count(&mut store, 10), 1);
    assert_eq!(tag_count(&mut store, 20), 0);
}

#[test]
fn removing_a_row_the_index_never_had_is_a_no_op() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(&[]);
    store.finish_mutation(&Change {
        removed: vec![l],
        ..Default::default()
    });
    assert_eq!(tag_count(&mut store, 10), 0, "and no member is invented");
}

// -----------------------------------------------------------------------
// Undo / Redo
// -----------------------------------------------------------------------

#[test]
fn undo_add() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    store
        .edits
        .edit()
        .record(Arc::new(entry(Change::from_sides(vec![l.clone()], vec![]))));

    let _delta = reverse(&mut store, &Change::from_sides(vec![l], vec![]));
    assert_eq!(*store.alive_count, 0);
    assert!(store.get_loc_by_id(1).is_none());
}

#[test]
fn undo_remove() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[]);
    // simulate: location was removed, undo should re-add it
    let _delta = reverse(&mut store, &Change::from_sides(vec![], vec![l.clone()]));
    assert_eq!(*store.alive_count, 1);
    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 10.0);
}

#[test]
fn undo_update_restores_original() {
    let original = loc_with_heading(1, 10.0, 20.0, 0.0);
    let updated = loc_with_heading(1, 10.0, 20.0, 90.0);
    let mut store = setup_store_with(slice::from_ref(&updated));

    let entry = Change::from_sides(vec![updated], vec![original.clone()]);
    reverse(&mut store, &entry);

    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.heading, 0.0);
}

#[test]
fn redo_after_undo() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    let entry = Change::from_sides(vec![l.clone()], vec![]);

    reverse(&mut store, &entry);
    assert_eq!(*store.alive_count, 0);

    forward(&mut store, &entry);
    assert_eq!(*store.alive_count, 1);
    assert!(store.get_loc_by_id(1).is_some());
}

#[test]
fn undo_stack_capped_at_max() {
    let mut store = setup_store_with(&[]);
    for i in 0..MAX_UNDO_ENTRIES + 50 {
        let l = loc(i as u32, 0.0, 0.0);
        store
            .edits
            .edit()
            .record(Arc::new(entry(Change::from_sides(vec![l], vec![]))));
    }
    assert_eq!(store.edits.len(Stack::Undo), MAX_UNDO_ENTRIES);
}

#[test]
fn redo_stack_cleared_on_new_edit() {
    let mut store = setup_store_with(&[]);
    click_add(&mut store, 0.0, 0.0);
    press_undo(&mut store);
    assert_eq!(store.edits.len(Stack::Redo), 1);

    store.edits.edit().record(Arc::new(entry(Change::from_sides(
        vec![loc(1, 0.0, 0.0)],
        vec![],
    ))));
    assert_eq!(
        store.edits.len(Stack::Redo),
        0,
        "a new edit drops redo by itself"
    );
}

#[test]
fn a_change_too_big_to_undo_records_nothing_and_drops_all_history() {
    let mut store = setup_store_with(&[]);
    click_add(&mut store, 0.0, 0.0);
    click_add(&mut store, 0.0, 0.0);
    press_undo(&mut store);
    assert_eq!(store.edits.len(Stack::Undo), 1);
    assert_eq!(store.edits.len(Stack::Redo), 1);

    let big: Vec<Edit<Location>> = (0..=MAX_UNDO_ROWS as u32)
        .map(|_| Op::Set(loc(0, 0.0, 0.0)))
        .collect();
    store.edit(&Target::Map, big, false, &mut None);

    assert_eq!(*store.alive_count as usize, MAX_UNDO_ROWS + 2);
    assert_eq!(store.edits.len(Stack::Undo), 0);
    assert_eq!(store.edits.len(Stack::Redo), 0);
}

// -----------------------------------------------------------------------
// Tag counts through undo/redo
// -----------------------------------------------------------------------

#[test]
fn tag_counts_correct_after_undo_add() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10, 20]);
    let mut store = setup_store_with(slice::from_ref(&l));
    assert_eq!(tag_count(&mut store, 10), 1);

    let entry = Change::from_sides(vec![l], vec![]);
    edit_and_finish(&mut store, &entry, false);
    assert_eq!(tag_count(&mut store, 10), 0);
}

#[test]
fn tag_counts_correct_after_undo_remove() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(&[]);
    assert_eq!(tag_count(&mut store, 10), 0);

    let entry = Change::from_sides(vec![], vec![l]);
    edit_and_finish(&mut store, &entry, false);
    assert_eq!(tag_count(&mut store, 10), 1);
}

#[test]
fn tag_counts_correct_after_undo_tag_change() {
    let old = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let new = loc_with_tags(1, 0.0, 0.0, vec![20]);
    let mut store = setup_store_with(slice::from_ref(&new));
    assert_eq!(tag_count(&mut store, 20), 1);
    assert_eq!(tag_count(&mut store, 10), 0);

    let entry = Change::from_sides(vec![new], vec![old]);
    edit_and_finish(&mut store, &entry, false);

    assert_eq!(tag_count(&mut store, 10), 1);
    assert_eq!(tag_count(&mut store, 20), 0);
}

#[test]
fn tag_counts_survive_undo_redo_cycle() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(slice::from_ref(&l));
    let entry = Change::from_sides(vec![l.clone()], vec![]);

    edit_and_finish(&mut store, &entry, false);
    assert_eq!(tag_count(&mut store, 10), 0);

    edit_and_finish(&mut store, &entry, true);
    assert_eq!(tag_count(&mut store, 10), 1);
}

// -----------------------------------------------------------------------
// Render frames
// -----------------------------------------------------------------------

/// One row a frame adds or patches, flattened across cells. `key` is the id for an add
/// and the row's index within its cell for a patch.
#[derive(Debug, Clone, Copy, PartialEq)]
struct FrameRow {
    cell: u8,
    key: u32,
    lng: f32,
    lat: f32,
    angle: f32,
    sel: u32,
}

fn frame_rows(cells: &[CellFrame], patches: bool) -> Vec<FrameRow> {
    cells
        .iter()
        .flat_map(|c| {
            let r = if patches { &c.patch } else { &c.add };
            (0..r.len()).map(move |i| FrameRow {
                cell: c.cell,
                key: r.key[i],
                lng: r.pos[2 * i],
                lat: r.pos[2 * i + 1],
                angle: r.angle[i],
                sel: r.sel[i],
            })
        })
        .collect()
}

fn added(cells: &[CellFrame]) -> Vec<FrameRow> {
    frame_rows(cells, false)
}

fn patched(cells: &[CellFrame]) -> Vec<FrameRow> {
    frame_rows(cells, true)
}

/// Every removal as `(cell, index)`.
fn removed(cells: &[CellFrame]) -> Vec<(u8, u32)> {
    cells
        .iter()
        .flat_map(|c| c.remove.iter().map(move |&i| (c.cell, i)))
        .collect()
}

/// Watch `store` as a window would, capturing every frame it sends.
fn watch(store: &mut Store) -> Captured {
    let frames = Captured::default();
    store.frames.insert("test".into(), frames.sink());
    frames
}

#[test]
fn a_new_location_is_added_to_its_cell() {
    let mut store = setup_store_with(&[]);
    let entry = Change::from_sides(vec![loc(1, 10.0, 20.0)], vec![]);
    let changes = forward(&mut store, &entry);
    let cells = store.derive_cell_frames(&changes, &HashSet::new());
    let rows = added(&cells);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].key, 1);
    assert_eq!(rows[0].cell, render_cell_idx(10.0, 20.0));
    assert!(removed(&cells).is_empty());
}

#[test]
fn a_deleted_location_is_removed_from_its_cell() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    let entry = Change::from_sides(vec![], vec![l]);
    let changes = forward(&mut store, &entry);
    let cells = store.derive_cell_frames(&changes, &HashSet::new());
    assert_eq!(removed(&cells), vec![(render_cell_idx(10.0, 20.0), 0)]);
    assert!(added(&cells).is_empty());
}

#[test]
fn a_moved_location_leaves_its_old_cell_and_joins_the_new_one() {
    let old = loc(1, 10.0, 20.0);
    let new = loc(1, -80.0, -170.0); // far enough to cross render cells
    let mut store = setup_store_with(slice::from_ref(&old));

    // A same-id remove+create is an update, so this is a move, not a delete plus a create.
    let entry = Change::from_sides(vec![new], vec![old]);
    let changes = forward(&mut store, &entry);
    let cells = store.derive_cell_frames(&changes, &HashSet::new());

    assert_eq!(removed(&cells), vec![(render_cell_idx(10.0, 20.0), 0)]);
    let rows = added(&cells);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].key, 1);
    assert_eq!(rows[0].cell, render_cell_idx(-80.0, -170.0));
    assert!(patched(&cells).is_empty(), "the add states the row in full");
}

#[test]
fn an_unselected_add_is_drawn_by_the_base_layer() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0)]);
    store.render.marker_color = [10, 20, 30];

    let entry = Change::from_sides(vec![loc(2, 30.0, 40.0)], vec![]);
    let changes = forward(&mut store, &entry);
    let cells = store.derive_cell_frames(&changes, &HashSet::new());

    let rows = added(&cells);
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].sel, NO_SEL,
        "unselected, so the base layer draws it"
    );
}

// -----------------------------------------------------------------------
// "Samey locations" optimization: skip re-render when only non-render
// fields changed (e.g. pitch, zoom, tags, extra)
// -----------------------------------------------------------------------

#[test]
fn samey_location_skips_render_frame() {
    let old = loc(1, 10.0, 20.0);
    let mut new = loc(1, 10.0, 20.0);
    new.pitch = 45.0; // non-render field
    new.zoom = 3.0; // non-render field
    let mut store = setup_store_with(slice::from_ref(&old));

    let entry = Change::from_sides(vec![new], vec![old]);
    let changes = forward(&mut store, &entry);
    let cells = store.derive_cell_frames(&changes, &HashSet::new());

    assert!(
        Frame::cells_of(cells).is_empty(),
        "no re-render needed for pitch/zoom change"
    );
}

#[test]
fn samey_location_with_heading_change_does_rerender() {
    let old = loc_with_heading(1, 10.0, 20.0, 0.0);
    let new = loc_with_heading(1, 10.0, 20.0, 90.0);
    let mut store = setup_store_with(slice::from_ref(&old));

    let entry = Change::from_sides(vec![new], vec![old]);
    let changes = forward(&mut store, &entry);
    let cells = store.derive_cell_frames(&changes, &HashSet::new());

    // heading change in the same cell => in-place render patch
    assert_eq!(
        patched(&cells).len(),
        1,
        "heading change requires a render patch"
    );
    assert!(added(&cells).is_empty());
    assert!(removed(&cells).is_empty());
}

#[test]
fn samey_location_with_lat_change_does_rerender() {
    let old = loc(1, 10.0, 20.0);
    let new = loc(1, 11.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&old));

    let entry = Change::from_sides(vec![new], vec![old]);
    let changes = forward(&mut store, &entry);
    let cells = store.derive_cell_frames(&changes, &HashSet::new());

    assert!(
        !Frame::cells_of(cells).is_empty(),
        "lat change requires re-render"
    );
}

#[test]
fn samey_tag_only_change_skips_render() {
    let old = loc_with_tags(1, 10.0, 20.0, vec![10]);
    let new = loc_with_tags(1, 10.0, 20.0, vec![20]);
    let mut store = setup_store_with(slice::from_ref(&old));

    let entry = Change::from_sides(vec![new], vec![old]);
    let delta = forward(&mut store, &entry);

    assert_eq!(delta.added.len(), 0, "tag-only change should skip render");
    assert_eq!(delta.removed.len(), 0);
}

// -----------------------------------------------------------------------
// Derived state and change feed
// -----------------------------------------------------------------------

#[test]
fn open_status_reflects_undo_redo() {
    let l = loc(1, 0.0, 0.0);
    let mut store = setup_store_with(&[l]);

    let s = store.open_status();
    assert_eq!(
        s.derived.history.map(|h| h
            .get(&EntryKey::Rows)
            .map_or((false, false), |h| (h.undo, h.redo))),
        Some((false, false))
    );

    store.edits.edit().record(Arc::new(entry(Change::from_sides(
        vec![loc(2, 0.0, 0.0)],
        vec![],
    ))));
    let s = store.open_status();
    assert_eq!(
        s.derived.history.map(|h| h
            .get(&EntryKey::Rows)
            .map_or((false, false), |h| (h.undo, h.redo))),
        Some((true, false))
    );

    store.edits.edit().record(Arc::new(entry(Change::from_sides(
        vec![loc(2, 0.0, 0.0)],
        vec![],
    ))));
    press_undo(&mut store);
    let s = store.open_status();
    assert_eq!(
        s.derived.history.map(|h| h
            .get(&EntryKey::Rows)
            .map_or((false, false), |h| (h.undo, h.redo))),
        Some((true, true))
    );
}

#[test]
fn finish_mutation_reports_correct_state() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(&[l]);
    store.edits.edit().record(Arc::new(entry(Change::from_sides(
        vec![loc(2, 0.0, 0.0)],
        vec![],
    ))));

    let feed = FeedCapture::attach(&mut store);
    let result = store.finish_mutation(&Change::default());
    let e = feed.last();
    assert_eq!(e.derived.location_count, Some(1));
    assert_eq!(
        e.derived.history.map(|h| h
            .get(&EntryKey::Rows)
            .map_or((false, false), |h| (h.undo, h.redo))),
        Some((true, false)),
        "stack change ships both flags"
    );
    assert_eq!(result.version, 1);

    // Nothing moved since: the next finish still heartbeats its version, with
    // every derived slice absent, so a watcher can await any mutation on the feed.
    let result = store.finish_mutation(&Change::default());
    assert_eq!(feed.len(), 2);
    let e = feed.last();
    assert_eq!(e.version, result.version);
    assert!(e.derived.is_empty());
}

#[test]
fn undo_flags_ship_again_after_out_of_band_stack_clear() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    let feed = FeedCapture::attach(&mut store);
    store.edits.edit().record(Arc::new(entry(Change::from_sides(
        vec![loc(2, 0.0, 0.0)],
        vec![],
    ))));
    store.finish_mutation(&Change::default());
    assert!(feed
        .last()
        .derived
        .history
        .is_some_and(|h| h.get(&EntryKey::Rows).is_some_and(|h| h.undo)));

    // A clear outside any mutation result must still re-ship the flags next mutation.
    store.edits.edit().clear();

    store.edits.edit().record(Arc::new(entry(Change::from_sides(
        vec![loc(2, 0.0, 0.0)],
        vec![],
    ))));
    store.finish_mutation(&Change::default());
    assert_eq!(
        feed.last().derived.history.map(|h| h
            .get(&EntryKey::Rows)
            .map_or((false, false), |h| (h.undo, h.redo))),
        Some((true, false))
    );
}

#[test]
fn field_values_shipped_only_when_postings_move() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(slice::from_ref(&l));

    let feed = FeedCapture::attach(&mut store);

    // A mutation that moves no rows ships no values.
    store.finish_mutation(&Change::default());
    assert!(feed.all().iter().all(|e| e.derived.field_values.is_none()));

    // A tag-touching edit ships the moved value: recordless and on no row, it is gone.
    let changes = apply_edit(&mut store, vec![l.clone()], Vec::new());
    store.finish_mutation(&changes);
    let values = feed.last().derived.field_values.clone().unwrap();
    assert!(matches!(values["tags"].get("10"), Some(None)));
}

#[test]
fn cached_bounds_tracks_adds_and_invalidates_on_remove() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    // [w,s,e,n] = [min_lng, min_lat, max_lng, max_lat]
    assert_eq!(store.cached_bounds(), Some([0.0, 0.0, 0.0, 0.0]));

    // Add outside the box -> grows incrementally, no recompute.
    let a = loc(2, 10.0, 10.0);
    store.overlay_add(vec![a.clone()]);
    let before = store.version;
    store.bump();
    store.update_bounds(
        &Change {
            added: vec![a],
            ..Default::default()
        },
        before,
    );
    assert!(
        store
            .bounds
            .peek()
            .is_some_and(|b| b.current(store.version)),
        "add carries the cache forward"
    );
    assert_eq!(store.cached_bounds(), Some([0.0, 0.0, 10.0, 10.0]));

    // Add inside the box -> no change.
    let b = loc(3, 5.0, 5.0);
    store.overlay_add(vec![b.clone()]);
    let before = store.version;
    store.bump();
    store.update_bounds(
        &Change {
            added: vec![b],
            ..Default::default()
        },
        before,
    );
    assert_eq!(store.cached_bounds(), Some([0.0, 0.0, 10.0, 10.0]));

    // Remove the extreme point -> invalidates, recompute shrinks the box.
    store.overlay_remove([loc(2, 10.0, 10.0)].iter());
    let before = store.version;
    store.bump();
    store.update_bounds(
        &Change {
            removed: vec![loc(2, 10.0, 10.0)],
            ..Default::default()
        },
        before,
    );
    assert!(
        !store
            .bounds
            .peek()
            .is_some_and(|b| b.current(store.version)),
        "removal leaves the cache behind"
    );
    assert_eq!(store.cached_bounds(), Some([0.0, 0.0, 5.0, 5.0]));

    // The cache must never diverge from a fresh O(N) compute.
    assert_eq!(
        store.cached_bounds(),
        store.all().bounds().map(BoundsAcc::resolve)
    );
}

#[test]
fn bounds_cross_antimeridian_picks_tight_box() {
    // Straddling 180°: naive min/max would give a ~356°-wide box. The shifted
    // framing wins, yielding the 4°-wide crossing box (west > east).
    let mut store = setup_store_with(&[loc(1, 0.0, 178.0), loc(2, 0.0, -178.0)]);
    let [w, s, e, n] = store.cached_bounds().unwrap();
    assert_eq!([w, s, e, n], [178.0, 0.0, -178.0, 0.0]);
    assert!(w > e, "antimeridian-crossing box has west > east");
}

#[test]
fn bounds_wide_span_stays_non_crossing() {
    // Portugal (-9) to Japan (140): 149° genuine span, no crossing — raw framing
    // wins (149 < the 211° shifted span), so west < east as normal.
    let mut store = setup_store_with(&[loc(1, 0.0, -9.0), loc(2, 0.0, 140.0)]);
    let [w, s, e, n] = store.cached_bounds().unwrap();
    assert_eq!([w, s, e, n], [-9.0, 0.0, 140.0, 0.0]);
    assert!(w < e);
}

// -----------------------------------------------------------------------
// Render cell tracking
// -----------------------------------------------------------------------

#[test]
fn cell_add_and_lookup() {
    let mut store = setup_store_with(&[]);
    store.cell_add_render(24, 1); // 24 = 's' in BASE32
    assert_eq!(store.cell_lookup(1), Some((24, 0)));
}

#[test]
fn cell_remove_returns_correct_info() {
    let mut store = setup_store_with(&[]);
    store.cell_add_render(24, 1);
    store.cell_add_render(24, 2);
    assert_eq!(store.cell_remove_render(1), Some((24, 0)));
    assert!(store.cell_lookup(2).is_some());
}

#[test]
fn cell_remove_nonexistent_returns_none() {
    let store = setup_store_with(&[]);
    assert!(store.render.id_to_cell_idx.get(999).copied().unwrap_or(255) == 255);
}

// -----------------------------------------------------------------------
// ID allocation
// -----------------------------------------------------------------------

#[test]
fn alloc_id_increments() {
    let mut store = Store::new();
    let a = store.alloc_id();
    let b = store.alloc_id();
    assert_eq!(b, a + 1);
}

// -----------------------------------------------------------------------
// Bake overlay
// -----------------------------------------------------------------------

#[test]
fn bake_overlay_merges_adds() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, 30.0, 40.0)]);
    assert_eq!(store.overlay.adds.len(), 2);

    store.bake_overlay();
    assert!(store.overlay.adds.is_empty());
    assert_eq!(store.batch.as_ref().unwrap().num_rows(), 2);
    // locations still accessible
    assert!(store.get_loc_by_id(1).is_some());
    assert!(store.get_loc_by_id(2).is_some());
}

#[test]
fn bake_overlay_applies_patches() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0)]);
    store.bake_overlay();
    // now loc 1 is in the batch; patch it
    overlay_update(&mut store, &patch!(1; lat: 99.0));
    store.bake_overlay();

    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 99.0);
    assert!(store.overlay.patches.is_empty());
}

#[test]
fn bake_overlay_removes_dead() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    store.bake_overlay();
    // now remove
    store.overlay_remove([l].iter());
    store.bake_overlay();
    assert_eq!(store.batch.as_ref().unwrap().num_rows(), 0);
}

// -----------------------------------------------------------------------
// No-op updates should not create undo entries
// -----------------------------------------------------------------------

#[test]
fn noop_update_produces_no_undo_entry() {
    let l = loc_with_heading(1, 10.0, 20.0, 45.0);
    let mut store = setup_store_with(slice::from_ref(&l));

    // "update" with identical values
    overlay_update(&mut store, &patch!(1; heading: 45.0));
    let new = store.get_loc_by_id(1).unwrap();

    // Unchanged before/after pairs contribute no edit.
    let pairs: Vec<_> = vec![(l.clone(), new.clone())]
        .into_iter()
        .filter(|(o, n)| o != n)
        .collect();
    assert!(pairs.is_empty(), "identical update should be filtered out");
}

#[test]
fn real_update_passes_filter() {
    let l = loc_with_heading(1, 10.0, 20.0, 0.0);
    let mut store = setup_store_with(slice::from_ref(&l));

    overlay_update(&mut store, &patch!(1; heading: 90.0));
    let new = store.get_loc_by_id(1).unwrap();

    let pairs: Vec<_> = vec![(l, new)].into_iter().filter(|(o, n)| o != n).collect();
    assert_eq!(pairs.len(), 1, "changed update should pass filter");
}

#[test]
fn batch_update_mixed_changed_unchanged() {
    let l1 = loc_with_heading(1, 10.0, 20.0, 0.0);
    let l2 = loc_with_heading(2, 30.0, 40.0, 90.0);
    let mut store = setup_store_with(&[l1.clone(), l2.clone()]);

    // update l1 (real change), "update" l2 with same value (noop)
    overlay_update(&mut store, &patch!(1; heading: 180.0));
    overlay_update(&mut store, &patch!(2; heading: 90.0));
    let n1 = store.get_loc_by_id(1).unwrap();
    let n2 = store.get_loc_by_id(2).unwrap();

    let (changed_old, changed_new): (Vec<_>, Vec<_>) = vec![(l1, n1), (l2, n2)]
        .into_iter()
        .filter(|(o, n)| o != n)
        .unzip();

    assert_eq!(changed_old.len(), 1, "only l1 should be in undo");
    assert_eq!(changed_old[0].id, 1);
    assert_eq!(changed_new[0].heading, 180.0);
}

#[test]
fn noop_batch_is_removed_before_selection_and_render_work() {
    let rows: Vec<Location> = (1..=101)
        .map(|id| loc_with_heading(id, id as f64 / 10.0, 0.0, 45.0))
        .collect();
    let mut store = setup_store_with(&rows);
    add_tag_selection(&mut store, 1, [255, 0, 0]);
    store.resolve_selection_membership();
    let rev = store.overlay.rev();
    let undo_len = store.edits.len(Stack::Undo);
    let updates: Vec<Patch<Location>> = rows
        .iter()
        .map(|row| patch!(row.id; heading: row.heading))
        .collect();

    let frames = watch(&mut store);
    let feed = FeedCapture::attach(&mut store);
    apply_updates(&mut store, &updates, &mut None);

    assert_eq!(store.overlay.rev(), rev);
    assert_eq!(store.edits.len(Stack::Undo), undo_len);
    assert!(frames.last().cells.is_empty());
    assert!(feed.last().derived.selection_counts.is_none());
}

// -----------------------------------------------------------------------
// Edge case: re-add a previously removed ID
// -----------------------------------------------------------------------

#[test]
fn readd_after_remove_via_overlay() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    assert_eq!(*store.alive_count, 1);

    store.overlay_remove(slice::from_ref(&l).iter());
    assert_eq!(*store.alive_count, 0);
    assert!(store.get_loc_by_id(1).is_none());

    // re-add with different position
    let l2 = loc(1, 50.0, 60.0);
    store.overlay_add(vec![l2]);
    assert_eq!(*store.alive_count, 1);
    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 50.0);
}

#[test]
fn readd_after_remove_through_undo() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));

    // remove it
    let remove_entry = Change::from_sides(vec![], vec![l.clone()]);
    forward(&mut store, &remove_entry);
    assert_eq!(*store.alive_count, 0);

    // undo the removal
    reverse(&mut store, &remove_entry);
    assert_eq!(*store.alive_count, 1);
    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 10.0);
}

// -----------------------------------------------------------------------
// Edge case: cell swap-remove correctness
// -----------------------------------------------------------------------

#[test]
fn cell_swap_remove_maintains_correct_indices() {
    let mut store = setup_store_with(&[]);
    store.cell_add_render(24, 10);
    store.cell_add_render(24, 20);
    store.cell_add_render(24, 30);

    assert_eq!(store.cell_remove_render(10), Some((24, 0)));

    let (_, idx30) = store.cell_lookup(30).unwrap();
    assert_eq!(idx30, 0, "id 30 should have been swapped into slot 0");

    let (_, idx20) = store.cell_lookup(20).unwrap();
    assert_eq!(idx20, 1, "id 20 should be undisturbed");

    let cr = store.render.cells[24].as_ref().unwrap();
    assert_eq!(cr.id_order.len(), 2);
}

#[test]
fn cell_swap_remove_last_element() {
    let mut store = setup_store_with(&[]);
    store.cell_add_render(24, 10);
    store.cell_add_render(24, 20);

    assert_eq!(store.cell_remove_render(20), Some((24, 1)));

    let (_, idx10) = store.cell_lookup(10).unwrap();
    assert_eq!(idx10, 0, "id 10 should be undisturbed");

    assert!(store.cell_lookup(20).is_none());
}

// -----------------------------------------------------------------------
// Edge case: undo/redo with overlay patches on top of batch rows
// -----------------------------------------------------------------------

#[test]
fn undo_update_when_location_is_in_baked_batch() {
    let l = loc_with_heading(1, 10.0, 20.0, 0.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    store.bake_overlay();
    // l is now in the batch, not in overlay_adds

    // update via overlay patch
    let updated = loc_with_heading(1, 10.0, 20.0, 90.0);
    overlay_update(&mut store, &patch!(1; heading: 90.0));
    assert_eq!(store.get_loc_by_id(1).unwrap().heading, 90.0);

    // undo: apply_edit should restore original via overlay
    let entry = Change::from_sides(vec![updated], vec![l]);
    reverse(&mut store, &entry);

    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.heading, 0.0, "undo should restore original heading");
}

#[test]
fn multiple_undo_redo_cycles_consistent() {
    let l = loc_with_tags(1, 10.0, 20.0, vec![10]);
    let mut store = setup_store_with(slice::from_ref(&l));

    let updated = loc_with_tags(1, 10.0, 20.0, vec![20]);
    let entry = Change::from_sides(vec![updated.clone()], vec![l.clone()]);

    for _ in 0..5 {
        edit_and_finish(&mut store, &entry, true);
        assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![20]);
        assert_eq!(tag_count(&mut store, 20), 1);

        edit_and_finish(&mut store, &entry, false);
        assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![10]);
        assert_eq!(tag_count(&mut store, 10), 1);
    }
}

// -----------------------------------------------------------------------
// derive_cell_frames (updates)
// -----------------------------------------------------------------------

fn cell_frames_for_update(store: &mut Store, id: u32, patch: Patch<Location>) -> [CellFrame; 32] {
    let old = store.get_loc_by_id(id).unwrap();
    overlay_update(store, &Patch::<Location> { id, ..patch });
    let new_loc = store.get_loc_by_id(id).unwrap();
    store.derive_cell_frames(
        &Change {
            updated: vec![(old, new_loc)],
            ..Default::default()
        },
        &HashSet::new(),
    )
}

#[test]
fn update_heading_only_produces_patch() {
    let l = loc_with_heading(1, 10.0, 20.0, 0.0);
    let mut store = setup_store_with(&[l]);
    let cells = cell_frames_for_update(&mut store, 1, patch!(heading: 90.0));
    assert!(added(&cells).is_empty());
    assert!(removed(&cells).is_empty());
    let rows = patched(&cells);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].angle, 0.0, "pin markers point nowhere");
    assert_eq!(
        (rows[0].lng, rows[0].lat),
        (20.0, 10.0),
        "a patch restates the row in full"
    );
}

#[test]
fn update_same_cell_position_produces_patch() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    // small position change that stays in the same render cell
    let cells = cell_frames_for_update(&mut store, 1, patch!(lat: 10.001));
    // should be an in-place patch, not a cell migration
    assert_eq!(patched(&cells).len(), 1);
    assert!(added(&cells).is_empty());
}

#[test]
fn update_cross_cell_position_moves_the_row() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    // large position change that crosses render cells
    let cells = cell_frames_for_update(&mut store, 1, patch!(lat: -80.0, lng: -170.0));
    let gone = removed(&cells);
    let rows = added(&cells);
    assert_eq!(gone.len(), 1, "the old cell loses the row");
    assert_eq!(rows.len(), 1, "the new cell gains it");
    assert_eq!(rows[0].key, 1);
    assert!(patched(&cells).is_empty());
    assert_ne!(
        gone[0].0, rows[0].cell,
        "the vacated slot is in the cell it left, not the one it joined"
    );
}

#[test]
fn update_tags_only_produces_no_cell_change() {
    let l = loc_with_tags(1, 10.0, 20.0, vec![10]);
    let mut store = setup_store_with(&[l]);
    let cells = cell_frames_for_update(&mut store, 1, patch!(tags: vec![20]));
    assert!(Frame::cells_of(cells).is_empty());
}

#[test]
fn a_patch_index_counts_a_later_move_out_of_its_cell() {
    // Rows 1, 2, 3 share a cell. Row 3 turns (a patch at its slot) and row 2 then leaves the
    // cell, which swap-removes row 3 into row 2's slot. The patch must name the slot row 3
    // ends up in, whatever order the changeset lists the two edits in.
    let rows = [
        loc_with_heading(1, 10.0, 20.0, 0.0),
        loc_with_heading(2, 10.001, 20.0, 0.0),
        loc_with_heading(3, 10.002, 20.0, 0.0),
    ];
    let mut store = setup_store_with(&rows);
    let ci = render_cell_idx(10.0, 20.0);
    assert_eq!(
        store.render.cells[ci as usize].as_ref().unwrap().id_order,
        [1, 2, 3]
    );

    let turned = Location {
        heading: 90.0,
        ..rows[2].clone()
    };
    let moved = Location {
        lat: -80.0,
        lng: -170.0,
        ..rows[1].clone()
    };
    let cells = store.derive_cell_frames(
        &Change {
            updated: vec![(rows[2].clone(), turned), (rows[1].clone(), moved)],
            ..Default::default()
        },
        &HashSet::new(),
    );

    let order = &store.render.cells[ci as usize].as_ref().unwrap().id_order;
    assert_eq!(order, &[1, 3]);
    let patch = patched(&cells);
    assert_eq!(patch.len(), 1);
    assert_eq!(
        order[patch[0].key as usize], 3,
        "the patch lands on the row it restates"
    );
}

// -----------------------------------------------------------------------
// overlay_update on items in overlay_adds (not yet baked)
// -----------------------------------------------------------------------

#[test]
fn overlay_update_on_overlay_add_item() {
    let mut store = setup_store_with(&[]);
    let l = loc(1, 10.0, 20.0);
    store.overlay_add(vec![l]);
    overlay_update(&mut store, &patch!(1; lat: 50.0));
    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 50.0);
    // should still be in overlay_adds, not overlay_patches
    assert_eq!(store.overlay.adds.len(), 1);
    assert_eq!(store.overlay.adds[0].lat, 50.0);
    assert!(store.overlay.patches.is_empty());
}

// -----------------------------------------------------------------------
// whole-map collect with mixed states
// -----------------------------------------------------------------------

#[test]
fn collect_all_with_dead_patches_and_adds() {
    let l1 = loc(1, 10.0, 20.0);
    let l2 = loc(2, 30.0, 40.0);
    let l3 = loc(3, 50.0, 60.0);
    let mut store = setup_store_with(&[l1.clone(), l2.clone(), l3.clone()]);
    store.bake_overlay();
    // kill l1
    store.overlay_remove([l1].iter());
    // patch l2
    overlay_update(&mut store, &patch!(2; lat: 99.0));
    // add l4
    let l4 = loc(4, 70.0, 80.0);
    store.overlay_add(vec![l4]);
    store.alive_count = Tracked::new(3); // l2, l3, l4

    let all = store.collect(&crate::store::engine::Target::Map, &Selector::Everything);
    assert_eq!(all.len(), 3);
    let ids: Vec<u32> = all.iter().map(|l| l.id).collect();
    assert!(!ids.contains(&1), "dead location should be excluded");
    assert!(ids.contains(&2));
    assert!(ids.contains(&3));
    assert!(ids.contains(&4));
    let l2_collected = all.iter().find(|l| l.id == 2).unwrap();
    assert_eq!(l2_collected.lat, 99.0, "patch should be applied");
}

// -----------------------------------------------------------------------
// bake_overlay with all three operations
// -----------------------------------------------------------------------

#[test]
fn bake_overlay_all_three_simultaneously() {
    let l1 = loc(1, 10.0, 20.0);
    let l2 = loc(2, 30.0, 40.0);
    let mut store = setup_store_with(&[l1.clone(), l2.clone()]);
    store.bake_overlay();
    assert_eq!(store.batch.as_ref().unwrap().num_rows(), 2);

    // dead: remove l1
    store.overlay_remove([l1].iter());
    // patch: modify l2
    overlay_update(&mut store, &patch!(2; heading: 180.0));
    // add: new l3
    let l3 = loc(3, 50.0, 60.0);
    store.overlay_add(vec![l3]);
    store.alive_count = Tracked::new(2); // l2, l3

    store.bake_overlay();
    assert_eq!(store.batch.as_ref().unwrap().num_rows(), 2);
    assert!(store.overlay.adds.is_empty());
    assert!(store.overlay.patches.is_empty());
    assert!(store.overlay.dead.is_empty());
    // verify data
    assert!(store.get_loc_by_id(1).is_none());
    assert_eq!(store.get_loc_by_id(2).unwrap().heading, 180.0);
    assert_eq!(store.get_loc_by_id(3).unwrap().lat, 50.0);
}

// -----------------------------------------------------------------------
// Overlay (.delta sidecar) round-trip
// -----------------------------------------------------------------------

fn sidecar_bytes(store: &Store) -> Vec<u8> {
    arrow::arrow_ipc_bytes(&store.overlay.to_delta(store.batch.as_ref())).unwrap()
}

fn through_sidecar(store: &Store) -> Overlay {
    Overlay::from_delta(&arrow::read_arrow_ipc_bytes(&sidecar_bytes(store)).unwrap())
}

#[test]
fn sidecar_round_trips_an_empty_overlay() {
    let store = store_with_full_overlay_base();
    assert_eq!(through_sidecar(&store), Overlay::default());
}

#[test]
fn sidecar_round_trips_every_overlay_kind_to_an_equal_overlay() {
    let mut store = store_with_full_overlay_base();
    store.overlay_add(vec![loc(12, 12.0, 12.0)]);
    store.overlay_add(vec![loc(10, 10.0, 10.0), loc(11, 11.0, 11.0)]);
    overlay_update(&mut store, &patch!(2; heading: 45.0));
    let l3 = store.get_loc_by_id(3).unwrap();
    let l11 = store.get_loc_by_id(11).unwrap();
    store.overlay_remove([l3, l11].iter());
    assert!(
        store.overlay.dead.contains(11),
        "sanity: an added-then-removed id is dead"
    );

    let restored = through_sidecar(&store);

    assert_eq!(
        restored.adds.iter().map(|l| l.id).collect::<Vec<_>>(),
        vec![10, 12],
        "adds come back sorted by id"
    );
    assert_eq!(
        restored,
        Overlay {
            adds: store.overlay.adds.clone(),
            dead: [3].into_iter().collect(),
            patches: store.overlay.patches.clone(),
        },
        "an id added then removed has no base row behind it and is dropped"
    );
}

#[test]
fn delta_overlay_preserves_extra_fields() {
    let mut l = loc(10, 0.0, 0.0);
    l.extra = Some(serde_json::from_str(r#"{"country":"FR","altitude":35.2}"#).unwrap());
    l.pano_id = Some("CAoSLEF".into());
    l.modified_at = Some(1_705_276_800);
    let mut store = store_with_full_overlay_base();
    store.overlay_add(vec![l.clone()]);
    let restored = through_sidecar(&store);
    assert_eq!(restored.adds[0].extra, l.extra);
    assert_eq!(restored.adds[0].pano_id, l.pano_id);
    assert_eq!(restored.adds[0].modified_at, l.modified_at);
}

#[test]
fn sidecar_is_a_commit_delta_against_the_base() {
    let store = store_with_full_overlay();
    let batch = arrow::read_arrow_ipc_bytes(&sidecar_bytes(&store)).unwrap();
    assert_eq!(*batch.schema(), arrow::delta_schema());

    let (created, removed) = arrow::batch_to_delta(&batch);
    assert_eq!(
        created
            .iter()
            .map(|l| (l.id, l.heading))
            .collect::<Vec<_>>(),
        vec![(1, 99.0), (10, 0.0)],
        "the patched row's new version and the add"
    );
    assert_eq!(
        removed,
        vec![loc(1, 1.0, 1.0), loc(2, 2.0, 2.0)],
        "the patched row's base version and the dead base row"
    );
}

#[test]
fn the_autosave_sidecar_and_the_commit_delta_are_one_derivation() {
    let store = store_with_full_overlay();
    let unsaved = store.unsaved().unwrap().unwrap();
    let dir = TempDir::new("mma_test_autosave_is_commit_delta");
    let sidecar = dir.join("m_delta.arrow");
    with_history_db(|conn| unsaved.write(conn, "m", &sidecar).unwrap());

    let commit = store.overlay.to_delta(store.batch.as_ref());
    assert_eq!(arrow::read_arrow_ipc(&sidecar).unwrap(), commit);
}

// -----------------------------------------------------------------------
// Change (undo stack) stored-blob round-trip
// -----------------------------------------------------------------------

fn stored_round_trip(entries: &[Change]) -> Vec<Change> {
    let mut store = setup_store_with(&[]);
    let seqs: Vec<u64> = entries
        .iter()
        .map(|e| store.edits.edit().record(Arc::new(entry(e.clone()))))
        .collect();
    with_history_db(|conn| {
        save_edit_history(conn, "m", &store.edits).unwrap();
        seqs.iter()
            .map(|&seq| load_edit(conn, "m", seq).unwrap().rows)
            .collect()
    })
}

#[test]
fn an_undo_entry_round_trips_through_the_stored_blob() {
    let old = loc_with_heading(1, 10.0, 20.0, 0.0);
    let mut new = loc_with_tags(1, 10.0, 20.0, vec![3, 7]);
    new.heading = 90.0;
    new.extra = Some(serde_json::from_str(r#"{"country":"FR"}"#).unwrap());
    new.pano_id = Some("CAoSLEF".into());
    let entry = Change::from_sides(vec![new], vec![old]);
    assert_eq!(stored_round_trip(slice::from_ref(&entry)), vec![entry]);
}

#[test]
fn an_undo_stack_round_trips_through_the_stored_blobs() {
    let entries = vec![
        Change::from_sides(vec![loc(1, 10.0, 20.0)], vec![]),
        Change::from_sides(vec![], vec![loc(2, 30.0, 40.0)]),
        Change::from_sides(
            vec![loc_with_heading(3, 0.0, 0.0, 90.0)],
            vec![loc(3, 0.0, 0.0)],
        ),
    ];
    assert_eq!(stored_round_trip(&entries), entries);
}

// -----------------------------------------------------------------------
// Cross-cutting invariants
// -----------------------------------------------------------------------

#[test]
fn alive_count_stays_correct_through_all_mutations() {
    let mut store = setup_store_with(&[]);
    assert_eq!(*store.alive_count, 0);

    // Add 3
    let locs = vec![loc(1, 0.0, 0.0), loc(2, 1.0, 1.0), loc(3, 2.0, 2.0)];
    for l in &locs {
        store.overlay_add(vec![l.clone()]);
    }
    assert_eq!(*store.alive_count, 3);

    // Remove 1
    store.overlay_remove([locs[0].clone()].iter());
    assert_eq!(*store.alive_count, 2);

    // Update (should not change count)
    overlay_update(&mut store, &patch!(2; heading: 90.0));
    assert_eq!(*store.alive_count, 2);

    // Bake (should not change count)
    store.bake_overlay();
    assert_eq!(*store.alive_count, 2);

    // Add 1 more
    store.overlay_add(vec![loc(4, 3.0, 3.0)]);
    assert_eq!(*store.alive_count, 3);

    // Remove 2
    let l2 = store.get_loc_by_id(2).unwrap();
    let l3 = store.get_loc_by_id(3).unwrap();
    store.overlay_remove([l2, l3].iter());
    assert_eq!(*store.alive_count, 1);

    // Undo the remove (re-adds 2)
    let entry = Change::from_sides(vec![], vec![loc(2, 1.0, 1.0), loc(3, 2.0, 2.0)]);
    reverse(&mut store, &entry);
    assert_eq!(*store.alive_count, 3);
}

#[test]
fn ids_are_never_reused() {
    let mut store = Store::new();
    let mut seen = HashSet::new();
    for _ in 0..1000 {
        let id = store.alloc_id();
        assert!(!seen.contains(&id), "ID {id} was reused");
        seen.insert(id);
    }
}

#[test]
fn overlay_consistency_no_id_in_both_dead_and_adds() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    store.bake_overlay();

    // Remove it
    store.overlay_remove(slice::from_ref(&l).iter());
    assert!(store.overlay.dead.contains(1));
    assert!(!store.overlay.adds.iter().any(|l| l.id == 1));

    // Re-add it (overlay_add on a known batch ID goes to patches)
    store.overlay_add(vec![loc(1, 50.0, 60.0)]);
    // After re-add, it should NOT be in dead
    assert!(
        !store.overlay.dead.contains(1),
        "re-added ID should be removed from dead set"
    );
}

#[test]
fn overlay_consistency_add_new_id_goes_to_adds() {
    let mut store = setup_store_with(&[]);
    store.batch = Some(empty_batch());
    store.overlay_add(vec![loc(99, 10.0, 20.0)]);
    assert!(store.overlay.adds.iter().any(|l| l.id == 99));
    assert!(!store.overlay.patches.contains_key(&99));
}

#[test]
fn overlay_consistency_update_batch_id_goes_to_patches() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    store.bake_overlay();
    // Now l is in the batch
    overlay_update(&mut store, &patch!(1; heading: 45.0));
    assert!(store.overlay.patches.contains_key(&1));
    assert!(!store.overlay.adds.iter().any(|l| l.id == 1));
}

#[test]
fn overlay_consistency_update_add_id_stays_in_adds() {
    let mut store = setup_store_with(&[]);
    store.batch = Some(empty_batch());
    store.overlay_add(vec![loc(1, 10.0, 20.0)]);
    overlay_update(&mut store, &patch!(1; heading: 45.0));
    // Should still be in overlay_adds, updated in place
    assert_eq!(store.overlay.adds.len(), 1);
    assert_eq!(store.overlay.adds[0].heading, 45.0);
    assert!(!store.overlay.patches.contains_key(&1));
}

#[test]
fn overlay_consistency_remove_clears_patches() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    store.bake_overlay();
    overlay_update(&mut store, &patch!(1; heading: 45.0));
    assert!(store.overlay.patches.contains_key(&1));

    store.overlay_remove([l].iter());
    assert!(
        !store.overlay.patches.contains_key(&1),
        "remove should clear patches for the ID"
    );
    assert!(store.overlay.dead.contains(1));
}

#[test]
fn the_scene_frame_adds_every_row_once() {
    let l1 = loc_with_heading(1, 48.8, 2.35, 90.0);
    let l2 = loc(2, -33.8, 151.2);
    let mut store = setup_store_with(&[l1, l2]);
    store.bake_overlay();

    let frame = store.scene_frame();

    assert_eq!(frame.kind, FrameKind::REPLACE);
    assert_eq!(frame.version, store.version);
    let mut ids: Vec<u32> = added(&frame.cells).iter().map(|r| r.key).collect();
    ids.sort_unstable();
    assert_eq!(ids, [1, 2]);
    assert!(removed(&frame.cells).is_empty() && patched(&frame.cells).is_empty());
    assert!(frame.palette.is_empty(), "no selections active");
    assert_eq!(frame.selection, None, "every add states its own selection");
}

#[test]
fn the_scene_frame_order_is_the_render_cell_order() {
    // Picking resolves a slot through `id_order`, so the slots the page fills from the
    // scene frame must be exactly that order.
    let locs: Vec<Location> = (1..=6)
        .map(|id| {
            loc(
                id,
                f64::from(id) * 20.0 - 60.0,
                f64::from(id) * 50.0 - 170.0,
            )
        })
        .collect();
    let mut store = setup_store_with(&locs);
    store.bake_overlay();
    overlay_update(&mut store, &patch!(2; lat: 10.0, lng: 20.0));
    store.overlay_remove([locs[3].clone()].iter());

    let frame = store.scene_frame();

    for c in &frame.cells {
        let order = &store.render.cells[c.cell as usize]
            .as_ref()
            .unwrap()
            .id_order;
        assert_eq!(&c.add.key, order, "cell {}", c.cell);
    }
    let total: usize = frame.cells.iter().map(|c| c.add.len()).sum();
    assert_eq!(total, store.render.total_len());
}

#[test]
fn arrow_render_angle_is_negated_heading() {
    // marker_style "arrow" must write angle = -heading (regression guard for ab0c496,
    // where arrows pointed the wrong way). The value is otherwise asserted nowhere.
    let l1 = loc_with_heading(1, 48.8, 2.35, 90.0);
    let mut store = setup_store_with(&[l1]);
    store.bake_overlay();
    store.render.arrow_style = true;

    let rows = added(&store.scene_frame().cells);
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].angle, -90.0,
        "arrow angle must be the negated heading"
    );
}

#[test]
fn f32_render_truncation_matches_grid() {
    let lat = 51.123456789012345_f64;
    let lng = 2.294738201745632_f64;
    assert_ne!(
        lat as f32 as f64, lat,
        "test coordinates must actually differ between f64 and f32"
    );
    assert_ne!(
        lng as f32 as f64, lng,
        "test coordinates must actually differ between f64 and f32"
    );

    let l = loc(1, lat, lng);
    let mut store = setup_store_with(&[l.clone()]);

    let changes = Change {
        added: vec![l],
        ..Default::default()
    };
    let cells = store.derive_cell_frames(&changes, &HashSet::new());

    let rows = added(&cells);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].lat, lat as f32, "lat must be f32-truncated");
    assert_eq!(rows[0].lng, lng as f32, "lng must be f32-truncated");
}

#[test]
fn f32_render_truncation_applies_to_position_patches() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    let new_lat = 10.123456789012345_f64;
    let new_lng = 20.987654321098765_f64;
    overlay_update(&mut store, &patch!(1; lat: new_lat, lng: new_lng));
    let old = loc(1, 10.0, 20.0);
    let new_loc = store.get_loc_by_id(1).unwrap();
    let cells = store.derive_cell_frames(
        &Change {
            updated: vec![(old, new_loc)],
            ..Default::default()
        },
        &HashSet::new(),
    );
    let rows = patched(&cells);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].lat, new_lat as f32);
    assert_eq!(rows[0].lng, new_lng as f32);
}

#[test]
fn cell_render_id_order_matches_after_swap_remove_sequence() {
    // This test verifies the Rust side of the critical invariant:
    // after a sequence of adds and removes, CellRender.id_order[i]
    // must match what JS's CellBuffer.ids[i] would be after the same
    // sequence of applied frames. Both use swap-remove.
    let mut store = setup_store_with(&[]);
    store.cell_add_render(24, 10);
    store.cell_add_render(24, 20);
    store.cell_add_render(24, 30);
    // order: [10, 20, 30]

    // Remove index 0 (id=10) — 30 swaps in
    store.cell_remove_render(10);
    let cr = store.render.cells[24].as_ref().unwrap();
    assert_eq!(cr.id_order, vec![30, 20]);

    // Remove index 0 (id=30) — 20 swaps in
    store.cell_remove_render(30);
    let cr = store.render.cells[24].as_ref().unwrap();
    assert_eq!(cr.id_order, vec![20]);

    // Add new entries
    store.cell_add_render(24, 40);
    store.cell_add_render(24, 50);
    let cr = store.render.cells[24].as_ref().unwrap();
    assert_eq!(cr.id_order, vec![20, 40, 50]);

    // Verify index lookups
    assert_eq!(*cr.id_to_index.get(&20).unwrap(), 0);
    assert_eq!(*cr.id_to_index.get(&40).unwrap(), 1);
    assert_eq!(*cr.id_to_index.get(&50).unwrap(), 2);
}

// -----------------------------------------------------------------------
// Bug regression: undo delete must re-add render entry
// (e53e8f5, 66d82f1)
// -----------------------------------------------------------------------

#[test]
fn undo_delete_readds_render_entry() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    assert!(store.cell_lookup(1).is_some());

    // Delete
    let entry = Change::from_sides(vec![], vec![l.clone()]);
    let changes = forward(&mut store, &entry);
    let cells = store.derive_cell_frames(&changes, &HashSet::new());
    assert_eq!(removed(&cells).len(), 1);
    assert!(store.cell_lookup(1).is_none());

    // Undo delete
    let changes = reverse(&mut store, &entry);
    let cells = store.derive_cell_frames(&changes, &HashSet::new());
    let rows = added(&cells);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].key, 1);
    assert!(
        store.cell_lookup(1).is_some(),
        "render entry must be restored after undo delete"
    );
}

#[test]
fn undo_delete_multiple_then_readd_renders_correctly() {
    let l1 = loc(1, 10.0, 20.0);
    let l2 = loc(2, 30.0, 40.0);
    let l3 = loc(3, 50.0, 60.0);
    let mut store = setup_store_with(&[l1.clone(), l2.clone(), l3.clone()]);

    // Delete l1 and l2
    let entry = Change::from_sides(vec![], vec![l1.clone(), l2.clone()]);
    let changes = forward(&mut store, &entry);
    store.derive_cell_frames(&changes, &HashSet::new());
    assert!(store.cell_lookup(1).is_none());
    assert!(store.cell_lookup(2).is_none());
    assert!(store.cell_lookup(3).is_some());

    // Undo
    let changes = reverse(&mut store, &entry);
    let cells = store.derive_cell_frames(&changes, &HashSet::new());
    assert_eq!(added(&cells).len(), 2);
    assert!(store.cell_lookup(1).is_some());
    assert!(store.cell_lookup(2).is_some());
    assert!(store.cell_lookup(3).is_some());
}

// -----------------------------------------------------------------------
// Bug regression: selection state after clear
// (c2be3d6)
// -----------------------------------------------------------------------

#[test]
fn selected_ids_cleared_properly() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 0.0, 0.0)]);
    store.selections.ids.insert(1);
    store.selections.ids.insert(2);

    store.selections.ids.clear();
    assert!(store.selections.ids.is_empty());
}

// -----------------------------------------------------------------------
// Bug regression: tag counts after bulk operations + undo
// (edd45ab)
// -----------------------------------------------------------------------

#[test]
fn tag_counts_correct_after_bulk_add_then_undo() {
    let locs: Vec<Location> = (0..10)
        .map(|i| loc_with_tags(i, i as f64, 0.0, vec![5]))
        .collect();
    let mut store = setup_store_with(&locs);
    assert_eq!(tag_count(&mut store, 5), 10);

    let entry = Change::from_sides(locs.clone(), vec![]);
    edit_and_finish(&mut store, &entry, false);
    assert_eq!(tag_count(&mut store, 5), 0);
    assert_eq!(*store.alive_count, 0);

    edit_and_finish(&mut store, &entry, true);
    assert_eq!(tag_count(&mut store, 5), 10);
    assert_eq!(*store.alive_count, 10);
}

#[test]
fn tag_counts_correct_after_tag_reassignment_undo() {
    // location starts with tag [5], update to [5, 10], undo should restore [5]
    let old = loc_with_tags(1, 0.0, 0.0, vec![5]);
    let new = loc_with_tags(1, 0.0, 0.0, vec![5, 10]);
    let mut store = setup_store_with(slice::from_ref(&new));
    assert_eq!(tag_count(&mut store, 5), 1);
    assert_eq!(tag_count(&mut store, 10), 1);

    let entry = Change::from_sides(vec![new], vec![old]);
    edit_and_finish(&mut store, &entry, false);
    assert_eq!(tag_count(&mut store, 5), 1, "tag 5 should still be 1");
    assert_eq!(
        tag_count(&mut store, 10),
        0,
        "tag 10 should be 0 after undo"
    );
}

// -----------------------------------------------------------------------
// Bug regression: delta overlay preserves data through save/load
// (759c448 "same location save bug")
// -----------------------------------------------------------------------

#[test]
fn delta_overlay_only_includes_actual_changes() {
    let l1 = loc(1, 10.0, 20.0);
    let l2 = loc(2, 30.0, 40.0);
    let mut store = setup_store_with(&[l1.clone(), l2.clone()]);
    store.bake_overlay();

    // Modify only l1
    overlay_update(&mut store, &patch!(1; heading: 90.0));

    let overlay = through_sidecar(&store);
    assert!(overlay.adds.is_empty(), "no new locations added");
    assert!(overlay.dead.is_empty(), "no locations deleted");
    assert_eq!(
        overlay.patches.len(),
        1,
        "only modified location in patches"
    );
    assert_eq!(overlay.patches[&1].heading, 90.0);
}

#[test]
fn delta_overlay_round_trip_preserves_store_state() {
    let l1 = loc_with_tags(1, 10.0, 20.0, vec![5]);
    let l2 = loc(2, 30.0, 40.0);
    let mut store = setup_store_with(&[l1.clone(), l2.clone()]);
    store.bake_overlay();

    // Add l3, remove l1, patch l2
    let l3 = loc(3, 50.0, 60.0);
    store.overlay_add(vec![l3.clone()]);
    store.overlay_remove(slice::from_ref(&l1).iter());
    overlay_update(&mut store, &patch!(2; heading: 180.0));

    let restored = through_sidecar(&store);
    assert_eq!(restored.adds.len(), 1);
    assert_eq!(restored.adds[0].id, 3);
    assert!(restored.dead.contains(1));
    assert_eq!(restored.patches.len(), 1);
    assert_eq!(restored.patches[&2].heading, 180.0);
}

// -----------------------------------------------------------------------
// Render buffer binary format
// -----------------------------------------------------------------------

/// Push a selection with an explicit member set, bypassing resolution.
fn push_resolved(store: &mut Store, key: &str, color: [u8; 3], members: &[u32]) {
    edit_selection_fixture(store, |rows| {
        rows.push(ListedSelection {
            selection: Selection {
                key: key.into(),
                color,
                selector: Selector::Manual {
                    locations: members.to_vec(),
                },
            },
            ghosted: false,
        })
    });
    let sets = store
        .selections
        .list()
        .iter()
        .map(|row| match &row.selection.selector {
            Selector::Manual { locations } => locations.iter().copied().collect(),
            _ => unreachable!(),
        })
        .collect();
    store.selections.resolve(sets, HashMap::new());
}

/// The scene behind `app/test/unit/fixtures/selection-bitmask.bin`: 200 locations in cell
/// `u` and 3 in cell `r`, with 300 selections -- "a" [255,0,0] over ids 1, 5 and 9, "b"
/// [0,0,255] over ids 201 and 203, then 298 fillers over id 1 so the count clears the u8
/// the header used to be. The wide cell picks the index-list format, the narrow one the
/// bitmask, so one buffer carries both branches.
fn selection_bitmask_fixture() -> Vec<u8> {
    let mut locs: Vec<Location> = (1..=200)
        .map(|i| loc(i, 48.8 + f64::from(i) * 0.0005, 2.35))
        .collect();
    locs.extend((201..=203).map(|i| loc(i, -33.8, 151.2 + f64::from(i) * 0.001)));
    let mut store = setup_store_with(&locs);
    store.bake_overlay();
    push_resolved(&mut store, "a", [255, 0, 0], &[1, 5, 9]);
    push_resolved(&mut store, "b", [0, 0, 255], &[201, 203]);
    for i in 0..298u32 {
        push_resolved(&mut store, &format!("f{i}"), [(i % 256) as u8, 0, 0], &[1]);
    }
    let live: Vec<&ResolvedSelection> = store.selections.live().collect();
    build_selection_buf(&store.render, &live).0
}

fn selection_bitmask_fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/unit/fixtures/selection-bitmask.bin")
}

/// Generator, not an assertion. `cargo test emit_selection_bitmask_fixture -- --ignored`
/// rewrites `app/test/unit/fixtures/selection-bitmask.bin`, which `selectionBitmask.test.ts`
/// decodes.
#[test]
#[ignore]
fn emit_selection_bitmask_fixture() {
    let path = selection_bitmask_fixture_path();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, selection_bitmask_fixture()).unwrap();
}

/// The committed fixture is what the serializer writes today.
/// If either side drifts, one of the two suites goes red.
#[test]
fn the_selection_bitmask_fixture_matches_the_serializer() {
    let on_disk = fs::read(selection_bitmask_fixture_path()).expect(
        "fixture; regenerate with `cargo test emit_selection_bitmask_fixture -- --ignored`",
    );
    assert_eq!(on_disk, selection_bitmask_fixture());
}

/// The frames behind `app/test/unit/fixtures/render-frame.bin`, as a window watching from
/// the start receives them: the scene, then one edit. Arrow style, 4 locations in 3 cells
/// (d: id 3, r: id 2, u: ids 1 and 4), selections "a" [255,0,0] over ids 1 and 4 and
/// "b" [0,0,255] over id 2. The edit removes id 1, adds id 5 in `u` and id 6 in `d`,
/// moves id 2 from `r` to `u` and turns id 4; a ranked selection makes it a full resolve,
/// so the patch frame carries a selection section too.
fn render_frame_fixture() -> Vec<u8> {
    let locs = vec![
        loc_with_heading(1, 48.8, 2.35, 90.0),
        loc_with_heading(2, -33.8, 151.2, 180.0),
        loc_with_heading(3, 40.7, -74.0, 270.0),
        loc_with_heading(4, 48.9, 2.4, 45.0),
    ];
    let mut store = setup_store_with(&locs);
    store.bake_overlay();
    push_resolved(&mut store, "a", [255, 0, 0], &[1, 4]);
    push_resolved(&mut store, "b", [0, 0, 255], &[2]);
    edit_selection_fixture(&mut store, |rows| {
        rows[1].selection.selector = Selector::Ranked {
            expr: "id".into(),
            k: Some(1),
            ascending: true,
            selection: Some(Box::new(Selection {
                key: "b0".into(),
                color: [0, 0, 255],
                selector: Selector::Manual { locations: vec![2] },
            })),
        }
    });
    store.resolve_selection_membership();

    let frames = Captured::default();
    let req = RenderRequest {
        marker_style: "arrow".into(),
        ..RenderRequest::default()
    };
    store.subscribe_frames("fixture".into(), frames.sink(), &req);

    let changes = apply_edit(
        &mut store,
        vec![locs[0].clone(), locs[1].clone(), locs[3].clone()],
        vec![
            loc_with_heading(2, 48.85, 2.3, 180.0),
            loc_with_heading(4, 48.9, 2.4, 135.0),
            loc_with_heading(5, 48.7, 2.2, 10.0),
            loc_with_heading(6, 40.6, -74.1, 20.0),
        ],
    );
    store.finish_mutation(&changes);

    let mut out = Vec::new();
    for bytes in frames.bytes() {
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(&bytes);
    }
    out
}

fn render_frame_fixture_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/unit/fixtures/render-frame.bin")
}

/// Generator, not an assertion. `cargo test emit_render_frame_fixture -- --ignored`
/// rewrites `app/test/unit/fixtures/render-frame.bin`: each frame is prefixed with its
/// u32 byte length. `cellManager.test.ts` applies them.
#[test]
#[ignore]
fn emit_render_frame_fixture() {
    let path = render_frame_fixture_path();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, render_frame_fixture()).unwrap();
}

/// The committed fixture is what the encoder writes today.
/// If either side drifts, one of the two suites goes red.
#[test]
fn the_render_frame_fixture_matches_the_encoder() {
    let on_disk = fs::read(render_frame_fixture_path())
        .expect("fixture; regenerate with `cargo test emit_render_frame_fixture -- --ignored`");
    assert_eq!(on_disk, render_frame_fixture());
}

/// The page's cells after applying `frames` in order, the way `CellManager.apply` does:
/// a replace starts over, each removal swap-removes, adds append, patches must land inside.
fn replay(frames: &[Frame]) -> [Vec<u32>; 32] {
    let mut cells: [Vec<u32>; 32] = array::from_fn(|_| Vec::new());
    for frame in frames {
        if frame.kind == FrameKind::REPLACE {
            cells = array::from_fn(|_| Vec::new());
        }
        for c in &frame.cells {
            let ids = &mut cells[c.cell as usize];
            for &i in &c.remove {
                ids.swap_remove(i as usize);
            }
            ids.extend(&c.add.key);
            for &i in &c.patch.key {
                assert!((i as usize) < ids.len(), "patch {i} past cell {}", c.cell);
            }
        }
    }
    cells
}

fn render_order(store: &Store) -> [Vec<u32>; 32] {
    array::from_fn(|ci| {
        store.render.cells[ci]
            .as_ref()
            .map(|cr| cr.id_order.clone())
            .unwrap_or_default()
    })
}

#[test]
fn replayed_frames_rebuild_the_render_cell_order() {
    // Picking reads a slot through `id_order`, so the page's slots must match it exactly
    // after any run of edits: removals, adds, cross-cell moves and in-place patches mixed
    // in one changeset, in whatever order the changeset lists them.
    let mut seed = 0x2545_f491_u64;
    let mut next = move |n: u64| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed % n
    };
    let spot = |r: u64| {
        (
            f64::from((r % 7) as u32) * 25.0 - 80.0,
            f64::from((r % 11) as u32) * 30.0 - 160.0,
        )
    };
    let locs: Vec<Location> = (1..=40)
        .map(|id| {
            let (lat, lng) = spot(u64::from(id) * 7919);
            loc(id, lat, lng)
        })
        .collect();
    let mut store = setup_store_with(&locs);
    store.bake_overlay();
    let frames = Captured::default();
    store.subscribe_frames("page".into(), frames.sink(), &RenderRequest::default());

    for round in 0..60 {
        let alive: Vec<Location> =
            store.collect(&crate::store::engine::Target::Map, &Selector::Everything);
        let mut remove = Vec::new();
        let mut create = Vec::new();
        for l in &alive {
            match next(6) {
                0 => remove.push(l.clone()),
                1 => {
                    let (lat, lng) = spot(next(1_000));
                    remove.push(l.clone());
                    create.push(Location {
                        lat,
                        lng,
                        ..l.clone()
                    });
                }
                2 => {
                    remove.push(l.clone());
                    create.push(Location {
                        heading: l.heading + 10.0,
                        ..l.clone()
                    });
                }
                _ => {}
            }
        }
        for _ in 0..next(5) {
            let (lat, lng) = spot(next(1_000));
            create.push(loc(store.alloc_id(), lat, lng));
        }
        let changes = apply_edit(&mut store, remove, create);
        store.finish_mutation(&changes);
        assert_eq!(
            replay(&frames.frames()),
            render_order(&store),
            "round {round}"
        );
    }
}

#[test]
fn every_mutation_sends_one_frame_stamped_with_its_version() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0)]);
    let frames = watch(&mut store);

    let changes = apply_edit(&mut store, Vec::new(), vec![loc(2, 30.0, 40.0)]);
    let moved = store.finish_mutation(&changes);
    // A change that moves no row still answers the page's wait for its version.
    let quiet = store.finish_mutation(&Change::default());

    let sent = frames.frames();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0].version, moved.version);
    assert_eq!(sent[1].version, quiet.version);
    assert!(sent.iter().all(|f| f.kind == FrameKind::PATCH));
    assert!(sent[1].cells.is_empty());
}

#[test]
fn subscribing_sends_the_scene_to_every_watching_window() {
    // The scene rebuild reorders the render cells, so a window already watching must get
    // the new order too, or its slots would stop matching `id_order`.
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, 10.0, 20.0)]);
    store.bake_overlay();
    let (a, b) = (Captured::default(), Captured::default());
    store.subscribe_frames("a".into(), a.sink(), &RenderRequest::default());
    store.subscribe_frames("b".into(), b.sink(), &RenderRequest::default());

    assert_eq!(a.frames().len(), 2);
    assert_eq!(b.frames().len(), 1);
    assert_eq!(a.last(), b.last());
    assert_eq!(b.last().kind, FrameKind::REPLACE);
}

#[test]
fn a_store_replacing_another_draws_its_scene_for_the_windows_watching_the_old_one() {
    let mut old = setup_store_with(&[loc(1, 10.0, 20.0)]);
    let watcher = Captured::default();
    old.subscribe_frames("a".into(), watcher.sink(), &RenderRequest::default());
    let mut new = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, -30.0, -40.0)]);

    new.adopt_watchers(old);

    let frame = watcher.last();
    assert_eq!(frame.kind, FrameKind::REPLACE);
    assert_eq!(frame.version, new.version);
    let ids: usize = frame.cells.iter().map(|c| c.add.key.len()).sum();
    assert_eq!(ids, 2, "the new store's rows, not the old one's");
    undoable(&mut new, vec![], vec![loc(3, 0.0, 0.0)]);
    assert_eq!(
        watcher.last().kind,
        FrameKind::PATCH,
        "later edits reach it too"
    );
}

#[test]
fn an_add_reports_the_id_its_first_location_was_given() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    store.next_id = 2;
    let added = add_rows(&mut store, vec![loc(0, 1.0, 1.0), loc(0, 2.0, 2.0)]);
    let ids: Vec<u32> = store
        .collect(&crate::store::engine::Target::Map, &Selector::Everything)
        .iter()
        .filter(|l| l.lat > 0.5)
        .map(|l| l.id)
        .collect();
    let first = added.added[0];
    assert_eq!(ids, vec![first, first + 1]);
}

#[test]
fn a_selection_change_restates_every_cell_and_keeps_the_bounds() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, -30.0, -40.0)]);
    store.bake_overlay();
    let bounds = store.cached_bounds();
    let frames = watch(&mut store);
    push_resolved(&mut store, "a", [255, 0, 0], &[2]);
    store.selections.ids = store.selections.live_ids();

    let feed = FeedCapture::attach(&mut store);
    let result = store.finish_selection_change();

    let frame = frames.last();
    assert_eq!(frame.version, result.version);
    assert!(frame.cells.is_empty(), "no row moved");
    assert_eq!(frame.palette, [[255, 0, 0]]);
    let section = frame.selection.expect("every cell's membership restated");
    assert_eq!(section, store.selection_section());
    assert!(feed.last().derived.selection_counts.is_some());
    assert_eq!(store.selections.ids.len(), 1);
    assert!(
        store.bounds.peek().unwrap().current(store.version),
        "a selection change moves no row, so the bounds carry over"
    );
    assert_eq!(store.cached_bounds(), bounds);
}

#[test]
fn unbinding_a_window_stops_its_frames() {
    let mut mgr = StoreManager::new();
    mgr.stores.insert("map-a".into(), setup_store_with(&[]));
    mgr.window_map.insert("win-1".into(), "map-a".into());
    mgr.window_map.insert("win-2".into(), "map-a".into());
    let (one, two) = (Captured::default(), Captured::default());
    let store = mgr.store_for_map("map-a").unwrap();
    store.frames.insert("win-1".into(), one.sink());
    store.frames.insert("win-2".into(), two.sink());

    mgr.unbind_window("win-1");
    mgr.store_for_map("map-a")
        .unwrap()
        .finish_mutation(&Change::default());

    assert!(
        one.bytes().is_empty(),
        "the closed window hears nothing more"
    );
    assert_eq!(two.bytes().len(), 1);
}

#[test]
fn the_render_frame_fixture_covers_every_section() {
    let bytes = render_frame_fixture();
    let mut frames = Vec::new();
    let mut off = 0;
    while off < bytes.len() {
        let len = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
        frames.push(frame::tests::decode(&bytes[off + 4..off + 4 + len]));
        off += 4 + len;
    }
    let [scene, edit] = frames.as_slice() else {
        panic!("the scene and one edit");
    };
    assert_eq!(scene.kind, FrameKind::REPLACE);
    assert_eq!(edit.kind, FrameKind::PATCH);
    assert_eq!(edit.palette, [[255, 0, 0], [0, 0, 255]]);
    assert!(!removed(&edit.cells).is_empty());
    let moved_in = added(&edit.cells).iter().any(|r| r.key == 2);
    assert!(moved_in, "the move lands in its new cell");
    assert!(!patched(&edit.cells).is_empty());
    assert!(
        edit.selection.is_some(),
        "the ranking forces a full resolve"
    );
}

#[test]
fn the_scene_frame_states_each_rows_selection() {
    let l1 = loc(1, 10.0, 20.0);
    let l2 = loc(2, 30.0, 40.0);
    let mut store = setup_store_with(&[l1, l2]);
    store.bake_overlay();
    push_resolved(&mut store, "manual", [255, 0, 0], &[1]);
    store.selections.ids.insert(1);

    let frame = store.scene_frame();

    assert_eq!(frame.palette, [[255, 0, 0]]);
    let mut sel: Vec<(u32, u32)> = added(&frame.cells).iter().map(|r| (r.key, r.sel)).collect();
    sel.sort_unstable();
    assert_eq!(sel, [(1, 0), (2, NO_SEL)]);
}

#[test]
fn the_scene_frame_tags_each_row_with_its_drawing_selection() {
    // Ids alternate between the two selections, so batch order and selection order
    // disagree. Each row carries the selection that draws it; the page orders its overlay
    // by that index, which is where the z-order between overlapping markers is decided.
    let locs: Vec<_> = (1..=4).map(|id| loc(id, 10.0, 20.0)).collect();
    let mut store = setup_store_with(&locs);
    store.bake_overlay();
    push_resolved(&mut store, "a", [255, 0, 0], &[1, 3]);
    push_resolved(&mut store, "b", [0, 0, 255], &[2, 4]);
    for id in 1..=4 {
        store.selections.ids.insert(id);
    }

    let rows = added(&store.scene_frame().cells);
    let ids: Vec<u32> = rows.iter().map(|r| r.key).collect();
    let sel: Vec<u32> = rows.iter().map(|r| r.sel).collect();
    assert_eq!(ids, vec![1, 2, 3, 4], "batch order");
    assert_eq!(
        sel,
        vec![0, 1, 0, 1],
        "each row tagged with its drawing selection"
    );
}

#[test]
fn paint_for_uses_last_matching_selection() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    // id 1 belongs to two selections with different colors.
    for (key, color) in [("a", [255, 0, 0]), ("b", [0, 0, 255])] {
        push_resolved(&mut store, key, color, &[1]);
    }
    store.selections.ids.insert(1);

    // The index is what the overlay orders by, so it must name the winning selection.
    let paint = store.selections.paint_for(1).expect("id 1 is selected");
    assert_eq!(paint, 1, "last selection wins");
    assert_eq!(store.scene_frame().palette[paint as usize], [0, 0, 255]);
    assert!(store.selections.paint_for(2).is_none(), "unselected id");
}

#[test]
fn paint_map_matches_paint_for() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 0.0, 0.0), loc(3, 0.0, 0.0)]);
    for (key, color, members) in [
        ("a", [255, 0, 0], vec![1u32, 2]),
        ("b", [0, 0, 255], vec![2u32, 3]),
    ] {
        push_resolved(&mut store, key, color, &members);
        for id in &members {
            store.selections.ids.insert(*id);
        }
    }

    let map = store.selections.paint_map();
    for id in 1..=4 {
        assert_eq!(
            map.get(&id).copied(),
            store.selections.paint_for(id),
            "id {id}"
        );
    }
}

// -----------------------------------------------------------------------
// Sorted ID invariant
// -----------------------------------------------------------------------

fn ids_sorted(store: &Store) -> bool {
    if let Some(ref b) = store.batch {
        let ids = Columns::id(b);
        (1..b.num_rows()).all(|i| ids.value(i - 1) < ids.value(i))
    } else {
        true
    }
}

#[test]
fn bake_preserves_sorted_ids_after_adds() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, 30.0, 40.0), loc(3, 50.0, 60.0)]);
    store.bake_overlay();
    assert!(ids_sorted(&store));
}

#[test]
fn bake_preserves_sorted_ids_after_patches() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, 30.0, 40.0), loc(3, 50.0, 60.0)]);
    store.bake_overlay();
    overlay_update(&mut store, &patch!(2; lat: 99.0));
    store.bake_overlay();
    assert!(ids_sorted(&store));
    assert_eq!(store.get_loc_by_id(2).unwrap().lat, 99.0);
}

#[test]
fn bake_preserves_sorted_ids_after_remove_and_patch() {
    let mut store = setup_store_with(&[
        loc(1, 0.0, 0.0),
        loc(2, 10.0, 10.0),
        loc(3, 20.0, 20.0),
        loc(4, 30.0, 30.0),
    ]);
    store.bake_overlay();
    store.overlay_remove([loc(2, 10.0, 10.0)].iter());
    overlay_update(&mut store, &patch!(3; heading: 45.0));
    store.bake_overlay();
    assert!(ids_sorted(&store));
    let ids: Vec<u32> = {
        let b = store.batch.as_ref().unwrap();
        (0..b.num_rows()).map(|i| Columns::id(b).value(i)).collect()
    };
    assert_eq!(ids, vec![1, 3, 4]);
}

#[test]
fn bake_preserves_sorted_ids_after_mixed_ops() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 10.0, 10.0)]);
    store.bake_overlay();
    // Remove 1, patch 2, add 3
    store.overlay_remove([loc(1, 0.0, 0.0)].iter());
    overlay_update(&mut store, &patch!(2; lat: 99.0));
    let l3 = loc(3, 50.0, 50.0);
    store.overlay_add(vec![l3]);
    store.bake_overlay();
    assert!(ids_sorted(&store));
    let ids: Vec<u32> = {
        let b = store.batch.as_ref().unwrap();
        (0..b.num_rows()).map(|i| Columns::id(b).value(i)).collect()
    };
    assert_eq!(ids, vec![2, 3]);
}

#[test]
fn bake_sorted_ids_survive_multiple_cycles() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 10.0, 10.0)]);
    store.bake_overlay();
    for round in 0..5 {
        let new_id = 10 + round;
        store.overlay_add(vec![loc(new_id, round as f64, round as f64)]);
        if round % 2 == 0 {
            overlay_update(&mut store, &patch!(2; heading: round as f64));
        }
        store.bake_overlay();
        assert!(ids_sorted(&store), "failed at round {round}");
    }
}

// -----------------------------------------------------------------------
// Binary search (Columns::row_of)
// -----------------------------------------------------------------------

#[test]
fn binary_search_finds_existing_ids() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(5, 10.0, 10.0), loc(10, 20.0, 20.0)]);
    store.bake_overlay();
    let b = store.batch.as_ref().unwrap();
    assert_eq!(Columns::of(b).row_of(1), Some(0));
    assert_eq!(Columns::of(b).row_of(5), Some(1));
    assert_eq!(Columns::of(b).row_of(10), Some(2));
}

#[test]
fn binary_search_returns_none_for_missing() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(5, 10.0, 10.0), loc(10, 20.0, 20.0)]);
    store.bake_overlay();
    let b = store.batch.as_ref().unwrap();
    assert_eq!(Columns::of(b).row_of(0), None);
    assert_eq!(Columns::of(b).row_of(3), None);
    assert_eq!(Columns::of(b).row_of(7), None);
    assert_eq!(Columns::of(b).row_of(99), None);
}

#[test]
fn binary_search_on_empty_batch() {
    let b = empty_batch();
    assert_eq!(Columns::of(&b).row_of(1), None);
}

#[test]
fn binary_search_single_element() {
    let mut store = setup_store_with(&[loc(42, 0.0, 0.0)]);
    store.bake_overlay();
    let b = store.batch.as_ref().unwrap();
    assert_eq!(Columns::of(b).row_of(42), Some(0));
    assert_eq!(Columns::of(b).row_of(41), None);
    assert_eq!(Columns::of(b).row_of(43), None);
}

#[test]
fn get_loc_by_id_uses_binary_search_on_batch() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, 30.0, 40.0), loc(3, 50.0, 60.0)]);
    store.bake_overlay();
    // All in batch now, no overlay
    assert_eq!(store.get_loc_by_id(1).unwrap().lat, 10.0);
    assert_eq!(store.get_loc_by_id(2).unwrap().lat, 30.0);
    assert_eq!(store.get_loc_by_id(3).unwrap().lat, 50.0);
    assert!(store.get_loc_by_id(99).is_none());
}

#[test]
fn overlay_add_distinguishes_batch_vs_new_ids() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, 30.0, 40.0)]);
    store.bake_overlay();
    // Adding id=1 again should go to patches (exists in batch)
    store.overlay_add(vec![loc(1, 99.0, 99.0)]);
    assert!(store.overlay.patches.contains_key(&1));
    assert!(store.overlay.adds.is_empty());
    // Adding id=5 should go to adds (not in batch)
    store.overlay_add(vec![loc(5, 50.0, 50.0)]);
    assert_eq!(store.overlay.adds.len(), 1);
    assert_eq!(store.overlay.adds[0].id, 5);
}

// -----------------------------------------------------------------------
// Full lifecycle: add/remove/undo across bake boundaries
// -----------------------------------------------------------------------

#[test]
fn full_lifecycle_add_bake_remove_bake_undo() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 10.0, 10.0)]);
    store.bake_overlay();
    assert!(ids_sorted(&store));
    assert_eq!(*store.alive_count, 2);

    // Add loc 3, bake
    store.overlay_add(vec![loc(3, 20.0, 20.0)]);
    store.bake_overlay();
    assert!(ids_sorted(&store));
    assert_eq!(store.batch.as_ref().unwrap().num_rows(), 3);

    // Remove loc 2, bake
    store.overlay_remove([loc(2, 10.0, 10.0)].iter());
    store.bake_overlay();
    assert!(ids_sorted(&store));
    assert_eq!(store.batch.as_ref().unwrap().num_rows(), 2);

    // Verify surviving IDs
    assert!(store.get_loc_by_id(1).is_some());
    assert!(store.get_loc_by_id(2).is_none());
    assert!(store.get_loc_by_id(3).is_some());
}

#[test]
fn patch_all_rows_preserves_order() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 10.0, 10.0), loc(3, 20.0, 20.0)]);
    store.bake_overlay();
    // Patch every single row
    overlay_update(&mut store, &patch!(1; heading: 10.0));
    overlay_update(&mut store, &patch!(2; heading: 20.0));
    overlay_update(&mut store, &patch!(3; heading: 30.0));
    store.bake_overlay();
    assert!(ids_sorted(&store));
    assert_eq!(store.get_loc_by_id(1).unwrap().heading, 10.0);
    assert_eq!(store.get_loc_by_id(2).unwrap().heading, 20.0);
    assert_eq!(store.get_loc_by_id(3).unwrap().heading, 30.0);
}

// -----------------------------------------------------------------------
// StoreManager
// -----------------------------------------------------------------------

#[test]
fn manager_insert_and_lookup() {
    let mut mgr = StoreManager::new();
    let mut s1 = Store::new();
    s1.meta = Tracked::new(maps::MapMeta {
        id: "map-a".into(),
        ..Default::default()
    });
    s1.alive_count = Tracked::new(10);
    let mut s2 = Store::new();
    s2.meta = Tracked::new(maps::MapMeta {
        id: "map-b".into(),
        ..Default::default()
    });
    s2.alive_count = Tracked::new(20);

    mgr.stores.insert("map-a".into(), s1);
    mgr.stores.insert("map-b".into(), s2);
    mgr.window_map.insert("win-1".into(), "map-a".into());
    mgr.window_map.insert("win-2".into(), "map-b".into());

    assert_eq!(*mgr.store_for_window("win-1").unwrap().alive_count, 10);
    assert_eq!(*mgr.store_for_window("win-2").unwrap().alive_count, 20);
    assert_eq!(*mgr.store_for_map("map-a").unwrap().alive_count, 10);
    assert_eq!(*mgr.store_for_map("map-b").unwrap().alive_count, 20);
}

#[test]
fn manager_window_not_found() {
    let mut mgr = StoreManager::new();
    assert!(mgr.store_for_window("nonexistent").is_err());
}

#[test]
fn manager_map_not_found() {
    let mut mgr = StoreManager::new();
    assert!(mgr.store_for_map("nonexistent").is_err());
}

#[test]
fn manager_map_id_for_window() {
    let mut mgr = StoreManager::new();
    mgr.window_map.insert("win-1".into(), "map-a".into());
    assert_eq!(mgr.map_id_for_window("win-1").unwrap(), "map-a");
    assert!(mgr.map_id_for_window("win-2").is_err());
}

#[test]
fn manager_unbind_last_window_yields_store() {
    let mut mgr = StoreManager::new();
    mgr.stores.insert("map-a".into(), Store::new());
    mgr.window_map.insert("win-1".into(), "map-a".into());

    let (map_id, _store) = mgr.unbind_window("win-1").expect("last window flushes");
    assert_eq!(map_id, "map-a");
    assert!(mgr.window_map.is_empty());
    assert!(mgr.stores.is_empty());
}

#[test]
fn manager_unbind_keeps_store_open_elsewhere() {
    let mut mgr = StoreManager::new();
    mgr.stores.insert("map-a".into(), Store::new());
    mgr.window_map.insert("win-1".into(), "map-a".into());
    mgr.window_map.insert("win-2".into(), "map-a".into());

    assert!(mgr.unbind_window("win-1").is_none());
    assert!(mgr.stores.contains_key("map-a"));
    assert_eq!(mgr.map_id_for_window("win-2").unwrap(), "map-a");

    assert!(mgr.unbind_window("unknown").is_none());
    assert!(mgr.unbind_window("win-2").is_some());
}

#[test]
fn manager_remove_preserves_other() {
    let mut mgr = StoreManager::new();
    let mut s1 = Store::new();
    s1.meta = Tracked::new(maps::MapMeta {
        id: "map-a".into(),
        ..Default::default()
    });
    let mut s2 = Store::new();
    s2.meta = Tracked::new(maps::MapMeta {
        id: "map-b".into(),
        ..Default::default()
    });
    s2.alive_count = Tracked::new(99);

    mgr.stores.insert("map-a".into(), s1);
    mgr.stores.insert("map-b".into(), s2);
    mgr.window_map.insert("win-1".into(), "map-a".into());
    mgr.window_map.insert("win-2".into(), "map-b".into());

    mgr.window_map.remove("win-1");
    mgr.stores.remove("map-a");

    assert!(mgr.store_for_window("win-1").is_err());
    assert_eq!(*mgr.store_for_window("win-2").unwrap().alive_count, 99);
    assert!(mgr.store_for_map("map-a").is_err());
    assert_eq!(*mgr.store_for_map("map-b").unwrap().alive_count, 99);
}

// -----------------------------------------------------------------------
// Interned value records: the one Rust-side owner (values.rs)
// -----------------------------------------------------------------------

/// A create seed: a pile with just a name.
fn seed(name: &str) -> ValueRecord {
    let mut rec = ValueRecord::new();
    rec.insert("name".into(), name.into());
    rec
}

fn creates(names: &[&str]) -> FieldValuesPatch {
    FieldValuesPatch {
        create: names.iter().map(|n| seed(n)).collect(),
        ..Default::default()
    }
}

#[test]
fn patch_field_values_interns_names_with_server_side_ids_above_the_data_floor() {
    // Rows already carry tag id 7 with no metadata (foreign import); a fresh name must
    // allocate above it, and an existing name must be reused case-insensitively.
    let mut store = setup_store_with(&[loc_with_tags(1, 0.0, 0.0, vec![7])]);
    let urban = store
        .patch_field_values("tags", &creates(&["Urban"]))
        .unwrap()
        .resolved[0];
    assert!(urban > 7, "fresh id lands above the data's max");

    let feed = FeedCapture::attach(&mut store);
    let r = store
        .patch_field_values("tags", &creates(&["URBAN", "Rural"]))
        .unwrap();
    assert_eq!(r.resolved[0], urban, "case-insensitive reuse");
    assert!(r.resolved[1] > urban);
    assert!(
        shipped_record(&feed.last().derived, "tags", r.resolved[1]).is_some(),
        "the reconciled records ship on the same result"
    );
}

#[test]
fn patch_field_values_updates_and_reorders_records() {
    let mut store = setup_store_with(&[]);
    let ids = store
        .patch_field_values("tags", &creates(&["A", "B"]))
        .unwrap()
        .resolved;

    let mut patch = ValueRecord::new();
    patch.insert("name".into(), "Alpha".into());
    patch.insert("color".into(), "#123456".into());
    let feed = FeedCapture::attach(&mut store);
    let r = store
        .patch_field_values(
            "tags",
            &FieldValuesPatch {
                update: vec![{
                    let mut patch = patch;
                    patch.insert("id".into(), ids[0].into());
                    patch
                }],
                reorder: Some(vec![ids[1], ids[0]]),
                ..Default::default()
            },
        )
        .unwrap();
    let _ = r;
    let derived = feed.last().derived;
    let first = shipped_record(&derived, "tags", ids[0]).unwrap();
    let second = shipped_record(&derived, "tags", ids[1]).unwrap();
    assert_eq!(record_name(&first), Some("Alpha"));
    assert_eq!(first["color"], "#123456");
    assert_eq!(record_order(&second), Some(0));
    assert_eq!(record_order(&first), Some(1));
}

#[test]
fn patch_field_values_null_deletes_a_pile_key_but_never_the_name() {
    let mut store = setup_store_with(&[]);
    let id = store
        .patch_field_values("tags", &creates(&["A"]))
        .unwrap()
        .resolved[0];
    let mut patch = ValueRecord::new();
    patch.insert("color".into(), serde_json::Value::Null);
    patch.insert("name".into(), serde_json::Value::Null);
    store
        .patch_field_values(
            "tags",
            &FieldValuesPatch {
                update: vec![{
                    let mut patch = patch;
                    patch.insert("id".into(), id.into());
                    patch
                }],
                ..Default::default()
            },
        )
        .unwrap();
    let meta = store.value_meta.get("tags").unwrap();
    assert!(!meta[&id].contains_key("color"), "null deletes the key");
    assert_eq!(
        record_name(&meta[&id]),
        Some("A"),
        "identity never goes blank"
    );
}

#[test]
fn patch_field_values_rename_collision_merges_rows_in_one_undoable_edit() {
    // Renaming A to "b" while B exists is a merge: every row carrying A is remapped to
    // B in one edit, A's record goes dark (count 0), and undo restores the rows.
    let mut store = setup_store_with(&[
        loc_with_tags(1, 0.0, 0.0, vec![]),
        loc_with_tags(2, 1.0, 1.0, vec![]),
    ]);
    let ids = store
        .patch_field_values("tags", &creates(&["A", "B"]))
        .unwrap()
        .resolved;
    let (a, b) = (ids[0], ids[1]);
    tag_onto(&mut store, a, &[1, 2]);
    tag_onto(&mut store, b, &[2]);

    let mut patch = ValueRecord::new();
    patch.insert("name".into(), "b".into());
    store
        .patch_field_values(
            "tags",
            &FieldValuesPatch {
                update: vec![{
                    let mut patch = patch;
                    patch.insert("id".into(), a.into());
                    patch
                }],
                ..Default::default()
            },
        )
        .unwrap();

    assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![b]);
    assert_eq!(store.get_loc_by_id(2).unwrap().tags, vec![b]);
    assert_eq!(
        record_name(&store.value_meta.get("tags").unwrap()[&a]),
        Some("A"),
        "the emptied record keeps its name, dark"
    );

    undo_and_finish(&mut store);
    assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![a]);
    assert_eq!(store.get_loc_by_id(2).unwrap().tags, vec![a, b]);
}

#[test]
fn patch_field_values_rejects_a_field_that_does_not_intern() {
    let mut store = setup_store_with(&[]);
    assert!(store
        .patch_field_values("panoId", &FieldValuesPatch::default())
        .is_err());
}

#[test]
fn patch_field_values_rejects_a_nameless_create_seed() {
    let mut store = setup_store_with(&[]);
    assert!(store
        .patch_field_values(
            "tags",
            &FieldValuesPatch {
                create: vec![ValueRecord::new()],
                ..Default::default()
            }
        )
        .is_err());
}

// -----------------------------------------------------------------------
// Tag membership through the generic list op: `tags` is an ordinary array field
// -----------------------------------------------------------------------

/// Put tag `t` onto `ids` through the generic list op, and hand it back.
fn tag_onto(store: &mut Store, t: u32, ids: &[u32]) -> u32 {
    if !ids.is_empty() {
        set_tags(store, &[t], &[], ids);
    }
    t
}

#[test]
fn assigning_a_tag_reports_its_count_in_the_same_mutation() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, 10.1, 20.1)]);
    let feed = FeedCapture::attach(&mut store);

    set_tags(&mut store, &[7], &[], &[1, 2]);

    assert_eq!(tag_count(&mut store, 7), 2);
    for id in [1, 2] {
        assert!(store.get_loc_by_id(id).unwrap().tags.contains(&7));
    }
    assert_eq!(
        shipped_count(&feed.last().derived, "tags", "7"),
        Some(2),
        "the same mutation reports the count to JS"
    );
}

#[test]
fn stripping_the_last_member_reports_a_zero_count() {
    // Count 0 is the signal the frontend derives "this tag has emptied" from, so the
    // mutation that empties a value must say so rather than dropping the entry.
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0)]);
    tag_onto(&mut store, 7, &[1]);
    let feed = FeedCapture::attach(&mut store);

    set_tags(&mut store, &[], &[7], &[1]);

    assert_eq!(tag_count(&mut store, 7), 0);
    assert_eq!(shipped_count(&feed.last().derived, "tags", "7"), Some(0));
}

/// Membership write through the generic field op: `tags` is an ordinary list-valued
/// field, so it goes through the same `ListSet` any `array` field would.
fn set_tags(store: &mut Store, add: &[u32], remove: &[u32], ids: &[u32]) -> Mutation {
    let op = Work::Rows(RowOp::ListSet {
        key: "tags".into(),
        add: add.iter().map(|&i| serde_json::json!(i)).collect(),
        remove: remove.iter().map(|&i| serde_json::json!(i)).collect(),
    });
    let selector = Selector::Locations {
        locations: ids.to_vec(),
        name: None,
    };
    apply_work(store, &selector, &op).unwrap().mutation
}

#[test]
fn set_tags_strips_a_tag_and_drops_its_count() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, 10.1, 20.1)]);
    let t = tag_onto(&mut store, 7, &[1, 2]);
    let feed = FeedCapture::attach(&mut store);

    set_tags(&mut store, &[], &[t], &[1]);

    assert!(store.get_loc_by_id(1).unwrap().tags.is_empty());
    assert_eq!(store.get_loc_by_id(2).unwrap().tags, vec![t]);
    assert_eq!(
        store.fields(["tags"])[0].count(&(t as f64).to_string()),
        1,
        "only the stripped row leaves the tag"
    );
    assert_eq!(shipped_count(&feed.last().derived, "tags", "7"), Some(1));
}

#[test]
fn set_tags_lets_add_win_over_remove_and_never_churns_the_row_that_had_it() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, 10.1, 20.1)]);
    let t = tag_onto(&mut store, 7, &[1]);

    set_tags(&mut store, &[t], &[t], &[1, 2]);

    assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![t]);
    assert_eq!(store.get_loc_by_id(2).unwrap().tags, vec![t], "add wins");
    assert_eq!(store.fields(["tags"])[0].count(&(t as f64).to_string()), 2);

    assert_eq!(
        newest_undo(&store)
            .sides()
            .0
            .iter()
            .map(|l| l.id)
            .collect::<Vec<_>>(),
        vec![2],
        "row 1 already had it, so it is not stripped and re-added"
    );
}

#[test]
fn set_tags_adds_and_removes_in_one_pass() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0)]);
    let old = tag_onto(&mut store, 7, &[1]);
    let new = 8;

    set_tags(&mut store, &[new], &[old], &[1]);

    assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![new]);
    assert_eq!(
        store.fields(["tags"])[0].count(&(old as f64).to_string()),
        0
    );
    assert_eq!(
        store.fields(["tags"])[0].count(&(new as f64).to_string()),
        1
    );
}

#[test]
fn set_tags_records_no_update_for_a_row_already_in_the_requested_state() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0)]);
    let t = tag_onto(&mut store, 7, &[1]);
    let undo_len = store.edits.len(Stack::Undo);

    set_tags(&mut store, &[t], &[], &[1]);

    assert_eq!(
        store.edits.len(Stack::Undo),
        undo_len,
        "no row moved, so no undo entry"
    );
    assert_eq!(
        store.fields(["tags"])[0].count(&(t as f64).to_string()),
        1,
        "and the count is not double-added"
    );
}

#[test]
fn set_tags_undo_restores_membership() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0)]);
    let t = tag_onto(&mut store, 7, &[1]);

    set_tags(&mut store, &[], &[t], &[1]);
    assert!(store.get_loc_by_id(1).unwrap().tags.is_empty());

    undo_and_finish(&mut store);

    assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![t]);
    assert_eq!(tag_count(&mut store, t), 1);
}

// -----------------------------------------------------------------------
// Field indexes: enumerable types get one, nothing else does
// -----------------------------------------------------------------------

/// Ids a selector resolves to, in order.
fn resolved(store: &mut Store, sel: &Selector) -> Vec<u32> {
    store.scope(sel).ids().iter().collect()
}

fn tag_filter(tag_id: u32) -> Selector {
    Selector::Filter {
        field: "tags".into(),
        test: selections::FilterOp::Contains {
            value: serde_json::json!(tag_id),
        },
    }
}

#[test]
fn only_enumerable_types_are_indexable() {
    use crate::store::maps::FieldType;
    assert_eq!(FieldType::Enum.index_shape(), IndexShape::Scalar);
    assert_eq!(FieldType::Boolean.index_shape(), IndexShape::Scalar);
    assert_eq!(FieldType::Array.index_shape(), IndexShape::Multi);
    for t in [
        FieldType::String,
        FieldType::Number,
        FieldType::Date,
        FieldType::Month,
    ] {
        assert_eq!(t.index_shape(), IndexShape::None, "unbounded value space");
    }
}

#[test]
fn tags_is_indexed_because_it_is_an_array_field_not_because_it_is_tags() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, 10.1, 20.1)]);
    let t = tag_onto(&mut store, 7, &[1]);

    assert_eq!(
        store.registry().get("tags").unwrap().index_shape(),
        IndexShape::Multi
    );
    assert_eq!(
        store.registry().get("panoId").unwrap().index_shape(),
        IndexShape::None
    );

    store.scope(&tag_filter(t));
    assert!(store.field_indexes.contains_key("tags"));
    assert!(
        !store.field_indexes.contains_key("panoId"),
        "an unbounded field is never indexed"
    );
}

#[test]
fn an_indexed_filter_agrees_with_the_scan_it_replaces() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, 10.1, 20.1), loc(3, 10.2, 20.2)]);
    let t = tag_onto(&mut store, 7, &[1, 3]);
    let scanned: Vec<u32> = store
        .rows()
        .select(&Selector::tag(t))
        .ids()
        .iter()
        .collect();

    store.scope(&tag_filter(t));

    assert_eq!(resolved(&mut store, &tag_filter(t)), scanned);
    assert_eq!(scanned, vec![1, 3]);
}

#[test]
fn an_index_built_before_an_edit_follows_the_rows_through_it() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, 10.1, 20.1)]);
    let t = tag_onto(&mut store, 7, &[1]);
    // Bake first, or every row sits in the overlay and the postings are never consulted.
    store.bake_overlay();
    store.scope(&tag_filter(t));
    assert_eq!(resolved(&mut store, &tag_filter(t)), vec![1]);

    // A patch adds the tag to a row the postings do not have, and a removal takes away
    // one they do. The mutation path moves the postings with the rows, so the resolve
    // is a clone of the set, not a scan or an overlay re-test.
    set_tags(&mut store, &[t], &[], &[2]);
    let gone = store.get_loc_by_id(1).unwrap();
    undoable(&mut store, vec![gone], Vec::new());

    assert_eq!(
        resolved(&mut store, &tag_filter(t)),
        vec![2],
        "the postings follow every row move"
    );
}

#[test]
fn the_filter_answer_comes_from_the_postings() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, 10.1, 20.1)]);
    let t = tag_onto(&mut store, 7, &[1]);
    store.bake_overlay();
    store.scope(&tag_filter(t));

    // Poison the postings. A resolve that still scanned would be unaffected; this one is
    // not, which is what makes the index load-bearing rather than decorative.
    store
        .field_indexes
        .get_mut("tags")
        .unwrap()
        .by_value
        .insert((t as f64).to_string(), [2u32].into_iter().collect());

    assert_eq!(resolved(&mut store, &tag_filter(t)), vec![2]);
}

#[test]
fn a_range_operator_is_not_an_index_lookup() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0)]);
    let t = tag_onto(&mut store, 7, &[1]);
    store.scope(&tag_filter(t));

    // `tags` is indexed, but `gt` is not a postings lookup: it must still scan, and the
    // scan must still be correct.
    let ranged = Selector::Filter {
        field: "tagCount".into(),
        test: selections::FilterOp::Gt {
            value: serde_json::json!(0),
            tz_local: false,
        },
    };
    assert_eq!(resolved(&mut store, &ranged), vec![1]);
}

fn nothas(field: &str) -> Selector {
    Selector::Filter {
        field: field.into(),
        test: selections::FilterOp::Nothas,
    }
}

/// `has(field)` and `not has(field)` resolved through the store's index, each against the
/// row-by-row answer over the same rows.
fn assert_existence_matches_scan(store: &mut Store, field: &str, holders: &[u32]) {
    for (name, sel) in [("has", Selector::has(field)), ("nothas", nothas(field))] {
        store.scope(&sel);
        assert!(store.field_indexes.contains_key(field), "{name}: indexed");
        let scanned: Vec<u32> = store.all().keep(|r| r.matches(&sel)).iter().collect();
        assert_eq!(resolved(store, &sel), scanned, "{name}");
    }
    assert_eq!(resolved(store, &Selector::has(field)), holders);
}

#[test]
fn existence_answers_from_the_index_rows() {
    let mut store = setup_store_with(&[
        loc_with_extra(1, r#"{"k":1}"#),
        loc_with_extra(2, r#"{"k":2}"#),
    ]);
    store.bake_overlay();
    store.scope(&Selector::has("k"));
    store.field_indexes.get_mut("k").unwrap().rows.remove(2);

    assert_eq!(resolved(&mut store, &Selector::has("k")), vec![1]);
    assert_eq!(resolved(&mut store, &nothas("k")), vec![2]);
}

#[test]
fn an_indexed_existence_filter_agrees_with_the_scan_through_every_edit() {
    let mut store = setup_store_with(&[
        loc_with_extra(1, r#"{"k":1}"#),
        loc_with_extra(2, r#"{"k":2}"#),
        loc_with_extra(3, r#"{"other":1}"#),
    ]);
    store.bake_overlay();
    store.next_id = 10;
    assert_existence_matches_scan(&mut store, "k", &[1, 2]);

    add_rows(&mut store, vec![loc_with_extra(0, r#"{"k":3}"#)]);
    assert_existence_matches_scan(&mut store, "k", &[1, 2, 10]);

    let drop_k = patch!(1; extra: raw_extra(r#"{"k":null}"#));
    apply_updates(&mut store, &[drop_k], &mut None);
    assert_existence_matches_scan(&mut store, "k", &[2, 10]);

    let gain_k = patch!(3; extra: raw_extra(r#"{"k":4}"#));
    apply_updates(&mut store, &[gain_k], &mut None);
    assert_existence_matches_scan(&mut store, "k", &[2, 3, 10]);

    let two = store.get_loc_by_id(2).unwrap();
    undoable(&mut store, vec![two], Vec::new());
    assert_existence_matches_scan(&mut store, "k", &[3, 10]);

    for holders in [&[2, 3, 10][..], &[2, 10], &[1, 2, 10], &[1, 2]] {
        undo_and_finish(&mut store);
        assert_existence_matches_scan(&mut store, "k", holders);
    }
}

/// Coverage of the fields a row's `extra` can hold, leaving out the builtin columns.
fn extra_coverage(store: &mut Store, selector: &Selector) -> Vec<(String, u32)> {
    coverage(store, selector)
        .into_iter()
        .filter(|(k, _)| selections::FieldRegistry::builtins().get(k).is_none())
        .collect()
}

fn counts(pairs: &[(&str, u32)]) -> Vec<(String, u32)> {
    pairs.iter().map(|(k, n)| ((*k).to_string(), *n)).collect()
}

#[test]
fn coverage_follows_the_rows_that_hold_each_field() {
    let mut store = setup_store_with(&[
        loc_with_extra(1, r#"{"a":1,"b":1}"#),
        loc_with_extra(2, r#"{"a":2}"#),
        loc_with_extra(3, r#"{"a":3}"#),
    ]);
    store.bake_overlay();
    for k in ["a", "b"] {
        store.meta.edit().extra.fields.insert(k.into(), def_of(k));
    }
    let all = Selector::Everything;
    assert_eq!(
        extra_coverage(&mut store, &all),
        counts(&[("a", 3), ("b", 1)])
    );

    apply_work(&mut store, &all, &Work::Rows(del_op(&["b"]))).unwrap();
    assert_eq!(extra_coverage(&mut store, &all), counts(&[("a", 3)]));

    let gain_b = patch!(2; extra: raw_extra(r#"{"b":5}"#));
    apply_updates(&mut store, &[gain_b], &mut None);
    assert_eq!(
        extra_coverage(&mut store, &all),
        counts(&[("a", 3), ("b", 1)])
    );

    let two = store.get_loc_by_id(2).unwrap();
    undoable(&mut store, vec![two], Vec::new());
    assert_eq!(extra_coverage(&mut store, &all), counts(&[("a", 2)]));

    undo_and_finish(&mut store);
    assert_eq!(
        extra_coverage(&mut store, &all),
        counts(&[("a", 3), ("b", 1)])
    );

    let some = Selector::Manual {
        locations: vec![2, 3],
    };
    assert_eq!(
        extra_coverage(&mut store, &some),
        counts(&[("a", 2), ("b", 1)])
    );
    let one = Selector::Manual { locations: vec![3] };
    assert_eq!(extra_coverage(&mut store, &one), counts(&[("a", 1)]));
}

/// A store over a committed batch of `base` with `dead` removed and `adds` in the overlay,
/// defining each of `keys`.
fn coverage_store(base: &[Location], adds: Vec<Location>, dead: &[u32], keys: &[&str]) -> Store {
    let mut store = Store::new();
    store.meta = Tracked::new(maps::MapMeta {
        id: "test-coverage".to_string(),
        ..Default::default()
    });
    store.batch = Some(arrow::locations_to_batch(base));
    store.alive_count = Tracked::new(base.len());
    for &id in dead {
        let l = store.get_loc_by_id(id).unwrap();
        store.overlay_remove(slice::from_ref(&l).iter());
    }
    store.overlay_add(adds);
    for k in keys {
        store
            .meta
            .edit()
            .extra
            .fields
            .insert((*k).to_string(), def_of(k));
    }
    store
}

#[test]
fn coverage_counts_rows_per_key_across_the_overlay() {
    let mut store = coverage_store(
        &[
            loc_with_extra(1, r#"{"a":1,"b":2}"#),
            loc_with_extra(2, r#"{"a":1}"#),
            loc_with_extra(3, r#"{"b":2}"#),
        ],
        vec![loc_with_extra(4, r#"{"a":9,"c":{"nested":1}}"#)],
        &[3],
        &["a", "b", "c"],
    );
    assert_eq!(
        coverage(&mut store, &Selector::Everything),
        counts(&[("a", 3), ("b", 1), ("c", 1)])
    );
}

#[test]
fn coverage_counts_an_optional_column_beside_the_extra_keys() {
    let locs = [
        Location {
            pano_id: Some("abc".into()),
            modified_at: Some(7),
            ..loc_with_extra(1, r#"{"a":1}"#)
        },
        loc_with_extra(2, r#"{"a":2}"#),
    ];
    let mut store = coverage_store(&locs, Vec::new(), &[], &["a"]);
    assert_eq!(
        coverage(&mut store, &Selector::Everything),
        counts(&[("a", 2), ("modifiedAt", 1), ("panoId", 1)])
    );
}

#[test]
fn coverage_leaves_out_a_column_every_row_holds() {
    let mut store = coverage_store(&[loc(1, 1.0, 1.0)], Vec::new(), &[], &[]);
    // lat/lng/heading/pitch/zoom always hold a value, so counting them says nothing.
    assert!(coverage(&mut store, &Selector::Everything).is_empty());
}

#[test]
fn coverage_decodes_escaped_base_row_keys() {
    // Blobs baked before key canonicalization can still carry `café` on disk; coverage
    // must report the decoded spelling, matching overlay rows and the field-def registry.
    let mut l = loc(1, 0.0, 0.0);
    l.extra = RawExtra::from_string_uncanonicalized("{\"caf\\u00e9\":1}");
    let mut store = coverage_store(&[l], Vec::new(), &[], &["café"]);
    assert_eq!(
        coverage(&mut store, &Selector::Everything),
        counts(&[("café", 1)])
    );
}

#[test]
fn coverage_does_not_descend_into_nested_objects() {
    let mut store = coverage_store(
        &[loc_with_extra(1, r#"{"outer":{"inner":1}}"#)],
        Vec::new(),
        &[],
        &["outer", "inner"],
    );
    assert_eq!(
        coverage(&mut store, &Selector::Everything),
        counts(&[("outer", 1)])
    );
}

#[test]
fn coverage_honours_a_named_id_list() {
    let mut store = coverage_store(
        &[
            loc_with_extra(1, r#"{"c":"US","d":1}"#),
            loc_with_extra(2, r#"{"c":"FR"}"#),
            loc_with_extra(3, r#"{"c":"FR"}"#),
        ],
        Vec::new(),
        &[],
        &["c", "d"],
    );
    let named = Selector::Locations {
        locations: vec![2, 3],
        name: None,
    };
    assert_eq!(coverage(&mut store, &named), counts(&[("c", 2)]));
}

fn flag_filter(on: bool) -> Selector {
    Selector::Filter {
        field: "loadAsPanoId".into(),
        test: selections::FilterOp::Eq {
            value: serde_json::json!(on),
        },
    }
}

#[test]
fn a_boolean_field_answers_from_the_postings_over_stored_and_overlay_rows() {
    let mut store = setup_store_with(&[
        Location {
            flags: LocationFlags::LOAD_AS_PANO_ID,
            ..loc(1, 10.0, 20.0)
        },
        loc(2, 10.1, 20.1),
    ]);
    store.bake_overlay();
    store.overlay_add(vec![
        Location {
            flags: LocationFlags::LOAD_AS_PANO_ID,
            ..loc(3, 10.2, 20.2)
        },
        loc(4, 10.3, 20.3),
    ]);
    store.scope(&flag_filter(true));

    assert_eq!(
        store.registry().get("loadAsPanoId").unwrap().index_shape(),
        IndexShape::Scalar
    );
    assert_eq!(store.fields(["loadAsPanoId"])[0].count("true"), 2);
    assert_eq!(resolved(&mut store, &flag_filter(true)), vec![1, 3]);
    assert_eq!(resolved(&mut store, &flag_filter(false)), vec![2, 4]);
}

// -----------------------------------------------------------------------
// Selection bitmask: partial cell invariants
// -----------------------------------------------------------------------

fn add_tag_selection(store: &mut Store, tag_id: u32, color: [u8; 3]) {
    edit_selection_fixture(store, |rows| {
        rows.push(ListedSelection {
            selection: Selection {
                key: format!("tag:{tag_id}"),
                color,
                selector: Selector::tag(tag_id),
            },
            ghosted: false,
        })
    });
}

#[test]
fn a_ghosted_selection_is_recounted_by_a_mutation_but_never_selected_or_drawn() {
    let l1 = loc_with_tags(1, 10.0, 20.0, vec![]);
    let mut store = setup_store_with(slice::from_ref(&l1));
    insert_tag(&mut store, 1, 0);
    insert_tag(&mut store, 2, 0);
    add_tag_selection(&mut store, 1, [255, 0, 0]);
    edit_selection_fixture(&mut store, |rows| rows[0].ghosted = true);
    add_tag_selection(&mut store, 2, [0, 255, 0]);

    let after = loc_with_tags(1, 10.0, 20.0, vec![1, 2]);
    let frames = watch(&mut store);
    let feed = FeedCapture::attach(&mut store);
    let result = store.finish_mutation(&Change {
        updated: vec![(l1, after)],
        ..Default::default()
    });

    let _ = result;
    let counts = feed
        .last()
        .derived
        .selection_counts
        .expect("a mutation recounts");
    assert_eq!(counts["tag:1"], 1, "the ghosted selection is counted");
    assert_eq!(counts["tag:2"], 1);
    assert_eq!(
        store.selections.ids.len(),
        1,
        "only the live selection selects"
    );
    let frame = frames.last();
    assert_eq!(
        patched(&frame.cells)[0].sel,
        0,
        "the paint index counts live selections only"
    );
    assert_eq!(
        frame.palette,
        [[0, 255, 0]],
        "the palette holds live selections only"
    );
}

#[test]
fn a_full_resolve_counts_a_ghosted_selection_and_keeps_it_out_of_the_selected_set() {
    let mut store = setup_store_with(&[loc_with_tags(1, 10.0, 20.0, vec![1, 2])]);
    add_tag_selection(&mut store, 1, [255, 0, 0]);
    edit_selection_fixture(&mut store, |rows| rows[0].ghosted = true);
    add_tag_selection(&mut store, 2, [0, 255, 0]);

    store.resolve_selection_membership();

    assert_eq!(store.selections.node_counts["tag:1"], 1);
    assert_eq!(store.selections.node_counts["tag:2"], 1);
    assert!(
        store.selections.list()[0].ghosted,
        "a full resolve keeps the flag"
    );
    assert_eq!(
        store.selections.ids.len(),
        1,
        "only the live selection selects"
    );
    assert_eq!(
        u32::from_le_bytes(store.selection_section()[0..4].try_into().unwrap()),
        1,
        "the bitmask carries live selections only"
    );
}

/// Parse the binary bitmask and return the cell chars it contains.
fn bitmask_cell_chars(buf: &[u8]) -> Vec<char> {
    if buf.is_empty() {
        return vec![];
    }
    let num_sels = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    let mut off = 4 + num_sels * 3;
    let num_cells = buf[off] as usize;
    off += 1;
    let mut chars = Vec::new();
    for _ in 0..num_cells {
        chars.push(buf[off] as char);
        off += 1;
        let loc_count = u32::from_le_bytes(buf[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        let mask_bytes = loc_count.div_ceil(8);
        for _ in 0..num_sels {
            let fmt = buf[off];
            off += 1;
            if fmt == 1 {
                let count = u32::from_le_bytes(buf[off..off + 4].try_into().unwrap()) as usize;
                off += 4 + count * 4;
            } else {
                off += mask_bytes;
            }
        }
    }
    chars
}

/// Add `count` extra rows carrying tag `id`, so selection resolution can see it.
fn insert_tag(store: &mut Store, id: u32, count: usize) {
    let locs: Vec<Location> = (0..count)
        .map(|i| loc_with_tags(10_000 + id * 100 + i as u32, 0.0, 0.0, vec![id]))
        .collect();
    store.overlay_add(locs);
}

#[test]
fn incremental_membership_change_ships_no_bitmask() {
    let l1 = loc_with_tags(1, 10.0, 20.0, vec![]);
    let mut store = setup_store_with(slice::from_ref(&l1));
    insert_tag(&mut store, 1, 0);
    add_tag_selection(&mut store, 1, [255, 0, 0]);
    let frames = watch(&mut store);
    let feed = FeedCapture::attach(&mut store);

    let result = store.finish_mutation(&Change {
        updated: vec![(l1, loc_with_tags(1, 10.0, 20.0, vec![1]))],
        ..Default::default()
    });

    let _ = result;
    assert!(
        feed.last().derived.selection_counts.is_some(),
        "counts still sync"
    );
    assert_eq!(store.selections.ids.len(), 1);
    let frame = frames.last();
    assert_eq!(
        frame.selection, None,
        "the incremental path carries membership on the rows, not a bitmask"
    );
    let rows = patched(&frame.cells);
    assert_eq!(
        rows.len(),
        1,
        "membership rides on a patch for the row that changed"
    );
    assert_eq!(rows[0].sel, 0);
    assert_eq!(frame.palette, [[255, 0, 0]]);
}

#[test]
fn full_resolve_ships_a_bitmask_for_every_cell() {
    // Two locations in different geohash cells, both tagged.
    let l1 = loc_with_tags(1, 10.0, 20.0, vec![1]);
    let l2 = loc_with_tags(2, -30.0, -40.0, vec![1]);
    assert_ne!(
        render_cell_idx(10.0, 20.0),
        render_cell_idx(-30.0, -40.0),
        "test requires locations in different cells"
    );
    let mut store = setup_store_with(&[l1.clone(), l2.clone()]);
    insert_tag(&mut store, 1, 2);
    add_tag_selection(&mut store, 1, [255, 0, 0]);

    // More than 100 rows in one change forces the full-resolve branch, all of them in l1's cell.
    let changes = apply_edit(
        &mut store,
        Vec::new(),
        (3..=103).map(|id| loc(id, 10.0, 20.0)).collect(),
    );
    let frames = watch(&mut store);
    store.finish_mutation(&changes);

    let buf = frames
        .last()
        .selection
        .expect("full resolve rebuilds the whole bitmask");
    assert_eq!(
        bitmask_cell_chars(&buf).len(),
        2,
        "a full resolve covers every non-empty cell, not just changed ones"
    );
}

#[test]
fn membership_delta_reports_gained_on_tag_add() {
    let l1 = loc_with_tags(1, 10.0, 20.0, vec![]);
    let mut store = setup_store_with(slice::from_ref(&l1));
    add_tag_selection(&mut store, 1, [255, 0, 0]);

    // Add tag 1 to location 1
    let with_tag = loc_with_tags(1, 10.0, 20.0, vec![1]);
    let frames = watch(&mut store);
    store.finish_mutation(&Change {
        updated: vec![(l1, with_tag)],
        ..Default::default()
    });

    // The row gained a selection without moving, so it ships as a patch restating it.
    let frame = frames.last();
    let p = *patched(&frame.cells)
        .iter()
        .find(|p| p.sel != NO_SEL)
        .expect("a row that joins a selection must state it");
    assert_eq!(
        frame.palette[p.sel as usize],
        [255, 0, 0],
        "the selection colour"
    );
    assert_eq!(
        (p.lng, p.lat, p.angle),
        (20.0, 10.0, 0.0),
        "nothing moved, so the patch restates where the row already is"
    );
}

#[test]
fn membership_delta_reports_lost_on_tag_remove() {
    let tagged = loc_with_tags(1, 10.0, 20.0, vec![1]);
    let mut store = setup_store_with(slice::from_ref(&tagged));
    insert_tag(&mut store, 1, 1);
    add_tag_selection(&mut store, 1, [255, 0, 0]);
    store.resolve_selection_membership();
    assert!(store.selections.ids.contains(1), "starts selected");

    let untagged = loc_with_tags(1, 10.0, 20.0, vec![]);
    let frames = watch(&mut store);
    store.finish_mutation(&Change {
        updated: vec![(tagged, untagged)],
        ..Default::default()
    });

    assert!(!store.selections.ids.contains(1), "left the selection");
    let rows = patched(&frames.last().cells);
    assert_eq!(
        rows.len(),
        1,
        "a row that leaves a selection must be restored to the base layer"
    );
    assert_eq!(
        rows[0].sel, NO_SEL,
        "no selection, so the base layer draws it again"
    );
}

#[test]
fn selected_leaf_tracks_the_selection_through_mutations() {
    let tagged = loc_with_tags(1, 10.0, 20.0, vec![1]);
    let other = loc_with_tags(2, 11.0, 21.0, vec![]);
    let mut store = setup_store_with(&[tagged.clone(), other]);
    insert_tag(&mut store, 1, 0);
    add_tag_selection(&mut store, 1, [255, 0, 0]);
    store.resolve_selection_membership();
    assert_eq!(store.selections.ids, [1u32].into_iter().collect());

    assert_eq!(
        store.scope(&Selector::Selected).ids(),
        store.selections.ids,
        "resolves to the synced set"
    );

    let untagged = loc_with_tags(1, 10.0, 20.0, vec![]);
    store.finish_mutation(&Change {
        updated: vec![(tagged, untagged)],
        ..Default::default()
    });
    assert_eq!(
        store.scope(&Selector::Selected).ids(),
        store.selections.ids,
        "a mutation's recount is visible without a re-sync"
    );
    assert_eq!(store.selections.ids, RoaringBitmap::new());
}

#[test]
fn removed_selected_location_leaves_no_patch() {
    // A deleted row has no cell left to patch; the page drops it from the overlay with
    // its removal, so emitting a patch for it would dangle.
    let l1 = loc_with_tags(1, 10.0, 20.0, vec![1]);
    let l2 = loc_with_tags(2, 10.001, 20.001, vec![1]);
    let mut store = setup_store_with(&[l1, l2]);
    insert_tag(&mut store, 1, 2);
    add_tag_selection(&mut store, 1, [255, 0, 0]);
    store.resolve_selection_membership();

    let frames = watch(&mut store);
    store.finish_mutation(&Change {
        removed: vec![loc_with_tags(1, 10.0, 20.0, vec![1])],
        ..Default::default()
    });

    let frame = frames.last();
    assert!(
        patched(&frame.cells).is_empty(),
        "no patch for a row that no longer has a cell"
    );
    assert_eq!(
        removed(&frame.cells),
        [(render_cell_idx(10.0, 20.0), 0)],
        "the removal itself is what drops it from the overlay"
    );
    assert!(!store.selections.ids.contains(1));
}

#[test]
fn leaving_winning_selection_restates_survivors_paint() {
    // A row in two overlapping selections is painted by the later one. Editing it out of
    // the winner — without moving it — must ship a patch stating the survivor's paint:
    // union membership never flips here, so this is exactly the case a union-flip test
    // misses and the overlay would keep the dead winner's colour until a full resolve.
    let both = loc_with_tags(1, 10.0, 20.0, vec![1, 2]);
    let mut store = setup_store_with(slice::from_ref(&both));
    insert_tag(&mut store, 1, 1);
    insert_tag(&mut store, 2, 1);
    add_tag_selection(&mut store, 1, [255, 0, 0]);
    add_tag_selection(&mut store, 2, [0, 0, 255]);
    store.resolve_selection_membership();
    assert_eq!(
        store.selections.paint_for(1),
        Some(1),
        "the later selection wins while the row is in both"
    );

    let only_first = loc_with_tags(1, 10.0, 20.0, vec![1]);
    let frames = watch(&mut store);
    store.finish_mutation(&Change {
        updated: vec![(both, only_first)],
        ..Default::default()
    });

    let frame = frames.last();
    let rows = patched(&frame.cells);
    assert_eq!(
        rows.len(),
        1,
        "leaving the winner while staying selected must still ship a patch"
    );
    assert_eq!(rows[0].sel, 0, "the surviving selection's paint");
    assert_eq!(frame.palette[0], [255, 0, 0]);
    assert_eq!(
        (rows[0].lng, rows[0].lat),
        (20.0, 10.0),
        "nothing moved, so the patch restates where the row already is"
    );
}

#[test]
fn membership_delta_no_patch_when_nothing_changed() {
    let l1 = loc_with_tags(1, 10.0, 20.0, vec![1]);
    let mut store = setup_store_with(slice::from_ref(&l1));
    add_tag_selection(&mut store, 1, [255, 0, 0]);
    // Resolve initial membership
    store.resolve_selection_membership();

    // Update heading only — selection membership doesn't change
    let updated = Location {
        heading: 90.0,
        ..l1.clone()
    };
    let frames = watch(&mut store);
    store.finish_mutation(&Change {
        updated: vec![(l1, updated)],
        ..Default::default()
    });

    // The heading moved, so a patch ships — but it restates the unchanged selection.
    let rows = patched(&frames.last().cells);
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].sel, 0,
        "a patch always states the row's current selection state"
    );
}

#[test]
fn selected_row_moving_across_cells_keeps_its_selection() {
    // A cross-cell move leaves the old cell and joins the new one in the same frame, and
    // the add restates the row's selection, so its overlay entry follows it.
    let l1 = loc_with_tags(1, 10.0, 20.0, vec![1]);
    let mut store = setup_store_with(slice::from_ref(&l1));
    insert_tag(&mut store, 1, 1);
    add_tag_selection(&mut store, 1, [255, 0, 0]);
    store.resolve_selection_membership();
    assert!(store.selections.ids.contains(1), "starts selected");

    let moved = Location {
        lat: -30.0,
        lng: -40.0,
        ..l1.clone()
    };
    assert_ne!(
        render_cell_idx(10.0, 20.0),
        render_cell_idx(-30.0, -40.0),
        "test requires a cross-cell move"
    );
    let frames = watch(&mut store);
    store.finish_mutation(&Change {
        updated: vec![(l1, moved)],
        ..Default::default()
    });

    let frame = frames.last();
    assert_eq!(
        removed(&frame.cells),
        [(render_cell_idx(10.0, 20.0), 0)],
        "the old cell loses the row"
    );
    let row = *added(&frame.cells)
        .iter()
        .find(|r| r.key == 1)
        .expect("re-added in the new cell");
    assert_eq!(row.cell, render_cell_idx(-30.0, -40.0));
    assert_eq!(row.sel, 0, "still selected");
}

// -----------------------------------------------------------------------
// merge_group (duplicate merge policy)
// -----------------------------------------------------------------------

fn loc_full(id: u32, tags: Vec<u32>, created_at: u32) -> Location {
    Location {
        tags,
        created_at,
        ..loc(id, 0.0, 0.0)
    }
}

#[test]
fn merge_group_survivor_is_most_tags() {
    let a = loc_full(1, vec![1], 2020);
    let b = loc_full(2, vec![1, 2, 3], 2021);
    let s = merge_group(
        selections::FieldRegistry::builtins(),
        &[a, b],
        &default_score(),
    );
    assert_eq!(s.id, 2);
    assert_eq!(s.tags, vec![1, 2, 3]);
}

#[test]
fn merge_group_tie_breaks_on_earliest_created() {
    let a = loc_full(1, vec![1], 2021);
    let b = loc_full(2, vec![9], 2019); // fewer-tag tie, but earlier
    let s = merge_group(
        selections::FieldRegistry::builtins(),
        &[a, b],
        &default_score(),
    );
    assert_eq!(s.id, 2);
}

#[test]
fn merge_group_tie_breaks_on_lowest_id() {
    let a = loc_full(5, vec![1], 2020);
    let b = loc_full(2, vec![9], 2020); // same tags+created, lower id
    let s = merge_group(
        selections::FieldRegistry::builtins(),
        &[a, b],
        &default_score(),
    );
    assert_eq!(s.id, 2);
}

#[test]
fn merge_group_unions_and_dedupes_tags() {
    let a = loc_full(1, vec![1, 2], 2020);
    let b = loc_full(2, vec![2, 3], 2020);
    let s = merge_group(
        selections::FieldRegistry::builtins(),
        &[a, b],
        &default_score(),
    );
    assert_eq!(s.tags, vec![1, 2, 3]);
}

#[test]
fn merge_group_extra_survivor_wins_and_unions_keys() {
    let mut a = loc_full(1, vec![1, 2], 2020); // survivor (most tags)
    a.extra = Some(serde_json::from_str(r#"{"k":"survivor"}"#).unwrap());
    let mut b = loc_full(2, vec![3], 2020);
    b.extra = Some(serde_json::from_str(r#"{"k":"other","x":"y"}"#).unwrap());
    let s = merge_group(
        selections::FieldRegistry::builtins(),
        &[a, b],
        &default_score(),
    );
    let extra = s.extra.unwrap();
    assert_eq!(extra.get("k").unwrap(), "survivor"); // conflict -> survivor wins
    assert_eq!(extra.get("x").unwrap(), "y"); // non-conflicting key from other is kept
}

fn score_expr(src: &str) -> Expr {
    field_expr::parse(src).expect("test expression parses")
}

/// What a map with no duplicate preference of its own ranks by.
fn default_score() -> Expr {
    selections::parse_duplicate_score(None).expect("default expression parses")
}

#[test]
fn merge_group_default_scores_more_than_tag_count() {
    // A finished location beats a bare one carrying more tags.
    let mut finished = loc_full(1, vec![7], 2020);
    finished.pano_id = Some("p".into());
    finished.flags = LocationFlags::LOAD_AS_PANO_ID;
    finished.heading = 90.0;
    let bare = loc_full(2, vec![1, 2, 3], 2021);
    let group = [finished, bare];
    assert_eq!(
        merge_group(
            selections::FieldRegistry::builtins(),
            &group,
            &default_score()
        )
        .id,
        1
    );
    assert_eq!(
        merge_group(
            selections::FieldRegistry::builtins(),
            &group,
            &score_expr("tagCount")
        )
        .id,
        2
    );
}

#[test]
fn merge_group_score_expression_replaces_tag_count() {
    let a = loc_full(1, vec![1, 2, 3], 2020);
    let b = loc_full(2, vec![], 2021);
    let s = merge_group(
        selections::FieldRegistry::builtins(),
        &[a, b],
        &score_expr("id"),
    );
    assert_eq!(s.id, 2); // highest id wins despite having no tags at all
}

#[test]
fn merge_group_score_ties_still_fall_to_created_then_id() {
    let a = loc_full(1, vec![1], 2021);
    let b = loc_full(2, vec![9], 2019);
    let s = merge_group(
        selections::FieldRegistry::builtins(),
        &[a, b],
        &score_expr("1"),
    );
    assert_eq!(s.id, 2); // only the earlier created_at explains this: a has the lower id
}

#[test]
fn merge_group_unscorable_member_ranks_below_a_scored_one() {
    let a = loc_full(1, vec![1, 2, 3], 2019); // wins on every built-in key
    let mut b = loc_full(2, vec![], 2021);
    b.extra = Some(serde_json::from_str(r#"{"q":1}"#).unwrap());
    let s = merge_group(
        selections::FieldRegistry::builtins(),
        &[a, b],
        &score_expr("q"),
    );
    assert_eq!(s.id, 2);
}

#[test]
fn merge_group_applies_and_undo_restores() {
    let a = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let b = loc_with_tags(2, 0.0, 0.0, vec![20]);
    let mut store = setup_store_with(&[a.clone(), b.clone()]);
    assert_eq!(*store.alive_count, 2);

    let members = vec![a.clone(), b.clone()];
    let survivor = merge_group(
        selections::FieldRegistry::builtins(),
        &members,
        &default_score(),
    );
    assert_eq!(survivor.id, 1); // tie on tags+created -> lowest id survives
    let entry = Change::from_sides(vec![survivor], members);

    forward(&mut store, &entry);
    assert_eq!(*store.alive_count, 1);
    assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![10, 20]);
    assert!(store.get_loc_by_id(2).is_none());

    reverse(&mut store, &entry);
    assert_eq!(*store.alive_count, 2);
    assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![10]);
    assert_eq!(store.get_loc_by_id(2).unwrap().tags, vec![20]);
}

#[test]
fn selection_cell_segment_adapts_format() {
    use roaring::RoaringBitmap;
    use std::collections::HashMap;

    // N large enough that a one-element index-list (8 bytes) beats the dense mask.
    let n = 800usize;
    let mut cells: [Option<CellRender>; 32] = array::from_fn(|_| None);
    cells[0] = Some(CellRender {
        id_order: (0..n as u32).collect(),
        id_to_index: (0..n as u32)
            .map(|i| (i, i as usize))
            .collect::<HashMap<_, _>>(),
    });
    let render = RenderState {
        cells,
        id_to_cell_idx: vec![0u8; n],
        arrow_style: false,
        marker_color: [42, 42, 42],
    };
    let cr = render.cells[0].as_ref().unwrap();
    // header = 1 base32 byte + 4-byte loc count; per selection a format byte follows.
    let parse_header = |seg: &[u8]| u32::from_le_bytes(seg[1..5].try_into().unwrap());

    // Sparse (one selected id) -> routed member-walk -> index-list (format byte 1).
    let mut sparse = RoaringBitmap::new();
    sparse.insert(5);
    let routed = vec![selection_cell_indices(&render, render.total_len(), &sparse)];
    let seg = serialize_cell_segment(0, cr, &routed);
    assert_eq!(parse_header(&seg), n as u32);
    assert_eq!(
        seg[5], 1,
        "sparse selection should use the index-list format"
    );
    assert_eq!(
        u32::from_le_bytes(seg[6..10].try_into().unwrap()),
        1,
        "one selected index"
    );
    assert_eq!(
        u32::from_le_bytes(seg[10..14].try_into().unwrap()),
        5,
        "local index of id 5"
    );

    // Dense (select all) -> cell scan -> bitmask (format byte 0), all bits set.
    let dense: RoaringBitmap = (0..n as u32).collect();
    let routed = vec![selection_cell_indices(&render, render.total_len(), &dense)];
    let seg = serialize_cell_segment(0, cr, &routed);
    let mask_bytes = n.div_ceil(8);
    assert_eq!(seg[5], 0, "select-all should use the dense bitmask format");
    assert_eq!(seg.len(), 5 + 1 + mask_bytes);
    assert!(seg[6..].iter().all(|&b| b == 0xFF), "every bit set");

    // Ids in no render cell route nowhere rather than panicking.
    let mut absent = RoaringBitmap::new();
    absent.insert(n as u32 + 10);
    let routed = selection_cell_indices(&render, render.total_len(), &absent);
    assert!(routed.iter().all(Vec::is_empty));
}

// -----------------------------------------------------------------------
// next_id vs undo/redo resurrection (duplicate-id bake panic)
// -----------------------------------------------------------------------

#[test]
fn stored_history_max_id_spans_both_sides_of_every_edit() {
    let mut store = setup_store_with(&[]);
    for (created, removed) in [
        (vec![loc(3, 0.0, 0.0)], vec![]),
        (vec![], vec![loc(112, 0.0, 0.0)]),
        (vec![loc(7, 0.0, 0.0)], vec![loc(9, 0.0, 0.0)]),
    ] {
        store
            .edits
            .edit()
            .record(Arc::new(entry(Change::from_sides(created, removed))));
    }
    with_history_db(|conn| {
        assert_eq!(stored_history_max_id(conn, "m").unwrap(), 0);
        save_edit_history(conn, "m", &store.edits).unwrap();
        assert_eq!(stored_history_max_id(conn, "m").unwrap(), 112);
    });
}

thread_local! {
    static HISTORY_DB: rusqlite::Connection = {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::store::storage::run_migrations_on(&conn).unwrap();
        conn.execute(
            "INSERT INTO maps (id, name, settings, created_at, updated_at) VALUES ('m', '', '{}', '', '')",
            [],
        )
        .unwrap();
        conn
    };
}

/// This test's own history database, holding map `m`.
fn with_history_db<R>(f: impl FnOnce(&rusqlite::Connection) -> R) -> R {
    HISTORY_DB.with(f)
}

fn fetch_stored(seq: u64) -> AppResult<Entry> {
    with_history_db(|conn| load_edit(conn, "m", seq))
}

// Simulate "close map" (store_close_map + save_edit_history) and "reopen"
// (store_open_map's delta/history load + next_id seeding) at the Store level,
// through the same delta bytes and history rows the app writes.
fn close_and_reopen(store: &Store) -> Store {
    with_history_db(|conn| save_edit_history(conn, "m", &store.edits).unwrap());
    reopen(store, &sidecar_bytes(store))
}

// store_open_map from `delta_bytes` and whatever history the database holds.
fn reopen(store: &Store, delta_bytes: &[u8]) -> Store {
    let (edits, history_max) = with_history_db(|conn| {
        (
            load_edit_history(conn, "m").unwrap(),
            stored_history_max_id(conn, "m").unwrap(),
        )
    });
    let delta = Overlay::from_delta(&arrow::read_arrow_ipc_bytes(delta_bytes).unwrap());

    let mut reopened = Store::new();
    reopened.meta = Tracked::new((*store.meta).clone());
    reopened.batch = Some(empty_batch());
    reopened.overlay = Tracked::unsaved(delta);
    reopened.next_id = seed_next_id(0, &reopened.overlay.adds, history_max);
    reopened.alive_count = Tracked::new(reopened.overlay.adds.len());
    reopened.edits = Tracked::new(edits);
    reopened
}

// Allocate an id and add a row through the store write path.
fn click_add(store: &mut Store, lat: f64, lng: f64) -> u32 {
    let id = store.alloc_id();
    let l = loc(id, lat, lng);
    store
        .edits
        .edit()
        .record(Arc::new(entry(Change::from_sides(vec![l.clone()], vec![]))));
    store.overlay_add(vec![l]);
    id
}

// Remove a row through the store write path.
fn delete_loc(store: &mut Store, id: u32) {
    let l = store.get_loc_by_id(id).unwrap();
    store
        .edits
        .edit()
        .record(Arc::new(entry(Change::from_sides(vec![], vec![l.clone()]))));
    store.overlay_remove(slice::from_ref(&l).iter());
}

// Replay undo or redo through the store history.
fn press_undo(store: &mut Store) {
    store.step(Stack::Undo, fetch_stored).unwrap().unwrap();
}

fn press_redo(store: &mut Store) {
    store.step(Stack::Redo, fetch_stored).unwrap().unwrap();
}

fn undo_and_finish(store: &mut Store) {
    let changes = store.step(Stack::Undo, fetch_stored).unwrap().unwrap();
    store.finish_entry(&changes);
}

/// The count `derived` shipped for one value of `field`: `None` when it did not ship the
/// value, `Some(0)` when the value is gone.
pub(crate) fn shipped_count(d: &Derived, field: &str, key: &str) -> Option<usize> {
    let v = d.field_values.as_ref()?.get(field)?.get(key)?;
    Some(v.as_ref().map_or(0, |v| v.count))
}

/// The record `derived` shipped for one interned value of `field`.
pub(crate) fn shipped_record(d: &Derived, field: &str, id: u32) -> Option<ValueRecord> {
    let v = d.field_values.as_ref()?.get(field)?.get(&id.to_string())?;
    v.as_ref()?.record.clone()
}

/// The change events one window received, decoded.
#[derive(Clone, Default)]
pub(crate) struct FeedCapture(Arc<Mutex<Vec<ChangeEvent>>>);

impl FeedCapture {
    pub(crate) fn attach(store: &mut Store) -> Self {
        let cap = Self::default();
        let got = cap.0.clone();
        store.changes.insert(
            "feed".into(),
            tauri::ipc::Channel::new(move |body| {
                let tauri::ipc::InvokeResponseBody::Json(s) = body else {
                    panic!("change events travel as json");
                };
                got.lock().unwrap().push(serde_json::from_str(&s).unwrap());
                Ok(())
            }),
        );
        cap
    }

    pub(crate) fn last(&self) -> ChangeEvent {
        self.0
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("a change event was sent")
    }

    pub(crate) fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }

    pub(crate) fn all(&self) -> Vec<ChangeEvent> {
        self.0.lock().unwrap().clone()
    }
}

fn newest_undo(store: &Store) -> Change {
    let (_, edit) = store
        .edits
        .iter()
        .filter(|(s, _)| *s == Stack::Undo)
        .last()
        .unwrap();
    edit.entry
        .as_deref()
        .cloned()
        .unwrap_or_else(|| fetch_stored(edit.seq).unwrap())
        .rows
}

fn stack_ids(store: &Store, stack: Stack) -> Vec<(u64, Vec<u32>)> {
    store
        .edits
        .iter()
        .filter(|(s, _)| *s == stack)
        .map(|(_, e)| {
            let entry = e
                .entry
                .as_deref()
                .cloned()
                .unwrap_or_else(|| fetch_stored(e.seq).unwrap());
            (e.seq, entry.rows.sides().0.iter().map(|l| l.id).collect())
        })
        .collect()
}

#[test]
fn history_survives_repeated_close_and_reopen_in_stack_order() {
    let mut store = setup_store_with(&[]);
    for i in 0..5 {
        click_add(&mut store, f64::from(i), 0.0);
    }
    press_undo(&mut store);
    press_undo(&mut store);
    let mut store = close_and_reopen(&store);
    press_redo(&mut store);
    let store = close_and_reopen(&store);

    let undo = stack_ids(&store, Stack::Undo);
    assert_eq!(
        undo.iter().map(|(seq, _)| *seq).collect::<Vec<_>>(),
        vec![0, 1, 2, 3]
    );
    assert_eq!(
        stack_ids(&store, Stack::Redo),
        vec![(4, vec![5])],
        "the one edit still undone is on top of redo"
    );
    assert_eq!(
        with_history_db(|conn| stored_history_max_id(conn, "m").unwrap()),
        5
    );
}

// store_save_dirty, through the same snapshot and write.
fn autosave(store: &mut Store, delta: &Path) {
    let unsaved = store.unsaved().unwrap().unwrap();
    with_history_db(|conn| unsaved.write(conn, "m", delta).unwrap());
    store.saved(&unsaved);
}

fn live_ids(store: &mut Store) -> Vec<u32> {
    let mut ids: Vec<u32> = store
        .collect(&crate::store::engine::Target::Map, &Selector::Everything)
        .iter()
        .map(|l| l.id)
        .collect();
    ids.sort_unstable();
    ids
}

#[test]
fn a_kill_reopens_to_the_last_autosave_with_history_that_matches_it() {
    let dir = TempDir::new("mma_test_kill_after_autosave");
    let delta = dir.join("m_delta.bin");
    let mut store = setup_store_with(&[]);
    for i in 0..4 {
        click_add(&mut store, f64::from(i), 0.0);
    }
    press_undo(&mut store);
    autosave(&mut store, &delta);
    let (ids, undo, redo) = (
        live_ids(&mut store),
        stack_ids(&store, Stack::Undo),
        stack_ids(&store, Stack::Redo),
    );
    click_add(&mut store, 9.0, 0.0);

    let mut store = reopen(&store, &fs::read(&delta).unwrap());
    assert_eq!(live_ids(&mut store), ids);
    assert_eq!(stack_ids(&store, Stack::Undo), undo);
    assert_eq!(stack_ids(&store, Stack::Redo), redo);

    press_redo(&mut store);
    assert_eq!(live_ids(&mut store), vec![1, 2, 3, 4]);
    for _ in 0..4 {
        press_undo(&mut store);
    }
    assert_eq!(live_ids(&mut store), Vec::<u32>::new());
}

#[test]
fn an_autosave_writes_a_history_change_that_moved_no_location() {
    let dir = TempDir::new("mma_test_history_only_autosave");
    let delta = dir.join("m_delta.bin");
    let mut store = setup_store_with(&[]);
    click_add(&mut store, 0.0, 0.0);
    autosave(&mut store, &delta);

    store.edits.edit().clear();
    autosave(&mut store, &delta);
    assert!(store.unsaved().unwrap().is_none());

    let mut store = reopen(&store, &fs::read(&delta).unwrap());
    assert_eq!(live_ids(&mut store), vec![1]);
    assert_eq!(
        (store.edits.len(Stack::Undo), store.edits.len(Stack::Redo)),
        (0, 0)
    );
}

#[test]
fn a_reopened_history_reads_no_edit_until_undo_reaches_it() {
    let mut store = setup_store_with(&[]);
    for i in 0..3 {
        click_add(&mut store, f64::from(i), 0.0);
    }
    let mut store = close_and_reopen(&store);
    assert!(store.edits.iter().all(|(_, e)| e.entry.is_none()));

    press_undo(&mut store);
    let read: Vec<u64> = store
        .edits
        .iter()
        .filter(|(_, e)| e.entry.is_some())
        .map(|(_, e)| e.seq)
        .collect();
    assert_eq!(read, vec![2], "only the undone edit was read");
}

fn page(store: &mut Store, group: &mut Option<u64>, id: u32, heading: f64) {
    let updates = [patch!(id; heading: heading)];
    apply_updates(store, &updates, group);
}

#[test]
fn a_grouped_run_undoes_as_one_step() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 1.0, 0.0)]);
    let mut group = None;
    page(&mut store, &mut group, 1, 90.0);
    page(&mut store, &mut group, 2, 180.0);

    assert_eq!(store.edits.len(Stack::Undo), 1);
    undo_and_finish(&mut store);
    assert_eq!(store.get_loc_by_id(1).unwrap().heading, 0.0);
    assert_eq!(store.get_loc_by_id(2).unwrap().heading, 0.0);
}

#[test]
fn a_row_a_run_touches_twice_undoes_to_its_state_before_the_run() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    let mut group = None;
    page(&mut store, &mut group, 1, 90.0);
    page(&mut store, &mut group, 1, 180.0);

    assert_eq!(store.get_loc_by_id(1).unwrap().heading, 180.0);
    undo_and_finish(&mut store);
    assert_eq!(store.get_loc_by_id(1).unwrap().heading, 0.0);
    press_redo(&mut store);
    assert_eq!(store.get_loc_by_id(1).unwrap().heading, 180.0);
}

#[test]
fn a_later_change_joins_the_step_a_result_names_while_it_is_the_newest() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    apply_updates(&mut store, &[patch!(1; heading: 90.0)], &mut None);
    let mut join = store
        .edits
        .iter()
        .filter(|(stack, _)| *stack == Stack::Undo)
        .last()
        .map(|(_, e)| e.seq);
    assert!(join.is_some(), "a recorded change names its step");
    page(&mut store, &mut join, 1, 180.0);

    assert_eq!(store.edits.len(Stack::Undo), 1);
    undo_and_finish(&mut store);
    assert_eq!(store.get_loc_by_id(1).unwrap().heading, 0.0);
}

#[test]
fn an_edit_between_pages_splits_the_group() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 1.0, 0.0)]);
    let mut group = None;
    page(&mut store, &mut group, 1, 90.0);
    let user_edit = [patch!(2; heading: 45.0)];
    apply_updates(&mut store, &user_edit, &mut None);
    page(&mut store, &mut group, 1, 180.0);

    assert_eq!(store.edits.len(Stack::Undo), 3);
    undo_and_finish(&mut store);
    assert_eq!(
        store.get_loc_by_id(1).unwrap().heading,
        90.0,
        "the page after the user edit undoes alone"
    );
    undo_and_finish(&mut store);
    assert_eq!(store.get_loc_by_id(2).unwrap().heading, 0.0);
    undo_and_finish(&mut store);
    assert_eq!(store.get_loc_by_id(1).unwrap().heading, 0.0);
}

#[test]
fn an_undo_mid_run_leaves_later_pages_as_their_own_step() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    let mut group = None;
    page(&mut store, &mut group, 1, 90.0);
    undo_and_finish(&mut store);
    page(&mut store, &mut group, 1, 180.0);

    assert_eq!(
        (store.edits.len(Stack::Undo), store.edits.len(Stack::Redo)),
        (1, 0),
        "the late page is a fresh entry and clears the undone one from redo"
    );
    undo_and_finish(&mut store);
    assert_eq!(store.get_loc_by_id(1).unwrap().heading, 0.0);
}

#[test]
fn a_run_an_autosave_lands_in_undoes_whole_after_reopen() {
    let dir = TempDir::new("mma_test_run_across_autosave");
    let delta = dir.join("m_delta.bin");
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 1.0, 0.0)]);
    let mut group = None;
    page(&mut store, &mut group, 1, 90.0);
    autosave(&mut store, &delta);
    page(&mut store, &mut group, 2, 180.0);
    autosave(&mut store, &delta);

    let mut store = reopen(&store, &fs::read(&delta).unwrap());
    assert_eq!(store.edits.len(Stack::Undo), 1);
    undo_and_finish(&mut store);
    assert_eq!(store.get_loc_by_id(1).unwrap().heading, 0.0);
    assert_eq!(store.get_loc_by_id(2).unwrap().heading, 0.0);
}

#[test]
fn a_page_folded_into_the_run_clears_redo() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 1.0, 0.0)]);
    let mut group = None;
    page(&mut store, &mut group, 1, 90.0);
    let user_edit = [patch!(2; heading: 45.0)];
    apply_updates(&mut store, &user_edit, &mut None);
    undo_and_finish(&mut store);
    page(&mut store, &mut group, 2, 180.0);

    assert_eq!(
        (store.edits.len(Stack::Undo), store.edits.len(Stack::Redo)),
        (1, 0),
        "the page joins the run, and the undone user edit cannot be redone over it"
    );
    undo_and_finish(&mut store);
    assert_eq!(store.get_loc_by_id(1).unwrap().heading, 0.0);
    assert_eq!(store.get_loc_by_id(2).unwrap().heading, 0.0);
}

#[test]
fn an_unreadable_edit_drops_the_history_rather_than_replay_around_it() {
    let mut store = setup_store_with(&[]);
    click_add(&mut store, 0.0, 0.0);
    click_add(&mut store, 1.0, 0.0);
    let mut store = close_and_reopen(&store);

    let failed = store.step(Stack::Undo, |_| Err("unreadable".into()));
    assert!(failed.is_err());
    assert_eq!(
        (store.edits.len(Stack::Undo), store.edits.len(Stack::Redo)),
        (0, 0)
    );
}

#[test]
fn a_close_writes_only_what_changed_since_the_last() {
    let mut store = setup_store_with(&[]);
    for i in 0..3 {
        click_add(&mut store, f64::from(i), 0.0);
    }
    with_history_db(|conn| {
        save_edit_history(conn, "m", &store.edits).unwrap();
        let before = conn.total_changes();
        save_edit_history(conn, "m", &store.edits).unwrap();
        assert_eq!(
            conn.total_changes(),
            before,
            "an unchanged history writes nothing"
        );

        click_add(&mut store, 9.0, 0.0);
        save_edit_history(conn, "m", &store.edits).unwrap();
        assert_eq!(conn.total_changes(), before + 1, "one new edit is one row");

        press_undo(&mut store);
        save_edit_history(conn, "m", &store.edits).unwrap();
        assert_eq!(conn.total_changes(), before + 2, "an undo moves one row");
    });
}

#[test]
fn edits_after_a_cleared_history_never_reuse_a_stored_number() {
    let mut store = setup_store_with(&[]);
    click_add(&mut store, 0.0, 0.0);
    click_add(&mut store, 1.0, 0.0);
    with_history_db(|conn| save_edit_history(conn, "m", &store.edits).unwrap());

    store.edits.edit().clear();
    let id = click_add(&mut store, 2.0, 0.0);
    let store = close_and_reopen(&store);

    assert_eq!(stack_ids(&store, Stack::Undo), vec![(2, vec![id])]);
}

fn assert_bake_sorted(store: &mut Store) {
    store.bake_overlay();
    let batch = store.batch.as_ref().unwrap();
    let ids = Columns::id(batch);
    assert!(
        (1..batch.num_rows()).all(|i| ids.value(i - 1) < ids.value(i)),
        "batch ids strictly sorted after bake"
    );
}

// Open map -> click new location -> delete it -> close map -> reopen -> undo the
// delete (resurrects the old id) -> click new location -> commit. Without seeding
// next_id past the persisted history, the new click re-allocates the resurrected
// id and bake panics on the strictly-sorted invariant ("oh jeff" corruption).
#[test]
fn undo_of_delete_after_reopen_does_not_collide() {
    let mut store = setup_store_with(&[]);
    let id = click_add(&mut store, 1.0, 1.0);
    delete_loc(&mut store, id);

    let mut store = close_and_reopen(&store);
    assert_eq!(
        store.next_id,
        id + 1,
        "freed id must stay reserved for history replay"
    );

    press_undo(&mut store); // resurrects `id`
    let new_id = click_add(&mut store, 2.0, 2.0);
    assert_ne!(new_id, id);
    assert_eq!(*store.alive_count, 2);
    assert_bake_sorted(&mut store);
}

// Same via redo: click -> undo the add -> close -> reopen -> redo (resurrects the
// old id) -> click -> commit.
#[test]
fn redo_of_add_after_reopen_does_not_collide() {
    let mut store = setup_store_with(&[]);
    let id = click_add(&mut store, 1.0, 1.0);
    press_undo(&mut store);

    let mut store = close_and_reopen(&store);
    press_redo(&mut store); // resurrects `id`
    let new_id = click_add(&mut store, 2.0, 2.0);
    assert_ne!(new_id, id);
    assert_eq!(*store.alive_count, 2);
    assert_bake_sorted(&mut store);
}

#[test]
#[should_panic(expected = "duplicate id 112")]
fn overlay_add_duplicate_id_asserts_in_debug() {
    let mut store = setup_store_with(&[loc(112, 1.0, 1.0)]);
    store.overlay_add(vec![loc(112, 9.0, 9.0)]);
}

// -----------------------------------------------------------------------
// Cross-map copy dedup (split_new_locations)
// -----------------------------------------------------------------------

fn loc_with_pano(id: u32, lat: f64, lng: f64, pano: &str) -> Location {
    Location {
        pano_id: Some(pano.into()),
        ..loc(id, lat, lng)
    }
}

#[test]
fn copy_dedup_pano_id_wins_over_coords() {
    let existing = vec![loc_with_pano(1, 10.0, 20.0, "AAA")];
    // Same pano, different coords: duplicate. Different pano, same coords: fresh.
    let sources = vec![
        loc_with_pano(7, 99.0, 99.0, "AAA"),
        loc_with_pano(8, 10.0, 20.0, "BBB"),
    ];
    let (fresh, skipped) = split_new_locations(sources, &existing);
    assert_eq!(skipped, 1);
    assert_eq!(fresh.len(), 1);
    assert_eq!(fresh[0].pano_id.as_deref(), Some("BBB"));
}

#[test]
fn copy_dedup_panoless_falls_back_to_exact_coords() {
    let existing = vec![loc(1, 10.0, 20.0), loc_with_pano(2, 30.0, 40.0, "CCC")];
    let sources = vec![
        loc(7, 10.0, 20.0),
        loc(8, 30.0, 40.0),
        loc(9, 10.0, 20.000001),
    ];
    let (fresh, skipped) = split_new_locations(sources, &existing);
    // id7 matches pano-less coords; id8 matches CCC's coords (pano-less source);
    // id9 is off by 1e-6 -- exact bits only, so fresh.
    assert_eq!(skipped, 2);
    assert_eq!(fresh.len(), 1);
    assert_eq!(fresh[0].id, 9);
}

#[test]
fn copy_dedup_empty_pano_treated_as_panoless() {
    let existing = vec![Location {
        pano_id: Some(Default::default()),
        ..loc(1, 10.0, 20.0)
    }];
    let sources = vec![Location {
        pano_id: Some(Default::default()),
        ..loc(7, 10.0, 20.0)
    }];
    let (_, skipped) = split_new_locations(sources, &existing);
    assert_eq!(skipped, 1);
}

// -----------------------------------------------------------------------
// Value reconciliation core (reconcile_values_by_name) — shared by import + copy
// -----------------------------------------------------------------------

fn tag(id: u32, name: &str, color: &str) -> (u32, ValueRecord) {
    let mut rec = seed(name);
    rec.insert("color".into(), color.into());
    (id, rec)
}

#[test]
fn reconcile_values_match_by_name_case_insensitive() {
    let mut target: HashMap<u32, ValueRecord> = [tag(3, "rural", "#222222")].into_iter().collect();
    let before = target.clone();
    let remap = reconcile_values_by_name(&[tag(7, "Rural", "#111111")], &mut target, 0);
    assert_eq!(remap.get(&7), Some(&3));
    assert_eq!(target, before, "pure match mutates nothing");
    assert_eq!(target.len(), 1);
    // The existing target record keeps its own color.
    assert_eq!(target.get(&3).unwrap()["color"], "#222222");
}

#[test]
fn reconcile_values_create_missing_with_source_pile() {
    let mut target: HashMap<u32, ValueRecord> = Default::default();
    let remap = reconcile_values_by_name(&[tag(7, "Trekker", "#abcdef")], &mut target, 9);
    assert_eq!(remap.get(&7), Some(&10));
    let rec = target.get(&10).unwrap();
    assert_eq!(record_name(rec), Some("Trekker"));
    assert_eq!(rec["color"], "#abcdef");
}

#[test]
fn reconcile_values_pile_keys_claimed_when_target_lacks_them() {
    let mut target: HashMap<u32, ValueRecord> = [tag(3, "rural", "#222222")].into_iter().collect();
    let (id, mut rec) = tag(7, "Rural", "#111111");
    rec.insert(
        "doclinks".into(),
        serde_json::json!(["https://docs.google.com/document/d/x/edit#heading=h.abc"]),
    );
    reconcile_values_by_name(&[(id, rec.clone())], &mut target, 0);
    assert_eq!(target.get(&3).unwrap()["doclinks"], rec["doclinks"]);
}

#[test]
fn reconcile_values_pile_keys_never_overwrite_existing() {
    let kept = serde_json::json!(["https://docs.google.com/document/d/kept/edit#heading=h.kept"]);
    let mut target: HashMap<u32, ValueRecord> = {
        let (id, mut rec) = tag(3, "rural", "#222222");
        rec.insert("doclinks".into(), kept.clone());
        [(id, rec)].into_iter().collect()
    };
    let (id, mut rec) = tag(7, "Rural", "#222222");
    rec.insert(
        "doclinks".into(),
        serde_json::json!(["https://docs.google.com/document/d/new/edit#heading=h.new"]),
    );
    reconcile_values_by_name(&[(id, rec)], &mut target, 0);
    assert_eq!(target.get(&3).unwrap()["doclinks"], kept);
}

#[test]
fn reconcile_values_dedupes_same_name_within_batch() {
    let mut target: HashMap<u32, ValueRecord> = Default::default();
    let remap = reconcile_values_by_name(
        &[tag(7, "urban", "#111111"), tag(8, "Urban", "#222222")],
        &mut target,
        0,
    );
    assert_eq!(target.len(), 1);
    assert_eq!(remap.get(&7), remap.get(&8));
}

// -----------------------------------------------------------------------
// Bug regression: undo to base state should clear the overlay patch,
// so the location no longer counts as "uncommitted".
// -----------------------------------------------------------------------

#[test]
fn undo_to_base_clears_overlay_patch() {
    let base = loc_with_heading(1, 10.0, 20.0, 0.0);
    let mut store = setup_store_with(slice::from_ref(&base));
    store.bake_overlay();

    let edited = loc_with_heading(1, 10.0, 20.0, 90.0);
    let entry = Change::from_sides(vec![edited], vec![base]);
    forward(&mut store, &entry);
    assert!(
        store.overlay.patches.contains_key(&1),
        "edit should create a patch"
    );

    reverse(&mut store, &entry);
    assert!(
        store.overlay.patches.is_empty(),
        "undo to base state should clear the patch"
    );
}

#[test]
fn any_write_that_changes_an_input_clears_what_was_computed_from_it() {
    let mut row = loc_with_heading(1, 10.0, 20.0, 0.0);
    row.extra = raw_extra(r#"{"timezone":"Europe/Oslo","sunrise":6,"kept":1}"#);
    let mut store = setup_store_with(&[row]);
    store.derived = ComputedFrom::new(HashMap::from([
        ("lat".to_string(), vec!["timezone".to_string()]),
        ("timezone".to_string(), vec!["sunrise".to_string()]),
    ]));
    apply_updates(&mut store, &[patch!(1; lat: 11.0)], &mut None);
    let extra = store.get_loc_by_id(1).unwrap().extra.unwrap().to_map();
    assert_eq!(
        extra,
        serde_json::json!({ "kept": 1 })
            .as_object()
            .unwrap()
            .clone()
    );
}

#[test]
fn overlay_update_back_to_base_clears_patch() {
    let base = loc_with_heading(1, 10.0, 20.0, 0.0);
    let mut store = setup_store_with(&[base]);
    store.bake_overlay();

    overlay_update(&mut store, &patch!(1; heading: 90.0));
    assert!(store.overlay.patches.contains_key(&1));

    overlay_update(&mut store, &patch!(1; heading: 0.0));
    assert!(
        !store.overlay.patches.contains_key(&1),
        "a row edited back to its base is the base row again, whatever its stamp"
    );
}

// -----------------------------------------------------------------------
// Spatial index (store integration; pure index tests live in spatial.test.rs)
// -----------------------------------------------------------------------

/// Brute-force reference: ids of alive locations within radius, sorted.
fn brute_nearby(store: &mut Store, lat: f64, lng: f64, r: f64) -> Vec<u32> {
    let mut out: Vec<u32> = store
        .collect(&crate::store::engine::Target::Map, &Selector::Everything)
        .iter()
        .filter(|l| selections::haversine_m(lat, lng, l.lat, l.lng) <= r)
        .map(|l| l.id)
        .collect();
    out.sort_unstable();
    out
}

fn indexed_nearby(store: &mut Store, lat: f64, lng: f64, r: f64) -> Vec<u32> {
    let near = Selector::Nearby {
        selection: None,
        lat,
        lng,
        radius_m: r,
    };
    store.scope(&near).ids().into_iter().collect()
}

fn nearest(store: &mut Store, lat: f64, lng: f64) -> Option<u32> {
    let near = Selector::Nearest {
        selection: None,
        lat,
        lng,
    };
    store.scope(&near).ids().min()
}

#[test]
fn spatial_matches_brute_force_across_mutations() {
    // Cluster around a point plus scattered outliers.
    let base = (48.8566, 2.3522);
    let m = 1.0 / 111_320.0; // ~1m in degrees latitude
    let mut store = setup_store_with(&[
        loc(1, base.0, base.1),
        loc(2, base.0 + m, base.1),
        loc(3, base.0 + 30.0 * m, base.1),
        loc(4, base.0 + 500.0 * m, base.1),
        loc(5, -33.0, 151.0),
    ]);

    for r in [0.0, 2.0, 50.0, 1000.0] {
        assert_eq!(
            indexed_nearby(&mut store, base.0, base.1, r),
            brute_nearby(&mut store, base.0, base.1, r),
            "radius {r}"
        );
    }

    // Mutate through every overlay path and re-verify: remove, coord patch, re-add.
    store.overlay_remove([loc(2, base.0 + m, base.1)].iter());
    overlay_update(&mut store, &patch!(3; lat: base.0, lng: base.1));
    store.overlay_add(vec![loc(6, base.0, base.1 + m)]);
    overlay_update(&mut store, &patch!(4; lat: 10.0)); // move far away

    for r in [0.0, 2.0, 50.0, 1000.0] {
        assert_eq!(
            indexed_nearby(&mut store, base.0, base.1, r),
            brute_nearby(&mut store, base.0, base.1, r),
            "radius {r} after mutations"
        );
    }
    assert_eq!(store.spatial.peek().unwrap().len(), *store.alive_count);
}

#[test]
fn spatial_survives_bake_and_undo_roundtrip() {
    let mut store = setup_store_with(&[loc(1, 10.0, 10.0), loc(2, 10.001, 10.0)]);
    assert_eq!(indexed_nearby(&mut store, 10.0, 10.0, 5.0), vec![1]);

    store.bake_overlay();
    assert_eq!(indexed_nearby(&mut store, 10.0, 10.0, 5.0), vec![1]);

    // Undo/redo replay flows through apply_edit -> overlay fns.
    let entry = Change::from_sides(vec![loc(3, 10.0, 10.0)], vec![loc(1, 10.0, 10.0)]);
    forward(&mut store, &entry);
    assert_eq!(indexed_nearby(&mut store, 10.0, 10.0, 5.0), vec![3]);
    reverse(&mut store, &entry);
    assert_eq!(indexed_nearby(&mut store, 10.0, 10.0, 5.0), vec![1]);
}

#[test]
fn spatial_rebuilds_when_alive_count_drifts() {
    let mut store = setup_store_with(&[loc(1, 10.0, 10.0)]);
    assert_eq!(indexed_nearby(&mut store, 10.0, 10.0, 5.0), vec![1]);

    // Simulate a bulk path bypassing the overlay fns: the len/alive mismatch
    // must force a rebuild instead of returning stale results.
    let pos = store.overlay.adds.partition_point(|l| l.id < 2);
    store.overlay.edit().adds.insert(pos, loc(2, 10.0, 10.0));
    *store.alive_count.edit() += 1;
    assert_eq!(indexed_nearby(&mut store, 10.0, 10.0, 5.0), vec![1, 2]);
}

#[test]
fn spatial_any_within() {
    let mut store = setup_store_with(&[loc(1, 10.0, 10.0)]);
    assert!(near_any(&mut store, 10.0, 10.0, 1.0));
    assert!(near_any(&mut store, 10.0004, 10.0, 50.0)); // ~45m away
    assert!(!near_any(&mut store, 10.0004, 10.0, 10.0));
    assert!(!near_any(&mut store, -45.0, 100.0, 1000.0));
}

#[test]
fn find_nearest_agrees_with_brute_force() {
    let mut store = setup_store_with(&[]);
    assert_eq!(nearest(&mut store, 0.0, 0.0), None);

    // Scattered worldwide, both sides of the antimeridian included.
    let mut seed = 7u64;
    let mut rand = move || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 11) as f64 / (1u64 << 53) as f64
    };
    let locs: Vec<Location> = (1..=200)
        .map(|id| loc(id, rand() * 160.0 - 80.0, rand() * 360.0 - 180.0))
        .chain([loc(201, 5.0, 179.9999), loc(202, 5.0, -179.9999)])
        .collect();
    let mut store = setup_store_with(&locs);

    let brute_nearest = |store: &mut Store, lat: f64, lng: f64| {
        store
            .collect(&crate::store::engine::Target::Map, &Selector::Everything)
            .iter()
            .map(|l| selections::haversine_m(lat, lng, l.lat, l.lng))
            .min_by(f64::total_cmp)
            .unwrap()
    };
    let mut check = |store: &mut Store, lat: f64, lng: f64| {
        let id = nearest(store, lat, lng).expect("nonempty map");
        let (la, ln) = store.coords_of(id).expect("alive id");
        let d = selections::haversine_m(lat, lng, la, ln);
        let want = brute_nearest(store, lat, lng);
        assert!((d - want).abs() < 1e-6, "({lat},{lng}): {d} != {want}");
    };

    // A queried point sitting on a location, dense and sparse regions, poles, and a
    // query just across the antimeridian from its nearest hit.
    for (lat, lng) in [
        (locs[0].lat, locs[0].lng),
        (0.0, 0.0),
        (48.8566, 2.3522),
        (89.9, 45.0),
        (-89.9, -45.0),
        (5.0, 179.9),
        (5.0, -179.9),
    ] {
        check(&mut store, lat, lng);
    }

    // Removing the nearest hands the answer to the runner-up.
    let gone = nearest(&mut store, 5.0, 179.9).unwrap();
    let gone_loc = store.get_loc_by_id(gone).unwrap();
    store.overlay_remove([gone_loc].iter());
    check(&mut store, 5.0, 179.9);
}

// -----------------------------------------------------------------------
// pick_spaced
// -----------------------------------------------------------------------

// 4x5 grid at the equator, 100m spacing. Ids 1..=20.
fn spaced_grid_store() -> Store {
    let step = 100.0 / 111_320.0; // ~100m in degrees at the equator
    let mut locs = Vec::new();
    let mut id = 1u32;
    for r in 0..4 {
        for c in 0..5 {
            locs.push(loc(id, r as f64 * step, c as f64 * step));
            id += 1;
        }
    }
    let mut store = setup_store_with(&locs);
    for l in &locs {
        store.selections.ids.insert(l.id);
    }
    store
}

fn coord_lookup(store: &Store) -> HashMap<u32, (f64, f64)> {
    store
        .selections
        .ids
        .iter()
        .filter_map(|id| store.coords_of(id).map(|c| (id, c)))
        .collect()
}

fn min_pairwise(ids: &[u32], coords: &HashMap<u32, (f64, f64)>) -> f64 {
    let mut min = f64::MAX;
    for i in 0..ids.len() {
        for j in i + 1..ids.len() {
            let (a, b) = (coords[&ids[i]], coords[&ids[j]]);
            min = min.min(selections::haversine_m(a.0, a.1, b.0, b.1));
        }
    }
    min
}

fn candidates(store: &Store, set: Option<&RoaringBitmap>) -> Vec<(u32, f64, f64)> {
    let all = store.all();
    match set {
        Some(s) => all.within(s).points(),
        None => all.points(),
    }
}

fn thin(count: Option<u32>, metres: Option<f64>) -> Thinning {
    match (count, metres) {
        (Some(n), None) => Thinning::Count { n },
        (None, Some(m)) => Thinning::Metres { m },
        _ => panic!("a pick thins exactly one way"),
    }
}

fn spaced(
    store: &Store,
    set: Option<&RoaringBitmap>,
    target: Option<u32>,
    min_distance_m: Option<f64>,
) -> AppResult<SpacedPickResult> {
    pick_spaced(candidates(store, set), thin(target, min_distance_m))
}

fn even(
    store: &Store,
    set: Option<&RoaringBitmap>,
    target: Option<u32>,
    spacing_m: Option<f64>,
) -> AppResult<SpacedPickResult> {
    pick_even(&candidates(store, set), thin(target, spacing_m))
}

#[test]
fn pick_spaced_count_returns_exactly_n_subset() {
    let store = spaced_grid_store();
    let res = spaced(&store, Some(&store.selections.ids), Some(8), None).unwrap();
    assert_eq!(res.ids.len(), 8);
    let uniq: HashSet<u32> = res.ids.iter().copied().collect();
    assert_eq!(uniq.len(), 8, "no duplicates");
    for id in &res.ids {
        assert!(
            store.selections.ids.contains(*id),
            "id {id} not in selection"
        );
    }
}

#[test]
fn pick_spaced_count_ge_size_returns_all() {
    let store = spaced_grid_store();
    let res = spaced(&store, Some(&store.selections.ids), Some(50), None).unwrap();
    assert_eq!(res.ids.len(), 20);
    assert_eq!(res.distance_m, 0);
    let uniq: HashSet<u32> = res.ids.iter().copied().collect();
    assert_eq!(uniq.len(), 20);
}

#[test]
fn pick_spaced_count_pairwise_spacing_meets_returned_distance() {
    let store = spaced_grid_store();
    let coords = coord_lookup(&store);
    let res = spaced(&store, Some(&store.selections.ids), Some(6), None).unwrap();
    let min = min_pairwise(&res.ids, &coords);
    assert!(
        min >= res.distance_m as f64 - 1e-6,
        "min pairwise {} < distance_m {}",
        min,
        res.distance_m
    );
}

#[test]
fn pick_spaced_distance_enforces_threshold() {
    let store = spaced_grid_store();
    let coords = coord_lookup(&store);
    let res = spaced(&store, Some(&store.selections.ids), None, Some(250.0)).unwrap();
    assert_eq!(res.distance_m, 250);
    assert!(!res.ids.is_empty());
    let min = min_pairwise(&res.ids, &coords);
    assert!(min >= 250.0 - 1e-6, "min pairwise {min} < 250");
}

#[test]
fn pick_spaced_arg_validation() {
    let store = spaced_grid_store();
    assert!(
        spaced(&store, None, None, Some(0.0)).is_err(),
        "zero distance"
    );
    assert!(
        spaced(&store, None, None, Some(f64::INFINITY)).is_err(),
        "distance above i32::MAX"
    );
}

#[test]
fn pick_spaced_empty_selection() {
    let store = setup_store_with(&[]);
    let count = spaced(&store, Some(&store.selections.ids), Some(5), None).unwrap();
    assert!(count.ids.is_empty());
    assert_eq!(count.distance_m, 0);
    let dist = spaced(&store, Some(&store.selections.ids), None, Some(100.0)).unwrap();
    assert!(dist.ids.is_empty());
    assert_eq!(dist.distance_m, 0);
}

#[test]
fn pick_spaced_narrowing_overrides_selection() {
    let mut store = spaced_grid_store();
    // Selection is the whole grid; narrow to ids 1..=5 (one row).
    let set = store
        .scope(&Selector::Manual {
            locations: vec![1, 2, 3, 4, 5],
        })
        .ids();
    let res = spaced(&store, Some(&set), Some(3), None).unwrap();
    assert_eq!(res.ids.len(), 3);
    for id in &res.ids {
        assert!(*id <= 5, "id {id} outside the set");
    }

    // An empty selection does not starve a narrowed pick.
    store.selections.ids = RoaringBitmap::new();
    let res = spaced(&store, Some(&set), Some(3), None).unwrap();
    assert_eq!(res.ids.len(), 3);
}

fn selected_store(points: &[(f64, f64)]) -> Store {
    let locs: Vec<Location> = points
        .iter()
        .enumerate()
        .map(|(i, &(lat, lng))| loc(i as u32 + 1, lat, lng))
        .collect();
    let mut store = setup_store_with(&locs);
    for l in &locs {
        store.selections.ids.insert(l.id);
    }
    store
}

/// `n` by `n` locations `step_m` apart, south-west corner at 45N 7E.
fn square_of(n: usize, step_m: f64) -> Vec<(f64, f64)> {
    let dlat = step_m / mma_geo::M_PER_DEG;
    let dlng = dlat / 45f64.to_radians().cos();
    (0..n)
        .flat_map(|r| (0..n).map(move |c| (45.0 + r as f64 * dlat, 7.0 + c as f64 * dlng)))
        .collect()
}

/// `n` pseudo-random locations over roughly a square kilometre at 45N 7E.
fn scattered(n: usize) -> Vec<(f64, f64)> {
    let mut seed = 0x9e37_79b9_u32;
    let mut next = move || {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (seed >> 8) as f64 / (1u32 << 24) as f64
    };
    (0..n)
        .map(|_| {
            let lat = 45.0 + next() * 0.01;
            (lat, 7.0 + next() * 0.014)
        })
        .collect()
}

fn nearest_to(lat: f64, lng: f64, others: impl Iterator<Item = (f64, f64)>) -> f64 {
    others
        .map(|(olat, olng)| selections::haversine_m(lat, lng, olat, olng))
        .fold(f64::INFINITY, f64::min)
}

#[test]
fn pick_even_spaces_neighbors_about_one_spacing_apart() {
    let store = selected_store(&square_of(60, 10.0));
    let coords = coord_lookup(&store);
    let res = even(&store, Some(&store.selections.ids), None, Some(100.0)).unwrap();
    assert_eq!(res.distance_m, 100);

    let picks: Vec<(f64, f64)> = res.ids.iter().map(|id| coords[id]).collect();
    let mut interior = 0;
    for &(lat, lng) in &picks {
        let y = (lat - 45.0) * mma_geo::M_PER_DEG;
        let x = (lng - 7.0) * mma_geo::M_PER_DEG * 45f64.to_radians().cos();
        if !(100.0..=490.0).contains(&x) || !(100.0..=490.0).contains(&y) {
            continue;
        }
        let gap = nearest_to(lat, lng, picks.iter().copied().filter(|&p| p != (lat, lng)));
        assert!(
            (85.0..=115.0).contains(&gap),
            "the pick at ({x:.0}, {y:.0})m has its nearest neighbor {gap:.1}m away"
        );
        interior += 1;
    }
    assert!(interior > 10, "{interior} interior picks");
}

#[test]
fn pick_even_never_keeps_two_picks_closer_than_half_the_spacing() {
    let road: Vec<(f64, f64)> = (0..400)
        .map(|i| (45.0 + i as f64 * 0.00004, 7.0 + i as f64 * 0.00007))
        .collect();
    for points in [scattered(3000), road] {
        let store = selected_store(&points);
        let coords = coord_lookup(&store);
        for spacing in [60.0, 150.0] {
            let res = even(&store, Some(&store.selections.ids), None, Some(spacing)).unwrap();
            assert!(res.ids.len() > 1);
            let min = min_pairwise(&res.ids, &coords);
            assert!(
                min >= spacing / 2.0,
                "{} picks at spacing {spacing}, the closest two {min}m apart",
                res.ids.len()
            );
        }
    }
}

#[test]
fn pick_even_leaves_every_location_near_a_pick() {
    let store = selected_store(&scattered(3000));
    let coords = coord_lookup(&store);
    let res = even(&store, Some(&store.selections.ids), None, Some(100.0)).unwrap();
    for (id, &(lat, lng)) in &coords {
        let gap = nearest_to(lat, lng, res.ids.iter().map(|p| coords[p]));
        assert!(
            gap <= 170.0,
            "location {id} is {gap:.1}m from the nearest pick"
        );
    }
}

#[test]
fn pick_even_count_keeps_at_most_n_near_n() {
    let store = selected_store(&scattered(3000));
    let coords = coord_lookup(&store);
    for goal in [1u32, 7, 40, 250] {
        let res = even(&store, Some(&store.selections.ids), Some(goal), None).unwrap();
        let n = res.ids.len();
        assert!(n >= 1 && n <= goal as usize, "{n} picks for {goal}");
        if goal >= 40 {
            assert!(n as f64 >= goal as f64 * 0.8, "{n} picks for {goal}");
        }
        if n > 1 {
            let min = min_pairwise(&res.ids, &coords);
            assert!(
                min >= res.distance_m as f64 / 2.0 - 1.0,
                "closest two {min}m apart"
            );
        }
    }
}

#[test]
fn pick_even_count_ge_size_returns_all() {
    let store = spaced_grid_store();
    let res = even(&store, Some(&store.selections.ids), Some(50), None).unwrap();
    assert_eq!(res.ids.len(), 20);
    assert_eq!(res.distance_m, 0);
}

#[test]
fn pick_even_is_deterministic() {
    let store = selected_store(&scattered(1000));
    let first = even(&store, Some(&store.selections.ids), None, Some(80.0)).unwrap();
    let second = even(&store, Some(&store.selections.ids), None, Some(80.0)).unwrap();
    assert_eq!(first.ids, second.ids);
}

#[test]
fn pick_even_arg_validation() {
    let store = spaced_grid_store();
    for spacing in [0.0, -5.0, f64::NAN, f64::INFINITY] {
        assert!(
            even(&store, None, None, Some(spacing)).is_err(),
            "spacing {spacing}"
        );
    }
}

#[test]
fn pick_even_empty_selection() {
    let store = setup_store_with(&[]);
    for (count, spacing) in [(Some(5), None), (None, Some(100.0))] {
        let res = even(&store, Some(&store.selections.ids), count, spacing).unwrap();
        assert!(res.ids.is_empty());
        assert_eq!(res.distance_m, 0);
    }
}

// -----------------------------------------------------------------------
// Delta corruption pinning
// -----------------------------------------------------------------------

fn store_with_full_overlay_base() -> Store {
    let base = vec![loc(1, 1.0, 1.0), loc(2, 2.0, 2.0), loc(3, 3.0, 3.0)];
    let mut store = Store::new();
    store.meta = Tracked::new(maps::MapMeta {
        id: "test-full-overlay".to_string(),
        ..Default::default()
    });
    store.batch = Some(arrow::locations_to_batch(&base));
    store.alive_count = Tracked::new(base.len());
    store.next_id = 10;
    store
}

// A store with a real (non-empty) base batch, plus all three overlay kinds
// populated: adds (fresh id 10), dead (removed id 2, which lives in the base),
// patches (updated id 1, which lives in the base).
fn store_with_full_overlay() -> Store {
    let mut store = store_with_full_overlay_base();

    overlay_update(&mut store, &patch!(1; heading: 99.0));

    let l2 = store.get_loc_by_id(2).unwrap();
    store.overlay_remove(slice::from_ref(&l2).iter());

    let new_id = store.alloc_id();
    store.overlay_add(vec![loc(new_id, 9.0, 9.0)]);

    store
}

#[test]
fn delta_parse_never_panics_on_corrupt_bytes() {
    let cases: Vec<Vec<u8>> = vec![
        Vec::new(),
        vec![0xff, 0x00, 0x13, 0x37, 0xde, 0xad, 0xbe, 0xef],
    ];
    for bytes in &cases {
        let result = panic::catch_unwind(|| arrow::read_arrow_ipc_bytes(bytes));
        assert!(result.is_ok(), "parsing must not panic: {bytes:?}");
        assert!(result.unwrap().is_err(), "must fail to parse: {bytes:?}");
    }
}

#[test]
fn delta_parse_never_panics_on_truncated_bytes() {
    let store = store_with_full_overlay();
    let full_bytes = sidecar_bytes(&store);
    assert!(full_bytes.len() > 1, "sanity: overlay has real content");
    let truncated = &full_bytes[..full_bytes.len() / 2];

    let result = panic::catch_unwind(|| arrow::read_arrow_ipc_bytes(truncated));
    assert!(result.is_ok(), "parsing must not panic on truncated bytes");
    assert!(
        result.unwrap().is_err(),
        "truncated bytes must fail to parse"
    );
}

#[test]
fn delta_bytes_roundtrip_exact() {
    let store = store_with_full_overlay();
    let parsed = through_sidecar(&store);

    assert_eq!(parsed.adds, store.overlay.adds, "adds preserved exactly");
    assert_eq!(
        parsed.dead, store.overlay.dead,
        "dead ids preserved exactly"
    );
    assert_eq!(
        parsed.patches, store.overlay.patches,
        "patches preserved exactly"
    );
}

// -----------------------------------------------------------------------
// Crash-window double-apply: write_baked_base renames the base file, then
// deletes the delta sidecar non-atomically. A crash between the two leaves a
// stale delta whose `adds` duplicate what the (now up to date) base already
// holds. store_open_map applies the parsed delta unconditionally -- mirror
// that application exactly and pin whatever
// the store ends up doing with the collision.
// -----------------------------------------------------------------------

#[test]
fn load_delta_sets_aside_unreadable_file_as_corrupt() {
    let dir = TempDir::new("mma_test_load_delta_corrupt");
    let path = dir.join("m1_delta.arrow");
    fs::write(&path, b"definitely not arrow").unwrap();

    assert!(load_delta(&path).is_none());
    assert!(!path.exists(), "unreadable delta must not stay in place");
    assert!(
        dir.join("m1_delta.corrupt").exists(),
        "unreadable delta must be kept for recovery"
    );
}

#[test]
fn load_delta_reads_valid_and_missing_files() {
    let dir = TempDir::new("mma_test_load_delta_ok");
    let path = dir.join("m1_delta.arrow");
    assert!(load_delta(&path).is_none(), "missing file is no delta");

    arrow::write_arrow_ipc(&path, &Overlay::default().to_delta(None)).unwrap();
    assert!(load_delta(&path).is_some());
    assert!(path.exists(), "valid delta stays in place");
}

#[test]
fn failed_base_write_keeps_the_overlay_and_the_delta() {
    let dir = TempDir::new("mma_test_failed_base_write");
    let base = dir.join("m1.arrow");
    let delta = dir.join("m1_delta.arrow");
    let mut store = setup_store_with(&[loc(1, 1.0, 1.0)]);
    store.bake_overlay();
    store.overlay_add(vec![loc(2, 2.0, 2.0)]);
    overlay_update(&mut store, &patch!(1; lat: 5.0));
    let delta_bytes = sidecar_bytes(&store);
    fs::write(&delta, &delta_bytes).unwrap();

    fs::create_dir(&base).unwrap();
    fs::write(base.join("obstacle"), b"x").unwrap();
    assert!(write_baked_base(&mut store, &base, &delta).is_err());

    assert!(store.overlay.is_unsaved(), "edits still read as unsaved");
    assert_eq!(sidecar_bytes(&store), delta_bytes);
    assert_eq!(
        store.batch.as_ref().unwrap().num_rows(),
        1,
        "base untouched"
    );
    assert_eq!(
        fs::read(&delta).unwrap(),
        delta_bytes,
        "delta file untouched"
    );

    fs::remove_dir_all(&base).unwrap();
    write_baked_base(&mut store, &base, &delta).unwrap();

    assert!(store.overlay.is_empty() && !store.overlay.is_unsaved());
    assert!(!delta.exists(), "a written base supersedes the delta");
    let written: Vec<(u32, f64)> =
        arrow::batch_to_locations(&arrow::read_arrow_ipc(&base).unwrap())
            .iter()
            .map(|l| (l.id, l.lat))
            .collect();
    assert_eq!(written, vec![(1, 5.0), (2, 2.0)]);
}

#[test]
fn patches_only_base_write_replaces_the_mapped_file_it_was_read_from() {
    let dir = TempDir::new("mma_test_mapped_base_write");
    let base = dir.join("m1.arrow");
    let delta = dir.join("m1_delta.arrow");
    arrow::write_arrow_ipc(
        &base,
        &arrow::locations_to_batch(&[loc(1, 1.0, 1.0), loc(2, 2.0, 2.0)]),
    )
    .unwrap();
    let mut store = Store::new();
    let (batch, handle) = arrow::read_arrow_ipc_mmap(&base).unwrap();
    store.batch = Some(batch);
    store.mmap_handle = Some(handle);
    store.alive_count = Tracked::new(2);
    let lats = |path: &Path| -> Vec<f64> {
        arrow::batch_to_locations(&arrow::read_arrow_ipc(path).unwrap())
            .iter()
            .map(|l| l.lat)
            .collect()
    };

    overlay_update(&mut store, &patch!(1; lat: 5.0));
    write_baked_base(&mut store, &base, &delta).unwrap();
    assert_eq!(lats(&base), vec![5.0, 2.0]);

    overlay_update(&mut store, &patch!(2; lat: 7.0));
    write_baked_base(&mut store, &base, &delta).unwrap();
    assert_eq!(lats(&base), vec![5.0, 7.0]);
    assert!(store.overlay.is_empty() && !store.overlay.is_unsaved());
}

#[test]
fn crash_window_stale_delta_double_applies_baked_locations() {
    let x = vec![loc(5, 5.0, 5.0), loc(6, 6.0, 6.0)];
    let mut store = Store::new();
    store.meta = Tracked::new(maps::MapMeta {
        id: "test-crash-window".to_string(),
        ..Default::default()
    });
    store.batch = Some(arrow::locations_to_batch(&x));
    store.alive_count = Tracked::new(x.len());

    // Stale delta from before the bake: re-adds the same ids the base now already has.
    let delta = Overlay::from_delta(&arrow::delta_to_batch(&x, &[]));

    // Mirror store_open_map's delta-application block exactly.
    store.overlay = Tracked::unsaved(delta);

    // Mirror the post-load alive_count recompute via scan_locations.
    let LocationAggregates { alive, .. } = store.scan_locations();
    store.alive_count = Tracked::new(alive);

    // Known bug: a stale delta re-adds rows already in the base.
    // This test records the duplicate rows produced by the current behaviour.
    assert_eq!(
        *store.alive_count, 4,
        "stale delta double-counts ids already in the baked base"
    );

    let all = store.collect(&crate::store::engine::Target::Map, &Selector::Everything);
    assert_eq!(all.len(), 4, "whole-map collect also yields duplicates");
    let ids: Vec<u32> = all.iter().map(|l| l.id).collect();
    assert_eq!(
        ids.iter().filter(|&&id| id == 5).count(),
        2,
        "id 5 appears twice"
    );
    assert_eq!(
        ids.iter().filter(|&&id| id == 6).count(),
        2,
        "id 6 appears twice"
    );

    // get_loc_by_id resolves via overlay.adds (binary search) before ever touching
    // the batch, so single-id lookups don't see the duplicate -- only bulk
    // enumeration (alive_count, collect, tag counts, render) is corrupted.
    assert_eq!(store.get_loc_by_id(5), Some(loc(5, 5.0, 5.0)));
}

#[test]
fn location_aggregates_include_effective_tag_membership() {
    let base = vec![
        loc_with_tags(1, 10.0, 20.0, vec![1]),
        loc_with_tags(2, 30.0, 40.0, vec![2]),
    ];
    let mut store = setup_store_with(&base);
    store.bake_overlay();
    overlay_update(&mut store, &patch!(1; tags: vec![2]));
    store.overlay_remove([base[1].clone()].iter());
    store.overlay_add(vec![loc_with_tags(3, -5.0, -10.0, vec![1, 2])]);

    let LocationAggregates { alive, bounds } = store.scan_locations();

    assert_eq!(alive, 2);
    assert_eq!(
        {
            let fields = store.fields(["tags"]);
            let tags = &fields[0];
            tags.keys()
                .into_iter()
                .map(|key| {
                    let count = tags.count(&key);
                    (key, count)
                })
                .collect::<HashMap<_, _>>()
        },
        HashMap::from([("1".into(), 1), ("2".into(), 2)]),
        "counts are the postings, derived on demand"
    );
    // Membership itself is the `tags` field index, resolved through the ordinary filter.
    store.scope(&Selector::tag(2));
    assert_eq!(resolved(&mut store, &Selector::tag(1)), vec![3]);
    assert_eq!(resolved(&mut store, &Selector::tag(2)), vec![1, 3]);
    assert_eq!(
        bounds.map(BoundsAcc::resolve),
        Some([-10.0, -5.0, 20.0, 10.0])
    );
}

// -----------------------------------------------------------------------
// Model-based undo/redo (proptest)
// -----------------------------------------------------------------------

#[derive(Debug, Clone)]
enum ModelOp {
    Add {
        lat: f64,
        lng: f64,
    },
    Remove {
        pick: usize,
    },
    Update {
        pick: usize,
        heading: f64,
        tags: Vec<u32>,
    },
}

fn arb_initial() -> impl Strategy<Value = Vec<Location>> {
    use proptest::strategy::Strategy;
    collection::btree_set(1u32..40, 0..10)
        .prop_map(|ids| ids.into_iter().map(|id| loc(id, 0.0, 0.0)).collect())
}

fn arb_ops() -> impl Strategy<Value = Vec<ModelOp>> {
    use proptest::prelude::*;
    let op = prop_oneof![
        (-90.0f64..90.0, -180.0f64..180.0).prop_map(|(lat, lng)| ModelOp::Add { lat, lng }),
        (0usize..1000).prop_map(|pick| ModelOp::Remove { pick }),
        (0usize..1000, 0.0f64..360.0, collection::vec(0u32..6, 0..3)).prop_map(
            |(pick, heading, tags)| ModelOp::Update {
                pick,
                heading,
                tags
            }
        ),
    ];
    collection::vec(op, 0..15)
}

// Apply the same operation to the store and the reference model.
fn apply_model_op(
    store: &mut Store,
    model: &mut BTreeMap<u32, Location>,
    alive_ids: &mut Vec<u32>,
    op: &ModelOp,
) {
    match op {
        ModelOp::Add { lat, lng } => {
            let id = store.alloc_id();
            let l = loc(id, *lat, *lng);
            store
                .edits
                .edit()
                .record(Arc::new(entry(Change::from_sides(vec![l.clone()], vec![]))));
            store.overlay_add(vec![l.clone()]);
            store.finish_mutation(&Change::from_sides(vec![l.clone()], vec![]));
            model.insert(id, l);
            let pos = alive_ids.partition_point(|&x| x < id);
            alive_ids.insert(pos, id);
        }
        ModelOp::Remove { pick } => {
            if alive_ids.is_empty() {
                return;
            }
            let idx = pick % alive_ids.len();
            let id = alive_ids[idx];
            let l = store.get_loc_by_id(id).unwrap();
            store.overlay_remove(slice::from_ref(&l).iter());
            store.finish_mutation(&Change::from_sides(vec![], vec![l.clone()]));
            store
                .edits
                .edit()
                .record(Arc::new(entry(Change::from_sides(vec![], vec![l]))));
            model.remove(&id);
            alive_ids.remove(idx);
        }
        ModelOp::Update {
            pick,
            heading,
            tags,
        } => {
            if alive_ids.is_empty() {
                return;
            }
            let idx = pick % alive_ids.len();
            let id = alive_ids[idx];
            let old = store.get_loc_by_id(id).unwrap();
            overlay_update(store, &patch!(id; heading: *heading, tags: tags.clone()));
            let new_loc = store.get_loc_by_id(id).unwrap();
            let change = Change::from_iter([mma_algebra::Transition::new(
                Some(old.clone()),
                Some(new_loc.clone()),
            )]);
            store.finish_mutation(&change);
            store.edits.edit().record(Arc::new(entry(Change::from_iter([
                mma_algebra::Transition::new(Some(old), Some(new_loc.clone())),
            ]))));
            model.insert(id, new_loc);
        }
    }
}

// modified_at is stamped from the wall clock on a real change; it is not part of
// the undo/redo correctness invariant under test, so normalize it away before
// comparing the store snapshot against the hand-rolled model.
fn model_snapshot(model: &BTreeMap<u32, Location>) -> Vec<Location> {
    let mut v: Vec<Location> = model.values().cloned().collect();
    v.sort_by_key(|l| l.id);
    for l in &mut v {
        l.modified_at = None;
    }
    v
}

fn store_snapshot(store: &mut Store) -> Vec<Location> {
    let mut v = store.collect(&crate::store::engine::Target::Map, &Selector::Everything);
    v.sort_by_key(|l| l.id);
    for l in &mut v {
        l.modified_at = None;
    }
    v
}

proptest::proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    #[test]
    fn undo_redo_matches_model(
        initial in arb_initial(),
        ops in arb_ops(),
        k_raw in 0usize..20,
    ) {
        let mut store = setup_store_with(&initial);
        let max_initial = initial.iter().map(|l| l.id).max().unwrap_or(0);
        store.next_id = max_initial + 1;

        let mut model: BTreeMap<u32, Location> =
            initial.iter().map(|l| (l.id, l.clone())).collect();
        let mut alive_ids: Vec<u32> = initial.iter().map(|l| l.id).collect();
        alive_ids.sort_unstable();

        let initial_snapshot = model_snapshot(&model);

        for (step, op) in ops.iter().enumerate() {
            apply_model_op(&mut store, &mut model, &mut alive_ids, op);
            proptest::prop_assert_eq!(
                *store.alive_count,
                model.len(),
                "alive_count drifted from model at step {}: {:?}", step, op
            );
            proptest::prop_assert_eq!(
                store_snapshot(&mut store),
                model_snapshot(&model),
                "store values diverged from model at step {}: {:?}", step, op
            );
            for tag in 0..6 {
                let expected = model.values().filter(|row| row.tags.contains(&tag)).count();
                proptest::prop_assert_eq!(
                    tag_count(&mut store, tag),
                    expected,
                    "tag {} count diverged at step {}: {:?}", tag, step, op
                );
            }
        }

        let final_snapshot = model_snapshot(&model);
        let pushed = store.edits.len(Stack::Undo);

        for _ in 0..pushed {
            press_undo(&mut store);
        }
        proptest::prop_assert_eq!(store_snapshot(&mut store), initial_snapshot.clone(), "full undo did not reach initial state");
        proptest::prop_assert_eq!(*store.alive_count, initial.len());

        for _ in 0..pushed {
            press_redo(&mut store);
        }
        proptest::prop_assert_eq!(store_snapshot(&mut store), final_snapshot.clone(), "full redo did not reach final state");
        proptest::prop_assert_eq!(*store.alive_count, model.len());

        // Interleaved: undo k then redo k, starting from the final state above, must
        // land back on the final state.
        let k = if pushed == 0 { 0 } else { k_raw % (pushed + 1) };
        for _ in 0..k {
            press_undo(&mut store);
        }
        for _ in 0..k {
            press_redo(&mut store);
        }
        proptest::prop_assert_eq!(store_snapshot(&mut store), final_snapshot, "interleaved undo/redo(k) did not land on final state");
        proptest::prop_assert_eq!(*store.alive_count, model.len());
    }
}

// ---------------------------------------------------------------------------
// plan_field_op: the map-wide `extra` rewrites, previously planned in JS
// ---------------------------------------------------------------------------

fn def_of(key: &str) -> maps::FieldDef {
    maps::infer_field_defs(
        |_| false,
        &[&raw_extra(&format!(r#"{{"{key}":1}}"#)).unwrap()],
    )
    .unwrap()
    .remove(key)
    .unwrap()
}

fn loc_with_extra(id: u32, json: &str) -> Location {
    Location {
        extra: RawExtra::from_string(json.to_string()),
        ..loc(id, 1.0, 1.0)
    }
}

fn planned_extra(u: &Patch<Location>) -> serde_json::Value {
    serde_json::from_str(match &u.extra {
        mma_algebra::Field::Set(e) => e.as_str(),
        other => panic!("extra is {other:?}"),
    })
    .unwrap()
}

struct Planned {
    updates: Vec<Patch<Location>>,
    failed: Vec<u32>,
}

fn puts(edits: Vec<Edit<Location>>) -> Vec<Patch<Location>> {
    edits
        .into_iter()
        .map(|e| match e {
            Op::Put(p) => p,
            _ => panic!("field work plans only patches"),
        })
        .collect()
}

fn plan(locs: &[Location], op: &RowOp) -> Vec<Patch<Location>> {
    plan_full(locs, op).updates
}

fn plan_full(locs: &[Location], op: &RowOp) -> Planned {
    let fx = Fx::base(locs);
    let p = plan_fields(selections::FieldRegistry::builtins(), &fx.view().all(), op).unwrap();
    Planned {
        updates: puts(p.edits),
        failed: p.failed,
    }
}

fn set_op(key: &str, value: serde_json::Value) -> RowOp {
    RowOp::Set {
        key: key.into(),
        value,
    }
}

fn expr_op(key: &str, expr: &str) -> RowOp {
    RowOp::Expr {
        key: key.into(),
        expr: expr.into(),
    }
}

fn move_op(from: &str, to: &str, winner: MergeWinner) -> RowOp {
    RowOp::Move {
        from: from.into(),
        to: to.into(),
        winner,
    }
}

#[test]
fn field_move_renames_when_the_target_is_absent() {
    let out = plan(
        &[loc_with_extra(1, r#"{"a":5}"#)],
        &move_op("a", "b", MergeWinner::From),
    );
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, 1);
    assert_eq!(
        planned_extra(&out[0]),
        serde_json::json!({"a": null, "b": 5})
    );
}

#[test]
fn field_move_winner_from_overwrites_an_existing_target() {
    let out = plan(
        &[loc_with_extra(1, r#"{"a":5,"b":9}"#)],
        &move_op("a", "b", MergeWinner::From),
    );
    assert_eq!(
        planned_extra(&out[0]),
        serde_json::json!({"a": null, "b": 5})
    );
}

#[test]
fn field_move_winner_to_keeps_the_target_and_only_drops_the_source() {
    let out = plan(
        &[loc_with_extra(1, r#"{"a":5,"b":9}"#)],
        &move_op("a", "b", MergeWinner::To),
    );
    assert_eq!(planned_extra(&out[0]), serde_json::json!({"a": null}));
}

#[test]
fn field_move_skips_rows_without_the_source_and_leaves_other_keys_alone() {
    let out = plan(
        &[
            loc_with_extra(1, r#"{"x":1}"#),
            loc_with_extra(2, r#"{"a":5,"keep":1}"#),
        ],
        &move_op("a", "b", MergeWinner::From),
    );
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, 2);
    // Merge patch carries only the moved keys -- `keep` is untouched.
    assert_eq!(
        planned_extra(&out[0]),
        serde_json::json!({"a": null, "b": 5})
    );
}

#[test]
fn field_move_is_a_noop_when_source_equals_target_or_target_is_empty() {
    let locs = [loc_with_extra(1, r#"{"a":5}"#)];
    assert!(plan(&locs, &move_op("a", "a", MergeWinner::From)).is_empty());
    assert!(plan(&locs, &move_op("a", "", MergeWinner::From)).is_empty());
}

#[test]
fn field_delete_null_deletes_only_where_the_key_exists() {
    let out = plan(
        &[
            loc_with_extra(1, r#"{"a":5,"b":9}"#),
            loc_with_extra(2, r#"{"b":1}"#),
        ],
        &RowOp::Delete {
            keys: vec!["a".into()],
        },
    );
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, 1);
    assert_eq!(planned_extra(&out[0]), serde_json::json!({"a": null}));
}

#[test]
fn field_delete_takes_several_keys_at_once() {
    let out = plan(
        &[loc_with_extra(1, r#"{"a":5,"b":9,"c":1}"#)],
        &RowOp::Delete {
            keys: vec!["a".into(), "c".into(), "missing".into()],
        },
    );
    assert_eq!(
        planned_extra(&out[0]),
        serde_json::json!({"a": null, "c": null})
    );
}

#[test]
fn field_op_honours_the_selector() {
    let locs = [
        loc_with_extra(1, r#"{"a":5}"#),
        loc_with_extra(2, r#"{"a":6}"#),
    ];
    let fx = Fx::base(&locs);
    let set: RoaringBitmap = [2u32].into_iter().collect();
    let out = puts(
        plan_fields(
            selections::FieldRegistry::builtins(),
            &fx.view().all().within(&set),
            &move_op("a", "b", MergeWinner::From),
        )
        .unwrap()
        .edits,
    );
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, 2);
}

#[test]
fn set_op_writes_extra_only_where_the_value_differs() {
    let locs = [
        loc_with_extra(1, r#"{"a":5}"#),
        loc_with_extra(2, r#"{"a":6}"#),
        loc_with_extra(3, r#"{"b":1}"#),
    ];
    let out = plan(&locs, &set_op("a", serde_json::json!(5)));
    assert_eq!(out.iter().map(|u| u.id).collect::<Vec<_>>(), vec![2, 3]);
    assert_eq!(planned_extra(&out[0]), serde_json::json!({ "a": 5 }));
    // A stored integer equals the float an expression would compute.
    assert!(plan(&locs, &set_op("a", serde_json::json!(5.0)))
        .iter()
        .all(|u| u.id != 1));
    // Strings compare exactly.
    let out = plan(&locs, &set_op("a", serde_json::json!("x")));
    assert_eq!(out.len(), 3);
}

#[test]
fn set_op_patches_a_writable_builtin_column() {
    let locs = [loc(1, 1.0, 1.0), loc(2, 1.0, 1.0)];
    let out = plan(&locs, &set_op("heading", serde_json::json!(90)));
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].heading, Some(90.0));
    assert!(out[0].extra.is_keep());
}

#[test]
fn set_op_toggles_a_flag_field_bit_and_keeps_the_others() {
    let informational = LocationFlags::INFORMATIONAL;
    let locs = [
        Location {
            flags: informational,
            ..loc(1, 1.0, 1.0)
        },
        Location {
            flags: LocationFlags::LOAD_AS_PANO_ID,
            ..loc(2, 1.0, 1.0)
        },
    ];
    let on = plan(&locs, &set_op("loadAsPanoId", serde_json::json!(true)));
    assert_eq!(on.iter().map(|u| u.id).collect::<Vec<_>>(), vec![1]);
    assert_eq!(
        on[0].flags,
        Some(informational | LocationFlags::LOAD_AS_PANO_ID)
    );
    assert!(on[0].extra.is_keep());
    let off = plan(&locs, &set_op("loadAsPanoId", serde_json::json!(false)));
    assert_eq!(off.iter().map(|u| u.id).collect::<Vec<_>>(), vec![2]);
    assert_eq!(off[0].flags, Some(LocationFlags::empty()));
}

#[test]
fn a_flag_field_takes_only_true_or_false() {
    let locs = [loc(1, 1.0, 1.0), loc_with_extra(2, r#"{"a":1}"#)];
    for value in [
        serde_json::json!(2),
        serde_json::json!(1),
        serde_json::json!("true"),
    ] {
        let err = plan_err(&locs, &set_op("loadAsPanoId", value));
        assert!(err.contains("takes true or false"), "{err}");
    }
    let out = plan_full(&locs, &expr_op("loadAsPanoId", "id * 2"));
    assert_eq!(out.failed, vec![1, 2]);
    assert!(out.updates.is_empty());
}

fn pinned_loc(id: u32, pano: &str) -> Location {
    Location {
        pano_id: Some(pano.into()),
        ..loc(id, 1.0, 1.0)
    }
}

/// The message a rejected op answers with, or a panic naming what was wrongly accepted.
fn plan_err(locs: &[Location], op: &RowOp) -> String {
    let fx = Fx::base(locs);
    match plan_fields(selections::FieldRegistry::builtins(), &fx.view().all(), op) {
        Err(e) => e.to_string(),
        Ok(_) => panic!("op was accepted"),
    }
}

fn del_op(keys: &[&str]) -> RowOp {
    RowOp::Delete {
        keys: keys.iter().map(|k| (*k).to_string()).collect(),
    }
}

#[test]
fn delete_clears_a_nullable_builtin_column_rather_than_a_phantom_extra_key() {
    let locs = [pinned_loc(1, "abc"), pinned_loc(2, "def")];
    let out = plan(&locs, &del_op(&["panoId"]));
    assert_eq!(out.len(), 2);
    assert_eq!(
        out[0].pano_id,
        mma_algebra::Field::Clear,
        "the column is cleared"
    );
    assert!(out[0].extra.is_keep(), "nothing lands in extra");
}

#[test]
fn delete_leaves_a_row_that_has_no_pano_alone() {
    let locs = [pinned_loc(1, "abc"), loc(2, 1.0, 1.0)];
    let out = plan(&locs, &del_op(&["panoId"]));
    assert_eq!(out.iter().map(|u| u.id).collect::<Vec<_>>(), vec![1]);
}

#[test]
fn one_delete_of_a_column_and_an_extra_key_is_one_patch() {
    let locs = [Location {
        pano_id: Some("abc".into()),
        ..loc_with_extra(1, r#"{"a":1}"#)
    }];
    let out = plan(&locs, &del_op(&["panoId", "a"]));
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].pano_id, mma_algebra::Field::Clear);
    assert_eq!(planned_extra(&out[0]), serde_json::json!({ "a": null }));
}

#[test]
fn a_nullable_builtin_may_be_cleared_but_never_assigned() {
    let locs = [pinned_loc(1, "abc")];
    assert!(plan(&locs, &del_op(&["panoId"])).len() == 1);
    let err = plan_err(&locs, &set_op("panoId", serde_json::json!("x")));
    assert!(err.contains("cannot be assigned"), "{err}");
}

#[test]
fn an_op_that_cannot_write_a_builtin_fails_instead_of_reporting_rows_changed() {
    let locs = [loc(1, 1.0, 1.0)];
    // A column that cannot hold null reads a null patch as "unchanged", so clearing one
    // would report the row changed and leave it standing. Writable is not clearable.
    for key in ["lat", "id", "tagCount", "loadAsPanoId", "heading", "zoom"] {
        let err = plan_err(&locs, &del_op(&[key]));
        assert!(err.contains("cannot be removed"), "{key}: {err}");
    }
}

#[test]
fn a_move_may_take_a_nullable_column_but_never_fill_one() {
    let locs = [pinned_loc(1, "abc")];
    let moved = plan(&locs, &move_op("panoId", "oldPano", MergeWinner::From));
    assert_eq!(moved[0].pano_id, mma_algebra::Field::Clear);
    assert_eq!(
        planned_extra(&moved[0]),
        serde_json::json!({ "oldPano": "abc" })
    );
    let err = plan_err(&locs, &move_op("a", "panoId", MergeWinner::From));
    assert!(err.contains("cannot be assigned"), "{err}");
}

#[test]
fn expr_op_evaluates_per_row_and_names_the_rows_it_cannot() {
    let locs = [
        loc_with_extra(1, r#"{"a":10}"#),
        loc_with_extra(2, r#"{"a":-10}"#),
        loc_with_extra(3, r#"{"b":1}"#),
        loc_with_extra(4, r#"{"a":"ten"}"#),
    ];
    let p = plan_full(&locs, &expr_op("h", "mod(a + 180, 360)"));
    assert_eq!(
        p.updates.iter().map(|u| u.id).collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(
        planned_extra(&p.updates[0]),
        serde_json::json!({ "h": 190 })
    );
    assert_eq!(
        planned_extra(&p.updates[1]),
        serde_json::json!({ "h": 170 })
    );
    assert_eq!(p.failed, vec![3, 4]);
}

#[test]
fn expr_op_drops_rows_the_result_would_not_change() {
    let locs = [
        loc_with_extra(1, r#"{"a":5}"#),
        loc_with_extra(2, r#"{"a":5.5}"#),
    ];
    let p = plan_full(&locs, &expr_op("a", "a * 1"));
    assert!(p.updates.is_empty());
    assert!(p.failed.is_empty());
    // Fractions survive as floats, whole numbers as integers.
    let out = plan(&locs, &expr_op("c", "a / 2"));
    assert_eq!(planned_extra(&out[0]), serde_json::json!({ "c": 2.5 }));
    assert_eq!(planned_extra(&out[1]), serde_json::json!({ "c": 2.75 }));
    let out = plan(&locs, &expr_op("c", "a * 2"));
    assert_eq!(planned_extra(&out[0]), serde_json::json!({ "c": 10 }));
}

#[test]
fn expr_op_reads_builtin_columns_and_may_write_one() {
    let mut l = loc(1, 1.0, 1.0);
    l.heading = 350.0;
    let out = plan(&[l], &expr_op("heading", "mod(heading + 20, 360)"));
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].heading, Some(10.0));
}

#[test]
fn expr_op_rejects_a_syntax_error_before_touching_rows() {
    let fx = Fx::base(&[loc_with_extra(1, r#"{"a":5}"#)]);
    let err = plan_fields(
        selections::FieldRegistry::builtins(),
        &fx.view().all(),
        &expr_op("a", "a +"),
    )
    .err()
    .unwrap();
    assert!(err.0.contains("unexpected end of expression"), "{}", err.0);
}

// A key a mutation introduces lands in the store's registry and the same result ships
// the whole registry; a mutation that adds no key ships nothing.
#[test]
fn new_extra_key_is_announced_in_the_same_result() {
    let mut store = setup_store_with(&[]);
    let feed = FeedCapture::attach(&mut store);
    add_rows(&mut store, vec![loc_with_extra(1, r#"{"zz":1}"#)]);
    assert!(store.meta.extra.fields.contains_key("zz"));
    assert!(feed
        .last()
        .derived
        .field_defs
        .is_some_and(|d| d.contains_key("zz")));
    add_rows(&mut store, vec![loc_with_extra(2, r#"{"zz":2}"#)]);
    assert!(feed.last().derived.field_defs.is_none());

    let feed = FeedCapture::attach(&mut store);
    apply_updates(
        &mut store,
        &[Patch::<Location> {
            id: 1,
            extra: RawExtra::from_string(r#"{"zz":1,"yy":2}"#.into()).into(),
            ..Default::default()
        }],
        &mut None,
    );
    assert!(feed
        .last()
        .derived
        .field_defs
        .is_some_and(|d| d.contains_key("yy") && d.contains_key("zz")));
}

// A def the map already holds is never overwritten when a new row carries the same key.
#[test]
fn registering_fields_keeps_the_existing_def() {
    let mut store = setup_store_with(&[]);
    let mut user = def_of("k");
    user.label = Some("User edited".into());
    store.meta.edit().extra.fields.insert("k".into(), user);
    store.write(
        [Op::Set(loc_with_extra(1, r#"{"k":1}"#))],
        &mut None,
        Entry::default(),
    );
    assert_eq!(
        store.meta.extra.fields["k"].label.as_deref(),
        Some("User edited")
    );
}

// The command path, not just the plan: a gate that rejected a clearable builtin before
// `plan_field_op` ran would make every plan-level test above green and the feature dead.
#[test]
fn apply_field_op_clears_a_nullable_column() {
    let mut store = setup_store_with(&[pinned_loc(1, "abc")]);
    let out = apply_work(
        &mut store,
        &Selector::Everything,
        &Work::Rows(del_op(&["panoId"])),
    )
    .unwrap();
    assert_eq!(out.changed, 1);
    assert!(out.failed.is_empty());
    assert!(store.get_loc_by_id(1).unwrap().pano_id.is_none());
}

#[test]
fn work_wire_kinds_land_in_their_tier() {
    let work = |v: serde_json::Value| serde_json::from_value::<Work>(v).unwrap();
    assert!(matches!(
        work(serde_json::json!({ "kind": "delete", "keys": ["a"] })),
        Work::Rows(RowOp::Delete { .. })
    ));
    assert!(matches!(
        work(serde_json::json!({ "kind": "pruneDuplicates", "distance": 25.0, "score": null })),
        Work::Sets(SetOp::PruneDuplicates { .. })
    ));
}

#[test]
fn a_patch_clears_only_the_nullable_columns_the_engine_does_not_stamp() {
    assert_eq!(<Location as mma_algebra::Patchable>::CLEARS, &["panoId"]);
}

#[test]
fn apply_field_op_refuses_to_clear_the_column_the_engine_stamps() {
    let mut store = setup_store_with(&[pinned_loc(1, "abc")]);
    let Err(err) = apply_work(
        &mut store,
        &Selector::Everything,
        &Work::Rows(del_op(&["modifiedAt"])),
    ) else {
        panic!("cleared the stamped column");
    };
    assert!(err.to_string().contains("modifiedAt"));
}

#[test]
fn apply_field_op_returns_the_ids_an_expression_could_not_evaluate() {
    let mut store = setup_store_with(&[
        loc_with_extra(1, r#"{"a":10}"#),
        loc_with_extra(2, r#"{"b":1}"#),
        loc_with_extra(3, r#"{"a":"ten"}"#),
    ]);
    let out = apply_work(
        &mut store,
        &Selector::Everything,
        &Work::Rows(expr_op("h", "a + 1")),
    )
    .unwrap();
    assert_eq!(out.changed, 1);
    assert_eq!(out.failed, vec![2, 3]);
}

#[test]
fn apply_field_op_sets_and_clears_a_flag_bit_from_a_boolean() {
    let mut store = setup_store_with(&[loc(1, 1.0, 1.0)]);
    for on in [true, false] {
        let out = apply_work(
            &mut store,
            &Selector::Everything,
            &Work::Rows(set_op("loadAsPanoId", serde_json::json!(on))),
        )
        .unwrap();
        assert_eq!(out.changed, 1);
        assert_eq!(
            store
                .get_loc_by_id(1)
                .unwrap()
                .flags
                .contains(LocationFlags::LOAD_AS_PANO_ID),
            on
        );
    }
}

#[test]
fn apply_field_op_refuses_a_column_it_cannot_clear() {
    let mut store = setup_store_with(&[loc(1, 1.0, 1.0)]);
    let Err(err) = apply_work(
        &mut store,
        &Selector::Everything,
        &Work::Rows(del_op(&["heading"])),
    ) else {
        panic!("heading is writable, never clearable")
    };
    assert!(err.0.contains("cannot be removed"), "{}", err.0);
}

#[test]
fn apply_field_op_refuses_a_non_numeric_assignment() {
    let mut store = setup_store_with(&[loc(1, 1.0, 1.0)]);
    assert!(apply_work(
        &mut store,
        &Selector::Everything,
        &Work::Rows(set_op("heading", serde_json::json!("north"))),
    )
    .is_err());
}

#[test]
fn collect_honours_each_selector_shape() {
    let mut store = setup_store_with(&[loc(1, 1.0, 1.0), loc(2, 2.0, 2.0), loc(3, 3.0, 3.0)]);
    let ids = |locs: Vec<Location>| locs.iter().map(|l| l.id).collect::<Vec<u32>>();

    assert_eq!(
        ids(store.collect(&crate::store::engine::Target::Map, &Selector::Everything)),
        vec![1, 2, 3]
    );
    // The named-ids fast path keeps request order and skips dead ids.
    assert_eq!(
        ids(store.collect(
            &crate::store::engine::Target::Map,
            &Selector::Locations {
                locations: vec![3, 1, 9],
                name: None,
            }
        )),
        vec![3, 1]
    );
    assert_eq!(
        ids(store.collect(
            &crate::store::engine::Target::Map,
            &Selector::Manual {
                locations: vec![1, 3]
            }
        )),
        vec![1, 3]
    );
}

#[test]
fn concurrent_rows_file_queries_get_distinct_paths() {
    // The rows file is fetched after the store lock is released; queries in flight at the
    // same time must never stage into the same path.
    let temp = env::temp_dir();
    let a = rows_file_path(&temp, "m");
    let b = rows_file_path(&temp, "m");
    assert_ne!(a, b);
}

// -----------------------------------------------------------------------
// Staged (chunked upload) adds
// -----------------------------------------------------------------------

/// Stage `chunks` into a fresh upload session the way the frontend POSTs them.
fn stage_chunks(chunks: &[Vec<Location>]) -> String {
    let session = export::store_upload_begin().unwrap();
    for (i, chunk) in chunks.iter().enumerate() {
        let path = Path::new(&session).join(format!("{i}.json"));
        fs::write(path, serde_json::to_vec(chunk).unwrap()).unwrap();
    }
    session
}

/// Ids the last frame added, ascending: allocation order, which is staged order.
fn added_ids(frames: &Captured) -> Vec<u32> {
    let mut ids: Vec<u32> = added(&frames.last().cells).iter().map(|r| r.key).collect();
    ids.sort_unstable();
    ids
}

#[test]
fn uploaded_add_reads_chunks_in_index_order() {
    let session = stage_chunks(&[
        vec![loc(0, 1.0, 1.0), loc(0, 2.0, 2.0)],
        vec![loc(0, 3.0, 3.0)],
    ]);
    let uploaded = export::read_uploaded_chunks::<Location>(&session).unwrap();
    assert_eq!(
        uploaded.iter().map(|l| l.lat).collect::<Vec<_>>(),
        vec![1.0, 2.0, 3.0]
    );
}

#[test]
fn uploaded_add_echoes_ids_in_staged_order() {
    let mut store = setup_store_with(&[]);
    let session = stage_chunks(&[
        vec![loc(0, 1.0, 1.0), loc(0, 2.0, 2.0)],
        vec![loc(0, 3.0, 3.0)],
    ]);
    let uploaded = export::read_uploaded_chunks::<Location>(&session).unwrap();
    let frames = watch(&mut store);
    add_rows(&mut store, uploaded);

    let ids = added_ids(&frames);
    assert_eq!(ids.len(), 3);
    assert!(ids.windows(2).all(|w| w[1] == w[0] + 1));
    for (id, lat) in ids.iter().zip([1.0, 2.0, 3.0]) {
        assert_eq!(store.get_loc_by_id(*id).unwrap().lat, lat);
    }
}

#[test]
fn uploaded_add_matches_direct_add() {
    let locs = vec![loc(0, 1.0, 1.0), loc(0, 2.0, 2.0), loc(0, 3.0, 3.0)];

    let mut direct_store = setup_store_with(&[]);
    let direct = add_rows(&mut direct_store, locs.clone());

    let mut uploaded_store = setup_store_with(&[]);
    let session = stage_chunks(&[locs[..2].to_vec(), locs[2..].to_vec()]);
    let uploaded = add_rows(
        &mut uploaded_store,
        export::read_uploaded_chunks::<Location>(&session).unwrap(),
    );

    assert_eq!(
        serde_json::to_value(&direct).unwrap(),
        serde_json::to_value(&uploaded).unwrap()
    );
    assert_eq!(
        direct_store.edits.len(Stack::Undo),
        uploaded_store.edits.len(Stack::Undo)
    );
    assert_eq!(
        newest_undo(&direct_store).sides().0,
        newest_undo(&uploaded_store).sides().0
    );
}

#[test]
fn uploaded_add_rejects_malformed_chunk_before_mutating() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    let session = stage_chunks(&[vec![loc(0, 1.0, 1.0)]]);
    fs::write(
        Path::new(&session).join("1.json"),
        b"[{\"id\": \"not a number\"}]",
    )
    .unwrap();

    // Mirrors the command: parse first, mutate only on Ok.
    let uploaded = export::read_uploaded_chunks::<Location>(&session);
    assert!(uploaded.is_err());
    if let Ok(locs) = uploaded {
        add_rows(&mut store, locs);
    }

    assert_eq!(*store.alive_count, 1);
    assert!(store.edits.len(Stack::Undo) == 0);
}

#[test]
fn uploaded_add_rejects_missing_chunk() {
    let session = stage_chunks(&[vec![loc(0, 1.0, 1.0)]]);
    fs::write(
        Path::new(&session).join("2.json"),
        serde_json::to_vec(&vec![loc(0, 2.0, 2.0)]).unwrap(),
    )
    .unwrap();
    assert!(export::read_uploaded_chunks::<Location>(&session).is_err());
}

#[test]
fn uploaded_add_rejects_dir_outside_session() {
    assert!(export::read_uploaded_chunks::<Location>("C:/somewhere/else").is_err());
}

#[test]
fn uploaded_add_removes_session_dir() {
    let ok = stage_chunks(&[vec![loc(0, 1.0, 1.0)]]);
    export::read_uploaded_chunks::<Location>(&ok).unwrap();
    assert!(!Path::new(&ok).exists());

    let bad = stage_chunks(&[]);
    fs::write(Path::new(&bad).join("junk.json"), b"[]").unwrap();
    assert!(export::read_uploaded_chunks::<Location>(&bad).is_err());
    assert!(!Path::new(&bad).exists());
}

#[test]
fn a_save_stamped_with_an_older_rev_leaves_the_value_unsaved() {
    let mut tracked = Tracked::new(0u32);
    *tracked.edit() = 1;
    let stale = tracked.rev();
    *tracked.edit() = 2;

    tracked.saved_at(stale);
    assert!(tracked.is_unsaved());

    let current = tracked.rev();
    tracked.saved_at(current);
    assert!(!tracked.is_unsaved());
}

// ---------------------------------------------------------------------------
// Pending layers: stage edits before applying them to the map
// ---------------------------------------------------------------------------

fn viewer() -> Target {
    Target::Pending {
        name: "viewer".into(),
    }
}

fn heading(id: u32, heading: f64) -> Patch<Location> {
    Patch::<Location> {
        id,
        heading: Some(heading),
        ..Default::default()
    }
}

#[test]
fn a_pending_edit_is_held_and_read_through_until_it_lands() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    store.next_id = 2;
    store.edit(&viewer(), vec![Op::Put(heading(1, 90.0))], false, &mut None);
    assert_eq!(
        store
            .collect(
                &Target::Map,
                &crate::selections::Selector::Locations {
                    locations: vec![1],
                    name: None
                }
            )
            .into_iter()
            .next()
            .unwrap()
            .heading,
        0.0
    );
    assert_eq!(
        store
            .collect(
                &viewer(),
                &crate::selections::Selector::Locations {
                    locations: vec![1],
                    name: None
                }
            )
            .into_iter()
            .next()
            .unwrap()
            .heading,
        90.0
    );
    assert_eq!(store.edits.len(Stack::Undo), 0);
}

#[test]
fn a_write_underneath_a_pending_layer_shows_through_its_reads() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    store.next_id = 2;
    store.edit(&viewer(), vec![Op::Put(heading(1, 90.0))], false, &mut None);
    store.write(
        [Op::Put(Patch::<Location> {
            id: 1,
            pitch: Some(5.0),
            ..Default::default()
        })],
        &mut None,
        Entry::default(),
    );
    let seen = store
        .collect(
            &viewer(),
            &crate::selections::Selector::Locations {
                locations: vec![1],
                name: None,
            },
        )
        .into_iter()
        .next()
        .unwrap();
    assert_eq!(seen.heading, 90.0);
    assert_eq!(seen.pitch, 5.0);
}

#[test]
fn landing_a_layer_folds_its_edits_into_one_undoable_step() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 1.0, 1.0)]);
    store.next_id = 3;
    store.edit(&viewer(), vec![Op::Put(heading(1, 90.0))], false, &mut None);
    store.edit(&viewer(), vec![Op::Remove(2)], false, &mut None);
    assert_eq!(store.edits.len(Stack::Undo), 0);

    store.edit(&viewer(), vec![], true, &mut None);
    assert_eq!(store.edits.len(Stack::Undo), 1);
    assert_eq!(
        store
            .collect(
                &Target::Map,
                &crate::selections::Selector::Locations {
                    locations: vec![1],
                    name: None
                }
            )
            .into_iter()
            .next()
            .unwrap()
            .heading,
        90.0
    );
    assert!(store
        .collect(
            &Target::Map,
            &crate::selections::Selector::Locations {
                locations: vec![2],
                name: None
            }
        )
        .into_iter()
        .next()
        .is_none());

    press_undo(&mut store);
    assert_eq!(
        store
            .collect(
                &Target::Map,
                &crate::selections::Selector::Locations {
                    locations: vec![1],
                    name: None
                }
            )
            .into_iter()
            .next()
            .unwrap()
            .heading,
        0.0
    );
    assert!(store
        .collect(
            &Target::Map,
            &crate::selections::Selector::Locations {
                locations: vec![2],
                name: None
            }
        )
        .into_iter()
        .next()
        .is_some());
}

#[test]
fn an_edit_through_a_landed_layer_writes_through_and_joins_its_step() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    store.next_id = 2;
    store.edit(&viewer(), vec![Op::Put(heading(1, 90.0))], true, &mut None);
    assert_eq!(store.edits.len(Stack::Undo), 1);

    store.edit(
        &viewer(),
        vec![Op::Put(Patch::<Location> {
            id: 1,
            pitch: Some(5.0),
            ..Default::default()
        })],
        false,
        &mut None,
    );
    let row = store
        .collect(
            &Target::Map,
            &crate::selections::Selector::Locations {
                locations: vec![1],
                name: None,
            },
        )
        .into_iter()
        .next()
        .unwrap();
    assert_eq!((row.heading, row.pitch), (90.0, 5.0));
    assert_eq!(store.edits.len(Stack::Undo), 1);

    press_undo(&mut store);
    let row = store
        .collect(
            &Target::Map,
            &crate::selections::Selector::Locations {
                locations: vec![1],
                name: None,
            },
        )
        .into_iter()
        .next()
        .unwrap();
    assert_eq!((row.heading, row.pitch), (0.0, 0.0));
}

#[test]
fn dropping_a_pending_layer_discards_what_it_held() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    store.next_id = 2;
    store.edit(&viewer(), vec![Op::Put(heading(1, 90.0))], false, &mut None);
    store.drop_pending("viewer");
    assert_eq!(
        store
            .collect(
                &viewer(),
                &crate::selections::Selector::Locations {
                    locations: vec![1],
                    name: None
                }
            )
            .into_iter()
            .next()
            .unwrap()
            .heading,
        0.0
    );
}

#[test]
fn adds_into_a_pending_layer_take_real_ids_and_land_on_save() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    store.next_id = 2;
    let r = store.edit(&viewer(), vec![Op::Set(loc(0, 2.0, 2.0))], false, &mut None);
    assert_eq!(r.added, vec![2]);
    assert!(store
        .collect(
            &Target::Map,
            &crate::selections::Selector::Locations {
                locations: vec![2],
                name: None
            }
        )
        .into_iter()
        .next()
        .is_none());
    assert_eq!(
        store
            .collect(
                &viewer(),
                &crate::selections::Selector::Locations {
                    locations: vec![2],
                    name: None
                }
            )
            .into_iter()
            .next()
            .unwrap()
            .lat,
        2.0
    );

    store.edit(&viewer(), vec![], true, &mut None);
    assert_eq!(
        store
            .collect(
                &Target::Map,
                &crate::selections::Selector::Locations {
                    locations: vec![2],
                    name: None
                }
            )
            .into_iter()
            .next()
            .unwrap()
            .lat,
        2.0
    );
}

#[test]
fn every_landed_change_reaches_the_change_feed_and_held_edits_do_not() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    store.next_id = 2;
    let got = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let sink = {
        let got = got.clone();
        tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(s) = body {
                got.lock().unwrap().push(s);
            }
            Ok(())
        })
    };
    store.changes.insert("win".into(), sink);

    apply_updates(&mut store, &[patch!(1; heading: 90.0)], &mut None);
    store.edit(&viewer(), vec![Op::Put(heading(1, 45.0))], false, &mut None);
    undo_and_finish(&mut store);

    let events: Vec<serde_json::Value> = got
        .lock()
        .unwrap()
        .iter()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(
        events.len(),
        2,
        "one per landed change; the held edit is silent"
    );
    assert_eq!(events[0]["updated"], serde_json::json!([1]));
    assert_eq!(events[1]["updated"], serde_json::json!([1]));
    assert!(events[1]["version"].as_u64() > events[0]["version"].as_u64());
}

#[test]
fn an_answers_keys_computed_from_a_moved_input_are_dropped_at_delivery() {
    let mut store = setup_store_with(&[]);
    store.derived = std::sync::Arc::new(HashMap::from([(
        "panoId".to_string(),
        vec!["countryCode".to_string()],
    )]));
    let read = Location {
        pano_id: Some("old".into()),
        ..loc(1, 0.0, 0.0)
    };
    let now = Location {
        pano_id: Some("new".into()),
        ..loc(1, 0.0, 0.0)
    };
    let answer = || Patch::<Location> {
        id: 1,
        heading: Some(2.0),
        extra: RawExtra::from_map(
            serde_json::json!({ "countryCode": "FR", "altitude": 9 })
                .as_object()
                .unwrap(),
        )
        .into(),
        ..Default::default()
    };

    let kept = store.retain_valid_outputs(answer(), &read, &now);
    let mma_algebra::Field::Set(extra) = kept.extra else {
        panic!("the fresh output is kept");
    };
    let extra = extra.to_map();
    assert!(extra.get("countryCode").is_none());
    assert_eq!(extra.get("altitude"), Some(&serde_json::json!(9)));
    assert_eq!(kept.heading, Some(2.0));

    let same = store.retain_valid_outputs(answer(), &read, &read);
    let mma_algebra::Field::Set(extra) = same.extra else {
        panic!("nothing went stale");
    };
    assert!(extra.to_map().contains_key("countryCode"));

    let all_stale = Patch::<Location> {
        id: 1,
        extra: RawExtra::from_map(
            serde_json::json!({ "countryCode": "FR" })
                .as_object()
                .unwrap(),
        )
        .into(),
        ..Default::default()
    };
    assert_eq!(
        store.retain_valid_outputs(all_stale, &read, &now).extra,
        mma_algebra::Field::Keep
    );
}

fn tag_records(store: &Store) -> HashMap<u32, ValueRecord> {
    store
        .value_meta
        .get("tags")
        .map(|m| (**m).clone())
        .unwrap_or_default()
}

fn tag_update(id: u32, key: &str, value: serde_json::Value) -> FieldValuesPatch {
    let mut rec = ValueRecord::new();
    rec.insert("id".into(), id.into());
    rec.insert(key.into(), value);
    FieldValuesPatch {
        update: vec![rec],
        ..Default::default()
    }
}

#[test]
fn every_tag_record_edit_is_one_undo_step_restoring_the_exact_prior_records() {
    let mut store = setup_store_with(&[]);
    let mut states = vec![tag_records(&store)];
    let ids = store
        .patch_field_values("tags", &creates(&["A", "B"]))
        .unwrap()
        .resolved;
    states.push(tag_records(&store));
    for patch in [
        tag_update(ids[0], "name", "Alpha".into()),
        tag_update(ids[1], "color", "#123456".into()),
        FieldValuesPatch {
            reorder: Some(vec![ids[1], ids[0]]),
            ..Default::default()
        },
    ] {
        store.patch_field_values("tags", &patch).unwrap();
        states.push(tag_records(&store));
    }
    assert_eq!(store.edits.len(Stack::Undo), 4);

    for expected in states.iter().rev().skip(1) {
        undo_and_finish(&mut store);
        assert_eq!(&tag_records(&store), expected);
    }
    press_redo(&mut store);
    assert_eq!(tag_records(&store), states[1]);
}

#[test]
fn undoing_a_rename_collision_restores_records_and_rows_together() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 1.0, 1.0)]);
    let ids = store
        .patch_field_values("tags", &creates(&["A", "B"]))
        .unwrap()
        .resolved;
    let (a, b) = (ids[0], ids[1]);
    tag_onto(&mut store, a, &[1, 2]);
    tag_onto(&mut store, b, &[2]);
    let records = tag_records(&store);

    let mut merge = tag_update(a, "name", "b".into());
    merge
        .update
        .extend(tag_update(b, "color", "#abcdef".into()).update);
    store.patch_field_values("tags", &merge).unwrap();
    assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![b]);
    assert_eq!(tag_records(&store)[&b]["color"], "#abcdef");

    undo_and_finish(&mut store);
    assert_eq!(tag_records(&store), records);
    assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![a]);
    assert_eq!(store.get_loc_by_id(2).unwrap().tags, vec![a, b]);
}

#[test]
fn undoing_a_landing_removes_the_tags_it_interned() {
    let mut store = setup_store_with(&[]);
    let before = tag_records(&store);
    crate::io::import::add_copied_to_store(
        &mut store,
        vec![loc_with_tags(0, 1.0, 1.0, vec![5])],
        vec![(5, seed("Fresh"))],
    )
    .unwrap();
    let interned = tag_records(&store);
    assert!(interned.values().any(|r| record_name(r) == Some("Fresh")));

    undo_and_finish(&mut store);
    assert_eq!(tag_records(&store), before);
    assert_eq!(*store.alive_count, 0);

    press_redo(&mut store);
    assert_eq!(tag_records(&store), interned);
}

#[test]
fn an_entry_round_trips_through_stored_history_with_its_record_changes() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    let ids = store
        .patch_field_values("tags", &creates(&["A"]))
        .unwrap()
        .resolved;
    tag_onto(&mut store, ids[0], &[1]);
    store
        .patch_field_values("tags", &tag_update(ids[0], "color", "#010203".into()))
        .unwrap();
    let held: Vec<(u64, Entry)> = store
        .edits
        .iter()
        .map(|(_, e)| (e.seq, (**e.entry.as_ref().unwrap()).clone()))
        .collect();
    assert!(held.iter().any(|(_, e)| !e.piles.is_empty()));
    with_history_db(|conn| {
        save_edit_history(conn, "m", &store.edits).unwrap();
        for (seq, entry) in &held {
            assert_eq!(&load_edit(conn, "m", *seq).unwrap(), entry);
        }
    });
}

#[test]
fn a_value_ships_dark_when_it_empties_and_gone_when_its_record_goes() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 1.0, 1.0)]);
    let ids = store
        .patch_field_values("tags", &creates(&["A", "B"]))
        .unwrap()
        .resolved;
    let (a, b) = (ids[0], ids[1]);
    tag_onto(&mut store, a, &[1]);
    tag_onto(&mut store, b, &[1, 2]);
    let feed = FeedCapture::attach(&mut store);

    set_tags(&mut store, &[], &[b], &[1]);
    let count = |id: u32| shipped_count(&feed.last().derived, "tags", &id.to_string());
    assert_eq!(count(b), Some(1), "b still holds row 2");

    set_tags(&mut store, &[], &[a], &[1]);
    assert_eq!(count(a), Some(0));
    assert!(
        shipped_record(&feed.last().derived, "tags", a).is_some(),
        "a lingers dark"
    );

    let c = store
        .patch_field_values("tags", &creates(&["C"]))
        .unwrap()
        .resolved[0];
    assert!(shipped_record(&feed.last().derived, "tags", c).is_some());
    undo_and_finish(&mut store);
    let gone = feed.last().derived.field_values.unwrap()["tags"][&c.to_string()].is_none();
    assert!(gone, "an undone create's value is gone");
}

fn labelled_def(key: &str) -> maps::FieldDef {
    maps::FieldDef {
        label: Some(key.to_uppercase()),
        ..def_of(key)
    }
}

#[test]
fn renaming_a_field_moves_its_rows_and_definition_in_one_undoable_step() {
    let mut store = setup_store_with(&[
        loc_with_extra(1, r#"{"a":1}"#),
        loc_with_extra(2, r#"{"a":2}"#),
    ]);
    store
        .meta
        .edit()
        .extra
        .fields
        .insert("a".into(), labelled_def("a"));
    let steps = store.edits.len(Stack::Undo);

    let rename = Work::Rows(move_op("a", "b", MergeWinner::From));
    apply_work(&mut store, &Selector::Everything, &rename).unwrap();
    assert_eq!(store.edits.len(Stack::Undo), steps + 1);
    assert!(!store.meta.extra.fields.contains_key("a"));
    assert_eq!(store.meta.extra.fields["b"], labelled_def("a"));

    undo_and_finish(&mut store);
    assert_eq!(store.meta.extra.fields["a"], labelled_def("a"));
    assert!(!store.meta.extra.fields.contains_key("b"));
    let row = store.get_loc_by_id(1).unwrap().extra.unwrap().to_map();
    assert!(row.contains_key("a") && !row.contains_key("b"));
}

#[test]
fn a_field_loses_its_definition_only_when_no_row_holds_it() {
    let mut store = setup_store_with(&[
        loc_with_extra(1, r#"{"a":1}"#),
        loc_with_extra(2, r#"{"a":2}"#),
    ]);
    store
        .meta
        .edit()
        .extra
        .fields
        .insert("a".into(), labelled_def("a"));
    let one = Selector::Locations {
        locations: vec![1],
        name: None,
    };
    apply_work(&mut store, &one, &Work::Rows(del_op(&["a"]))).unwrap();
    assert_eq!(store.meta.extra.fields["a"], labelled_def("a"));

    apply_work(
        &mut store,
        &Selector::Everything,
        &Work::Rows(del_op(&["a"])),
    )
    .unwrap();
    assert!(!store.meta.extra.fields.contains_key("a"));
    undo_and_finish(&mut store);
    assert_eq!(store.meta.extra.fields["a"], labelled_def("a"));
}

#[test]
fn a_stored_edit_keeps_its_definition_moves() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::store::storage::run_migrations_on(&conn).unwrap();
    conn.execute(
        "INSERT INTO maps (id, name, settings, created_at, updated_at) VALUES ('m', '', '{}', '', '')",
        [],
    )
    .unwrap();
    let mut store = setup_store_with(&[loc_with_extra(1, r#"{"a":1}"#)]);
    store
        .meta
        .edit()
        .extra
        .fields
        .insert("a".into(), labelled_def("a"));
    let rename = Work::Rows(move_op("a", "b", MergeWinner::From));
    apply_work(&mut store, &Selector::Everything, &rename).unwrap();
    let (_, newest) = store.edits.iter().last().unwrap();
    let held = (**newest.entry.as_ref().unwrap()).clone();
    assert!(!held.defs.is_empty());

    save_edit_history(&conn, "m", &store.edits).unwrap();
    assert_eq!(load_edit(&conn, "m", newest.seq).unwrap(), held);
}

// -----------------------------------------------------------------------
// Pick queries, spacing, and initial field values
// -----------------------------------------------------------------------

#[test]
fn a_pick_node_reads_only_its_child_and_clips_to_the_outer_scope() {
    let locs: Vec<Location> = (1..=10).map(|i| loc(i, 0.0, i as f64 * 0.001)).collect();
    let mut store = setup_store_with(&locs);
    let child = Some(Box::new(Selection::of(Selector::Manual {
        locations: vec![1, 2, 3, 4, 5],
    })));
    let picks = [
        Selector::Sample {
            selection: child.clone(),
            n: 3,
        },
        Selector::Spaced {
            selection: child.clone(),
            thin: Thinning::Count { n: 3 },
        },
        Selector::EvenlySpaced {
            selection: child.clone(),
            thin: Thinning::Metres { m: 100.0 },
        },
        Selector::Nearby {
            selection: child.clone(),
            lat: 0.0,
            lng: 0.0,
            radius_m: 1e7,
        },
        Selector::Nearest {
            selection: child.clone(),
            lat: 0.0,
            lng: 0.01,
        },
    ];
    for pick in picks {
        let ids = store.scope(&pick).ids();
        assert!(!ids.is_empty());
        assert!(ids.iter().all(|id| id <= 5), "a pick reads only its child");
        let outer = Selector::all([
            Selector::Manual {
                locations: vec![4, 5, 6],
            },
            pick,
        ]);
        let clipped = store.scope(&outer).ids();
        assert!(clipped.iter().all(|id| id == 4 || id == 5));
    }
    let nearest = Selector::Nearest {
        selection: child,
        lat: 0.0,
        lng: 0.01,
    };
    assert_eq!(
        store.scope(&nearest).ids().iter().collect::<Vec<_>>(),
        vec![5],
        "the nearest row of the child, not of the map"
    );
}

#[test]
fn the_spacing_ask_answers_only_a_spaced_pick() {
    let locs: Vec<Location> = (1..=10).map(|i| loc(i, 0.0, i as f64 * 0.001)).collect();
    let mut store = setup_store_with(&locs);
    assert!(store
        .read(
            &crate::store::engine::Target::Map,
            &Selector::Everything,
            &Ask::Spacing
        )
        .is_err());
    let spaced = Selector::Spaced {
        selection: None,
        thin: Thinning::Count { n: 2 },
    };
    let answer = store
        .read(&crate::store::engine::Target::Map, &spaced, &Ask::Spacing)
        .unwrap();
    assert!(matches!(answer, Answer::Spacing { ref ids, .. } if ids.len() == 2));
}

#[test]
fn the_open_picture_ships_recordless_counts_and_dark_records_together() {
    let mut store = setup_store_with(&[loc_with_tags(1, 0.0, 0.0, vec![7])]);
    let dark = store
        .patch_field_values("tags", &creates(&["Dark"]))
        .unwrap()
        .resolved[0];
    let status = store.open_status();
    let values = status.derived.field_values.unwrap();
    let tags = &values["tags"];
    assert!(matches!(&tags["7"], Some(v) if v.record.is_none() && v.count == 1));
    assert!(matches!(&tags[&dark.to_string()], Some(v) if v.record.is_some() && v.count == 0));
}

// -----------------------------------------------------------------------
// The selection list the store holds
// -----------------------------------------------------------------------

#[test]
fn a_value_left_on_no_row_drops_the_selections_testing_it_and_ships_the_list() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, 10.1, 20.1)]);
    tag_onto(&mut store, 7, &[1]);
    tag_onto(&mut store, 8, &[2]);
    add_tag_selection(&mut store, 7, [1, 1, 1]);
    add_tag_selection(&mut store, 8, [2, 2, 2]);
    edit_selection_fixture(&mut store, |rows| rows[1].ghosted = true);
    store.resolve_selection_membership();
    let feed = FeedCapture::attach(&mut store);

    set_tags(&mut store, &[], &[7], &[1]);
    let keys: Vec<String> = store
        .selections
        .list()
        .into_iter()
        .map(|r| r.selection.key)
        .collect();
    assert_eq!(keys, vec!["tag:8"]);
    let shipped = feed.last().derived.selection_list.expect("the list ships");
    assert_eq!(shipped.len(), 1);

    set_tags(&mut store, &[], &[8], &[2]);
    assert!(store.selections.is_empty(), "a ghosted selection goes too");
}

#[test]
fn a_selection_testing_an_interned_value_paints_in_its_records_color() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0)]);
    let t = store
        .patch_field_values("tags", &creates(&["A"]))
        .unwrap()
        .resolved[0];
    tag_onto(&mut store, t, &[1]);
    add_tag_selection(&mut store, t, [9, 9, 9]);
    store.resolve_selection_membership();
    assert_eq!(
        store.scene_frame().palette,
        vec![[9, 9, 9]],
        "no record color: its own"
    );

    let mut patch = ValueRecord::new();
    patch.insert("id".into(), t.into());
    patch.insert("color".into(), "#ff8000".into());
    store
        .patch_field_values(
            "tags",
            &FieldValuesPatch {
                update: vec![patch],
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(store.scene_frame().palette, vec![[255, 128, 0]]);

    store.edit_selections(&crate::selections::tree::SelectionOp::Invert { path: vec![0] });
    assert_eq!(
        store.scene_frame().palette,
        vec![[255, 128, 0]],
        "an inverted test too"
    );
}

#[test]
fn merge_arbitrary_groups_is_one_undoable_write() {
    let rows = vec![
        loc_with_tags(1, 0.0, 0.0, vec![10]),
        loc_with_tags(2, 50.0, 50.0, vec![20]),
        loc(3, -50.0, -50.0),
        loc(4, 80.0, 80.0),
    ];
    let mut store = setup_store_with(&rows);
    let out = apply_work(
        &mut store,
        &Selector::Everything,
        &Work::Sets(SetOp::Merge {
            groups: vec![vec![1, 2, 2], vec![3, 4]],
            score: Some("-id".into()),
        }),
    )
    .unwrap();
    assert_eq!(out.changed, 4);
    assert_eq!(*store.alive_count, 2);
    assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![10, 20]);
    assert!(store.get_loc_by_id(3).is_some());
    assert_eq!(store.edits.len(Stack::Undo), 1);
    store
        .step(Stack::Undo, |_| panic!("resident undo entry"))
        .unwrap()
        .unwrap();
    for row in rows {
        assert_eq!(store.get_loc_by_id(row.id).unwrap(), row);
    }
}

#[test]
fn merge_groups_respects_scope_and_ignores_missing_members() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 1.0, 1.0), loc(3, 2.0, 2.0)]);
    let selector = Selector::Locations {
        locations: vec![1, 2],
        name: None,
    };
    apply_work(
        &mut store,
        &selector,
        &Work::Sets(SetOp::Merge {
            groups: vec![vec![1, 2, 3, 999]],
            score: Some("-id".into()),
        }),
    )
    .unwrap();
    assert!(store.get_loc_by_id(1).is_some());
    assert!(store.get_loc_by_id(2).is_none());
    assert!(store.get_loc_by_id(3).is_some());
}

#[test]
fn overlapping_merge_groups_fail_before_any_write() {
    let rows = vec![loc(1, 0.0, 0.0), loc(2, 1.0, 1.0), loc(3, 2.0, 2.0)];
    let mut store = setup_store_with(&rows);
    assert!(apply_work(
        &mut store,
        &Selector::Everything,
        &Work::Sets(SetOp::Merge {
            groups: vec![vec![1, 2], vec![2, 3]],
            score: None
        })
    )
    .is_err());
    assert_eq!(store.edits.len(Stack::Undo), 0);
    for row in rows {
        assert_eq!(store.get_loc_by_id(row.id).unwrap(), row);
    }
}

#[test]
fn metadata_edits_apply_and_ship_but_stay_out_of_history() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    let feed = FeedCapture::attach(&mut store);
    let before = (*store.meta).clone();
    let mut after = before.clone();
    after.name = "Renamed".into();
    store.write(
        [],
        &mut None,
        Entry {
            meta: mma_algebra::Change::from_iter([mma_algebra::Transition::new(
                Some(before.clone()),
                Some(after),
            )]),
            ..Default::default()
        },
    );
    assert_eq!(store.meta.name, "Renamed");
    assert_eq!(
        feed.last().derived.meta.unwrap().name.as_deref(),
        Some("Renamed")
    );
    assert_eq!(store.edits.len(Stack::Undo), 0, "meta edits never record");
}

#[test]
fn inferred_definitions_undo_and_redo_with_their_rows() {
    let mut store = setup_store_with(&[]);
    let mut row = loc(1, 0.0, 0.0);
    row.extra = RawExtra::from_map(&serde_json::Map::from_iter([("height".into(), 12.into())]));
    store.write([Op::Set(row)], &mut None, Entry::default());
    assert_eq!(
        store.meta.extra.fields["height"].field_type,
        maps::FieldType::Number
    );
    let entry = store
        .step(Stack::Undo, |_| panic!("in-memory edit"))
        .unwrap()
        .unwrap();
    store.finish_entry(&entry);
    assert!(!store.meta.extra.fields.contains_key("height"));
    assert!(store.get_loc_by_id(1).is_none());
    let entry = store
        .step(Stack::Redo, |_| panic!("in-memory edit"))
        .unwrap()
        .unwrap();
    store.finish_entry(&entry);
    assert!(store.meta.extra.fields.contains_key("height"));
    assert!(store.get_loc_by_id(1).is_some());
}

#[test]
fn selection_pruning_is_part_of_the_row_edit_and_undo_restores_it() {
    let mut store = setup_store_with(&[loc_with_tags(1, 0.0, 0.0, vec![7])]);
    let input = crate::selections::tree::SelectionInput {
        selector: Selector::Filter {
            field: "tags".into(),
            test: selections::FilterOp::Contains { value: 7.into() },
        },
        color: None,
    };
    store.edit_selections(&crate::selections::tree::SelectionOp::Add {
        selections: vec![input],
    });
    let before = store.selections.list();
    let mut row = store.get_loc_by_id(1).unwrap();
    row.tags.clear();
    store.write([Op::Set(row)], &mut None, Entry::default());
    assert!(store.selections.list().is_empty());
    assert!(store.selections.ids.is_empty());
    let entry = store
        .step(Stack::Undo, |_| panic!("in-memory edit"))
        .unwrap()
        .unwrap();
    store.finish_entry(&entry);
    assert_eq!(store.selections.list(), before);
    assert!(store.selections.ids.contains(1));
}

#[test]
fn clearing_the_selection_list_clears_membership_and_preserves_data_history() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    store.edit_selections(&crate::selections::tree::SelectionOp::Add {
        selections: vec![crate::selections::tree::SelectionInput {
            selector: Selector::Everything,
            color: None,
        }],
    });
    store.edit_selections(&crate::selections::tree::SelectionOp::Set { selections: vec![] });
    assert!(store.selections.ids.is_empty());
    assert!(store.selections.node_counts.is_empty());
    assert_eq!(
        store.edits.len(Stack::Undo),
        0,
        "selection edits never record"
    );
}

#[test]
fn indexed_proximity_respects_the_scope_and_pending_reads_use_overlaid_rows() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 40.0, 40.0)]);
    let ask = Ask::NearAny {
        lats: vec![0.0, 40.0],
        lngs: vec![0.0, 40.0],
        radius_m: 10.0,
    };
    let pick = Selector::Locations {
        locations: vec![2],
        name: None,
    };
    assert!(
        matches!(store.read(&Target::Map, &pick, &ask).unwrap(), Answer::NearAny { values } if values == vec![false, true])
    );
    let pending = Target::Pending {
        name: "test".into(),
    };
    store.edit(&pending, vec![Op::Set(loc(2, 0.0, 0.0))], false, &mut None);
    assert!(
        matches!(store.read(&pending, &pick, &ask).unwrap(), Answer::NearAny { values } if values == vec![true, false])
    );
    assert_eq!(store.get_loc_by_id(2).unwrap().lat, 40.0);
}

fn edit_selection_fixture(store: &mut Store, edit: impl FnOnce(&mut Vec<ListedSelection>)) {
    let delta = store.selections.change(&Default::default(), |mut rows| {
        edit(&mut rows);
        rows
    });
    store.selections.apply(&delta);
}

fn coverage(store: &mut Store, selector: &Selector) -> Vec<(String, u32)> {
    let Answer::Coverage { coverage } = store.read(&Target::Map, selector, &Ask::Coverage).unwrap()
    else {
        panic!("coverage answer")
    };
    coverage
}

fn near_any(store: &mut Store, lat: f64, lng: f64, radius_m: f64) -> bool {
    let ask = Ask::NearAny {
        lats: vec![lat],
        lngs: vec![lng],
        radius_m,
    };
    let Answer::NearAny { values } = store
        .read(&Target::Map, &Selector::Everything, &ask)
        .unwrap()
    else {
        panic!("near-any answer")
    };
    values[0]
}

#[test]
fn field_access_preserves_request_order_and_builds_presence_for_unbounded_fields() {
    let mut store = setup_store_with(&[loc_with_extra(1, r#"{"note":"hello"}"#), loc(2, 1.0, 1.0)]);
    assert!(store.fields(std::iter::empty()).is_empty());
    let fields = store.fields(["note", "tags", "note"]);
    assert_eq!(
        fields.iter().map(|field| field.field()).collect::<Vec<_>>(),
        ["note", "tags", "note"]
    );
    assert_eq!(
        fields[0].count("hello"),
        0,
        "unbounded values are not enumerated"
    );
    drop(fields);
    assert!(store.field_indexes["note"].rows.contains(1));
    assert!(!store.field_indexes["note"].rows.contains(2));
    assert!(store.field_indexes["note"].by_value.is_empty());
    let first = &store.field_indexes["note"] as *const _;
    let _ = store.fields(["note"]);
    assert_eq!(
        first, &store.field_indexes["note"] as *const _,
        "a repeat read reuses the index"
    );
}

#[test]
fn redo_reapplies_a_bulk_tag_removal() {
    let rows: Vec<Location> = (1..=12)
        .map(|id| loc_with_tags(id, 0.0, 0.0, vec![10]))
        .collect();
    let mut store = setup_store_with(&rows);
    assert_eq!(tag_count(&mut store, 10), 12);

    let removed: Vec<u32> = (1..=6).collect();
    apply_work(
        &mut store,
        &Selector::Locations {
            locations: removed,
            name: None,
        },
        &Work::Rows(RowOp::ListSet {
            key: "tags".into(),
            add: vec![],
            remove: vec![serde_json::json!(10)],
        }),
    )
    .unwrap();
    assert_eq!(tag_count(&mut store, 10), 6);

    undo_and_finish(&mut store);
    assert_eq!(tag_count(&mut store, 10), 12);

    let changes = store.step(Stack::Redo, fetch_stored).unwrap().unwrap();
    store.finish_entry(&changes);
    assert_eq!(tag_count(&mut store, 10), 6, "redo re-applies the removal");
}

#[test]
fn redo_reapplies_a_row_removal_to_the_tag_counts() {
    let rows: Vec<Location> = (1..=12)
        .map(|id| loc_with_tags(id, 0.0, 0.0, vec![10]))
        .collect();
    let mut store = setup_store_with(&rows);
    assert_eq!(tag_count(&mut store, 10), 12);

    let removes = (1..=6).map(Op::Remove);
    store.write(removes, &mut None, Entry::default());
    assert_eq!(tag_count(&mut store, 10), 6);

    undo_and_finish(&mut store);
    assert_eq!(tag_count(&mut store, 10), 12);

    let feed = FeedCapture::attach(&mut store);
    let changes = store.step(Stack::Redo, fetch_stored).unwrap().unwrap();
    store.finish_entry(&changes);
    assert_eq!(tag_count(&mut store, 10), 6, "redo re-removes the rows");
    let shipped = feed.last().derived.field_values;
    let count = shipped
        .as_ref()
        .and_then(|f| f.get("tags"))
        .and_then(|v| v.get("10"))
        .and_then(|h| h.as_ref().map(|h| h.count));
    assert_eq!(count, Some(6), "the redo event ships the moved tag count");
}

#[test]
fn selections_and_meta_only_edits_stay_out_of_data_history() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    store.next_id = 2;
    click_add(&mut store, 1.0, 1.0);
    press_undo(&mut store);
    assert_eq!(store.edits.len(Stack::Redo), 1);

    store.edit_selections(&crate::selections::tree::SelectionOp::Set { selections: vec![] });
    assert_eq!(store.edits.len(Stack::Undo), 0, "no entry recorded");
    assert_eq!(
        store.edits.len(Stack::Redo),
        1,
        "redo survives a selection edit"
    );
}

#[test]
fn reselect_restores_the_cleared_list_after_data_edits_without_touching_history() {
    use crate::selections::tree::{SelectionInput, SelectionOp};
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 1.0, 1.0)]);
    let feed = FeedCapture::attach(&mut store);
    store.edit_selections(&SelectionOp::Set {
        selections: vec![
            SelectionInput {
                selector: Selector::Everything,
                color: Some([1, 2, 3]),
            },
            SelectionInput {
                selector: Selector::Locations {
                    locations: vec![1],
                    name: None,
                },
                color: Some([4, 5, 6]),
            },
        ],
    });
    store.edit_selections(&SelectionOp::Ghost { index: 1 });
    let before = store.selections.list();
    store.edit_selections(&SelectionOp::Set { selections: vec![] });
    assert_eq!(
        feed.last().derived.history.unwrap()[&EntryKey::Selections].undo,
        true
    );
    store.edit_selections(&SelectionOp::Set { selections: vec![] });
    let mut row = store.get_loc_by_id(1).unwrap();
    row.heading = 90.0;
    store.write([Op::Set(row.clone())], &mut None, Entry::default());
    let undo = store.edits.len(Stack::Undo);
    step_selection(&mut store, Stack::Undo);
    assert_eq!(store.selections.list(), before);
    assert_eq!(store.get_loc_by_id(1).unwrap(), row);
    assert_eq!(store.edits.len(Stack::Undo), undo);
    assert_eq!(store.selections.ids, RoaringBitmap::from_iter([1, 2]));
    assert_eq!(
        feed.last().derived.history.unwrap()[&EntryKey::Selections].redo,
        true
    );
    press_undo(&mut store);
    assert_eq!(store.get_loc_by_id(1).unwrap().heading, 0.0);
    assert_eq!(store.selections.list(), before);
    store.edit_selections(&SelectionOp::Set { selections: vec![] });
    step_selection(&mut store, Stack::Undo);
    assert_eq!(store.edits.len(Stack::Redo), 1);
    press_redo(&mut store);
    assert_eq!(store.get_loc_by_id(1).unwrap(), row);
}

#[test]
fn selection_history_undoes_and_redoes_each_change_in_order() {
    use crate::selections::tree::SelectionOp;
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    assert!(store
        .step_key(Stack::Undo, EntryKey::Selections, fetch_stored)
        .unwrap()
        .is_none());
    store.edit_selections(&SelectionOp::Manual { id: 1 });
    let before = store.selections.list();
    store.edit_selections(&SelectionOp::Set { selections: vec![] });
    step_selection(&mut store, Stack::Undo);
    assert_eq!(store.selections.list(), before);
    step_selection(&mut store, Stack::Undo);
    assert!(store.selections.list().is_empty());
    step_selection(&mut store, Stack::Redo);
    assert_eq!(store.selections.list(), before);
    step_selection(&mut store, Stack::Redo);
    assert!(store.selections.list().is_empty());
    assert!(!setup_store_with(&[loc(1, 0.0, 0.0)])
        .history()
        .contains_key(&EntryKey::Selections));
}

#[test]
fn reselect_drops_deleted_tag_leaves_and_preserves_other_selections() {
    use crate::selections::tree::{SelectionInput, SelectionOp};
    let mut store = setup_store_with(&[loc_with_tags(1, 0.0, 0.0, vec![7])]);
    store.edit_selections(&SelectionOp::Set {
        selections: vec![
            SelectionInput {
                selector: Selector::Filter {
                    field: "tags".into(),
                    test: selections::FilterOp::Contains { value: 7.into() },
                },
                color: None,
            },
            SelectionInput {
                selector: Selector::Everything,
                color: None,
            },
        ],
    });
    store.edit_selections(&SelectionOp::Combine {
        mode: crate::selections::tree::Composition::Union,
        keys: None,
    });
    store.edit_selections(&SelectionOp::Set { selections: vec![] });
    let mut row = store.get_loc_by_id(1).unwrap();
    row.tags.clear();
    store.write([Op::Set(row)], &mut None, Entry::default());
    step_selection(&mut store, Stack::Undo);
    assert_eq!(store.selections.list().len(), 1);
    assert_eq!(
        store.selections.list()[0].selection.selector,
        Selector::Everything
    );
    assert!(store.selections.ids.contains(1));
}

#[test]
fn selection_undo_drops_a_cleared_list_whose_tags_have_all_disappeared() {
    use crate::selections::tree::{SelectionInput, SelectionOp};
    let mut store = setup_store_with(&[loc_with_tags(1, 0.0, 0.0, vec![7])]);
    let feed = FeedCapture::attach(&mut store);
    store.edit_selections(&SelectionOp::Set {
        selections: vec![SelectionInput {
            selector: Selector::Filter {
                field: "tags".into(),
                test: selections::FilterOp::Contains { value: 7.into() },
            },
            color: None,
        }],
    });
    store.edit_selections(&SelectionOp::Set { selections: vec![] });
    let mut row = store.get_loc_by_id(1).unwrap();
    row.tags.clear();
    store.write([Op::Set(row)], &mut None, Entry::default());
    step_selection(&mut store, Stack::Undo);
    assert!(store.selections.list().is_empty());
    assert_eq!(
        feed.last().derived.history.unwrap()[&EntryKey::Selections].redo,
        true
    );
}

fn step_selection(store: &mut Store, stack: Stack) {
    if let Some(entry) = store
        .step_key(stack, EntryKey::Selections, fetch_stored)
        .unwrap()
    {
        store.finish_entry(&entry);
    }
}

#[test]
fn delta_keys_follow_named_fields_and_only_report_populated_parts() {
    #[derive(Default, mma_fields::Delta)]
    struct Example<T: Default> {
        extra_rows: T,
        r#type: T,
    }
    #[derive(Default, mma_fields::Delta)]
    struct Empty {}
    assert!(Empty::default().keys().next().is_none());
    let mut change = Example::<mma_algebra::Change<Location>>::default();
    assert!(change.keys().next().is_none());
    change.extra_rows = Change::from_sides(vec![loc(1, 0.0, 0.0)], vec![]);
    assert_eq!(change.keys().collect::<Vec<_>>(), [ExampleKey::ExtraRows]);
    change.r#type = Change::from_sides(vec![loc(2, 1.0, 1.0)], vec![]);
    assert_eq!(
        change.keys().collect::<Vec<_>>(),
        [ExampleKey::ExtraRows, ExampleKey::Type]
    );
    assert_eq!(
        serde_json::to_string(&ExampleKey::ExtraRows).unwrap(),
        "\"extraRows\""
    );
    assert_eq!(
        serde_json::from_str::<ExampleKey>("\"type\"").unwrap(),
        ExampleKey::Type
    );
    assert_eq!(
        change.inverse().keys().collect::<Vec<_>>(),
        change.keys().collect::<Vec<_>>()
    );
}

#[test]
fn field_scoped_data_undo_keeps_the_whole_entry_atomic() {
    let mut store = setup_store_with(&[loc_with_tags(1, 0.0, 0.0, vec![7])]);
    store.edit_selections(&crate::selections::tree::SelectionOp::Set {
        selections: vec![crate::selections::tree::SelectionInput {
            selector: Selector::Filter {
                field: "tags".into(),
                test: selections::FilterOp::Contains { value: 7.into() },
            },
            color: None,
        }],
    });
    let before = store.selections.list();
    let mut row = store.get_loc_by_id(1).unwrap();
    row.tags.clear();
    store.write([Op::Set(row)], &mut None, Entry::default());
    let changes = store
        .step_key(Stack::Undo, EntryKey::Rows, fetch_stored)
        .unwrap()
        .unwrap();
    store.finish_entry(&changes);
    assert_eq!(store.get_loc_by_id(1).unwrap().tags, [7]);
    assert_eq!(store.selections.list(), before);
    assert!(store.history()[&EntryKey::Rows].redo);
}

#[test]
fn selection_key_never_replays_a_data_cascade_without_selection_history() {
    let mut store = setup_store_with(&[loc_with_tags(1, 0.0, 0.0, vec![7])]);
    edit_selection_fixture(&mut store, |rows| {
        rows.push(ListedSelection {
            selection: Selection::of(Selector::Filter {
                field: "tags".into(),
                test: selections::FilterOp::Contains { value: 7.into() },
            }),
            ghosted: false,
        })
    });
    let mut row = store.get_loc_by_id(1).unwrap();
    row.tags.clear();
    store.write([Op::Set(row)], &mut None, Entry::default());
    assert!(!store.history().contains_key(&EntryKey::Selections));
    assert!(store
        .step_key(Stack::Undo, EntryKey::Selections, fetch_stored)
        .unwrap()
        .is_none());
    assert!(store.get_loc_by_id(1).unwrap().tags.is_empty());
}

#[test]
fn persisted_history_reports_the_same_keys_without_loading_row_payloads() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    let mut row = store.get_loc_by_id(1).unwrap();
    row.heading = 45.0;
    store.write([Op::Set(row)], &mut None, Entry::default());
    let before = store.edits.availability();
    with_history_db(|conn| {
        save_edit_history(conn, "m", &store.edits).unwrap();
        let reopened = load_edit_history(conn, "m").unwrap();
        assert!(reopened.iter().all(|(_, edit)| edit.entry.is_none()));
        let after = reopened.availability();
        assert_eq!(
            before.keys().collect::<Vec<_>>(),
            after.keys().collect::<Vec<_>>()
        );
        assert_eq!(after[&EntryKey::Rows].undo, before[&EntryKey::Rows].undo);
        assert_eq!(after[&EntryKey::Rows].redo, before[&EntryKey::Rows].redo);
    });
}

fn black_tag_selected(store: &mut Store) -> u32 {
    let tag = store
        .patch_field_values("tags", &creates(&["2023"]))
        .unwrap()
        .resolved[0];
    store
        .patch_field_values("tags", &tag_update(tag, "color", "#000000".into()))
        .unwrap();
    add_rows(store, vec![loc_with_tags(0, 1.0, 1.0, vec![tag])]);
    store.edit_selections(&crate::selections::tree::SelectionOp::Add {
        selections: vec![crate::selections::tree::SelectionInput {
            selector: Selector::Filter {
                field: "tags".into(),
                test: selections::FilterOp::Contains { value: tag.into() },
            },
            color: None,
        }],
    });
    tag
}

#[test]
fn a_new_tag_selection_takes_its_tags_colour_everywhere_it_is_drawn() {
    let mut store = setup_store_with(&[]);
    let frames = watch(&mut store);
    black_tag_selected(&mut store);

    let frame = frames.last();
    assert_eq!(frame.palette, [[0, 0, 0]]);
    let section = frame
        .selection
        .expect("adding a selection restates membership");
    assert_eq!(
        section[4..7],
        [0, 0, 0],
        "the section paints what the palette says"
    );
    assert_eq!(store.selections.list()[0].selection.color, [0, 0, 0]);
}

#[test]
fn recolouring_a_selected_tag_repaints_its_markers() {
    let mut store = setup_store_with(&[]);
    let tag = black_tag_selected(&mut store);
    let frames = watch(&mut store);

    store
        .patch_field_values("tags", &tag_update(tag, "color", "#ff0000".into()))
        .unwrap();

    let frame = frames.last();
    assert_eq!(frame.palette, [[255, 0, 0]]);
    let section = frame
        .selection
        .expect("a recolour restates the painted rows");
    assert_eq!(section[4..7], [255, 0, 0]);
    assert_eq!(store.selections.list()[0].selection.color, [255, 0, 0]);
}

#[test]
fn a_created_tag_without_a_colour_gets_its_names() {
    let mut store = setup_store_with(&[]);
    let id = store
        .patch_field_values("tags", &creates(&["Urban"]))
        .unwrap()
        .resolved[0];
    assert_eq!(
        record_color(&tag_records(&store)[&id]),
        crate::util::hex_to_rgb(&crate::util::color_for_name("Urban"))
    );
}

#[test]
fn ensuring_a_colour_fills_only_a_colourless_record_and_reports_it() {
    let mut colourless = seed("Rural");
    assert!(ensure_color(&mut colourless));
    assert_eq!(
        colourless["color"],
        crate::util::color_for_name("Rural").as_str()
    );
    assert!(!ensure_color(&mut colourless), "nothing left to fill");

    let mut coloured = seed("Urban");
    coloured.insert("color".into(), "#123456".into());
    assert!(!ensure_color(&mut coloured));
    assert_eq!(coloured["color"], "#123456");
}

#[test]
fn a_key_an_op_cannot_write_fails_even_where_no_row_would_change() {
    let locs = [loc(1, 1.0, 1.0)];
    let err = plan_err(&locs, &del_op(&["tags"]));
    assert!(err.contains("'tags' cannot be removed"), "{err}");
}

#[test]
fn mixed_writes_keep_their_state_and_history_across_reopen_undo_redo_and_bake() {
    let mut store = setup_store_with(&[]);
    let first = click_add(&mut store, 10.0, 20.0);
    let second = click_add(&mut store, -5.0, 30.0);
    apply_updates(
        &mut store,
        &[patch!(first; lat: 11.0, heading: 270.0, tags: vec![3, 8])],
        &mut None,
    );
    delete_loc(&mut store, second);
    let expected = store_snapshot(&mut store);

    let mut reopened = close_and_reopen(&store);
    assert_eq!(
        store_snapshot(&mut reopened),
        expected,
        "delta sidecar restores current rows"
    );

    press_undo(&mut reopened);
    assert_eq!(
        reopened.get_loc_by_id(second).unwrap().lng,
        30.0,
        "undo after reopen restores the deleted row"
    );
    press_redo(&mut reopened);
    assert_eq!(
        store_snapshot(&mut reopened),
        expected,
        "redo after reopen restores final rows"
    );

    for _ in 0..reopened.edits.len(Stack::Undo) {
        press_undo(&mut reopened);
    }
    assert!(
        store_snapshot(&mut reopened).is_empty(),
        "full undo reaches the empty start"
    );
    for _ in 0..reopened.edits.len(Stack::Redo) {
        press_redo(&mut reopened);
    }
    assert_eq!(
        store_snapshot(&mut reopened),
        expected,
        "full redo reaches the saved end"
    );
    assert_bake_sorted(&mut reopened);
    assert_eq!(
        store_snapshot(&mut reopened),
        expected,
        "bake preserves the rows"
    );
}

#[path = "engine/operation_sequences.test.rs"]
mod operation_sequences;
