use super::*;
use crate::store::engine::{IncomingRecords, ValueRecord};
use crate::sync::diff::compute_sync_plan;
use crate::sync::{
    local_to_normalized, sync_hash, IdentityModel, NormalizedSyncLocation, ProviderSpec, PushBatch,
    PushedId, RemoteSnapshot, SyncDirection,
};
use crate::types::shape::MapShape;
use crate::types::{AppResult, Location, LocationFlags};
use mma_algebra::Id;
use std::collections::HashMap;

/// A remote whose raw shape is already the normalized contract, plus an optional real id for the
/// stable case; keeps the tests about identity, not adaptation.
#[derive(Clone)]
struct Raw {
    n: NormalizedSyncLocation,
    rid: Option<i64>,
}

const STABLE: ProviderSpec = ProviderSpec {
    id: "test",
    identity: IdentityModel::Stable,
    direction: SyncDirection::Bidirectional,
    shape: MapShape::MapMaking,
};

const POSITIONAL: ProviderSpec = ProviderSpec {
    id: "test",
    identity: IdentityModel::Positional,
    direction: SyncDirection::Bidirectional,
    shape: MapShape::MapMaking,
};

const POSITIONAL_GEOGUESSR: ProviderSpec = ProviderSpec {
    shape: MapShape::GeoGuessr,
    ..POSITIONAL
};

struct Fake {
    spec: &'static ProviderSpec,
}

impl Fake {
    fn stable() -> Self {
        Self { spec: &STABLE }
    }
    fn positional() -> Self {
        Self { spec: &POSITIONAL }
    }
}

impl SyncProvider for Fake {
    type Raw = Raw;
    fn spec(&self) -> &'static ProviderSpec {
        self.spec
    }
    fn remote_id_of(&self, item: &Raw, index: usize) -> i64 {
        item.rid.unwrap_or(index as i64)
    }
    fn normalize(&self, item: &Raw) -> NormalizedSyncLocation {
        item.n.clone()
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
    ) -> AppResult<()> {
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
        extra: None,
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

fn loc(id: u32, f: impl FnOnce(&mut Location)) -> Location {
    let mut l = Location {
        id: Id::new(id),
        ..Location::default()
    };
    f(&mut l);
    l
}

fn tag_records() -> IncomingRecords {
    let red = ValueRecord {
        id: Id::new(1),
        name: Some("red".into()),
        ..Default::default()
    };
    IncomingRecords::from([("tags".to_string(), HashMap::from([(Id::new(1), red)]))])
}

fn hash_of(l: &Location) -> String {
    sync_hash(&local_to_normalized(l, &tag_records()))
}

/// Plan arrays come from HashSet iteration, so any ordered comparison sorts both sides.
fn sorted(v: &[IdentityKey]) -> Vec<&str> {
    let mut out: Vec<&str> = v.iter().map(String::as_str).collect();
    out.sort();
    out
}

// --- keying: unmapped duplicates -------------------------------------------

#[test]
fn keeps_two_identical_unmapped_local_pins_separate() {
    let dupes = [loc(1, |_| {}), loc(2, |_| {})];
    let k = build_keyed_inputs(&Fake::stable(), &dupes, &[], &[], &tag_records());

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
        &tag_records(),
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
            local_id: Id::new(10),
            remote_id: 0,
            hash: hash_of(&a),
        },
        RemoteMappingRow {
            local_id: Id::new(11),
            remote_id: 1,
            hash: hash_of(&b),
        },
    ];
    let k = build_keyed_inputs(
        &Fake::positional(),
        &[a, b],
        &[raw(|r| r.n.lat = 1.0), raw(|r| r.n.lat = 2.0)],
        &mapping,
        &tag_records(),
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
            local_id: Id::new(10),
            remote_id: 0,
            hash: hash_of(&a),
        },
        RemoteMappingRow {
            local_id: Id::new(11),
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
        &tag_records(),
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
        local_id: Id::new(10),
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
        &tag_records(),
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
        l.flags = LocationFlags::from_bits_retain(1);
    });
    let b = loc(11, |l| {
        l.lat = 2.0;
        l.pano_id = Some("PANO_B".into());
        l.flags = LocationFlags::from_bits_retain(1);
    });
    let mapping = vec![
        RemoteMappingRow {
            local_id: Id::new(10),
            remote_id: 0,
            hash: hash_of(&a),
        },
        RemoteMappingRow {
            local_id: Id::new(11),
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
        &tag_records(),
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
            local_id: Id::new(10),
            remote_id: 0,
            hash: hash_of(&a),
        },
        RemoteMappingRow {
            local_id: Id::new(11),
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
        &tag_records(),
    );
    let plan = compute_sync_plan(&k.base, &k.local, &k.remote);

    assert_eq!(sorted(&plan.pull.delete), vec!["L:10", "L:11"]);
    assert_eq!(plan.pull.create.len(), 1);
}

// --- keying: provider projection and filtering -----------------------------

#[test]
fn projection_erases_unrepresentable_fields() {
    // A pin carrying a panoId it does not load by. The remote reports panoId null; without
    // projection this would diff forever.
    let l = loc(10, |x| {
        x.pano_id = Some("PANO".into());
        x.flags = LocationFlags::from_bits_retain(0);
    });
    let projected = {
        let mut n = local_to_normalized(&l, &tag_records());
        n.pano_id = None;
        n.tags = vec![];
        n
    };
    let mut p = Fake::positional();
    p.spec = &POSITIONAL_GEOGUESSR;
    let mapping = vec![RemoteMappingRow {
        local_id: Id::new(10),
        remote_id: 0,
        hash: sync_hash(&projected),
    }];
    let k = build_keyed_inputs(
        &p,
        &[l],
        &[raw(|r| r.n.pano_id = None)],
        &mapping,
        &tag_records(),
    );
    let plan = compute_sync_plan(&k.base, &k.local, &k.remote);

    assert_eq!(plan.push.update.len(), 0);
    assert_eq!(plan.pull.update.len(), 0);
    assert_eq!(k.local.get("L:10").unwrap().pano_id, None);
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
    let k = build_keyed_inputs(&Fake::stable(), &[l], &[r], &[], &tag_records());
    let plan = compute_sync_plan(&k.base, &k.local, &k.remote);

    assert_eq!(plan.converged.len(), 1);
    assert_eq!(plan.push.create.len(), 0);
    assert_eq!(plan.pull.create.len(), 0);
    // the converged key resolves to both originals (for recording the mapping)
    let key = &plan.converged[0];
    assert_eq!(k.local_id_of.get(key), Some(&Id::new(5)));
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
        &tag_records(),
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
        local_id: Id::new(5),
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
        &tag_records(),
    );
    let plan = compute_sync_plan(&k.base, &k.local, &k.remote);

    assert_eq!(sorted(&plan.pull.update), vec!["L:5"]);
    assert_eq!(k.remote_handle_of.get("L:5"), Some(&9000));
    assert_eq!(k.local_id_of.get("L:5"), Some(&Id::new(5)));
}

#[test]
fn mapped_pin_deleted_remotely_pulls_delete() {
    let orig = loc(5, |x| {
        x.lat = 1.0;
        x.lng = 2.0;
    });
    let mapping = vec![RemoteMappingRow {
        local_id: Id::new(5),
        remote_id: 9000,
        hash: hash_of(&orig),
    }];
    let k = build_keyed_inputs(&Fake::stable(), &[orig], &[], &mapping, &tag_records()); // remote gone
    let plan = compute_sync_plan(&k.base, &k.local, &k.remote);

    assert_eq!(sorted(&plan.pull.delete), vec!["L:5"]);
}
