//! Global saved selection rules.
//!
//! A saved rule is one `Selector` tree plus the names its `Tag` leaves carried at save
//! time. Tag ids are map-local, so JS resolves them through the names at apply time; the
//! tree itself is stored verbatim. Rules are global rather than per-map -- no `map_id`.

use crate::selections::Selector;
use crate::storage;
use crate::types::AppResult;
use crate::util::now_iso;
use rusqlite::Connection;
use std::collections::HashMap;

/// A rule's identity and label, with no tree attached. What the UI lists and holds; the
/// body is a separate read because a single `Polygon` leaf can carry a country border's
/// coordinates (~1.7MB of JSON at the heavy border detail).
#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedSelectionInfo {
    pub id: String,
    pub name: String,
    pub color: [u8; 3],
    pub created_at: String,
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedSelection {
    #[serde(flatten)]
    pub info: SavedSelectionInfo,
    pub selector: Selector,
    /// Tag id -> the name it carried when saved. What makes a map-local `Tag` leaf portable.
    pub tag_names: HashMap<u32, String>,
}

const COLS: &str = "id, name, selector, tag_names, color, created_at";

/// Stand-in color for a rule imported without one.
const NO_COLOR: [u8; 3] = [128, 128, 128];

// --- Core (testable against any Connection) ---

/// Every rule's identity, oldest first. Reads no tree, so its cost is the rule count.
pub(crate) fn list_info(conn: &Connection) -> AppResult<Vec<SavedSelectionInfo>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, color, created_at FROM saved_selections ORDER BY created_at, id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(SavedSelectionInfo {
            id: row.get(0)?,
            name: row.get(1)?,
            color: serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or(NO_COLOR),
            created_at: row.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Bodies for `ids`, oldest first. A row whose JSON no longer parses (a `Selector` variant
/// this build dropped) is skipped rather than failing the whole read.
pub(crate) fn get(conn: &Connection, ids: &[String]) -> AppResult<Vec<SavedSelection>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let holes = vec!["?"; ids.len()].join(",");
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM saved_selections WHERE id IN ({holes}) ORDER BY created_at, id"
    ))?;
    let rows = stmt.query_map(rusqlite::params_from_iter(ids), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, name, selector, tag_names, color, created_at) = row?;
        match parse_row(&id, name, &selector, &tag_names, &color, created_at) {
            Ok(s) => out.push(s),
            Err(e) => log::warn!("[saved-selections] skipping unreadable rule {id}: {e}"),
        }
    }
    Ok(out)
}

fn parse_row(
    id: &str,
    name: String,
    selector: &str,
    tag_names: &str,
    color: &str,
    created_at: String,
) -> Result<SavedSelection, serde_json::Error> {
    Ok(SavedSelection {
        info: SavedSelectionInfo {
            id: id.to_string(),
            name,
            color: serde_json::from_str(color)?,
            created_at,
        },
        selector: serde_json::from_str(selector)?,
        tag_names: serde_json::from_str(tag_names)?,
    })
}

pub(crate) fn create(
    conn: &Connection,
    name: String,
    selector: Selector,
    tag_names: HashMap<u32, String>,
    color: [u8; 3],
) -> AppResult<SavedSelection> {
    let saved = SavedSelection {
        info: SavedSelectionInfo {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            color,
            created_at: now_iso(),
        },
        selector,
        tag_names,
    };
    insert(conn, &saved)?;
    Ok(saved)
}

fn insert(conn: &Connection, s: &SavedSelection) -> AppResult<()> {
    conn.execute(
        "INSERT INTO saved_selections (id, name, selector, tag_names, color, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            s.info.id,
            s.info.name,
            serde_json::to_string(&s.selector)?,
            serde_json::to_string(&s.tag_names)?,
            serde_json::to_string(&s.info.color)?,
            s.info.created_at,
        ],
    )?;
    Ok(())
}

pub(crate) fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM saved_selections WHERE id = ?",
        rusqlite::params![id],
    )?;
    Ok(())
}

// --- Command wrappers ---

#[tauri::command]
#[specta::specta]
pub async fn store_list_saved_selections() -> AppResult<Vec<SavedSelectionInfo>> {
    storage::with_db(|conn| list_info(conn)).await
}

#[tauri::command]
#[specta::specta]
pub async fn store_get_saved_selections(ids: Vec<String>) -> AppResult<Vec<SavedSelection>> {
    storage::with_db(move |conn| get(conn, &ids)).await
}

#[tauri::command]
#[specta::specta]
pub async fn store_save_selection(
    name: String,
    selector: Selector,
    tag_names: HashMap<u32, String>,
    color: [u8; 3],
) -> AppResult<SavedSelection> {
    storage::with_db(move |conn| create(conn, name, selector, tag_names, color)).await
}

#[tauri::command]
#[specta::specta]
pub async fn store_delete_saved_selection(id: String) -> AppResult<()> {
    storage::with_db(move |conn| delete(conn, &id)).await
}

/// The pre-0.9.3 localStorage import, kept in its own file so it can be deleted whole.
#[path = "saved_selections.legacy.rs"]
pub(crate) mod legacy;

#[cfg(test)]
#[path = "saved_selections.test.rs"]
mod tests;
