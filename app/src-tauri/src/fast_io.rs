use rusqlite::Connection;
use sha2::{Digest, Sha256};
use tauri::ipc::InvokeBody;
use tauri::Manager;
use crate::arrow_bridge;

pub fn is_test_mode() -> bool {
    cfg!(feature = "e2e") || std::env::var("MMA_TEST_DB").is_ok()
}

pub fn db_filename() -> &'static str {
    if is_test_mode() { "mma_test.db" } else { "mma.db" }
}

pub(crate) fn db_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join(db_filename()))
        .map_err(|e| e.to_string())
}

pub(crate) fn open_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create app data dir: {e}"))?;
    }
    Connection::open(path).map_err(|e| e.to_string())
}

pub(crate) fn run_migrations(app: &tauri::AppHandle) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute_batch("
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
    ").map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS _mma_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
        [],
    ).map_err(|e| e.to_string())?;

    // Seed from tauri-plugin-sql's migration table if upgrading from old system
    let sqlx_exists: bool = conn.query_row(
        "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
        [], |r| r.get(0),
    ).unwrap_or(false);
    if sqlx_exists {
        conn.execute_batch(
            "INSERT OR IGNORE INTO _mma_migrations (version, applied_at)
             SELECT version, installed_on FROM _sqlx_migrations WHERE success = 1"
        ).ok();
    }

    let applied: std::collections::HashSet<u32> = conn
        .prepare("SELECT version FROM _mma_migrations")
        .map_err(|e| e.to_string())?
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    for (version, sql) in MIGRATIONS {
        if applied.contains(version) { continue; }
        log::info!("[migrations] applying v{version}");
        conn.execute_batch(sql).map_err(|e| format!("migration v{version} failed: {e}"))?;
        conn.execute(
            "INSERT INTO _mma_migrations (version, applied_at) VALUES (?1, datetime('now'))",
            rusqlite::params![version],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

const MIGRATIONS: &[(u32, &str)] = &[
    (1, "CREATE TABLE IF NOT EXISTS maps (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            folder TEXT,
            settings TEXT NOT NULL DEFAULT '{}',
            score_bounds TEXT NOT NULL DEFAULT '\"auto\"',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS tags (
            id TEXT PRIMARY KEY NOT NULL,
            map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            color TEXT NOT NULL,
            visible INTEGER NOT NULL DEFAULT 1
          );
          CREATE TABLE IF NOT EXISTS locations (
            id TEXT PRIMARY KEY NOT NULL,
            map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            heading REAL NOT NULL DEFAULT 0,
            pitch REAL NOT NULL DEFAULT 0,
            zoom REAL NOT NULL DEFAULT 0,
            pano_id TEXT,
            created_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS location_tags (
            location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
            tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (location_id, tag_id)
          );
          CREATE INDEX IF NOT EXISTS idx_locations_map_id ON locations(map_id);
          CREATE INDEX IF NOT EXISTS idx_tags_map_id ON tags(map_id);
          CREATE INDEX IF NOT EXISTS idx_location_tags_location ON location_tags(location_id);
          CREATE INDEX IF NOT EXISTS idx_location_tags_tag ON location_tags(tag_id);"),
    (2, "DROP TABLE IF EXISTS location_tags;
          DROP TABLE IF EXISTS locations;
          DROP INDEX IF EXISTS idx_locations_map_id;
          DROP INDEX IF EXISTS idx_location_tags_location;
          DROP INDEX IF EXISTS idx_location_tags_tag;
          CREATE TABLE IF NOT EXISTS blobs (
            hash TEXT PRIMARY KEY NOT NULL,
            data TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS working_tree (
            map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
            geohash TEXT NOT NULL,
            blob_hash TEXT NOT NULL REFERENCES blobs(hash),
            location_count INTEGER NOT NULL,
            PRIMARY KEY (map_id, geohash)
          );
          CREATE TABLE IF NOT EXISTS commits (
            id TEXT PRIMARY KEY NOT NULL,
            map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
            parent_id TEXT,
            message TEXT,
            location_count INTEGER NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS commit_trees (
            commit_id TEXT NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
            geohash TEXT NOT NULL,
            blob_hash TEXT NOT NULL REFERENCES blobs(hash),
            location_count INTEGER NOT NULL,
            PRIMARY KEY (commit_id, geohash)
          );
          CREATE INDEX IF NOT EXISTS idx_working_tree_map ON working_tree(map_id);
          CREATE INDEX IF NOT EXISTS idx_commits_map ON commits(map_id);"),
    (3, "CREATE TABLE IF NOT EXISTS edit_history (
            map_id TEXT PRIMARY KEY NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
            undo_stack TEXT NOT NULL DEFAULT '[]',
            redo_stack TEXT NOT NULL DEFAULT '[]'
          );"),
    (4, "CREATE TABLE IF NOT EXISTS pano_date_cache (
            pano_id TEXT PRIMARY KEY NOT NULL,
            timestamp INTEGER NOT NULL
          );"),
    (5, "ALTER TABLE commits ADD COLUMN tree_hash TEXT;
          ALTER TABLE commits ADD COLUMN added INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE commits ADD COLUMN removed INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE commits ADD COLUMN modified INTEGER NOT NULL DEFAULT 0;"),
    (6, "ALTER TABLE tags ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;"),
    (7, "CREATE TABLE IF NOT EXISTS seen (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pano_id TEXT NOT NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            heading REAL NOT NULL,
            pitch REAL NOT NULL,
            zoom REAL NOT NULL,
            entered_at INTEGER NOT NULL,
            map_id TEXT,
            location_id TEXT,
            thumbnail BLOB
          );
          CREATE INDEX IF NOT EXISTS idx_seen_entered ON seen(entered_at DESC);"),
    (8, "DROP TABLE IF EXISTS seen;
          CREATE TABLE IF NOT EXISTS seen (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pano_id TEXT NOT NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            heading REAL NOT NULL,
            pitch REAL NOT NULL,
            zoom REAL NOT NULL,
            entered_at INTEGER NOT NULL,
            map_id TEXT,
            location_id TEXT,
            country_code TEXT,
            address TEXT,
            thumbnail TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_seen_entered ON seen(entered_at DESC);"),
    (9, "ALTER TABLE maps ADD COLUMN extra TEXT NOT NULL DEFAULT '{}';"),
    (10, "CREATE TABLE IF NOT EXISTS working_tree_new (
            map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
            geohash TEXT NOT NULL,
            blob_hash TEXT NOT NULL,
            location_count INTEGER NOT NULL,
            PRIMARY KEY (map_id, geohash)
          );
          INSERT INTO working_tree_new SELECT * FROM working_tree;
          DROP TABLE working_tree;
          ALTER TABLE working_tree_new RENAME TO working_tree;
          CREATE INDEX IF NOT EXISTS idx_working_tree_map ON working_tree(map_id);
          CREATE TABLE IF NOT EXISTS commit_trees_new (
            commit_id TEXT NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
            geohash TEXT NOT NULL,
            blob_hash TEXT NOT NULL,
            location_count INTEGER NOT NULL,
            PRIMARY KEY (commit_id, geohash)
          );
          INSERT INTO commit_trees_new SELECT * FROM commit_trees;
          DROP TABLE commit_trees;
          ALTER TABLE commit_trees_new RENAME TO commit_trees;
          DROP TABLE IF EXISTS blobs;"),
    (11, "ALTER TABLE maps ADD COLUMN location_count INTEGER NOT NULL DEFAULT 0;"),
    (12, "ALTER TABLE maps ADD COLUMN tags TEXT NOT NULL DEFAULT '{}';"),
    (13, "DROP TABLE IF EXISTS seen;
          CREATE TABLE seen (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pano_id TEXT NOT NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            heading REAL NOT NULL,
            pitch REAL NOT NULL,
            zoom REAL NOT NULL,
            entered_at INTEGER NOT NULL,
            map_id TEXT,
            location_id INTEGER,
            country_code TEXT,
            address TEXT,
            thumbnail TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_seen_entered ON seen(entered_at DESC);"),
    (14, "ALTER TABLE maps ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
          ALTER TABLE maps ADD COLUMN last_opened_at TEXT;"),
];

// ---------------------------------------------------------------------------
// Arrow IPC
// ---------------------------------------------------------------------------

pub(crate) fn arrow_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let subdir = if is_test_mode() { "arrow_test" } else { "arrow" };
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(subdir);
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

pub(crate) fn arrow_path(app: &tauri::AppHandle, map_id: &str) -> Result<std::path::PathBuf, String> {
    Ok(arrow_dir(app)?.join(format!("{map_id}.arrow")))
}

pub(crate) fn arrow_delta_path(app: &tauri::AppHandle, map_id: &str) -> Result<std::path::PathBuf, String> {
    Ok(arrow_dir(app)?.join(format!("{map_id}_delta.arrow")))
}

pub(crate) fn arrow_blobs_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = arrow_dir(app)?.join("blobs");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

pub(crate) fn blob_path(app: &tauri::AppHandle, hash: &str) -> Result<std::path::PathBuf, String> {
    Ok(arrow_blobs_dir(app)?.join(format!("{hash}.arrow")))
}

pub(crate) fn write_blob(app: &tauri::AppHandle, batch: &arrow::array::RecordBatch) -> Result<(String, usize), String> {
    let mut buf = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut buf);
        let mut writer = arrow::ipc::writer::FileWriter::try_new(cursor, &batch.schema())
            .map_err(|e| e.to_string())?;
        writer.write(batch).map_err(|e| e.to_string())?;
        writer.finish().map_err(|e| e.to_string())?;
    }
    let hash = sha256_hex(&buf);
    let path = blob_path(app, &hash)?;
    if !path.exists() {
        atomic_write(&path, |mut file| {
            use std::io::Write;
            file.write_all(&buf).map_err(|e| e.to_string())
        })?;
    }
    let rows = batch.num_rows();
    Ok((hash, rows))
}

pub(crate) fn read_blob(app: &tauri::AppHandle, hash: &str) -> Result<arrow::array::RecordBatch, String> {
    let path = blob_path(app, hash)?;
    read_arrow_ipc(&path)
}

pub(crate) fn write_arrow_ipc(path: &std::path::Path, batch: &arrow::array::RecordBatch) -> Result<(), String> {
    atomic_write(path, |file| {
        let buf = std::io::BufWriter::with_capacity(1 << 20, file);
        let mut writer = arrow::ipc::writer::FileWriter::try_new(buf, &batch.schema())
            .map_err(|e| e.to_string())?;
        writer.write(batch).map_err(|e| e.to_string())?;
        writer.finish().map_err(|e| e.to_string())?;
        Ok(())
    })
}

pub(crate) fn atomic_write(path: &std::path::Path, write_fn: impl FnOnce(std::fs::File) -> Result<(), String>) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    write_fn(file)?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn read_arrow_ipc(path: &std::path::Path) -> Result<arrow::array::RecordBatch, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = arrow::ipc::reader::FileReader::try_new(file, None)
        .map_err(|e| e.to_string())?;
    let mut batches = Vec::new();
    for batch in reader {
        batches.push(batch.map_err(|e| e.to_string())?);
    }
    if batches.is_empty() {
        return Ok(arrow::array::RecordBatch::new_empty(std::sync::Arc::new(
            arrow_bridge::location_schema(),
        )));
    }
    if batches.len() == 1 {
        return Ok(batches.into_iter().next().unwrap());
    }
    let schema = std::sync::Arc::new(arrow_bridge::location_schema());
    arrow::compute::concat_batches(&schema, &batches).map_err(|e| e.to_string())
}

/// Keeps the mmap alive for as long as the RecordBatch references it.
pub(crate) struct MmapHandle {
    _buffer: arrow::buffer::Buffer,
}

/// Zero-copy Arrow IPC read via memory-mapped file.
pub(crate) fn read_arrow_ipc_mmap(path: &std::path::Path) -> Result<(arrow::array::RecordBatch, MmapHandle), String> {
    use arrow::buffer::Buffer;
    use arrow::ipc::reader::{FileDecoder, read_footer_length};
    use arrow::ipc::{root_as_footer, convert::fb_to_schema};
    use std::sync::Arc;

    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    // SAFETY: we own the file exclusively; no other process modifies it while mapped.
    // On Windows, the mmap holds an exclusive lock preventing external modification.
    let mmap = unsafe { memmap2::Mmap::map(&file) }.map_err(|e| e.to_string())?;
    let buffer = Buffer::from(bytes::Bytes::from_owner(mmap));

    let buf_len = buffer.len();
    if buf_len < 10 {
        let schema = Arc::new(arrow_bridge::location_schema());
        return Ok((
            arrow::array::RecordBatch::new_empty(schema),
            MmapHandle { _buffer: buffer },
        ));
    }

    let trailer: [u8; 10] = buffer[buf_len - 10..].try_into().unwrap();
    let footer_len = read_footer_length(trailer)
        .map_err(|e| e.to_string())?;
    let footer = root_as_footer(&buffer[buf_len - 10 - footer_len..buf_len - 10])
        .map_err(|e| e.to_string())?;
    let schema = Arc::new(fb_to_schema(footer.schema().unwrap()));
    let mut decoder = FileDecoder::new(schema.clone(), footer.version());

    // Read dictionaries if present
    for block in footer.dictionaries().iter().flatten() {
        let block_len = block.bodyLength() as usize + block.metaDataLength() as usize;
        let data = buffer.slice_with_length(block.offset() as usize, block_len);
        decoder.read_dictionary(&block, &data).map_err(|e| e.to_string())?;
    }

    let blocks = footer.recordBatches();
    let blocks = blocks.as_ref();
    if blocks.map_or(true, |b| b.is_empty()) {
        return Ok((
            arrow::array::RecordBatch::new_empty(schema),
            MmapHandle { _buffer: buffer },
        ));
    }
    let blocks = blocks.unwrap();

    if blocks.len() == 1 {
        let block = blocks.get(0);
        let block_len = block.bodyLength() as usize + block.metaDataLength() as usize;
        let data = buffer.slice_with_length(block.offset() as usize, block_len);
        let batch = decoder.read_record_batch(&block, &data)
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| arrow::array::RecordBatch::new_empty(schema));
        Ok((batch, MmapHandle { _buffer: buffer }))
    } else {
        let mut batches = Vec::with_capacity(blocks.len());
        for i in 0..blocks.len() {
            let block = blocks.get(i);
            let block_len = block.bodyLength() as usize + block.metaDataLength() as usize;
            let data = buffer.slice_with_length(block.offset() as usize, block_len);
            if let Some(batch) = decoder.read_record_batch(&block, &data)
                .map_err(|e| e.to_string())? {
                batches.push(batch);
            }
        }
        let merged = arrow::compute::concat_batches(&schema, &batches)
            .map_err(|e| e.to_string())?;
        Ok((merged, MmapHandle { _buffer: buffer }))
    }
}


/// Returns msgpack map `{ undoStack: [...], redoStack: [...] }`.
// #[tauri::command]
// pub fn load_edit_history(app: tauri::AppHandle, map_id: String) -> Result<Response, String> {
//     let conn = open_db(&app)?;
//     let result = conn.query_row(
//         "SELECT undo_stack, redo_stack FROM edit_history WHERE map_id = ?1",
//         [&map_id],
//         |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?)),
//     );

//     match result {
//         Ok((undo, redo)) => {
//             let mut out = Vec::with_capacity(undo.len() + redo.len() + 32);
//             out.push(0x82); // fixmap 2
//             write_fixstr(&mut out, "undoStack");
//             out.extend_from_slice(&undo);
//             write_fixstr(&mut out, "redoStack");
//             out.extend_from_slice(&redo);
//             Ok(Response::new(out))
//         }
//         Err(rusqlite::Error::QueryReturnedNoRows) => {
//             let mut out = Vec::new();
//             out.push(0x82); // fixmap 2
//             write_fixstr(&mut out, "undoStack");
//             out.push(0x90); // fixarray 0
//             write_fixstr(&mut out, "redoStack");
//             out.push(0x90);
//             Ok(Response::new(out))
//         }
//         Err(e) => Err(e.to_string()),
//     }
// }

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(digest.len() * 2);
    for b in digest.iter() {
        use std::fmt::Write;
        write!(&mut s, "{:02x}", b).unwrap();
    }
    s
}

// #[derive(serde::Deserialize)]
// #[serde(rename_all = "camelCase")]
// struct SaveHistoryPayload {
//     map_id: String,
//     undo_stack: serde_json::Value,
//     redo_stack: serde_json::Value,
// }

/// Receive msgpack `{ mapId, undoStack, redoStack }`, re-encode each stack
/// as a separate msgpack blob, and write to edit_history.
// #[tauri::command]
// pub async fn save_edit_history(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
//     let body = raw_body(&request)?.to_vec();
//     let db_path = db_path(&app)?;
//     tokio::task::spawn_blocking(move || {
//         let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
//         let p: SaveHistoryPayload = rmp_serde::from_slice(&body).map_err(|e| e.to_string())?;
//         let undo = rmp_serde::to_vec(&p.undo_stack).map_err(|e| e.to_string())?;
//         let redo = rmp_serde::to_vec(&p.redo_stack).map_err(|e| e.to_string())?;
//         conn.execute(
//             "INSERT OR REPLACE INTO edit_history (map_id, undo_stack, redo_stack) VALUES (?1, ?2, ?3)",
//             rusqlite::params![p.map_id, undo, redo],
//         )
//         .map_err(|e| e.to_string())?;
//         Ok(())
//     }).await.map_err(|e| e.to_string())?
// }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn raw_body<'a>(req: &'a tauri::ipc::Request<'a>) -> Result<&'a [u8], String> {
    match req.body() {
        InvokeBody::Raw(b) => Ok(b),
        _ => Err("expected binary request body".into()),
    }
}


fn write_fixstr(out: &mut Vec<u8>, s: &str) {
    assert!(s.len() <= 31);
    out.push(0xa0 | s.len() as u8);
    out.extend_from_slice(s.as_bytes());
}

#[cfg(test)]
#[path = "fast_io.test.rs"]
mod tests;
