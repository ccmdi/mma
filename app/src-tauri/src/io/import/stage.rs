//! Preview and stage editor imports, then apply them to the open map on confirmation.

use super::*;
use crate::selections::Selector;
use crate::store::engine;
use crate::store::engine::with_store;
use crate::store::engine::ValueRecord;
use crate::store::engine::WindowLabel;
use crate::types::{AppError, AppResult, Location, LocationFlags};
use crate::util;
use mma_algebra::{Id, IdRange, Op, Patch};
use serde_json::Value;
use std::collections::HashMap;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::Instant;
use tokio::task;

/// Field presence count for the editor import preview dialog, letting
/// the user see which optional fields exist and decide which to keep/drop.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FieldCount {
    pub key: String,
    pub count: u32,
}

/// Preview data for importing a file into the currently open map.
/// Unlike bulk import, this shows per-field counts so the user can
/// selectively drop fields (heading, panoId, etc.) before importing.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EditorImportPreview {
    pub location_count: u32,
    /// Tag records from the file, shown in the preview before map-local ids are assigned.
    #[specta(type = Vec<HashMap<String, specta_typescript::Unknown>>)]
    pub tags: Vec<ValueRecord>,
    pub fields: Vec<FieldCount>,
    pub warnings: Vec<String>,
    /// Temp-file path to preview positions: interleaved LE f32 `[lng, lat]` pairs.
    pub preview_positions_path: String,
    /// `[west, south, east, north]` bounding box of the import, for map auto-focus.
    pub bounds: Option<[f64; 4]>,
    /// True when this import is too large to undo and will be committed automatically.
    pub will_auto_commit: bool,
    /// The pending layer the staged locations are read through until the import lands.
    pub target: engine::Target,
    /// The ids the staged locations were given, in the order the file lists them.
    pub keys: IdRange<Location>,
    /// Map settings carried by the import (`extra.settings`).
    #[specta(type = HashMap<String, specta_typescript::Any>)]
    pub settings: serde_json::Map<String, Value>,
}

/// The pending layer holding `window`'s staged import.
pub(crate) fn import_target(window: &str) -> engine::Target {
    engine::Target::Pending {
        name: import_layer(window),
    }
}

pub(super) fn import_layer(window: &str) -> String {
    format!("import:{window}")
}

/// Stage rows and tag records in this window's import layer, replacing any import it held.
/// Confirm applies them to the map; cancel discards them.
pub(super) fn stage_parsed(
    store: &mut engine::Store,
    window: &str,
    parsed: ParsedMap,
) -> IdRange<Location> {
    store.close_layer(&import_layer(window));
    let run = store.next_id.take_run(parsed.locations.len() as u32);
    let now = util::now_unix();
    let edits = parsed
        .locations
        .into_iter()
        .zip(run.iter())
        .map(|(row, id)| {
            Op::Set(Location {
                id,
                ..row.created(now)
            })
        })
        .collect();
    let records = engine::IncomingRecords::from([(
        "tags".to_string(),
        parsed.tags.into_iter().map(|t| (t.id, t)).collect(),
    )]);
    store
        .at(&import_target(window))
        .edit(edits, records, &mut None);
    run
}

/// Build preview field counts, bounds, and a temp file of interleaved LE f32 `[lng, lat]` positions.
pub(super) fn build_preview(parsed: &ParsedMap, window: &str) -> AppResult<EditorImportPreview> {
    let n = parsed.locations.len();
    let (mut h, mut p, mut z, mut pano_c, mut tag_c) = (0u32, 0u32, 0u32, 0u32, 0u32);
    let mut extra_counts: HashMap<String, u32> = HashMap::new();
    let mut pos_buf: Vec<u8> = Vec::with_capacity(n * 8);
    let (mut west, mut south, mut east, mut north) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);

    for loc in &parsed.locations {
        if loc.heading != 0.0 {
            h += 1;
        }
        if loc.pitch != 0.0 {
            p += 1;
        }
        if loc.zoom != 0.0 {
            z += 1;
        }
        if loc.pano_id.is_some() {
            pano_c += 1;
        }
        if !loc.tags.is_empty() {
            tag_c += 1;
        }
        if let Some(extra) = &loc.extra {
            // Byte key-scan (no per-loc map alloc); only allocate a String the first
            // time each distinct key is seen.
            extra.for_each_field(|k, _| {
                if let Some(c) = extra_counts.get_mut(k) {
                    *c += 1;
                } else {
                    extra_counts.insert(k.to_owned(), 1);
                }
            });
        }
        pos_buf.extend_from_slice(&(loc.lng as f32).to_le_bytes());
        pos_buf.extend_from_slice(&(loc.lat as f32).to_le_bytes());
        if loc.lng < west {
            west = loc.lng;
        }
        if loc.lat < south {
            south = loc.lat;
        }
        if loc.lng > east {
            east = loc.lng;
        }
        if loc.lat > north {
            north = loc.lat;
        }
    }

    let mut fields: Vec<FieldCount> = Vec::with_capacity(5 + extra_counts.len());
    for (key, count) in [
        ("heading", h),
        ("pitch", p),
        ("zoom", z),
        ("panoId", pano_c),
        ("tags", tag_c),
    ] {
        if count > 0 {
            fields.push(FieldCount {
                key: key.into(),
                count,
            });
        }
    }
    for (key, count) in extra_counts {
        fields.push(FieldCount {
            key: format!("extra.{key}"),
            count,
        });
    }

    let path = preview_positions_path(window);
    fs::write(&path, &pos_buf)?;

    let preview = EditorImportPreview {
        location_count: n as u32,
        tags: parsed.tags.clone(),
        fields,
        warnings: parsed.warnings.clone(),
        preview_positions_path: path.to_string_lossy().into_owned(),
        bounds: if n == 0 {
            None
        } else {
            Some([west, south, east, north])
        },
        will_auto_commit: engine::too_large_to_undo(n),
        target: import_target(window),
        keys: IdRange::default(),
        settings: parsed.settings.clone(),
    };
    Ok(preview)
}

pub(super) fn preview_positions_path(window: &str) -> PathBuf {
    let file_label: String = window
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    env::temp_dir().join(format!("mma_import_preview_{file_label}.bin"))
}

/// Discard the staged import without importing it.
#[tauri::command]
#[specta::specta]
pub fn store_import_cancel(
    label: WindowLabel,
    state: tauri::State<'_, engine::StoreState>,
) -> AppResult<()> {
    let _ = fs::remove_file(preview_positions_path(&label.0));
    with_store!(label, state, |store| {
        store.close_layer(&import_layer(&label.0));
        Ok(())
    })
}

/// Parse a file and return field-level statistics and preview positions for the
/// editor import dialog. Call `storeImportFile` to commit the import.
#[tauri::command]
#[specta::specta]
pub async fn store_import_preview(
    label: WindowLabel,
    state: tauri::State<'_, engine::StoreState>,
    path: String,
) -> AppResult<EditorImportPreview> {
    // CPU-bound parse runs on a blocking thread so it never stalls the main/event-loop
    // thread (which the webview shares - a sync command here freezes the window).
    let window = label.0.clone();
    let (parsed, mut preview) = task::spawn_blocking(move || {
        let t0 = Instant::now();
        let mut buf = read_sequential(&path)?;
        let t_read = t0.elapsed();
        let parsed = parse_file(&mut buf);
        let t_parse = t0.elapsed();
        let preview = build_preview(&parsed, &window)?;
        log::debug!(
            "[import-preview] read={:.0}ms parse={:.0}ms build={:.0}ms locs={}",
            t_read.as_millis(),
            (t_parse - t_read).as_millis(),
            (t0.elapsed() - t_parse).as_millis(),
            preview.location_count
        );
        Ok::<_, AppError>((parsed, preview))
    })
    .await??;
    with_store!(label, state, |store| {
        preview.keys = stage_parsed(store, &label.0, parsed);
        Ok(preview)
    })
}

/// Parse pasted text (JSON or CSV) and stage it for preview. Works like
/// `storeImportPreview` but reads from a string instead of a file.
#[tauri::command]
#[specta::specta]
pub async fn store_import_paste_preview(
    label: WindowLabel,
    state: tauri::State<'_, engine::StoreState>,
    text: String,
) -> AppResult<EditorImportPreview> {
    let window = label.0.clone();
    let (parsed, mut preview) = task::spawn_blocking(move || {
        let t0 = Instant::now();
        let mut buf = text.into_bytes();
        let parsed = parse_file(&mut buf);
        if parsed.locations.is_empty() {
            return Err("no locations found".into());
        }
        log::debug!(
            "[paste-preview] parse={:.0}ms locs={}",
            t0.elapsed().as_millis(),
            parsed.locations.len()
        );
        let preview = build_preview(&parsed, &window)?;
        Ok::<_, AppError>((parsed, preview))
    })
    .await??;
    with_store!(label, state, |store| {
        preview.keys = stage_parsed(store, &label.0, parsed);
        Ok(preview)
    })
}

/// Combined result of an editor import: the mutation it made
/// plus import-specific metadata.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EditorImportResult {
    pub mutation: engine::Mutation,
    pub imported_count: u32,
    /// True when the import was too large to undo; the caller commits it.
    pub auto_commit: bool,
}

/// Commit a previously previewed editor import into the open map, optionally
/// dropping fields in `droppedFields` (e.g. `"heading"`, `"extra.countryCode"`)
/// and/or applying each of `tagNames` to every imported location.
// `async` so the insert + render-buffer registration runs off the main (event-loop)
// thread; as a sync command it froze the webview for the duration of the import insert.
#[tauri::command]
#[specta::specta]
pub async fn store_import_file(
    label: WindowLabel,
    state: tauri::State<'_, engine::StoreState>,
    dropped_fields: Vec<String>,
    tag_names: Vec<String>,
) -> AppResult<EditorImportResult> {
    let t0 = Instant::now();
    let _ = fs::remove_file(preview_positions_path(&label.0));
    let result = with_store!(label, state, |store| {
        confirm_staged(store, &label.0, &dropped_fields, &tag_names)
    });
    log::debug!("[import] total={:.0}ms", t0.elapsed().as_millis());
    result
}

/// Land `window`'s staged import with `dropped` fields cleared and every name in `tag_names`
/// applied to each imported location.
pub(super) fn confirm_staged(
    store: &mut engine::Store,
    window: &str,
    dropped: &[String],
    tag_names: &[String],
) -> AppResult<EditorImportResult> {
    let target = import_target(window);
    let key = import_layer(window);
    let drop_set: HashSet<&str> = dropped.iter().map(String::as_str).collect();
    if !store.pending.contains_key(&key) {
        return Err("no staged import - call store_import_preview first".into());
    }
    let rows = store.at(&target).rows(&Selector::Everything);

    let mut records = engine::IncomingRecords::new();
    let drop_tags = drop_set.contains("tags");
    let mut tags = if drop_tags {
        HashMap::new()
    } else {
        store.held_records(&key, "tags")
    };
    let bulk = bulk_tag_ids(&mut tags, tag_names);
    records.insert("tags".to_string(), tags);
    let mut edits: Vec<mma_algebra::Edit<Location>> = Vec::new();
    for loc in &rows {
        let mut patch = Patch::<Location>::default();
        if drop_set.contains("heading") {
            patch.heading = Some(0.0);
        }
        if drop_set.contains("pitch") {
            patch.pitch = Some(0.0);
        }
        if drop_set.contains("zoom") {
            patch.zoom = Some(0.0);
        }
        if drop_set.contains("panoId") {
            patch.pano_id = mma_algebra::Field::Clear;
            let mut flags = loc.flags;
            flags.remove(LocationFlags::LOAD_AS_PANO_ID);
            patch.flags = Some(flags);
        }
        if drop_tags || !bulk.is_empty() {
            let mut next = if drop_tags {
                Vec::new()
            } else {
                loc.tags.clone()
            };
            for b in bulk.iter().copied() {
                if !next.contains(&b) {
                    next.push(b);
                }
            }
            patch.tags = Some(next);
        }
        if !drop_set.is_empty() {
            if let Some(extra) = &loc.extra {
                let dropped: serde_json::Map<String, Value> = extra
                    .to_map()
                    .keys()
                    .filter(|k| drop_set.contains(format!("extra.{k}").as_str()))
                    .map(|k| (k.clone(), Value::Null))
                    .collect();
                if !dropped.is_empty() {
                    patch.extra = mma_algebra::Field::Set(mma_algebra::JsonWrite::Merge(
                        Value::Object(dropped),
                    ));
                }
            }
        }
        if patch != Patch::<Location>::default() {
            patch.id = loc.id;
            edits.push(Op::Put(patch));
        }
    }

    store.at(&target).edit(edits, records, &mut None);
    let mutation = store.land(&key, &mut None);
    Ok(EditorImportResult {
        imported_count: rows.len() as u32,
        auto_commit: mutation.history_cleared,
        mutation,
    })
}

/// Add a record to `records` for each of `names` it lacks, matching names regardless of case,
/// and return the ids of all of them.
pub(super) fn bulk_tag_ids(
    records: &mut HashMap<Id<ValueRecord>, ValueRecord>,
    names: &[String],
) -> Vec<Id<ValueRecord>> {
    let seeds = names.iter().filter_map(|name| {
        engine::named(Op::Add(ValueRecord {
            name: Some(name.clone()),
            ..Default::default()
        }))
        .ok()
    });
    let landed = mma_algebra::apply(records, seeds, Id::default());
    let mut ids = Vec::new();
    for id in landed.keys {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}
