//! Persistence layer: SQLite metadata database and Arrow IPC file I/O.
//!
//! All disk writes use [`atomic_write`] (temp-file-then-rename) to prevent
//! corruption on crash. Arrow IPC writes go through [`BufWriter`](std::io::BufWriter)
//! because unbuffered `File` writes are ~15x slower.

use crate::types::{AppError, AppResult};
use rusqlite::Connection;
use tauri::ipc::InvokeBody;
use tauri::Manager;
use crate::arrow_bridge;

/// True when running under e2e tests or with `MMA_TEST_DB` set.
/// Controls which database file and Arrow directory are used, keeping
/// test data isolated from production.
pub fn is_test_mode() -> bool {
    cfg!(feature = "e2e") || std::env::var("MMA_TEST_DB").is_ok()
}

/// Returns `"mma_test.db"` in test mode, `"mma.db"` otherwise.
pub fn db_filename() -> &'static str {
    if is_test_mode() { "mma_test.db" } else { "mma.db" }
}

/// Process-constant directories, resolved once at startup. Lets every path helper
/// (db, arrow, plugins, temp) be zero-arg instead of threading an `AppHandle`
/// through functions whose only use for it is path resolution.
static APP_DATA_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
static TEMP_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Resolve and cache the data/temp directories. Called once from `setup()`,
/// before anything touches disk.
pub(crate) fn init_paths(app: &tauri::AppHandle) -> AppResult<()> {
    let _ = APP_DATA_DIR.set(app.path().app_data_dir().map_err(AppError::from)?);
    let _ = TEMP_DIR.set(app.path().temp_dir().map_err(AppError::from)?);
    Ok(())
}

/// The app data directory. Errors if `init_paths` has not run.
pub(crate) fn app_data_dir() -> AppResult<std::path::PathBuf> {
    APP_DATA_DIR.get().cloned().ok_or_else(|| AppError::from("app paths not initialized".to_string()))
}

/// The OS temp directory (resolved via Tauri at startup).
pub(crate) fn temp_dir() -> AppResult<std::path::PathBuf> {
    TEMP_DIR.get().cloned().ok_or_else(|| AppError::from("app paths not initialized".to_string()))
}

/// Full path to the SQLite database.
pub(crate) fn db_path() -> AppResult<std::path::PathBuf> {
    Ok(app_data_dir()?.join(db_filename()))
}

/// Open (or create) the SQLite database, ensuring the parent directory exists.
/// The one place that owns per-connection setup (busy timeout, future pragmas).
pub(crate) fn open_db() -> AppResult<Connection> {
    let path = db_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("failed to create app data dir: {e}"))?;
    }
    let conn = Connection::open(path)?;
    // Default busy timeout is 0: any write-lock contention (second window, lingering
    // process) fails instantly with "database is locked" instead of waiting.
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(conn)
}

/// Apply all pending schema migrations from [`MIGRATIONS`] in order.
///
/// On first run after migrating from the old `tauri-plugin-sql` system, seeds
/// already-applied versions from `_sqlx_migrations` so they aren't replayed.
/// Sets WAL mode and foreign keys as part of the connection setup.
pub(crate) fn run_migrations() -> AppResult<()> {
    let conn = open_db()?;
    conn.execute_batch("
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
    ")?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS _mma_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
        [],
    )?;

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
        .prepare("SELECT version FROM _mma_migrations")?
        .query_map([], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();

    let mut wiped_blobs = false;
    for (version, sql) in MIGRATIONS {
        if applied.contains(version) { continue; }
        log::info!("[migrations] applying v{version}");
        conn.execute_batch(sql).map_err(|e| format!("migration v{version} failed: {e}"))?;
        conn.execute(
            "INSERT INTO _mma_migrations (version, applied_at) VALUES (?1, datetime('now'))",
            rusqlite::params![version],
        )?;
        if *version == 16 { wiped_blobs = true; }
    }

    // The delta-chain migration (v16) retires the geohash blob store. Reclaim its disk
    // once, when v16 first applies.
    if wiped_blobs {
        let blobs = arrow_dir()?.join("blobs");
        if blobs.exists() {
            if let Err(e) = std::fs::remove_dir_all(&blobs) {
                log::warn!("[migrations] failed to remove old blob store {blobs:?}: {e}");
            } else {
                log::info!("[migrations] removed retired blob store {blobs:?}");
            }
        }
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
    (15, "DROP TABLE IF EXISTS pano_date_cache;"),
    (16, "DROP TABLE IF EXISTS commit_trees;
          DROP TABLE IF EXISTS working_tree;
          DELETE FROM commits;"),
    (17, "CREATE TABLE IF NOT EXISTS review_sessions (
            id           TEXT PRIMARY KEY NOT NULL,
            map_id       TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
            name         TEXT NOT NULL DEFAULT '',
            source_key   TEXT NOT NULL,
            source_props TEXT NOT NULL DEFAULT '{}',
            ordering     TEXT NOT NULL,
            reviewed     TEXT NOT NULL DEFAULT '[]',
            cursor_id    INTEGER NOT NULL,
            status       TEXT NOT NULL DEFAULT 'active',
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_review_sessions_map ON review_sessions(map_id, status);"),
];

// ---------------------------------------------------------------------------
// Arrow IPC
// ---------------------------------------------------------------------------

/// Root directory for all Arrow IPC files (`arrow/` or `arrow_test/`).
/// Created on first access.
pub(crate) fn arrow_dir() -> AppResult<std::path::PathBuf> {
    let subdir = if is_test_mode() { "arrow_test" } else { "arrow" };
    let dir = app_data_dir()?.join(subdir);
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
    }
    Ok(dir)
}

/// Path to a map's base Arrow IPC snapshot: `<arrow_dir>/<map_id>.arrow`.
pub(crate) fn arrow_path(map_id: &str) -> AppResult<std::path::PathBuf> {
    Ok(arrow_dir()?.join(format!("{map_id}.arrow")))
}

/// Path to a map's uncommitted delta file: `<arrow_dir>/<map_id>_delta.arrow`.
/// Contains overlay mutations not yet baked into the base snapshot.
pub(crate) fn arrow_delta_path(map_id: &str) -> AppResult<std::path::PathBuf> {
    Ok(arrow_dir()?.join(format!("{map_id}_delta.arrow")))
}

/// Directory holding a map's per-commit VCS delta files. Created on first access.
pub(crate) fn commit_dir(map_id: &str) -> AppResult<std::path::PathBuf> {
    let dir = arrow_dir()?.join("commits").join(map_id);
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
    }
    Ok(dir)
}

/// Path to a single commit's Arrow delta file: `<arrow_dir>/commits/<map_id>/<commit_id>.arrow`.
pub(crate) fn commit_delta_path(map_id: &str, commit_id: &str) -> AppResult<std::path::PathBuf> {
    Ok(commit_dir(map_id)?.join(format!("{commit_id}.arrow")))
}

/// Atomically write a RecordBatch to an Arrow IPC file.
///
/// Uses a 1 MB `BufWriter` (unbuffered writes are ~15x slower on Windows).
/// The write targets a `.tmp` sibling then renames, so readers never see
/// a partial file.
pub(crate) fn write_arrow_ipc(path: &std::path::Path, batch: &arrow::array::RecordBatch) -> AppResult<()> {
    atomic_write(path, |file| {
        let buf = std::io::BufWriter::with_capacity(1 << 20, file);
        let mut writer = arrow::ipc::writer::FileWriter::try_new(buf, &batch.schema())?;
        writer.write(batch)?;
        writer.finish()?;
        Ok(())
    })
}

/// Write to `path` via a temporary `.tmp` sibling, then atomically rename.
/// Guarantees readers never observe a partially-written file.
pub(crate) fn atomic_write(path: &std::path::Path, write_fn: impl FnOnce(std::fs::File) -> AppResult<()>) -> AppResult<()> {
    let tmp = path.with_extension("tmp");
    let file = std::fs::File::create(&tmp)?;
    write_fn(file)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Read an Arrow IPC file into a single RecordBatch.
///
/// If the file contains multiple batches they are concatenated. An empty or
/// missing-batch file returns an empty batch with the location schema.
pub(crate) fn read_arrow_ipc(path: &std::path::Path) -> AppResult<arrow::array::RecordBatch> {
    let file = std::fs::File::open(path)?;
    let reader = arrow::ipc::reader::FileReader::try_new(file, None)?;
    let mut batches = Vec::new();
    for batch in reader {
        batches.push(crate::arrow_migrate::migrate(batch?)?);
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
    arrow::compute::concat_batches(&schema, &batches).map_err(AppError::from)
}

/// Keeps the mmap alive for as long as the RecordBatch references it.
pub(crate) struct MmapHandle {
    _buffer: arrow::buffer::Buffer,
}

/// Zero-copy Arrow IPC read via memory-mapped file.
///
/// Returns the batch alongside an [`MmapHandle`] that must be kept alive for
/// as long as any array data from the batch is referenced. Parses the IPC
/// footer and record-batch blocks directly from the mmap buffer, avoiding
/// any heap allocation for the raw column data.
pub(crate) fn read_arrow_ipc_mmap(path: &std::path::Path) -> AppResult<(arrow::array::RecordBatch, MmapHandle)> {
    use arrow::buffer::Buffer;
    use arrow::ipc::reader::{FileDecoder, read_footer_length};
    use arrow::ipc::{root_as_footer, convert::fb_to_schema};
    use std::sync::Arc;

    let file = std::fs::File::open(path)?;
    // SAFETY: we own the file exclusively; no other process modifies it while mapped.
    // On Windows, the mmap holds an exclusive lock preventing external modification.
    let mmap = unsafe { memmap2::Mmap::map(&file) }?;
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
    let footer_len = read_footer_length(trailer)?;
    let footer = root_as_footer(&buffer[buf_len - 10 - footer_len..buf_len - 10]).map_err(|e| AppError(e.to_string()))?;
    let schema = Arc::new(fb_to_schema(footer.schema().unwrap()));
    let mut decoder = FileDecoder::new(schema.clone(), footer.version());

    // Read dictionaries if present
    for block in footer.dictionaries().iter().flatten() {
        let block_len = block.bodyLength() as usize + block.metaDataLength() as usize;
        let data = buffer.slice_with_length(block.offset() as usize, block_len);
        decoder.read_dictionary(&block, &data)?;
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
        let batch = decoder.read_record_batch(&block, &data)?
            .unwrap_or_else(|| arrow::array::RecordBatch::new_empty(schema));
        Ok((crate::arrow_migrate::migrate(batch)?, MmapHandle { _buffer: buffer }))
    } else {
        let mut batches = Vec::with_capacity(blocks.len());
        for i in 0..blocks.len() {
            let block = blocks.get(i);
            let block_len = block.bodyLength() as usize + block.metaDataLength() as usize;
            let data = buffer.slice_with_length(block.offset() as usize, block_len);
            if let Some(batch) = decoder.read_record_batch(&block, &data)? {
                batches.push(batch);
            }
        }
        let merged = arrow::compute::concat_batches(&schema, &batches)?;
        Ok((crate::arrow_migrate::migrate(merged)?, MmapHandle { _buffer: buffer }))
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Extract the raw binary body from a Tauri IPC request, or error if the
/// body is JSON rather than binary.
fn raw_body<'a>(req: &'a tauri::ipc::Request<'a>) -> AppResult<&'a [u8]> {
    match req.body() {
        InvokeBody::Raw(b) => Ok(b),
        _ => Err("expected binary request body".into()),
    }
}


/// Append a msgpack fixstr (up to 31 bytes) to `out`. Panics if `s` exceeds 31 bytes.
fn write_fixstr(out: &mut Vec<u8>, s: &str) {
    assert!(s.len() <= 31);
    out.push(0xa0 | s.len() as u8);
    out.extend_from_slice(s.as_bytes());
}

#[cfg(test)]
#[path = "storage.test.rs"]
mod tests;
