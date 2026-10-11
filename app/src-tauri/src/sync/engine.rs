//! Reconcile local and remote maps.
//! `plan` computes changes and conflicts; `execute` pushes remote changes and updates mappings.
//! The command also applies pulls locally as one undoable edit.

use crate::store::maps::MapMeta;
use crate::types::{wire_str_enum, AppError, AppResult};
use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::store::engine::{StoreState, ValueRecord};
use crate::store::storage;
use crate::sync::diff::{compute_sync_plan, summarize};
use crate::sync::file::FileProvider;
use crate::sync::geoguessr::GeoGuessrProvider;
use crate::sync::keying::{build_keyed_inputs, KeyedInputs};
use crate::sync::map_making::MapMakingProvider;
use crate::sync::remote_mapping::{self, RemoteMappingRow};
use crate::sync::{
    parse_local_key, sync_hash, Conflict, DesiredEntry, FirstSyncMode, IdentityKey, IdentityModel,
    Location, NormalizedSyncLocation, ProviderSpec, PushBatch, PushedId, RemoteSnapshot, RemoteTag,
    SideCounts, SyncDirection, SyncPlan, SyncProvider,
};
use crate::types::shape::MapPart;
use mma_algebra::{Edit, Id, Op, Patch, Patchable};
use std::mem;
use std::time::Instant;
use tauri::async_runtime;

// --- result types (IPC contract) --------------------------------------------

wire_str_enum! {
    /// Which side won a resolved conflict.
    derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)
    pub enum ResolutionSide {
        /// This map's version won the conflict.
        Local = "local",
        /// The remote map's version won the conflict.
        Remote = "remote",
    }
}

/// A location created on the remote side, to add locally.
// `remote_id` is the handle its mapping row must carry once created (a positional push
// reindexes to its desired-document position).
#[derive(Clone, Debug)]
pub struct PullCreate {
    pub fields: NormalizedSyncLocation,
    pub remote_id: i64,
    pub hash: String,
}

/// A remote-originated update to apply to an existing local id.
#[derive(Clone, Debug)]
pub struct PullUpdate {
    pub local_id: Id<Location>,
    pub patch: Patch<NormalizedSyncLocation>,
    pub remote_id: i64,
    pub hash: String,
}

/// Planned pull changes. The command applies them before returning to the caller.
#[derive(Clone, Debug)]
pub struct ReconcileOutcome {
    pub pushed: SideCounts,
    pub pulled: SideCounts,
    pub adopted: u32,
    pub conflicts: Vec<Conflict>,
    pub needed_tags: Vec<RemoteTag>,
    pub pull_creates: Vec<PullCreate>,
    pub pull_updates: Vec<PullUpdate>,
    pub pull_delete_ids: Vec<Id<Location>>,
    pub mirror_local_delete_ids: Vec<Id<Location>>,
}

/// Sync counts, unresolved conflicts, and the locally applied pull mutation.
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncReconcileResult {
    /// Remote-applied counts; mirror-from-local deletes fold into `delete`.
    pub pushed: SideCounts,
    /// Local-applied counts; mirror-from-remote deletes fold into `delete`.
    pub pulled: SideCounts,
    pub adopted: u32,
    pub conflicts: Vec<Conflict>,
    /// The change the pull half made locally, or `null` when nothing was pulled.
    pub mutation: Option<crate::store::engine::Mutation>,
    /// The locations the pull removed.
    pub removed_ids: Vec<Id<Location>>,
}

// --- Layer 1: pure planning -------------------------------------------------

pub(crate) struct ReconcileInput<'a, P: SyncProvider> {
    pub provider: &'a P,
    pub local_locs: &'a [Location],
    pub remote: RemoteSnapshot<P::Raw>,
    pub mapping: &'a [RemoteMappingRow],
    /// tag id -> name of the open map.
    pub tag_names: &'a HashMap<Id<ValueRecord>, String>,
    pub first_sync: Option<FirstSyncMode>,
    pub resolutions: &'a [(IdentityKey, ResolutionSide)],
}

/// Planned pushes, pulls, conflicts, and mapping updates.
pub(crate) struct PlannedReconcile<R> {
    pub counts_push: SideCounts,
    pub counts_pull: SideCounts,
    pub conflicts: Vec<Conflict>,
    pub adopted: u32,
    pub needed_tags: Vec<RemoteTag>,
    pub pull_creates: Vec<PullCreate>,
    pub pull_updates: Vec<PullUpdate>,
    pub pull_delete_ids: Vec<Id<Location>>,
    pub mirror_local_delete_ids: Vec<Id<Location>>,
    pub mirror_remote_delete_count: u32,
    /// The remote-side write, or None when nothing goes up.
    pub push_batch: Option<PushBatch<R>>,
    /// local_id -> settled hash for the rows the push confirms (the commit point's content).
    pub push_hashes: HashMap<Id<Location>, String>,
    /// Rows to write with final handles baked in (changed vs mapping only). Pushed keys for a
    /// stable provider are excluded here; the commit path writes them.
    pub rows: Vec<RemoteMappingRow>,
    /// Held keys keep their BASE hash but take the post-push handle.
    pub held_rows: Vec<RemoteMappingRow>,
    pub mapping_delete_ids: Vec<Id<Location>>,
}

/// Express the remote half of the plan both ways: as a delta, and as the full desired document.
/// Remote locations we aren't touching (unchanged, or held as conflicts) carry through verbatim so
/// provider fields we don't model survive a whole-document write.
fn build_push_batch<P: SyncProvider>(
    provider: &P,
    keyed: &KeyedInputs,
    remote_locs: &[P::Raw],
    plan: &SyncPlan,
    mirror_remote_deletes: &HashSet<IdentityKey>,
) -> PushBatch<P::Raw> {
    let mut create = Vec::new();
    let mut update = Vec::new();
    let mut delete = Vec::new();
    let mut replaced: HashMap<IdentityKey, P::Raw> = HashMap::new();

    for key in &plan.push.create {
        let item = provider.materialize(keyed.local.get(key).expect("local key"));
        create.push((keyed.local_id_of[key], item));
    }
    for key in &plan.push.update {
        let item = provider.materialize(keyed.local.get(key).expect("local key"));
        let replaces = remote_locs[keyed.remote_item_of[key]].clone();
        update.push((keyed.local_id_of[key], item.clone(), replaces));
        replaced.insert(key.clone(), item);
    }

    let dropped: HashSet<&IdentityKey> = mirror_remote_deletes
        .iter()
        .chain(plan.push.delete.iter())
        .collect();
    for key in &dropped {
        if let Some(&idx) = keyed.remote_item_of.get(*key) {
            delete.push(remote_locs[idx].clone());
        }
    }

    // Only a whole-document (positional) write reads `desired`; for a delta provider it would
    // be a full cloned copy of the remote side that nothing consumes.
    let mut desired = Vec::new();
    if provider.spec().identity == IdentityModel::Positional {
        for (key, idx) in &keyed.remote_order {
            if dropped.contains(key) {
                continue;
            }
            let item = replaced
                .get(key)
                .cloned()
                .unwrap_or_else(|| remote_locs[*idx].clone());
            desired.push(DesiredEntry {
                item,
                local_id: keyed.local_id_of.get(key).copied(),
            });
        }
        for (local_id, item) in &create {
            desired.push(DesiredEntry {
                item: item.clone(),
                local_id: Some(*local_id),
            });
        }
    }

    PushBatch {
        create,
        update,
        delete,
        desired,
    }
}

/// The pure stage of a reconcile. Produces every apply, both directions, plus the rows to persist.
#[allow(
    clippy::too_many_lines,
    reason = "a sequential pipeline whose stages thread the same accumulating state"
)]
pub(crate) fn plan<P: SyncProvider>(
    input: &ReconcileInput<P>,
) -> AppResult<PlannedReconcile<P::Raw>> {
    if input.remote.locations.is_empty() && !input.mapping.is_empty() {
        return Err(AppError(
            "The remote map came back empty, so nothing was synced.".into(),
        ));
    }
    let provider = input.provider;
    let positional = provider.spec().identity == IdentityModel::Positional;
    let pull_only = provider.spec().direction == SyncDirection::PullOnly;
    if pull_only && input.first_sync == Some(FirstSyncMode::MirrorFromLocal) {
        return Err(AppError(
            "A pull-only link never writes to its source, so it cannot mirror this map onto it."
                .into(),
        ));
    }

    let tag_name = |id: Id<ValueRecord>| input.tag_names.get(&id).cloned();
    let keyed = build_keyed_inputs(
        provider,
        input.local_locs,
        &input.remote.locations,
        input.mapping,
        &tag_name,
    );
    let mut plan = compute_sync_plan(&keyed.base, &keyed.local, &keyed.remote);

    // Resolved conflicts become ordinary applies on the losing side, so the key advances its base
    // instead of re-conflicting on the next poll. A pull-only link resolves every one to the remote.
    if pull_only || !input.resolutions.is_empty() {
        let res: HashMap<&IdentityKey, ResolutionSide> =
            input.resolutions.iter().map(|(k, s)| (k, *s)).collect();
        let mut resolved: HashSet<IdentityKey> = HashSet::new();
        let conflicts = mem::take(&mut plan.conflicts);
        for c in &conflicts {
            let side = if pull_only {
                ResolutionSide::Remote
            } else if let Some(&side) = res.get(&c.key) {
                side
            } else {
                continue;
            };
            resolved.insert(c.key.clone());
            match side {
                ResolutionSide::Local => {
                    if !keyed.local.contains_key(&c.key) {
                        plan.push.delete.push(c.key.clone());
                    } else if keyed.remote.contains_key(&c.key) {
                        plan.push.update.push(c.key.clone());
                    } else {
                        plan.push.create.push(c.key.clone());
                    }
                }
                ResolutionSide::Remote => {
                    if !keyed.remote.contains_key(&c.key) {
                        plan.pull.delete.push(c.key.clone());
                    } else if keyed.local.contains_key(&c.key) {
                        plan.pull.update.push(c.key.clone());
                    } else {
                        plan.pull.create.push(c.key.clone());
                    }
                }
            }
        }
        plan.conflicts = conflicts
            .into_iter()
            .filter(|c| !resolved.contains(&c.key))
            .collect();
    }

    // Mirror seeding (first sync only): reinterpret one side's create-on-the-other as a delete on
    // the loser. `merge` leaves the plan untouched.
    let mode = input.first_sync.unwrap_or(FirstSyncMode::Merge);
    let mut mirror_local_delete_ids: Vec<Id<Location>> = Vec::new();
    let mut mirror_remote_deletes: HashSet<IdentityKey> = HashSet::new();
    if input.mapping.is_empty() {
        match mode {
            FirstSyncMode::MirrorFromRemote => {
                for key in &plan.push.create {
                    mirror_local_delete_ids.push(keyed.local_id_of[key]);
                }
                plan.push.create.clear();
            }
            FirstSyncMode::MirrorFromLocal => {
                for key in &plan.pull.create {
                    mirror_remote_deletes.insert(key.clone());
                }
                plan.pull.create.clear();
            }
            FirstSyncMode::Merge => {}
        }
    }

    // Keys whose base must not advance: held conflicts, and on a pull-only link the local edits
    // and deletes that never go up, so the next pull neither pushes nor reverts them.
    let mut held: Vec<IdentityKey> = plan.conflicts.iter().map(|c| c.key.clone()).collect();
    if pull_only {
        let kept_local = mem::take(&mut plan.push);
        held.extend(kept_local.update);
        held.extend(kept_local.delete);
    }

    // Local tags the incoming pulls reference that don't exist yet (created by the apply step).
    // Each carries the source catalog's look, and the batch follows the source's ordering.
    let name_set: HashSet<&str> = input.tag_names.values().map(String::as_str).collect();
    let mut needed_tags: Vec<RemoteTag> = Vec::new();
    if provider.spec().shape.keeps(MapPart::Tags) {
        let catalog: HashMap<&str, &RemoteTag> = input
            .remote
            .tags
            .iter()
            .map(|t| (t.name.as_str(), t))
            .collect();
        let mut seen: HashSet<String> = HashSet::new();
        for key in plan.pull.create.iter().chain(plan.pull.update.iter()) {
            if let Some(n) = keyed.remote.get(key) {
                for t in &n.tags {
                    if !name_set.contains(t.as_str()) && seen.insert(t.clone()) {
                        needed_tags.push(catalog.get(t.as_str()).map_or_else(
                            || RemoteTag {
                                name: t.clone(),
                                color: None,
                                order: None,
                            },
                            |&r| r.clone(),
                        ));
                    }
                }
            }
        }
        needed_tags.sort_by_key(|t| t.order.unwrap_or(u32::MAX));
    }

    // Post-sync content per key. Seeded from the whole local side, not just touched keys: a
    // location neither side changed still needs a row, because a positional push reindexes it.
    // Borrows into `keyed` - a value copy of this map would be another whole-map clone.
    let mut settled: HashMap<&IdentityKey, &NormalizedSyncLocation> = keyed.local.iter().collect();
    for key in plan.pull.create.iter().chain(plan.pull.update.iter()) {
        let (k, v) = keyed.remote.get_key_value(key).expect("remote key");
        settled.insert(k, v);
    }
    for key in &plan.pull.delete {
        settled.remove(key);
    }
    for key in &held {
        settled.remove(key);
    }

    // The JS side records a pulled update's hash once applied; until then only its handle moves.
    let pulled_updates: HashSet<&IdentityKey> = plan.pull.update.iter().collect();
    let persisted_hash = |key: &IdentityKey, content: &NormalizedSyncLocation| {
        if pulled_updates.contains(key) {
            keyed.base.get(key).cloned()
        } else {
            Some(sync_hash(content))
        }
    };

    let needs_push = !plan.push.create.is_empty()
        || !plan.push.update.is_empty()
        || !plan.push.delete.is_empty()
        || !mirror_remote_deletes.is_empty();
    let push_batch = needs_push.then(|| {
        build_push_batch(
            provider,
            &keyed,
            &input.remote.locations,
            &plan,
            &mirror_remote_deletes,
        )
    });

    // localId -> settled hash the push will confirm. A whole-document (positional) write reindexes
    // and confirms every settled key with a local id; a stable one only the keys it actually sends.
    let mut push_hashes: HashMap<Id<Location>, String> = HashMap::new();
    if push_batch.is_some() {
        if positional {
            for (&key, content) in &settled {
                if let (Some(&local_id), Some(hash)) =
                    (keyed.local_id_of.get(key), persisted_hash(key, content))
                {
                    push_hashes.insert(local_id, hash);
                }
            }
        } else {
            for key in plan.push.create.iter().chain(plan.push.update.iter()) {
                if let (Some(&local_id), Some(content)) =
                    (keyed.local_id_of.get(key), settled.get(key))
                {
                    push_hashes.insert(local_id, sync_hash(content));
                }
            }
        }
    }

    // Index of each remaining remote-side key in the desired document (the positional post-push
    // handle), for row handles and for binding pull creates.
    let mut desired_index_of: HashMap<IdentityKey, usize> = HashMap::new();
    if push_batch.is_some() {
        let dropped: HashSet<&IdentityKey> = mirror_remote_deletes
            .iter()
            .chain(plan.push.delete.iter())
            .collect();
        let mut i = 0;
        for (key, _) in &keyed.remote_order {
            if dropped.contains(key) {
                continue;
            }
            desired_index_of.insert(key.clone(), i);
            i += 1;
        }
    }

    // The final handle for a key: a positional push reindexes everything to the desired document,
    // so its rows take those indices; otherwise the handle read at pull time still holds.
    let handle_of = |key: &IdentityKey| -> Option<i64> {
        if positional && push_batch.is_some() {
            desired_index_of.get(key).map(|&i| i as i64)
        } else {
            keyed.remote_handle_of.get(key).copied()
        }
    };

    // --- pull instructions ---
    let pull_creates: Vec<PullCreate> = plan
        .pull
        .create
        .iter()
        .map(|key| {
            let fields = keyed.remote.get(key).expect("remote key").clone();
            let remote_id = if positional && push_batch.is_some() {
                desired_index_of
                    .get(key)
                    .map(|&i| i as i64)
                    .unwrap_or_else(|| keyed.remote_handle_of[key])
            } else {
                keyed.remote_handle_of[key]
            };
            let hash = sync_hash(&fields);
            PullCreate {
                fields,
                remote_id,
                hash,
            }
        })
        .collect();
    let pull_updates: Vec<PullUpdate> = plan
        .pull
        .update
        .iter()
        .map(|key| {
            let remote = keyed.remote.get(key).expect("remote key");
            PullUpdate {
                local_id: keyed.local_id_of[key],
                patch: NormalizedSyncLocation::between(
                    keyed.local.get(key).expect("local key"),
                    remote,
                ),
                remote_id: handle_of(key).expect("remote key"),
                hash: sync_hash(remote),
            }
        })
        .collect();
    let pull_delete_ids: Vec<Id<Location>> = plan
        .pull
        .delete
        .iter()
        .map(|key| keyed.local_id_of[key])
        .collect();

    // --- rows and deletes ---
    let persisted: HashMap<Id<Location>, &RemoteMappingRow> =
        input.mapping.iter().map(|r| (r.local_id, r)).collect();
    let changed = |r: &RemoteMappingRow| match persisted.get(&r.local_id) {
        None => true,
        Some(p) => p.remote_id != r.remote_id || p.hash != r.hash,
    };

    // A stable push confirms its own keys in the commit callback; pre-writing them here with the
    // stale pre-push handle would strand them. A positional push has no such split.
    let pushed_keys: HashSet<&IdentityKey> = if push_batch.is_some() && !positional {
        plan.push
            .create
            .iter()
            .chain(plan.push.update.iter())
            .collect()
    } else {
        HashSet::new()
    };

    let mut rows = Vec::new();
    for (&key, content) in &settled {
        if pushed_keys.contains(key) {
            continue;
        }
        let Some(&local_id) = keyed.local_id_of.get(key) else {
            continue;
        };
        let Some(remote_id) = handle_of(key) else {
            continue;
        };
        let Some(hash) = persisted_hash(key, content) else {
            continue;
        };
        let row = RemoteMappingRow {
            local_id,
            remote_id,
            hash,
        };
        if changed(&row) {
            rows.push(row);
        }
    }

    // A held key keeps its BASE hash, but must still take the new remote handle - a positional push
    // that reindexes would otherwise strand it.
    let mut held_rows = Vec::new();
    for key in &held {
        let (Some(base), Some(local_id), Some(remote_id)) =
            (keyed.base.get(key), parse_local_key(key), handle_of(key))
        else {
            continue;
        };
        held_rows.push(RemoteMappingRow {
            local_id,
            remote_id,
            hash: base.clone(),
        });
    }

    // A pulled create on a mapped key re-creates a location deleted here under a fresh id; the row
    // of the deleted one must go, or it claims the remote location again on the next pull.
    let mut mapping_delete_ids: Vec<Id<Location>> = Vec::new();
    for key in plan.push.delete.iter().chain(plan.pull.create.iter()) {
        if let Some(id) = parse_local_key(key) {
            mapping_delete_ids.push(id);
        }
    }

    // Converged: both sides already agree; adopt/advance the base, no apply. Both-deleted drops.
    let mut adopted = 0u32;
    for key in &plan.converged {
        if settled.contains_key(key) && keyed.remote_handle_of.contains_key(key) {
            adopted += 1;
        } else if let Some(id) = parse_local_key(key) {
            mapping_delete_ids.push(id);
        }
    }

    let counts = summarize(&plan);
    Ok(PlannedReconcile {
        counts_push: counts.push,
        counts_pull: counts.pull,
        conflicts: plan.conflicts,
        adopted,
        needed_tags,
        pull_creates,
        pull_updates,
        pull_delete_ids,
        mirror_local_delete_ids,
        mirror_remote_delete_count: mirror_remote_deletes.len() as u32,
        push_batch,
        push_hashes,
        rows,
        held_rows,
        mapping_delete_ids,
    })
}

// --- Layer 2: execution -----------------------------------------------------

/// Where mapping rows land. Prod is a rusqlite connection scoped to `(provider, map_id)`; tests
/// use an in-memory map.
pub(crate) trait MappingSink {
    fn upsert(&mut self, rows: &[RemoteMappingRow]) -> AppResult<()>;
    fn delete(&mut self, local_ids: &[Id<Location>]) -> AppResult<()>;
}

/// Drive the push and persist the mapping. The provider commits confirmed ids AS it writes them
/// (resumable across chunks); we then write the plan's remaining rows and drop deleted ones.
pub(crate) fn execute<P: SyncProvider>(
    provider: &P,
    remote_map_id: &str,
    planned: PlannedReconcile<P::Raw>,
    token: Option<i64>,
    sink: &mut dyn MappingSink,
) -> AppResult<ReconcileOutcome> {
    if let Some(batch) = &planned.push_batch {
        let push_hashes = &planned.push_hashes;
        let mut commit = |pushed: &[PushedId]| -> AppResult<()> {
            let rows: Vec<RemoteMappingRow> = pushed
                .iter()
                .filter_map(|p| {
                    push_hashes.get(&p.local_id).map(|h| RemoteMappingRow {
                        local_id: p.local_id,
                        remote_id: p.remote_id,
                        hash: h.clone(),
                    })
                })
                .collect();
            if !rows.is_empty() {
                sink.upsert(&rows)?;
            }
            Ok(())
        };
        provider.push(remote_map_id, batch, token, &mut commit)?;
    }

    let mut final_rows = planned.rows;
    final_rows.extend(planned.held_rows);
    if !final_rows.is_empty() {
        sink.upsert(&final_rows)?;
    }
    if !planned.mapping_delete_ids.is_empty() {
        sink.delete(&planned.mapping_delete_ids)?;
    }

    Ok(ReconcileOutcome {
        pushed: SideCounts {
            create: planned.counts_push.create,
            update: planned.counts_push.update,
            delete: planned.counts_push.delete + planned.mirror_remote_delete_count,
        },
        pulled: SideCounts {
            create: planned.counts_pull.create,
            update: planned.counts_pull.update,
            delete: planned.counts_pull.delete + planned.mirror_local_delete_ids.len() as u32,
        },
        adopted: planned.adopted,
        conflicts: planned.conflicts,
        needed_tags: planned.needed_tags,
        pull_creates: planned.pull_creates,
        pull_updates: planned.pull_updates,
        pull_delete_ids: planned.pull_delete_ids,
        mirror_local_delete_ids: planned.mirror_local_delete_ids,
    })
}

/// Prod sink: rows through [`remote_mapping`], scoped to one linked map.
struct DbSink<'a> {
    conn: &'a mut Connection,
    provider: &'a str,
    map_id: &'a Id<MapMeta, String>,
}

impl MappingSink for DbSink<'_> {
    fn upsert(&mut self, rows: &[RemoteMappingRow]) -> AppResult<()> {
        remote_mapping::upsert(self.conn, self.provider, self.map_id, rows)
    }
    fn delete(&mut self, local_ids: &[Id<Location>]) -> AppResult<()> {
        remote_mapping::delete(self.conn, self.provider, self.map_id, local_ids)
    }
}

// --- Layer 3: the command ---------------------------------------------------

/// One reconcile: which map, against which remote, and the local state it was
/// snapshotted with. Threaded whole from the command down to [`ReconcileInput`].
pub(crate) struct ReconcileRequest<'a> {
    pub map_id: &'a Id<MapMeta, String>,
    pub remote_map_id: &'a str,
    pub local_locs: &'a [Location],
    /// tag id -> name of the open map.
    pub tag_names: &'a HashMap<Id<ValueRecord>, String>,
    pub first_sync: Option<FirstSyncMode>,
    pub resolutions: &'a [(IdentityKey, ResolutionSide)],
}

/// Pull, plan, and execute a linked map against one provider. Blocking (network + rusqlite).
fn reconcile_with<P: SyncProvider>(
    provider: &P,
    req: &ReconcileRequest<'_>,
    mapping: &[RemoteMappingRow],
    conn: &mut Connection,
) -> AppResult<ReconcileOutcome> {
    let t = Instant::now();
    let snapshot = provider.pull(req.remote_map_id)?;
    log::info!(
        "[sync] pull: {} remote locations in {:.1}s",
        snapshot.locations.len(),
        t.elapsed().as_secs_f64()
    );
    let token = snapshot.token;
    let input = ReconcileInput {
        provider,
        local_locs: req.local_locs,
        remote: snapshot,
        mapping,
        tag_names: req.tag_names,
        first_sync: req.first_sync,
        resolutions: req.resolutions,
    };
    let t = Instant::now();
    let planned = plan(&input)?;
    log::info!(
        "[sync] plan: push {}+{}+{} pull {}+{}+{} adopted {} conflicts {} rows {} in {:.1}s",
        planned.counts_push.create,
        planned.counts_push.update,
        planned.counts_push.delete,
        planned.counts_pull.create,
        planned.counts_pull.update,
        planned.counts_pull.delete,
        planned.adopted,
        planned.conflicts.len(),
        planned.rows.len(),
        t.elapsed().as_secs_f64()
    );
    let mut sink = DbSink {
        conn,
        provider: provider.spec().id,
        map_id: req.map_id,
    };
    let t = Instant::now();
    let result = execute(provider, req.remote_map_id, planned, token, &mut sink);
    log::info!("[sync] execute: {:.1}s", t.elapsed().as_secs_f64());
    result
}

/// Every provider this app syncs with.
pub(crate) const PROVIDERS: [&ProviderSpec; 3] = [
    &MapMakingProvider::SPEC,
    &GeoGuessrProvider::SPEC,
    &FileProvider::SPEC,
];

fn run_reconcile(provider_name: &str, req: &ReconcileRequest<'_>) -> AppResult<ReconcileOutcome> {
    let mut conn = storage::open_db()?;
    let mapping = remote_mapping::get(&conn, provider_name, req.map_id)?;

    if provider_name == MapMakingProvider::SPEC.id {
        let provider = MapMakingProvider::from_key()?;
        reconcile_with(&provider, req, &mapping, &mut conn)
    } else if provider_name == GeoGuessrProvider::SPEC.id {
        let provider = GeoGuessrProvider::from_session()?;
        reconcile_with(&provider, req, &mapping, &mut conn)
    } else if provider_name == FileProvider::SPEC.id {
        reconcile_with(&FileProvider, req, &mapping, &mut conn)
    } else {
        Err(AppError(format!("unknown sync provider '{provider_name}'")))
    }
}

/// Reconcile a linked map against its remote, pushing local changes and pulling
/// remote ones. Returns the creates, updates, and deletes for each side to apply.
#[tauri::command]
#[specta::specta]
pub async fn sync_reconcile(
    state: tauri::State<'_, StoreState>,
    provider: String,
    map_id: Id<MapMeta, String>,
    remote_map_id: String,
    first_sync: Option<FirstSyncMode>,
    resolutions: Option<Vec<(String, ResolutionSide)>>,
) -> AppResult<SyncReconcileResult> {
    let keeps_extra = PROVIDERS
        .iter()
        .any(|s| s.id == provider && s.shape.keeps(MapPart::AppData));
    let (local_locs, tag_names) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_map(&map_id)?;
        let t = Instant::now();
        let mut pins: Vec<Location> = Vec::new();
        for row in store.all().rows() {
            let mut loc = row.to_location();
            if !keeps_extra {
                loc.extra = None;
            }
            pins.push(loc);
        }
        log::info!(
            "[sync] snapshot: {} pins in {:.1}s (store lock held)",
            pins.len(),
            t.elapsed().as_secs_f64()
        );
        let names: HashMap<Id<ValueRecord>, String> = store
            .value_meta
            .get("tags")
            .map(|meta| {
                meta.iter()
                    .filter_map(|(&id, rec)| Some((id, rec.name.clone()?)))
                    .collect()
            })
            .unwrap_or_default();
        (pins, names)
    };
    let resolutions = resolutions.unwrap_or_default();

    let out = {
        let provider = provider.clone();
        let map_id = map_id.clone();
        async_runtime::spawn_blocking(move || {
            run_reconcile(
                &provider,
                &ReconcileRequest {
                    map_id: &map_id,
                    remote_map_id: &remote_map_id,
                    local_locs: &local_locs,
                    tag_names: &tag_names,
                    first_sync,
                    resolutions: &resolutions,
                },
            )
        })
        .await??
    };

    let (mutation, created_rows) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_map(&map_id)?;
        apply_pull(store, &out)?
    };
    let update_rows: Vec<RemoteMappingRow> = out
        .pull_updates
        .iter()
        .map(|u| RemoteMappingRow {
            local_id: u.local_id,
            remote_id: u.remote_id,
            hash: u.hash.clone(),
        })
        .collect();
    if !created_rows.is_empty() || !update_rows.is_empty() || !out.pull_delete_ids.is_empty() {
        let mut conn = crate::store::storage::open_db()?;
        if !created_rows.is_empty() {
            remote_mapping::upsert(&mut conn, &provider, &map_id, &created_rows)?;
        }
        if !update_rows.is_empty() {
            remote_mapping::upsert(&mut conn, &provider, &map_id, &update_rows)?;
        }
        if !out.pull_delete_ids.is_empty() {
            remote_mapping::delete(&mut conn, &provider, &map_id, &out.pull_delete_ids)?;
        }
    }

    let mut removed_ids = out.pull_delete_ids;
    removed_ids.extend(&out.mirror_local_delete_ids);
    Ok(SyncReconcileResult {
        pushed: out.pushed,
        pulled: out.pulled,
        adopted: out.adopted,
        conflicts: out.conflicts,
        mutation,
        removed_ids,
    })
}

/// Apply pulled rows and reconcile their tags as one undoable edit.
/// Return the mutation and mappings for newly created rows.
fn apply_pull(
    store: &mut crate::store::engine::Store,
    out: &ReconcileOutcome,
) -> AppResult<(
    Option<crate::store::engine::Mutation>,
    Vec<RemoteMappingRow>,
)> {
    use crate::store::engine::{Target, ValueRecord};
    let edit_count = out.pull_creates.len()
        + out.pull_updates.len()
        + out.pull_delete_ids.len()
        + out.mirror_local_delete_ids.len();
    if edit_count == 0 {
        return Ok((None, Vec::new()));
    }
    let layer = format!("sync:{}", store.meta.id);
    let target = Target::Pending {
        name: layer.clone(),
    };
    store.drop_pending(&layer);

    let needed: HashMap<&str, &RemoteTag> = out
        .needed_tags
        .iter()
        .map(|t| (t.name.as_str(), t))
        .collect();
    let mut piles: HashMap<Id<ValueRecord>, ValueRecord> = HashMap::new();
    let mut pile_of: HashMap<String, Id<ValueRecord>> = HashMap::new();
    let mut tag_of = |name: &str| -> Id<ValueRecord> {
        if let Some(&id) = pile_of.get(name) {
            return id;
        }
        let id = Id::new(piles.len() as u32 + 1);
        let tag = needed.get(name);
        let extra = tag
            .and_then(|t| t.color.as_deref())
            .map(|color| serde_json::Map::from_iter([("color".to_string(), color.into())]));
        piles.insert(
            id,
            ValueRecord {
                id,
                name: Some(name.into()),
                order: tag.and_then(|t| t.order),
                extra,
            },
        );
        pile_of.insert(name.to_string(), id);
        id
    };

    let mut edits: Vec<Edit<Location>> = Vec::new();
    for c in &out.pull_creates {
        edits.push(Op::Set(pulled_location(&c.fields, &mut tag_of)));
    }
    for u in &out.pull_updates {
        edits.push(Op::Put(pulled_patch(u, &mut tag_of)));
    }
    for &id in out
        .pull_delete_ids
        .iter()
        .chain(&out.mirror_local_delete_ids)
    {
        edits.push(Op::Remove(id));
    }

    store.edit(&target, Vec::new(), false, &mut None);
    if let Some(p) = store.pending.get_mut(&layer) {
        p.incoming.insert("tags".to_string(), piles);
    }
    let result = store.edit(&target, edits, true, &mut None);
    let rows = result
        .keys
        .iter()
        .zip(&out.pull_creates)
        .map(|(&local_id, c)| RemoteMappingRow {
            local_id,
            remote_id: c.remote_id,
            hash: c.hash.clone(),
        })
        .collect();
    Ok((Some(result), rows))
}

/// A remote-created row as this map stores it, its tag names resolved through the layer.
fn pulled_location(
    n: &NormalizedSyncLocation,
    tag_of: &mut impl FnMut(&str) -> Id<ValueRecord>,
) -> Location {
    Location {
        id: Id::UNSET,
        lat: n.lat,
        lng: n.lng,
        heading: n.heading,
        pitch: n.pitch,
        zoom: n.zoom,
        pano_id: n.pano_id.as_deref().map(Into::into),
        flags: crate::types::LocationFlags::from_bits_truncate(n.flags),
        tags: n.tags.iter().map(|t| tag_of(t)).collect(),
        extra: n.extra.as_ref().and_then(crate::types::RawExtra::from_map),
        created_at: crate::util::now_unix(),
        modified_at: None,
    }
}

/// A remote-originated patch as a local one, its tag names resolved through the layer.
fn pulled_patch(
    u: &PullUpdate,
    tag_of: &mut impl FnMut(&str) -> Id<ValueRecord>,
) -> Patch<Location> {
    let p = &u.patch;
    Patch::<Location> {
        id: u.local_id,
        lat: p.lat,
        lng: p.lng,
        heading: p.heading,
        pitch: p.pitch,
        zoom: p.zoom,
        pano_id: p.pano_id.as_ref().map(|s| s.as_str().into()),
        flags: p.flags.map(crate::types::LocationFlags::from_bits_truncate),
        tags: p
            .tags
            .as_ref()
            .map(|names| names.iter().map(|t| tag_of(t)).collect()),
        extra: p.extra.as_ref().and_then(crate::types::RawExtra::from_map),
        ..Default::default()
    }
}

#[cfg(test)]
#[path = "engine.test.rs"]
mod tests;
