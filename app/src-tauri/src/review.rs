//! Persistent review sessions.
//!
//! A review session is a frozen, ordered worklist of location ids (born from a selection)
//! plus a per-session set of ids that have been reviewed and a content-addressed cursor.
//! Stored in SQLite (`review_sessions`), scoped per map. Sessions survive map close, and
//! the cursor is an id rather than a positional index, so worklist mutation cannot desync it.
//!
//! Command wrappers (`store_review_*`) open the DB and delegate to the `&Connection` core
//! functions below, which carry all the behavior and are unit-tested directly.

use crate::storage::{self, push_field};
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

/// Decode a row (selected via `COLS`) into a `ReviewSession`, parsing JSON-text columns.
fn row_to_session(row: &rusqlite::Row) -> rusqlite::Result<ReviewSession> {
    Ok(ReviewSession {
        id: row.get("id")?,
        map_id: row.get("map_id")?,
        name: row.get("name")?,
        source_key: row.get("source_key")?,
        source_props: storage::json_col(row, "source_props")?,
        order: storage::json_col(row, "ordering")?,
        reviewed: storage::json_col(row, "reviewed")?,
        cursor_id: row.get("cursor_id")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
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

    push_field!(sets, params, update, "name", name);
    push_field!(sets, params, update, "cursor_id", cursor_id);
    push_field!(json sets, params, update, "reviewed", reviewed);
    push_field!(json sets, params, update, "ordering", ordering);
    push_field!(sets, params, update, "status", status);
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
pub async fn store_review_create(session: ReviewCreate) -> AppResult<ReviewSession> {
    storage::with_db(move |conn| create(conn, session)).await
}

#[tauri::command]
#[specta::specta]
pub async fn store_review_get(map_id: String, source_key: String) -> AppResult<Option<ReviewSession>> {
    storage::with_db(move |conn| get(conn, &map_id, &source_key)).await
}

#[tauri::command]
#[specta::specta]
pub async fn store_review_list(map_id: String, status: Option<String>) -> AppResult<Vec<ReviewSession>> {
    storage::with_db(move |conn| list(conn, &map_id, status.as_deref())).await
}

#[tauri::command]
#[specta::specta]
pub async fn store_review_update(update: ReviewUpdate) -> AppResult<()> {
    storage::with_db(move |conn| self::update(conn, update)).await
}

#[tauri::command]
#[specta::specta]
pub async fn store_review_delete(id: String) -> AppResult<()> {
    storage::with_db(move |conn| delete(conn, &id)).await
}

#[cfg(test)]
#[path = "review.test.rs"]
mod tests;
