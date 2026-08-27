//! Ported from app/test/unit/syncDiff.test.ts. HashMap iteration order is unspecified, so any
//! assertion the TS test made on a multi-key vector sorts first; single-key checks are unaffected.

use super::*;
use crate::sync::{sync_hash, NormalizedSyncLocation};
use std::collections::HashMap;

fn n(over: impl FnOnce(&mut NormalizedSyncLocation)) -> NormalizedSyncLocation {
    let mut loc = NormalizedSyncLocation {
        lat: 0.0,
        lng: 0.0,
        heading: 0.0,
        pitch: 0.0,
        zoom: 0.0,
        pano_id: None,
        flags: 0,
        tags: vec![],
    };
    over(&mut loc);
    loc
}

fn lat(v: f64) -> NormalizedSyncLocation {
    n(|l| l.lat = v)
}

/// Current-state map (full locations).
fn state(
    entries: &[(&str, NormalizedSyncLocation)],
) -> HashMap<IdentityKey, NormalizedSyncLocation> {
    entries
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect()
}

/// Base map (fingerprints only) from the locations agreed at last sync.
fn hashes(entries: &[(&str, NormalizedSyncLocation)]) -> HashMap<IdentityKey, String> {
    entries
        .iter()
        .map(|(k, v)| (k.to_string(), sync_hash(v)))
        .collect()
}

fn nostate() -> HashMap<IdentityKey, NormalizedSyncLocation> {
    HashMap::new()
}

fn nobase() -> HashMap<IdentityKey, String> {
    HashMap::new()
}

#[test]
fn no_changes_anywhere_is_a_noop() {
    let v = [("a", lat(1.0))];
    assert!(is_noop(&compute_sync_plan(
        &hashes(&v),
        &state(&v),
        &state(&v)
    )));
}

// --- First sync (empty base) ---

#[test]
fn first_sync_local_only_push_create_remote_only_pull_create() {
    let plan = compute_sync_plan(
        &nobase(),
        &state(&[("a", lat(1.0))]),
        &state(&[("b", lat(2.0))]),
    );
    assert_eq!(plan.push.create, vec!["a"]);
    assert_eq!(plan.pull.create, vec!["b"]);
    assert_eq!(plan.conflicts.len(), 0);
}

#[test]
fn first_sync_same_identity_added_identically_converged() {
    let v = n(|l| {
        l.lat = 5.0;
        l.tags = vec!["x".to_string()];
    });
    let plan = compute_sync_plan(
        &nobase(),
        &state(&[("a", v.clone())]),
        &state(&[("a", v.clone())]),
    );
    assert_eq!(plan.converged, vec!["a"]);
    assert!(is_noop(&plan));
}

#[test]
fn first_sync_same_identity_added_differently_add_add_conflict() {
    let plan = compute_sync_plan(
        &nobase(),
        &state(&[("a", lat(5.0))]),
        &state(&[("a", lat(6.0))]),
    );
    assert_eq!(plan.conflicts.len(), 1);
    assert_eq!(plan.conflicts[0].kind, ConflictKind::AddAdd);
}

// --- Steady state (base present), one side moves ---

#[test]
fn local_modified_remote_unchanged_push_update() {
    let b = [("a", lat(1.0))];
    let plan = compute_sync_plan(&hashes(&b), &state(&[("a", lat(2.0))]), &state(&b));
    assert_eq!(plan.push.update, vec!["a"]);
    assert_eq!(summarize(&plan).actionable, 1);
}

#[test]
fn remote_modified_local_unchanged_pull_update() {
    let b = [("a", lat(1.0))];
    let plan = compute_sync_plan(&hashes(&b), &state(&b), &state(&[("a", lat(2.0))]));
    assert_eq!(plan.pull.update, vec!["a"]);
}

#[test]
fn local_deleted_remote_unchanged_push_delete() {
    let b = [("a", lat(1.0))];
    let plan = compute_sync_plan(&hashes(&b), &nostate(), &state(&b));
    assert_eq!(plan.push.delete, vec!["a"]);
}

#[test]
fn remote_deleted_local_unchanged_pull_delete() {
    let b = [("a", lat(1.0))];
    let plan = compute_sync_plan(&hashes(&b), &state(&b), &nostate());
    assert_eq!(plan.pull.delete, vec!["a"]);
}

// --- Steady state, both sides move ---

#[test]
fn both_modified_to_the_same_value_converged() {
    let b = [("a", lat(1.0))];
    let moved = lat(9.0);
    let plan = compute_sync_plan(
        &hashes(&b),
        &state(&[("a", moved.clone())]),
        &state(&[("a", moved.clone())]),
    );
    assert_eq!(plan.converged, vec!["a"]);
    assert!(is_noop(&plan));
}

#[test]
fn both_modified_differently_update_update_conflict() {
    let b = [("a", lat(1.0))];
    let plan = compute_sync_plan(
        &hashes(&b),
        &state(&[("a", lat(2.0))]),
        &state(&[("a", lat(3.0))]),
    );
    assert_eq!(plan.conflicts[0].key, "a");
    assert_eq!(plan.conflicts[0].kind, ConflictKind::UpdateUpdate);
    assert_eq!(plan.conflicts[0].local, Some(lat(2.0)));
    assert_eq!(plan.conflicts[0].remote, Some(lat(3.0)));
}

#[test]
fn both_deleted_converged() {
    let b = [("a", lat(1.0))];
    let plan = compute_sync_plan(&hashes(&b), &nostate(), &nostate());
    assert_eq!(plan.converged, vec!["a"]);
    assert!(is_noop(&plan));
}

#[test]
fn local_deleted_remote_modified_delete_update_conflict() {
    let b = [("a", lat(1.0))];
    let plan = compute_sync_plan(&hashes(&b), &nostate(), &state(&[("a", lat(2.0))]));
    assert_eq!(plan.conflicts[0].key, "a");
    assert_eq!(plan.conflicts[0].kind, ConflictKind::DeleteUpdate);
    assert_eq!(plan.conflicts[0].local, None);
    assert_eq!(plan.conflicts[0].remote, Some(lat(2.0)));
}

#[test]
fn remote_deleted_local_modified_delete_update_conflict() {
    let b = [("a", lat(1.0))];
    let plan = compute_sync_plan(&hashes(&b), &state(&[("a", lat(2.0))]), &nostate());
    assert_eq!(plan.conflicts[0].key, "a");
    assert_eq!(plan.conflicts[0].kind, ConflictKind::DeleteUpdate);
    assert_eq!(plan.conflicts[0].remote, None);
}

// --- Mixed batch + counts ---

#[test]
fn classifies_a_mixed_batch_correctly_and_summarizes() {
    let base_objs = [
        ("same", lat(0.0)),
        ("locmod", lat(1.0)),
        ("remmod", lat(2.0)),
        ("locdel", lat(3.0)),
        ("remdel", lat(4.0)),
        ("conflict", lat(5.0)),
    ];
    let local = state(&[
        ("same", lat(0.0)),
        ("locmod", lat(11.0)), // push.update
        ("remmod", lat(2.0)),
        // locdel removed -> push.delete
        ("remdel", lat(4.0)),
        ("conflict", lat(51.0)), // conflict
        ("locnew", lat(100.0)),  // push.create
    ]);
    let remote = state(&[
        ("same", lat(0.0)),
        ("locmod", lat(1.0)),
        ("remmod", lat(22.0)), // pull.update
        ("locdel", lat(3.0)),
        // remdel removed -> pull.delete
        ("conflict", lat(52.0)), // conflict
        ("remnew", lat(200.0)),  // pull.create
    ]);
    let plan = compute_sync_plan(&hashes(&base_objs), &local, &remote);
    let c = summarize(&plan);
    assert_eq!((c.push.create, c.push.update, c.push.delete), (1, 1, 1));
    assert_eq!((c.pull.create, c.pull.update, c.pull.delete), (1, 1, 1));
    assert_eq!(c.conflicts, 1);
    assert_eq!(c.actionable, 7);
    assert_eq!(plan.push.create, vec!["locnew"]);
    assert_eq!(plan.pull.create, vec!["remnew"]);
    assert_eq!(plan.conflicts[0].key, "conflict");
}
