//! Editor import: preview a parsed file, stage its rows as virtual locations, then add them to the open store.

use super::*;
use crate::store::engine;
use crate::store::engine::with_store;
use crate::store::engine::WindowLabel;
use crate::store::maps;
use crate::types::AppResult;
use crate::types::RawExtra;
use crate::types::{Location, LocationFlags, Tag};
use crate::util::color_for_name;
use serde_json::Value;
use std::collections::HashMap;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::mem;
use std::sync::Mutex;
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
    pub tags: Vec<Tag>,
    pub fields: Vec<FieldCount>,
    pub warnings: Vec<String>,
    /// Temp-file path to preview positions: interleaved LE f32 `[lng, lat]` pairs.
    pub preview_positions_path: String,
    /// `[west, south, east, north]` bounding box of the import, for map auto-focus.
    pub bounds: Option<[f64; 4]>,
    /// True when this import exceeds `IMPORT_AUTOCOMMIT_THRESHOLD` and will be
    /// committed automatically (not undoable). Drives the import warning modal.
    pub will_auto_commit: bool,
}

/// Write interleaved LE f32 `[lng, lat]` for every location to a temp file.
/// Build preview stats from a parsed map and cache the parse for commit.
/// Single pass: field counts, positions buffer, and bounds are computed together.
pub(super) fn build_preview(parsed: ParsedMap) -> AppResult<EditorImportPreview> {
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

    let path = env::temp_dir().join("mma_import_preview.bin");
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
        will_auto_commit: n > IMPORT_AUTOCOMMIT_THRESHOLD,
    };

    *EDITOR_IMPORT_CACHE.lock().unwrap() = Some(parsed);
    Ok(preview)
}

pub(super) static EDITOR_IMPORT_CACHE: Mutex<Option<ParsedMap>> = Mutex::new(None);

/// Fetch one staged (not yet imported) location by its preview index, for read-only
/// preview in the editor. Indexes follow the preview positions order.
#[tauri::command]
#[specta::specta]
pub fn store_import_staged_location(index: u32) -> AppResult<Location> {
    let cache = EDITOR_IMPORT_CACHE.lock().unwrap();
    let parsed = cache.as_ref().ok_or("no staged import")?;
    parsed
        .locations
        .get(index as usize)
        .cloned()
        .ok_or_else(|| "staged index out of range".into())
}

/// Parse a file and return field-level statistics + preview positions for the editor
/// import sidebar. Caches the parse result for `store_import_file` to consume on commit.
#[tauri::command]
#[specta::specta]
pub async fn store_import_preview(path: String) -> AppResult<EditorImportPreview> {
    // CPU-bound parse runs on a blocking thread so it never stalls the main/event-loop
    // thread (which the webview shares — a sync command here freezes the window).
    task::spawn_blocking(move || {
        let t0 = Instant::now();
        let mut buf = read_sequential(&path)?;
        let t_read = t0.elapsed();
        let parsed = parse_file(&mut buf);
        let t_parse = t0.elapsed();
        let preview = build_preview(parsed)?;
        log::debug!(
            "[import-preview] read={:.0}ms parse={:.0}ms build={:.0}ms locs={}",
            t_read.as_millis(),
            (t_parse - t_read).as_millis(),
            (t0.elapsed() - t_parse).as_millis(),
            preview.location_count
        );
        Ok(preview)
    })
    .await?
}

/// Parse pasted text (JSON or CSV) and stage it for preview, exactly like
/// `store_import_preview` does for a file. Caches the parse for `store_import_file`.
#[tauri::command]
#[specta::specta]
pub async fn store_import_paste_preview(text: String) -> AppResult<EditorImportPreview> {
    task::spawn_blocking(move || {
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
        build_preview(parsed)
    })
    .await?
}

/// Combined result of an editor import: the mutation delta (for render pipeline)
/// plus import-specific metadata.
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EditorImportResult {
    #[serde(flatten)]
    pub mutation: engine::MutationResult,
    pub imported_count: u32,
    pub warnings: Vec<String>,
    /// True when the import was large enough to autocommit; the caller commits it.
    pub auto_commit: bool,
    /// Settings carried by the import (`extra.settings`)
    #[specta(type = HashMap<String, specta_typescript::Any>)]
    pub settings: serde_json::Map<String, Value>,
}

/// Insert pre-deduped copied locations (cross-map copy) through the same path
/// as editor import: tag reconcile, id alloc, counts, field defs, undo entry,
/// and render cell registration. `tags` are the source tag defs referenced by
/// `locations`.
pub(crate) fn add_copied_to_store(
    store: &mut engine::Store,
    locations: Vec<Location>,
    tags: Vec<Tag>,
) -> AppResult<engine::MutationResult> {
    let mut parsed = ParsedMap {
        locations,
        tags,
        ..Default::default()
    };
    add_parsed_to_store(store, &mut parsed, None)
}

/// Insert parsed locations into the open map's store via the overlay.
///
/// Imports up to `IMPORT_AUTOCOMMIT_THRESHOLD` get a single undo entry (reversible).
/// Larger imports skip the undo entry; the caller autocommits them instead, so the
/// baseline advances through the normal commit path rather than diverging silently.
///
/// Tag reconciliation, render cell registration, and extra-field auto-registration
/// happen regardless of size.
pub(super) fn add_parsed_to_store(
    store: &mut engine::Store,
    parsed: &mut ParsedMap,
    bulk_tag: Option<&str>,
) -> AppResult<engine::MutationResult> {
    let _t = Instant::now();
    let n = parsed.locations.len();
    let tag_id_remap = {
        let tags = &mut store.tags;
        let (remap, changed) =
            engine::reconcile_tags_by_name(&parsed.tags, &mut tags.all, &mut tags.next_id);
        if changed {
            tags.dirty = true;
        }
        remap
    };

    for loc in &mut parsed.locations {
        loc.id = store.alloc_id();
        loc.tags = loc
            .tags
            .iter()
            .filter_map(|&old| tag_id_remap.get(&old).copied())
            .collect();
    }
    let t_reconcile = _t.elapsed();

    // Find-or-create the bulk tag (case-insensitive) and apply it to every location.
    if let Some(name) = bulk_tag.map(str::trim).filter(|n| !n.is_empty()) {
        let tag_id = store
            .tags
            .all
            .values()
            .find(|t| t.name.eq_ignore_ascii_case(name))
            .map(|t| t.id)
            .unwrap_or_else(|| {
                let id = store.alloc_tag_id();
                store.tags.all.insert(
                    id,
                    Tag {
                        id,
                        name: name.to_string(),
                        color: color_for_name(name),
                        visible: true,
                        order: None,
                        doclinks: Vec::new(),
                    },
                );
                store.tags.dirty = true;
                id
            });
        for loc in &mut parsed.locations {
            if !loc.tags.contains(&tag_id) {
                loc.tags.push(tag_id);
            }
        }
    }

    store.add_tag_counts(&parsed.locations);
    let t_counts = _t.elapsed();

    // Discover new extra-field defs from the locations now, before we consume them.
    let new_field_defs = {
        let extras: Vec<&RawExtra> = parsed
            .locations
            .iter()
            .filter_map(|l| l.extra.as_ref())
            .collect();
        maps::auto_register_field_defs(&store.known_field_keys, &extras)
    };
    let t_autoreg = _t.elapsed();

    // Small imports keep a reversible undo entry (needs a copy of the locations). Large
    // imports autocommit and skip undo, so the locations are MOVED into the overlay
    // below instead of cloning each one.
    if parsed.locations.len() <= IMPORT_AUTOCOMMIT_THRESHOLD {
        store.push_undo(engine::EditEntry {
            created: parsed.locations.clone(),
            removed: Vec::new(),
        });
    }
    store.edits.redo.clear();

    let t_undo = _t.elapsed();

    for loc in mem::take(&mut parsed.locations) {
        let ci = engine::render_cell_idx(loc.lat, loc.lng);
        store.cell_add_render(ci, loc.id);
        store.overlay_add(vec![loc]);
    }
    let t_overlay = _t.elapsed();

    let new_field_defs = new_field_defs.map(|defs| engine::apply_field_defs(store, defs));
    let mut result = store.finish_mutation(&engine::ChangeSet {
        full_reset: true,
        ..Default::default()
    });
    result.tags = Some(store.tags.all.clone());
    result.new_field_defs = new_field_defs;
    log::debug!("[import-insert] n={n} reconcile+alloc={:.0}ms counts={:.0}ms auto_reg={:.0}ms undo={:.0}ms overlay_add={:.0}ms finish={:.0}ms total={:.0}ms",
        t_reconcile.as_millis(), (t_counts - t_reconcile).as_millis(), (t_autoreg - t_counts).as_millis(),
        (t_undo - t_autoreg).as_millis(), (t_overlay - t_undo).as_millis(), (_t.elapsed() - t_overlay).as_millis(), _t.elapsed().as_millis());
    Ok(result)
}

/// Commit a previously previewed editor import, optionally dropping fields and/or
/// applying a bulk tag to every imported location. Consumes the cached parse from
/// `store_import_preview`/`store_import_paste_preview`. Fields in `dropped_fields`
/// (e.g. `"heading"`, `"extra.countryCode"`) are zeroed/removed.
// `async` so the insert + render-buffer registration runs off the main (event-loop)
// thread; as a sync command it froze the webview for the duration of the import insert.
#[tauri::command]
#[specta::specta]
pub async fn store_import_file(
    label: WindowLabel,
    state: tauri::State<'_, engine::StoreState>,
    dropped_fields: Vec<String>,
    tag_name: Option<String>,
) -> AppResult<EditorImportResult> {
    let t0 = Instant::now();
    let mut parsed = EDITOR_IMPORT_CACHE
        .lock()
        .unwrap()
        .take()
        .ok_or("no cached import — call store_import_preview first")?;

    let drop_set: HashSet<&str> = dropped_fields.iter().map(String::as_str).collect();
    if !drop_set.is_empty() {
        for loc in &mut parsed.locations {
            if drop_set.contains("heading") {
                loc.heading = 0.0;
            }
            if drop_set.contains("pitch") {
                loc.pitch = 0.0;
            }
            if drop_set.contains("zoom") {
                loc.zoom = 0.0;
            }
            if drop_set.contains("panoId") {
                loc.pano_id = None;
                loc.flags.remove(LocationFlags::LOAD_AS_PANO_ID);
            }
            if drop_set.contains("tags") {
                loc.tags.clear();
            }
            if let Some(extra) = &loc.extra {
                let mut m = extra.to_map();
                m.retain(|k, _| !drop_set.contains(format!("extra.{k}").as_str()));
                loc.extra = RawExtra::from_map(&m);
            }
        }
        if drop_set.contains("tags") {
            parsed.tags.clear();
        }
    }
    // Capture before add_parsed_to_store, which consumes parsed.locations (moves them
    // into the overlay) leaving the vec empty.
    let imported_count = parsed.locations.len() as u32;
    let auto_commit = parsed.locations.len() > IMPORT_AUTOCOMMIT_THRESHOLD;
    log::debug!("[import] parse=cached locs={imported_count}");

    with_store!(label, state, |store| {
        let mutation = add_parsed_to_store(store, &mut parsed, tag_name.as_deref())?;

        log::debug!(
            "[import] total={:.0}ms locs={}",
            t0.elapsed().as_millis(),
            imported_count
        );

        Ok(EditorImportResult {
            imported_count,
            auto_commit,
            warnings: parsed.warnings,
            settings: parsed.settings,
            mutation,
        })
    })
}
