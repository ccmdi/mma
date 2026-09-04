#![allow(clippy::needless_pass_by_value)]
use super::*;
use crate::io::export;
use crate::selections::field_expr;
use crate::selections::field_expr::Expr;
use crate::selections::{self, Selection, Selector};
use crate::store::arrow::empty_batch;
use crate::store::commands::rows_file_path;
use crate::test_util::Fx;
use crate::test_util::TempDir;
use crate::test_util::{loc, patch};
use crate::types::RawExtra;
use crate::types::Tag;
use proptest::collection;
use proptest::prelude::ProptestConfig;
use proptest::strategy::Strategy;
use std::array;
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::panic;
use std::path::Path;
use std::slice;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

fn loc_with_tags(id: u32, lat: f64, lng: f64, tags: Vec<u32>) -> Location {
    Location {
        tags,
        ..loc(id, lat, lng)
    }
}

/// Member count for a registered tag, `None` when the tag isn't in the registry.
fn tag_count(store: &Store, id: u32) -> Option<usize> {
    store
        .tags
        .all
        .contains_key(&id)
        .then(|| store.tag_count(id))
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
    store.map_id = Some(format!("test-{}", SEQ.fetch_add(1, Ordering::Relaxed)));
    store.batch = Some(empty_batch());
    for l in locs {
        store.add_tag_counts(slice::from_ref(l));
        store.overlay_add(vec![l.clone()]);
        let ci = render_cell_idx(l.lat, l.lng);
        store.cell_add_render(ci, l.id);
    }
    store.alive_count = locs.len();
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
    assert_eq!(store.alive_count, 1);
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
    assert_eq!(store.alive_count, 1001);
    assert_eq!(store.get_loc_by_id(1).unwrap().lat, 1.0);
    assert_eq!(store.get_loc_by_id(1000).unwrap().lat, 0.0);
    assert_eq!(store.get_loc_by_id(1001).unwrap().lat, 1.0);
}

#[test]
fn undo_of_a_page_keeps_the_overlay_sorted() {
    let rows: Vec<Location> = (1..=2000).map(|i| loc(i, 0.0, 0.0)).collect();
    let mut store = setup_store_with(&rows);
    let before: Vec<Location> = rows[499..1499].to_vec();
    let after: Vec<Location> = before.iter().map(|l| loc(l.id, 5.0, 0.0)).collect();
    store.apply_undoable(before, after);
    assert_eq!(store.get_loc_by_id(700).unwrap().lat, 5.0);

    let entry = store.edits.undo.pop().unwrap();
    store.apply_edit_reverse(&entry);
    let ids: Vec<u32> = store.overlay.adds.iter().map(|l| l.id).collect();
    assert_eq!(ids, (1..=2000).collect::<Vec<u32>>());
    assert_eq!(store.get_loc_by_id(700).unwrap().lat, 0.0);
    assert_eq!(store.alive_count, 2000);
}

#[test]
fn overlay_remove_decrements_alive_count() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    assert_eq!(store.alive_count, 1);
    store.overlay_remove(&[l]);
    assert_eq!(store.alive_count, 0);
}

#[test]
fn overlay_remove_makes_get_return_none() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    store.overlay_remove(&[l]);
    assert!(store.get_loc_by_id(1).is_none());
}

#[test]
fn overlay_update_changes_fields() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    store.overlay_update(1, &patch!(lat: 50.0, heading: 90.0));
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
    store.overlay_update(1, &patch!(extra: raw_extra(r#"{"b":3,"c":4}"#)));
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
    store.overlay_update(1, &patch!(extra: raw_extra(r#"{"a":null}"#)));
    let got = store.get_loc_by_id(1).unwrap().extra.unwrap();
    assert_eq!(got.get("a"), None);
    assert_eq!(got.get("b"), Some(serde_json::json!(2)));
}

#[test]
fn overlay_update_extra_creates_extra_when_none() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    store.overlay_update(1, &patch!(extra: raw_extra(r#"{"a":1}"#)));
    let got = store.get_loc_by_id(1).unwrap().extra.unwrap();
    assert_eq!(got.get("a"), Some(serde_json::json!(1)));
}

#[test]
fn overlay_update_extra_empty_after_deletes_is_none() {
    let mut l = loc(1, 10.0, 20.0);
    l.extra = raw_extra(r#"{"a":1}"#);
    let mut store = setup_store_with(&[l]);
    store.overlay_update(1, &patch!(extra: raw_extra(r#"{"a":null}"#)));
    assert!(store.get_loc_by_id(1).unwrap().extra.is_none());
}

#[test]
fn overlay_update_extra_top_level_null_clears() {
    let mut l = loc(1, 10.0, 20.0);
    l.extra = raw_extra(r#"{"a":1}"#);
    let mut store = setup_store_with(&[l]);
    store.overlay_update(1, &patch!(extra: None));
    assert!(store.get_loc_by_id(1).unwrap().extra.is_none());
}

#[test]
fn overlay_update_nonexistent_is_noop() {
    let mut store = setup_store_with(&[]);
    store.overlay_update(999, &patch!(lat: 50.0));
    assert!(store.get_loc_by_id(999).is_none());
}

#[test]
fn overlay_update_stamps_modified_at_on_session_added_row() {
    // Row lives in overlay.adds (not yet baked): an edit must stamp modified_at,
    // same as an edit to a committed base row.
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    assert!(store.get_loc_by_id(1).unwrap().modified_at.is_none());
    store.overlay_update(1, &patch!(lat: 50.0));
    assert!(store.get_loc_by_id(1).unwrap().modified_at.is_some());
}

#[test]
fn overlay_update_noop_does_not_stamp_session_added_row() {
    // A patch that changes nothing must not stamp (or it fabricates undo entries).
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    let rev = store.overlay.rev();
    store.overlay_update(1, &patch!(lat: 10.0));
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

    store.overlay_update(1, &patch!(lat: 10.0));

    assert_eq!(store.overlay.rev(), rev);
    assert!(!store.overlay.is_unsaved());
}

#[test]
fn overlay_update_stamps_modified_at_on_base_row() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    store.bake_overlay();
    store.overlay_update(1, &patch!(lat: 50.0));
    assert!(store.get_loc_by_id(1).unwrap().modified_at.is_some());
}

#[test]
fn overlay_update_returns_the_location_as_stored() {
    // The pair's `new` half feeds undo entries and selection membership re-tests, so it
    // must be exactly what the store now holds -- including the modified_at stamp.
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    store.bake_overlay();
    let (_, new_loc) = store.overlay_update(1, &patch!(lat: 50.0)).unwrap();
    assert!(new_loc.modified_at.is_some());
    assert_eq!(new_loc, store.get_loc_by_id(1).unwrap());
}

#[test]
fn overlay_update_noop_on_patched_row_stays_a_noop() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    store.bake_overlay();
    store.overlay_update(1, &patch!(lat: 50.0));
    // Re-applying the identical patch must return an equal pair (no undo entry) and leave
    // the stored row untouched.
    let stored = store.get_loc_by_id(1).unwrap();
    let rev = store.overlay.rev();
    let (old, new_loc) = store.overlay_update(1, &patch!(lat: 50.0)).unwrap();
    assert_eq!(old, new_loc);
    assert_eq!(store.get_loc_by_id(1).unwrap(), stored);
    assert_eq!(store.overlay.rev(), rev);
}

#[test]
fn collect_everything() {
    let locs = vec![loc(1, 10.0, 20.0), loc(2, 30.0, 40.0)];
    let store = setup_store_with(&locs);
    let all = store.collect(&Selector::Everything);
    assert_eq!(all.len(), 2);
}

#[test]
fn named_id_ordering_is_consumer_defined() {
    // Pins the documented divergence on `Selector::Locations`: `collect` honours the
    // caller's order and duplicates, set projections sort and dedup.
    let locs = vec![loc(3, 0.0, 0.0), loc(7, 1.0, 1.0)];
    let store = setup_store_with(&locs);
    let selector = Selector::Locations {
        locations: vec![7, 3, 3],
        name: None,
    };
    let rows: Vec<u32> = store.collect(&selector).iter().map(|l| l.id).collect();
    assert_eq!(rows, vec![7, 3, 3]);
    let view = store.loc_view();
    let set = selections::narrow(&view, &selector).unwrap();
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
    store.overlay_update(1, &patch!(lat: 5.0));
    let r2 = store.overlay.rev();
    assert!(r2 > r1);
    store.overlay_remove(&[store.get_loc_by_id(1).unwrap()]);
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
    store.overlay.touch(); // stale flag with no content must not re-bake
    store.bake_overlay();
    assert_eq!(store.batch.as_ref().unwrap().num_rows(), rows_before);
}

// -----------------------------------------------------------------------
// Commit diff (overlay-derived)
// -----------------------------------------------------------------------

#[test]
fn commit_diff_counts_session_adds() {
    let store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 1.0, 1.0)]);
    assert_eq!(store.overlay_diff_counts(), (2, 0, 0));
}

#[test]
fn commit_diff_counts_patch_on_base_row_without_undo() {
    // Pins the fix: an edit that never touches the undo stack (record_undo=false
    // paths) must still show up in the commit diff.
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    store.bake_overlay();
    assert_eq!(store.overlay_diff_counts(), (0, 0, 0));
    store.overlay_update(1, &patch!(lat: 5.0));
    assert!(store.edits.undo.is_empty());
    assert_eq!(store.overlay_diff_counts(), (0, 0, 1));
}

#[test]
fn commit_diff_counts_removed_base_row() {
    let l = loc(1, 0.0, 0.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    store.bake_overlay();
    store.overlay_remove(&[l]);
    assert_eq!(store.overlay_diff_counts(), (0, 1, 0));
}

#[test]
fn commit_diff_add_then_remove_is_noop() {
    let l = loc(1, 0.0, 0.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    store.overlay_remove(&[l]);
    assert_eq!(store.overlay_diff_counts(), (0, 0, 0));
}

// -----------------------------------------------------------------------
// Tag counts
// -----------------------------------------------------------------------

#[test]
fn tag_counts_after_add() {
    let l1 = loc_with_tags(1, 0.0, 0.0, vec![10, 20]);
    let l2 = loc_with_tags(2, 1.0, 1.0, vec![10]);
    let store = setup_store_with(&[l1, l2]);
    assert_eq!(tag_count(&store, 10), Some(2));
    assert_eq!(tag_count(&store, 20), Some(1));
}

#[test]
fn tag_counts_after_remove() {
    let l1 = loc_with_tags(1, 0.0, 0.0, vec![10, 20]);
    let l2 = loc_with_tags(2, 1.0, 1.0, vec![10]);
    let mut store = setup_store_with(&[l1.clone(), l2]);
    store.remove_tag_counts(&[l1]);
    assert_eq!(tag_count(&store, 10), Some(1));
    assert_eq!(tag_count(&store, 20), Some(0));
}

#[test]
fn tag_counts_saturate_at_zero() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(&[]);
    store.remove_tag_counts(&[l]);
    assert_eq!(tag_count(&store, 10), None);
}

// -----------------------------------------------------------------------
// Undo / Redo
// -----------------------------------------------------------------------

#[test]
fn undo_add() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    store.push_undo(EditEntry {
        created: vec![l.clone()],
        removed: vec![],
    });

    let _delta = store.apply_edit_reverse(&EditEntry {
        created: vec![l],
        removed: vec![],
    });
    assert_eq!(store.alive_count, 0);
    assert!(store.get_loc_by_id(1).is_none());
}

#[test]
fn undo_remove() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[]);
    // simulate: location was removed, undo should re-add it
    let _delta = store.apply_edit_reverse(&EditEntry {
        created: vec![],
        removed: vec![l.clone()],
    });
    assert_eq!(store.alive_count, 1);
    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 10.0);
}

#[test]
fn undo_update_restores_original() {
    let original = loc_with_heading(1, 10.0, 20.0, 0.0);
    let updated = loc_with_heading(1, 10.0, 20.0, 90.0);
    let mut store = setup_store_with(slice::from_ref(&updated));

    let entry = EditEntry {
        created: vec![updated],
        removed: vec![original.clone()],
    };
    store.apply_edit_reverse(&entry);

    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.heading, 0.0);
}

#[test]
fn redo_after_undo() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    let entry = EditEntry {
        created: vec![l.clone()],
        removed: vec![],
    };

    store.apply_edit_reverse(&entry);
    assert_eq!(store.alive_count, 0);

    store.apply_edit_forward(&entry);
    assert_eq!(store.alive_count, 1);
    assert!(store.get_loc_by_id(1).is_some());
}

#[test]
fn undo_stack_capped_at_max() {
    let mut store = setup_store_with(&[]);
    for i in 0..MAX_UNDO_ENTRIES + 50 {
        let l = loc(i as u32, 0.0, 0.0);
        store.push_undo(EditEntry {
            created: vec![l],
            removed: vec![],
        });
    }
    assert_eq!(store.edits.undo.len(), MAX_UNDO_ENTRIES);
}

#[test]
fn redo_stack_cleared_on_new_edit() {
    let mut store = setup_store_with(&[]);
    store.edits.redo.push(EditEntry {
        created: vec![],
        removed: vec![],
    });
    assert!(!store.edits.redo.is_empty());

    store.push_undo(EditEntry {
        created: vec![loc(1, 0.0, 0.0)],
        removed: vec![],
    });
    store.edits.redo.clear();
    assert!(store.edits.redo.is_empty());
}

// -----------------------------------------------------------------------
// Tag counts through undo/redo
// -----------------------------------------------------------------------

#[test]
fn tag_counts_correct_after_undo_add() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10, 20]);
    let mut store = setup_store_with(slice::from_ref(&l));
    assert_eq!(tag_count(&store, 10), Some(1));

    let entry = EditEntry {
        created: vec![l],
        removed: vec![],
    };
    store.apply_edit_reverse(&entry);
    assert_eq!(tag_count(&store, 10), Some(0));
}

#[test]
fn tag_counts_correct_after_undo_remove() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(&[]);
    assert_eq!(tag_count(&store, 10), None);

    let entry = EditEntry {
        created: vec![],
        removed: vec![l],
    };
    store.apply_edit_reverse(&entry);
    assert_eq!(tag_count(&store, 10), Some(1));
}

#[test]
fn tag_counts_correct_after_undo_tag_change() {
    let old = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let new = loc_with_tags(1, 0.0, 0.0, vec![20]);
    let mut store = setup_store_with(slice::from_ref(&new));
    store.tags.counts = Touched::default();
    store.add_tag_counts(slice::from_ref(&new));
    assert_eq!(tag_count(&store, 20), Some(1));
    assert_eq!(tag_count(&store, 10), None);

    let entry = EditEntry {
        created: vec![new],
        removed: vec![old],
    };
    store.apply_edit_reverse(&entry);

    assert_eq!(tag_count(&store, 10), Some(1));
    assert_eq!(tag_count(&store, 20), Some(0));
}

#[test]
fn tag_counts_survive_undo_redo_cycle() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(slice::from_ref(&l));
    let entry = EditEntry {
        created: vec![l.clone()],
        removed: vec![],
    };

    store.apply_edit_reverse(&entry);
    assert_eq!(tag_count(&store, 10), Some(0));

    store.apply_edit_forward(&entry);
    assert_eq!(tag_count(&store, 10), Some(1));
}

// -----------------------------------------------------------------------
// Render delta
// -----------------------------------------------------------------------

#[test]
fn delta_has_added_entry_for_new_location() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[]);
    let entry = EditEntry {
        created: vec![l],
        removed: vec![],
    };
    let delta = store.apply_edit_forward(&entry);
    assert_eq!(delta.added.len(), 1);
    assert_eq!(delta.added[0].id, 1);
    assert_eq!(delta.removed.len(), 0);
}

#[test]
fn delta_has_removed_entry_for_deleted_location() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    let entry = EditEntry {
        created: vec![],
        removed: vec![l],
    };
    let delta = store.apply_edit_forward(&entry);
    assert_eq!(delta.removed.len(), 1);
    assert_eq!(delta.removed[0], 1);
    assert_eq!(delta.added.len(), 0);
}

#[test]
fn delta_has_one_move_entry_for_moved_location() {
    let old = loc(1, 10.0, 20.0);
    let new = loc(1, -80.0, -170.0); // far enough to cross render cells
    let mut store = setup_store_with(slice::from_ref(&old));

    // A same-id remove+create is an update, so this is a move, not a delete plus a create.
    let entry = EditEntry {
        created: vec![new],
        removed: vec![old],
    };
    let changes = store.apply_edit_forward(&entry);
    let delta = store.derive_render_delta(&changes, &HashSet::new());

    assert!(delta.removed.is_empty(), "a move is not a removal");
    assert_eq!(delta.added.len(), 1);
    let from = delta.added[0]
        .moved_from
        .as_ref()
        .expect("carries the slot it vacated");
    assert_eq!(from.id, 1);
}

#[test]
fn delta_add_uses_configured_marker_color() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0)]);
    store.render.marker_color = [10, 20, 30];

    let entry = EditEntry {
        created: vec![loc(2, 30.0, 40.0)],
        removed: vec![],
    };
    let changes = store.apply_edit_forward(&entry);
    let delta = store.derive_render_delta(&changes, &HashSet::new());

    assert_eq!(delta.added.len(), 1);
    assert_eq!(
        delta.added[0].sel, None,
        "unselected, so the base layer draws it"
    );
}

// -----------------------------------------------------------------------
// "Samey locations" optimization: skip re-render when only non-render
// fields changed (e.g. pitch, zoom, tags, extra)
// -----------------------------------------------------------------------

#[test]
fn samey_location_skips_render_delta() {
    let old = loc(1, 10.0, 20.0);
    let mut new = loc(1, 10.0, 20.0);
    new.pitch = 45.0; // non-render field
    new.zoom = 3.0; // non-render field
    let mut store = setup_store_with(slice::from_ref(&old));

    let entry = EditEntry {
        created: vec![new],
        removed: vec![old],
    };
    let changes = store.apply_edit_forward(&entry);
    let delta = store.derive_render_delta(&changes, &HashSet::new());

    assert_eq!(
        delta.added.len(),
        0,
        "no re-render needed for pitch/zoom change"
    );
    assert_eq!(delta.removed.len(), 0);
    assert_eq!(delta.updated.len(), 0);
}

#[test]
fn samey_location_with_heading_change_does_rerender() {
    let old = loc_with_heading(1, 10.0, 20.0, 0.0);
    let new = loc_with_heading(1, 10.0, 20.0, 90.0);
    let mut store = setup_store_with(slice::from_ref(&old));

    let entry = EditEntry {
        created: vec![new],
        removed: vec![old],
    };
    let changes = store.apply_edit_forward(&entry);
    let delta = store.derive_render_delta(&changes, &HashSet::new());

    // heading change in the same cell => in-place render patch
    assert_eq!(
        delta.updated.len(),
        1,
        "heading change requires a render patch"
    );
    assert_eq!(delta.added.len(), 0);
    assert_eq!(delta.removed.len(), 0);
}

#[test]
fn samey_location_with_lat_change_does_rerender() {
    let old = loc(1, 10.0, 20.0);
    let new = loc(1, 11.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&old));

    let entry = EditEntry {
        created: vec![new],
        removed: vec![old],
    };
    let changes = store.apply_edit_forward(&entry);
    let delta = store.derive_render_delta(&changes, &HashSet::new());

    assert!(
        delta.added.len() + delta.removed.len() + delta.updated.len() > 0,
        "lat change requires re-render"
    );
}

#[test]
fn samey_tag_only_change_skips_render() {
    let old = loc_with_tags(1, 10.0, 20.0, vec![10]);
    let new = loc_with_tags(1, 10.0, 20.0, vec![20]);
    let mut store = setup_store_with(slice::from_ref(&old));

    let entry = EditEntry {
        created: vec![new],
        removed: vec![old],
    };
    let delta = store.apply_edit_forward(&entry);

    assert_eq!(delta.added.len(), 0, "tag-only change should skip render");
    assert_eq!(delta.removed.len(), 0);
}

// -----------------------------------------------------------------------
// store_status / finish_mutation
// -----------------------------------------------------------------------

#[test]
fn open_status_reflects_undo_redo() {
    let l = loc(1, 0.0, 0.0);
    let mut store = setup_store_with(&[l]);

    let s = store.open_status();
    assert!(!s.can_undo);
    assert!(!s.can_redo);

    store.push_undo(EditEntry {
        created: vec![],
        removed: vec![],
    });
    let s = store.open_status();
    assert!(s.can_undo);
    assert!(!s.can_redo);

    store.edits.redo.push(EditEntry {
        created: vec![],
        removed: vec![],
    });
    let s = store.open_status();
    assert!(s.can_undo);
    assert!(s.can_redo);
}

#[test]
fn finish_mutation_reports_correct_state() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(&[l]);
    store.push_undo(EditEntry {
        created: vec![],
        removed: vec![],
    });

    let result = store.finish_mutation(&ChangeSet::default());
    assert_eq!(result.location_count, Some(1));
    assert_eq!(result.can_undo, Some(true));
    assert_eq!(result.can_redo, None, "never true, so never reported");
    // Setup added tagged locations, so this first mutation ships counts.
    assert_eq!(result.tag_counts.as_ref().unwrap().get(&10), Some(&1));
    assert_eq!(result.version, 1);

    // Nothing moved since: the next result reports none of it again.
    let result = store.finish_mutation(&ChangeSet::default());
    assert_eq!(result.location_count, None);
    assert_eq!(result.can_undo, None);
}

#[test]
fn tag_counts_shipped_only_when_changed() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(slice::from_ref(&l));

    // Setup's add_tag_counts left counts dirty: first mutation ships them once.
    let result = store.finish_mutation(&ChangeSet::default());
    assert!(result.tag_counts.is_some());

    // A mutation that touches no tags must not ship counts.
    let result = store.finish_mutation(&ChangeSet::default());
    assert!(result.tag_counts.is_none());

    // A tag-touching edit ships fresh counts again.
    let changes = store.apply_edit(slice::from_ref(&l), &[]);
    let result = store.finish_mutation(&changes);
    assert_eq!(result.tag_counts.as_ref().unwrap().get(&10), Some(&0));
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
        &ChangeSet {
            added: vec![a],
            ..Default::default()
        },
        before,
    );
    assert!(
        store.bounds.is_some_and(|b| b.current(store.version)),
        "add carries the cache forward"
    );
    assert_eq!(store.cached_bounds(), Some([0.0, 0.0, 10.0, 10.0]));

    // Add inside the box -> no change.
    let b = loc(3, 5.0, 5.0);
    store.overlay_add(vec![b.clone()]);
    let before = store.version;
    store.bump();
    store.update_bounds(
        &ChangeSet {
            added: vec![b],
            ..Default::default()
        },
        before,
    );
    assert_eq!(store.cached_bounds(), Some([0.0, 0.0, 10.0, 10.0]));

    // Remove the extreme point -> invalidates, recompute shrinks the box.
    store.overlay_remove(&[loc(2, 10.0, 10.0)]);
    let before = store.version;
    store.bump();
    store.update_bounds(
        &ChangeSet {
            removed: vec![2],
            ..Default::default()
        },
        before,
    );
    assert!(
        !store.bounds.is_some_and(|b| b.current(store.version)),
        "removal leaves the cache behind"
    );
    assert_eq!(store.cached_bounds(), Some([0.0, 0.0, 5.0, 5.0]));

    // The cache must never diverge from a fresh O(N) compute.
    assert_eq!(store.cached_bounds(), store.compute_bounds(None));
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
    let (cell, idx) = store.cell_lookup(1).unwrap();
    assert_eq!(cell, "s");
    assert_eq!(idx, 0);
}

#[test]
fn cell_remove_returns_correct_info() {
    let mut store = setup_store_with(&[]);
    store.cell_add_render(24, 1);
    store.cell_add_render(24, 2);
    let removal = store.cell_remove_render(1).unwrap();
    assert_eq!(removal.id, 1);
    assert_eq!(removal.cell, "s");
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

#[test]
fn alloc_tag_id_increments() {
    let mut store = Store::new();
    let a = store.alloc_tag_id();
    let b = store.alloc_tag_id();
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
    store.overlay_update(1, &patch!(lat: 99.0));
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
    store.overlay_remove(&[l]);
    store.bake_overlay();
    assert_eq!(store.batch.as_ref().unwrap().num_rows(), 0);
}

// -----------------------------------------------------------------------
// Edge cases: no-op updates should not create undo entries
// (mirrors the filter in store_update_locations)
// -----------------------------------------------------------------------

#[test]
fn noop_update_produces_no_undo_entry() {
    let l = loc_with_heading(1, 10.0, 20.0, 45.0);
    let mut store = setup_store_with(slice::from_ref(&l));

    // "update" with identical values
    store.overlay_update(1, &patch!(heading: 45.0));
    let new = store.get_loc_by_id(1).unwrap();

    // simulate the filter from store_update_locations
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

    store.overlay_update(1, &patch!(heading: 90.0));
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
    store.overlay_update(1, &patch!(heading: 180.0));
    store.overlay_update(2, &patch!(heading: 90.0));
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
    let undo_len = store.edits.undo.len();
    let updates: Vec<Update<LocationPatch>> = rows
        .iter()
        .map(|row| Update {
            id: row.id,
            patch: patch!(heading: row.heading),
        })
        .collect();

    let result = apply_updates(&mut store, &updates, true);

    assert_eq!(store.overlay.rev(), rev);
    assert_eq!(store.edits.undo.len(), undo_len);
    assert!(result.delta.added.is_empty());
    assert!(result.delta.updated.is_empty());
    assert!(result.delta.removed.is_empty());
    assert!(result.selection_sync.is_none());
}

// -----------------------------------------------------------------------
// Edge case: re-add a previously removed ID
// -----------------------------------------------------------------------

#[test]
fn readd_after_remove_via_overlay() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    assert_eq!(store.alive_count, 1);

    store.overlay_remove(slice::from_ref(&l));
    assert_eq!(store.alive_count, 0);
    assert!(store.get_loc_by_id(1).is_none());

    // re-add with different position
    let l2 = loc(1, 50.0, 60.0);
    store.overlay_add(vec![l2]);
    assert_eq!(store.alive_count, 1);
    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 50.0);
}

#[test]
fn readd_after_remove_through_undo() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));

    // remove it
    let remove_entry = EditEntry {
        created: vec![],
        removed: vec![l.clone()],
    };
    store.apply_edit_forward(&remove_entry);
    assert_eq!(store.alive_count, 0);

    // undo the removal
    store.apply_edit_reverse(&remove_entry);
    assert_eq!(store.alive_count, 1);
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

    let removal = store.cell_remove_render(10).unwrap();
    assert_eq!(removal.cell_index, 0);

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

    let removal = store.cell_remove_render(20).unwrap();
    assert_eq!(removal.cell_index, 1);

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
    store.overlay_update(1, &patch!(heading: 90.0));
    assert_eq!(store.get_loc_by_id(1).unwrap().heading, 90.0);

    // undo: apply_edit should restore original via overlay
    let entry = EditEntry {
        created: vec![updated],
        removed: vec![l],
    };
    store.apply_edit_reverse(&entry);

    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.heading, 0.0, "undo should restore original heading");
}

#[test]
fn multiple_undo_redo_cycles_consistent() {
    let l = loc_with_tags(1, 10.0, 20.0, vec![10]);
    let mut store = setup_store_with(slice::from_ref(&l));

    let updated = loc_with_tags(1, 10.0, 20.0, vec![20]);
    let entry = EditEntry {
        created: vec![updated.clone()],
        removed: vec![l.clone()],
    };

    for _ in 0..5 {
        store.apply_edit_forward(&entry);
        assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![20]);
        assert_eq!(tag_count(&store, 20), Some(1));

        store.apply_edit_reverse(&entry);
        assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![10]);
        assert_eq!(tag_count(&store, 10), Some(1));
    }
}

// -----------------------------------------------------------------------
// derive_render_delta (updates)
// -----------------------------------------------------------------------

fn render_delta_for_update(store: &mut Store, id: u32, patch: LocationPatch) -> RenderDelta {
    let old = store.get_loc_by_id(id).unwrap();
    store.overlay_update(id, &patch);
    let new_loc = store.get_loc_by_id(id).unwrap();
    store.derive_render_delta(
        &ChangeSet {
            updated: vec![(old, new_loc)],
            ..Default::default()
        },
        &HashSet::new(),
    )
}

#[test]
fn update_delta_heading_only_produces_patch() {
    let l = loc_with_heading(1, 10.0, 20.0, 0.0);
    let mut store = setup_store_with(&[l]);
    let delta = render_delta_for_update(&mut store, 1, patch!(heading: 90.0));
    assert!(delta.added.is_empty());
    assert!(delta.removed.is_empty());
    assert_eq!(delta.updated.len(), 1);
    assert_eq!(delta.updated[0].heading, Some(0.0));
    assert!(delta.updated[0].lat.is_none());
}

#[test]
fn update_delta_same_cell_position_produces_patch() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    // small position change that stays in the same render cell
    let delta = render_delta_for_update(&mut store, 1, patch!(lat: 10.001));
    // should be an in-place patch, not a cell migration
    assert_eq!(delta.updated.len(), 1);
    assert!(delta.added.is_empty());
}

#[test]
fn update_delta_cross_cell_position_produces_one_move() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    // large position change that crosses render cells
    let delta = render_delta_for_update(&mut store, 1, patch!(lat: -80.0, lng: -170.0));
    assert!(delta.removed.is_empty(), "a move is not a removal");
    assert_eq!(delta.added.len(), 1, "new cell entry added");
    assert!(delta.updated.is_empty());

    let e = &delta.added[0];
    let from = e.moved_from.as_ref().expect("carries the slot it vacated");
    assert_eq!(from.id, 1);
    assert_ne!(
        from.cell, e.cell,
        "the vacated slot is in the cell it left, not the one it joined"
    );
}

#[test]
fn update_delta_tags_only_produces_empty_delta() {
    let l = loc_with_tags(1, 10.0, 20.0, vec![10]);
    let mut store = setup_store_with(&[l]);
    let delta = render_delta_for_update(&mut store, 1, patch!(tags: vec![20]));
    assert!(delta.added.is_empty());
    assert!(delta.removed.is_empty());
    assert!(delta.updated.is_empty());
}

// -----------------------------------------------------------------------
// overlay_update on items in overlay_adds (not yet baked)
// -----------------------------------------------------------------------

#[test]
fn overlay_update_on_overlay_add_item() {
    let mut store = setup_store_with(&[]);
    let l = loc(1, 10.0, 20.0);
    store.overlay_add(vec![l]);
    store.overlay_update(1, &patch!(lat: 50.0));
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
    store.overlay_remove(&[l1]);
    // patch l2
    store.overlay_update(2, &patch!(lat: 99.0));
    // add l4
    let l4 = loc(4, 70.0, 80.0);
    store.overlay_add(vec![l4]);
    store.alive_count = 3; // l2, l3, l4

    let all = store.collect(&Selector::Everything);
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
    store.overlay_remove(&[l1]);
    // patch: modify l2
    store.overlay_update(2, &patch!(heading: 180.0));
    // add: new l3
    let l3 = loc(3, 50.0, 60.0);
    store.overlay_add(vec![l3]);
    store.alive_count = 2; // l2, l3

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
// Overlay (.delta sidecar) msgpack round-trip
// -----------------------------------------------------------------------

/// The overlay shape a delta file carries: adds, dead ids, patches keyed by id.
fn delta_overlay(adds: Vec<Location>, dead: &[u32], patches: Vec<Location>) -> Overlay {
    Overlay {
        adds,
        dead: dead.iter().copied().collect(),
        patches: patches.into_iter().map(|l| (l.id, l)).collect(),
    }
}

#[test]
fn delta_overlay_msgpack_round_trip_empty() {
    let overlay = delta_overlay(vec![], &[], vec![]);
    let bytes = rmp_serde::to_vec_named(&overlay).unwrap();
    let restored: Overlay = rmp_serde::from_slice(&bytes).unwrap();
    assert!(restored.adds.is_empty());
    assert!(restored.dead.is_empty());
    assert!(restored.patches.is_empty());
}

#[test]
fn delta_overlay_msgpack_round_trip_with_data() {
    let l1 = loc_with_tags(1, 48.8, 2.35, vec![10, 20]);
    let l2 = loc_with_heading(2, -33.8, 151.2, 90.0);
    let overlay = delta_overlay(vec![l1.clone()], &[99, 100], vec![l2.clone()]);
    let bytes = rmp_serde::to_vec_named(&overlay).unwrap();
    let restored: Overlay = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(restored.adds.len(), 1);
    assert_eq!(restored.adds[0], l1);
    let mut dead: Vec<u32> = restored.dead.into_iter().collect();
    dead.sort_unstable();
    assert_eq!(dead, vec![99, 100]);
    assert_eq!(restored.patches.len(), 1);
    assert_eq!(restored.patches[&2], l2);
}

#[test]
fn delta_overlay_preserves_extra_fields() {
    let mut l = loc(1, 0.0, 0.0);
    l.extra = Some(serde_json::from_str(r#"{"country":"FR","altitude":35.2}"#).unwrap());
    l.pano_id = Some("CAoSLEF".into());
    l.modified_at = Some(1_705_276_800);
    let overlay = delta_overlay(vec![l.clone()], &[], vec![]);
    let bytes = rmp_serde::to_vec_named(&overlay).unwrap();
    let restored: Overlay = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(restored.adds[0].extra, l.extra);
    assert_eq!(restored.adds[0].pano_id, l.pano_id);
    assert_eq!(restored.adds[0].modified_at, l.modified_at);
}

/// The literal on-disk `.delta` shape, restated independently of `Overlay` so a change
/// to the in-memory field types cannot silently rewrite the file format. Unknown fields
/// are rejected, so `dirty`/`rev` leaking into the file fails here.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DeltaFile {
    adds: Vec<Location>,
    dead_ids: Vec<u32>,
    patches: Vec<Location>,
}

#[test]
fn delta_overlay_wire_format_is_stable() {
    let l1 = loc(1, 1.0, 2.0);
    let l3 = loc(3, 3.0, 4.0);

    // Written by the app, read by the format spec.
    let overlay = delta_overlay(vec![l1.clone()], &[7], vec![l3.clone()]);
    let bytes = rmp_serde::to_vec_named(&overlay).unwrap();
    let on_disk: DeltaFile = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(on_disk.adds, vec![l1.clone()]);
    assert_eq!(on_disk.dead_ids, vec![7]);
    assert_eq!(on_disk.patches, vec![l3.clone()]);

    // Written by an older build, read by the app.
    let legacy = rmp_serde::to_vec_named(&DeltaFile {
        adds: vec![l1.clone()],
        dead_ids: vec![7],
        patches: vec![l3.clone()],
    })
    .unwrap();
    let restored: Overlay = rmp_serde::from_slice(&legacy).unwrap();
    assert_eq!(restored.adds, vec![l1]);
    assert!(restored.dead.contains(&7));
    assert_eq!(restored.patches[&3], l3);
}

// -----------------------------------------------------------------------
// EditEntry (undo stack) msgpack round-trip
// -----------------------------------------------------------------------

#[test]
fn edit_entry_msgpack_round_trip() {
    let old = loc_with_heading(1, 10.0, 20.0, 0.0);
    let new = loc_with_heading(1, 10.0, 20.0, 90.0);
    let entry = EditEntry {
        created: vec![new.clone()],
        removed: vec![old.clone()],
    };
    let bytes = rmp_serde::to_vec_named(&entry).unwrap();
    let restored: EditEntry = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(restored.created[0], new);
    assert_eq!(restored.removed[0], old);
}

#[test]
fn undo_stack_msgpack_round_trip() {
    let entries = vec![
        EditEntry {
            created: vec![loc(1, 10.0, 20.0)],
            removed: vec![],
        },
        EditEntry {
            created: vec![],
            removed: vec![loc(2, 30.0, 40.0)],
        },
        EditEntry {
            created: vec![loc_with_heading(3, 0.0, 0.0, 90.0)],
            removed: vec![loc(3, 0.0, 0.0)],
        },
    ];
    let bytes = rmp_serde::to_vec_named(&entries).unwrap();
    let restored: Vec<EditEntry> = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(restored.len(), 3);
    assert_eq!(restored[0].created[0].lat, 10.0);
    assert_eq!(restored[1].removed[0].id, 2);
    assert_eq!(restored[2].created[0].heading, 90.0);
}

// -----------------------------------------------------------------------
// Cross-cutting invariants
// -----------------------------------------------------------------------

#[test]
fn alive_count_stays_correct_through_all_mutations() {
    let mut store = setup_store_with(&[]);
    assert_eq!(store.alive_count, 0);

    // Add 3
    let locs = vec![loc(1, 0.0, 0.0), loc(2, 1.0, 1.0), loc(3, 2.0, 2.0)];
    for l in &locs {
        store.overlay_add(vec![l.clone()]);
    }
    assert_eq!(store.alive_count, 3);

    // Remove 1
    store.overlay_remove(&[locs[0].clone()]);
    assert_eq!(store.alive_count, 2);

    // Update (should not change count)
    store.overlay_update(2, &patch!(heading: 90.0));
    assert_eq!(store.alive_count, 2);

    // Bake (should not change count)
    store.bake_overlay();
    assert_eq!(store.alive_count, 2);

    // Add 1 more
    store.overlay_add(vec![loc(4, 3.0, 3.0)]);
    assert_eq!(store.alive_count, 3);

    // Remove 2
    let l2 = store.get_loc_by_id(2).unwrap();
    let l3 = store.get_loc_by_id(3).unwrap();
    store.overlay_remove(&[l2, l3]);
    assert_eq!(store.alive_count, 1);

    // Undo the remove (re-adds 2)
    let entry = EditEntry {
        created: vec![],
        removed: vec![loc(2, 1.0, 1.0), loc(3, 2.0, 2.0)],
    };
    store.apply_edit_reverse(&entry);
    assert_eq!(store.alive_count, 3);
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
fn tag_ids_are_never_reused() {
    let mut store = Store::new();
    let mut seen = HashSet::new();
    for _ in 0..1000 {
        let id = store.alloc_tag_id();
        assert!(!seen.contains(&id), "Tag ID {id} was reused");
        seen.insert(id);
    }
}

#[test]
fn overlay_consistency_no_id_in_both_dead_and_adds() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    store.bake_overlay();

    // Remove it
    store.overlay_remove(slice::from_ref(&l));
    assert!(store.overlay.dead.contains(&1));
    assert!(!store.overlay.adds.iter().any(|l| l.id == 1));

    // Re-add it (overlay_add on a known batch ID goes to patches)
    store.overlay_add(vec![loc(1, 50.0, 60.0)]);
    // After re-add, it should NOT be in dead
    assert!(
        !store.overlay.dead.contains(&1),
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
    store.overlay_update(1, &patch!(heading: 45.0));
    assert!(store.overlay.patches.contains_key(&1));
    assert!(!store.overlay.adds.iter().any(|l| l.id == 1));
}

#[test]
fn overlay_consistency_update_add_id_stays_in_adds() {
    let mut store = setup_store_with(&[]);
    store.batch = Some(empty_batch());
    store.overlay_add(vec![loc(1, 10.0, 20.0)]);
    store.overlay_update(1, &patch!(heading: 45.0));
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
    store.overlay_update(1, &patch!(heading: 45.0));
    assert!(store.overlay.patches.contains_key(&1));

    store.overlay_remove(&[l]);
    assert!(
        !store.overlay.patches.contains_key(&1),
        "remove should clear patches for the ID"
    );
    assert!(store.overlay.dead.contains(&1));
}

#[test]
fn render_buffer_format_matches_js_parser() {
    let l1 = loc_with_heading(1, 48.8, 2.35, 90.0);
    let l2 = loc(2, -33.8, 151.2);
    let mut store = setup_store_with(&[l1, l2]);
    store.bake_overlay();

    let req = RenderRequest {
        west: -180.0,
        south: -90.0,
        east: 180.0,
        north: 90.0,
        selected_ids: None,
        marker_style: "pin".into(),
        marker_color: None,
    };
    let buf = build_cell_render_buffers(&mut store, &req);
    assert!(!buf.is_empty());

    // Parse the binary format the same way JS does
    let cell_count = u32::from_le_bytes(buf[0..4].try_into().unwrap());
    assert!(cell_count > 0, "should have at least one cell");

    let mut offset = 4usize;
    let mut total_locs = 0u32;
    for _ in 0..cell_count {
        let _cell_char = buf[offset];
        let count = u32::from_le_bytes(buf[offset + 1..offset + 5].try_into().unwrap());
        // header + 3 alignment pad bytes
        offset += 8;
        // ids: count * 4 bytes
        offset += count as usize * 4;
        // positions: count * 2 * 4 bytes
        offset += count as usize * 2 * 4;
        // visible: count bytes + pad to 4
        offset += count as usize + (4 - count as usize % 4) % 4;
        // angles: count * 4 bytes
        offset += count as usize * 4;
        total_locs += count;
    }
    assert_eq!(total_locs, 2, "should have 2 locations total");

    // Selection overlay: u32 count
    let sel_count = u32::from_le_bytes(buf[offset..offset + 4].try_into().unwrap());
    assert_eq!(sel_count, 0, "no selections active");
}

#[test]
fn arrow_render_angle_is_negated_heading() {
    // marker_style "arrow" must write angle = -heading (regression guard for ab0c496,
    // where arrows pointed the wrong way). The value is otherwise asserted nowhere.
    let l1 = loc_with_heading(1, 48.8, 2.35, 90.0);
    let mut store = setup_store_with(&[l1]);
    store.bake_overlay();

    let req = RenderRequest {
        west: -180.0,
        south: -90.0,
        east: 180.0,
        north: 90.0,
        selected_ids: None,
        marker_style: "arrow".into(),
        marker_color: None,
    };
    let buf = build_cell_render_buffers(&mut store, &req);

    // Walk to the single cell's angles segment:
    // [u32 cells][u8 char][u32 count][3 pad][ids][positions][visible][pad to 4][angles]
    let cell_count = u32::from_le_bytes(buf[0..4].try_into().unwrap());
    assert_eq!(cell_count, 1);
    let mut offset = 4usize;
    let count = u32::from_le_bytes(buf[offset + 1..offset + 5].try_into().unwrap()) as usize;
    assert_eq!(count, 1);
    offset += 8;
    offset += count * 4; // ids
    offset += count * 2 * 4; // positions
    offset += count + (4 - count % 4) % 4; // visible + pad
    let angle = f32::from_le_bytes(buf[offset..offset + 4].try_into().unwrap());
    assert_eq!(angle, -90.0, "arrow angle must be the negated heading");
}

#[test]
fn cell_render_id_order_matches_after_swap_remove_sequence() {
    // This test verifies the Rust side of the critical invariant:
    // after a sequence of adds and removes, CellRender.id_order[i]
    // must match what JS's CellBuffer.ids[i] would be after the same
    // sequence of applyDelta calls. Both use swap-remove.
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
    let entry = EditEntry {
        created: vec![],
        removed: vec![l.clone()],
    };
    let changes = store.apply_edit_forward(&entry);
    let delta = store.derive_render_delta(&changes, &HashSet::new());
    assert_eq!(delta.removed.len(), 1);
    assert!(store.cell_lookup(1).is_none());

    // Undo delete
    let changes = store.apply_edit_reverse(&entry);
    let delta = store.derive_render_delta(&changes, &HashSet::new());
    assert_eq!(delta.added.len(), 1);
    assert_eq!(delta.added[0].id, 1);
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
    let entry = EditEntry {
        created: vec![],
        removed: vec![l1.clone(), l2.clone()],
    };
    let changes = store.apply_edit_forward(&entry);
    store.derive_render_delta(&changes, &HashSet::new());
    assert!(store.cell_lookup(1).is_none());
    assert!(store.cell_lookup(2).is_none());
    assert!(store.cell_lookup(3).is_some());

    // Undo
    let changes = store.apply_edit_reverse(&entry);
    let delta = store.derive_render_delta(&changes, &HashSet::new());
    assert_eq!(delta.added.len(), 2);
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
    assert_eq!(tag_count(&store, 5), Some(10));

    let entry = EditEntry {
        created: locs.clone(),
        removed: vec![],
    };
    store.apply_edit_reverse(&entry);
    assert_eq!(tag_count(&store, 5), Some(0));
    assert_eq!(store.alive_count, 0);

    store.apply_edit_forward(&entry);
    assert_eq!(tag_count(&store, 5), Some(10));
    assert_eq!(store.alive_count, 10);
}

#[test]
fn tag_counts_correct_after_tag_reassignment_undo() {
    // location starts with tag [5], update to [5, 10], undo should restore [5]
    let old = loc_with_tags(1, 0.0, 0.0, vec![5]);
    let new = loc_with_tags(1, 0.0, 0.0, vec![5, 10]);
    let mut store = setup_store_with(slice::from_ref(&new));
    store.tags.counts = Touched::default();
    store.add_tag_counts(slice::from_ref(&new));
    assert_eq!(tag_count(&store, 5), Some(1));
    assert_eq!(tag_count(&store, 10), Some(1));

    let entry = EditEntry {
        created: vec![new],
        removed: vec![old],
    };
    store.apply_edit_reverse(&entry);
    assert_eq!(tag_count(&store, 5), Some(1), "tag 5 should still be 1");
    assert_eq!(
        tag_count(&store, 10),
        Some(0),
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
    store.overlay_update(1, &patch!(heading: 90.0));

    // The delta is the overlay itself.
    let bytes = overlay_delta_bytes(&store.overlay).unwrap();
    let overlay: Overlay = rmp_serde::from_slice(&bytes).unwrap();
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
    store.alive_count += 1;
    store.overlay_remove(slice::from_ref(&l1));
    store.overlay_update(2, &patch!(heading: 180.0));

    // Serialize
    let bytes = overlay_delta_bytes(&store.overlay).unwrap();

    // Simulate reopen: deserialize and verify
    let restored: Overlay = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(restored.adds.len(), 1);
    assert_eq!(restored.adds[0].id, 3);
    assert!(restored.dead.contains(&1));
    assert_eq!(restored.patches.len(), 1);
    assert_eq!(restored.patches[&2].heading, 180.0);
}

// -----------------------------------------------------------------------
// Bug regression: active location removed by undo
// -----------------------------------------------------------------------

#[test]
fn active_id_should_be_clearable_when_location_removed() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(slice::from_ref(&l));
    store.selections.active_id = Some(1);

    // Remove the active location
    let entry = EditEntry {
        created: vec![],
        removed: vec![l],
    };
    store.apply_edit_forward(&entry);

    // The caller (JS) should clear active_id when the delta removes it.
    // Verify the location is actually gone so the caller can detect it.
    assert!(store.get_loc_by_id(1).is_none());
    let delta_has_removed_active = entry
        .removed
        .iter()
        .any(|l| Some(l.id) == store.selections.active_id);
    assert!(
        delta_has_removed_active,
        "caller can detect active was removed"
    );
}

// -----------------------------------------------------------------------
// Render buffer binary format
// -----------------------------------------------------------------------

/// Push a selection with an explicit member set, bypassing resolution.
fn push_resolved(store: &mut Store, key: &str, color: [u8; 3], members: &[u32]) {
    let mut set = RoaringBitmap::new();
    for &id in members {
        set.insert(id);
    }
    store.selections.resolved.push(ResolvedSelection {
        sel: Selection {
            key: key.into(),
            color,
            selector: Selector::Manual {
                locations: members.to_vec(),
            },
        },
        set,
    });
}

/// Generator, not an assertion. `cargo test emit_render_fixture -- --ignored` rewrites
/// `app/test/unit/fixtures/render-buffer.bin`, which `cellManager.test.ts` parses.
///
/// Scene: 4 locations in 3 cells (d: id 3, r: id 2, u: ids 1 and 4), arrow style, and
/// two selections -- "a" [255,0,0] over ids 1 and 4, "b" [0,0,255] over id 2.
#[test]
#[ignore]
fn emit_render_fixture() {
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
    for id in [1, 2, 4] {
        store.selections.ids.insert(id);
    }

    let req = RenderRequest {
        west: -180.0,
        south: -90.0,
        east: 180.0,
        north: 90.0,
        selected_ids: None,
        marker_style: "arrow".into(),
        marker_color: None,
    };
    let buf = build_cell_render_buffers(&mut store, &req);

    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/unit/fixtures");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("render-buffer.bin"), &buf).unwrap();
}

#[test]
fn render_buffer_with_selection_overlay() {
    let l1 = loc(1, 10.0, 20.0);
    let l2 = loc(2, 30.0, 40.0);
    let mut store = setup_store_with(&[l1, l2]);
    store.bake_overlay();
    push_resolved(&mut store, "manual", [255, 0, 0], &[1]);
    store.selections.ids.insert(1);

    let req = RenderRequest {
        west: -180.0,
        south: -90.0,
        east: 180.0,
        north: 90.0,
        selected_ids: None,
        marker_style: "pin".into(),
        marker_color: None,
    };
    let buf = build_cell_render_buffers(&mut store, &req);

    // Skip to selection overlay
    let cell_count = u32::from_le_bytes(buf[0..4].try_into().unwrap());
    let mut offset = 4usize;
    for _ in 0..cell_count {
        let count = u32::from_le_bytes(buf[offset + 1..offset + 5].try_into().unwrap()) as usize;
        // header+pad + ids + positions + visible+pad + angles
        offset += 8 + count * 4 + count * 2 * 4 + count + (4 - count % 4) % 4 + count * 4;
    }
    let sel_count = u32::from_le_bytes(buf[offset..offset + 4].try_into().unwrap());
    assert_eq!(sel_count, 1, "one selected location");
}

#[test]
fn render_buffer_ships_selection_index_per_entry() {
    // Ids alternate between the two selections, so batch order and selection order
    // disagree. The buffer ships entries in emission order, each tagged with the
    // selection that draws it; JS sorts by that tag in `CellManager.load`, which is
    // where the z-order between overlapping markers is decided.
    let locs: Vec<_> = (1..=4).map(|id| loc(id, 10.0, 20.0)).collect();
    let mut store = setup_store_with(&locs);
    store.bake_overlay();
    push_resolved(&mut store, "a", [255, 0, 0], &[1, 3]);
    push_resolved(&mut store, "b", [0, 0, 255], &[2, 4]);
    for id in 1..=4 {
        store.selections.ids.insert(id);
    }

    let req = RenderRequest {
        west: -180.0,
        south: -90.0,
        east: 180.0,
        north: 90.0,
        selected_ids: None,
        marker_style: "pin".into(),
        marker_color: None,
    };
    let buf = build_cell_render_buffers(&mut store, &req);

    let cell_count = u32::from_le_bytes(buf[0..4].try_into().unwrap());
    let mut offset = 4usize;
    for _ in 0..cell_count {
        let count = u32::from_le_bytes(buf[offset + 1..offset + 5].try_into().unwrap()) as usize;
        offset += 8 + count * 4 + count * 2 * 4 + count + (4 - count % 4) % 4 + count * 4;
    }
    let n = u32::from_le_bytes(buf[offset..offset + 4].try_into().unwrap()) as usize;
    assert_eq!(n, 4, "every location is selected");
    offset += 4;
    // positions, colors, angles, then ids and the selection indices.
    let ids_at = offset + n * 8 + n * 4 + n * 4;
    let sel_at = ids_at + n * 4;
    let read = |at: usize, i: usize| {
        u32::from_le_bytes(buf[at + i * 4..at + i * 4 + 4].try_into().unwrap())
    };
    let sel: Vec<u32> = (0..n).map(|i| read(sel_at, i)).collect();
    let ids: Vec<u32> = (0..n).map(|i| read(ids_at, i)).collect();
    assert_eq!(ids, vec![1, 2, 3, 4], "emission order");
    assert_eq!(
        sel,
        vec![0, 1, 0, 1],
        "each entry tagged with its drawing selection"
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

    let paint = store.selections.paint_for(1).expect("id 1 is selected");
    assert_eq!(paint.color, [0, 0, 255], "last selection wins");
    // The index is what the overlay orders by, so it must name the winning selection.
    assert_eq!(paint.idx, 1, "index of the winning selection");
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
        let bulk = map.get(&id).map(|p| (p.idx, p.color));
        let single = store.selections.paint_for(id).map(|p| (p.idx, p.color));
        assert_eq!(bulk, single, "id {id}");
    }
}

// -----------------------------------------------------------------------
// Sorted ID invariant
// -----------------------------------------------------------------------

fn ids_sorted(store: &Store) -> bool {
    if let Some(ref b) = store.batch {
        let ids = col_id(b);
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
    store.overlay_update(2, &patch!(lat: 99.0));
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
    store.overlay_remove(&[loc(2, 10.0, 10.0)]);
    store.alive_count -= 1;
    store.overlay_update(3, &patch!(heading: 45.0));
    store.bake_overlay();
    assert!(ids_sorted(&store));
    let ids: Vec<u32> = {
        let b = store.batch.as_ref().unwrap();
        (0..b.num_rows()).map(|i| col_id(b).value(i)).collect()
    };
    assert_eq!(ids, vec![1, 3, 4]);
}

#[test]
fn bake_preserves_sorted_ids_after_mixed_ops() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 10.0, 10.0)]);
    store.bake_overlay();
    // Remove 1, patch 2, add 3
    store.overlay_remove(&[loc(1, 0.0, 0.0)]);
    store.alive_count -= 1;
    store.overlay_update(2, &patch!(lat: 99.0));
    let l3 = loc(3, 50.0, 50.0);
    store.overlay_add(vec![l3]);
    store.alive_count += 1;
    store.bake_overlay();
    assert!(ids_sorted(&store));
    let ids: Vec<u32> = {
        let b = store.batch.as_ref().unwrap();
        (0..b.num_rows()).map(|i| col_id(b).value(i)).collect()
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
        store.alive_count += 1;
        if round % 2 == 0 {
            store.overlay_update(2, &patch!(heading: round as f64));
        }
        store.bake_overlay();
        assert!(ids_sorted(&store), "failed at round {round}");
    }
}

// -----------------------------------------------------------------------
// Binary search (batch_row_for_id)
// -----------------------------------------------------------------------

#[test]
fn binary_search_finds_existing_ids() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(5, 10.0, 10.0), loc(10, 20.0, 20.0)]);
    store.bake_overlay();
    let b = store.batch.as_ref().unwrap();
    assert_eq!(batch_row_for_id(b, 1), Some(0));
    assert_eq!(batch_row_for_id(b, 5), Some(1));
    assert_eq!(batch_row_for_id(b, 10), Some(2));
}

#[test]
fn binary_search_returns_none_for_missing() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(5, 10.0, 10.0), loc(10, 20.0, 20.0)]);
    store.bake_overlay();
    let b = store.batch.as_ref().unwrap();
    assert_eq!(batch_row_for_id(b, 0), None);
    assert_eq!(batch_row_for_id(b, 3), None);
    assert_eq!(batch_row_for_id(b, 7), None);
    assert_eq!(batch_row_for_id(b, 99), None);
}

#[test]
fn binary_search_on_empty_batch() {
    let b = empty_batch();
    assert_eq!(batch_row_for_id(&b, 1), None);
}

#[test]
fn binary_search_single_element() {
    let mut store = setup_store_with(&[loc(42, 0.0, 0.0)]);
    store.bake_overlay();
    let b = store.batch.as_ref().unwrap();
    assert_eq!(batch_row_for_id(b, 42), Some(0));
    assert_eq!(batch_row_for_id(b, 41), None);
    assert_eq!(batch_row_for_id(b, 43), None);
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
    assert_eq!(store.alive_count, 2);

    // Add loc 3, bake
    store.overlay_add(vec![loc(3, 20.0, 20.0)]);
    store.alive_count += 1;
    store.bake_overlay();
    assert!(ids_sorted(&store));
    assert_eq!(store.batch.as_ref().unwrap().num_rows(), 3);

    // Remove loc 2, bake
    store.overlay_remove(&[loc(2, 10.0, 10.0)]);
    store.alive_count -= 1;
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
    store.overlay_update(1, &patch!(heading: 10.0));
    store.overlay_update(2, &patch!(heading: 20.0));
    store.overlay_update(3, &patch!(heading: 30.0));
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
    s1.map_id = Some("map-a".into());
    s1.alive_count = 10;
    let mut s2 = Store::new();
    s2.map_id = Some("map-b".into());
    s2.alive_count = 20;

    mgr.stores.insert("map-a".into(), s1);
    mgr.stores.insert("map-b".into(), s2);
    mgr.window_map.insert("win-1".into(), "map-a".into());
    mgr.window_map.insert("win-2".into(), "map-b".into());

    assert_eq!(mgr.store_for_window("win-1").unwrap().alive_count, 10);
    assert_eq!(mgr.store_for_window("win-2").unwrap().alive_count, 20);
    assert_eq!(mgr.store_for_map("map-a").unwrap().alive_count, 10);
    assert_eq!(mgr.store_for_map("map-b").unwrap().alive_count, 20);
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
fn manager_remove_preserves_other() {
    let mut mgr = StoreManager::new();
    let mut s1 = Store::new();
    s1.map_id = Some("map-a".into());
    let mut s2 = Store::new();
    s2.map_id = Some("map-b".into());
    s2.alive_count = 99;

    mgr.stores.insert("map-a".into(), s1);
    mgr.stores.insert("map-b".into(), s2);
    mgr.window_map.insert("win-1".into(), "map-a".into());
    mgr.window_map.insert("win-2".into(), "map-b".into());

    mgr.window_map.remove("win-1");
    mgr.stores.remove("map-a");

    assert!(mgr.store_for_window("win-1").is_err());
    assert_eq!(mgr.store_for_window("win-2").unwrap().alive_count, 99);
    assert!(mgr.store_for_map("map-a").is_err());
    assert_eq!(mgr.store_for_map("map-b").unwrap().alive_count, 99);
}

// -----------------------------------------------------------------------
// Store::create_tags: create-and-assign in one mutation
// -----------------------------------------------------------------------

#[test]
fn create_tags_with_locations_never_leaves_the_tag_at_zero() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, 10.1, 20.1)]);

    let result = store.create_tags(&["field".to_string()], &[1, 2]);

    let tag = store
        .tags
        .all
        .values()
        .find(|t| t.name == "field")
        .expect("tag created");
    assert_eq!(
        store.tag_count(tag.id),
        2,
        "the count is right in the same mutation"
    );
    assert!(
        tag.visible,
        "and it is not flipped invisible for being empty"
    );
    for id in [1, 2] {
        assert!(store.get_loc_by_id(id).unwrap().tags.contains(&tag.id));
    }
    assert_eq!(
        result.tag_counts.unwrap().get(&tag.id),
        Some(&2),
        "the same mutation reports the count to JS"
    );
}

#[test]
fn create_tags_without_locations_only_creates() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0)]);

    store.create_tags(&["solo".to_string()], &[]);

    let tag = store.tags.all.values().find(|t| t.name == "solo").unwrap();
    assert_eq!(store.tag_count(tag.id), 0);
    assert!(store.get_loc_by_id(1).unwrap().tags.is_empty());
}

#[test]
fn an_empty_tag_survives_an_unrelated_mutation() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0), loc(2, 30.0, 40.0)]);
    store.create_tags(&["empty".to_string()], &[]);
    let tag_id = store
        .tags
        .all
        .values()
        .find(|t| t.name == "empty")
        .unwrap()
        .id;
    assert!(store.tags.all[&tag_id].visible, "visible on creation");

    // Move an unrelated location. Visibility is re-derived only for tags this touched.
    let old = store.get_loc_by_id(2).unwrap();
    let moved = Location {
        lat: 31.0,
        ..old.clone()
    };
    store.finish_mutation(&ChangeSet {
        updated: vec![(old, moved)],
        ..Default::default()
    });

    assert!(
        store.tags.all[&tag_id].visible,
        "an unrelated edit must not hide a tag that is merely empty"
    );
}

#[test]
fn losing_its_last_location_still_hides_a_tag() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0)]);
    store.create_tags(&["fading".to_string()], &[1]);
    let tag_id = store
        .tags
        .all
        .values()
        .find(|t| t.name == "fading")
        .unwrap()
        .id;
    assert!(store.tags.all[&tag_id].visible);

    // Strip it back off: the tag IS touched, so visibility is re-derived and it hides.
    let old = store.get_loc_by_id(1).unwrap();
    let untagged = Location {
        tags: vec![],
        ..old.clone()
    };
    store.remove_tag_counts(slice::from_ref(&old));
    store.add_tag_counts(slice::from_ref(&untagged));
    store.finish_mutation(&ChangeSet {
        updated: vec![(old, untagged)],
        ..Default::default()
    });

    assert_eq!(store.tag_count(tag_id), 0);
    assert!(!store.tags.all[&tag_id].visible);
}

#[test]
fn create_tags_is_idempotent_against_locations_that_already_have_the_tag() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0)]);
    store.create_tags(&["dup".to_string()], &[1]);
    let tag_id = store
        .tags
        .all
        .values()
        .find(|t| t.name == "dup")
        .unwrap()
        .id;

    // Same name, same location: no second copy of the tag, no double count.
    store.create_tags(&["DUP".to_string()], &[1]);

    assert_eq!(store.tags.counts.values().filter(|&&c| c > 0).count(), 1);
    assert_eq!(store.tag_count(tag_id), 1);
    assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![tag_id]);
}

// -----------------------------------------------------------------------
// Selection bitmask: partial cell invariants
// -----------------------------------------------------------------------

fn add_tag_selection(store: &mut Store, tag_id: u32, color: [u8; 3]) {
    store.selections.resolved.push(ResolvedSelection {
        sel: Selection {
            key: format!("tag:{tag_id}"),
            color,
            selector: Selector::Tag { tag_id },
        },
        set: RoaringBitmap::new(),
    });
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

#[test]
fn tag_patch_applies_set_fields_only() {
    let mut tag = Tag {
        id: 1,
        name: "A".into(),
        color: "#ff0000".into(),
        visible: true,
        order: None,
        doclinks: vec!["https://old".into()],
    };
    // Unset fields untouched; blank name ignored.
    apply_tag_patch(
        &mut tag,
        &TagPatch {
            name: Some("  ".into()),
            ..Default::default()
        },
    );
    assert_eq!(tag.name, "A");
    assert_eq!(tag.doclinks, vec!["https://old".to_string()]);

    // doclinks is a full replacement; empty vec clears.
    apply_tag_patch(
        &mut tag,
        &TagPatch {
            doclinks: Some(vec!["https://a".into(), "https://b".into()]),
            ..Default::default()
        },
    );
    assert_eq!(tag.doclinks.len(), 2);
    apply_tag_patch(
        &mut tag,
        &TagPatch {
            doclinks: Some(Vec::new()),
            ..Default::default()
        },
    );
    assert!(tag.doclinks.is_empty());
    assert_eq!(tag.name, "A");
}

fn registry_tag(id: u32, visible: bool) -> Tag {
    Tag {
        id,
        name: format!("tag{id}"),
        color: "#ff0000".into(),
        visible,
        order: None,
        doclinks: Vec::new(),
    }
}

// Issue #122: commit checkout rewrites the base Arrow file but not the SQLite tag
// registry, so a tag soft-deleted after the target commit stays visible=false even
// though the restored locations reference it. Open-time reconciliation revives it.
#[test]
fn reconcile_revives_soft_deleted_tag_with_members() {
    let mut tags = HashMap::from([
        (1, registry_tag(1, false)), // ghost, but locations reference it again
        (2, registry_tag(2, true)),  // live
        (3, registry_tag(3, false)), // ghost with no members
    ]);
    let counts = HashMap::from([(1, 2usize), (2, 5)]);

    let (max_tag_id, healed) = reconcile_tag_registry(&mut tags, &counts);

    assert!(healed, "revived tag must be flagged for persistence");
    assert_eq!(max_tag_id, 3);
    assert!(tags[&1].visible);
    assert!(tags[&2].visible);
    assert!(
        !tags[&3].visible,
        "memberless ghost stays soft-deleted for undo revival"
    );
}

#[test]
fn reconcile_clean_registry_needs_no_persist() {
    let mut tags = HashMap::from([
        (1, registry_tag(1, true)),
        (2, registry_tag(2, true)), // created but unassigned; stays visible
    ]);
    let counts = HashMap::from([(1, 3usize), (5, 1)]);

    let (max_tag_id, healed) = reconcile_tag_registry(&mut tags, &counts);

    assert!(!healed, "no desync, so open must not dirty the registry");
    assert_eq!(max_tag_id, 5);
    assert!(tags[&2].visible);
    let placeholder = &tags[&5];
    assert!(placeholder.visible);
    assert_eq!(placeholder.name, "Tag 5");
}

/// Insert tag `id` with `count` members so selection resolution can see it.
fn insert_tag(store: &mut Store, id: u32, count: usize) {
    store.tags.all.edit().insert(
        id,
        Tag {
            id,
            name: format!("tag{id}"),
            color: "#ff0000".into(),
            visible: true,
            order: None,
            doclinks: Vec::new(),
        },
    );
    *store.tags.counts.edit(id) = count;
}

#[test]
fn incremental_membership_change_ships_no_bitmask() {
    let l1 = loc_with_tags(1, 10.0, 20.0, vec![]);
    let mut store = setup_store_with(slice::from_ref(&l1));
    insert_tag(&mut store, 1, 0);
    add_tag_selection(&mut store, 1, [255, 0, 0]);

    let result = store.finish_mutation(&ChangeSet {
        updated: vec![(l1, loc_with_tags(1, 10.0, 20.0, vec![1]))],
        ..Default::default()
    });

    let sync = result.selection_sync.expect("counts still sync");
    assert!(
        sync.bitmask.is_none(),
        "the incremental path carries membership on the render delta, not a bitmask"
    );
    assert_eq!(sync.selected_count, 1);
    assert_eq!(
        result.delta.updated.len(),
        1,
        "membership rides on a patch for the row that changed"
    );
    assert_eq!(
        result.delta.updated[0].sel,
        Some(SelPaint {
            idx: 0,
            color: [255, 0, 0]
        })
    );
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

    // `full_reset` forces the full-resolve branch.
    let result = store.finish_mutation(&ChangeSet {
        full_reset: true,
        ..Default::default()
    });

    let buf = result
        .selection_sync
        .unwrap()
        .bitmask
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
    store.tags.all.edit().insert(
        1,
        Tag {
            id: 1,
            name: "A".into(),
            color: "#ff0000".into(),
            visible: true,
            order: None,
            doclinks: Vec::new(),
        },
    );
    add_tag_selection(&mut store, 1, [255, 0, 0]);

    // Add tag 1 to location 1
    let with_tag = loc_with_tags(1, 10.0, 20.0, vec![1]);
    let result = store.finish_mutation(&ChangeSet {
        updated: vec![(l1, with_tag)],
        ..Default::default()
    });

    // The row gained a selection without moving, so it ships as a coordinate-free patch.
    let p = result
        .delta
        .updated
        .iter()
        .find(|p| p.sel.is_some())
        .expect("a row that joins a selection must state it");
    assert_eq!(
        p.sel,
        Some(SelPaint {
            idx: 0,
            color: [255, 0, 0]
        }),
        "the selection colour"
    );
    assert_eq!(
        (p.lng, p.lat, p.heading),
        (None, None, None),
        "nothing moved, so only the selection state is stated"
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
    let result = store.finish_mutation(&ChangeSet {
        updated: vec![(tagged, untagged)],
        ..Default::default()
    });

    assert!(!store.selections.ids.contains(1), "left the selection");
    assert_eq!(
        result.delta.updated.len(),
        1,
        "a row that leaves a selection must be restored to the base layer"
    );
    assert_eq!(
        result.delta.updated[0].sel, None,
        "no selection, so the base layer draws it again"
    );
}

#[test]
fn removed_selected_location_leaves_no_patch() {
    // A deleted row has no cell left to patch; JS drops it from the overlay via
    // `delta.removed`, so emitting a patch for it would dangle.
    let l1 = loc_with_tags(1, 10.0, 20.0, vec![1]);
    let l2 = loc_with_tags(2, 10.001, 20.001, vec![1]);
    let mut store = setup_store_with(&[l1, l2]);
    insert_tag(&mut store, 1, 2);
    add_tag_selection(&mut store, 1, [255, 0, 0]);
    store.resolve_selection_membership();

    let result = store.finish_mutation(&ChangeSet {
        removed: vec![1],
        ..Default::default()
    });

    assert!(
        result.delta.updated.is_empty(),
        "no patch for a row that no longer has a cell"
    );
    assert!(
        result.delta.removed.iter().any(|r| r.id == 1),
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
        Some(SelPaint {
            idx: 1,
            color: [0, 0, 255]
        }),
        "the later selection wins while the row is in both"
    );

    let only_first = loc_with_tags(1, 10.0, 20.0, vec![1]);
    let result = store.finish_mutation(&ChangeSet {
        updated: vec![(both, only_first)],
        ..Default::default()
    });

    assert_eq!(
        result.delta.updated.len(),
        1,
        "leaving the winner while staying selected must still ship a patch"
    );
    let p = &result.delta.updated[0];
    assert_eq!(
        p.sel,
        Some(SelPaint {
            idx: 0,
            color: [255, 0, 0]
        }),
        "the surviving selection's paint"
    );
    assert_eq!(
        (p.lng, p.lat, p.heading),
        (None, None, None),
        "nothing moved, so only the selection state is stated"
    );
}

#[test]
fn membership_delta_no_patch_when_nothing_changed() {
    let l1 = loc_with_tags(1, 10.0, 20.0, vec![1]);
    let mut store = setup_store_with(slice::from_ref(&l1));
    store.tags.all.edit().insert(
        1,
        Tag {
            id: 1,
            name: "A".into(),
            color: "#ff0000".into(),
            visible: true,
            order: None,
            doclinks: Vec::new(),
        },
    );
    add_tag_selection(&mut store, 1, [255, 0, 0]);
    // Resolve initial membership
    store.resolve_selection_membership();

    // Update heading only — selection membership doesn't change
    let updated = Location {
        heading: 90.0,
        ..l1.clone()
    };
    let result = store.finish_mutation(&ChangeSet {
        updated: vec![(l1, updated)],
        ..Default::default()
    });

    // The heading moved, so a patch ships — but it restates the unchanged selection.
    assert_eq!(result.delta.updated.len(), 1);
    assert_eq!(
        result.delta.updated[0].sel,
        Some(SelPaint {
            idx: 0,
            color: [255, 0, 0]
        }),
        "a patch always states the row's current selection state"
    );
}

#[test]
fn selected_row_moving_across_cells_ships_as_one_move() {
    // A cross-cell move ships as a single added entry carrying the slot it vacated, so JS
    // can move the overlay entry with the row instead of guessing from a removed/added pair.
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
    let result = store.finish_mutation(&ChangeSet {
        updated: vec![(l1, moved)],
        ..Default::default()
    });

    assert!(
        !result.delta.removed.iter().any(|r| r.id == 1),
        "a move is not a removal"
    );
    let added = result
        .delta
        .added
        .iter()
        .find(|e| e.id == 1)
        .expect("re-added in the new cell");
    assert_eq!(
        added.sel,
        Some(SelPaint {
            idx: 0,
            color: [255, 0, 0]
        }),
        "still selected"
    );
    let from = added.moved_from.as_ref().expect("carries the vacated slot");
    assert_eq!(from.id, 1);
}

#[test]
fn touched_zero_member_tag_is_hidden_by_finish_mutation() {
    // A tag with no members produces an empty changeset, so update_tag_counts never marks
    // it touched; store_delete_tags marks it directly. This pins the mechanism it relies
    // on: a touched count-0 tag gets visible=false and the result ships tags.
    let mut store = setup_store_with(&[]);
    insert_tag(&mut store, 1, 0);
    store.tags.counts.touch(1);

    let result = store.finish_mutation(&ChangeSet::default());

    assert!(
        !store.tags.all[&1].visible,
        "touched zero-member tag must be hidden"
    );
    assert!(
        result.tags.is_some(),
        "the visibility flip must ship tags so JS sees it"
    );
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
    let s = merge_group(&[a, b], &default_score());
    assert_eq!(s.id, 2);
    assert_eq!(s.tags, vec![1, 2, 3]);
}

#[test]
fn merge_group_tie_breaks_on_earliest_created() {
    let a = loc_full(1, vec![1], 2021);
    let b = loc_full(2, vec![9], 2019); // fewer-tag tie, but earlier
    let s = merge_group(&[a, b], &default_score());
    assert_eq!(s.id, 2);
}

#[test]
fn merge_group_tie_breaks_on_lowest_id() {
    let a = loc_full(5, vec![1], 2020);
    let b = loc_full(2, vec![9], 2020); // same tags+created, lower id
    let s = merge_group(&[a, b], &default_score());
    assert_eq!(s.id, 2);
}

#[test]
fn merge_group_unions_and_dedupes_tags() {
    let a = loc_full(1, vec![1, 2], 2020);
    let b = loc_full(2, vec![2, 3], 2020);
    let s = merge_group(&[a, b], &default_score());
    assert_eq!(s.tags, vec![1, 2, 3]);
}

#[test]
fn merge_group_extra_survivor_wins_and_unions_keys() {
    let mut a = loc_full(1, vec![1, 2], 2020); // survivor (most tags)
    a.extra = Some(serde_json::from_str(r#"{"k":"survivor"}"#).unwrap());
    let mut b = loc_full(2, vec![3], 2020);
    b.extra = Some(serde_json::from_str(r#"{"k":"other","x":"y"}"#).unwrap());
    let s = merge_group(&[a, b], &default_score());
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
    assert_eq!(merge_group(&group, &default_score()).id, 1);
    assert_eq!(merge_group(&group, &score_expr("tagCount")).id, 2);
}

#[test]
fn merge_group_score_expression_replaces_tag_count() {
    let a = loc_full(1, vec![1, 2, 3], 2020);
    let b = loc_full(2, vec![], 2021);
    let s = merge_group(&[a, b], &score_expr("id"));
    assert_eq!(s.id, 2); // highest id wins despite having no tags at all
}

#[test]
fn merge_group_score_ties_still_fall_to_created_then_id() {
    let a = loc_full(1, vec![1], 2021);
    let b = loc_full(2, vec![9], 2019);
    let s = merge_group(&[a, b], &score_expr("1"));
    assert_eq!(s.id, 2); // only the earlier created_at explains this: a has the lower id
}

#[test]
fn merge_group_unscorable_member_ranks_below_a_scored_one() {
    let a = loc_full(1, vec![1, 2, 3], 2019); // wins on every built-in key
    let mut b = loc_full(2, vec![], 2021);
    b.extra = Some(serde_json::from_str(r#"{"q":1}"#).unwrap());
    let s = merge_group(&[a, b], &score_expr("q"));
    assert_eq!(s.id, 2);
}

#[test]
fn merge_group_applies_and_undo_restores() {
    let a = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let b = loc_with_tags(2, 0.0, 0.0, vec![20]);
    let mut store = setup_store_with(&[a.clone(), b.clone()]);
    assert_eq!(store.alive_count, 2);

    let members = vec![a.clone(), b.clone()];
    let survivor = merge_group(&members, &default_score());
    assert_eq!(survivor.id, 1); // tie on tags+created -> lowest id survives
    let entry = EditEntry {
        created: vec![survivor],
        removed: members,
    };

    store.apply_edit_forward(&entry);
    assert_eq!(store.alive_count, 1);
    assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![10, 20]);
    assert!(store.get_loc_by_id(2).is_none());

    store.apply_edit_reverse(&entry);
    assert_eq!(store.alive_count, 2);
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
fn history_max_id_spans_both_stacks_and_both_sides() {
    let undo = vec![
        EditEntry {
            created: vec![loc(3, 0.0, 0.0)],
            removed: vec![],
        },
        EditEntry {
            created: vec![],
            removed: vec![loc(112, 0.0, 0.0)],
        },
    ];
    let redo = vec![EditEntry {
        created: vec![loc(7, 0.0, 0.0)],
        removed: vec![loc(9, 0.0, 0.0)],
    }];
    assert_eq!(history_max_id(&undo, &redo), 112);
    assert_eq!(history_max_id(&[], &[]), 0);
}

// Simulate "close map" (store_close_map + save_edit_history) and "reopen"
// (store_open_map's delta/history load + next_id seeding) at the Store level,
// using the same serialization roundtrips the app uses.
fn close_and_reopen(store: &Store) -> Store {
    let delta_bytes = overlay_delta_bytes(&store.overlay).unwrap();
    let undo_bytes = rmp_serde::to_vec_named(&store.edits.undo).unwrap();
    let redo_bytes = rmp_serde::to_vec_named(&store.edits.redo).unwrap();

    let delta: Overlay = rmp_serde::from_slice(&delta_bytes).unwrap();
    let undo: Vec<EditEntry> = rmp_serde::from_slice(&undo_bytes).unwrap();
    let redo: Vec<EditEntry> = rmp_serde::from_slice(&redo_bytes).unwrap();

    let mut reopened = Store::new();
    reopened.map_id = store.map_id.clone();
    reopened.batch = Some(empty_batch());
    reopened.overlay = Tracked::unsaved(delta);
    reopened.next_id = seed_next_id(0, &reopened.overlay.adds, &undo, &redo);
    reopened.alive_count = reopened.overlay.adds.len();
    reopened.edits.undo = undo;
    reopened.edits.redo = redo;
    reopened
}

// store_add_locations: alloc an id and add, with the same undo entry it records.
fn click_add(store: &mut Store, lat: f64, lng: f64) -> u32 {
    let id = store.alloc_id();
    let l = loc(id, lat, lng);
    store.push_undo(EditEntry {
        created: vec![l.clone()],
        removed: vec![],
    });
    store.edits.redo.clear();
    store.overlay_add(vec![l]);
    id
}

// store_remove_locations: remove with the same undo entry it records.
fn delete_loc(store: &mut Store, id: u32) {
    let l = store.get_loc_by_id(id).unwrap();
    store.push_undo(EditEntry {
        created: vec![],
        removed: vec![l.clone()],
    });
    store.edits.redo.clear();
    store.overlay_remove(slice::from_ref(&l));
}

// store_undo / store_redo replay.
fn press_undo(store: &mut Store) {
    let entry = store.edits.undo.pop().unwrap();
    store.apply_edit_reverse(&entry);
    store.edits.redo.push(entry);
}

fn press_redo(store: &mut Store) {
    let entry = store.edits.redo.pop().unwrap();
    store.apply_edit_forward(&entry);
    store.push_undo(entry);
}

fn assert_bake_sorted(store: &mut Store) {
    store.bake_overlay();
    let batch = store.batch.as_ref().unwrap();
    let ids = col_id(batch);
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
    assert_eq!(store.alive_count, 2);
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
    assert_eq!(store.alive_count, 2);
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
// Tag reconciliation core (reconcile_tags_by_name) — shared by import + copy
// -----------------------------------------------------------------------

fn tag(id: u32, name: &str, color: &str) -> Tag {
    Tag {
        id,
        name: name.into(),
        color: color.into(),
        visible: true,
        order: None,
        doclinks: Vec::new(),
    }
}

#[test]
fn reconcile_tags_match_by_name_case_insensitive() {
    let mut target_tags: HashMap<u32, Tag> =
        [(3, tag(3, "rural", "#222222"))].into_iter().collect();
    let mut next = 4;
    let (remap, changed) =
        reconcile_tags_by_name(&[tag(7, "Rural", "#111111")], &mut target_tags, &mut next);
    assert_eq!(remap.get(&7), Some(&3));
    assert!(!changed, "pure match mutates nothing");
    assert_eq!(next, 4);
    assert_eq!(target_tags.len(), 1);
    // The existing target tag keeps its own color.
    assert_eq!(target_tags.get(&3).unwrap().color, "#222222");
}

#[test]
fn reconcile_tags_create_missing_with_source_color() {
    let mut target_tags: HashMap<u32, Tag> = Default::default();
    let mut next = 10;
    let (remap, changed) =
        reconcile_tags_by_name(&[tag(7, "Trekker", "#abcdef")], &mut target_tags, &mut next);
    assert!(changed);
    assert_eq!(remap.get(&7), Some(&10));
    assert_eq!(next, 11);
    let new_tag = target_tags.get(&10).unwrap();
    assert_eq!(new_tag.name, "Trekker");
    assert_eq!(new_tag.color, "#abcdef");
}

#[test]
fn reconcile_tags_doclinks_claimed_when_target_empty() {
    let mut target_tags: HashMap<u32, Tag> =
        [(3, tag(3, "rural", "#222222"))].into_iter().collect();
    let mut next = 4;
    let source = Tag {
        doclinks: vec!["https://docs.google.com/document/d/x/edit#heading=h.abc".into()],
        ..tag(7, "Rural", "#111111")
    };
    let (_, changed) = reconcile_tags_by_name(slice::from_ref(&source), &mut target_tags, &mut next);
    assert!(changed, "doclink adoption must mark tags as changed");
    assert_eq!(target_tags.get(&3).unwrap().doclinks, source.doclinks);
}

#[test]
fn reconcile_tags_doclinks_never_overwrite_existing() {
    let mut target_tags: HashMap<u32, Tag> = [(
        3,
        Tag {
            doclinks: vec!["https://docs.google.com/document/d/kept/edit#heading=h.kept".into()],
            ..tag(3, "rural", "#222222")
        },
    )]
    .into_iter()
    .collect();
    let mut next = 4;
    let source = Tag {
        doclinks: vec!["https://docs.google.com/document/d/new/edit#heading=h.new".into()],
        ..tag(7, "Rural", "#111111")
    };
    let (_, changed) = reconcile_tags_by_name(&[source], &mut target_tags, &mut next);
    assert!(!changed, "no adoption means no tag change");
    assert_eq!(
        target_tags.get(&3).unwrap().doclinks,
        vec!["https://docs.google.com/document/d/kept/edit#heading=h.kept".to_string()]
    );
}

#[test]
fn reconcile_tags_dedupes_same_name_within_batch() {
    let mut target_tags: HashMap<u32, Tag> = Default::default();
    let mut next = 1;
    let (remap, _) = reconcile_tags_by_name(
        &[tag(7, "urban", "#111111"), tag(8, "Urban", "#222222")],
        &mut target_tags,
        &mut next,
    );
    assert_eq!(target_tags.len(), 1);
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
    let entry = EditEntry {
        created: vec![edited],
        removed: vec![base],
    };
    store.apply_edit_forward(&entry);
    assert!(
        store.overlay.patches.contains_key(&1),
        "edit should create a patch"
    );

    store.apply_edit_reverse(&entry);
    assert!(
        store.overlay.patches.is_empty(),
        "undo to base state should clear the patch"
    );
}

#[test]
fn overlay_update_back_to_base_clears_patch() {
    let base = loc_with_heading(1, 10.0, 20.0, 0.0);
    let mut store = setup_store_with(&[base]);
    store.bake_overlay();

    store.overlay_update(1, &patch!(heading: 90.0));
    assert!(store.overlay.patches.contains_key(&1));

    // Reverting the heading doesn't clear the patch because overlay_update
    // stamps modified_at = now, which still differs from the base.
    store.overlay_update(1, &patch!(heading: 0.0));
    assert!(
        store.overlay.patches.contains_key(&1),
        "modified_at prevents full revert to base"
    );
}

// -----------------------------------------------------------------------
// Spatial index (store integration; pure index tests live in spatial.test.rs)
// -----------------------------------------------------------------------

/// Brute-force reference: ids of alive locations within radius, sorted.
fn brute_nearby(store: &Store, lat: f64, lng: f64, r: f64) -> Vec<u32> {
    let mut out: Vec<u32> = store
        .collect(&Selector::Everything)
        .iter()
        .filter(|l| selections::haversine_m(lat, lng, l.lat, l.lng) <= r)
        .map(|l| l.id)
        .collect();
    out.sort_unstable();
    out
}

fn indexed_nearby(store: &mut Store, lat: f64, lng: f64, r: f64) -> Vec<u32> {
    let mut ids = store.find_nearby_ids(lat, lng, r);
    ids.sort_unstable();
    ids
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
            brute_nearby(&store, base.0, base.1, r),
            "radius {r}"
        );
    }

    // Mutate through every overlay path and re-verify: remove, coord patch, re-add.
    store.overlay_remove(&[loc(2, base.0 + m, base.1)]);
    store.overlay_update(3, &patch!(lat: base.0, lng: base.1));
    store.overlay_add(vec![loc(6, base.0, base.1 + m)]);
    store.overlay_update(4, &patch!(lat: 10.0)); // move far away

    for r in [0.0, 2.0, 50.0, 1000.0] {
        assert_eq!(
            indexed_nearby(&mut store, base.0, base.1, r),
            brute_nearby(&store, base.0, base.1, r),
            "radius {r} after mutations"
        );
    }
    assert_eq!(store.spatial.as_ref().unwrap().len(), store.alive_count);
}

#[test]
fn spatial_survives_bake_and_undo_roundtrip() {
    let mut store = setup_store_with(&[loc(1, 10.0, 10.0), loc(2, 10.001, 10.0)]);
    assert_eq!(indexed_nearby(&mut store, 10.0, 10.0, 5.0), vec![1]);

    store.bake_overlay();
    assert_eq!(indexed_nearby(&mut store, 10.0, 10.0, 5.0), vec![1]);

    // Undo/redo replay flows through apply_edit -> overlay fns.
    let entry = EditEntry {
        created: vec![loc(3, 10.0, 10.0)],
        removed: vec![loc(1, 10.0, 10.0)],
    };
    store.apply_edit_forward(&entry);
    assert_eq!(indexed_nearby(&mut store, 10.0, 10.0, 5.0), vec![3]);
    store.apply_edit_reverse(&entry);
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
    store.alive_count += 1;
    assert_eq!(indexed_nearby(&mut store, 10.0, 10.0, 5.0), vec![1, 2]);
}

#[test]
fn spatial_any_within() {
    let mut store = setup_store_with(&[loc(1, 10.0, 10.0)]);
    assert!(store.any_within(10.0, 10.0, 1.0));
    assert!(store.any_within(10.0004, 10.0, 50.0)); // ~45m away
    assert!(!store.any_within(10.0004, 10.0, 10.0));
    assert!(!store.any_within(-45.0, 100.0, 1000.0));
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

#[test]
fn pick_spaced_count_returns_exactly_n_subset() {
    let store = spaced_grid_store();
    let res = store
        .pick_spaced(Some(&store.selections.ids), Some(8), None)
        .unwrap();
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
    let res = store
        .pick_spaced(Some(&store.selections.ids), Some(50), None)
        .unwrap();
    assert_eq!(res.ids.len(), 20);
    assert_eq!(res.distance_m, 0);
    let uniq: HashSet<u32> = res.ids.iter().copied().collect();
    assert_eq!(uniq.len(), 20);
}

#[test]
fn pick_spaced_count_pairwise_spacing_meets_returned_distance() {
    let store = spaced_grid_store();
    let coords = coord_lookup(&store);
    let res = store
        .pick_spaced(Some(&store.selections.ids), Some(6), None)
        .unwrap();
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
    let res = store
        .pick_spaced(Some(&store.selections.ids), None, Some(250))
        .unwrap();
    assert_eq!(res.distance_m, 250);
    assert!(!res.ids.is_empty());
    let min = min_pairwise(&res.ids, &coords);
    assert!(min >= 250.0 - 1e-6, "min pairwise {min} < 250");
}

#[test]
fn pick_spaced_arg_validation() {
    let store = spaced_grid_store();
    assert!(
        store.pick_spaced(None, Some(5), Some(100)).is_err(),
        "both set"
    );
    assert!(store.pick_spaced(None, None, None).is_err(), "neither set");
    assert!(
        store.pick_spaced(None, None, Some(0)).is_err(),
        "zero distance"
    );
    assert!(
        store.pick_spaced(None, None, Some(u32::MAX)).is_err(),
        "distance above i32::MAX"
    );
}

#[test]
fn pick_spaced_empty_selection() {
    let store = setup_store_with(&[]);
    let count = store
        .pick_spaced(Some(&store.selections.ids), Some(5), None)
        .unwrap();
    assert!(count.ids.is_empty());
    assert_eq!(count.distance_m, 0);
    let dist = store
        .pick_spaced(Some(&store.selections.ids), None, Some(100))
        .unwrap();
    assert!(dist.ids.is_empty());
    assert_eq!(dist.distance_m, 0);
}

#[test]
fn pick_spaced_narrowing_overrides_selection() {
    let mut store = spaced_grid_store();
    // Selection is the whole grid; narrow to ids 1..=5 (one row).
    let set = selections::resolve(
        &store.loc_view(),
        &Selector::Manual {
            locations: vec![1, 2, 3, 4, 5],
        },
    );
    let res = store.pick_spaced(Some(&set), Some(3), None).unwrap();
    assert_eq!(res.ids.len(), 3);
    for id in &res.ids {
        assert!(*id <= 5, "id {id} outside the set");
    }

    // An empty selection does not starve a narrowed pick.
    store.selections.ids = RoaringBitmap::new();
    let res = store.pick_spaced(Some(&set), Some(3), None).unwrap();
    assert_eq!(res.ids.len(), 3);
}

// -----------------------------------------------------------------------
// Delta corruption pinning
// -----------------------------------------------------------------------

// A store with a real (non-empty) base batch, plus all three overlay kinds
// populated: adds (fresh id 10), dead (removed id 2, which lives in the base),
// patches (updated id 1, which lives in the base).
fn store_with_full_overlay() -> Store {
    let base = vec![loc(1, 1.0, 1.0), loc(2, 2.0, 2.0), loc(3, 3.0, 3.0)];
    let mut store = Store::new();
    store.map_id = Some("test-full-overlay".to_string());
    store.batch = Some(arrow::locations_to_batch(&base));
    store.alive_count = base.len();
    store.next_id = 10;

    store.overlay_update(1, &patch!(heading: 99.0));

    let l2 = store.get_loc_by_id(2).unwrap();
    store.overlay_remove(slice::from_ref(&l2));

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
        let result = panic::catch_unwind(|| rmp_serde::from_slice::<Overlay>(bytes));
        assert!(result.is_ok(), "parsing must not panic: {bytes:?}");
        assert!(result.unwrap().is_err(), "must fail to parse: {bytes:?}");
    }
}

#[test]
fn delta_parse_never_panics_on_truncated_bytes() {
    let store = store_with_full_overlay();
    let full_bytes = overlay_delta_bytes(&store.overlay).unwrap();
    assert!(full_bytes.len() > 1, "sanity: overlay has real content");
    let truncated = &full_bytes[..full_bytes.len() / 2];

    let result = panic::catch_unwind(|| rmp_serde::from_slice::<Overlay>(truncated));
    assert!(result.is_ok(), "parsing must not panic on truncated bytes");
    assert!(
        result.unwrap().is_err(),
        "truncated bytes must fail to parse"
    );
}

#[test]
fn delta_bytes_roundtrip_exact() {
    let store = store_with_full_overlay();
    let bytes = overlay_delta_bytes(&store.overlay).unwrap();
    let parsed: Overlay = rmp_serde::from_slice(&bytes).unwrap();

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
// Crash-window double-apply: save_arrow renames the base file, then
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
    fs::write(&path, b"definitely not msgpack").unwrap();

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

    let bytes = rmp_serde::to_vec(&Overlay::default()).unwrap();
    fs::write(&path, bytes).unwrap();
    assert!(load_delta(&path).is_some());
    assert!(path.exists(), "valid delta stays in place");
}

#[test]
fn crash_window_stale_delta_double_applies_baked_locations() {
    let x = vec![loc(5, 5.0, 5.0), loc(6, 6.0, 6.0)];
    let mut store = Store::new();
    store.map_id = Some("test-crash-window".to_string());
    store.batch = Some(arrow::locations_to_batch(&x));
    store.alive_count = x.len();

    // Stale delta from before the bake: re-adds the same ids the base now already has.
    let delta = delta_overlay(x.clone(), &[], vec![]);

    // Mirror store_open_map's delta-application block exactly.
    store.overlay = Tracked::unsaved(delta);

    // Mirror the post-load alive_count recompute via scan_locations.
    let LocationAggregates { alive, .. } = store.scan_locations();
    store.alive_count = alive;

    // SUSPECTED BUG: loc_view's for_each has no dedup between base rows and
    // overlay.adds, so a stale post-bake delta double-counts every id it
    // re-adds. This pins the current (corrupt) behavior, not a fixed one.
    assert_eq!(
        store.alive_count, 4,
        "stale delta double-counts ids already in the baked base"
    );

    let all = store.collect(&Selector::Everything);
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
    store.overlay_update(1, &patch!(tags: vec![2]));
    store.overlay_remove(&[base[1].clone()]);
    store.overlay_add(vec![loc_with_tags(3, -5.0, -10.0, vec![1, 2])]);

    let LocationAggregates {
        alive,
        tag_counts,
        tag_sets,
        bounds,
    } = store.scan_locations();

    assert_eq!(alive, 2);
    assert_eq!(tag_counts, HashMap::from([(1, 1), (2, 2)]));
    assert_eq!(tag_sets[&1].iter().collect::<Vec<_>>(), vec![3]);
    assert_eq!(tag_sets[&2].iter().collect::<Vec<_>>(), vec![1, 3]);
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

// Apply one op to both the real store (mirroring store_add_locations /
// store_remove_locations / store_update_locations exactly) and the parallel model.
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
            store.push_undo(EditEntry {
                created: vec![l.clone()],
                removed: vec![],
            });
            store.edits.redo.clear();
            store.add_tag_counts(slice::from_ref(&l));
            store.overlay_add(vec![l.clone()]);
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
            store.remove_tag_counts(slice::from_ref(&l));
            store.overlay_remove(slice::from_ref(&l));
            store.push_undo(EditEntry {
                created: vec![],
                removed: vec![l],
            });
            store.edits.redo.clear();
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
            store.overlay_update(id, &patch!(heading: *heading, tags: tags.clone()));
            let new_loc = store.get_loc_by_id(id).unwrap();
            store.remove_tag_counts(slice::from_ref(&old));
            store.add_tag_counts(slice::from_ref(&new_loc));
            store.record_update_undo([(old, new_loc.clone())]);
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

fn store_snapshot(store: &Store) -> Vec<Location> {
    let mut v = store.collect(&Selector::Everything);
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

        for op in &ops {
            apply_model_op(&mut store, &mut model, &mut alive_ids, op);
            proptest::prop_assert_eq!(store.alive_count, model.len(), "alive_count drifted from model mid-script");
        }

        let final_snapshot = model_snapshot(&model);
        let pushed = store.edits.undo.len();

        for _ in 0..pushed {
            press_undo(&mut store);
        }
        proptest::prop_assert_eq!(store_snapshot(&store), initial_snapshot.clone(), "full undo did not reach initial state");
        proptest::prop_assert_eq!(store.alive_count, initial.len());

        for _ in 0..pushed {
            press_redo(&mut store);
        }
        proptest::prop_assert_eq!(store_snapshot(&store), final_snapshot.clone(), "full redo did not reach final state");
        proptest::prop_assert_eq!(store.alive_count, model.len());

        // Interleaved: undo k then redo k, starting from the final state above, must
        // land back on the final state.
        let k = if pushed == 0 { 0 } else { k_raw % (pushed + 1) };
        for _ in 0..k {
            press_undo(&mut store);
        }
        for _ in 0..k {
            press_redo(&mut store);
        }
        proptest::prop_assert_eq!(store_snapshot(&store), final_snapshot, "interleaved undo/redo(k) did not land on final state");
        proptest::prop_assert_eq!(store.alive_count, model.len());
    }
}

// ---------------------------------------------------------------------------
// plan_field_op: the map-wide `extra` rewrites, previously planned in JS
// ---------------------------------------------------------------------------

fn def_of(key: &str) -> maps::ExtraFieldDef {
    maps::auto_register_field_defs(
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

fn planned_extra(u: &Update<LocationPatch>) -> serde_json::Value {
    serde_json::from_str(u.patch.extra.as_ref().unwrap().as_ref().unwrap().as_str()).unwrap()
}

fn plan(locs: &[Location], op: &FieldOp) -> Vec<Update<LocationPatch>> {
    plan_full(locs, op).updates
}

fn plan_full(locs: &[Location], op: &FieldOp) -> FieldPlan {
    let fx = Fx::base(locs);
    plan_field_op(&fx.view(), None, op).unwrap()
}

fn set_op(key: &str, value: serde_json::Value) -> FieldOp {
    FieldOp::Set {
        key: key.into(),
        value,
    }
}

fn expr_op(key: &str, expr: &str) -> FieldOp {
    FieldOp::Expr {
        key: key.into(),
        expr: expr.into(),
    }
}

fn move_op(from: &str, to: &str, winner: MergeWinner) -> FieldOp {
    FieldOp::Move {
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
        &FieldOp::Delete {
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
        &FieldOp::Delete {
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
    let FieldPlan {
        updates: out,
        forget,
        ..
    } = plan_field_op(
        &fx.view(),
        Some(&set),
        &move_op("a", "b", MergeWinner::From),
    )
    .unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, 2);
    // Row 1 still holds `a`, so the key must not be forgotten.
    assert!(forget.is_empty());
}

#[test]
fn field_op_forgets_a_key_only_when_no_row_retains_it() {
    let locs = [
        loc_with_extra(1, r#"{"a":5}"#),
        loc_with_extra(2, r#"{"a":6,"x":1}"#),
    ];
    let fx = Fx::base(&locs);

    // Whole-map move erases `a` everywhere.
    let forget = plan_field_op(&fx.view(), None, &move_op("a", "b", MergeWinner::From))
        .unwrap()
        .forget;
    assert_eq!(forget, vec!["a".to_string()]);

    // Whole-map delete of `x` erases it; `a` is untouched.
    let forget = plan_field_op(
        &fx.view(),
        None,
        &FieldOp::Delete {
            keys: vec!["x".into()],
        },
    )
    .unwrap()
    .forget;
    assert_eq!(forget, vec!["x".to_string()]);

    // Invalid move plans nothing and forgets nothing.
    let p = plan_field_op(&fx.view(), None, &move_op("a", "a", MergeWinner::From)).unwrap();
    assert!(p.updates.is_empty());
    assert!(p.forget.is_empty());
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
    assert_eq!(out[0].patch.heading, Some(90.0));
    assert!(out[0].patch.extra.is_none());
}

fn pinned_loc(id: u32, pano: &str) -> Location {
    Location {
        pano_id: Some(pano.into()),
        ..loc(id, 1.0, 1.0)
    }
}

/// The message a rejected op answers with, or a panic naming what was wrongly accepted.
fn plan_err(locs: &[Location], op: &FieldOp) -> String {
    let fx = Fx::base(locs);
    match plan_field_op(&fx.view(), None, op) {
        Err(e) => e.to_string(),
        Ok(_) => panic!("op was accepted"),
    }
}

fn del_op(keys: &[&str]) -> FieldOp {
    FieldOp::Delete {
        keys: keys.iter().map(|k| (*k).to_string()).collect(),
    }
}

#[test]
fn delete_clears_a_nullable_builtin_column_rather_than_a_phantom_extra_key() {
    let locs = [pinned_loc(1, "abc"), pinned_loc(2, "def")];
    let out = plan(&locs, &del_op(&["panoId"]));
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].patch.pano_id, Some(None), "the column is cleared");
    assert!(out[0].patch.extra.is_none(), "nothing lands in extra");
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
    assert_eq!(out[0].patch.pano_id, Some(None));
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
    assert_eq!(moved[0].patch.pano_id, Some(None));
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
    assert!(p.forget.is_empty());
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
    assert_eq!(out[0].patch.heading, Some(10.0));
}

#[test]
fn expr_op_rejects_a_syntax_error_before_touching_rows() {
    let fx = Fx::base(&[loc_with_extra(1, r#"{"a":5}"#)]);
    let err = plan_field_op(&fx.view(), None, &expr_op("a", "a +"))
        .err()
        .unwrap();
    assert!(err.0.contains("Unexpected end of expression"), "{}", err.0);
}

// A key a mutation introduces lands in the store's registry and the same result ships
// the whole registry; a mutation that adds no key ships nothing.
#[test]
fn new_extra_key_is_announced_in_the_same_result() {
    let mut store = setup_store_with(&[]);
    let r = apply_adds(&mut store, vec![loc_with_extra(1, r#"{"zz":1}"#)]);
    assert!(store.field_defs.contains_key("zz"));
    assert!(r.field_defs.is_some_and(|d| d.contains_key("zz")));
    let r = apply_adds(&mut store, vec![loc_with_extra(2, r#"{"zz":2}"#)]);
    assert!(r.field_defs.is_none());

    let r = apply_updates(
        &mut store,
        &[Update {
            id: 1,
            patch: LocationPatch {
                extra: Some(RawExtra::from_string(r#"{"zz":1,"yy":2}"#.into())),
                ..Default::default()
            },
        }],
        false,
    );
    assert!(r
        .field_defs
        .is_some_and(|d| d.contains_key("yy") && d.contains_key("zz")));
}

// A def the map already holds is never overwritten by a later inference for the same key.
#[test]
fn apply_field_defs_keeps_the_existing_def() {
    let mut store = setup_store_with(&[]);
    let mut user = def_of("k");
    user.label = Some("User edited".into());
    store.field_defs.edit().insert("k".into(), user);
    apply_field_defs(&mut store, HashMap::from([("k".to_string(), def_of("k"))]));
    assert_eq!(store.field_defs["k"].label.as_deref(), Some("User edited"));
}

// The round-trip rename invariant: a->b then b->a. The render delta never carries
// extra-only rewrites, so knownness must flow through the registry channel: the store
// forgets `a` when the move erases it, and re-announces it via field_defs when
// the reverse move brings it back.
// The command path, not just the plan: a gate that rejected a clearable builtin before
// `plan_field_op` ran would make every plan-level test above green and the feature dead.
#[test]
fn apply_field_op_clears_a_nullable_column() {
    let mut store = setup_store_with(&[pinned_loc(1, "abc")]);
    let out = apply_field_op(
        &mut store,
        &Selector::Everything,
        &del_op(&["panoId"]),
        false,
    )
    .unwrap();
    assert_eq!(out.changed, 1);
    assert!(out.failed.is_empty());
    assert!(store.get_loc_by_id(1).unwrap().pano_id.is_none());
}

#[test]
fn clearable_builtins_are_the_optional_columns_touch_leaves_empty() {
    assert_eq!(clearable_builtins(), &["panoId"]);
}

#[test]
fn apply_field_op_refuses_to_clear_the_column_the_engine_stamps() {
    let mut store = setup_store_with(&[pinned_loc(1, "abc")]);
    let Err(err) = apply_field_op(
        &mut store,
        &Selector::Everything,
        &del_op(&["modifiedAt"]),
        false,
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
    let out = apply_field_op(
        &mut store,
        &Selector::Everything,
        &expr_op("h", "a + 1"),
        false,
    )
    .unwrap();
    assert_eq!(out.changed, 1);
    assert_eq!(out.failed, vec![2, 3]);
}

#[test]
fn apply_field_op_refuses_a_column_it_cannot_clear() {
    let mut store = setup_store_with(&[loc(1, 1.0, 1.0)]);
    let Err(err) = apply_field_op(
        &mut store,
        &Selector::Everything,
        &del_op(&["heading"]),
        false,
    ) else {
        panic!("heading is writable, never clearable")
    };
    assert!(err.0.contains("cannot be removed"), "{}", err.0);
}

#[test]
fn apply_field_op_refuses_a_non_numeric_assignment() {
    let mut store = setup_store_with(&[loc(1, 1.0, 1.0)]);
    assert!(apply_field_op(
        &mut store,
        &Selector::Everything,
        &set_op("heading", serde_json::json!("north")),
        false,
    )
    .is_err());
}

#[test]
fn field_op_round_trip_rename_reannounces_the_key() {
    let mut store = setup_store_with(&[
        loc_with_extra(1, r#"{"a":5}"#),
        loc_with_extra(2, r#"{"a":6}"#),
    ]);
    store.field_defs.edit().insert("a".into(), def_of("a"));

    let r1 = apply_field_op(
        &mut store,
        &Selector::Everything,
        &move_op("a", "b", MergeWinner::From),
        false,
    )
    .unwrap()
    .mutation;
    assert!(r1.delta.updated.is_empty(), "extra-only: no render delta");
    assert!(!store.field_defs.contains_key("a"), "a erased, forgotten");
    assert!(store.field_defs.contains_key("b"), "b auto-registered");
    assert!(
        r1.field_defs.as_ref().is_some_and(|d| !d.contains_key("a")),
        "the result ships the registry without a"
    );

    let r2 = apply_field_op(
        &mut store,
        &Selector::Everything,
        &move_op("b", "a", MergeWinner::From),
        false,
    )
    .unwrap()
    .mutation;
    assert!(store.field_defs.contains_key("a"));
    assert!(!store.field_defs.contains_key("b"));
    assert!(
        r2.field_defs.is_some_and(|d| d.contains_key("a")),
        "reappearing key is re-announced"
    );
}

#[test]
fn collect_honours_each_selector_shape() {
    let store = setup_store_with(&[loc(1, 1.0, 1.0), loc(2, 2.0, 2.0), loc(3, 3.0, 3.0)]);
    let ids = |locs: Vec<Location>| locs.iter().map(|l| l.id).collect::<Vec<u32>>();

    assert_eq!(ids(store.collect(&Selector::Everything)), vec![1, 2, 3]);
    // The named-ids fast path keeps request order and skips dead ids.
    assert_eq!(
        ids(store.collect(&Selector::Locations {
            locations: vec![3, 1, 9],
            name: None,
        })),
        vec![3, 1]
    );
    assert_eq!(
        ids(store.collect(&Selector::Manual {
            locations: vec![1, 3]
        })),
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

fn added_ids(result: &MutationResult) -> Vec<u32> {
    result.delta.added.iter().map(|a| a.id).collect()
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
    let result = apply_adds(&mut store, uploaded);

    let ids = added_ids(&result);
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
    let direct = apply_adds(&mut direct_store, locs.clone());

    let mut uploaded_store = setup_store_with(&[]);
    let session = stage_chunks(&[locs[..2].to_vec(), locs[2..].to_vec()]);
    let uploaded = apply_adds(
        &mut uploaded_store,
        export::read_uploaded_chunks::<Location>(&session).unwrap(),
    );

    assert_eq!(
        serde_json::to_value(&direct).unwrap(),
        serde_json::to_value(&uploaded).unwrap()
    );
    assert_eq!(
        direct_store.edits.undo.len(),
        uploaded_store.edits.undo.len()
    );
    assert_eq!(
        direct_store.edits.undo.last().unwrap().created,
        uploaded_store.edits.undo.last().unwrap().created
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
        apply_adds(&mut store, locs);
    }

    assert_eq!(store.alive_count, 1);
    assert!(store.edits.undo.is_empty());
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
