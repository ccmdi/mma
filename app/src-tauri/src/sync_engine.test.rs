use super::*;
use crate::sync::SyncLocalPin;
use crate::sync::{sync_hash, IdentityModel, NormalizedSyncLocation, RemoteSnapshot};
use std::cell::{Cell, RefCell};

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

fn row(local_id: u32, remote_id: i64, hash: String) -> RemoteMappingRow {
    RemoteMappingRow {
        local_id,
        remote_id,
        hash,
    }
}

fn no_tags() -> HashMap<u32, String> {
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
struct Fake {
    identity: IdentityModel,
    items: RefCell<Vec<Raw>>,
    next_rid: Cell<i64>,
    pushes: RefCell<Vec<Recorded>>,
}

impl Fake {
    fn new(identity: IdentityModel, initial: Vec<Raw>) -> Self {
        Self {
            identity,
            items: RefCell::new(initial),
            next_rid: Cell::new(1000),
            pushes: RefCell::new(Vec::new()),
        }
    }
    fn stable(initial: Vec<Raw>) -> Self {
        Self::new(IdentityModel::Stable, initial)
    }
    fn positional(initial: Vec<Raw>) -> Self {
        Self::new(IdentityModel::Positional, initial)
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
            create_ids: batch.create.iter().map(|(id, _)| *id).collect(),
            updates: batch
                .update
                .iter()
                .map(|(id, _, replaces)| (*id, replaces.clone()))
                .collect(),
            deletes: batch.delete.clone(),
            desired: batch
                .desired
                .iter()
                .map(|d| (d.local_id, d.item.clone()))
                .collect(),
        });
    }
}

impl SyncProvider for Fake {
    type Raw = Raw;
    fn id(&self) -> &'static str {
        "fake"
    }
    fn identity(&self) -> IdentityModel {
        self.identity
    }
    fn supports_tags(&self) -> bool {
        true
    }
    fn remote_id_of(&self, item: &Raw, index: usize) -> i64 {
        if self.identity == IdentityModel::Stable {
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
            if self.identity == IdentityModel::Positional {
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
            s.rows.insert(r.local_id, r.clone());
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
            .map(|r| (r.local_id, r.remote_id, r.hash.clone()))
            .collect();
        out.sort_by_key(|r| r.0);
        out
    }
    fn mapping(&self) -> Vec<RemoteMappingRow> {
        let mut out: Vec<RemoteMappingRow> = self.rows.values().cloned().collect();
        out.sort_by_key(|r| r.local_id);
        out
    }
}

impl MappingSink for MemSink {
    fn upsert(&mut self, rows: &[RemoteMappingRow]) -> AppResult<()> {
        self.upsert_sizes.push(rows.len());
        for r in rows {
            self.rows.insert(r.local_id, r.clone());
        }
        Ok(())
    }
    fn delete(&mut self, local_ids: &[u32]) -> AppResult<()> {
        self.delete_calls += 1;
        for id in local_ids {
            self.rows.remove(id);
        }
        Ok(())
    }
}

// --- harness ----------------------------------------------------------------

fn drive(
    provider: &Fake,
    locs: &[SyncLocalPin],
    mapping: &[RemoteMappingRow],
    tags: &HashMap<u32, String>,
    first_sync: Option<FirstSyncMode>,
    resolutions: &[(IdentityKey, ResolutionSide)],
    sink: &mut MemSink,
) -> SyncReconcileResult {
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
    let planned = plan(&input);
    execute(provider, "r", planned, token, sink).unwrap()
}

/// Plain reconcile: no first-sync mode, no resolutions.
fn sync(
    provider: &Fake,
    locs: &[SyncLocalPin],
    mapping: &[RemoteMappingRow],
    tags: &HashMap<u32, String>,
    sink: &mut MemSink,
) -> SyncReconcileResult {
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

    assert_eq!(out.needed_tags, vec!["blue".to_string()]);
    assert_eq!(out.pull_creates.len(), 1);
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
    assert_eq!(out.pull_updates[0].local_id, 2);
    assert_eq!(out.pull_updates[0].patch.lat, Some(22.0));

    let pushes = provider.pushes.borrow();
    assert_eq!(pushes[0].updates.len(), 1);
    assert_eq!(pushes[0].updates[0].0, 1);
    assert_eq!(pushes[0].updates[0].1, raw(|n| n.lat = 1.0, Some(7)));
    drop(pushes);

    assert_eq!(
        sink.dump(),
        vec![
            (1, 1000, nhash(|n| n.lat = 11.0)),
            (2, 8, nhash(|n| n.lat = 22.0)),
        ]
    );

    // With the pull applied locally (JS's job), the second pass is a no-op.
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
    assert_eq!(out.pull_updates[0].local_id, 1);
    assert_eq!(out.pull_updates[0].patch.lat, Some(3.0));
    assert_eq!(sink.dump(), vec![(1, 7, nhash(|n| n.lat = 3.0))]);
}

// ---------------------------------------------------------------------------
// first-sync mirror modes
// ---------------------------------------------------------------------------

fn mirror_setup() -> (Fake, [SyncLocalPin; 1]) {
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
    assert_eq!(out.mirror_local_delete_ids, vec![1]);
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
fn reindex_setup() -> (Fake, [SyncLocalPin; 2], Vec<RemoteMappingRow>) {
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
    assert_eq!(out.pull_updates[0].local_id, 3);
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
    fn id(&self) -> &'static str {
        "chunked"
    }
    fn identity(&self) -> IdentityModel {
        IdentityModel::Stable
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
    fn materialize(&self, n: &NormalizedSyncLocation) -> Raw {
        Raw {
            n: n.clone(),
            rid: None,
        }
    }
    fn pull(&self, _remote_map_id: &str) -> AppResult<RemoteSnapshot<Raw>> {
        Ok(RemoteSnapshot {
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
    let planned = plan(&input);
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
