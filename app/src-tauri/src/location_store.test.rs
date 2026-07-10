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
        flags: crate::types::LocationFlags::empty(),
        tags: vec![],
        extra: None,
        created_at: 0,
        modified_at: None,
    }
}

fn loc_with_tags(id: u32, lat: f64, lng: f64, tags: Vec<u32>) -> Location {
    Location {
        tags,
        ..loc(id, lat, lng)
    }
}

fn loc_with_heading(id: u32, lat: f64, lng: f64, heading: f64) -> Location {
    Location {
        heading,
        ..loc(id, lat, lng)
    }
}

fn patch() -> LocationPatch {
    LocationPatch {
        lat: None,
        lng: None,
        heading: None,
        pitch: None,
        zoom: None,
        pano_id: None,
        flags: None,
        tags: None,
        extra: None,
        created_at: None,
        modified_at: None,
    }
}

fn setup_store_with(locs: &[Location]) -> Store {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut store = Store::new();
    store.map_id = Some(format!(
        "test-{}",
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
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
    store.overlay_update(
        1,
        &LocationPatch {
            lat: Some(50.0),
            heading: Some(90.0),
            ..patch()
        },
    );
    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 50.0);
    assert_eq!(got.heading, 90.0);
    assert_eq!(got.lng, 20.0); // unchanged
}

#[test]
fn overlay_update_nonexistent_is_noop() {
    let mut store = setup_store_with(&[]);
    store.overlay_update(
        999,
        &LocationPatch {
            lat: Some(50.0),
            ..patch()
        },
    );
    assert!(store.get_loc_by_id(999).is_none());
}

#[test]
fn overlay_update_stamps_modified_at_on_session_added_row() {
    // Row lives in overlay.adds (not yet baked): an edit must stamp modified_at,
    // same as an edit to a committed base row.
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    assert!(store.get_loc_by_id(1).unwrap().modified_at.is_none());
    store.overlay_update(
        1,
        &LocationPatch {
            lat: Some(50.0),
            ..patch()
        },
    );
    assert!(store.get_loc_by_id(1).unwrap().modified_at.is_some());
}

#[test]
fn overlay_update_noop_does_not_stamp_session_added_row() {
    // A patch that changes nothing must not stamp (or it fabricates undo entries).
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    store.overlay_update(
        1,
        &LocationPatch {
            lat: Some(10.0),
            ..patch()
        },
    );
    assert!(store.get_loc_by_id(1).unwrap().modified_at.is_none());
}

#[test]
fn overlay_update_stamps_modified_at_on_base_row() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    store.bake_overlay();
    store.overlay_update(
        1,
        &LocationPatch {
            lat: Some(50.0),
            ..patch()
        },
    );
    assert!(store.get_loc_by_id(1).unwrap().modified_at.is_some());
}

#[test]
fn collect_all_locations() {
    let locs = vec![loc(1, 10.0, 20.0), loc(2, 30.0, 40.0)];
    let store = setup_store_with(&locs);
    let all = store.collect_all_locations();
    assert_eq!(all.len(), 2);
}

// -----------------------------------------------------------------------
// Overlay dirty lifecycle (autosave rev guard)
// -----------------------------------------------------------------------

#[test]
fn overlay_rev_bumps_on_every_mutation() {
    let mut store = setup_store_with(&[]);
    let r0 = store.overlay.rev;
    store.overlay_add(loc(1, 0.0, 0.0));
    let r1 = store.overlay.rev;
    assert!(r1 > r0);
    store.overlay_update(
        1,
        &LocationPatch {
            lat: Some(5.0),
            ..patch()
        },
    );
    let r2 = store.overlay.rev;
    assert!(r2 > r1);
    store.overlay_remove(&[store.get_loc_by_id(1).unwrap()]);
    assert!(store.overlay.rev > r2);
}

#[test]
fn bake_proceeds_when_clean_but_nonempty() {
    // Simulate a completed autosave (dirty cleared) with content still in the
    // overlay: a commit's bake must still fold it into the base batch.
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0)]);
    store.overlay.dirty = false;
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
    store.overlay.dirty = true; // stale flag with no content must not re-bake
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
    store.overlay_update(
        1,
        &LocationPatch {
            lat: Some(5.0),
            ..patch()
        },
    );
    assert!(store.edits.undo.is_empty());
    assert_eq!(store.overlay_diff_counts(), (0, 0, 1));
}

#[test]
fn commit_diff_counts_removed_base_row() {
    let l = loc(1, 0.0, 0.0);
    let mut store = setup_store_with(&[l.clone()]);
    store.bake_overlay();
    store.overlay_remove(&[l]);
    assert_eq!(store.overlay_diff_counts(), (0, 1, 0));
}

#[test]
fn commit_diff_add_then_remove_is_noop() {
    let l = loc(1, 0.0, 0.0);
    let mut store = setup_store_with(&[l.clone()]);
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
    assert_eq!(store.tags.all.get(&10).map(|t| t.count), Some(2));
    assert_eq!(store.tags.all.get(&20).map(|t| t.count), Some(1));
}

#[test]
fn tag_counts_after_remove() {
    let l1 = loc_with_tags(1, 0.0, 0.0, vec![10, 20]);
    let l2 = loc_with_tags(2, 1.0, 1.0, vec![10]);
    let mut store = setup_store_with(&[l1.clone(), l2]);
    store.remove_tag_counts(&[l1]);
    assert_eq!(store.tags.all.get(&10).map(|t| t.count), Some(1));
    assert_eq!(store.tags.all.get(&20).map(|t| t.count), Some(0));
}

#[test]
fn tag_counts_saturate_at_zero() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(&[]);
    store.remove_tag_counts(&[l]);
    assert_eq!(store.tags.all.get(&10).map(|t| t.count), None);
}

// -----------------------------------------------------------------------
// Undo / Redo
// -----------------------------------------------------------------------

#[test]
fn undo_add() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l.clone()]);
    store.push_undo(EditEntry {
        created: vec![l.clone()],
        removed: vec![],
    });

    let _delta = apply_edit_reverse(
        &mut store,
        &EditEntry {
            created: vec![l],
            removed: vec![],
        },
    );
    assert_eq!(store.alive_count, 0);
    assert!(store.get_loc_by_id(1).is_none());
}

#[test]
fn undo_remove() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[]);
    // simulate: location was removed, undo should re-add it
    let _delta = apply_edit_reverse(
        &mut store,
        &EditEntry {
            created: vec![],
            removed: vec![l.clone()],
        },
    );
    assert_eq!(store.alive_count, 1);
    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 10.0);
}

#[test]
fn undo_update_restores_original() {
    let original = loc_with_heading(1, 10.0, 20.0, 0.0);
    let updated = loc_with_heading(1, 10.0, 20.0, 90.0);
    let mut store = setup_store_with(&[updated.clone()]);

    let entry = EditEntry {
        created: vec![updated],
        removed: vec![original.clone()],
    };
    apply_edit_reverse(&mut store, &entry);

    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.heading, 0.0);
}

#[test]
fn redo_after_undo() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l.clone()]);
    let entry = EditEntry {
        created: vec![l.clone()],
        removed: vec![],
    };

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
    let mut store = setup_store_with(&[l.clone()]);
    assert_eq!(store.tags.all.get(&10).map(|t| t.count), Some(1));

    let entry = EditEntry {
        created: vec![l],
        removed: vec![],
    };
    apply_edit_reverse(&mut store, &entry);
    assert_eq!(store.tags.all.get(&10).map(|t| t.count), Some(0));
}

#[test]
fn tag_counts_correct_after_undo_remove() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(&[]);
    assert_eq!(store.tags.all.get(&10).map(|t| t.count), None);

    let entry = EditEntry {
        created: vec![],
        removed: vec![l],
    };
    apply_edit_reverse(&mut store, &entry);
    assert_eq!(store.tags.all.get(&10).map(|t| t.count), Some(1));
}

#[test]
fn tag_counts_correct_after_undo_tag_change() {
    let old = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let new = loc_with_tags(1, 0.0, 0.0, vec![20]);
    let mut store = setup_store_with(&[new.clone()]);
    for tag in store.tags.all.values_mut() {
        tag.count = 0;
    }
    store.add_tag_counts(&[new.clone()]);
    assert_eq!(store.tags.all.get(&20).map(|t| t.count), Some(1));
    assert_eq!(store.tags.all.get(&10).map(|t| t.count), None);

    let entry = EditEntry {
        created: vec![new],
        removed: vec![old],
    };
    apply_edit_reverse(&mut store, &entry);

    assert_eq!(store.tags.all.get(&10).map(|t| t.count), Some(1));
    assert_eq!(store.tags.all.get(&20).map(|t| t.count), Some(0));
}

#[test]
fn tag_counts_survive_undo_redo_cycle() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(&[l.clone()]);
    let entry = EditEntry {
        created: vec![l.clone()],
        removed: vec![],
    };

    apply_edit_reverse(&mut store, &entry);
    assert_eq!(store.tags.all.get(&10).map(|t| t.count), Some(0));

    apply_edit_forward(&mut store, &entry);
    assert_eq!(store.tags.all.get(&10).map(|t| t.count), Some(1));
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
    let delta = apply_edit_forward(&mut store, &entry);
    assert_eq!(delta.added.len(), 1);
    assert_eq!(delta.added[0].id, 1);
    assert_eq!(delta.removed.len(), 0);
}

#[test]
fn delta_has_removed_entry_for_deleted_location() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l.clone()]);
    let entry = EditEntry {
        created: vec![],
        removed: vec![l],
    };
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

    let entry = EditEntry {
        created: vec![new],
        removed: vec![old],
    };
    let changes = apply_edit_forward(&mut store, &entry);
    let delta = store.derive_render_delta(&changes);
    // cross-cell move => remove old + add new
    assert_eq!(delta.removed.len(), 1);
    assert_eq!(delta.added.len(), 1);
}

#[test]
fn delta_add_uses_configured_marker_color() {
    let mut store = setup_store_with(&[loc(1, 10.0, 20.0)]);
    store.render.marker_color = [10, 20, 30];

    let entry = EditEntry {
        created: vec![loc(2, 30.0, 40.0)],
        removed: vec![],
    };
    let changes = apply_edit_forward(&mut store, &entry);
    let delta = store.derive_render_delta(&changes);

    assert_eq!(delta.added.len(), 1);
    let e = &delta.added[0];
    assert_eq!((e.r, e.g, e.b, e.a), (10, 20, 30, 255));
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
    let mut store = setup_store_with(&[old.clone()]);

    let entry = EditEntry {
        created: vec![new],
        removed: vec![old],
    };
    let changes = apply_edit_forward(&mut store, &entry);
    let delta = store.derive_render_delta(&changes);

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
    let mut store = setup_store_with(&[old.clone()]);

    let entry = EditEntry {
        created: vec![new],
        removed: vec![old],
    };
    let changes = apply_edit_forward(&mut store, &entry);
    let delta = store.derive_render_delta(&changes);

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
    let mut store = setup_store_with(&[old.clone()]);

    let entry = EditEntry {
        created: vec![new],
        removed: vec![old],
    };
    let changes = apply_edit_forward(&mut store, &entry);
    let delta = store.derive_render_delta(&changes);

    assert!(
        delta.added.len() + delta.removed.len() + delta.updated.len() > 0,
        "lat change requires re-render"
    );
}

#[test]
fn samey_tag_only_change_skips_render() {
    let old = loc_with_tags(1, 10.0, 20.0, vec![10]);
    let new = loc_with_tags(1, 10.0, 20.0, vec![20]);
    let mut store = setup_store_with(&[old.clone()]);

    let entry = EditEntry {
        created: vec![new],
        removed: vec![old],
    };
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

    store.push_undo(EditEntry {
        created: vec![],
        removed: vec![],
    });
    let s = store.store_status();
    assert!(s.can_undo);
    assert!(!s.can_redo);

    store.edits.redo.push(EditEntry {
        created: vec![],
        removed: vec![],
    });
    let s = store.store_status();
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

    let result = store.finish_mutation(ChangeSet::default());
    assert_eq!(result.status.location_count, 1);
    assert!(result.status.can_undo);
    assert!(!result.status.can_redo);
    // Setup added tagged locations, so this first mutation ships counts.
    assert_eq!(
        result.status.tag_counts.as_ref().unwrap().get(&10),
        Some(&1)
    );
    assert_eq!(result.status.version, 1);
}

#[test]
fn tag_counts_shipped_only_when_changed() {
    let l = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let mut store = setup_store_with(&[l.clone()]);

    // Setup's add_tag_counts left counts dirty: first mutation ships them once.
    let result = store.finish_mutation(ChangeSet::default());
    assert!(result.status.tag_counts.is_some());

    // A mutation that touches no tags must not ship counts.
    let result = store.finish_mutation(ChangeSet::default());
    assert!(result.status.tag_counts.is_none());

    // A tag-touching edit ships fresh counts again.
    let changes = apply_edit(&mut store, std::slice::from_ref(&l), &[]);
    let result = store.finish_mutation(changes);
    assert_eq!(
        result.status.tag_counts.as_ref().unwrap().get(&10),
        Some(&0)
    );
}

#[test]
fn cached_bounds_tracks_adds_and_invalidates_on_remove() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    // [w,s,e,n] = [min_lng, min_lat, max_lng, max_lat]
    assert_eq!(store.cached_bounds(), Some([0.0, 0.0, 0.0, 0.0]));

    // Add outside the box -> grows incrementally, no recompute.
    let a = loc(2, 10.0, 10.0);
    store.overlay_add(a.clone());
    store.update_bounds(&ChangeSet {
        added: vec![a],
        ..Default::default()
    });
    assert!(!store.bounds_dirty, "add must not dirty the cache");
    assert_eq!(store.cached_bounds(), Some([0.0, 0.0, 10.0, 10.0]));

    // Add inside the box -> no change.
    let b = loc(3, 5.0, 5.0);
    store.overlay_add(b.clone());
    store.update_bounds(&ChangeSet {
        added: vec![b],
        ..Default::default()
    });
    assert_eq!(store.cached_bounds(), Some([0.0, 0.0, 10.0, 10.0]));

    // Remove the extreme point -> invalidates, recompute shrinks the box.
    store.overlay_remove(&[loc(2, 10.0, 10.0)]);
    store.update_bounds(&ChangeSet {
        removed: vec![2],
        ..Default::default()
    });
    assert!(store.bounds_dirty, "removal must invalidate the cache");
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
    store.overlay_update(
        1,
        &LocationPatch {
            lat: Some(99.0),
            ..patch()
        },
    );
    store.bake_overlay();

    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 99.0);
    assert!(store.overlay.patches.is_empty());
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
    store.overlay_update(
        1,
        &LocationPatch {
            heading: Some(45.0),
            ..patch()
        },
    );
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

    store.overlay_update(
        1,
        &LocationPatch {
            heading: Some(90.0),
            ..patch()
        },
    );
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
    store.overlay_update(
        1,
        &LocationPatch {
            heading: Some(180.0),
            ..patch()
        },
    );
    store.overlay_update(
        2,
        &LocationPatch {
            heading: Some(90.0),
            ..patch()
        },
    );
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
    let remove_entry = EditEntry {
        created: vec![],
        removed: vec![l.clone()],
    };
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
    let mut store = setup_store_with(&[l.clone()]);
    store.bake_overlay();
    // l is now in the batch, not in overlay_adds

    // update via overlay patch
    let updated = loc_with_heading(1, 10.0, 20.0, 90.0);
    store.overlay_update(
        1,
        &LocationPatch {
            heading: Some(90.0),
            ..patch()
        },
    );
    assert_eq!(store.get_loc_by_id(1).unwrap().heading, 90.0);

    // undo: apply_edit should restore original via overlay
    let entry = EditEntry {
        created: vec![updated],
        removed: vec![l],
    };
    apply_edit_reverse(&mut store, &entry);

    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.heading, 0.0, "undo should restore original heading");
}

#[test]
fn multiple_undo_redo_cycles_consistent() {
    let l = loc_with_tags(1, 10.0, 20.0, vec![10]);
    let mut store = setup_store_with(&[l.clone()]);

    let updated = loc_with_tags(1, 10.0, 20.0, vec![20]);
    let entry = EditEntry {
        created: vec![updated.clone()],
        removed: vec![l.clone()],
    };

    for _ in 0..5 {
        apply_edit_forward(&mut store, &entry);
        assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![20]);
        assert_eq!(store.tags.all.get(&20).map(|t| t.count), Some(1));

        apply_edit_reverse(&mut store, &entry);
        assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![10]);
        assert_eq!(store.tags.all.get(&10).map(|t| t.count), Some(1));
    }
}

// -----------------------------------------------------------------------
// derive_render_delta (updates)
// -----------------------------------------------------------------------

fn render_delta_for_update(store: &mut Store, id: u32, patch: LocationPatch) -> RenderDelta {
    let old = store.get_loc_by_id(id).unwrap();
    store.overlay_update(id, &patch);
    let new_loc = store.get_loc_by_id(id).unwrap();
    store.derive_render_delta(&ChangeSet {
        updated: vec![(old, new_loc)],
        ..Default::default()
    })
}

#[test]
fn update_delta_heading_only_produces_patch() {
    let l = loc_with_heading(1, 10.0, 20.0, 0.0);
    let mut store = setup_store_with(&[l]);
    let delta = render_delta_for_update(
        &mut store,
        1,
        LocationPatch {
            heading: Some(90.0),
            ..patch()
        },
    );
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
    let delta = render_delta_for_update(
        &mut store,
        1,
        LocationPatch {
            lat: Some(10.001),
            ..patch()
        },
    );
    // should be an in-place patch, not a cell migration
    assert_eq!(delta.updated.len(), 1);
    assert!(delta.added.is_empty());
}

#[test]
fn update_delta_cross_cell_position_produces_remove_and_add() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    // large position change that crosses render cells
    let delta = render_delta_for_update(
        &mut store,
        1,
        LocationPatch {
            lat: Some(-80.0),
            lng: Some(-170.0),
            ..patch()
        },
    );
    assert_eq!(delta.removed.len(), 1, "old cell entry removed");
    assert_eq!(delta.added.len(), 1, "new cell entry added");
    assert!(delta.updated.is_empty());
}

#[test]
fn update_delta_tags_only_produces_empty_delta() {
    let l = loc_with_tags(1, 10.0, 20.0, vec![10]);
    let mut store = setup_store_with(&[l]);
    let delta = render_delta_for_update(
        &mut store,
        1,
        LocationPatch {
            tags: Some(vec![20]),
            ..patch()
        },
    );
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
    store.overlay_update(
        1,
        &LocationPatch {
            lat: Some(50.0),
            ..patch()
        },
    );
    let got = store.get_loc_by_id(1).unwrap();
    assert_eq!(got.lat, 50.0);
    // should still be in overlay_adds, not overlay_patches
    assert_eq!(store.overlay.adds.len(), 1);
    assert_eq!(store.overlay.adds[0].lat, 50.0);
    assert!(store.overlay.patches.is_empty());
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
    store.overlay_update(
        2,
        &LocationPatch {
            lat: Some(99.0),
            ..patch()
        },
    );
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
    store.overlay_update(
        2,
        &LocationPatch {
            heading: Some(180.0),
            ..patch()
        },
    );
    // add: new l3
    let l3 = loc(3, 50.0, 60.0);
    store.overlay_add(l3);
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
// DeltaOverlay msgpack round-trip
// -----------------------------------------------------------------------

#[test]
fn delta_overlay_msgpack_round_trip_empty() {
    let overlay = DeltaOverlay {
        adds: vec![],
        dead_ids: vec![],
        patches: vec![],
    };
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
    l.modified_at = Some(1_705_276_800);
    let overlay = DeltaOverlay {
        adds: vec![l.clone()],
        dead_ids: vec![],
        patches: vec![],
    };
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
    for l in &locs {
        store.overlay_add(l.clone());
    }
    assert_eq!(store.alive_count, 3);

    // Remove 1
    store.overlay_remove(&[locs[0].clone()]);
    assert_eq!(store.alive_count, 2);

    // Update (should not change count)
    store.overlay_update(
        2,
        &LocationPatch {
            heading: Some(90.0),
            ..patch()
        },
    );
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
    let entry = EditEntry {
        created: vec![],
        removed: vec![loc(2, 1.0, 1.0), loc(3, 2.0, 2.0)],
    };
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
    assert!(store.overlay.dead.contains(&1));
    assert!(!store.overlay.adds.iter().any(|l| l.id == 1));

    // Re-add it (overlay_add on a known batch ID goes to patches)
    store.overlay_add(loc(1, 50.0, 60.0));
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
    store.overlay_add(loc(99, 10.0, 20.0));
    assert!(store.overlay.adds.iter().any(|l| l.id == 99));
    assert!(!store.overlay.patches.contains_key(&99));
}

#[test]
fn overlay_consistency_update_batch_id_goes_to_patches() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l]);
    store.bake_overlay();
    // Now l is in the batch
    store.overlay_update(
        1,
        &LocationPatch {
            heading: Some(45.0),
            ..patch()
        },
    );
    assert!(store.overlay.patches.contains_key(&1));
    assert!(!store.overlay.adds.iter().any(|l| l.id == 1));
}

#[test]
fn overlay_consistency_update_add_id_stays_in_adds() {
    let mut store = setup_store_with(&[]);
    store.batch = Some(empty_batch());
    store.overlay_add(loc(1, 10.0, 20.0));
    store.overlay_update(
        1,
        &LocationPatch {
            heading: Some(45.0),
            ..patch()
        },
    );
    // Should still be in overlay_adds, updated in place
    assert_eq!(store.overlay.adds.len(), 1);
    assert_eq!(store.overlay.adds[0].heading, 45.0);
    assert!(!store.overlay.patches.contains_key(&1));
}

#[test]
fn overlay_consistency_remove_clears_patches() {
    let l = loc(1, 10.0, 20.0);
    let mut store = setup_store_with(&[l.clone()]);
    store.bake_overlay();
    store.overlay_update(
        1,
        &LocationPatch {
            heading: Some(45.0),
            ..patch()
        },
    );
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

    // Walk to the single cell's angles segment: [u32 cells][u8 char][u32 count][ids][positions][colors][angles]
    let cell_count = u32::from_le_bytes(buf[0..4].try_into().unwrap());
    assert_eq!(cell_count, 1);
    let mut offset = 4usize;
    let count = u32::from_le_bytes(buf[offset + 1..offset + 5].try_into().unwrap()) as usize;
    assert_eq!(count, 1);
    offset += 5;
    offset += count * 4; // ids
    offset += count * 2 * 4; // positions
    offset += count * 4; // colors
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
    let mut store = setup_store_with(&[l.clone()]);
    assert!(store.cell_lookup(1).is_some());

    // Delete
    let entry = EditEntry {
        created: vec![],
        removed: vec![l.clone()],
    };
    let changes = apply_edit_forward(&mut store, &entry);
    let delta = store.derive_render_delta(&changes);
    assert_eq!(delta.removed.len(), 1);
    assert!(store.cell_lookup(1).is_none());

    // Undo delete
    let changes = apply_edit_reverse(&mut store, &entry);
    let delta = store.derive_render_delta(&changes);
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
    store.selections.ids.insert(1);
    store.selections.ids.insert(2);

    store.selections.ids.clear();
    assert!(store.selections.ids.is_empty());
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
    assert_eq!(store.tags.all.get(&5).map(|t| t.count), Some(10));

    let entry = EditEntry {
        created: locs.clone(),
        removed: vec![],
    };
    apply_edit_reverse(&mut store, &entry);
    assert_eq!(store.tags.all.get(&5).map(|t| t.count), Some(0));
    assert_eq!(store.alive_count, 0);

    apply_edit_forward(&mut store, &entry);
    assert_eq!(store.tags.all.get(&5).map(|t| t.count), Some(10));
    assert_eq!(store.alive_count, 10);
}

#[test]
fn tag_counts_correct_after_tag_reassignment_undo() {
    // location starts with tag [5], update to [5, 10], undo should restore [5]
    let old = loc_with_tags(1, 0.0, 0.0, vec![5]);
    let new = loc_with_tags(1, 0.0, 0.0, vec![5, 10]);
    let mut store = setup_store_with(&[new.clone()]);
    for tag in store.tags.all.values_mut() {
        tag.count = 0;
    }
    store.add_tag_counts(&[new.clone()]);
    assert_eq!(store.tags.all.get(&5).map(|t| t.count), Some(1));
    assert_eq!(store.tags.all.get(&10).map(|t| t.count), Some(1));

    let entry = EditEntry {
        created: vec![new],
        removed: vec![old],
    };
    apply_edit_reverse(&mut store, &entry);
    assert_eq!(
        store.tags.all.get(&5).map(|t| t.count),
        Some(1),
        "tag 5 should still be 1"
    );
    assert_eq!(
        store.tags.all.get(&10).map(|t| t.count),
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
    store.overlay_update(
        1,
        &LocationPatch {
            heading: Some(90.0),
            ..patch()
        },
    );

    // Build delta overlay
    let overlay = DeltaOverlay {
        adds: store.overlay.adds.clone(),
        dead_ids: store.overlay.dead.iter().cloned().collect(),
        patches: store.overlay.patches.values().cloned().collect(),
    };
    assert!(overlay.adds.is_empty(), "no new locations added");
    assert!(overlay.dead_ids.is_empty(), "no locations deleted");
    assert_eq!(
        overlay.patches.len(),
        1,
        "only modified location in patches"
    );
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
    store.overlay_update(
        2,
        &LocationPatch {
            heading: Some(180.0),
            ..patch()
        },
    );

    // Serialize
    let overlay = DeltaOverlay {
        adds: store.overlay.adds.clone(),
        dead_ids: store.overlay.dead.iter().cloned().collect(),
        patches: store.overlay.patches.values().cloned().collect(),
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
    store.selections.active_id = Some(1);

    // Remove the active location
    let entry = EditEntry {
        created: vec![],
        removed: vec![l],
    };
    apply_edit_forward(&mut store, &entry);

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

#[test]
fn render_buffer_with_selection_overlay() {
    let l1 = loc(1, 10.0, 20.0);
    let l2 = loc(2, 30.0, 40.0);
    let mut store = setup_store_with(&[l1, l2]);
    store.bake_overlay();
    store.selections.all.push(selections::Selection {
        key: "manual".into(),
        color: [255, 0, 0],
        props: selections::SelectionProps::Manual { locations: vec![1] },
    });
    let mut bm = RoaringBitmap::new();
    bm.insert(1);
    store.selections.loc_sets.push(bm);
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
        offset += 5 + count * 4 + count * 2 * 4 + count * 4 + count * 4;
    }
    let sel_count = u32::from_le_bytes(buf[offset..offset + 4].try_into().unwrap());
    assert_eq!(sel_count, 1, "one selected location");
}

#[test]
fn color_for_uses_last_matching_selection() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0)]);
    // id 1 belongs to two selections with different colors.
    for (key, color) in [("a", [255, 0, 0]), ("b", [0, 0, 255])] {
        store.selections.all.push(selections::Selection {
            key: key.into(),
            color,
            props: selections::SelectionProps::Manual { locations: vec![1] },
        });
        let mut bm = RoaringBitmap::new();
        bm.insert(1);
        store.selections.loc_sets.push(bm);
    }
    store.selections.ids.insert(1);

    assert_eq!(
        store.selections.color_for(1),
        Some([0, 0, 255]),
        "last selection wins"
    );
    assert_eq!(store.selections.color_for(2), None, "unselected id");
}

#[test]
fn color_map_matches_color_for() {
    let mut store = setup_store_with(&[loc(1, 0.0, 0.0), loc(2, 0.0, 0.0), loc(3, 0.0, 0.0)]);
    for (key, color, members) in [
        ("a", [255, 0, 0], vec![1u32, 2]),
        ("b", [0, 0, 255], vec![2u32, 3]),
    ] {
        store.selections.all.push(selections::Selection {
            key: key.into(),
            color,
            props: selections::SelectionProps::Manual {
                locations: members.clone(),
            },
        });
        let mut bm = RoaringBitmap::new();
        for id in &members {
            bm.insert(*id);
            store.selections.ids.insert(*id);
        }
        store.selections.loc_sets.push(bm);
    }

    let map = store.selections.color_map();
    for id in 1..=4 {
        assert_eq!(
            map.get(&id).copied(),
            store.selections.color_for(id),
            "id {}",
            id
        );
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
    store.overlay_update(
        2,
        &LocationPatch {
            lat: Some(99.0),
            ..patch()
        },
    );
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
    store.overlay_update(
        3,
        &LocationPatch {
            heading: Some(45.0),
            ..patch()
        },
    );
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
    store.overlay_update(
        2,
        &LocationPatch {
            lat: Some(99.0),
            ..patch()
        },
    );
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
            store.overlay_update(
                2,
                &LocationPatch {
                    heading: Some(round as f64),
                    ..patch()
                },
            );
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
    assert!(store.overlay.patches.contains_key(&1));
    assert!(store.overlay.adds.is_empty());
    // Adding id=5 should go to adds (not in batch)
    store.overlay_add(loc(5, 50.0, 50.0));
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
    store.overlay_update(
        1,
        &LocationPatch {
            heading: Some(10.0),
            ..patch()
        },
    );
    store.overlay_update(
        2,
        &LocationPatch {
            heading: Some(20.0),
            ..patch()
        },
    );
    store.overlay_update(
        3,
        &LocationPatch {
            heading: Some(30.0),
            ..patch()
        },
    );
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
// Selection bitmask: partial cell invariants
// -----------------------------------------------------------------------

fn add_tag_selection(store: &mut Store, tag_id: u32, color: [u8; 3]) {
    store.selections.all.push(selections::Selection {
        key: format!("tag:{}", tag_id),
        color,
        props: selections::SelectionProps::Tag { tag_id },
    });
    store.selections.loc_sets.push(RoaringBitmap::new());
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
fn partial_bitmask_only_contains_affected_cells() {
    // Two locations in different geohash cells
    let l1 = loc_with_tags(1, 10.0, 20.0, vec![1]);
    let l2 = loc_with_tags(2, -30.0, -40.0, vec![1]);
    let mut store = setup_store_with(&[l1.clone(), l2.clone()]);
    store.tags.all.insert(
        1,
        Tag {
            id: 1,
            name: "A".into(),
            color: "#ff0000".into(),
            visible: true,
            order: None,
            count: 2,
        },
    );
    add_tag_selection(&mut store, 1, [255, 0, 0]);

    // Verify they're in different cells
    let c1 = render_cell_idx(10.0, 20.0);
    let c2 = render_cell_idx(-30.0, -40.0);
    assert_ne!(c1, c2, "test requires locations in different cells");

    // Update only l1's tags — only l1's cell should be in the bitmask
    let result = store.finish_mutation(ChangeSet {
        updated: vec![(l1.clone(), loc_with_tags(1, 10.0, 20.0, vec![1]))],
        ..Default::default()
    });

    let sync = result.selection_sync.unwrap();
    let buf = sync.bitmask.expect("should send bitmask");
    let cells = bitmask_cell_chars(&buf);
    assert_eq!(
        cells.len(),
        1,
        "only the affected cell should be in the bitmask"
    );
}

#[test]
fn membership_delta_reports_gained_on_tag_add() {
    let l1 = loc_with_tags(1, 10.0, 20.0, vec![]);
    let mut store = setup_store_with(&[l1.clone()]);
    store.tags.all.insert(
        1,
        Tag {
            id: 1,
            name: "A".into(),
            color: "#ff0000".into(),
            visible: true,
            order: None,
            count: 0,
        },
    );
    add_tag_selection(&mut store, 1, [255, 0, 0]);

    // Add tag 1 to location 1
    let with_tag = loc_with_tags(1, 10.0, 20.0, vec![1]);
    let result = store.finish_mutation(ChangeSet {
        updated: vec![(l1, with_tag)],
        ..Default::default()
    });

    // Should have a colorPatch for the gained selection
    assert!(
        !result.delta.color_patches.is_empty(),
        "should emit colorPatch for gained selection"
    );
    let cp = &result.delta.color_patches[0];
    assert_eq!(cp.r, 255);
    assert_eq!(cp.g, 0);
    assert_eq!(cp.b, 0);
}

#[test]
fn membership_delta_no_colorpatch_when_membership_unchanged() {
    let l1 = loc_with_tags(1, 10.0, 20.0, vec![1]);
    let mut store = setup_store_with(&[l1.clone()]);
    store.tags.all.insert(
        1,
        Tag {
            id: 1,
            name: "A".into(),
            color: "#ff0000".into(),
            visible: true,
            order: None,
            count: 1,
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
    let result = store.finish_mutation(ChangeSet {
        updated: vec![(l1, updated)],
        ..Default::default()
    });

    // No colorPatch — membership unchanged
    assert!(
        result.delta.color_patches.is_empty(),
        "no colorPatch when membership unchanged"
    );
}

#[test]
fn removal_bitmask_includes_affected_cell() {
    let l1 = loc_with_tags(1, 10.0, 20.0, vec![1]);
    let l2 = loc_with_tags(2, 10.001, 20.001, vec![1]);
    let mut store = setup_store_with(&[l1.clone(), l2.clone()]);
    store.tags.all.insert(
        1,
        Tag {
            id: 1,
            name: "A".into(),
            color: "#ff0000".into(),
            visible: true,
            order: None,
            count: 2,
        },
    );
    add_tag_selection(&mut store, 1, [255, 0, 0]);
    store.resolve_selection_membership();

    // Remove l1
    let result = store.finish_mutation(ChangeSet {
        removed: vec![1],
        ..Default::default()
    });

    // The bitmask should include the cell that l1 was in
    let sync = result.selection_sync.unwrap();
    assert!(
        sync.bitmask.is_some(),
        "should send bitmask for the affected cell"
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
    let s = merge_group(&[a, b]);
    assert_eq!(s.id, 2);
    assert_eq!(s.tags, vec![1, 2, 3]);
}

#[test]
fn merge_group_tie_breaks_on_earliest_created() {
    let a = loc_full(1, vec![1], 2021);
    let b = loc_full(2, vec![9], 2019); // fewer-tag tie, but earlier
    let s = merge_group(&[a, b]);
    assert_eq!(s.id, 2);
}

#[test]
fn merge_group_tie_breaks_on_lowest_id() {
    let a = loc_full(5, vec![1], 2020);
    let b = loc_full(2, vec![9], 2020); // same tags+created, lower id
    let s = merge_group(&[a, b]);
    assert_eq!(s.id, 2);
}

#[test]
fn merge_group_unions_and_dedupes_tags() {
    let a = loc_full(1, vec![1, 2], 2020);
    let b = loc_full(2, vec![2, 3], 2020);
    let s = merge_group(&[a, b]);
    assert_eq!(s.tags, vec![1, 2, 3]);
}

#[test]
fn merge_group_extra_survivor_wins_and_unions_keys() {
    let mut a = loc_full(1, vec![1, 2], 2020); // survivor (most tags)
    a.extra = Some(serde_json::from_str(r#"{"k":"survivor"}"#).unwrap());
    let mut b = loc_full(2, vec![3], 2020);
    b.extra = Some(serde_json::from_str(r#"{"k":"other","x":"y"}"#).unwrap());
    let s = merge_group(&[a, b]);
    let extra = s.extra.unwrap();
    assert_eq!(extra.get("k").unwrap(), "survivor"); // conflict -> survivor wins
    assert_eq!(extra.get("x").unwrap(), "y"); // non-conflicting key from other is kept
}

#[test]
fn merge_group_applies_and_undo_restores() {
    let a = loc_with_tags(1, 0.0, 0.0, vec![10]);
    let b = loc_with_tags(2, 0.0, 0.0, vec![20]);
    let mut store = setup_store_with(&[a.clone(), b.clone()]);
    assert_eq!(store.alive_count, 2);

    let members = vec![a.clone(), b.clone()];
    let survivor = merge_group(&members);
    assert_eq!(survivor.id, 1); // tie on tags+created -> lowest id survives
    let entry = EditEntry {
        created: vec![survivor],
        removed: members,
    };

    apply_edit_forward(&mut store, &entry);
    assert_eq!(store.alive_count, 1);
    assert_eq!(store.get_loc_by_id(1).unwrap().tags, vec![10, 20]);
    assert!(store.get_loc_by_id(2).is_none());

    apply_edit_reverse(&mut store, &entry);
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
    let mut cells: [Option<CellRender>; 32] = std::array::from_fn(|_| None);
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
    let routed = vec![selection_cell_indices(&render, &sparse, None)];
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
    let routed = vec![selection_cell_indices(&render, &dense, None)];
    let seg = serialize_cell_segment(0, cr, &routed);
    let mask_bytes = n.div_ceil(8);
    assert_eq!(seg[5], 0, "select-all should use the dense bitmask format");
    assert_eq!(seg.len(), 5 + 1 + mask_bytes);
    assert!(seg[6..].iter().all(|&b| b == 0xFF), "every bit set");

    // Affected-scope filter: routing for a cell outside the scope yields nothing.
    let mut other_cell_only = std::collections::HashSet::new();
    other_cell_only.insert(1u8);
    let routed = selection_cell_indices(&render, &sparse, Some(&other_cell_only));
    assert!(
        routed[0].is_empty(),
        "out-of-scope cells must not be routed"
    );
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

// Simulate "close map" (store_close_map + save_edit_history_inner) and "reopen"
// (store_open_map's delta/history load + next_id seeding) at the Store level,
// using the same serialization roundtrips the app uses.
fn close_and_reopen(store: &Store) -> Store {
    let delta_bytes = overlay_delta_bytes(store).unwrap();
    let undo_bytes = rmp_serde::to_vec_named(&store.edits.undo).unwrap();
    let redo_bytes = rmp_serde::to_vec_named(&store.edits.redo).unwrap();

    let delta: DeltaOverlay = rmp_serde::from_slice(&delta_bytes).unwrap();
    let undo: Vec<EditEntry> = rmp_serde::from_slice(&undo_bytes).unwrap();
    let redo: Vec<EditEntry> = rmp_serde::from_slice(&redo_bytes).unwrap();

    let mut reopened = Store::new();
    reopened.map_id = store.map_id.clone();
    reopened.batch = Some(empty_batch());
    reopened.overlay.dead = delta.dead_ids.into_iter().collect();
    for p in delta.patches {
        reopened.overlay.patches.insert(p.id, p);
    }
    reopened.overlay.adds = delta.adds;
    reopened.overlay.dirty = true;
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
    store.overlay_add(l);
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
    store.overlay_remove(std::slice::from_ref(&l));
}

// store_undo / store_redo replay.
fn press_undo(store: &mut Store) {
    let entry = store.edits.undo.pop().unwrap();
    apply_edit_reverse(store, &entry);
    store.edits.redo.push(entry);
}

fn press_redo(store: &mut Store) {
    let entry = store.edits.redo.pop().unwrap();
    apply_edit_forward(store, &entry);
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
    store.overlay_add(loc(112, 9.0, 9.0));
}

// -----------------------------------------------------------------------
// Cross-map copy dedup (split_new_locations)
// -----------------------------------------------------------------------

fn loc_with_pano(id: u32, lat: f64, lng: f64, pano: &str) -> Location {
    Location {
        pano_id: Some(pano.to_string()),
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
        pano_id: Some(String::new()),
        ..loc(1, 10.0, 20.0)
    }];
    let sources = vec![Location {
        pano_id: Some(String::new()),
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
        count: 0,
    }
}

#[test]
fn reconcile_tags_match_by_name_case_insensitive() {
    let mut target_tags: HashMap<u32, Tag> =
        [(3, tag(3, "rural", "#222222"))].into_iter().collect();
    let mut next = 4;
    let remap = reconcile_tags_by_name(&[tag(7, "Rural", "#111111")], &mut target_tags, &mut next);
    assert_eq!(remap.get(&7), Some(&3));
    assert_eq!(next, 4);
    assert_eq!(target_tags.len(), 1);
    // The existing target tag keeps its own color.
    assert_eq!(target_tags.get(&3).unwrap().color, "#222222");
}

#[test]
fn reconcile_tags_create_missing_with_source_color() {
    let mut target_tags: HashMap<u32, Tag> = Default::default();
    let mut next = 10;
    let remap = reconcile_tags_by_name(
        &[Tag {
            count: 42,
            ..tag(7, "Trekker", "#abcdef")
        }],
        &mut target_tags,
        &mut next,
    );
    assert_eq!(remap.get(&7), Some(&10));
    assert_eq!(next, 11);
    let new_tag = target_tags.get(&10).unwrap();
    assert_eq!(new_tag.name, "Trekker");
    assert_eq!(new_tag.color, "#abcdef");
    assert_eq!(new_tag.count, 0); // source count never leaks into the target
}

#[test]
fn reconcile_tags_dedupes_same_name_within_batch() {
    let mut target_tags: HashMap<u32, Tag> = Default::default();
    let mut next = 1;
    let remap = reconcile_tags_by_name(
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
    let mut store = setup_store_with(&[base.clone()]);
    store.bake_overlay();

    let edited = loc_with_heading(1, 10.0, 20.0, 90.0);
    let entry = EditEntry {
        created: vec![edited],
        removed: vec![base],
    };
    apply_edit_forward(&mut store, &entry);
    assert!(
        store.overlay.patches.contains_key(&1),
        "edit should create a patch"
    );

    apply_edit_reverse(&mut store, &entry);
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

    store.overlay_update(
        1,
        &LocationPatch {
            heading: Some(90.0),
            ..patch()
        },
    );
    assert!(store.overlay.patches.contains_key(&1));

    // Reverting the heading doesn't clear the patch because overlay_update
    // stamps modified_at = now, which still differs from the base.
    store.overlay_update(
        1,
        &LocationPatch {
            heading: Some(0.0),
            ..patch()
        },
    );
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
        .collect_all_locations()
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
    store.overlay_update(
        3,
        &LocationPatch {
            lat: Some(base.0),
            lng: Some(base.1),
            ..patch()
        },
    );
    store.overlay_add(loc(6, base.0, base.1 + m));
    store.overlay_update(
        4,
        &LocationPatch {
            lat: Some(10.0),
            ..patch()
        },
    ); // move far away

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
    apply_edit_forward(&mut store, &entry);
    assert_eq!(indexed_nearby(&mut store, 10.0, 10.0, 5.0), vec![3]);
    apply_edit_reverse(&mut store, &entry);
    assert_eq!(indexed_nearby(&mut store, 10.0, 10.0, 5.0), vec![1]);
}

#[test]
fn spatial_rebuilds_when_alive_count_drifts() {
    let mut store = setup_store_with(&[loc(1, 10.0, 10.0)]);
    assert_eq!(indexed_nearby(&mut store, 10.0, 10.0, 5.0), vec![1]);

    // Simulate a bulk path bypassing the overlay fns: the len/alive mismatch
    // must force a rebuild instead of returning stale results.
    let pos = store.overlay.adds.partition_point(|l| l.id < 2);
    store.overlay.adds.insert(pos, loc(2, 10.0, 10.0));
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

fn coord_lookup(store: &Store) -> std::collections::HashMap<u32, (f64, f64)> {
    store
        .selections
        .ids
        .iter()
        .filter_map(|id| store.coords_of(id).map(|c| (id, c)))
        .collect()
}

fn min_pairwise(ids: &[u32], coords: &std::collections::HashMap<u32, (f64, f64)>) -> f64 {
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
    let res = store.pick_spaced(Some(8), None).unwrap();
    assert_eq!(res.ids.len(), 8);
    let uniq: std::collections::HashSet<u32> = res.ids.iter().copied().collect();
    assert_eq!(uniq.len(), 8, "no duplicates");
    for id in &res.ids {
        assert!(
            store.selections.ids.contains(*id),
            "id {} not in selection",
            id
        );
    }
}

#[test]
fn pick_spaced_count_ge_size_returns_all() {
    let store = spaced_grid_store();
    let res = store.pick_spaced(Some(50), None).unwrap();
    assert_eq!(res.ids.len(), 20);
    assert_eq!(res.distance_m, 0);
    let uniq: std::collections::HashSet<u32> = res.ids.iter().copied().collect();
    assert_eq!(uniq.len(), 20);
}

#[test]
fn pick_spaced_count_pairwise_spacing_meets_returned_distance() {
    let store = spaced_grid_store();
    let coords = coord_lookup(&store);
    let res = store.pick_spaced(Some(6), None).unwrap();
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
    let res = store.pick_spaced(None, Some(250)).unwrap();
    assert_eq!(res.distance_m, 250);
    assert!(!res.ids.is_empty());
    let min = min_pairwise(&res.ids, &coords);
    assert!(min >= 250.0 - 1e-6, "min pairwise {} < 250", min);
}

#[test]
fn pick_spaced_arg_validation() {
    let store = spaced_grid_store();
    assert!(store.pick_spaced(Some(5), Some(100)).is_err(), "both set");
    assert!(store.pick_spaced(None, None).is_err(), "neither set");
    assert!(store.pick_spaced(None, Some(0)).is_err(), "zero distance");
}

#[test]
fn pick_spaced_empty_selection() {
    let store = setup_store_with(&[]);
    let count = store.pick_spaced(Some(5), None).unwrap();
    assert!(count.ids.is_empty());
    assert_eq!(count.distance_m, 0);
    let dist = store.pick_spaced(None, Some(100)).unwrap();
    assert!(dist.ids.is_empty());
    assert_eq!(dist.distance_m, 0);
}
