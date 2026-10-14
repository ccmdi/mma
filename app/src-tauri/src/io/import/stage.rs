//! Preview and stage editor imports, then apply them to the open map on confirmation.

use super::*;
use crate::store::engine;
use crate::store::engine::with_store;
use crate::store::engine::ValueRecord;
use crate::store::engine::WindowLabel;
use crate::types::{AppResult, Location, LocationFlags, RawExtra};
use mma_algebra::{Id, Op, Patch};
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
    /// The id the first staged location was given; the rest follow it in order.
    pub first_id: Option<Id<Location>>,
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

/// Stage rows and tag records in this window's import layer.
/// Confirm applies them to the map; cancel discards them.
pub(super) fn stage_parsed(
    store: &mut engine::Store,
    window: &str,
    parsed: ParsedMap,
) -> Option<Id<Location>> {
    let key = import_layer(window);
    store.close_layer(&key);
    let edits = parsed.locations.into_iter().map(Op::Add).collect();
    let result = store.edit(&import_target(window), edits, &mut None);
    if let Some(p) = store.pending.get_mut(&key) {
        p.incoming.insert(
            "tags".to_string(),
            parsed.tags.into_iter().map(|t| (t.id, t)).collect(),
        );
    }
    result.keys.first().copied()
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
        will_auto_commit: n > engine::MAX_UNDO_LOCATIONS,
        first_id: None,
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
        Ok::<_, crate::types::AppError>((parsed, preview))
    })
    .await??;
    with_store!(label, state, |store| {
        preview.first_id = stage_parsed(store, &label.0, parsed);
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
        Ok::<_, crate::types::AppError>((parsed, preview))
    })
    .await??;
    with_store!(label, state, |store| {
        preview.first_id = stage_parsed(store, &label.0, parsed);
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
    /// True when the import was large enough to autocommit; the caller commits it.
    pub auto_commit: bool,
}

/// Copy pre-deduplicated locations through the import path, with tag reconciliation and undo.
pub(crate) fn add_copied_to_store(
    store: &mut engine::Store,
    locations: Vec<Location>,
    tags: Vec<ValueRecord>,
) -> AppResult<engine::Mutation> {
    const LAYER: &str = "copy-to-map";
    store.close_layer(LAYER);
    store
        .pending
        .entry(LAYER.to_string())
        .or_default()
        .incoming
        .insert(
            "tags".to_string(),
            tags.into_iter().map(|t| (t.id, t)).collect(),
        );
    let edits = locations.into_iter().map(Op::Add).collect();
    let target = engine::Target::Pending {
        name: LAYER.to_string(),
    };
    let staged = store.edit(&target, edits, &mut None);
    Ok(engine::Mutation {
        keys: staged.keys,
        ..store.land(LAYER, &mut None)
    })
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
    let target = import_target(&label.0);
    let key = import_layer(&label.0);
    let drop_set: HashSet<&str> = dropped_fields.iter().map(String::as_str).collect();

    with_store!(label, state, |store| {
        if !store.pending.contains_key(&key) {
            return Err("no staged import - call store_import_preview first".into());
        }
        let rows = store.collect(&target, &crate::selections::Selector::Everything);

        let bulk = if drop_set.contains("tags") {
            Vec::new()
        } else {
            bulk_tag_ids(store, &key, &tag_names)
        };
        let mut edits: Vec<mma_algebra::Edit<Location>> = Vec::new();
        for loc in &rows {
            let mut patch = Patch::<Location>::default();
            patch.id = loc.id;
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
            let mut tags = if drop_set.contains("tags") {
                Some(Vec::new())
            } else {
                None
            };
            if !bulk.is_empty() {
                let mut next = loc.tags.clone();
                for b in bulk.iter().copied() {
                    if !next.contains(&b) {
                        next.push(b);
                    }
                }
                tags = Some(next);
            }
            patch.tags = tags;
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
            edits.push(mma_algebra::Op::Put(patch));
        }
        if drop_set.contains("tags") {
            if let Some(p) = store.pending.get_mut(&key) {
                p.incoming.remove("tags");
            }
        }

        let imported_count = rows.len() as u32;
        let auto_commit = rows.len() > engine::MAX_UNDO_LOCATIONS;
        store.edit(&target, edits, &mut None);
        let mutation = store.land(&key, &mut None);
        log::debug!(
            "[import] total={:.0}ms locs={}",
            t0.elapsed().as_millis(),
            imported_count
        );
        Ok(EditorImportResult {
            imported_count,
            auto_commit,
            mutation,
        })
    })
}

/// Create tag records in the import layer and return their provisional ids.
pub(super) fn bulk_tag_ids(
    store: &mut engine::Store,
    key: &str,
    names: &[String],
) -> Vec<Id<ValueRecord>> {
    let Some(p) = store.pending.get_mut(key) else {
        return Vec::new();
    };
    let records = p.incoming.entry("tags".to_string()).or_default();
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
