use rusqlite::params;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::fast_io;
use crate::location_store::{self, CommitBlobEntry, StoreState};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub map_id: String,
    pub parent_id: Option<String>,
    pub message: Option<String>,
    pub tree_hash: Option<String>,
    pub added: u32,
    pub removed: u32,
    pub modified: u32,
    pub location_count: u32,
    pub created_at: String,
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(default)]
pub struct CommitDiff {
    pub added: u32,
    pub removed: u32,
    pub modified: u32,
}

impl Default for CommitDiff {
    fn default() -> Self {
        Self { added: 0, removed: 0, modified: 0 }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn sha256_hex(input: &str) -> String {
    let hash = Sha256::digest(input.as_bytes());
    let mut s = String::with_capacity(hash.len() * 2);
    for b in hash.iter() {
        use std::fmt::Write;
        write!(&mut s, "{b:02x}").unwrap();
    }
    s
}

use crate::util::now_iso;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub fn store_create_commit(
    app: tauri::AppHandle,
    state: State<'_, StoreState>,
    map_id: String,
    message: Option<String>,
    diff: Option<CommitDiff>,
) -> Result<String, String> {
    let _t = std::time::Instant::now();
    let conn = fast_io::open_db(&app)?;

    // 1. Find parent commit
    let parent_id: Option<String> = conn
        .query_row(
            "SELECT id FROM commits WHERE map_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 1",
            params![map_id],
            |row| row.get(0),
        )
        .ok();

    // 2. Snapshot blobs via the store
    let entries = location_store::snapshot_inner(&app, &state)?;

    // 3. Compute tree hash
    let mut sorted = entries.clone();
    sorted.sort_by(|a, b| a.geohash.cmp(&b.geohash));
    let hash_content: String = sorted
        .iter()
        .map(|e| format!("{} {}", e.geohash, e.blob_hash))
        .collect::<Vec<_>>()
        .join("\n");
    let tree_hash = sha256_hex(&hash_content);

    // 4. Compute commit id
    let now = now_iso();
    let commit_input = format!(
        "tree {tree_hash}\nparent {}\ndate {now}",
        parent_id.as_deref().unwrap_or("")
    );
    let id = sha256_hex(&commit_input);

    // 5. Compute location count
    let location_count: u32 = sorted.iter().map(|e| e.location_count).sum();

    // 6. Diff stats
    let (added, removed, modified) = match diff {
        Some(d) => (d.added, d.removed, d.modified),
        None => (0, 0, 0),
    };

    // 7. INSERT commit
    conn.execute(
        "INSERT INTO commits (id, map_id, parent_id, message, location_count, created_at, tree_hash, added, removed, modified) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id, map_id, parent_id, message, location_count, now, tree_hash, added, removed, modified],
    ).map_err(|e| e.to_string())?;

    // 8. Batch INSERT commit_trees
    const BATCH_SIZE: usize = 200;
    for chunk in sorted.chunks(BATCH_SIZE) {
        let placeholders: String = chunk
            .iter()
            .map(|_| "(?, ?, ?, ?)")
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "INSERT INTO commit_trees (commit_id, geohash, blob_hash, location_count) VALUES {placeholders}"
        );
        let mut flat_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::with_capacity(chunk.len() * 4);
        for entry in chunk {
            flat_params.push(Box::new(id.clone()));
            flat_params.push(Box::new(entry.geohash.clone()));
            flat_params.push(Box::new(entry.blob_hash.clone()));
            flat_params.push(Box::new(entry.location_count));
        }
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = flat_params.iter().map(|p| p.as_ref()).collect();
        conn.execute(&sql, param_refs.as_slice())
            .map_err(|e| e.to_string())?;
    }

    log::info!(
        "[vcs] commit {} locs={} blobs={} in {}ms",
        &id[..7],
        location_count,
        sorted.len(),
        _t.elapsed().as_millis()
    );

    Ok(id)
}

#[tauri::command]
#[specta::specta]
pub fn store_list_commits(
    app: tauri::AppHandle,
    map_id: String,
) -> Result<Vec<CommitInfo>, String> {
    let conn = fast_io::open_db(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, map_id, parent_id, message, tree_hash, added, removed, modified, location_count, created_at FROM commits WHERE map_id = ?1 ORDER BY created_at DESC, rowid DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![map_id], |row| {
            Ok(CommitInfo {
                id: row.get(0)?,
                map_id: row.get(1)?,
                parent_id: row.get(2)?,
                message: row.get(3)?,
                tree_hash: row.get(4)?,
                added: row.get(5)?,
                removed: row.get(6)?,
                modified: row.get(7)?,
                location_count: row.get(8)?,
                created_at: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut commits = Vec::new();
    for row in rows {
        commits.push(row.map_err(|e| e.to_string())?);
    }
    Ok(commits)
}

#[tauri::command]
#[specta::specta]
pub fn store_checkout_commit(
    app: tauri::AppHandle,
    map_id: String,
    commit_id: String,
) -> Result<(), String> {
    let conn = fast_io::open_db(&app)?;
    let mut stmt = conn
        .prepare("SELECT geohash, blob_hash, location_count FROM commit_trees WHERE commit_id = ?1")
        .map_err(|e| e.to_string())?;

    let blobs: Vec<CommitBlobEntry> = stmt
        .query_map(params![commit_id], |row| {
            Ok(CommitBlobEntry {
                geohash: row.get(0)?,
                blob_hash: row.get(1)?,
                location_count: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    location_store::restore_inner(&app, &map_id, blobs)?;

    log::info!("[vcs] checkout {} on map {}", &commit_id[..7.min(commit_id.len())], map_id);
    Ok(())
}
