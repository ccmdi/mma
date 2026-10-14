use super::*;
use crate::store::engine::Stack;
use crate::sync::{
    sync_hash, IdentityModel, NormalizedSyncLocation, ProviderSpec, RemoteSnapshot, SyncDirection,
};
use crate::test_util::loc_ids;
use crate::types::shape::MapShape;
use crate::types::{Location, LocationFlags};
use mma_algebra::Id;
use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicU32, Ordering};

// --- fixtures ---------------------------------------------------------------

/// A remote whose raw shape is already the normalized contract, plus an optional real id for the
/// stable case; keeps the tests about orchestration, not adaptation.
#[derive(Clone, Debug, PartialEq)]
struct Raw {
    n: NormalizedSyncLocation,
    rid: Option<i64>,
}

fn norm(f: impl FnOnce(&mut NormalizedSyncLocation)) -> NormalizedSyncLocation {
    let mut n = NormalizedSyncLocation {
        lat: 0.0,
        lng: 0.0,
        heading: 0.0,
        pitch: 0.0,
        zoom: 0.0,
        pano_id: None,
        flags: 0,
        tags: vec![],
        extra: None,
    };
    f(&mut n);
    n
}

/// Hash of the normalized contract described by `f` - what a mapping row should carry.
fn nhash(f: impl FnOnce(&mut NormalizedSyncLocation)) -> String {
    sync_hash(&norm(f))
}

fn raw(f: impl FnOnce(&mut NormalizedSyncLocation), rid: Option<i64>) -> Raw {
    Raw { n: norm(f), rid }
}

fn loc(id: u32, f: impl FnOnce(&mut Location)) -> Location {
    let mut l = Location {
        id: Id::new(id),
        ..Location::default()
    };
    f(&mut l);
    l
}

fn row(local_id: u32, remote_id: i64, hash: String) -> RemoteMappingRow {
    RemoteMappingRow {
        local_id: Id::new(local_id),
        remote_id,
        hash,
    }
}

fn no_tags() -> HashMap<Id<ValueRecord>, String> {
    HashMap::new()
}

// --- recording fake provider -----------------------------------------------

/// One push as the provider saw it, reduced to what the assertions check.
#[derive(Default)]
struct Recorded {
    create_ids: Vec<u32>,
    updates: Vec<(u32, Raw)>, // (local_id, replaces)
    deletes: Vec<Raw>,
    desired: Vec<(Option<u32>, Raw)>,
}

/// `stable` churns the remote id on every write (map-making.app does); `positional` replaces the
/// whole document from `desired` and reports a handle for every entry carrying a local id.
const STABLE: ProviderSpec = ProviderSpec {
    id: "fake",
    identity: IdentityModel::Stable,
    direction: SyncDirection::Bidirectional,
    shape: MapShape::MapMaking,
};

const POSITIONAL: ProviderSpec = ProviderSpec {
    id: "fake",
    identity: IdentityModel::Positional,
    direction: SyncDirection::Bidirectional,
    shape: MapShape::MapMaking,
};

struct Fake {
    spec: &'static ProviderSpec,
    items: RefCell<Vec<Raw>>,
    next_rid: Cell<i64>,
    pushes: RefCell<Vec<Recorded>>,
    catalog: Vec<RemoteTag>,
}

impl Fake {
    fn new(spec: &'static ProviderSpec, initial: Vec<Raw>) -> Self {
        Self {
            spec,
            items: RefCell::new(initial),
            next_rid: Cell::new(1000),
            pushes: RefCell::new(Vec::new()),
            catalog: Vec::new(),
        }
    }
    fn stable(initial: Vec<Raw>) -> Self {
        Self::new(&STABLE, initial)
    }
    fn positional(initial: Vec<Raw>) -> Self {
        Self::new(&POSITIONAL, initial)
    }
    fn take_rid(&self) -> i64 {
        let r = self.next_rid.get();
        self.next_rid.set(r + 1);
        r
    }
    fn items(&self) -> Vec<Raw> {
        self.items.borrow().clone()
    }
    fn record(&self, batch: &PushBatch<Raw>) {
        self.pushes.borrow_mut().push(Recorded {
            create_ids: batch
                .create
                .iter()
                .map(|(id, _)| *id)
                .map(Id::get)
                .collect(),
            updates: batch
                .update
                .iter()
                .map(|(id, _, replaces)| (id.get(), replaces.clone()))
                .collect(),
            deletes: batch.delete.clone(),
            desired: batch
                .desired
                .iter()
                .map(|d| (d.local_id.map(Id::get), d.item.clone()))
                .collect(),
        });
    }
}

impl SyncProvider for Fake {
    type Raw = Raw;
    fn spec(&self) -> &'static ProviderSpec {
        self.spec
    }
    fn remote_id_of(&self, item: &Raw, index: usize) -> i64 {
        if self.spec.identity == IdentityModel::Stable {
            item.rid.expect("stable raw needs rid")
        } else {
            index as i64
        }
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
    fn pull(&self, _remote_map_id: &str) -> AppResult<RemoteSnapshot<Raw>> {
        Ok(RemoteSnapshot {
            tags: self.catalog.clone(),
            locations: self.items(),
            token: None,
        })
    }
    fn push(
        &self,
        _remote_map_id: &str,
        batch: &PushBatch<Raw>,
        _token: Option<i64>,
        commit: &mut dyn FnMut(&[PushedId]) -> AppResult<()>,
    ) -> AppResult<Vec<PushedId>> {
        self.record(batch);
        let mut out = Vec::new();
        {
            let mut items = self.items.borrow_mut();
            if self.spec.identity == IdentityModel::Positional {
                *items = batch.desired.iter().map(|d| d.item.clone()).collect();
                for (i, d) in batch.desired.iter().enumerate() {
                    if let Some(local_id) = d.local_id {
                        out.push(PushedId {
                            local_id,
                            remote_id: i as i64,
                        });
                    }
                }
            } else {
                for d in &batch.delete {
                    items.retain(|it| it.rid != d.rid);
                }
                for (local_id, item, replaces) in &batch.update {
                    let rid = self.take_rid();
                    if let Some(pos) = items.iter().position(|it| it.rid == replaces.rid) {
                        items[pos] = Raw {
                            n: item.n.clone(),
                            rid: Some(rid),
                        };
                    }
                    out.push(PushedId {
                        local_id: *local_id,
                        remote_id: rid,
                    });
                }
                for (local_id, item) in &batch.create {
                    let rid = self.take_rid();
                    items.push(Raw {
                        n: item.n.clone(),
                        rid: Some(rid),
                    });
                    out.push(PushedId {
                        local_id: *local_id,
                        remote_id: rid,
                    });
                }
            }
        }
        commit(&out)?;
        Ok(out)
    }
}

// --- in-memory sink ---------------------------------------------------------

struct MemSink {
    rows: HashMap<u32, RemoteMappingRow>,
    upsert_sizes: Vec<usize>,
    delete_calls: usize,
}

impl MemSink {
    fn new() -> Self {
        Self {
            rows: HashMap::new(),
            upsert_sizes: Vec::new(),
            delete_calls: 0,
        }
    }
    fn seeded(rows: &[RemoteMappingRow]) -> Self {
        let mut s = Self::new();
        for r in rows {
            s.rows.insert(r.local_id.get(), r.clone());
        }
        s
    }
    fn untouched(&self) -> bool {
        self.upsert_sizes.is_empty() && self.delete_calls == 0
    }
    /// Rows as `(local_id, remote_id, hash)`, sorted by local id.
    fn dump(&self) -> Vec<(u32, i64, String)> {
        let mut out: Vec<(u32, i64, String)> = self
            .rows
            .values()
            .map(|r| (r.local_id.get(), r.remote_id, r.hash.clone()))
            .collect();
        out.sort_by_key(|r| r.0);
        out
    }
    fn mapping(&self) -> Vec<RemoteMappingRow> {
        let mut out: Vec<RemoteMappingRow> = self.rows.values().cloned().collect();
        out.sort_by_key(|r| r.local_id);
        out
    }
    /// What the apply step records once the pulls have landed locally.
    fn apply_pulls(&mut self, out: &ReconcileOutcome) {
        let rows: Vec<RemoteMappingRow> = out
            .pull_updates
            .iter()
            .map(|u| row(u.local_id.get(), u.remote_id, u.hash.clone()))
            .collect();
        self.upsert(&rows).unwrap();
        self.delete(&out.pull_delete_ids).unwrap();
    }
}

impl MappingSink for MemSink {
    fn upsert(&mut self, rows: &[RemoteMappingRow]) -> AppResult<()> {
        self.upsert_sizes.push(rows.len());
        for r in rows {
            self.rows.insert(r.local_id.get(), r.clone());
        }
        Ok(())
    }
    fn delete(&mut self, local_ids: &[Id<Location>]) -> AppResult<()> {
        self.delete_calls += 1;
        for id in local_ids {
            self.rows.remove(&id.get());
        }
        Ok(())
    }
}

// --- harness ----------------------------------------------------------------

fn drive(
    provider: &Fake,
    locs: &[Location],
    mapping: &[RemoteMappingRow],
    tags: &HashMap<Id<ValueRecord>, String>,
    first_sync: Option<FirstSyncMode>,
    resolutions: &[(IdentityKey, ResolutionSide)],
    sink: &mut MemSink,
) -> ReconcileOutcome {
    let snapshot = provider.pull("r").unwrap();
    let token = snapshot.token;
    let input = ReconcileInput {
        provider,
        local_locs: locs,
        remote: snapshot,
        mapping,
        tag_names: tags,
        first_sync,
        resolutions,
    };
    let planned = plan(&input).unwrap();
    execute(provider, "r", planned, token, sink).unwrap()
}

/// Plain reconcile: no first-sync mode, no resolutions.
fn sync(
    provider: &Fake,
    locs: &[Location],
    mapping: &[RemoteMappingRow],
    tags: &HashMap<Id<ValueRecord>, String>,
    sink: &mut MemSink,
) -> ReconcileOutcome {
    drive(provider, locs, mapping, tags, None, &[], sink)
}

fn side(create: u32, update: u32, delete: u32) -> SideCounts {
    SideCounts {
        create,
        update,
        delete,
    }
}

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

#[test]
fn pushes_unmapped_local_and_records_resolved_remote_id() {
    let provider = Fake::stable(vec![]);
    let locs = [loc(1, |l| {
        l.lat = 10.0;
        l.lng = 20.0;
    })];
    let mut sink = MemSink::new();

    let out = sync(&provider, &locs, &[], &no_tags(), &mut sink);

    assert_eq!(out.pushed, side(1, 0, 0));
    let pushes = provider.pushes.borrow();
    assert_eq!(pushes.len(), 1);
    assert_eq!(pushes[0].create_ids, vec![1]);
    // Stable-id providers push deltas; `desired` is built only for positional ones.
    assert!(pushes[0].desired.is_empty());
    drop(pushes);
    assert_eq!(
        sink.dump(),
        vec![(
            1,
            1000,
            nhash(|n| {
                n.lat = 10.0;
                n.lng = 20.0;
            })
        )]
    );
    assert_eq!(
        provider.items(),
        vec![raw(
            |n| {
                n.lat = 10.0;
                n.lng = 20.0;
            },
            Some(1000)
        )]
    );

    // Steady state: a second pass has nothing to do.
    let mut sink2 = MemSink::seeded(&sink.mapping());
    let out2 = sync(&provider, &locs, &sink.mapping(), &no_tags(), &mut sink2);
    assert_eq!(out2.pushed, side(0, 0, 0));
    assert!(sink2.untouched());
}

// ---------------------------------------------------------------------------
// pull
// ---------------------------------------------------------------------------

#[test]
fn pull_create_returns_instruction_with_hash_and_handle() {
    let provider = Fake::stable(vec![raw(|n| n.lat = 5.0, Some(7))]);
    let mut sink = MemSink::new();

    let out = sync(&provider, &[], &[], &no_tags(), &mut sink);

    assert_eq!(out.pulled, side(1, 0, 0));
    assert!(provider.pushes.borrow().is_empty());
    assert_eq!(out.pull_creates.len(), 1);
    let c = &out.pull_creates[0];
    assert_eq!(c.fields.lat, 5.0);
    assert_eq!(c.remote_id, 7);
    assert_eq!(c.hash, nhash(|n| n.lat = 5.0));
    // The engine never writes a pull-create row; JS binds the fresh id and writes it.
    assert!(sink.rows.is_empty());
}

#[test]
fn pull_create_reports_needed_tags() {
    let provider = Fake::stable(vec![raw(
        |n| {
            n.lat = 5.0;
            n.tags = vec!["blue".into()];
        },
        Some(7),
    )]);
    let mut sink = MemSink::new();

    let out = sync(&provider, &[], &[], &no_tags(), &mut sink);

    assert_eq!(out.needed_tags.len(), 1);
    assert_eq!(out.needed_tags[0].name, "blue");
    assert_eq!(out.needed_tags[0].color, None);
    assert_eq!(out.pull_creates.len(), 1);
}

#[test]
fn needed_tags_adopt_the_source_catalog_in_its_order() {
    let mut provider = Fake::stable(vec![raw(
        |n| {
            n.lat = 5.0;
            n.tags = vec!["blue".into(), "red".into(), "loose".into()];
        },
        Some(7),
    )]);
    provider.catalog = vec![
        RemoteTag {
            name: "blue".into(),
            color: Some("#0000ff".into()),
            order: Some(2),
        },
        RemoteTag {
            name: "red".into(),
            color: Some("#ff0000".into()),
            order: Some(1),
        },
    ];
    let mut sink = MemSink::new();

    let out = sync(&provider, &[], &[], &no_tags(), &mut sink);

    let names: Vec<&str> = out.needed_tags.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(names, vec!["red", "blue", "loose"]);
    assert_eq!(out.needed_tags[0].color.as_deref(), Some("#ff0000"));
    assert_eq!(out.needed_tags[2].color, None);
}

// ---------------------------------------------------------------------------
// updates in both directions
// ---------------------------------------------------------------------------

#[test]
fn pushes_local_edit_and_pulls_remote_edit() {
    let provider = Fake::stable(vec![
        raw(|n| n.lat = 1.0, Some(7)),
        raw(|n| n.lat = 22.0, Some(8)),
    ]);
    let locs = [loc(1, |l| l.lat = 11.0), loc(2, |l| l.lat = 2.0)];
    let mapping = [
        row(1, 7, nhash(|n| n.lat = 1.0)),
        row(2, 8, nhash(|n| n.lat = 2.0)),
    ];
    let mut sink = MemSink::seeded(&mapping);

    let out = sync(&provider, &locs, &mapping, &no_tags(), &mut sink);

    assert_eq!(out.pushed, side(0, 1, 0));
    assert_eq!(out.pulled, side(0, 1, 0));
    // The push must not write back over the local edit.
    assert_eq!(out.pull_updates.len(), 1);
    assert_eq!(out.pull_updates[0].local_id, Id::new(2));
    assert_eq!(out.pull_updates[0].patch.lat, Some(22.0));
    assert_eq!(out.pull_updates[0].remote_id, 8);
    assert_eq!(out.pull_updates[0].hash, nhash(|n| n.lat = 22.0));

    let pushes = provider.pushes.borrow();
    assert_eq!(pushes[0].updates.len(), 1);
    assert_eq!(pushes[0].updates[0].0, 1);
    assert_eq!(pushes[0].updates[0].1, raw(|n| n.lat = 1.0, Some(7)));
    drop(pushes);

    assert_eq!(
        sink.dump(),
        vec![
            (1, 1000, nhash(|n| n.lat = 11.0)),
            (2, 8, nhash(|n| n.lat = 2.0)),
        ]
    );

    // With the pull applied locally (JS's job), the second pass is a no-op.
    sink.apply_pulls(&out);
    let settled_locs = [loc(1, |l| l.lat = 11.0), loc(2, |l| l.lat = 22.0)];
    let mut sink2 = MemSink::seeded(&sink.mapping());
    let out2 = sync(
        &provider,
        &settled_locs,
        &sink.mapping(),
        &no_tags(),
        &mut sink2,
    );
    assert_eq!(out2.pushed, side(0, 0, 0));
    assert_eq!(out2.pulled, side(0, 0, 0));
    assert!(sink2.untouched());
}

// ---------------------------------------------------------------------------
// convergence / adoption
// ---------------------------------------------------------------------------

#[test]
fn adopts_a_change_both_sides_made_and_advances_base() {
    let provider = Fake::stable(vec![raw(|n| n.lat = 2.0, Some(7))]);
    let locs = [loc(1, |l| l.lat = 2.0)];
    let mapping = [row(1, 7, nhash(|n| n.lat = 1.0))];
    let mut sink = MemSink::seeded(&mapping);

    let out = sync(&provider, &locs, &mapping, &no_tags(), &mut sink);

    assert_eq!(out.adopted, 1);
    assert_eq!(out.pushed, side(0, 0, 0));
    assert_eq!(out.pulled, side(0, 0, 0));
    assert!(provider.pushes.borrow().is_empty());
    assert_eq!(sink.dump(), vec![(1, 7, nhash(|n| n.lat = 2.0))]);

    let mut sink2 = MemSink::seeded(&sink.mapping());
    let out2 = sync(&provider, &locs, &sink.mapping(), &no_tags(), &mut sink2);
    assert_eq!(out2.adopted, 0);
    assert!(sink2.untouched());
}

// ---------------------------------------------------------------------------
// conflicts
// ---------------------------------------------------------------------------

#[test]
fn holds_a_divergent_edit_from_both_sides_and_does_not_advance_the_row() {
    let provider = Fake::stable(vec![raw(|n| n.lat = 3.0, Some(7))]);
    let locs = [loc(1, |l| l.lat = 2.0)];
    let mapping = [row(1, 7, nhash(|n| n.lat = 1.0))];
    let mut sink = MemSink::seeded(&mapping);

    let out = sync(&provider, &locs, &mapping, &no_tags(), &mut sink);

    assert_eq!(out.conflicts.len(), 1);
    assert_eq!(out.conflicts[0].key, "L:1");
    assert!(provider.pushes.borrow().is_empty());
    // The row keeps its base hash and handle.
    assert_eq!(sink.dump(), vec![(1, 7, nhash(|n| n.lat = 1.0))]);
}

#[test]
fn resolution_to_local_applies_as_a_push_and_settles() {
    let provider = Fake::stable(vec![raw(|n| n.lat = 3.0, Some(7))]);
    let locs = [loc(1, |l| l.lat = 2.0)];
    let mapping = [row(1, 7, nhash(|n| n.lat = 1.0))];
    let mut sink = MemSink::seeded(&mapping);

    let out = drive(
        &provider,
        &locs,
        &mapping,
        &no_tags(),
        None,
        &[("L:1".to_string(), ResolutionSide::Local)],
        &mut sink,
    );

    assert!(out.conflicts.is_empty());
    assert_eq!(out.pushed, side(0, 1, 0));
    assert_eq!(provider.items(), vec![raw(|n| n.lat = 2.0, Some(1000))]);
    assert_eq!(sink.dump(), vec![(1, 1000, nhash(|n| n.lat = 2.0))]);
}

#[test]
fn resolution_to_remote_applies_as_a_pull() {
    let provider = Fake::stable(vec![raw(|n| n.lat = 3.0, Some(7))]);
    let locs = [loc(1, |l| l.lat = 2.0)];
    let mapping = [row(1, 7, nhash(|n| n.lat = 1.0))];
    let mut sink = MemSink::seeded(&mapping);

    let out = drive(
        &provider,
        &locs,
        &mapping,
        &no_tags(),
        None,
        &[("L:1".to_string(), ResolutionSide::Remote)],
        &mut sink,
    );

    assert!(out.conflicts.is_empty());
    assert_eq!(out.pulled, side(0, 1, 0));
    assert!(provider.pushes.borrow().is_empty());
    assert_eq!(out.pull_updates.len(), 1);
    assert_eq!(out.pull_updates[0].local_id, Id::new(1));
    assert_eq!(out.pull_updates[0].patch.lat, Some(3.0));
    assert_eq!(out.pull_updates[0].remote_id, 7);
    assert_eq!(out.pull_updates[0].hash, nhash(|n| n.lat = 3.0));
    assert_eq!(sink.dump(), vec![(1, 7, nhash(|n| n.lat = 1.0))]);
}

#[test]
fn pull_updates_and_pull_deletes_leave_their_mapping_rows_to_the_apply_step() {
    let provider = Fake::stable(vec![
        raw(|n| n.lat = 11.0, Some(7)),
        raw(|n| n.lat = 2.0, Some(8)),
    ]);
    let locs = [
        loc(1, |l| l.lat = 1.0),
        loc(2, |l| l.lat = 2.0),
        loc(3, |l| l.lat = 3.0),
    ];
    let mapping = [
        row(1, 7, nhash(|n| n.lat = 1.0)),
        row(2, 8, nhash(|n| n.lat = 2.0)),
        row(3, 9, nhash(|n| n.lat = 3.0)),
    ];
    let mut sink = MemSink::seeded(&mapping);

    let out = sync(&provider, &locs, &mapping, &no_tags(), &mut sink);

    assert_eq!(out.pulled, side(0, 1, 1));
    assert_eq!(out.pull_delete_ids, loc_ids([3]));
    assert!(sink.untouched());
    assert_eq!(
        sink.dump(),
        vec![
            (1, 7, nhash(|n| n.lat = 1.0)),
            (2, 8, nhash(|n| n.lat = 2.0)),
            (3, 9, nhash(|n| n.lat = 3.0)),
        ]
    );

    sink.apply_pulls(&out);
    assert_eq!(
        sink.dump(),
        vec![
            (1, 7, nhash(|n| n.lat = 11.0)),
            (2, 8, nhash(|n| n.lat = 2.0)),
        ]
    );
}

// ---------------------------------------------------------------------------
// first-sync mirror modes
// ---------------------------------------------------------------------------

fn mirror_setup() -> (Fake, [Location; 1]) {
    (
        Fake::stable(vec![raw(|n| n.lat = 2.0, Some(7))]),
        [loc(1, |l| l.lat = 1.0)],
    )
}

#[test]
fn merge_keeps_both_sides_and_deletes_nothing() {
    let (provider, locs) = mirror_setup();
    let mut sink = MemSink::new();

    let out = sync(&provider, &locs, &[], &no_tags(), &mut sink);

    assert_eq!(out.pushed, side(1, 0, 0));
    assert_eq!(out.pulled, side(1, 0, 0));
    assert!(provider.pushes.borrow()[0].deletes.is_empty());
    let mut lats: Vec<f64> = provider.items().iter().map(|r| r.n.lat).collect();
    lats.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(lats, vec![1.0, 2.0]);
}

#[test]
fn mirror_from_remote_deletes_local_only_pins_instead_of_pushing() {
    let (provider, locs) = mirror_setup();
    let mut sink = MemSink::new();

    let out = drive(
        &provider,
        &locs,
        &[],
        &no_tags(),
        Some(FirstSyncMode::MirrorFromRemote),
        &[],
        &mut sink,
    );

    assert_eq!(out.pushed, side(0, 0, 0));
    assert_eq!(out.pulled, side(1, 0, 1));
    assert_eq!(out.mirror_local_delete_ids, loc_ids([1]));
    assert!(provider.pushes.borrow().is_empty());
    assert_eq!(provider.items(), vec![raw(|n| n.lat = 2.0, Some(7))]);
    // The remote-only pin still comes in as a pull-create instruction.
    assert_eq!(out.pull_creates.len(), 1);
    assert_eq!(out.pull_creates[0].fields.lat, 2.0);
}

#[test]
fn mirror_from_local_deletes_remote_only_pins_instead_of_pulling() {
    let (provider, locs) = mirror_setup();
    let mut sink = MemSink::new();

    let out = drive(
        &provider,
        &locs,
        &[],
        &no_tags(),
        Some(FirstSyncMode::MirrorFromLocal),
        &[],
        &mut sink,
    );

    // The deletion is applied remotely, so it counts as a push, not a pull.
    assert_eq!(out.pulled, side(0, 0, 0));
    assert_eq!(out.pushed, side(1, 0, 1));
    assert!(out.pull_creates.is_empty());
    let pushes = provider.pushes.borrow();
    assert_eq!(pushes[0].deletes, vec![raw(|n| n.lat = 2.0, Some(7))]);
    // Stable-id providers push deltas; `desired` is built only for positional ones.
    assert!(pushes[0].desired.is_empty());
    drop(pushes);
    assert_eq!(provider.items(), vec![raw(|n| n.lat = 1.0, Some(1000))]);
}

// ---------------------------------------------------------------------------
// positional reindexing
// ---------------------------------------------------------------------------

/// Three synced pins; the first is deleted locally, so the push rewrites the whole document and
/// every later pin slides down one index.
fn reindex_setup() -> (Fake, [Location; 2], Vec<RemoteMappingRow>) {
    let provider = Fake::positional(vec![
        raw(|n| n.lat = 1.0, None),
        raw(|n| n.lat = 2.0, None),
        raw(|n| n.lat = 3.0, None),
    ]);
    let locs = [loc(2, |l| l.lat = 2.0), loc(3, |l| l.lat = 3.0)];
    let mapping = vec![
        row(1, 0, nhash(|n| n.lat = 1.0)),
        row(2, 1, nhash(|n| n.lat = 2.0)),
        row(3, 2, nhash(|n| n.lat = 3.0)),
    ];
    (provider, locs, mapping)
}

#[test]
fn positional_sends_full_desired_document_without_the_deleted_entry() {
    let (provider, locs, mapping) = reindex_setup();
    let mut sink = MemSink::seeded(&mapping);

    let out = sync(&provider, &locs, &mapping, &no_tags(), &mut sink);

    assert_eq!(out.pushed, side(0, 0, 1));
    let pushes = provider.pushes.borrow();
    assert_eq!(pushes.len(), 1);
    assert_eq!(
        pushes[0].desired,
        vec![
            (Some(2), raw(|n| n.lat = 2.0, None)),
            (Some(3), raw(|n| n.lat = 3.0, None)),
        ]
    );
    assert_eq!(pushes[0].deletes, vec![raw(|n| n.lat = 1.0, None)]);
    drop(pushes);
    assert_eq!(
        provider.items(),
        vec![raw(|n| n.lat = 2.0, None), raw(|n| n.lat = 3.0, None)]
    );
}

#[test]
fn positional_rewrites_untouched_rows_to_new_indices_and_drops_deleted() {
    let (provider, locs, mapping) = reindex_setup();
    let mut sink = MemSink::seeded(&mapping);

    sync(&provider, &locs, &mapping, &no_tags(), &mut sink);

    assert_eq!(
        sink.dump(),
        vec![
            (2, 0, nhash(|n| n.lat = 2.0)),
            (3, 1, nhash(|n| n.lat = 3.0)),
        ]
    );
}

#[test]
fn positional_re_syncs_to_a_noop_against_the_reindexed_remote() {
    let (provider, locs, mapping) = reindex_setup();
    let mut sink = MemSink::seeded(&mapping);
    sync(&provider, &locs, &mapping, &no_tags(), &mut sink);

    let mut sink2 = MemSink::seeded(&sink.mapping());
    let out = sync(&provider, &locs, &sink.mapping(), &no_tags(), &mut sink2);

    assert_eq!(out.pushed, side(0, 0, 0));
    assert_eq!(out.pulled, side(0, 0, 0));
    assert_eq!(provider.pushes.borrow().len(), 1); // no second push
    assert!(sink2.untouched());
}

#[test]
fn positional_keeps_local_id_when_remote_later_edits_a_reindexed_location() {
    let (provider, locs, mapping) = reindex_setup();
    let mut sink = MemSink::seeded(&mapping);
    sync(&provider, &locs, &mapping, &no_tags(), &mut sink);

    // Remote edits the pin now sitting at index 1.
    *provider.items.borrow_mut() = vec![raw(|n| n.lat = 2.0, None), {
        let mut r = raw(|n| n.lat = 3.0, None);
        r.n.heading = 77.0;
        r
    }];
    let mut sink2 = MemSink::seeded(&sink.mapping());
    let out = sync(&provider, &locs, &sink.mapping(), &no_tags(), &mut sink2);

    assert_eq!(out.pulled, side(0, 1, 0));
    assert_eq!(out.pull_updates.len(), 1);
    assert_eq!(out.pull_updates[0].local_id, Id::new(3));
    assert_eq!(out.pull_updates[0].patch.heading, Some(77.0));
}

#[test]
fn positional_binds_a_pulled_in_pins_fresh_id_into_the_same_passes_desired_document() {
    // Remote added a pin AND local added a pin: one pass must pull one, push the other, and the
    // pulled pin - whose local id only exists after the pull applies on the JS side - is reported
    // by the whole-document push via its desired index, so it gets a row at its new index.
    let provider = Fake::positional(vec![raw(|n| n.lat = 2.0, None), raw(|n| n.lat = 9.0, None)]);
    let locs = [loc(2, |l| l.lat = 2.0), loc(3, |l| l.lat = 5.0)];
    let mapping = [row(2, 0, nhash(|n| n.lat = 2.0))];
    let mut sink = MemSink::seeded(&mapping);

    let out = sync(&provider, &locs, &mapping, &no_tags(), &mut sink);

    assert_eq!(out.pulled, side(1, 0, 0));
    assert_eq!(out.pushed, side(1, 0, 0));

    // The pulled pin's instruction carries its desired-document index as the handle.
    assert_eq!(out.pull_creates.len(), 1);
    assert_eq!(out.pull_creates[0].fields.lat, 9.0);
    assert_eq!(out.pull_creates[0].remote_id, 1);
    assert_eq!(out.pull_creates[0].hash, nhash(|n| n.lat = 9.0));

    // The remote-only item survives into the whole-document write at index 1, local id unknown.
    let pushes = provider.pushes.borrow();
    assert_eq!(
        pushes[0].desired,
        vec![
            (Some(2), raw(|n| n.lat = 2.0, None)),
            (None, raw(|n| n.lat = 9.0, None)),
            (Some(3), raw(|n| n.lat = 5.0, None)),
        ]
    );
    drop(pushes);

    // The engine wrote the two locally-known rows; JS writes the pulled pin's row after creating it.
    assert_eq!(
        sink.dump(),
        vec![
            (2, 0, nhash(|n| n.lat = 2.0)),
            (3, 2, nhash(|n| n.lat = 5.0)),
        ]
    );
}

// ---------------------------------------------------------------------------
// chunked push commits
// ---------------------------------------------------------------------------

/// A stable provider that confirms its creates in two instalments, so the commit callback lands
/// each chunk in the sink before the next request.
struct ChunkedFake {
    pushes: Cell<usize>,
}

impl SyncProvider for ChunkedFake {
    type Raw = Raw;
    fn spec(&self) -> &'static ProviderSpec {
        &STABLE
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
    fn pull(&self, _remote_map_id: &str) -> AppResult<RemoteSnapshot<Raw>> {
        Ok(RemoteSnapshot {
            tags: vec![],
            locations: vec![],
            token: None,
        })
    }
    fn push(
        &self,
        _remote_map_id: &str,
        batch: &PushBatch<Raw>,
        _token: Option<i64>,
        commit: &mut dyn FnMut(&[PushedId]) -> AppResult<()>,
    ) -> AppResult<Vec<PushedId>> {
        self.pushes.set(self.pushes.get() + 1);
        let all: Vec<PushedId> = batch
            .create
            .iter()
            .enumerate()
            .map(|(i, (local_id, _))| PushedId {
                local_id: *local_id,
                remote_id: 900 + i as i64,
            })
            .collect();
        // Report in two instalments; the contract still returns the full list.
        let split = 2.min(all.len());
        commit(&all[..split])?;
        commit(&all[split..])?;
        Ok(all)
    }
}

#[test]
fn commits_each_chunk_as_it_lands_and_does_not_rewrite_them_at_the_end() {
    let provider = ChunkedFake {
        pushes: Cell::new(0),
    };
    let locs = [
        loc(1, |l| l.lat = 1.0),
        loc(2, |l| l.lat = 2.0),
        loc(3, |l| l.lat = 3.0),
    ];
    let mut sink = MemSink::new();

    let snapshot = provider.pull("r").unwrap();
    let input = ReconcileInput {
        provider: &provider,
        local_locs: &locs,
        remote: snapshot,
        mapping: &[],
        tag_names: &no_tags(),
        first_sync: None,
        resolutions: &[],
    };
    let planned = plan(&input).unwrap();
    let out = execute(&provider, "r", planned, None, &mut sink).unwrap();

    // Two chunk commits, and nothing after them: pushed keys are excluded from the final rows.
    assert_eq!(sink.upsert_sizes, vec![2, 1]);
    assert_eq!(out.pushed, side(3, 0, 0));
    assert_eq!(sink.rows.len(), 3);
    let mut remotes: Vec<i64> = sink.rows.values().map(|r| r.remote_id).collect();
    remotes.sort();
    assert_eq!(remotes, vec![900, 901, 902]);
}

#[test]
fn atomic_provider_commits_once() {
    let provider = Fake::stable(vec![]);
    let locs = [loc(1, |l| l.lat = 1.0), loc(2, |l| l.lat = 2.0)];
    let mut sink = MemSink::new();

    sync(&provider, &locs, &[], &no_tags(), &mut sink);

    // The single push commit is the only upsert; the final settled write is empty.
    assert_eq!(sink.upsert_sizes, vec![2]);
    assert_eq!(sink.rows.len(), 2);
}

// ---------------------------------------------------------------------------
// partial push failure
// ---------------------------------------------------------------------------

struct PartialPushFake {
    items: RefCell<Vec<Raw>>,
    next_rid: Cell<i64>,
    fail_after: Cell<Option<usize>>,
}

impl PartialPushFake {
    fn new() -> Self {
        Self {
            items: RefCell::new(Vec::new()),
            next_rid: Cell::new(800),
            fail_after: Cell::new(None),
        }
    }
}

impl SyncProvider for PartialPushFake {
    type Raw = Raw;
    fn spec(&self) -> &'static ProviderSpec {
        &STABLE
    }
    fn remote_id_of(&self, item: &Raw, _index: usize) -> i64 {
        item.rid.expect("stable raw needs rid")
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
    fn pull(&self, _remote_map_id: &str) -> AppResult<RemoteSnapshot<Raw>> {
        Ok(RemoteSnapshot {
            tags: vec![],
            locations: self.items.borrow().clone(),
            token: None,
        })
    }
    fn push(
        &self,
        _remote_map_id: &str,
        batch: &PushBatch<Raw>,
        _token: Option<i64>,
        commit: &mut dyn FnMut(&[PushedId]) -> AppResult<()>,
    ) -> AppResult<Vec<PushedId>> {
        let fail_after = self.fail_after.get();
        let mut items = self.items.borrow_mut();
        let mut accepted = Vec::new();
        for (i, (local_id, item)) in batch.create.iter().enumerate() {
            if fail_after.is_some_and(|n| i >= n) {
                break;
            }
            let rid = self.next_rid.get();
            self.next_rid.set(rid + 1);
            items.push(Raw {
                n: item.n.clone(),
                rid: Some(rid),
            });
            accepted.push(PushedId {
                local_id: *local_id,
                remote_id: rid,
            });
        }
        drop(items);
        if !accepted.is_empty() {
            commit(&accepted)?;
        }
        if fail_after.is_some() {
            return Err(AppError("network failure on chunk 2".into()));
        }
        Ok(accepted)
    }
}

#[test]
fn partial_push_failure_preserves_committed_mapping_and_retries_cleanly() {
    let provider = PartialPushFake::new();
    provider.fail_after.set(Some(2));
    let locs = [
        loc(1, |l| l.lat = 1.0),
        loc(2, |l| l.lat = 2.0),
        loc(3, |l| l.lat = 3.0),
    ];
    let mut sink = MemSink::new();

    let snapshot = provider.pull("r").unwrap();
    let input = ReconcileInput {
        provider: &provider,
        local_locs: &locs,
        remote: snapshot,
        mapping: &[],
        tag_names: &no_tags(),
        first_sync: None,
        resolutions: &[],
    };
    let planned = plan(&input).unwrap();
    let result = execute(&provider, "r", planned, None, &mut sink);

    assert!(result.is_err());
    assert_eq!(sink.rows.len(), 2);
    assert_eq!(provider.items.borrow().len(), 2);

    // Retry with the committed mapping. The provider now holds items for the 2 that landed.
    provider.fail_after.set(None);
    let mapping = sink.mapping();
    let mut sink2 = MemSink::seeded(&mapping);

    let snap2 = provider.pull("r").unwrap();
    let token2 = snap2.token;
    let input2 = ReconcileInput {
        provider: &provider,
        local_locs: &locs,
        remote: snap2,
        mapping: &mapping,
        tag_names: &no_tags(),
        first_sync: None,
        resolutions: &[],
    };
    let planned2 = plan(&input2).unwrap();
    let out = execute(&provider, "r", planned2, token2, &mut sink2).unwrap();

    assert_eq!(out.pushed, side(1, 0, 0));
    assert_eq!(out.pulled, side(0, 0, 0));
    assert_eq!(sink2.rows.len(), 3);
    let mut all_ids: Vec<u32> = sink2.rows.keys().copied().collect();
    all_ids.sort();
    assert_eq!(all_ids, vec![1, 2, 3]);
}

#[test]
fn positional_pull_update_moves_to_its_new_index_but_keeps_its_base_hash_until_applied() {
    let edited = || {
        let mut r = raw(|n| n.lat = 3.0, None);
        r.n.heading = 77.0;
        r
    };
    let provider = Fake::positional(vec![
        raw(|n| n.lat = 1.0, None),
        raw(|n| n.lat = 2.0, None),
        edited(),
    ]);
    let locs = [loc(2, |l| l.lat = 2.0), loc(3, |l| l.lat = 3.0)];
    let mapping = [
        row(1, 0, nhash(|n| n.lat = 1.0)),
        row(2, 1, nhash(|n| n.lat = 2.0)),
        row(3, 2, nhash(|n| n.lat = 3.0)),
    ];
    let mut sink = MemSink::seeded(&mapping);

    let out = sync(&provider, &locs, &mapping, &no_tags(), &mut sink);

    assert_eq!(out.pushed, side(0, 0, 1));
    assert_eq!(out.pulled, side(0, 1, 0));
    assert_eq!(out.pull_updates[0].local_id, Id::new(3));
    assert_eq!(out.pull_updates[0].remote_id, 1);
    assert_eq!(out.pull_updates[0].hash, sync_hash(&edited().n));
    assert_eq!(
        sink.dump(),
        vec![
            (2, 0, nhash(|n| n.lat = 2.0)),
            (3, 1, nhash(|n| n.lat = 3.0)),
        ]
    );

    sink.apply_pulls(&out);
    let applied = [
        loc(2, |l| l.lat = 2.0),
        loc(3, |l| {
            l.lat = 3.0;
            l.heading = 77.0;
        }),
    ];
    let mut sink2 = MemSink::seeded(&sink.mapping());
    let out2 = sync(&provider, &applied, &sink.mapping(), &no_tags(), &mut sink2);
    assert_eq!(out2.pushed, side(0, 0, 0));
    assert_eq!(out2.pulled, side(0, 0, 0));
    assert!(sink2.untouched());
}

// ---------------------------------------------------------------------------
// content-keyed conflict handling
// ---------------------------------------------------------------------------

#[test]
fn content_keyed_entries_never_produce_held_rows_or_mapping_deletes() {
    // With mapping: the same two locations get L:N keys. Both sides changed from base
    // differently, so the diff produces a conflict. The plan writes a held row to
    // preserve the base hash.
    let provider = Fake::stable(vec![raw(|n| n.lat = 3.0, Some(7))]);
    let locs = [loc(1, |l| l.lat = 2.0)];

    let mapping = [row(1, 7, nhash(|n| n.lat = 1.0))];
    let snap_a = provider.pull("r").unwrap();
    let planned_mapped = plan(&ReconcileInput {
        provider: &provider,
        local_locs: &locs,
        remote: snap_a,
        mapping: &mapping,
        tag_names: &no_tags(),
        first_sync: None,
        resolutions: &[],
    })
    .unwrap();
    assert_eq!(planned_mapped.conflicts.len(), 1);
    assert_eq!(planned_mapped.held_rows.len(), 1);

    // Without mapping: both pins are content-keyed. Different content -> different keys,
    // so no conflict arises. A content-keyed AddAdd conflict would require a cyrb53
    // collision; in that case the base guard (no base entry for unmapped keys) still
    // prevents a held row, and parse_local_key rejects the C:hash#N key format.
    let snap_b = provider.pull("r").unwrap();
    let planned_unmapped = plan(&ReconcileInput {
        provider: &provider,
        local_locs: &locs,
        remote: snap_b,
        mapping: &[],
        tag_names: &no_tags(),
        first_sync: None,
        resolutions: &[],
    })
    .unwrap();
    assert!(planned_unmapped.conflicts.is_empty());
    assert!(planned_unmapped.held_rows.is_empty());
    assert!(planned_unmapped.mapping_delete_ids.is_empty());
    assert_eq!(planned_unmapped.counts_push.create, 1);
    assert_eq!(planned_unmapped.counts_pull.create, 1);
}

// ---------------------------------------------------------------------------
// empty remote snapshot
// ---------------------------------------------------------------------------

#[test]
fn empty_remote_snapshot_with_a_nonempty_mapping_refuses_the_sync() {
    let provider = Fake::stable(vec![]);
    let locs = [
        loc(1, |l| l.lat = 1.0),
        loc(2, |l| l.lat = 2.0),
        loc(3, |l| l.lat = 3.0),
    ];
    let mapping = [
        row(1, 7, nhash(|n| n.lat = 1.0)),
        row(2, 8, nhash(|n| n.lat = 2.0)),
        row(3, 9, nhash(|n| n.lat = 3.0)),
    ];

    let planned = plan(&ReconcileInput {
        provider: &provider,
        local_locs: &locs,
        remote: provider.pull("r").unwrap(),
        mapping: &mapping,
        tag_names: &no_tags(),
        first_sync: None,
        resolutions: &[],
    });

    assert!(planned.is_err());
    assert!(provider.pushes.borrow().is_empty());
}

#[test]
fn empty_remote_snapshot_with_an_empty_mapping_still_syncs() {
    let provider = Fake::stable(vec![]);
    let mut sink = MemSink::new();

    let out = sync(&provider, &[], &[], &no_tags(), &mut sink);

    assert_eq!(out.pushed, side(0, 0, 0));
    assert_eq!(out.pulled, side(0, 0, 0));
    assert!(out.pull_delete_ids.is_empty());
    assert!(sink.untouched());
}

// ---------------------------------------------------------------------------
// steady state
// ---------------------------------------------------------------------------

#[test]
fn unchanged_map_touches_neither_the_remote_nor_the_sink() {
    let provider = Fake::stable(vec![
        raw(|n| n.lat = 1.0, Some(7)),
        raw(|n| n.lat = 2.0, Some(8)),
    ]);
    let locs = [loc(1, |l| l.lat = 1.0), loc(2, |l| l.lat = 2.0)];
    let mapping = [
        row(1, 7, nhash(|n| n.lat = 1.0)),
        row(2, 8, nhash(|n| n.lat = 2.0)),
    ];
    let mut sink = MemSink::seeded(&mapping);

    let out = sync(&provider, &locs, &mapping, &no_tags(), &mut sink);

    assert_eq!(out.pushed, side(0, 0, 0));
    assert_eq!(out.pulled, side(0, 0, 0));
    assert_eq!(out.adopted, 0);
    assert!(out.conflicts.is_empty());
    assert!(provider.pushes.borrow().is_empty());
    assert!(sink.untouched());
}

// ---------------------------------------------------------------------------
// pull-only
// ---------------------------------------------------------------------------

const PULL_ONLY_STABLE: ProviderSpec = ProviderSpec {
    direction: SyncDirection::PullOnly,
    ..STABLE
};

const PULL_ONLY_POSITIONAL: ProviderSpec = ProviderSpec {
    direction: SyncDirection::PullOnly,
    ..POSITIONAL
};

/// Land a result the way the apply step does: pulled creates get a never-used local id and a row,
/// pulled updates patch in place, pulled and mirrored deletes leave.
fn land(out: &ReconcileOutcome, locs: &mut Vec<Location>, sink: &mut MemSink) {
    static NEXT_ID: AtomicU32 = AtomicU32::new(100);
    for c in &out.pull_creates {
        let next = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let f = &c.fields;
        locs.push(loc(next, |l| {
            l.lat = f.lat;
            l.lng = f.lng;
            l.pano_id = f.pano_id.as_deref().map(Into::into);
            l.flags = LocationFlags::from_bits_retain(f.flags);
        }));
        sink.upsert(&[row(next, c.remote_id, c.hash.clone())])
            .unwrap();
    }
    for u in &out.pull_updates {
        let l = locs.iter_mut().find(|l| l.id == u.local_id).unwrap();
        if let Some(v) = u.patch.lat {
            l.lat = v;
        }
        if let Some(v) = u.patch.lng {
            l.lng = v;
        }
    }
    sink.apply_pulls(out);
    locs.retain(|l| {
        !out.pull_delete_ids.contains(&l.id) && !out.mirror_local_delete_ids.contains(&l.id)
    });
}

/// One reconcile against the sink's own rows, landed.
fn pull_once(provider: &Fake, locs: &mut Vec<Location>, sink: &mut MemSink) -> ReconcileOutcome {
    let mapping = sink.mapping();
    let out = sync(provider, locs, &mapping, &no_tags(), sink);
    land(&out, locs, sink);
    out
}

#[test]
fn pull_only_keeps_local_additions_and_never_pushes() {
    let provider = Fake::new(&PULL_ONLY_POSITIONAL, vec![raw(|n| n.lat = 1.0, None)]);
    let mut locs = vec![loc(1, |l| l.lat = 9.0)];
    let mut sink = MemSink::new();

    let out = pull_once(&provider, &mut locs, &mut sink);
    assert_eq!(out.pulled, side(1, 0, 0));
    assert_eq!(out.pushed, side(0, 0, 0));

    let again = pull_once(&provider, &mut locs, &mut sink);
    assert_eq!(again.pulled, side(0, 0, 0));
    assert!(provider.pushes.borrow().is_empty());
    assert_eq!(provider.items(), vec![raw(|n| n.lat = 1.0, None)]);
    assert!(locs.iter().any(|l| l.id == Id::new(1) && l.lat == 9.0));
    assert!(
        !sink.rows.contains_key(&1),
        "a local addition is never mapped"
    );
}

#[test]
fn pull_only_holds_a_local_edit_until_upstream_changes_that_location() {
    let provider = Fake::new(&PULL_ONLY_POSITIONAL, vec![raw(|n| n.lat = 1.0, None)]);
    let mut locs = vec![];
    let mut sink = MemSink::new();
    pull_once(&provider, &mut locs, &mut sink);
    let id = locs[0].id;

    locs[0].lat = 5.0;
    for _ in 0..2 {
        let out = pull_once(&provider, &mut locs, &mut sink);
        assert_eq!(out.pulled, side(0, 0, 0));
        assert_eq!(out.pushed, side(0, 0, 0));
        assert_eq!(locs[0].lat, 5.0);
        assert_eq!(sink.rows[&id.get()].hash, nhash(|n| n.lat = 1.0));
    }

    provider.items.borrow_mut()[0].n.lat = 2.0;
    let out = pull_once(&provider, &mut locs, &mut sink);
    assert!(out.conflicts.is_empty());
    assert_eq!(out.pulled, side(0, 1, 0));
    assert_eq!(locs[0].lat, 2.0);
    assert!(provider.pushes.borrow().is_empty());
}

#[test]
fn pull_only_keeps_a_local_delete_until_upstream_changes_that_location() {
    let provider = Fake::new(&PULL_ONLY_STABLE, vec![raw(|n| n.lat = 1.0, Some(7))]);
    let mut locs = vec![];
    let mut sink = MemSink::new();
    pull_once(&provider, &mut locs, &mut sink);
    let deleted = locs[0].id;

    locs.clear();
    for _ in 0..2 {
        let out = pull_once(&provider, &mut locs, &mut sink);
        assert_eq!(out.pulled, side(0, 0, 0));
        assert!(locs.is_empty());
        assert!(sink.rows.contains_key(&deleted.get()));
    }

    provider.items.borrow_mut()[0].n.lat = 2.0;
    let out = pull_once(&provider, &mut locs, &mut sink);
    assert!(out.conflicts.is_empty());
    assert_eq!(out.pulled, side(1, 0, 0));
    assert!(!sink.rows.contains_key(&deleted.get()));
    assert_eq!(locs.len(), 1);

    let settled = pull_once(&provider, &mut locs, &mut sink);
    assert_eq!(settled.pulled, side(0, 0, 0));
    assert_eq!(locs.len(), 1);
}

#[test]
fn pull_only_follows_a_regenerated_upstream_and_keeps_local_additions() {
    let provider = Fake::new(
        &PULL_ONLY_POSITIONAL,
        (1..=3)
            .map(|i| raw(|n| n.lat = f64::from(i), None))
            .collect(),
    );
    let mut locs = vec![];
    let mut sink = MemSink::new();
    pull_once(&provider, &mut locs, &mut sink);
    locs.push(loc(1, |l| l.lat = 99.0));

    *provider.items.borrow_mut() = (10..=11)
        .map(|i| raw(|n| n.lat = f64::from(i), None))
        .collect();
    let out = pull_once(&provider, &mut locs, &mut sink);

    assert_eq!(out.pulled, side(2, 0, 3));
    let mut lats: Vec<f64> = locs.iter().map(|l| l.lat).collect();
    lats.sort_by(f64::total_cmp);
    assert_eq!(lats, vec![10.0, 11.0, 99.0]);
    assert!(provider.pushes.borrow().is_empty());
}

#[test]
fn pull_only_refuses_to_mirror_from_local() {
    let provider = Fake::new(&PULL_ONLY_POSITIONAL, vec![raw(|n| n.lat = 1.0, None)]);
    let err = plan(&ReconcileInput {
        provider: &provider,
        local_locs: &[loc(1, |l| l.lat = 2.0)],
        remote: provider.pull("r").unwrap(),
        mapping: &[],
        tag_names: &no_tags(),
        first_sync: Some(FirstSyncMode::MirrorFromLocal),
        resolutions: &[],
    })
    .err();
    assert!(err.is_some());
}

#[test]
fn the_pull_half_lands_as_one_undo_step_with_its_tags_interned() {
    use crate::store::engine::{Store, Tracked, ValueRecord};
    let mut store = Store::new();
    store.meta = Tracked::new(MapMeta {
        id: Id::new("sync-test".into()),
        ..Default::default()
    });
    store.batch = Some(crate::store::arrow::locations_to_batch(&[]));
    let old_tag = ValueRecord {
        id: Id::new(5),
        name: Some("Old".into()),
        order: Some(4),
        ..Default::default()
    };
    store.value_meta.insert(
        "tags".into(),
        Tracked::new([(Id::new(5), old_tag)].into_iter().collect()),
    );
    store.put(&crate::store::engine::Change {
        added: vec![
            crate::test_util::loc(1, 0.0, 0.0),
            crate::test_util::loc(2, 1.0, 1.0),
        ],
        ..Default::default()
    });
    store.next_id = mma_algebra::Ids::starting_at(Id::new(3));

    let out = ReconcileOutcome {
        pushed: SideCounts::default(),
        pulled: SideCounts::default(),
        adopted: 0,
        conflicts: Vec::new(),
        needed_tags: vec![
            RemoteTag {
                name: "New".into(),
                color: Some("#123456".into()),
                order: Some(10),
            },
            RemoteTag {
                name: "Second".into(),
                color: None,
                order: Some(2),
            },
        ],
        pull_creates: vec![PullCreate {
            fields: norm(|n| {
                n.lat = 9.0;
                n.lng = 9.0;
                // Encounter order intentionally differs from remote display order.
                n.tags = vec!["Old".into(), "New".into(), "Second".into()];
            }),
            remote_id: 77,
            hash: "h-create".into(),
        }],
        pull_updates: vec![PullUpdate {
            local_id: Id::new(1),
            patch: Patch::<NormalizedSyncLocation> {
                heading: Some(45.0),
                ..Default::default()
            },
            remote_id: 88,
            hash: "h-update".into(),
        }],
        pull_delete_ids: vec![Id::new(2)],
        mirror_local_delete_ids: Vec::new(),
    };

    let (mutation, rows) = apply_pull(&mut store, &out).unwrap();
    let mutation = mutation.expect("the pull landed a change");
    assert_eq!(mutation.keys, loc_ids([3]));
    assert_eq!(store.edits.len(Stack::Undo), 1);

    let created = store.get_loc_by_id(Id::new(3)).expect("create landed");
    let meta = &store.value_meta["tags"];
    let (new_id, new_rec) = meta
        .iter()
        .find(|(_, rec)| rec.name.as_deref() == Some("New"))
        .expect("New interned at land");
    let (second_id, second_rec) = meta
        .iter()
        .find(|(_, rec)| rec.name.as_deref() == Some("Second"))
        .unwrap();
    assert_eq!(created.tags, vec![Id::new(5), *new_id, *second_id]);
    assert_eq!(meta[&Id::new(5)].order, Some(4));
    assert_eq!(second_rec.order, Some(5));
    assert_eq!(new_rec.order, Some(6));
    assert_eq!(new_rec.color(), "#123456".parse().ok());
    assert_eq!(store.get_loc_by_id(Id::new(1)).unwrap().heading, 45.0);
    assert!(store.get_loc_by_id(Id::new(2)).is_none());
    assert_eq!(rows.len(), 1);
    assert_eq!(
        (rows[0].local_id, rows[0].remote_id, rows[0].hash.as_str()),
        (Id::new(3), 77, "h-create")
    );
}

#[test]
fn a_pulled_update_that_leaves_tags_alone_keeps_the_rows_own_tags() {
    use crate::store::engine::{Store, Tracked, ValueRecord};
    let mut store = Store::new();
    store.meta = Tracked::new(MapMeta {
        id: Id::new("sync-test".into()),
        ..Default::default()
    });
    store.batch = Some(crate::store::arrow::locations_to_batch(&[]));
    let records = [(7, "Kept"), (8, "Pulled")].map(|(id, name)| {
        (
            Id::new(id),
            ValueRecord {
                id: Id::new(id),
                name: Some(name.into()),
                ..Default::default()
            },
        )
    });
    store
        .value_meta
        .insert("tags".into(), Tracked::new(records.into_iter().collect()));
    let mut tagged = crate::test_util::loc(1, 0.0, 0.0);
    tagged.tags = crate::test_util::tag_ids([7]);
    store.put(&crate::store::engine::Change {
        added: vec![tagged],
        ..Default::default()
    });
    store.next_id = mma_algebra::Ids::starting_at(Id::new(2));

    let out = ReconcileOutcome {
        pushed: SideCounts::default(),
        pulled: SideCounts::default(),
        adopted: 0,
        conflicts: Vec::new(),
        needed_tags: Vec::new(),
        pull_creates: vec![PullCreate {
            fields: norm(|n| n.tags = vec!["Pulled".into()]),
            remote_id: 77,
            hash: "h-create".into(),
        }],
        pull_updates: vec![PullUpdate {
            local_id: Id::new(1),
            patch: Patch::<NormalizedSyncLocation> {
                heading: Some(45.0),
                ..Default::default()
            },
            remote_id: 88,
            hash: "h-update".into(),
        }],
        pull_delete_ids: Vec::new(),
        mirror_local_delete_ids: Vec::new(),
    };

    apply_pull(&mut store, &out).unwrap();
    let updated = store.get_loc_by_id(Id::new(1)).unwrap();
    assert_eq!(updated.heading, 45.0);
    assert_eq!(updated.tags, crate::test_util::tag_ids([7]));
    assert_eq!(
        store.get_loc_by_id(Id::new(2)).unwrap().tags,
        crate::test_util::tag_ids([8])
    );
}
