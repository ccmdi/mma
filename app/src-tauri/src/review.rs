//! Persistent review sessions.
//!
//! A review session is a frozen, ordered worklist of location ids (born from a selection)
//! plus a per-session set of ids that have been reviewed and a content-addressed cursor.
//! Stored in SQLite (`review_sessions`), scoped per map. Unlike the old in-memory cursor,
//! sessions survive map close, run in parallel, and never desync on worklist mutation
//! because the cursor is an id, not a positional index.
//!
//! Command wrappers (`store_review_*`) open the DB and delegate to the `&Connection` core
//! functions below, which carry all the behavior and are unit-tested directly.

use crate::storage;
use crate::types::AppResult;
use crate::util::now_iso;
use rusqlite::Connection;

/// A review session as returned to the frontend. `order`/`reviewed` are decoded from the
/// JSON-text columns; `source_props` is the originating `SelectionProps` (opaque here).
#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSession {
    pub id: String,
    pub map_id: String,
    pub name: String,
    pub source_key: String,
    #[specta(type = specta_typescript::Any)]
    pub source_props: serde_json::Value,
    pub order: Vec<u32>,
    pub reviewed: Vec<u32>,
    pub cursor_id: u32,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Inbound payload for creating a session. `order` is the frozen worklist (must be non-empty);
/// the cursor starts at its first id and `reviewed` starts empty.
#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCreate {
    pub map_id: String,
    pub name: String,
    pub source_key: String,
    #[specta(type = specta_typescript::Any)]
    pub source_props: serde_json::Value,
    pub order: Vec<u32>,
}

/// Partial update. Any `Some` field is written; `None` leaves the column untouched.
/// `ordering`/`reviewed` carry the full replacement arrays (used by reconciliation pruning).
#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewUpdate {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub cursor_id: Option<u32>,
    pub reviewed: Option<Vec<u32>>,
    pub ordering: Option<Vec<u32>>,
    pub status: Option<String>,
}

/// SELECT column list shared by all readers, matching `row_to_session` ordinals.
const COLS: &str =
    "id, map_id, name, source_key, source_props, ordering, reviewed, cursor_id, status, created_at, updated_at";

/// Decode a row (in `COLS` order) into a `ReviewSession`, parsing the JSON-text columns.
fn row_to_session(row: &rusqlite::Row) -> rusqlite::Result<ReviewSession> {
    let source_props: String = row.get(4)?;
    let ordering: String = row.get(5)?;
    let reviewed: String = row.get(6)?;
    Ok(ReviewSession {
        id: row.get(0)?,
        map_id: row.get(1)?,
        name: row.get(2)?,
        source_key: row.get(3)?,
        source_props: serde_json::from_str(&source_props).unwrap_or(serde_json::Value::Null),
        order: serde_json::from_str(&ordering).unwrap_or_default(),
        reviewed: serde_json::from_str(&reviewed).unwrap_or_default(),
        cursor_id: row.get(7)?,
        status: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

// --- Core (testable against any Connection) ---

/// Creates a review session over `order` (frozen worklist). Cursor starts at the first id.
pub(crate) fn create(conn: &Connection, session: ReviewCreate) -> AppResult<ReviewSession> {
    if session.order.is_empty() {
        return Err("cannot create a review session with an empty worklist".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_iso();
    let cursor_id = session.order[0];
    let source_props = serde_json::to_string(&session.source_props)?;
    let ordering = serde_json::to_string(&session.order)?;

    conn.execute(
        "INSERT INTO review_sessions (id, map_id, name, source_key, source_props, ordering, reviewed, cursor_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 'active', ?, ?)",
        rusqlite::params![id, session.map_id, session.name, session.source_key, source_props, ordering, cursor_id, now, now],
    )?;

    Ok(ReviewSession {
        id,
        map_id: session.map_id,
        name: session.name,
        source_key: session.source_key,
        source_props: session.source_props,
        order: session.order,
        reviewed: Vec::new(),
        cursor_id,
        status: "active".into(),
        created_at: now.clone(),
        updated_at: now,
    })
}

/// Resume lookup: the most recent active session for `map_id` matching `source_key`, if any.
pub(crate) fn get(
    conn: &Connection,
    map_id: &str,
    source_key: &str,
) -> AppResult<Option<ReviewSession>> {
    let sql = format!(
        "SELECT {COLS} FROM review_sessions WHERE map_id = ? AND source_key = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query_map(rusqlite::params![map_id, source_key], row_to_session)?;
    match rows.next() {
        Some(r) => Ok(Some(r?)),
        None => Ok(None),
    }
}

/// Lists a map's sessions, newest-first. Optional `status` filter (e.g. "active" / "done").
pub(crate) fn list(
    conn: &Connection,
    map_id: &str,
    status: Option<&str>,
) -> AppResult<Vec<ReviewSession>> {
    let (sql, params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = match status {
        Some(s) => (
            format!("SELECT {COLS} FROM review_sessions WHERE map_id = ? AND status = ? ORDER BY updated_at DESC"),
            vec![Box::new(map_id.to_string()), Box::new(s.to_string())],
        ),
        None => (
            format!("SELECT {COLS} FROM review_sessions WHERE map_id = ? ORDER BY updated_at DESC"),
            vec![Box::new(map_id.to_string())],
        ),
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
        row_to_session,
    )?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// Applies a partial update. Only `Some` fields are written. Always bumps `updated_at`.
pub(crate) fn update(conn: &Connection, update: ReviewUpdate) -> AppResult<()> {
    let mut sets: Vec<&str> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(name) = &update.name {
        sets.push("name = ?");
        params.push(Box::new(name.clone()));
    }
    if let Some(cursor_id) = update.cursor_id {
        sets.push("cursor_id = ?");
        params.push(Box::new(cursor_id));
    }
    if let Some(reviewed) = &update.reviewed {
        sets.push("reviewed = ?");
        params.push(Box::new(serde_json::to_string(reviewed)?));
    }
    if let Some(ordering) = &update.ordering {
        sets.push("ordering = ?");
        params.push(Box::new(serde_json::to_string(ordering)?));
    }
    if let Some(status) = &update.status {
        sets.push("status = ?");
        params.push(Box::new(status.clone()));
    }
    if sets.is_empty() {
        return Ok(());
    }
    sets.push("updated_at = ?");
    params.push(Box::new(now_iso()));
    params.push(Box::new(update.id));

    let sql = format!(
        "UPDATE review_sessions SET {} WHERE id = ?",
        sets.join(", ")
    );
    conn.execute(
        &sql,
        rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
    )?;
    Ok(())
}

/// Deletes a session.
pub(crate) fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM review_sessions WHERE id = ?",
        rusqlite::params![id],
    )?;
    Ok(())
}

// --- Command wrappers ---

#[tauri::command]
#[specta::specta]
pub fn store_review_create(session: ReviewCreate) -> AppResult<ReviewSession> {
    create(&storage::open_db()?, session)
}

#[tauri::command]
#[specta::specta]
pub fn store_review_get(map_id: String, source_key: String) -> AppResult<Option<ReviewSession>> {
    get(&storage::open_db()?, &map_id, &source_key)
}

#[tauri::command]
#[specta::specta]
pub fn store_review_list(map_id: String, status: Option<String>) -> AppResult<Vec<ReviewSession>> {
    list(&storage::open_db()?, &map_id, status.as_deref())
}

#[tauri::command]
#[specta::specta]
pub fn store_review_update(update: ReviewUpdate) -> AppResult<()> {
    self::update(&storage::open_db()?, update)
}

#[tauri::command]
#[specta::specta]
pub fn store_review_delete(id: String) -> AppResult<()> {
    delete(&storage::open_db()?, &id)
}

#[cfg(test)]
#[path = "review.test.rs"]
mod tests;
