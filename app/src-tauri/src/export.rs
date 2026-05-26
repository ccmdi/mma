use std::io::Write;
use crate::arrow_bridge;
use crate::fast_io;
use crate::location_store::StoreState;

const LOAD_AS_PANO_ID: u32 = 1;

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportOpts {
    pub export_zoom: bool,
    pub export_unpanned: bool,
    pub export_extras: bool,
    pub scope: Option<Vec<u32>>,
    pub map_name: String,
    pub tags_json: String,
    pub extra_fields_json: Option<String>,
}

fn hex_to_rgb(hex: &str) -> Option<[u8; 3]> {
    let h = hex.trim_start_matches('#');
    if h.len() != 6 { return None; }
    Some([
        u8::from_str_radix(&h[0..2], 16).ok()?,
        u8::from_str_radix(&h[2..4], 16).ok()?,
        u8::from_str_radix(&h[4..6], 16).ok()?,
    ])
}

#[cfg(test)]
#[path = "export.test.rs"]
mod tests;

#[tauri::command]
#[specta::specta]
pub fn store_export_json(
    state: tauri::State<'_, StoreState>,
    opts: ExportOpts,
) -> Result<String, String> {
    let store = state.lock().map_err(|e| e.to_string())?;

    let tag_defs: std::collections::HashMap<String, serde_json::Value> =
        serde_json::from_str(&opts.tags_json).unwrap_or_default();
    let id_to_name: std::collections::HashMap<u32, String> = tag_defs.iter()
        .filter_map(|(k, v)| {
            let id = k.parse::<u32>().ok()?;
            let name = v.get("name")?.as_str()?.to_string();
            Some((id, name))
        })
        .collect();

    let locs = match &opts.scope {
        Some(ids) => {
            let set: std::collections::HashSet<u32> = ids.iter().copied().collect();
            store.collect_all_locations().into_iter().filter(|l| set.contains(&l.id)).collect::<Vec<_>>()
        }
        None => store.collect_all_locations(),
    };

    let mut coords = Vec::with_capacity(locs.len());
    for loc in &locs {
        let pinned = loc.flags & LOAD_AS_PANO_ID != 0;
        let mut c = serde_json::Map::new();
        c.insert("lat".into(), serde_json::json!(loc.lat));
        c.insert("lng".into(), serde_json::json!(loc.lng));
        let heading = if opts.export_unpanned && loc.heading == 0.0 { 0.001 } else { loc.heading };
        c.insert("heading".into(), serde_json::json!(heading));
        c.insert("pitch".into(), serde_json::json!(loc.pitch));
        c.insert("zoom".into(), serde_json::json!(if opts.export_zoom { loc.zoom } else { 0.0 }));
        c.insert("panoId".into(), if pinned { serde_json::json!(loc.pano_id) } else { serde_json::Value::Null });
        c.insert("countryCode".into(), loc.extra.as_ref().and_then(|e| e.get("countryCode").cloned()).unwrap_or(serde_json::Value::Null));
        c.insert("stateCode".into(), loc.extra.as_ref().and_then(|e| e.get("stateCode").cloned()).unwrap_or(serde_json::Value::Null));

        if opts.export_extras {
            let mut extra = serde_json::Map::new();
            if let Some(ref e) = loc.extra {
                for (k, v) in e {
                    if k == "countryCode" || k == "stateCode" { continue; }
                    extra.insert(k.clone(), v.clone());
                }
            }
            if !loc.tags.is_empty() {
                let names: Vec<serde_json::Value> = loc.tags.iter()
                    .map(|id| serde_json::json!(id_to_name.get(id).cloned().unwrap_or_else(|| id.to_string())))
                    .collect();
                extra.insert("tags".into(), serde_json::json!(names));
            }
            if !pinned && loc.pano_id.is_some() {
                extra.insert("panoId".into(), serde_json::json!(loc.pano_id));
            }
            if !extra.is_empty() {
                c.insert("extra".into(), serde_json::Value::Object(extra));
            }
        }
        coords.push(serde_json::Value::Object(c));
    }

    let mut parts = serde_json::Map::new();
    if !opts.map_name.is_empty() {
        parts.insert("name".into(), serde_json::json!(opts.map_name));
    }
    parts.insert("customCoordinates".into(), serde_json::Value::Array(coords));

    if opts.export_extras {
        let mut extra = serde_json::Map::new();
        if !tag_defs.is_empty() {
            let mut converted = serde_json::Map::new();
            for v in tag_defs.values() {
                if let (Some(name), Some(color)) = (v.get("name").and_then(|n| n.as_str()), v.get("color").and_then(|c| c.as_str())) {
                    let mut entry = serde_json::Map::new();
                    if let Some(rgb) = hex_to_rgb(color) {
                        entry.insert("color".into(), serde_json::json!([rgb[0], rgb[1], rgb[2]]));
                    }
                    converted.insert(name.to_string(), serde_json::Value::Object(entry));
                }
            }
            if !converted.is_empty() {
                extra.insert("tags".into(), serde_json::Value::Object(converted));
            }
        }
        if let Some(ref fields_json) = opts.extra_fields_json {
            if let Ok(fields) = serde_json::from_str::<serde_json::Value>(fields_json) {
                extra.insert("fields".into(), fields);
            }
        }
        if !extra.is_empty() {
            parts.insert("extra".into(), serde_json::Value::Object(extra));
        }
    }

    let json = serde_json::to_string(&serde_json::Value::Object(parts)).map_err(|e| e.to_string())?;

    let path = std::env::temp_dir().join(format!("mma_export_{}.json", std::process::id()));
    std::fs::write(&path, &json).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
#[specta::specta]
pub fn store_export_csv(
    state: tauri::State<'_, StoreState>,
    scope: Option<Vec<u32>>,
) -> Result<String, String> {
    let store = state.lock().map_err(|e| e.to_string())?;

    let locs = match &scope {
        Some(ids) => {
            let set: std::collections::HashSet<u32> = ids.iter().copied().collect();
            store.collect_all_locations().into_iter().filter(|l| set.contains(&l.id)).collect::<Vec<_>>()
        }
        None => store.collect_all_locations(),
    };

    let mut buf = String::with_capacity(locs.len() * 30);
    buf.push_str("lat,lng\n");
    for loc in &locs {
        buf.push_str(&format!("{},{}\n", loc.lat, loc.lng));
    }

    let path = std::env::temp_dir().join(format!("mma_export_{}.csv", std::process::id()));
    std::fs::write(&path, &buf).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
#[specta::specta]
pub fn store_export_geojson(
    state: tauri::State<'_, StoreState>,
    scope: Option<Vec<u32>>,
    tags_json: String,
) -> Result<String, String> {
    let store = state.lock().map_err(|e| e.to_string())?;

    let tag_defs: std::collections::HashMap<String, serde_json::Value> =
        serde_json::from_str(&tags_json).unwrap_or_default();
    let id_to_name: std::collections::HashMap<u32, String> = tag_defs.iter()
        .filter_map(|(k, v)| {
            let id = k.parse::<u32>().ok()?;
            let name = v.get("name")?.as_str()?.to_string();
            Some((id, name))
        })
        .collect();

    let locs = match &scope {
        Some(ids) => {
            let set: std::collections::HashSet<u32> = ids.iter().copied().collect();
            store.collect_all_locations().into_iter().filter(|l| set.contains(&l.id)).collect::<Vec<_>>()
        }
        None => store.collect_all_locations(),
    };

    let features: Vec<serde_json::Value> = locs.iter().map(|l| {
        let tag_names: Vec<String> = l.tags.iter()
            .map(|id| id_to_name.get(id).cloned().unwrap_or_else(|| id.to_string()))
            .collect();
        serde_json::json!({
            "type": "Feature",
            "geometry": { "type": "Point", "coordinates": [l.lng, l.lat] },
            "properties": { "tags": tag_names }
        })
    }).collect();

    let geojson = serde_json::json!({ "type": "FeatureCollection", "features": features });
    let json = serde_json::to_string(&geojson).map_err(|e| e.to_string())?;

    let path = std::env::temp_dir().join(format!("mma_export_{}.geojson", std::process::id()));
    std::fs::write(&path, &json).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
#[specta::specta]
pub async fn store_export_bulk_zip(
    app: tauri::AppHandle,
) -> Result<String, String> {
    let app2 = app.clone();
    let path = tokio::task::spawn_blocking(move || {
        use std::io::Cursor;

        let conn = fast_io::open_db(&app2)?;
        let mut stmt = conn.prepare("SELECT id, name, folder, tags, extra FROM maps")
            .map_err(|e| e.to_string())?;
        let maps: Vec<(String, String, Option<String>, String, String)> = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        }).map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
        drop(stmt);
        drop(conn);
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);

            let mut used_names = std::collections::HashSet::new();

            for (map_id, name, _folder, tags_json, extra_json) in &maps {
                let arrow_path = fast_io::arrow_path(&app2, map_id)?;
                let locs = if arrow_path.exists() {
                    let batch = fast_io::read_arrow_ipc(&arrow_path)?;
                    arrow_bridge::batch_to_locations(&batch)
                } else {
                    Vec::new()
                };

                let tag_defs: std::collections::HashMap<String, serde_json::Value> =
                    serde_json::from_str(tags_json).unwrap_or_default();
                let id_to_name: std::collections::HashMap<u32, String> = tag_defs.iter()
                    .filter_map(|(k, v)| {
                        let id = k.parse::<u32>().ok()?;
                        let n = v.get("name")?.as_str()?.to_string();
                        Some((id, n))
                    })
                    .collect();

                let coords: Vec<serde_json::Value> = locs.iter().map(|loc| {
                    let pinned = loc.flags & LOAD_AS_PANO_ID != 0;
                    let mut c = serde_json::Map::new();
                    if let Some(ref e) = loc.extra {
                        for (k, v) in e { c.insert(k.clone(), v.clone()); }
                    }
                    c.insert("lat".into(), serde_json::json!(loc.lat));
                    c.insert("lng".into(), serde_json::json!(loc.lng));
                    c.insert("heading".into(), serde_json::json!(loc.heading));
                    c.insert("pitch".into(), serde_json::json!(loc.pitch));
                    c.insert("zoom".into(), serde_json::json!(loc.zoom));
                    c.insert("panoId".into(), if pinned { serde_json::json!(loc.pano_id) } else { serde_json::Value::Null });

                    let mut extra = serde_json::Map::new();
                    if !loc.tags.is_empty() {
                        let names: Vec<&str> = loc.tags.iter()
                            .filter_map(|id| id_to_name.get(id).map(|s| s.as_str()))
                            .collect();
                        extra.insert("tags".into(), serde_json::json!(names));
                    }
                    if !pinned && loc.pano_id.is_some() {
                        extra.insert("panoId".into(), serde_json::json!(loc.pano_id));
                    }
                    if !extra.is_empty() { c.insert("extra".into(), serde_json::Value::Object(extra)); }
                    serde_json::Value::Object(c)
                }).collect();

                let mut entry = serde_json::Map::new();
                entry.insert("name".into(), serde_json::json!(name));
                entry.insert("customCoordinates".into(), serde_json::Value::Array(coords));

                // Tag color metadata
                if !tag_defs.is_empty() {
                    let mut converted = serde_json::Map::new();
                    for v in tag_defs.values() {
                        if let (Some(n), Some(color)) = (v.get("name").and_then(|n| n.as_str()), v.get("color").and_then(|c| c.as_str())) {
                            let mut e = serde_json::Map::new();
                            if let Some(rgb) = hex_to_rgb(color) {
                                e.insert("color".into(), serde_json::json!([rgb[0], rgb[1], rgb[2]]));
                            }
                            converted.insert(n.to_string(), serde_json::Value::Object(e));
                        }
                    }
                    let mut extra_meta = serde_json::Map::new();
                    extra_meta.insert("tags".into(), serde_json::Value::Object(converted));
                    if let Ok(fields) = serde_json::from_str::<serde_json::Value>(extra_json) {
                        if let Some(f) = fields.get("fields") {
                            extra_meta.insert("fields".into(), f.clone());
                        }
                    }
                    entry.insert("extra".into(), serde_json::Value::Object(extra_meta));
                }

                let json = serde_json::to_string_pretty(&serde_json::Value::Object(entry))
                    .map_err(|e| e.to_string())?;

                let base = name.replace(|c: char| "<>:\"/\\|?*".contains(c), "_");
                let mut file_name = base.clone();
                let mut i = 2;
                while used_names.contains(&file_name.to_lowercase()) {
                    file_name = format!("{base} ({i})");
                    i += 1;
                }
                used_names.insert(file_name.to_lowercase());

                zip.start_file(format!("{file_name}.json"), options).map_err(|e| e.to_string())?;
                zip.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
            }
            zip.finish().map_err(|e| e.to_string())?;
        }

        let path = std::env::temp_dir().join(format!("mma_backup_{}.zip", std::process::id()));
        std::fs::write(&path, buf.into_inner()).map_err(|e| e.to_string())?;
        Ok::<_, String>(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(path)
}
