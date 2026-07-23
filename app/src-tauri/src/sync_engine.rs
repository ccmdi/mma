//! The reconcile pass: composes keying + diff + the provider seam into one pure plan, then
//! executes the push and rewrites the mapping. One pass end to end, EXCEPT pull application:
//! pulls are returned as instructions for the JS side to apply (it owns store-mutation events
//! and undo).
//!
//! Three layers:
//!  - [`plan`]: pure, IO-free, fully testable. Everything the sync settled to.
//!  - [`execute`]: drives the provider push and writes rows through a [`MappingSink`].
//!  - [`sync_reconcile`]: the tauri command; thin glue that snapshots local state, builds the
//!    provider, and runs plan+execute off the async thread.

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::remote_mapping::{self, RemoteMappingRow};
use crate::storage;
use crate::sync::{
    parse_local_key, sync_hash, Conflict, DesiredEntry, FirstSyncMode, IdentityKey, IdentityModel,
    NormalizedSyncLocation, PushBatch, PushedId, RemoteSnapshot, SideCounts, SyncLocalPin,
    SyncPlan, SyncProvider,
};
use crate::sync_diff::{compute_sync_plan, summarize};
use crate::sync_geoguessr::GeoGuessrProvider;
use crate::sync_keying::{build_keyed_inputs, KeyedInputs};
use crate::sync_map_making::MapMakingProvider;
use crate::types::{AppError, AppResult};

// --- result types (IPC contract) --------------------------------------------

/// Which side won a resolved conflict; serialized as "local"/"remote".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ResolutionSide {
    Local,
    Remote,
}

/// A remote-originated create for JS to apply. `remote_id` is the handle its mapping row must
/// carry once created (a positional push reindexes to its desired-document position).
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PullCreate {
    pub fields: NormalizedSyncLocation,
    pub remote_id: i64,
    pub hash: String,
}

/// A remote-originated update for JS to apply to an existing local id.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PullUpdate {
    pub local_id: u32,
    pub patch: SyncPatch,
}

/// Only the fields a pull genuinely changes. A field the provider cannot represent reads as empty
/// on the remote side and must not overwrite local data, so absent fields are left untouched.
/// `pano_id` applies only when `pano_id_set` is true (a cleared panoId is a real change to `null`).
#[derive(Clone, Debug, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncPatch {
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub heading: Option<f64>,
    pub pitch: Option<f64>,
    pub zoom: Option<f64>,
    pub pano_id_set: bool,
    pub pano_id: Option<String>,
    pub flags: Option<u32>,
    pub tags: Option<Vec<String>>,
}

/// Everything the reconcile settled to, for the JS side. Every array is empty on an unchanged map.
#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncReconcileResult {
    /// Remote-applied counts; mirror-from-local deletes fold into `delete`.
    pub pushed: SideCounts,
    /// Local-applied counts; mirror-from-remote deletes fold into `delete`.
    pub pulled: SideCounts,
    pub adopted: u32,
    pub conflicts: Vec<Conflict>,
    pub needed_tags: Vec<String>,
    pub pull_creates: Vec<PullCreate>,
    pub pull_updates: Vec<PullUpdate>,
    pub pull_delete_ids: Vec<u32>,
    pub mirror_local_delete_ids: Vec<u32>,
}

// --- Layer 1: pure planning -------------------------------------------------

pub(crate) struct ReconcileInput<'a, P: SyncProvider> {
    pub provider: &'a P,
    pub local_locs: &'a [SyncLocalPin],
    pub remote: RemoteSnapshot<P::Raw>,
    pub mapping: &'a [RemoteMappingRow],
    /// tag id -> name of the open map.
    pub tag_names: &'a HashMap<u32, String>,
    pub first_sync: Option<FirstSyncMode>,
    pub resolutions: &'a [(IdentityKey, ResolutionSide)],
}

/// The full outcome of planning. Public fields are the IPC result; the rest drive [`execute`].
pub(crate) struct PlannedReconcile<R> {
    pub counts_push: SideCounts,
    pub counts_pull: SideCounts,
    pub conflicts: Vec<Conflict>,
    pub adopted: u32,
    pub needed_tags: Vec<String>,
    pub pull_creates: Vec<PullCreate>,
    pub pull_updates: Vec<PullUpdate>,
    pub pull_delete_ids: Vec<u32>,
    pub mirror_local_delete_ids: Vec<u32>,
    pub mirror_remote_delete_count: u32,
    /// The remote-side write, or None when nothing goes up.
    pub push_batch: Option<PushBatch<R>>,
    /// local_id -> settled hash for the rows the push confirms (the commit point's content).
    pub push_hashes: HashMap<u32, String>,
    /// Rows to write with final handles baked in (changed vs mapping only). Pushed keys for a
    /// stable provider are excluded here; the commit path writes them.
    pub rows: Vec<RemoteMappingRow>,
    /// Held-back conflicts keep their BASE hash but take the post-push handle.
    pub conflict_rows: Vec<RemoteMappingRow>,
    pub mapping_delete_ids: Vec<u32>,
}

fn changed_patch(prev: &NormalizedSyncLocation, next: &NormalizedSyncLocation) -> SyncPatch {
    let pano_changed = prev.pano_id != next.pano_id;
    SyncPatch {
        lat: (prev.lat != next.lat).then_some(next.lat),
        lng: (prev.lng != next.lng).then_some(next.lng),
        heading: (prev.heading != next.heading).then_some(next.heading),
        pitch: (prev.pitch != next.pitch).then_some(next.pitch),
        zoom: (prev.zoom != next.zoom).then_some(next.zoom),
        pano_id_set: pano_changed,
        pano_id: if pano_changed {
            next.pano_id.clone()
        } else {
            None
        },
        flags: (prev.flags != next.flags).then_some(next.flags),
        tags: (prev.tags != next.tags).then(|| next.tags.clone()),
    }
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
    if provider.identity() == IdentityModel::Positional {
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
pub(crate) fn plan<P: SyncProvider>(input: &ReconcileInput<P>) -> PlannedReconcile<P::Raw> {
    let provider = input.provider;
    let positional = provider.identity() == IdentityModel::Positional;

    let tag_name = |id: u32| input.tag_names.get(&id).cloned();
    let keyed = build_keyed_inputs(
        provider,
        input.local_locs,
        &input.remote.locations,
        input.mapping,
        &tag_name,
    );
    let mut plan = compute_sync_plan(&keyed.base, &keyed.local, &keyed.remote);

    // Resolved conflicts become ordinary applies on the losing side, so the key advances its base
    // instead of re-conflicting on the next poll.
    if !input.resolutions.is_empty() {
        let res: HashMap<&IdentityKey, ResolutionSide> =
            input.resolutions.iter().map(|(k, s)| (k, *s)).collect();
        let mut resolved: HashSet<IdentityKey> = HashSet::new();
        let conflicts = std::mem::take(&mut plan.conflicts);
        for c in &conflicts {
            let Some(&side) = res.get(&c.key) else {
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
    let mut mirror_local_delete_ids: Vec<u32> = Vec::new();
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

    // Local tags the incoming pulls reference that don't exist yet (created by the apply step).
    let name_set: HashSet<&str> = input.tag_names.values().map(String::as_str).collect();
    let mut needed_tags: Vec<String> = Vec::new();
    if provider.supports_tags() {
        let mut seen: HashSet<String> = HashSet::new();
        for key in plan.pull.create.iter().chain(plan.pull.update.iter()) {
            if let Some(n) = keyed.remote.get(key) {
                for t in &n.tags {
                    if !name_set.contains(t.as_str()) && seen.insert(t.clone()) {
                        needed_tags.push(t.clone());
                    }
                }
            }
        }
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
    for c in &plan.conflicts {
        settled.remove(&c.key);
    }

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
    let mut push_hashes: HashMap<u32, String> = HashMap::new();
    if push_batch.is_some() {
        if positional {
            for (&key, content) in &settled {
                if let Some(&local_id) = keyed.local_id_of.get(key) {
                    push_hashes.insert(local_id, sync_hash(content));
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
        .map(|key| PullUpdate {
            local_id: keyed.local_id_of[key],
            patch: changed_patch(
                keyed.local.get(key).expect("local key"),
                keyed.remote.get(key).expect("remote key"),
            ),
        })
        .collect();
    let pull_delete_ids: Vec<u32> = plan
        .pull
        .delete
        .iter()
        .map(|key| keyed.local_id_of[key])
        .collect();

    // --- rows and deletes ---
    let persisted: HashMap<u32, &RemoteMappingRow> =
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
        let row = RemoteMappingRow {
            local_id,
            remote_id,
            hash: sync_hash(content),
        };
        if changed(&row) {
            rows.push(row);
        }
    }

    // A held-back conflict keeps its BASE hash so it re-conflicts next time, but must still take
    // the new remote handle - a positional push that reindexes would otherwise strand it.
    let mut conflict_rows = Vec::new();
    for c in &plan.conflicts {
        let Some(base) = keyed.base.get(&c.key) else {
            continue;
        };
        let Some(&local_id) = keyed.local_id_of.get(&c.key) else {
            continue;
        };
        let Some(remote_id) = handle_of(&c.key) else {
            continue;
        };
        conflict_rows.push(RemoteMappingRow {
            local_id,
            remote_id,
            hash: base.clone(),
        });
    }

    let mut mapping_delete_ids: Vec<u32> = Vec::new();
    for key in plan.pull.delete.iter().chain(plan.push.delete.iter()) {
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
    PlannedReconcile {
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
        conflict_rows,
        mapping_delete_ids,
    }
}

// --- Layer 2: execution -----------------------------------------------------

/// Where mapping rows land. Prod is a rusqlite connection scoped to `(provider, map_id)`; tests
/// use an in-memory map.
pub(crate) trait MappingSink {
    fn upsert(&mut self, rows: &[RemoteMappingRow]) -> AppResult<()>;
    fn delete(&mut self, local_ids: &[u32]) -> AppResult<()>;
}

/// Drive the push and persist the mapping. The provider commits confirmed ids AS it writes them
/// (resumable across chunks); we then write the plan's remaining rows and drop deleted ones.
pub(crate) fn execute<P: SyncProvider>(
    provider: &P,
    remote_map_id: &str,
    planned: PlannedReconcile<P::Raw>,
    token: Option<i64>,
    sink: &mut dyn MappingSink,
) -> AppResult<SyncReconcileResult> {
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
    final_rows.extend(planned.conflict_rows);
    if !final_rows.is_empty() {
        sink.upsert(&final_rows)?;
    }
    if !planned.mapping_delete_ids.is_empty() {
        sink.delete(&planned.mapping_delete_ids)?;
    }

    Ok(SyncReconcileResult {
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
    map_id: &'a str,
}

impl MappingSink for DbSink<'_> {
    fn upsert(&mut self, rows: &[RemoteMappingRow]) -> AppResult<()> {
        remote_mapping::upsert(self.conn, self.provider, self.map_id, rows)
    }
    fn delete(&mut self, local_ids: &[u32]) -> AppResult<()> {
        remote_mapping::delete(self.conn, self.provider, self.map_id, local_ids)
    }
}

// --- Layer 3: the command ---------------------------------------------------

/// Rewrap a provider auth failure as the `auth:` prefix the JS side classifies on, stripping the
/// map-making 401 sentinel first so only the human message survives.
fn normalize_auth_error(e: AppError, is_auth: fn(&AppError) -> bool) -> AppError {
    if is_auth(&e) {
        let msg = e.0.strip_prefix("mma-http-401: ").unwrap_or(&e.0);
        AppError(format!("auth: {msg}"))
    } else {
        e
    }
}

/// Pull, plan, and execute a linked map against one provider. Blocking (network + rusqlite).
fn reconcile_with<P: SyncProvider>(
    provider: &P,
    remote_map_id: &str,
    local_locs: &[SyncLocalPin],
    mapping: Vec<RemoteMappingRow>,
    tag_names: &HashMap<u32, String>,
    first_sync: Option<FirstSyncMode>,
    resolutions: &[(IdentityKey, ResolutionSide)],
    conn: &mut Connection,
    provider_id: &str,
    map_id: &str,
    is_auth: fn(&AppError) -> bool,
) -> AppResult<SyncReconcileResult> {
    let mut run = || -> AppResult<SyncReconcileResult> {
        let t = std::time::Instant::now();
        let snapshot = provider.pull(remote_map_id)?;
        log::info!(
            "[sync] pull: {} remote locations in {:.1}s",
            snapshot.locations.len(),
            t.elapsed().as_secs_f64()
        );
        let token = snapshot.token;
        let input = ReconcileInput {
            provider,
            local_locs,
            remote: snapshot,
            mapping: &mapping,
            tag_names,
            first_sync,
            resolutions,
        };
        let t = std::time::Instant::now();
        let planned = plan(&input);
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
            provider: provider_id,
            map_id,
        };
        let t = std::time::Instant::now();
        let result = execute(provider, remote_map_id, planned, token, &mut sink);
        log::info!("[sync] execute: {:.1}s", t.elapsed().as_secs_f64());
        result
    };
    run().map_err(|e| normalize_auth_error(e, is_auth))
}

fn run_reconcile(
    provider_name: &str,
    map_id: &str,
    remote_map_id: &str,
    api_key: Option<String>,
    local_locs: &[SyncLocalPin],
    tag_names: &HashMap<u32, String>,
    first_sync: Option<FirstSyncMode>,
    resolutions: &[(IdentityKey, ResolutionSide)],
) -> AppResult<SyncReconcileResult> {
    let mut conn = storage::open_db()?;
    let mapping = remote_mapping::get(&conn, provider_name, map_id)?;

    match provider_name {
        "map-making.app" => {
            let api_key = api_key.ok_or_else(|| AppError("missing api key".into()))?;
            let provider = MapMakingProvider { api_key };
            reconcile_with(
                &provider,
                remote_map_id,
                local_locs,
                mapping,
                tag_names,
                first_sync,
                resolutions,
                &mut conn,
                provider_name,
                map_id,
                crate::sync_map_making::is_auth_error,
            )
        }
        "geoguessr" => {
            let provider = GeoGuessrProvider::from_session()?;
            reconcile_with(
                &provider,
                remote_map_id,
                local_locs,
                mapping,
                tag_names,
                first_sync,
                resolutions,
                &mut conn,
                provider_name,
                map_id,
                crate::sync_geoguessr::is_auth_error,
            )
        }
        other => Err(AppError(format!("unknown sync provider '{other}'"))),
    }
}

/// Reconcile a linked, open map against its remote. Snapshots local state under the store lock,
/// drops the lock, then does all network + persistence off the async thread.
#[tauri::command]
#[specta::specta]
pub async fn sync_reconcile(
    state: tauri::State<'_, crate::location_store::StoreState>,
    provider: String,
    map_id: String,
    remote_map_id: String,
    api_key: Option<String>,
    first_sync: Option<FirstSyncMode>,
    resolutions: Option<Vec<(String, ResolutionSide)>>,
) -> AppResult<SyncReconcileResult> {
    let (local_locs, tag_names) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_map(&map_id)?;
        // Stream rows into the slim sync shape so each full Location (with its arbitrarily large
        // `extra`) is dropped immediately - never a whole-map copy of fields sync cannot see.
        let t = std::time::Instant::now();
        let mut pins: Vec<SyncLocalPin> = Vec::new();
        store
            .loc_view()
            .for_each(|row| pins.push(SyncLocalPin::from(row.to_location())));
        log::info!(
            "[sync] snapshot: {} pins in {:.1}s (store lock held)",
            pins.len(),
            t.elapsed().as_secs_f64()
        );
        let names: HashMap<u32, String> = store
            .tags
            .all
            .iter()
            .map(|(&id, t)| (id, t.name.clone()))
            .collect();
        (pins, names)
    };
    let resolutions = resolutions.unwrap_or_default();

    tauri::async_runtime::spawn_blocking(move || {
        run_reconcile(
            &provider,
            &map_id,
            &remote_map_id,
            api_key,
            &local_locs,
            &tag_names,
            first_sync,
            &resolutions,
        )
    })
    .await?
}

#[cfg(test)]
#[path = "sync_engine.test.rs"]
mod tests;
