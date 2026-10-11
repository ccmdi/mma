//! A per-map record of settled sync passes: when each ran, what started it, and what it changed
//! or why it failed. Kept per map and provider, capped, and deleted with the map.

use super::SideCounts;
use crate::store::maps::MapMeta;
use crate::store::storage;
use crate::types::{wire_str_enum, AppResult};
use mma_algebra::Id;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

wire_str_enum! {
    /// What started a sync pass.
    derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)
    pub enum SyncTrigger {
        /// Sync now was pressed.
        Manual = "manual",
        /// Live sync ran it, after an edit or on its schedule.
        Live = "live",
        /// Linking the map ran its first sync.
        Link = "link",
        /// Resolving held conflicts ran it.
        Resolve = "resolve",
    }
}

/// How a sync pass ended.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SyncLogResult {
    /// The pass finished, with what it changed on each side.
    #[serde(rename_all = "camelCase")]
    Ok {
        pushed: SideCounts,
        pulled: SideCounts,
        adopted: u32,
        conflicts: u32,
    },
    /// The pass stopped with this error.
    Error { message: String },
}

/// One settled sync pass.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncLogEntry {
    pub trigger: SyncTrigger,
    /// When the pass started, in milliseconds since 1970.
    pub started_at: i64,
    pub duration_ms: u32,
    pub result: SyncLogResult,
}

/// Passes kept per map and provider; the oldest go first.
pub(crate) const MAX_ENTRIES: u32 = 100;

// --- Core (testable against any Connection) ---

pub(crate) fn append(
    conn: &Connection,
    provider: &str,
    map_id: &Id<MapMeta, String>,
    entry: &SyncLogEntry,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO sync_log (map_id, provider, started_at, entry) VALUES (?, ?, ?, ?)",
        params![
            map_id.raw(),
            provider,
            entry.started_at,
            serde_json::to_string(entry)?
        ],
    )?;
    conn.execute(
        "DELETE FROM sync_log WHERE map_id = ?1 AND provider = ?2 AND id NOT IN (
            SELECT id FROM sync_log WHERE map_id = ?1 AND provider = ?2
            ORDER BY started_at DESC, id DESC LIMIT ?3)",
        params![map_id.raw(), provider, MAX_ENTRIES],
    )?;
    Ok(())
}

/// The map's passes with `provider`, newest first.
pub(crate) fn list(
    conn: &Connection,
    provider: &str,
    map_id: &Id<MapMeta, String>,
) -> AppResult<Vec<SyncLogEntry>> {
    let mut stmt = conn.prepare(
        "SELECT entry FROM sync_log WHERE map_id = ? AND provider = ?
         ORDER BY started_at DESC, id DESC",
    )?;
    let rows = stmt.query_map(params![map_id.raw(), provider], |row| {
        row.get::<_, String>(0)
    })?;
    let mut entries = Vec::new();
    for row in rows {
        entries.push(serde_json::from_str(&row?)?);
    }
    Ok(entries)
}

// --- Command wrappers ---

/// Record a settled sync pass for a map. Only the most recent passes per provider are kept.
#[tauri::command]
#[specta::specta]
pub async fn sync_log_append(
    provider: String,
    map_id: Id<MapMeta, String>,
    entry: SyncLogEntry,
) -> AppResult<()> {
    storage::with_db(move |conn| append(conn, &provider, &map_id, &entry)).await
}

/// A map's recorded sync passes with a provider, newest first.
#[tauri::command]
#[specta::specta]
pub async fn sync_log_list(
    provider: String,
    map_id: Id<MapMeta, String>,
) -> AppResult<Vec<SyncLogEntry>> {
    storage::with_db(move |conn| list(conn, &provider, &map_id)).await
}

#[cfg(test)]
#[path = "log.test.rs"]
mod tests;
