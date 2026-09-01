//! Tauri commands over the location store: each takes the window lock, calls the engine,
//! and maps the result. Workflow belongs in the engine or in TS, not here.
#![allow(clippy::needless_pass_by_value)]

use crate::io::export;
use crate::io::import;
use crate::plugins::borders;
use crate::selections::{self, Selection, Selector};
use crate::store::arrow;
use crate::store::arrow::{col_id, schema};
use crate::store::engine::*;
use crate::store::maps;
use crate::store::storage;
use crate::types::RawExtra;
use crate::types::{AppError, AppResult};
use crate::types::{Location, Tag};
use crate::util;
use arrow_array::RecordBatch;
use arrow_ord::sort;
use arrow_select::take;
use roaring::RoaringBitmap;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{self, AtomicUsize};
use std::time::Instant;
use tokio::task;

/// How `store_collect` shipped its answer. A transport choice, not a projection: both
/// variants carry the same rows, and callers take whichever arrives.
#[derive(serde::Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Rows {
    Inline { locations: Vec<Location> },
    File { path: String },
}

/// Above this many rows, `store_collect` stages a file instead of answering over IPC.
pub(crate) const ROWS_INLINE_MAX: usize = 1024;

/// A rotating slot per rows-file query: the file is fetched after the store lock is
/// released, so two concurrent row reads must not share one path -- while the slot
/// cycle keeps stale files bounded and self-overwriting like a fixed path.
pub(crate) fn rows_file_path(temp: &Path, map_id: &str) -> PathBuf {
    static SLOT: AtomicUsize = AtomicUsize::new(0);
    let slot = SLOT.fetch_add(1, atomic::Ordering::Relaxed) % 8;
    temp.join(format!("mma_rows_{map_id}_{slot}.json"))
}

/// Load a map's Arrow data from disk, rebuild all indexes, and return initial state
/// (tag counts, undo/redo availability). Must be called before any other store commands.
#[tauri::command]
#[specta::specta]
pub async fn store_open_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    map_id: String,
) -> AppResult<StoreStatus> {
    let map_id2 = map_id.clone();

    let result = task::spawn_blocking(move || {
        use std::time::Instant;
        let t_total = Instant::now();

        let (batch, mmap_handle, delta) = {
            let t0 = Instant::now();
            let path = storage::arrow_path(&map_id2)?;
            let delta_path = storage::arrow_delta_path(&map_id2)?;

            // The base file holds the last committed state -- it may not exist at all for a
            // map with no commits, whose data then lives entirely in the delta sidecar. Mmap
            // the base zero-copy and leave it untouched; load the delta into the overlay
            // regardless of whether a base file exists (never folded into the base).
            let (batch, handle) = if path.exists() {
                let (b, h) = arrow::read_arrow_ipc_mmap(&path)?;
                log::debug!(
                    "[store_open] mmap_read={}ms rows={}",
                    t0.elapsed().as_millis(),
                    b.num_rows()
                );
                (b, Some(h))
            } else {
                log::debug!("[store_open] no base file, empty batch");
                (RecordBatch::new_empty(schema()), None)
            };
            let delta = load_delta(&delta_path);
            (batch, handle, delta)
        };

        // Legacy files may be unsorted; enforce the sorted ID invariant once.
        let (batch, mmap_handle) = {
            let ids = col_id(&batch);
            let sorted = (1..batch.num_rows()).all(|i| ids.value(i - 1) < ids.value(i));
            if sorted || batch.num_rows() == 0 {
                (batch, mmap_handle)
            } else {
                log::info!("[store_open] migrating unsorted Arrow file to sorted ID order");
                let sort_idx = sort::sort_to_indices(ids, None, None)?;
                let sorted_batch = RecordBatch::try_new(
                    batch.schema(),
                    batch
                        .columns()
                        .iter()
                        .map(|col| take::take(col.as_ref(), &sort_idx, None).unwrap())
                        .collect(),
                )
                .unwrap();
                drop(batch);
                drop(mmap_handle);
                let path = storage::arrow_path(&map_id2)?;
                arrow::write_arrow_ipc(&path, &sorted_batch)?;
                drop(sorted_batch);
                let (b, h) = arrow::read_arrow_ipc_mmap(&path)?;
                log::info!("[store_open] migration complete, re-mmap'd sorted file");
                (b, Some(h))
            }
        };

        let n = batch.num_rows();
        let max_id = if n > 0 {
            col_id(&batch).value(n - 1)
        } else {
            0
        };

        let (undo, redo) = load_edit_history(&map_id2)?;

        log::debug!("[store_open] TOTAL={}ms", t_total.elapsed().as_millis());
        Ok::<_, AppError>((batch, mmap_handle, max_id, undo, redo, delta))
    })
    .await??;

    let (batch, mmap_handle, max_id, undo, redo, delta) = result;

    let mut store = Store::new();
    store.bump();
    store.map_id = Some(map_id.clone());
    store.batch = Some(batch);
    store.mmap_handle = mmap_handle;

    // Load uncommitted edits into the overlay; the base batch stays at the last commit.
    // `adds` are persisted in sorted-id order.
    if let Some(d) = delta {
        store.overlay = Tracked::unsaved(d);
    }
    store.next_id = seed_next_id(max_id, &store.overlay.adds, &undo, &redo);

    let LocationAggregates {
        alive,
        tag_counts,
        tag_sets,
        bounds,
    } = store.scan_locations();
    store.alive_count = alive;
    store.bounds = Some(At::new(store.version, bounds));
    {
        let conn = storage::open_db()?;
        storage::set_location_count(&conn, &map_id, alive)?;
        let mut tags = read_tags_json(&conn, &map_id);
        let (max_tag_id, healed) = reconcile_tag_registry(&mut tags, &tag_counts);
        store.tags.all = Tracked::new(tags);
        store.tags.counts = Touched::new(tag_counts);
        if healed {
            store.tags.all.touch();
        }
        store.tags.next_id = max_tag_id + 1;
        store.tags.sets = tag_sets;
        let extra_str: String = conn
            .query_row(
                "SELECT extra FROM maps WHERE id = ?1",
                rusqlite::params![map_id],
                |row| row.get(0),
            )
            .unwrap_or_default();
        let extra = maps::MapExtra::from_json(&extra_str);
        store.field_defs = Tracked::new(extra.fields.unwrap_or_default());
    }
    store.edits.undo = undo;
    store.edits.redo = redo;

    let status = store.open_status();
    let mut mgr = state.lock()?;
    mgr.window_map.insert(label.0.clone(), map_id.clone());
    mgr.stores.insert(map_id, store);
    Ok(status)
}

/// Close the current map: bake overlay, flush Arrow + tags + edit history to disk, then
/// release all in-memory state (batch, mmap, indexes, selections, undo stacks).
#[tauri::command]
#[specta::specta]
pub async fn store_close_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<()> {
    let (map_id, store) = {
        let mut mgr = state.lock()?;
        let map_id = match mgr.window_map.remove(&label.0) {
            Some(id) => id,
            None => return Ok(()),
        };
        if mgr.window_map.values().any(|v| v == &map_id) {
            log::debug!("[close_map] {map_id} still open in another window, skipping flush");
            return Ok(());
        }
        let Some(store) = mgr.stores.remove(&map_id) else {
            log::debug!("[close_map] {map_id} has no store, nothing to flush");
            return Ok(());
        };
        (map_id, store)
    };
    task::spawn_blocking(move || flush_closed_store(&map_id, &store)).await?
}

/// Add new locations. IDs are allocated server-side (monotonic). Records an undo entry
/// and clears the redo stack.
#[tauri::command]
#[specta::specta]
pub fn store_add_locations(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    locations: Vec<Location>,
) -> AppResult<MutationResult> {
    let _t = Instant::now();
    with_store!(label, state, |store| {
        let _lock = _t.elapsed().as_millis();
        let result = apply_adds(store, locations);
        log::debug!(
            "[cmd] store_add_locations lock={}ms total={}ms",
            _lock,
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// Add locations uploaded as chunked JSON in an upload session dir (see `store_upload_begin`),
/// so the frontend never serializes the whole batch at once. Otherwise identical to
/// [`store_add_locations`]: one atomic mutation, one undo entry, IDs in uploaded order.
#[tauri::command]
#[specta::specta]
pub async fn store_add_locations_uploaded(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    session_dir: String,
) -> AppResult<MutationResult> {
    let _t = Instant::now();
    // Parse before taking the store lock: a malformed chunk must leave the store untouched.
    let locations =
        task::spawn_blocking(move || export::read_uploaded_chunks(&session_dir)).await??;
    let _read = _t.elapsed().as_millis();
    with_store!(label, state, |store| {
        let n = locations.len();
        let result = apply_adds(store, locations);
        log::debug!(
            "[cmd] store_add_locations_uploaded n={} read={}ms total={}ms",
            n,
            _read,
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// Remove locations by ID. Snapshots the full location data for undo before deleting.
#[tauri::command]
#[specta::specta]
pub fn store_remove_locations(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    ids: Vec<u32>,
) -> AppResult<MutationResult> {
    let _t = Instant::now();
    with_store!(label, state, |store| {
        let mut removed_locs = Vec::new();
        for &id in &ids {
            if let Some(loc) = store.get_loc_by_id(id) {
                removed_locs.push(loc);
            }
        }
        store.remove_tag_counts(&removed_locs);
        store.overlay_remove(&removed_locs);

        let removed_ids: Vec<u32> = removed_locs.iter().map(|l| l.id).collect();
        store.push_undo(EditEntry {
            created: Vec::new(),
            removed: removed_locs,
        });
        store.edits.redo.clear();

        log::debug!(
            "[cmd] store_remove_locations total={}ms ids={}",
            _t.elapsed().as_millis(),
            ids.len()
        );
        Ok(store.finish_mutation(&ChangeSet {
            removed: removed_ids,
            ..Default::default()
        }))
    })
}

/// Apply partial patches to existing locations. `record_undo` defaults to true;
/// set to false for ephemeral updates (e.g., plugin-driven batch modifications
/// that manage their own undo).
#[tauri::command]
#[specta::specta]
pub async fn store_update_locations(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    updates: Vec<Update<LocationPatch>>,
    record_undo: Option<bool>,
) -> AppResult<MutationResult> {
    let record_undo = record_undo.unwrap_or(true);
    let _t = Instant::now();
    with_store!(label, state, |store| {
        let n = updates.len();
        let result = apply_updates(store, &updates, record_undo);
        log::debug!(
            "[cmd] store_update_locations n={} undo={} total={}ms",
            n,
            record_undo,
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

#[tauri::command]
#[specta::specta]
pub async fn store_apply_field_op(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    op: FieldOp,
    record_undo: Option<bool>,
) -> AppResult<FieldOpResult> {
    let _t = Instant::now();
    with_store!(label, state, |store| {
        let result = apply_field_op(store, &selector, &op, record_undo.unwrap_or(true))?;
        log::debug!(
            "[cmd] store_apply_field_op total={}ms",
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// Rename and/or recolor tags in one batch. Renaming onto an existing name (case-insensitive)
/// merges the two tags.
// Batched so a folder-cascade rename lands as one render instead of one per tag.
#[tauri::command]
#[specta::specta]
pub async fn store_update_tags(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    updates: Vec<Update<TagPatch>>,
) -> AppResult<MutationResult> {
    let _t = Instant::now();
    with_store!(label, state, |store| {
        let mut all_updated: Vec<(Location, Location)> = Vec::new();

        for u in &updates {
            if !store.tags.all.contains_key(&u.id) {
                continue;
            }

            let merge_target = u.patch.name.as_ref().and_then(|new_name| {
                let trimmed = new_name.trim();
                if trimmed.is_empty() {
                    return None;
                }
                let lower = trimmed.to_lowercase();
                store
                    .tags
                    .all
                    .iter()
                    .find(|(&id, t)| id != u.id && t.name.to_lowercase() == lower)
                    .map(|(&id, _)| id)
            });

            if let Some(target_id) = merge_target {
                let view = store.loc_view();
                let affected = selections::resolve(&view, &Selector::Tag { tag_id: u.id });
                drop(view);

                let mut updated: Vec<(Location, Location)> =
                    Vec::with_capacity(affected.len() as usize);
                for loc_id in &affected {
                    if let Some(old) = store.get_loc_by_id(loc_id) {
                        let mut new_tags: Vec<u32> =
                            old.tags.iter().filter(|&&t| t != u.id).copied().collect();
                        if !new_tags.contains(&target_id) {
                            new_tags.push(target_id);
                        }
                        let mut new_loc = old.clone();
                        new_loc.tags = new_tags;
                        updated.push((old, new_loc));
                    }
                }
                all_updated.extend(store.commit_tag_update(updated).updated);
            } else if let Some(t) = store.tags.all.edit().get_mut(&u.id) {
                apply_tag_patch(t, &u.patch);
            }
        }
        let result = store.finish_mutation(&ChangeSet {
            updated: all_updated,
            ..Default::default()
        });
        log::debug!(
            "[cmd] store_update_tags n={} total={}ms",
            updates.len(),
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// Strip tags from all locations. Tags stay in `store.tags` with count=0 /
/// visible=false so undo can revive them. Returns MutationResult with `tags`.
#[tauri::command]
#[specta::specta]
pub async fn store_delete_tags(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    tag_ids: Vec<u32>,
) -> AppResult<MutationResult> {
    let _t = Instant::now();
    with_store!(label, state, |store| {
        let tag_set: HashSet<u32> = tag_ids.iter().copied().collect();
        let view = store.loc_view();
        let mut affected_ids = HashSet::new();
        for &tid in &tag_set {
            affected_ids.extend(selections::resolve(&view, &Selector::Tag { tag_id: tid }));
        }
        drop(view);

        let mut updated: Vec<(Location, Location)> = Vec::with_capacity(affected_ids.len());
        for &id in &affected_ids {
            if let Some(old) = store.get_loc_by_id(id) {
                let mut new_loc = old.clone();
                new_loc.tags.retain(|t| !tag_set.contains(t));
                updated.push((old, new_loc));
            }
        }
        log::debug!(
            "[cmd] store_delete_tags n={} locs={} total={}ms",
            tag_set.len(),
            affected_ids.len(),
            _t.elapsed().as_millis()
        );
        // A zero-member tag never passes through update_tag_counts, so announce it
        // directly or finish_mutation skips the visible=false flip and the delete no-ops.
        for &id in &tag_set {
            store.tags.counts.touch(id);
        }
        let changeset = store.commit_tag_update(updated);
        Ok(store.finish_mutation(&changeset))
    })
}

/// Set (or clear) the active location. Fire-and-forget from JS; no re-render triggered.
/// JS patches the cell buffer synchronously to hide/show the active marker.
#[tauri::command]
#[specta::specta]
pub fn store_set_active(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    id: Option<u32>,
) -> AppResult<()> {
    with_store!(label, state, |store| {
        store.selections.active_id = id;
        Ok(())
    })
}

/// Set the default marker color used by the render delta path. Fire-and-forget from JS;
/// the JS side recolors its cell buffers in place (no full rebuild).
#[tauri::command]
#[specta::specta]
pub fn store_set_marker_color(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    color: [u8; 3],
) -> AppResult<()> {
    with_store!(label, state, |store| {
        store.render.marker_color = color;
        Ok(())
    })
}

/// Count locations by country (offline point-in-polygon). Returns unsorted (ISO-A2, count) pairs.
/// `level` selects border precision, falling back to "light" if unavailable.
// Coords are gathered under the store lock, then classified after it's released.
#[tauri::command]
#[specta::specta]
pub async fn store_country_distribution(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    level: String,
) -> AppResult<Vec<(String, u32)>> {
    let coords: Vec<(f64, f64)> = with_store!(label, state, |store| {
        let view = store.loc_view();
        let resolved = selections::narrow(&view, &selector);
        let mut coords = Vec::new();
        view.for_each_within(resolved.as_ref(), |row| coords.push((row.lat(), row.lng())));
        coords
    });
    borders::tally_countries(&level, &coords)
}

/// Copy locations already stored in this map into another map.
#[tauri::command]
#[specta::specta]
pub fn store_copy_locations_to_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    target_map_id: String,
    selector: Selector,
) -> AppResult<CopyToMapResult> {
    copy_to_map(label, state, target_map_id, |src| src.collect(&selector))
}

/// Copy caller-supplied location data into another map. Tag ids are read against this
/// map's tag table, so the values may differ from any row it holds -- that is how the
/// editor sends the pano you are currently looking at rather than the one on disk.
#[tauri::command]
#[specta::specta]
pub fn store_add_locations_to_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    target_map_id: String,
    locations: Vec<Location>,
) -> AppResult<CopyToMapResult> {
    copy_to_map(label, state, target_map_id, |_| locations)
}

/// Insert `collect`'s locations into another map, skipping ones the target already has.
/// Tags and extra fields carry over.
// If the target is open in any window its live store is mutated and `store-external-mutation`
// tells its windows to resync; either way the result is persisted immediately.
fn copy_to_map(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    target_map_id: String,
    collect: impl FnOnce(&mut Store) -> Vec<Location>,
) -> AppResult<CopyToMapResult> {
    let _t = Instant::now();
    let conn = storage::open_db()?;
    let target_name: String = conn.query_row(
        "SELECT name FROM maps WHERE id = ?1",
        [&target_map_id],
        |r| r.get(0),
    )?;

    // The manager lock is held for both paths: it serializes the closed-path
    // delta-file rewrite against a concurrent store_open_map of the same map.
    let mut mgr = state.lock()?;
    let source_map_id = mgr.map_id_for_window(&label.0)?;
    if source_map_id == target_map_id {
        return Err(AppError("cannot copy a location into its own map".into()));
    }

    let now = util::now_unix();
    let mut sources: Vec<Location> = Vec::new();
    let mut source_tags: HashMap<u32, Tag> = HashMap::new();
    {
        let src = mgr.store_for_map(&source_map_id)?;
        for mut loc in collect(src) {
            loc.created_at = now;
            loc.modified_at = Some(now);
            for &t in &loc.tags {
                if let Some(tag) = src.tags.all.get(&t) {
                    source_tags.insert(t, tag.clone());
                }
            }
            sources.push(loc);
        }
    }
    if sources.is_empty() {
        return Ok(CopyToMapResult {
            copied: 0,
            skipped: 0,
            target_name,
        });
    }

    let used_tags = |fresh: &[Location]| -> Vec<Tag> {
        let used: HashSet<u32> = fresh.iter().flat_map(|l| l.tags.iter().copied()).collect();
        used.iter()
            .filter_map(|id| source_tags.get(id).cloned())
            .collect()
    };

    if mgr.stores.contains_key(&target_map_id) {
        // Target open in some window: insert through the import path (reconcile,
        // id alloc, counts, field defs, undo, render cells) and emit the resulting
        // MutationResult. The receiving window applies it via the same mutate() flow
        // as a local edit — including the save — so we do NOT persist here.
        let target = mgr.store_for_map(&target_map_id)?;
        let t_scan = Instant::now();
        let existing = target.collect(&Selector::Everything);
        let (fresh, skipped) = split_new_locations(sources, &existing);
        let scan_ms = t_scan.elapsed().as_millis();
        let copied = fresh.len() as u32;
        if copied > 0 {
            let tags = used_tags(&fresh);
            let t_add = Instant::now();
            let result = import::add_copied_to_store(target, fresh, tags)?;
            // The receiving window's autosave must flush the bumped counts even when no
            // new tag was created.
            target.tags.all.touch();
            log::debug!(
                "[cmd] copy_to_map open-target scan={}ms add={}ms total={}ms",
                scan_ms,
                t_add.elapsed().as_millis(),
                _t.elapsed().as_millis()
            );
            crate::emit_event(ExternalMutation {
                result,
                map_id: target_map_id.clone(),
            });
        }
        return Ok(CopyToMapResult {
            copied,
            skipped,
            target_name,
        });
    }

    // Target closed: append to the uncommitted delta sidecar (what autosave writes).
    let t_read = Instant::now();
    let existing = read_full_state_from_disk(&target_map_id)?;
    let read_ms = t_read.elapsed().as_millis();
    let (mut fresh, skipped) = split_new_locations(sources, &existing);
    let copied = fresh.len() as u32;
    if copied > 0 {
        let mut target_tags = read_tags_json(&conn, &target_map_id);
        let mut next_tag = target_tags.keys().max().copied().unwrap_or(0) + 1;
        let (remap, _) =
            reconcile_tags_by_name(&used_tags(&fresh), &mut target_tags, &mut next_tag);
        for loc in &mut fresh {
            loc.tags = loc
                .tags
                .iter()
                .filter_map(|t| remap.get(t).copied())
                .collect();
        }

        // Register any extra-field defs the copies introduce. `persist_field_defs`
        // skips keys the target already defines, so an empty known-set is safe.
        {
            let extras: Vec<&RawExtra> = fresh.iter().filter_map(|l| l.extra.as_ref()).collect();
            if let Some(defs) = maps::auto_register_field_defs(|_| false, &extras) {
                maps::persist_field_defs(&conn, &target_map_id, &defs)?;
            }
        }

        let t_hist = Instant::now();
        let (undo, redo) = load_edit_history(&target_map_id)?;
        let hist_ms = t_hist.elapsed().as_millis();
        let base_max = existing.iter().map(|l| l.id).max().unwrap_or(0);
        let next = seed_next_id(base_max, &[], &undo, &redo);
        for (loc, id) in fresh.iter_mut().zip(next..) {
            loc.id = id;
        }
        let t_save = Instant::now();
        let delta_path = storage::arrow_delta_path(&target_map_id)?;
        let mut delta: Overlay = if delta_path.exists() {
            rmp_serde::from_slice(&fs::read(&delta_path)?)?
        } else {
            Overlay::default()
        };
        delta.adds.extend(fresh);
        let bytes = rmp_serde::to_vec_named(&delta)?;
        let alive = existing.len() + copied as usize;
        persist_dirty(
            &target_map_id,
            Some(bytes),
            alive,
            Some(serialize_tags_json(&target_tags)),
        )?;
        log::debug!("[cmd] copy_to_map closed-target read={}ms history={}ms save={}ms total={}ms",
            read_ms, hist_ms, t_save.elapsed().as_millis(), _t.elapsed().as_millis());
    }
    Ok(CopyToMapResult {
        copied,
        skipped,
        target_name,
    })
}

/// Autosave uncommitted changes to the delta sidecar. No-op when nothing changed.
// Does NOT bake the overlay (store_commit does). `overlay.dirty` is cleared only after the
// write lands and only if the overlay wasn't mutated in flight (rev guard), so a failed or
// raced save keeps the data flagged for the next attempt.
#[tauri::command]
#[specta::specta]
pub async fn store_save_dirty(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<SaveResult> {
    let _t = Instant::now();
    log::debug!("[cmd] store_save_dirty ENTER");
    // Each snapshot carries the revision it serialized, so the store can be told exactly
    // what disk holds once the write lands, however many edits arrived meanwhile.
    let (map_id, delta, alive, tags) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_window(&label.0)?;
        let map_id = store.map_id.clone().ok_or("no map open")?;
        if !store.overlay.is_unsaved() && !store.tags.all.is_unsaved() {
            return Ok(SaveResult { saved_bytes: 0 });
        }
        let delta = store
            .overlay
            .is_unsaved()
            .then(|| overlay_delta_bytes(&store.overlay).map(|b| store.overlay.stamp(b)))
            .transpose()?;
        let tags = store
            .tags
            .all
            .is_unsaved()
            .then(|| store.tags.all.stamp(serialize_tags_json(&store.tags.all)));
        (map_id, delta, store.alive_count, tags)
    };

    let size = delta.as_ref().map_or(0, |d| d.value().len());
    let delta_rev = delta.as_ref().map(At::rev);
    let tags_rev = tags.as_ref().map(At::rev);
    let map_id2 = map_id.clone();
    task::spawn_blocking(move || {
        persist_dirty(
            &map_id2,
            delta.map(At::into_value),
            alive,
            tags.map(At::into_value),
        )
    })
    .await
    .unwrap_or_else(|e| Err(e.into()))?;

    // The window may have closed or switched maps during the write; the map_id check
    // stops a fresh store from being marked saved by a stale write.
    let mut mgr = state.lock()?;
    if let Ok(store) = mgr.store_for_window(&label.0) {
        if store.map_id.as_deref() == Some(map_id.as_str()) {
            if let Some(rev) = delta_rev {
                store.overlay.saved_at(rev);
            }
            if let Some(rev) = tags_rev {
                store.tags.all.saved_at(rev);
            }
        }
    }

    log::debug!(
        "[cmd] store_save_dirty total={}ms size={}",
        _t.elapsed().as_millis(),
        size
    );
    Ok(SaveResult { saved_bytes: size })
}

/// Lightweight status query: location count, version, and dirty flag.
#[tauri::command]
#[specta::specta]
pub fn store_get_summary(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<SummaryResult> {
    let _t = Instant::now();
    with_store!(label, state, |store| {
        let count = store.alive_count;
        log::debug!(
            "[cmd] store_get_summary total={}ms alive_count={}",
            _t.elapsed().as_millis(),
            count
        );
        Ok(SummaryResult {
            location_count: count,
            version: store.version,
            dirty_count: usize::from(store.overlay.is_unsaved()),
        })
    })
}

/// Full render rebuild: single-pass over all alive locations, writes binary to a temp file.
/// Returns the file path for JS to fetch via `mma-buf://`. Only called on map open or full reset.
#[tauri::command]
#[specta::specta]
pub async fn store_fill_render_file(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    req: RenderRequest,
) -> AppResult<String> {
    let (buf, map_id_str) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_window(&label.0)?;
        store.render.arrow_style = req.marker_style == "arrow";
        if let Some(mc) = req.marker_color {
            store.render.marker_color = mc;
        }
        let mid = store.map_id.clone().unwrap_or_default();
        (build_cell_render_buffers(store, &req), mid)
    };
    let path = storage::temp_dir()?.join(format!("mma_render_{map_id_str}.bin"));
    task::spawn_blocking(move || {
        fs::write(&path, &buf)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await?
}

/// Resolve a deck.gl pick result (cell key + index within cell) to a location ID.
/// Called on marker click to map the GPU pick back to a logical location.
#[tauri::command]
#[specta::specta]
pub fn store_resolve_pick(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    cell: String,
    cell_index: u32,
) -> AppResult<Option<u32>> {
    with_store!(label, state, |store| {
        let ci = cell_idx_from_key(&cell).ok_or("invalid cell key")?;
        Ok(store.render.cells[ci as usize]
            .as_ref()
            .and_then(|cr| cr.id_order.get(cell_index as usize).copied()))
    })
}

/// Pop the undo stack and reverse the last edit. Pushes the entry onto the redo stack.
#[tauri::command]
#[specta::specta]
pub async fn store_undo(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<MutationResult> {
    with_store!(label, state, |store| {
        let _t = Instant::now();
        let entry = store.edits.undo.pop().ok_or("nothing to undo")?;
        log::debug!(
            "[UNDO] stack_depth={} created={} removed={}",
            store.edits.undo.len(),
            entry.created.len(),
            entry.removed.len()
        );
        let changes = store.apply_edit_reverse(&entry);
        log::debug!(
            "[UNDO] apply_edit={}ms changes: +{} ~{} -{}",
            _t.elapsed().as_millis(),
            changes.added.len(),
            changes.updated.len(),
            changes.removed.len()
        );
        store.edits.redo.push(entry);
        Ok(store.finish_mutation(&changes))
    })
}

/// Pop the redo stack and replay the edit forward. Pushes the entry back onto undo.
#[tauri::command]
#[specta::specta]
pub async fn store_redo(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<MutationResult> {
    with_store!(label, state, |store| {
        let _t = Instant::now();
        let entry = store.edits.redo.pop().ok_or("nothing to redo")?;
        log::debug!(
            "[REDO] stack_depth={} created={} removed={}",
            store.edits.redo.len(),
            entry.created.len(),
            entry.removed.len()
        );
        let changes = store.apply_edit_forward(&entry);
        log::debug!(
            "[REDO] apply_edit={}ms changes: +{} ~{} -{}",
            _t.elapsed().as_millis(),
            changes.added.len(),
            changes.updated.len(),
            changes.removed.len()
        );
        store.push_undo(entry);
        Ok(store.finish_mutation(&changes))
    })
}

/// The uncommitted changes since the last commit -- the same changeset `store_commit` will record.
// Derived from the overlay, not the undo stack: the stack is capped, and non-undoable edits
// (enrichment, field renames, plugin batches) bypass it while still being part of the commit.
#[tauri::command]
#[specta::specta]
pub fn store_commit_diff(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
) -> AppResult<(u32, u32, u32)> {
    with_store!(label, state, |store| { Ok(store.overlay_diff_counts()) })
}

/// Clear both undo and redo stacks. Called after a commit to start fresh.
#[tauri::command]
#[specta::specta]
pub fn store_reset_undo(label: WindowLabel, state: tauri::State<'_, StoreState>) -> AppResult<()> {
    with_store!(label, state, |store| {
        store.edits.undo.clear();
        store.edits.redo.clear();
        Ok(())
    })
}

/// Create tags by name. Deduplicates case-insensitively: if a tag with the same name
/// already exists, it is made visible instead of creating a duplicate.
///
/// `location_ids` assigns every resulting tag to those locations in the same mutation.
/// Doing both here is not a convenience: creating and assigning as two commands leaves the
/// tag visible at count 0 for the round trip in between, and makes the caller fetch every
/// location into JS just to append an id Rust already has.
#[tauri::command]
#[specta::specta]
pub fn store_create_tags(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    names: Vec<String>,
    selector: Selector,
) -> AppResult<MutationResult> {
    with_store!(label, state, |store| {
        let location_ids: Vec<u32> = {
            let view = store.loc_view();
            let resolved = selections::narrow(&view, &selector);
            selections::ids_within(&view, resolved.as_ref())
        };
        Ok(store.create_tags(&names, &location_ids))
    })
}

/// Persist tag ordering. `ordered_ids` specifies the desired order; each tag's
/// `order` field is set to its index in the list.
#[tauri::command]
#[specta::specta]
pub fn store_reorder_tags(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    ordered_ids: Vec<u32>,
) -> AppResult<MutationResult> {
    with_store!(label, state, |store| {
        for (i, &id) in ordered_ids.iter().enumerate() {
            if let Some(tag) = store.tags.all.edit().get_mut(&id) {
                tag.order = Some(i as u32);
            }
        }
        Ok(store.finish_mutation(&ChangeSet::default()))
    })
}

/// Replace all selections, resolve bitmasks against current data, and write a binary
/// patch file for JS to apply to the render overlay. Returns per-selection counts.
#[tauri::command]
#[specta::specta]
pub async fn store_sync_selections(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    sels: Vec<SelectionInput>,
) -> AppResult<SelectionSync> {
    let _t = Instant::now();
    let (counts, buf, selected_count, num_cells) = {
        let mut mgr = state.lock()?;
        let store = mgr.store_for_window(&label.0)?;

        // Faithful tree: real keys preserved so per-node counts come back keyed (incl. nested).
        let sels_full: Vec<Selection> = sels
            .iter()
            .map(|si| Selection {
                key: si.key.clone(),
                color: si.color,
                selector: si.selector.clone(),
            })
            .collect();

        // 1. Resolve the whole forest in one pass: per-selection Roaring id-sets plus
        //    counts for every node (top-level and nested). Tag leaves hit the membership
        //    index; composites combine natively. (Geometric leaves still scan.)
        //    Counts cover ghosted selections too; the overlay uses the non-ghosted subset.
        let view = store.loc_view();
        let (sel_sets, counts) = selections::resolve_forest(&view, &sels_full);
        drop(view);

        // 2. Drop the ghosted ones once, here. Everything downstream reads `live`, so the
        //    selections and their member sets can never be filtered by two different rules.
        let live: Vec<ResolvedSelection> = pair_selections(sels_full, sel_sets)
            .into_iter()
            .zip(&sels)
            .filter(|(_, si)| !si.ghosted)
            .map(|(r, _)| r)
            .collect();

        let mut all_selected = RoaringBitmap::new();
        for r in &live {
            all_selected |= &r.set;
        }
        let selected_count = all_selected.len() as usize;

        // 3. Route selections to per-cell indices (O(selected), not O(S*N)), then
        //    serialize the per-cell bitmask binary.
        let render_total = store.render.total_len();
        let (buf, num_cells) = build_selection_buf(&store.render, &live);

        store.selections.ids = all_selected;
        store.selections.resolved = live;
        store.selections.node_counts = counts.clone();
        store.selections.version += 1;

        log::debug!("[cmd] store_sync_selections total={}ms sels={} selected={} cells={} buf_size={} batch_rows={} overlay_adds={} dead={} alive={} render_total={} first_set_len={} counts={:?}",
            _t.elapsed().as_millis(), sels.len(), selected_count, num_cells, buf.len(),
            store.batch.as_ref().map_or(0, RecordBatch::num_rows), store.overlay.adds.len(),
            store.overlay.dead.len(), store.alive_count, render_total,
            store.selections.resolved.first().map_or(0, |r| r.set.len() as usize), counts);

        (counts, buf, selected_count, num_cells)
    };

    let bitmask = if num_cells > 0 { Some(buf) } else { None };
    Ok(SelectionSync {
        counts,
        bitmask,
        selected_count,
    })
}

/// Ids of every location the selector resolves to, ascending.
#[tauri::command]
#[specta::specta]
pub fn store_resolve(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
) -> AppResult<Vec<u32>> {
    selector_read!(label, state, selector, |view, set| selections::ids_within(
        &view, set
    ))
}

/// How many locations the selector resolves to. Counts rows, never materializes them.
#[tauri::command]
#[specta::specta]
pub fn store_count(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
) -> AppResult<u32> {
    selector_read!(
        label,
        state,
        selector,
        |view, set| selections::count_within(&view, set)
    )
}

/// `n` ids drawn uniformly at random from the selected set, without replacement.
#[tauri::command]
#[specta::specta]
pub fn store_sample(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    n: u32,
) -> AppResult<Vec<u32>> {
    selector_read!(label, state, selector, |view, set| selections::sample(
        selections::ids_within(&view, set),
        n as usize
    ))
}

/// An evenly spaced subset: exactly one of `target_count` (thin to N, maximizing
/// spacing) or `min_distance_m` (keep as many as fit at that spacing).
#[tauri::command]
#[specta::specta]
pub fn store_spaced(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    target_count: Option<u32>,
    min_distance_m: Option<u32>,
) -> AppResult<SpacedPickResult> {
    selector_read!(label, state, selector, store: |store, set| store.pick_spaced(
        set,
        target_count,
        min_distance_m
    )?)
}

/// Group by a derived key, returning `{ key, ids, bin }` per group.
#[tauri::command]
#[specta::specta]
pub fn store_group_by(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    field: String,
    key: selections::KeySpec,
) -> AppResult<Vec<selections::PartitionBucket>> {
    selector_read!(label, state, selector, |view, set| selections::partition(
        &view, &field, &key, set
    ))
}

/// Group by a derived key, returning counts only -- no member ids on the wire.
#[tauri::command]
#[specta::specta]
pub fn store_count_by(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    field: String,
    key: selections::KeySpec,
) -> AppResult<Vec<(String, u32)>> {
    selector_read!(label, state, selector, |view, set| selections::count_by(
        &view, &field, &key, set
    ))
}

/// Distinct values of `field` across the selected set, sorted.
#[tauri::command]
#[specta::specta]
pub fn store_values(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    field: String,
) -> AppResult<Vec<String>> {
    selector_read!(label, state, selector, |view, set| {
        selections::distinct_values(&view, &field, set)
    })
}

/// How many rows hold a value for each field, key-sorted: `extra` keys and the built-in
/// columns a row can lack.
#[tauri::command]
#[specta::specta]
pub fn store_coverage(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
) -> AppResult<Vec<(String, u32)>> {
    selector_read!(label, state, selector, |view, set| {
        selections::coverage(&view, set)
    })
}

/// Per-field columns of the selected set. One value per row per field, `null` where a
/// row lacks it; `"tags"` is a column of tag-id arrays.
#[derive(serde::Serialize, specta::Type)]
#[serde(transparent)]
pub struct Columns(
    #[specta(type = Vec<Vec<specta_typescript::Unknown>>)] pub Vec<Vec<serde_json::Value>>,
);

/// Values, never rows: the projection for a scan that reads fields across a set.
#[tauri::command]
#[specta::specta]
pub fn store_columns(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    fields: Vec<String>,
) -> AppResult<Columns> {
    selector_read!(label, state, selector, |view, set| {
        Columns(selections::columns_within(&view, set, &fields))
    })
}

/// Bounding box `[west, south, east, north]`, or `None` when the set is empty.
#[tauri::command]
#[specta::specta]
pub fn store_bounds(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
) -> AppResult<Option<[f64; 4]>> {
    // The whole-map box is maintained incrementally; narrower ones scan.
    selector_read!(label, state, selector, store: |store, set| match set {
        None => store.cached_bounds(),
        Some(set) => store.compute_bounds(Some(set)),
    })
}

/// Full rows. The last resort -- prefer a projection. Every row is materialized in
/// webview memory, so an `Everything` call costs O(map). Large answers are staged to a file
/// rather than pushed through the IPC channel.
#[tauri::command]
#[specta::specta]
pub fn store_collect(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
) -> AppResult<Rows> {
    with_store!(label, state, |store| {
        let locations = store.collect(&selector);
        if locations.len() <= ROWS_INLINE_MAX {
            return Ok(Rows::Inline { locations });
        }
        let map_id_str = store.map_id.as_deref().unwrap_or("default");
        let path = rows_file_path(&storage::temp_dir()?, map_id_str);
        fs::write(&path, serde_json::to_vec(&locations)?)?;
        Ok(Rows::File {
            path: path.to_string_lossy().into_owned(),
        })
    })
}

/// Transitive spatial duplicate groups (connected components, size >= 2) within `distance`
/// metres. Read-only; used to preview a merge. Returns groups of location IDs.
#[tauri::command]
#[specta::specta]
pub fn store_duplicate_groups(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    distance: f64,
) -> AppResult<Vec<Vec<u32>>> {
    with_store!(label, state, |store| {
        let view = store.loc_view();
        Ok(selections::find_duplicate_groups(&view, distance))
    })
}

/// Merge each duplicate group within `distance` metres into one survivor location, unioning
/// tags and extra fields. `score` is the map's duplicate preference expression; blank or
/// absent uses [`selections::DEFAULT_DUPLICATE_SCORE`]. One undoable edit.
// Extra merges survivor-wins.
#[tauri::command]
#[specta::specta]
pub async fn store_merge_duplicates(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    distance: f64,
    score: Option<String>,
) -> AppResult<MutationResult> {
    let _t = Instant::now();
    let score = selections::parse_duplicate_score(score.as_deref())?;
    with_store!(label, state, |store| {
        let groups = {
            let view = store.loc_view();
            selections::find_duplicate_groups(&view, distance)
        };

        let mut remove: Vec<Location> = Vec::new();
        let mut create: Vec<Location> = Vec::new();

        for group in &groups {
            let members: Vec<Location> = group
                .iter()
                .filter_map(|&id| store.get_loc_by_id(id))
                .collect();
            if members.len() < 2 {
                continue;
            }
            create.push(merge_group(&members, &score));
            for m in members {
                remove.push(m);
            }
        }

        log::debug!(
            "[cmd] store_merge_duplicates groups={} merged_away={} total={}ms",
            create.len(),
            remove.len().saturating_sub(create.len()),
            _t.elapsed().as_millis()
        );
        Ok(store.apply_undoable(remove, create))
    })
}

/// Thin duplicates among `ids` within `distance` metres, keeping the best location per
/// cluster. `score` is the map's duplicate preference expression, the same one a merge
/// ranks by. Informational locations are never pruned. One undoable edit.
// <= 25m: best-scored per cluster; > 25m: greedy thinning so no two survivors remain in
// range.
#[tauri::command]
#[specta::specta]
pub async fn store_prune_duplicates(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    selector: Selector,
    distance: f64,
    score: Option<String>,
) -> AppResult<MutationResult> {
    let _t = Instant::now();
    let score = selections::parse_duplicate_score(score.as_deref())?;
    with_store!(label, state, |store| {
        let locs: Vec<Location> = store.collect(&selector);
        let prune_ids: HashSet<u32> = selections::prune_duplicates(&locs, distance, &score)
            .into_iter()
            .collect();
        let total = locs.len();
        let remove: Vec<Location> = locs
            .into_iter()
            .filter(|l| prune_ids.contains(&l.id))
            .collect();

        log::debug!(
            "[cmd] store_prune_duplicates pruned={} of {} total={}ms",
            remove.len(),
            total,
            _t.elapsed().as_millis()
        );
        Ok(store.apply_undoable(remove, Vec::new()))
    })
}

/// Find all locations within `radius_m` metres of (`lat`, `lng`).
// Lazy spatial index: O(cells in radius) per query after a one-time O(N) build, maintained
// incrementally. Called on every marker click (duplicate check), so it must not scan.
#[tauri::command]
#[specta::specta]
pub fn store_find_nearby(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    lat: f64,
    lng: f64,
    radius_m: f64,
) -> AppResult<Vec<Location>> {
    with_store!(label, state, |store| {
        let _t = Instant::now();
        let mut ids = store.find_nearby_ids(lat, lng, radius_m);
        ids.sort_unstable();
        let result: Vec<Location> = ids
            .iter()
            .filter_map(|&id| store.get_loc_by_id(id))
            .collect();
        log::debug!(
            "[cmd] store_find_nearby r={}m hits={} total={}ms",
            radius_m,
            result.len(),
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}

/// For each input point, whether any existing location lies within `radius_m` metres.
/// Bulk form so callers probing many coordinates (e.g. the map generator skipping
/// already-covered spots) pay one IPC round-trip, not one per point.
#[tauri::command]
#[specta::specta]
pub fn store_near_any(
    label: WindowLabel,
    state: tauri::State<'_, StoreState>,
    lats: Vec<f64>,
    lngs: Vec<f64>,
    radius_m: f64,
) -> AppResult<Vec<bool>> {
    if lats.len() != lngs.len() {
        return Err(AppError::from("store_near_any: lats/lngs length mismatch"));
    }
    with_store!(label, state, |store| {
        let _t = Instant::now();
        let result: Vec<bool> = lats
            .iter()
            .zip(lngs.iter())
            .map(|(&la, &ln)| store.any_within(la, ln, radius_m))
            .collect();
        log::debug!(
            "[cmd] store_near_any n={} r={}m total={}ms",
            result.len(),
            radius_m,
            _t.elapsed().as_millis()
        );
        Ok(result)
    })
}
