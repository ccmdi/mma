use super::*;
use crate::sync::SyncLocalPin;
use crate::sync::{
    local_to_normalized, sync_hash, IdentityModel, NormalizedSyncLocation, PushBatch, PushedId,
    RemoteSnapshot,
};
use crate::sync_diff::compute_sync_plan;
use crate::types::AppResult;

/// A remote whose raw shape is already the normalized contract, plus an optional real id for the
/// stable case; keeps the tests about identity, not adaptation.
#[derive(Clone)]
struct Raw {
    n: NormalizedSyncLocation,
    rid: Option<i64>,
}

struct Fake {
    identity: IdentityModel,
    project_fn: Option<fn(NormalizedSyncLocation) -> NormalizedSyncLocation>,
    include_fn: Option<fn(&SyncLocalPin) -> bool>,
}

impl Fake {
    fn stable() -> Self {
        Self {
            identity: IdentityModel::Stable,
            project_fn: None,
            include_fn: None,
        }
    }
    fn positional() -> Self {
        Self {
            identity: IdentityModel::Positional,
            project_fn: None,
            include_fn: None,
        }
    }
}

impl SyncProvider for Fake {
    type Raw = Raw;
    fn id(&self) -> &'static str {
        "test"
    }
    fn identity(&self) -> IdentityModel {
        self.identity
    }
    fn supports_tags(&self) -> bool {
        true
    }
    fn remote_id_of(&self, item: &Raw, index: usize) -> i64 {
        item.rid.unwrap_or(index as i64)
    }
    fn normalize(&self, item: &Raw) -> NormalizedSyncLocation {
        item.n.clone()
    }
    fn project(&self, n: NormalizedSyncLocation) -> NormalizedSyncLocation {
        match self.project_fn {
            Some(f) => f(n),
            None => n,
        }
    }
    fn include_local(&self, loc: &SyncLocalPin) -> bool {
        match self.include_fn {
            Some(f) => f(loc),
            None => true,
        }
    }
    fn materialize(&self, n: &NormalizedSyncLocation) -> Raw {
        Raw {
            n: n.clone(),
            rid: None,
        }
    }
    // keying never touches the network seam.
    fn pull(&self, _remote_map_id: &str) -> AppResult<RemoteSnapshot<Raw>> {
        unimplemented!()
    }
    fn push(
        &self,
        _remote_map_id: &str,
        _batch: &PushBatch<Raw>,
        _token: Option<i64>,
        _commit: &mut dyn FnMut(&[PushedId]) -> AppResult<()>,
    ) -> AppResult<Vec<PushedId>> {
        unimplemented!()
    }
}

fn base_norm() -> NormalizedSyncLocation {
    NormalizedSyncLocation {
        lat: 0.0,
        lng: 0.0,
        heading: 0.0,
        pitch: 0.0,
        zoom: 0.0,
        pano_id: None,
        flags: 0,
        tags: vec![],
    }
}

fn raw(f: impl FnOnce(&mut Raw)) -> Raw {
    let mut r = Raw {
        n: base_norm(),
        rid: None,
    };
    f(&mut r);
    r
}

fn loc(id: u32, f: impl FnOnce(&mut SyncLocalPin)) -> SyncLocalPin {
    let mut l = SyncLocalPin {
        id,
        lat: 0.0,
        lng: 0.0,
        heading: 0.0,
        pitch: 0.0,
        zoom: 0.0,
        pano_id: None,
        flags: 0,
        tags: vec![],
    };
    f(&mut l);
    l
}

fn tag_name(id: u32) -> Option<String> {
    if id == 1 {
        Some("red".to_string())
    } else {
        None
    }
}

fn hash_of(l: &SyncLocalPin) -> String {
    sync_hash(&local_to_normalized(l, &tag_name))
}

/// Plan arrays come from HashSet iteration, so any ordered comparison sorts both sides.
fn sorted(v: &[IdentityKey]) -> Vec<&str> {
    let mut out: Vec<&str> = v.iter().map(|s| s.as_str()).collect();
    out.sort();
    out
}

// --- keying: unmapped duplicates -------------------------------------------

#[test]
fn keeps_two_identical_unmapped_local_pins_separate() {
    let dupes = [loc(1, |_| {}), loc(2, |_| {})];
    let k = build_keyed_inputs(&Fake::stable(), &dupes, &[], &[], &tag_name);

    assert_eq!(k.local.len(), 2);
    assert_eq!(k.local_id_of.len(), 2);
    let plan = compute_sync_plan(&k.base, &k.local, &k.remote);
    assert_eq!(plan.push.create.len(), 2);
}

#[test]
fn converges_only_as_many_duplicates_as_shared() {
    // Two identical local pins, one identical remote pin.
    let k = build_keyed_inputs(
        &Fake::stable(),
        &[loc(1, |_| {}), loc(2, |_| {})],
        &[raw(|_| {})],
        &[],
        &tag_name,
    );
    let plan = compute_sync_plan(&k.base, &k.local, &k.remote);

    assert_eq!(plan.converged.len(), 1); // the shared one is adopted
    assert_eq!(plan.push.create.len(), 1); // the surplus local copy is pushed
    assert_eq!(plan.pull.create.len(), 0);
}

// --- keying: positional identity -------------------------------------------

#[test]
fn positional_holds_identity_when_array_untouched() {
    let a = loc(10, |l| l.lat = 1.0);
    let b = loc(11, |l| l.lat = 2.0);
    let mapping = vec![
        RemoteMappingRow {
            local_id: 10,
            remote_id: 0,
            hash: hash_of(&a),
        },
        RemoteMappingRow {
            local_id: 11,
            remote_id: 1,
            hash: hash_of(&b),
        },
    ];
    let k = build_keyed_inputs(
        &Fake::positional(),
        &[a, b],
        &[raw(|r| r.n.lat = 1.0), raw(|r| r.n.lat = 2.0)],
        &mapping,
        &tag_name,
    );
    let plan = compute_sync_plan(&k.base, &k.local, &k.remote);

    assert_eq!(plan.push.create.len(), 0);
    assert_eq!(plan.pull.create.len(), 0);
    assert!(k.remote.contains_key("L:10"));
    assert!(k.remote.contains_key("L:11"));
}

#[test]
fn positional_realigns_by_content_hash_on_insert() {
    let a = loc(10, |l| l.lat = 1.0);
    let b = loc(11, |l| l.lat = 2.0);
    let mapping = vec![
        RemoteMappingRow {
            local_id: 10,
            remote_id: 0,
            hash: hash_of(&a),
        },
        RemoteMappingRow {
            local_id: 11,
            remote_id: 1,
            hash: hash_of(&b),
        },
    ];
    // Someone added a pin at the front on the remote, shifting both of ours by one.
    let k = build_keyed_inputs(
        &Fake::positional(),
        &[a, b],
        &[
            raw(|r| r.n.lat = 99.0),
            raw(|r| r.n.lat = 1.0),
            raw(|r| r.n.lat = 2.0),
        ],
        &mapping,
        &tag_name,
    );
    let plan = compute_sync_plan(&k.base, &k.local, &k.remote);

    assert!(k.remote.contains_key("L:10"));
    assert!(k.remote.contains_key("L:11"));
    assert_eq!(plan.pull.create.len(), 1); // only the genuinely new pin comes in
    assert_eq!(plan.push.create.len(), 0); // nothing of ours re-pushed as new
    assert_eq!(plan.pull.update.len(), 0);
}

#[test]
fn positional_keeps_local_id_on_in_place_edit() {
    let a = loc(10, |l| l.lat = 1.0);
    let mapping = vec![RemoteMappingRow {
        local_id: 10,
        remote_id: 0,
        hash: hash_of(&a),
    }];
    // Same slot, different heading: a remote-side edit, not a delete plus an add. Length unchanged,
    // so step 4's bare index recovers it.
    let k = build_keyed_inputs(
        &Fake::positional(),
        &[a],
        &[raw(|r| {
            r.n.lat = 1.0;
            r.n.heading = 42.0;
        })],
        &mapping,
        &tag_name,
    );
    let plan = compute_sync_plan(&k.base, &k.local, &k.remote);

    assert_eq!(sorted(&plan.pull.update), vec!["L:10"]);
    assert_eq!(plan.pull.create.len(), 0);
    assert_eq!(plan.push.delete.len(), 0);
}

#[test]
fn positional_recovers_edited_pin_by_pano_after_delete_shift() {
    let a = loc(10, |l| {
        l.lat = 1.0;
        l.pano_id = Some("PANO_A".into());
        l.flags = 1;
    });
    let b = loc(11, |l| {
        l.lat = 2.0;
        l.pano_id = Some("PANO_B".into());
        l.flags = 1;
    });
    let mapping = vec![
        RemoteMappingRow {
            local_id: 10,
            remote_id: 0,
            hash: hash_of(&a),
        },
        RemoteMappingRow {
            local_id: 11,
            remote_id: 1,
            hash: hash_of(&b),
        },
    ];
    // Remote deleted #10 outright AND re-aimed #11, so #11's index and hash are both stale.
    let k = build_keyed_inputs(
        &Fake::positional(),
        &[a, b],
        &[raw(|r| {
            r.n.lat = 2.0;
            r.n.pano_id = Some("PANO_B".into());
            r.n.flags = 1;
            r.n.heading = 77.0;
        })],
        &mapping,
        &tag_name,
    );
    let plan = compute_sync_plan(&k.base, &k.local, &k.remote);

    assert_eq!(sorted(&plan.pull.update), vec!["L:11"]); // matched on pano, local id preserved
    assert_eq!(sorted(&plan.pull.delete), vec!["L:10"]);
    assert_eq!(plan.pull.create.len(), 0);
}

#[test]
fn positional_distrusts_bare_index_once_length_changed() {
    let a = loc(10, |l| l.lat = 1.0);
    let b = loc(11, |l| l.lat = 2.0);
    let mapping = vec![
        RemoteMappingRow {
            local_id: 10,
            remote_id: 0,
            hash: hash_of(&a),
        },
        RemoteMappingRow {
            local_id: 11,
            remote_id: 1,
            hash: hash_of(&b),
        },
    ];
    // Both remotes replaced by unrelated content and one dropped. Nothing matches, so these must
    // surface as deletes plus an add, never a wrong pairing.
    let k = build_keyed_inputs(
        &Fake::positional(),
        &[a, b],
        &[raw(|r| r.n.lat = 500.0)],
        &mapping,
        &tag_name,
    );
    let plan = compute_sync_plan(&k.base, &k.local, &k.remote);

    assert_eq!(sorted(&plan.pull.delete), vec!["L:10", "L:11"]);
    assert_eq!(plan.pull.create.len(), 1);
}

// --- keying: provider projection and filtering -----------------------------

fn project_by_pano_flag(mut n: NormalizedSyncLocation) -> NormalizedSyncLocation {
    n.pano_id = if n.flags & 1 != 0 { n.pano_id } else { None };
    n.tags = vec![];
    n
}

#[test]
fn projection_erases_unrepresentable_fields() {
    // A pin carrying a panoId it does not load by. The remote reports panoId null; without
    // projection this would diff forever.
    let l = loc(10, |x| {
        x.pano_id = Some("PANO".into());
        x.flags = 0;
    });
    let projected = {
        let mut n = local_to_normalized(&l, &tag_name);
        n.pano_id = None;
        n.tags = vec![];
        n
    };
    let mut p = Fake::positional();
    p.project_fn = Some(project_by_pano_flag);
    let mapping = vec![RemoteMappingRow {
        local_id: 10,
        remote_id: 0,
        hash: sync_hash(&projected),
    }];
    let k = build_keyed_inputs(
        &p,
        &[l],
        &[raw(|r| r.n.pano_id = None)],
        &mapping,
        &tag_name,
    );
    let plan = compute_sync_plan(&k.base, &k.local, &k.remote);

    assert_eq!(plan.push.update.len(), 0);
    assert_eq!(plan.pull.update.len(), 0);
    assert_eq!(k.local.get("L:10").unwrap().pano_id, None);
}

fn include_non_informational(l: &SyncLocalPin) -> bool {
    (l.flags & 2) == 0
}

#[test]
fn filtering_excludes_and_deletes_once_excluded() {
    let kept = loc(10, |x| x.lat = 1.0);
    let excluded = loc(11, |x| {
        x.lat = 2.0;
        x.flags = 2;
    });
    let mut p = Fake::stable();
    p.include_fn = Some(include_non_informational);

    let fresh = build_keyed_inputs(&p, &[kept.clone(), excluded.clone()], &[], &[], &tag_name);
    assert_eq!(fresh.local.len(), 1);
    let fresh_plan = compute_sync_plan(&fresh.base, &fresh.local, &fresh.remote);
    assert_eq!(fresh_plan.push.create.len(), 1);

    // Already synced, then marked excluded: it must be withdrawn from the remote.
    let mapping = vec![RemoteMappingRow {
        local_id: 11,
        remote_id: 7,
        hash: hash_of(&loc(11, |x| x.lat = 2.0)),
    }];
    let after = build_keyed_inputs(
        &p,
        &[kept, excluded],
        &[raw(|r| {
            r.n.lat = 2.0;
            r.rid = Some(7);
        })],
        &mapping,
        &tag_name,
    );
    let after_plan = compute_sync_plan(&after.base, &after.local, &after.remote);
    assert_eq!(sorted(&after_plan.push.delete), vec!["L:11"]);
}

// --- mapMakingSync keying (stable identity) --------------------------------

#[test]
fn first_sync_identical_unmapped_pins_converge() {
    let l = loc(5, |x| {
        x.lat = 1.0;
        x.lng = 2.0;
    });
    // same content, different ids
    let r = raw(|x| {
        x.n.lat = 1.0;
        x.n.lng = 2.0;
        x.rid = Some(9000);
    });
    let k = build_keyed_inputs(&Fake::stable(), &[l], &[r], &[], &tag_name);
    let plan = compute_sync_plan(&k.base, &k.local, &k.remote);

    assert_eq!(plan.converged.len(), 1);
    assert_eq!(plan.push.create.len(), 0);
    assert_eq!(plan.pull.create.len(), 0);
    // the converged key resolves to both originals (for recording the mapping)
    let key = &plan.converged[0];
    assert_eq!(k.local_id_of.get(key), Some(&5));
    assert_eq!(k.remote_handle_of.get(key), Some(&9000));
}

#[test]
fn first_sync_one_sided_pins_create_on_correct_side() {
    let k = build_keyed_inputs(
        &Fake::stable(),
        &[loc(5, |x| x.lat = 1.0)],
        &[raw(|x| {
            x.n.lat = 2.0;
            x.rid = Some(9000);
        })],
        &[],
        &tag_name,
    );
    let plan = compute_sync_plan(&k.base, &k.local, &k.remote);

    assert_eq!(plan.push.create.len(), 1); // local-only -> push
    assert_eq!(plan.pull.create.len(), 1); // remote-only -> pull
    assert_eq!(plan.converged.len(), 0);
}

#[test]
fn mapped_pin_remote_edit_detected_against_base_hash() {
    let orig = loc(5, |x| {
        x.lat = 1.0;
        x.lng = 2.0;
    });
    let mapping = vec![RemoteMappingRow {
        local_id: 5,
        remote_id: 9000,
        hash: hash_of(&orig),
    }];
    // local unchanged, remote moved
    let k = build_keyed_inputs(
        &Fake::stable(),
        &[orig],
        &[raw(|x| {
            x.n.lat = 9.0;
            x.n.lng = 9.0;
            x.rid = Some(9000);
        })],
        &mapping,
        &tag_name,
    );
    let plan = compute_sync_plan(&k.base, &k.local, &k.remote);

    assert_eq!(sorted(&plan.pull.update), vec!["L:5"]);
    assert_eq!(k.remote_handle_of.get("L:5"), Some(&9000));
    assert_eq!(k.local_id_of.get("L:5"), Some(&5));
}

#[test]
fn mapped_pin_deleted_remotely_pulls_delete() {
    let orig = loc(5, |x| {
        x.lat = 1.0;
        x.lng = 2.0;
    });
    let mapping = vec![RemoteMappingRow {
        local_id: 5,
        remote_id: 9000,
        hash: hash_of(&orig),
    }];
    let k = build_keyed_inputs(&Fake::stable(), &[orig], &[], &mapping, &tag_name); // remote gone
    let plan = compute_sync_plan(&k.base, &k.local, &k.remote);

    assert_eq!(sorted(&plan.pull.delete), vec!["L:5"]);
}
