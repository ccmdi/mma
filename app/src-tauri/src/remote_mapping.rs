//! Generic local<->remote id mapping for sync plugins (map-making.app, GeoGuessr, ...).
//!
//! One row per synced location: its stable local id paired with the current remote id plus a
//! fingerprint of the last-synced contract. Scoped by `(provider, map_id)`. This is dumb CRUD --
//! it holds no sync logic; the plugin owns the adapter/diff/policy and just persists rows here.
//! Stores ids and a hash, never location content.

use crate::storage;
use crate::types::AppResult;
use rusqlite::{params, Connection};

/// One mapping row. `hash` is the plugin's content fingerprint (opaque text to us).
#[derive(serde::Serialize, serde::Deserialize, specta::Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMappingRow {
    pub local_id: u32,
    /// Remote ids can exceed u32 (observed ~1.2e10), so i64.
    pub remote_id: i64,
    pub hash: String,
}

// --- Core (testable against any Connection) ---

/// All rows for a linked map.
pub(crate) fn get(conn: &Connection, provider: &str, map_id: &str) -> AppResult<Vec<RemoteMappingRow>> {
    let mut stmt =
        conn.prepare("SELECT local_id, remote_id, hash FROM remote_mapping WHERE provider = ? AND map_id = ?")?;
    let rows = stmt.query_map(params![provider, map_id], |row| {
        Ok(RemoteMappingRow { local_id: row.get(0)?, remote_id: row.get(1)?, hash: row.get(2)? })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Insert or update rows by `(provider, map_id, local_id)`. One transaction for the batch.
pub(crate) fn upsert(conn: &mut Connection, provider: &str, map_id: &str, rows: &[RemoteMappingRow]) -> AppResult<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO remote_mapping (provider, map_id, local_id, remote_id, hash) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(provider, map_id, local_id) DO UPDATE SET remote_id = excluded.remote_id, hash = excluded.hash",
        )?;
        for r in rows {
            stmt.execute(params![provider, map_id, r.local_id, r.remote_id, r.hash])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Remove specific rows by local id.
pub(crate) fn delete(conn: &mut Connection, provider: &str, map_id: &str, local_ids: &[u32]) -> AppResult<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("DELETE FROM remote_mapping WHERE provider = ? AND map_id = ? AND local_id = ?")?;
        for id in local_ids {
            stmt.execute(params![provider, map_id, id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Drop the whole mapping for a linked map (unlink).
pub(crate) fn clear(conn: &Connection, provider: &str, map_id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM remote_mapping WHERE provider = ? AND map_id = ?", params![provider, map_id])?;
    Ok(())
}

// --- Command wrappers ---

#[tauri::command]
#[specta::specta]
pub fn remote_mapping_get(provider: String, map_id: String) -> AppResult<Vec<RemoteMappingRow>> {
    get(&storage::open_db()?, &provider, &map_id)
}

#[tauri::command]
#[specta::specta]
pub fn remote_mapping_upsert(provider: String, map_id: String, rows: Vec<RemoteMappingRow>) -> AppResult<()> {
    upsert(&mut storage::open_db()?, &provider, &map_id, &rows)
}

#[tauri::command]
#[specta::specta]
pub fn remote_mapping_delete(provider: String, map_id: String, local_ids: Vec<u32>) -> AppResult<()> {
    delete(&mut storage::open_db()?, &provider, &map_id, &local_ids)
}

#[tauri::command]
#[specta::specta]
pub fn remote_mapping_clear(provider: String, map_id: String) -> AppResult<()> {
    clear(&storage::open_db()?, &provider, &map_id)
}

#[cfg(test)]
#[path = "remote_mapping.test.rs"]
mod tests;
