//! Persistent review sessions.
//!
//! A review session is a frozen, ordered worklist of location ids (born from a selection)
//! plus a per-session set of ids that have been reviewed and a content-addressed cursor.
//! Stored in SQLite (`review_sessions`), scoped per map. Sessions survive map close, and
//! the cursor is an id rather than a positional index, so worklist mutation cannot desync it.

use crate::store::maps::MapMeta;
use crate::store::storage;
use crate::types::{AppResult, Location};
use crate::util::now_iso;
use mma_algebra::{Edit, Id, Op};
use rusqlite::types::ToSql;
use rusqlite::{Connection, OptionalExtension};

/// A review session: a frozen worklist of locations with progress tracking.
#[derive(Clone, serde::Serialize, serde::Deserialize, specta::Type, mma_fields::Patch)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSession {
    #[patch(key)]
    pub id: String,
    #[patch(skip)]
    pub map_id: Id<MapMeta, String>,
    pub name: String,
    #[patch(skip)]
    pub source_key: String,
    #[specta(type = specta_typescript::Any)]
    #[patch(skip)]
    pub source_props: serde_json::Value,
    #[patch(column = "ordering")]
    pub order: Vec<Id<Location>>,
    pub reviewed: Vec<Id<Location>>,
    pub cursor_id: Id<Location>,
    pub status: String,
    #[patch(skip)]
    pub created_at: String,
    #[patch(skip)]
    pub updated_at: String,
}

impl storage::Stamped for ReviewSession {
    fn updated_at(&self) -> &str {
        &self.updated_at
    }
    fn stamp(&mut self, at: String) {
        self.updated_at = at;
    }
}

/// SELECT column list shared by all readers, matching `row_to_session` ordinals.
const COLS: &str =
    "id, map_id, name, source_key, source_props, ordering, reviewed, cursor_id, status, created_at, updated_at";

/// Decode a row (selected via `COLS`) into a `ReviewSession`, parsing JSON-text columns.
fn row_to_session(row: &rusqlite::Row) -> rusqlite::Result<ReviewSession> {
    Ok(ReviewSession {
        id: row.get("id")?,
        map_id: Id::new(row.get("map_id")?),
        name: row.get("name")?,
        source_key: row.get("source_key")?,
        source_props: storage::json_col(row, "source_props")?,
        order: storage::json_col(row, "ordering")?,
        reviewed: storage::json_col(row, "reviewed")?,
        cursor_id: Id::new(row.get("cursor_id")?),
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// Store `session` whole, replacing any session with its id. Its worklist must be non-empty
/// and hold its cursor.
fn write_session(conn: &Connection, session: &ReviewSession) -> AppResult<()> {
    if session.order.is_empty() {
        return Err("a review session needs a non-empty worklist".into());
    }
    if !session.order.contains(&session.cursor_id) {
        return Err("a review session's cursor must be in its worklist".into());
    }
    conn.execute(
        "INSERT OR REPLACE INTO review_sessions (id, map_id, name, source_key, source_props, ordering, reviewed, cursor_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            session.id,
            session.map_id.raw(),
            session.name,
            session.source_key,
            serde_json::to_string(&session.source_props)?,
            serde_json::to_string(&session.order)?,
            serde_json::to_string(&session.reviewed)?,
            session.cursor_id.get(),
            session.status,
            session.created_at,
            session.updated_at,
        ],
    )?;
    Ok(())
}

/// Lists a map's sessions, newest-first, optionally only those with `status` and `source_key`.
pub(crate) fn list(
    conn: &Connection,
    map_id: &Id<MapMeta, String>,
    status: Option<&str>,
    source_key: Option<&str>,
) -> AppResult<Vec<ReviewSession>> {
    let mut sql = format!("SELECT {COLS} FROM review_sessions WHERE map_id = ?");
    let mut params: Vec<Box<dyn ToSql>> = vec![Box::new(map_id.raw().clone())];
    for (column, value) in [("status", status), ("source_key", source_key)] {
        if let Some(value) = value {
            sql.push_str(&format!(" AND {column} = ?"));
            params.push(Box::new(value.to_string()));
        }
    }
    sql.push_str(" ORDER BY updated_at DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        rusqlite::params_from_iter(params.iter().map(AsRef::as_ref)),
        row_to_session,
    )?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// List review sessions for a map, newest first, optionally only those with `status` and `sourceKey`.
#[tauri::command]
#[specta::specta]
pub async fn store_review_list(
    map_id: Id<MapMeta, String>,
    status: Option<String>,
    source_key: Option<String>,
) -> AppResult<Vec<ReviewSession>> {
    storage::with_db(move |conn| list(conn, &map_id, status.as_deref(), source_key.as_deref()))
        .await
}

/// Add, replace, patch or remove review sessions together. Returns each added session as
/// stored, in order.
#[tauri::command]
#[specta::specta]
pub async fn store_review_edit(edits: Vec<Edit<ReviewSession>>) -> AppResult<Vec<ReviewSession>> {
    storage::with_db(move |conn| {
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut added = Vec::new();
        for edit in edits {
            let now = now_iso();
            match edit {
                Op::Add(mut session) => {
                    session.id = uuid::Uuid::new_v4().to_string();
                    session.created_at = now.clone();
                    session.updated_at = now;
                    write_session(&tx, &session)?;
                    added.push(session);
                }
                Op::Set(mut session) => {
                    session.updated_at = now;
                    write_session(&tx, &session)?;
                }
                Op::Put(patch) => {
                    let row = tx
                        .query_row(
                            &format!("SELECT {COLS} FROM review_sessions WHERE id = ?"),
                            [&patch.id],
                            row_to_session,
                        )
                        .optional()?;
                    if let Some(row) = row {
                        storage::patch_row(&tx, "review_sessions", &patch.id, &row, &patch)?;
                    }
                }
                Op::Remove(id) => {
                    tx.execute("DELETE FROM review_sessions WHERE id = ?", [&id])?;
                }
            }
        }
        tx.commit()?;
        Ok(added)
    })
    .await
}

#[cfg(test)]
#[path = "review.test.rs"]
mod tests;
