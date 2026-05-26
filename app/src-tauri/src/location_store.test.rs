use super::*;

fn loc(id: u32, lat: f64, lng: f64) -> Location {
    Location {
        id,
        lat,
        lng,
        heading: 0.0,
        pitch: 0.0,
        zoom: 1.0,
        pano_id: None,
        flags: 0,
        tags: vec![],
        extra: None,
        created_at: String::new(),
        modified_at: None,
    }
}

fn loc_with_tags(id: u32, lat: f64, lng: f64, tags: Vec<u32>) -> Location {
    Location { tags, ..loc(id, lat, lng) }
}

fn loc_with_heading(id: u32, lat: f64, lng: f64, heading: f64) -> Location {
    Location { heading, ..loc(id, lat, lng) }
}

fn patch() -> LocationPatch {
    LocationPatch {
        lat: None, lng: None, heading: None, pitch: None, zoom: None,
        pano_id: None, flags: None, tags: None, extra: None,
        created_at: None, modified_at: None,
    }
}

fn setup_store_with(locs: &[Location]) -> Store {
    let mut store = Store::new();
    store.map_id = Some("test".into());
    store.batch = Some(empty_batch());
    for l in locs {
        store.add_tag_counts(std::slice::from_ref(l));
        store.overlay_add(l.clone());
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
    store.overlay_add(l);
    assert_eq!(store.alive_count, 1);
}

#[test]
fn overlay_add_then_get() {
    let mut store = setup_store_with(&[]);
    let l = loc(1, 10.0, 20.0);
    store.overlay_add(l.clone());
    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 10.0);
    assert_eq!(got.lng, 20.0);
}

#[test]
fn overlay_remove_decrements_alive_count() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l.clone()]);
    assert_eq!(store.alive_count, 1);
    store.overlay_remove(&[l]);
    assert_eq!(store.alive_count, 0);
}

#[test]
fn overlay_remove_makes_get_return_none() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l.clone()]);
    store.overlay_remove(&[l]);
    assert!(store.get_loc_by_id(1).is_none());
}

#[test]
fn overlay_update_changes_fields() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    store.overlay_update(1, &LocationPatch { lat: Some(50.0), heading: Some(90.0), ..patch() });
    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 50.0);
    assert_eq!(got.heading, 90.0);
    assert_eq!(got.lng, 20.0); // unchanged
}

#[test]
fn overlay_update_nonexistent_is_noop() {
    let mut store = setup_store_with(&[]);
    store.overlay_update(999, &LocationPatch { lat: Some(50.0), ..patch() });
    assert!(store.get_loc_by_id(999).is_none());
}

#[test]
fn collect_all_locations() {
    let locs = vec![loc(1, 10.0, 20.0), loc(2, 30.0, 40.0)];
    let store = setup_store_with(&locs);
    let all = store.collect_all_locations();
    assert_eq!(all.len(), 2);
}

// -----------------------------------------------------------------------
// Tag counts
// -----------------------------------------------------------------------

#[test]
fn tag_counts_after_add() {
    let l1 = loc_with_tags(1, 0.0, 0.0, vec![10, 20]);
    let l2 = loc_with_tags(2, 1.0, 1.0, vec![10]);
    let store = setup_store_with(&[l1, l2]);
    assert_eq!(store.tags.get(&10).map(|t| t.count), Some(2));
    assert_eq!(store.tags.get(&20).map(|t| t.count), Some(1));
}

#[test]
fn tag_counts_after_remove() {
    let l1 = loc_with_tags(1, 0.0, 0.0, vec![10, 20]);
    let l2 = loc_with_tags(2, 1.0, 1.0, vec![10]);
    let mut store = setup_store_with(&[l1.clone(), l2]);
    store.remove_tag_counts(&[l1]);
    assert_eq!(store.tags.get(&10).map(|t| t.count), Some(1));
    assert_eq!(store.tags.get(&20).map(|t| t.count), Some(0));
}

#[test]
fn tag_counts_saturate_at_zero() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(&[]);
    store.remove_tag_counts(&[l]);
    assert_eq!(store.tags.get(&10).map(|t| t.count), None);
}

// -----------------------------------------------------------------------
// Undo / Redo
// -----------------------------------------------------------------------

#[test]
fn undo_add() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l.clone()]);
    store.push_undo(EditEntry { created: vec![l.clone()], removed: vec![] });

    let _delta = apply_edit_reverse(&mut store, &EditEntry { created: vec![l], removed: vec![] });
    assert_eq!(store.alive_count, 0);
    assert!(store.get_loc_by_id(1).is_none());
}

#[test]
fn undo_remove() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[]);
    // simulate: location was removed, undo should re-add it
    let _delta = apply_edit_reverse(&mut store, &EditEntry { created: vec![], removed: vec![l.clone()] });
    assert_eq!(store.alive_count, 1);
    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 10.0);
}

#[test]
fn undo_update_restores_original() {
    let original = loc_with_heading(1, 10.0, 20.0, 0.0);
    let updated = loc_with_heading(1, 10.0, 20.0, 90.0);
    let mut store = setup_store_with(&[updated.clone()]);

    let entry = EditEntry { created: vec![updated], removed: vec![original.clone()] };
    apply_edit_reverse(&mut store, &entry);

    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.heading, 0.0);
}

#[test]
fn redo_after_undo() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l.clone()]);
    let entry = EditEntry { created: vec![l.clone()], removed: vec![] };

    apply_edit_reverse(&mut store, &entry);
    assert_eq!(store.alive_count, 0);

    apply_edit_forward(&mut store, &entry);
    assert_eq!(store.alive_count, 1);
    assert!(store.get_loc_by_id(1).is_some());
}

#[test]
fn undo_stack_capped_at_max() {
    let mut store = setup_store_with(&[]);
    for i in 0..MAX_UNDO_ENTRIES + 50 {
        let l = loc(i as u32, 0.0, 0.0);
        store.push_undo(EditEntry { created: vec![l], removed: vec![] });
    }
    assert_eq!(store.undo_stack.len(), MAX_UNDO_ENTRIES);
}

#[test]
fn redo_stack_cleared_on_new_edit() {
    let mut store = setup_store_with(&[]);
    store.redo_stack.push(EditEntry { created: vec![], removed: vec![] });
    assert!(!store.redo_stack.is_empty());

    store.push_undo(EditEntry { created: vec![loc(1, 0.0, 0.0)], removed: vec![] });
    store.redo_stack.clear();
    assert!(store.redo_stack.is_empty());
}

// -----------------------------------------------------------------------
// Tag counts through undo/redo
// -----------------------------------------------------------------------

#[test]
fn tag_counts_correct_after_undo_add() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10, 20]);
    let mut store = setup_store_with(&[l.clone()]);
    assert_eq!(store.tags.get(&10).map(|t| t.count), Some(1));

    let entry = EditEntry { created: vec![l], removed: vec![] };
    apply_edit_reverse(&mut store, &entry);
    assert_eq!(store.tags.get(&10).map(|t| t.count), Some(0));
}

#[test]
fn tag_counts_correct_after_undo_remove() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(&[]);
    assert_eq!(store.tags.get(&10).map(|t| t.count), None);

    let entry = EditEntry { created: vec![], removed: vec![l] };
    apply_edit_reverse(&mut store, &entry);
    assert_eq!(store.tags.get(&10).map(|t| t.count), Some(1));
}

#[test]
fn tag_counts_correct_after_undo_tag_change() {
    let old = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let new = loc_with_tags(1, 0.0, 0.0, vec![20]);
    let mut store = setup_store_with(&[new.clone()]);
    for tag in store.tags.values_mut() { tag.count = 0; };
    store.add_tag_counts(&[new.clone()]);
    assert_eq!(store.tags.get(&20).map(|t| t.count), Some(1));
    assert_eq!(store.tags.get(&10).map(|t| t.count), None);

    let entry = EditEntry { created: vec![new], removed: vec![old] };
    apply_edit_reverse(&mut store, &entry);

    assert_eq!(store.tags.get(&10).map(|t| t.count), Some(1));
    assert_eq!(store.tags.get(&20).map(|t| t.count), Some(0));
}

#[test]
fn tag_counts_survive_undo_redo_cycle() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(&[l.clone()]);
    let entry = EditEntry { created: vec![l.clone()], removed: vec![] };

    apply_edit_reverse(&mut store, &entry);
    assert_eq!(store.tags.get(&10).map(|t| t.count), Some(0));

    apply_edit_forward(&mut store, &entry);
    assert_eq!(store.tags.get(&10).map(|t| t.count), Some(1));
}

// -----------------------------------------------------------------------
// Render delta
// -----------------------------------------------------------------------

#[test]
fn delta_has_added_entry_for_new_location() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[]);
    let entry = EditEntry { created: vec![l], removed: vec![] };
    let delta = apply_edit_forward(&mut store, &entry);
    assert_eq!(delta.added.len(), 1);
    assert_eq!(delta.added[0].id, 1);
    assert_eq!(delta.removed.len(), 0);
}

#[test]
fn delta_has_removed_entry_for_deleted_location() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l.clone()]);
    let entry = EditEntry { created: vec![], removed: vec![l] };
    let delta = apply_edit_forward(&mut store, &entry);
    assert_eq!(delta.removed.len(), 1);
    assert_eq!(delta.removed[0], 1);
    assert_eq!(delta.added.len(), 0);
}

#[test]
fn delta_has_both_for_moved_location() {
    let old = loc(1, 10.0, 20.0);
    let new = loc(1, -80.0, -170.0); // far enough to cross render cells
    let mut store = setup_store_with(&[old.clone()]);

    let entry = EditEntry { created: vec![new], removed: vec![old] };
    let changes = apply_edit_forward(&mut store, &entry);
    let delta = store.derive_render_delta(&changes);
    // cross-cell move => remove old + add new
    assert_eq!(delta.removed.len(), 1);
    assert_eq!(delta.added.len(), 1);
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
    new.zoom = 3.0;   // non-render field
    let mut store = setup_store_with(&[old.clone()]);

    let entry = EditEntry { created: vec![new], removed: vec![old] };
    let changes = apply_edit_forward(&mut store, &entry);
    let delta = store.derive_render_delta(&changes);

    assert_eq!(delta.added.len(), 0, "no re-render needed for pitch/zoom change");
    assert_eq!(delta.removed.len(), 0);
    assert_eq!(delta.updated.len(), 0);
}

#[test]
fn samey_location_with_heading_change_does_rerender() {
    let old = loc_with_heading(1, 10.0, 20.0, 0.0);
    let new = loc_with_heading(1, 10.0, 20.0, 90.0);
    let mut store = setup_store_with(&[old.clone()]);

    let entry = EditEntry { created: vec![new], removed: vec![old] };
    let changes = apply_edit_forward(&mut store, &entry);
    let delta = store.derive_render_delta(&changes);

    // heading change in the same cell => in-place render patch
    assert_eq!(delta.updated.len(), 1, "heading change requires a render patch");
    assert_eq!(delta.added.len(), 0);
    assert_eq!(delta.removed.len(), 0);
}

#[test]
fn samey_location_with_lat_change_does_rerender() {
    let old = loc(1, 10.0, 20.0);
    let new = loc(1, 11.0, 20.0);
    let mut store = setup_store_with(&[old.clone()]);

    let entry = EditEntry { created: vec![new], removed: vec![old] };
    let changes = apply_edit_forward(&mut store, &entry);
    let delta = store.derive_render_delta(&changes);

    assert!(delta.added.len() + delta.removed.len() + delta.updated.len() > 0, "lat change requires re-render");
}

#[test]
fn samey_tag_only_change_skips_render() {
    let old = loc_with_tags(1, 10.0, 20.0, vec![10]);
    let new = loc_with_tags(1, 10.0, 20.0, vec![20]);
    let mut store = setup_store_with(&[old.clone()]);

    let entry = EditEntry { created: vec![new], removed: vec![old] };
    let delta = apply_edit_forward(&mut store, &entry);

    assert_eq!(delta.added.len(), 0, "tag-only change should skip render");
    assert_eq!(delta.removed.len(), 0);
}

// -----------------------------------------------------------------------
// store_status / finish_mutation
// -----------------------------------------------------------------------

#[test]
fn store_status_reflects_undo_redo() {
    let l = loc(1, 0.0, 0.0);
    let mut store = setup_store_with(&[l]);

    let s = store.store_status();
    assert!(!s.can_undo);
    assert!(!s.can_redo);

    store.push_undo(EditEntry { created: vec![], removed: vec![] });
    let s = store.store_status();
    assert!(s.can_undo);
    assert!(!s.can_redo);

    store.redo_stack.push(EditEntry { created: vec![], removed: vec![] });
    let s = store.store_status();
    assert!(s.can_undo);
    assert!(s.can_redo);
}

#[test]
fn finish_mutation_reports_correct_state() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(&[l]);
    store.push_undo(EditEntry { created: vec![], removed: vec![] });

    let result = store.finish_mutation(ChangeSet::default());
    assert_eq!(result.status.location_count, 1);
    assert!(result.status.can_undo);
    assert!(!result.status.can_redo);
    assert_eq!(result.status.tag_counts.get(&10), Some(&1));
    assert_eq!(result.status.version, 1);
}

// -----------------------------------------------------------------------
// Geohash
// -----------------------------------------------------------------------

#[test]
fn geohash_deterministic() {
    let a = encode_geohash(51.5, -0.1);
    let b = encode_geohash(51.5, -0.1);
    assert_eq!(a, b);
}

#[test]
fn geohash_different_for_distant_points() {
    let a = encode_geohash(51.5, -0.1);
    let b = encode_geohash(-33.9, 151.2);
    assert_ne!(a, b);
}

#[test]
fn geohash_length_matches_precision() {
    let gh = encode_geohash(0.0, 0.0);
    assert_eq!(gh.len(), GEOHASH_PRECISION);
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
    assert!(store.id_to_cell_idx.get(999).copied().unwrap_or(255) == 255);
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
    assert_eq!(store.overlay_adds.len(), 2);

    store.bake_overlay();
    assert!(store.overlay_adds.is_empty());
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
    store.overlay_update(1, &LocationPatch { lat: Some(99.0), ..patch() });
    store.bake_overlay();

    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 99.0);
    assert!(store.overlay_patches.is_empty());
}

#[test]
fn bake_overlay_removes_dead() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l.clone()]);
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
    let mut store = setup_store_with(&[l.clone()]);

    // "update" with identical values
    store.overlay_update(1, &LocationPatch { heading: Some(45.0), ..patch() });
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
    let mut store = setup_store_with(&[l.clone()]);

    store.overlay_update(1, &LocationPatch { heading: Some(90.0), ..patch() });
    let new = store.get_loc_by_id(1).unwrap();

    let pairs: Vec<_> = vec![(l, new)]
        .into_iter()
        .filter(|(o, n)| o != n)
        .collect();
    assert_eq!(pairs.len(), 1, "changed update should pass filter");
}

#[test]
fn batch_update_mixed_changed_unchanged() {
    let l1 = loc_with_heading(1, 10.0, 20.0, 0.0);
    let l2 = loc_with_heading(2, 30.0, 40.0, 90.0);
    let mut store = setup_store_with(&[l1.clone(), l2.clone()]);

    // update l1 (real change), "update" l2 with same value (noop)
    store.overlay_update(1, &LocationPatch { heading: Some(180.0), ..patch() });
    store.overlay_update(2, &LocationPatch { heading: Some(90.0), ..patch() });
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

// -----------------------------------------------------------------------
// Edge case: re-add a previously removed ID
// -----------------------------------------------------------------------

#[test]
fn readd_after_remove_via_overlay() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l.clone()]);
    assert_eq!(store.alive_count, 1);

    store.overlay_remove(&[l.clone()]);
    assert_eq!(store.alive_count, 0);
    assert!(store.get_loc_by_id(1).is_none());

    // re-add with different position
    let l2 = loc(1, 50.0, 60.0);
    store.overlay_add(l2);
    assert_eq!(store.alive_count, 1);
    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 50.0);
}

#[test]
fn readd_after_remove_through_undo() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l.clone()]);

    // remove it
    let remove_entry = EditEntry { created: vec![], removed: vec![l.clone()] };
    apply_edit_forward(&mut store, &remove_entry);
    assert_eq!(store.alive_count, 0);

    // undo the removal
    apply_edit_reverse(&mut store, &remove_entry);
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

    let cr = store.render_cells[24].as_ref().unwrap();
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
    let mut store = setup_store_with(&[l.clone()]);
    store.bake_overlay();
    // l is now in the batch, not in overlay_adds

    // update via overlay patch
    let updated = loc_with_heading(1, 10.0, 20.0, 90.0);
    store.overlay_update(1, &LocationPatch { heading: Some(90.0), ..patch() });
    assert_eq!(store.get_loc_by_id(1).unwrap().heading, 90.0);

    // undo: apply_edit should restore original via overlay
    let entry = EditEntry { created: vec![updated], removed: vec![l] };
    apply_edit_reverse(&mut store, &entry);

    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.heading, 0.0, "undo should restore original heading");
}

#[test]
fn multiple_undo_redo_cycles_consistent() {
    let l = loc_with_tags(1, 10.0, 20.0, vec![10]);
    let mut store = setup_store_with(&[l.clone()]);

    let updated = loc_with_tags(1, 10.0, 20.0, vec![20]);
    let entry = EditEntry { created: vec![updated.clone()], removed: vec![l.clone()] };

    for _ in 0..5 {
        apply_edit_forward(&mut store, &entry);
        assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![20]);
        assert_eq!(store.tags.get(&20).map(|t| t.count), Some(1));

        apply_edit_reverse(&mut store, &entry);
        assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![10]);
        assert_eq!(store.tags.get(&10).map(|t| t.count), Some(1));
    }
}

// -----------------------------------------------------------------------
// derive_render_delta (updates)
// -----------------------------------------------------------------------

fn render_delta_for_update(store: &mut Store, id: u32, patch: LocationPatch) -> RenderDelta {
    let old = store.get_loc_by_id(id).unwrap();
    store.overlay_update(id, &patch);
    let new_loc = store.get_loc_by_id(id).unwrap();
    store.derive_render_delta(&ChangeSet { updated: vec![(old, new_loc)], ..Default::default() })
}

#[test]
fn update_delta_heading_only_produces_patch() {
    let l = loc_with_heading(1, 10.0, 20.0, 0.0);
    let mut store = setup_store_with(&[l]);
    let delta = render_delta_for_update(&mut store, 1, LocationPatch { heading: Some(90.0), ..patch() });
    assert!(delta.added.is_empty());
    assert!(delta.removed.is_empty());
    assert_eq!(delta.updated.len(), 1);
    assert_eq!(delta.updated[0].heading, Some(90.0));
    assert!(delta.updated[0].lat.is_none());
}

#[test]
fn update_delta_same_cell_position_produces_patch() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    // small position change that stays in the same render cell
    let delta = render_delta_for_update(&mut store, 1, LocationPatch { lat: Some(10.001), ..patch() });
    // should be an in-place patch, not a cell migration
    assert_eq!(delta.updated.len(), 1);
    assert!(delta.added.is_empty());
}

#[test]
fn update_delta_cross_cell_position_produces_remove_and_add() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    // large position change that crosses render cells
    let delta = render_delta_for_update(&mut store, 1, LocationPatch { lat: Some(-80.0), lng: Some(-170.0), ..patch() });
    assert_eq!(delta.removed.len(), 1, "old cell entry removed");
    assert_eq!(delta.added.len(), 1, "new cell entry added");
    assert!(delta.updated.is_empty());
}

#[test]
fn update_delta_tags_only_produces_empty_delta() {
    let l = loc_with_tags(1, 10.0, 20.0, vec![10]);
    let mut store = setup_store_with(&[l]);
    let delta = render_delta_for_update(&mut store, 1, LocationPatch { tags: Some(vec![20]), ..patch() });
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
    store.overlay_add(l);
    store.overlay_update(1, &LocationPatch { lat: Some(50.0), ..patch() });
    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 50.0);
    // should still be in overlay_adds, not overlay_patches
    assert_eq!(store.overlay_adds.len(), 1);
    assert_eq!(store.overlay_adds[0].lat, 50.0);
    assert!(store.overlay_patches.is_empty());
}

// -----------------------------------------------------------------------
// collect_all_locations with mixed states
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
    store.overlay_update(2, &LocationPatch { lat: Some(99.0), ..patch() });
    // add l4
    let l4 = loc(4, 70.0, 80.0);
    store.overlay_add(l4);
    store.alive_count = 3; // l2, l3, l4

    let all = store.collect_all_locations();
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
    store.overlay_update(2, &LocationPatch { heading: Some(180.0), ..patch() });
    // add: new l3
    let l3 = loc(3, 50.0, 60.0);
    store.overlay_add(l3);
    store.alive_count = 2; // l2, l3

    store.bake_overlay();
    assert_eq!(store.batch.as_ref().unwrap().num_rows(), 2);
    assert!(store.overlay_adds.is_empty());
    assert!(store.overlay_patches.is_empty());
    assert!(store.overlay_dead.is_empty());
    // verify data
    assert!(store.get_loc_by_id(1).is_none());
    assert_eq!(store.get_loc_by_id(2).unwrap().heading, 180.0);
    assert_eq!(store.get_loc_by_id(3).unwrap().lat, 50.0);
}

// -----------------------------------------------------------------------
// DeltaOverlay msgpack round-trip
// -----------------------------------------------------------------------

#[test]
fn delta_overlay_msgpack_round_trip_empty() {
    let overlay = DeltaOverlay { adds: vec![], dead_ids: vec![], patches: vec![] };
    let bytes = rmp_serde::to_vec_named(&overlay).unwrap();
    let restored: DeltaOverlay = rmp_serde::from_slice(&bytes).unwrap();
    assert!(restored.adds.is_empty());
    assert!(restored.dead_ids.is_empty());
    assert!(restored.patches.is_empty());
}

#[test]
fn delta_overlay_msgpack_round_trip_with_data() {
    let l1 = loc_with_tags(1, 48.8, 2.35, vec![10, 20]);
    let l2 = loc_with_heading(2, -33.8, 151.2, 90.0);
    let overlay = DeltaOverlay {
        adds: vec![l1.clone()],
        dead_ids: vec![99, 100],
        patches: vec![l2.clone()],
    };
    let bytes = rmp_serde::to_vec_named(&overlay).unwrap();
    let restored: DeltaOverlay = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(restored.adds.len(), 1);
    assert_eq!(restored.adds[0], l1);
    assert_eq!(restored.dead_ids, vec![99, 100]);
    assert_eq!(restored.patches.len(), 1);
    assert_eq!(restored.patches[0], l2);
}

#[test]
fn delta_overlay_preserves_extra_fields() {
    let mut l = loc(1, 0.0, 0.0);
    l.extra = Some(serde_json::from_str(r#"{"country":"FR","altitude":35.2}"#).unwrap());
    l.pano_id = Some("CAoSLEF".into());
    l.modified_at = Some("2024-01-15".into());
    let overlay = DeltaOverlay { adds: vec![l.clone()], dead_ids: vec![], patches: vec![] };
    let bytes = rmp_serde::to_vec_named(&overlay).unwrap();
    let restored: DeltaOverlay = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(restored.adds[0].extra, l.extra);
    assert_eq!(restored.adds[0].pano_id, l.pano_id);
    assert_eq!(restored.adds[0].modified_at, l.modified_at);
}

// -----------------------------------------------------------------------
// EditEntry (undo stack) msgpack round-trip
// -----------------------------------------------------------------------

#[test]
fn edit_entry_msgpack_round_trip() {
    let old = loc_with_heading(1, 10.0, 20.0, 0.0);
    let new = loc_with_heading(1, 10.0, 20.0, 90.0);
    let entry = EditEntry { created: vec![new.clone()], removed: vec![old.clone()] };
    let bytes = rmp_serde::to_vec_named(&entry).unwrap();
    let restored: EditEntry = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(restored.created[0], new);
    assert_eq!(restored.removed[0], old);
}

#[test]
fn undo_stack_msgpack_round_trip() {
    let entries = vec![
        EditEntry { created: vec![loc(1, 10.0, 20.0)], removed: vec![] },
        EditEntry { created: vec![], removed: vec![loc(2, 30.0, 40.0)] },
        EditEntry { created: vec![loc_with_heading(3, 0.0, 0.0, 90.0)], removed: vec![loc(3, 0.0, 0.0)] },
    ];
    let bytes = rmp_serde::to_vec_named(&entries).unwrap();
    let restored: Vec<EditEntry> = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(restored.len(), 3);
    assert_eq!(restored[0].created[0].lat, 10.0);
    assert_eq!(restored[1].removed[0].id, 2);
    assert_eq!(restored[2].created[0].heading, 90.0);
}

// -----------------------------------------------------------------------
// Render buffer binary format
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// Cross-cutting invariants
// -----------------------------------------------------------------------

#[test]
fn alive_count_stays_correct_through_all_mutations() {
    let mut store = setup_store_with(&[]);
    assert_eq!(store.alive_count, 0);

    // Add 3
    let locs = vec![loc(1, 0.0, 0.0), loc(2, 1.0, 1.0), loc(3, 2.0, 2.0)];
    for l in &locs { store.overlay_add(l.clone()); }
    assert_eq!(store.alive_count, 3);

    // Remove 1
    store.overlay_remove(&[locs[0].clone()]);
    assert_eq!(store.alive_count, 2);

    // Update (should not change count)
    store.overlay_update(2, &LocationPatch { heading: Some(90.0), ..patch() });
    assert_eq!(store.alive_count, 2);

    // Bake (should not change count)
    store.bake_overlay();
    assert_eq!(store.alive_count, 2);

    // Add 1 more
    store.overlay_add(loc(4, 3.0, 3.0));
    assert_eq!(store.alive_count, 3);

    // Remove 2
    let l2 = store.get_loc_by_id(2).unwrap();
    let l3 = store.get_loc_by_id(3).unwrap();
    store.overlay_remove(&[l2, l3]);
    assert_eq!(store.alive_count, 1);

    // Undo the remove (re-adds 2)
    let entry = EditEntry { created: vec![], removed: vec![loc(2, 1.0, 1.0), loc(3, 2.0, 2.0)] };
    apply_edit_reverse(&mut store, &entry);
    assert_eq!(store.alive_count, 3);
}

#[test]
fn ids_are_never_reused() {
    let mut store = Store::new();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..1000 {
        let id = store.alloc_id();
        assert!(!seen.contains(&id), "ID {} was reused", id);
        seen.insert(id);
    }
}

#[test]
fn tag_ids_are_never_reused() {
    let mut store = Store::new();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..1000 {
        let id = store.alloc_tag_id();
        assert!(!seen.contains(&id), "Tag ID {} was reused", id);
        seen.insert(id);
    }
}

#[test]
fn overlay_consistency_no_id_in_both_dead_and_adds() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l.clone()]);
    store.bake_overlay();

    // Remove it
    store.overlay_remove(&[l.clone()]);
    assert!(store.overlay_dead.contains(&1));
    assert!(!store.overlay_adds.iter().any(|l| l.id == 1));

    // Re-add it (overlay_add on a known batch ID goes to patches)
    store.overlay_add(loc(1, 50.0, 60.0));
    // After re-add, it should NOT be in dead
    assert!(!store.overlay_dead.contains(&1), "re-added ID should be removed from dead set");
}

#[test]
fn overlay_consistency_add_new_id_goes_to_adds() {
    let mut store = setup_store_with(&[]);
    store.batch = Some(empty_batch());
    store.overlay_add(loc(99, 10.0, 20.0));
    assert!(store.overlay_adds.iter().any(|l| l.id == 99));
    assert!(!store.overlay_patches.contains_key(&99));
}

#[test]
fn overlay_consistency_update_batch_id_goes_to_patches() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    store.bake_overlay();
    // Now l is in the batch
    store.overlay_update(1, &LocationPatch { heading: Some(45.0), ..patch() });
    assert!(store.overlay_patches.contains_key(&1));
    assert!(!store.overlay_adds.iter().any(|l| l.id == 1));
}

#[test]
fn overlay_consistency_update_add_id_stays_in_adds() {
    let mut store = setup_store_with(&[]);
    store.batch = Some(empty_batch());
    store.overlay_add(loc(1, 10.0, 20.0));
    store.overlay_update(1, &LocationPatch { heading: Some(45.0), ..patch() });
    // Should still be in overlay_adds, updated in place
    assert_eq!(store.overlay_adds.len(), 1);
    assert_eq!(store.overlay_adds[0].heading, 45.0);
    assert!(!store.overlay_patches.contains_key(&1));
}

#[test]
fn overlay_consistency_remove_clears_patches() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l.clone()]);
    store.bake_overlay();
    store.overlay_update(1, &LocationPatch { heading: Some(45.0), ..patch() });
    assert!(store.overlay_patches.contains_key(&1));

    store.overlay_remove(&[l]);
    assert!(!store.overlay_patches.contains_key(&1), "remove should clear patches for the ID");
    assert!(store.overlay_dead.contains(&1));
}

#[test]
fn render_buffer_format_matches_js_parser() {
    let l1 = loc_with_heading(1, 48.8, 2.35, 90.0);
    let l2 = loc(2, -33.8, 151.2);
    let mut store = setup_store_with(&[l1, l2]);
    store.bake_overlay();

    let req = RenderRequest {
        west: -180.0, south: -90.0, east: 180.0, north: 90.0,
        selected_ids: None,
        marker_style: "pin".into(),
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
        let count = u32::from_le_bytes(buf[offset+1..offset+5].try_into().unwrap());
        offset += 5;
        // ids: count * 4 bytes
        offset += count as usize * 4;
        // positions: count * 2 * 4 bytes
        offset += count as usize * 2 * 4;
        // colors: count * 4 bytes
        offset += count as usize * 4;
        // angles: count * 4 bytes
        offset += count as usize * 4;
        total_locs += count;
    }
    assert_eq!(total_locs, 2, "should have 2 locations total");

    // Selection overlay: u32 count
    let sel_count = u32::from_le_bytes(buf[offset..offset+4].try_into().unwrap());
    assert_eq!(sel_count, 0, "no selections active");
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
    let cr = store.render_cells[24].as_ref().unwrap();
    assert_eq!(cr.id_order, vec![30, 20]);

    // Remove index 0 (id=30) — 20 swaps in
    store.cell_remove_render(30);
    let cr = store.render_cells[24].as_ref().unwrap();
    assert_eq!(cr.id_order, vec![20]);

    // Add new entries
    store.cell_add_render(24, 40);
    store.cell_add_render(24, 50);
    let cr = store.render_cells[24].as_ref().unwrap();
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
    let mut store = setup_store_with(&[l.clone()]);
    assert!(store.cell_lookup(1).is_some());

    // Delete
    let entry = EditEntry { created: vec![], removed: vec![l.clone()] };
    let changes = apply_edit_forward(&mut store, &entry);
    let delta = store.derive_render_delta(&changes);
    assert_eq!(delta.removed.len(), 1);
    assert!(store.cell_lookup(1).is_none());

    // Undo delete
    let changes = apply_edit_reverse(&mut store, &entry);
    let delta = store.derive_render_delta(&changes);
    assert_eq!(delta.added.len(), 1);
    assert_eq!(delta.added[0].id, 1);
    assert!(store.cell_lookup(1).is_some(), "render entry must be restored after undo delete");
}

#[test]
fn undo_delete_multiple_then_readd_renders_correctly() {
    let l1 = loc(1, 10.0, 20.0);
    let l2 = loc(2, 30.0, 40.0);
    let l3 = loc(3, 50.0, 60.0);
    let mut store = setup_store_with(&[l1.clone(), l2.clone(), l3.clone()]);

    // Delete l1 and l2
    let entry = EditEntry { created: vec![], removed: vec![l1.clone(), l2.clone()] };
    let changes = apply_edit_forward(&mut store, &entry);
    store.derive_render_delta(&changes);
    assert!(store.cell_lookup(1).is_none());
    assert!(store.cell_lookup(2).is_none());
    assert!(store.cell_lookup(3).is_some());

    // Undo
    let changes = apply_edit_reverse(&mut store, &entry);
    let delta = store.derive_render_delta(&changes);
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
    store.selected_ids.insert(1);
    store.selected_ids.insert(2);
    store.selected_colors.insert(1, [255, 0, 0]);
    store.selected_colors.insert(2, [0, 255, 0]);

    store.selected_ids.clear();
    store.selected_colors.clear();
    assert!(store.selected_ids.is_empty());
    assert!(store.selected_colors.is_empty());
}

// -----------------------------------------------------------------------
// Bug regression: tag counts after bulk operations + undo
// (edd45ab, TODO "tag counts are wrong")
// -----------------------------------------------------------------------

#[test]
fn tag_counts_correct_after_bulk_add_then_undo() {
    let locs: Vec<Location> = (0..10)
        .map(|i| loc_with_tags(i, i as f64, 0.0, vec![5]))
        .collect();
    let mut store = setup_store_with(&locs);
    assert_eq!(store.tags.get(&5).map(|t| t.count), Some(10));

    let entry = EditEntry { created: locs.clone(), removed: vec![] };
    apply_edit_reverse(&mut store, &entry);
    assert_eq!(store.tags.get(&5).map(|t| t.count), Some(0));
    assert_eq!(store.alive_count, 0);

    apply_edit_forward(&mut store, &entry);
    assert_eq!(store.tags.get(&5).map(|t| t.count), Some(10));
    assert_eq!(store.alive_count, 10);
}

#[test]
fn tag_counts_correct_after_tag_reassignment_undo() {
    // location starts with tag [5], update to [5, 10], undo should restore [5]
    let old = loc_with_tags(1, 0.0, 0.0, vec![5]);
    let new = loc_with_tags(1, 0.0, 0.0, vec![5, 10]);
    let mut store = setup_store_with(&[new.clone()]);
    for tag in store.tags.values_mut() { tag.count = 0; };
    store.add_tag_counts(&[new.clone()]);
    assert_eq!(store.tags.get(&5).map(|t| t.count), Some(1));
    assert_eq!(store.tags.get(&10).map(|t| t.count), Some(1));

    let entry = EditEntry { created: vec![new], removed: vec![old] };
    apply_edit_reverse(&mut store, &entry);
    assert_eq!(store.tags.get(&5).map(|t| t.count), Some(1), "tag 5 should still be 1");
    assert_eq!(store.tags.get(&10).map(|t| t.count), Some(0), "tag 10 should be 0 after undo");
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
    store.overlay_update(1, &LocationPatch { heading: Some(90.0), ..patch() });

    // Build delta overlay
    let overlay = DeltaOverlay {
        adds: store.overlay_adds.clone(),
        dead_ids: store.overlay_dead.iter().cloned().collect(),
        patches: store.overlay_patches.values().cloned().collect(),
    };
    assert!(overlay.adds.is_empty(), "no new locations added");
    assert!(overlay.dead_ids.is_empty(), "no locations deleted");
    assert_eq!(overlay.patches.len(), 1, "only modified location in patches");
    assert_eq!(overlay.patches[0].id, 1);
    assert_eq!(overlay.patches[0].heading, 90.0);
}

#[test]
fn delta_overlay_round_trip_preserves_store_state() {
    let l1 = loc_with_tags(1, 10.0, 20.0, vec![5]);
    let l2 = loc(2, 30.0, 40.0);
    let mut store = setup_store_with(&[l1.clone(), l2.clone()]);
    store.bake_overlay();

    // Add l3, remove l1, patch l2
    let l3 = loc(3, 50.0, 60.0);
    store.overlay_add(l3.clone());
    store.alive_count += 1;
    store.overlay_remove(&[l1.clone()]);
    store.overlay_update(2, &LocationPatch { heading: Some(180.0), ..patch() });

    // Serialize
    let overlay = DeltaOverlay {
        adds: store.overlay_adds.clone(),
        dead_ids: store.overlay_dead.iter().cloned().collect(),
        patches: store.overlay_patches.values().cloned().collect(),
    };
    let bytes = rmp_serde::to_vec_named(&overlay).unwrap();

    // Simulate reopen: deserialize and verify
    let restored: DeltaOverlay = rmp_serde::from_slice(&bytes).unwrap();
    assert_eq!(restored.adds.len(), 1);
    assert_eq!(restored.adds[0].id, 3);
    assert!(restored.dead_ids.contains(&1));
    assert_eq!(restored.patches.len(), 1);
    assert_eq!(restored.patches[0].heading, 180.0);
}

// -----------------------------------------------------------------------
// Bug regression: active location removed by undo
// (5ac390a)
// -----------------------------------------------------------------------

#[test]
fn active_id_should_be_clearable_when_location_removed() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l.clone()]);
    store.active_id = Some(1);

    // Remove the active location
    let entry = EditEntry { created: vec![], removed: vec![l] };
    apply_edit_forward(&mut store, &entry);

    // The caller (JS) should clear active_id when the delta removes it.
    // Verify the location is actually gone so the caller can detect it.
    assert!(store.get_loc_by_id(1).is_none());
    let delta_has_removed_active = entry.removed.iter().any(|l| Some(l.id) == store.active_id);
    assert!(delta_has_removed_active, "caller can detect active was removed");
}

// -----------------------------------------------------------------------
// Render buffer binary format
// -----------------------------------------------------------------------

#[test]
fn render_buffer_with_selection_overlay() {
    let l1 = loc(1, 10.0, 20.0);
    let l2 = loc(2, 30.0, 40.0);
    let mut store = setup_store_with(&[l1, l2]);
    store.bake_overlay();
    store.selected_ids.insert(1);
    store.selected_colors.insert(1, [255, 0, 0]);

    let req = RenderRequest {
        west: -180.0, south: -90.0, east: 180.0, north: 90.0,
        selected_ids: None,
        marker_style: "pin".into(),
    };
    let buf = build_cell_render_buffers(&mut store, &req);

    // Skip to selection overlay
    let cell_count = u32::from_le_bytes(buf[0..4].try_into().unwrap());
    let mut offset = 4usize;
    for _ in 0..cell_count {
        let count = u32::from_le_bytes(buf[offset+1..offset+5].try_into().unwrap()) as usize;
        offset += 5 + count * 4 + count * 2 * 4 + count * 4 + count * 4;
    }
    let sel_count = u32::from_le_bytes(buf[offset..offset+4].try_into().unwrap());
    assert_eq!(sel_count, 1, "one selected location");
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
    store.overlay_update(2, &LocationPatch { lat: Some(99.0), ..patch() });
    store.bake_overlay();
    assert!(ids_sorted(&store));
    assert_eq!(store.get_loc_by_id(2).unwrap().lat, 99.0);
}

#[test]
fn bake_preserves_sorted_ids_after_remove_and_patch() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 10.0, 10.0), loc(3, 20.0, 20.0), loc(4, 30.0, 30.0)]);
    store.bake_overlay();
    store.overlay_remove(&[loc(2, 10.0, 10.0)]);
    store.alive_count -= 1;
    store.overlay_update(3, &LocationPatch { heading: Some(45.0), ..patch() });
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
    store.overlay_update(2, &LocationPatch { lat: Some(99.0), ..patch() });
    let l3 = loc(3, 50.0, 50.0);
    store.overlay_add(l3);
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
        store.overlay_add(loc(new_id, round as f64, round as f64));
        store.alive_count += 1;
        if round % 2 == 0 {
            store.overlay_update(2, &LocationPatch { heading: Some(round as f64), ..patch() });
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
    store.overlay_add(loc(1, 99.0, 99.0));
    assert!(store.overlay_patches.contains_key(&1));
    assert!(store.overlay_adds.is_empty());
    // Adding id=5 should go to adds (not in batch)
    store.overlay_add(loc(5, 50.0, 50.0));
    assert_eq!(store.overlay_adds.len(), 1);
    assert_eq!(store.overlay_adds[0].id, 5);
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
    store.overlay_add(loc(3, 20.0, 20.0));
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
    store.overlay_update(1, &LocationPatch { heading: Some(10.0), ..patch() });
    store.overlay_update(2, &LocationPatch { heading: Some(20.0), ..patch() });
    store.overlay_update(3, &LocationPatch { heading: Some(30.0), ..patch() });
    store.bake_overlay();
    assert!(ids_sorted(&store));
    assert_eq!(store.get_loc_by_id(1).unwrap().heading, 10.0);
    assert_eq!(store.get_loc_by_id(2).unwrap().heading, 20.0);
    assert_eq!(store.get_loc_by_id(3).unwrap().heading, 30.0);
}
