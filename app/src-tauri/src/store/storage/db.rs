//! SQLite: connections, pragmas, the migration registry, row helpers.

use super::*;
use crate::store::maps::MapMeta;
use crate::types::AppResult;
use crate::util::now_iso;
use mma_algebra::{Counts, Id, Patchable};
use rusqlite::types::FromSql;
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, Row};
use serde::de::DeserializeOwned;
use std::collections::HashSet;
use std::fs;
use std::time::Duration;
use tokio::task;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Column {
    pub name: &'static str,
    pub sql_type: &'static str,
    pub nullable: bool,
    pub primary_key: bool,
    pub default: Option<&'static str>,
}

pub(crate) trait SqlType {
    const SQL_TYPE: &'static str;
    const NULLABLE: bool = false;
}

impl<T, Raw: SqlType> SqlType for Id<T, Raw> {
    const SQL_TYPE: &'static str = Raw::SQL_TYPE;
}

pub(crate) fn id_col<T, Raw: FromSql>(row: &Row, col: &str) -> rusqlite::Result<Id<T, Raw>> {
    row.get(col).map(Id::new)
}

macro_rules! sql_types {
    ($($ty:ty => $sql:literal),* $(,)?) => { $(impl SqlType for $ty { const SQL_TYPE: &'static str = $sql; })* };
}
sql_types!(String => "TEXT", u32 => "INTEGER", i64 => "INTEGER", bool => "INTEGER", f64 => "REAL");
impl<T: SqlType> SqlType for Option<T> {
    const SQL_TYPE: &'static str = T::SQL_TYPE;
    const NULLABLE: bool = true;
}

pub(crate) const fn sql_column<R, T: SqlType>(
    name: &'static str,
    _: fn(&R) -> &T,
    primary_key: bool,
    default: Option<&'static str>,
) -> Column {
    Column {
        name,
        sql_type: T::SQL_TYPE,
        nullable: T::NULLABLE,
        primary_key,
        default,
    }
}

/// Deserialize a JSON text column from a SQLite row, falling back to `T::default()`
/// on parse failure (forward-compatible with schema evolution).
pub(crate) fn json_col<T: Default + DeserializeOwned>(row: &Row, col: &str) -> rusqlite::Result<T> {
    let s: String = row.get(col)?;
    Ok(serde_json::from_str(&s).unwrap_or_default())
}

/// A stored row that carries the time its values last changed.
pub(crate) trait Stamped {
    fn updated_at(&self) -> &str;
    fn stamp(&mut self, at: String);
}

/// Persist `row` with `patch` applied, stamped as changed now, and return what was stored.
pub(crate) fn patch_row<T: Patchable + Stamped + serde::Serialize>(
    conn: &Connection,
    table: &str,
    id: &str,
    row: &T,
    patch: &T::Patch,
) -> AppResult<T> {
    let mut next = row.patched(patch);
    next.stamp(now_iso());
    update_row(conn, table, id, &next)?;
    Ok(next)
}

/// Persist a row's writable values and the time it says they last changed.
pub(crate) fn update_row<T: Patchable + Stamped + serde::Serialize>(
    conn: &Connection,
    table: &str,
    id: &str,
    row: &T,
) -> AppResult<()> {
    let serde_json::Value::Object(set) = serde_json::to_value(row)? else {
        return Ok(());
    };
    let mut sets: Vec<String> = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();
    for (key, column) in T::WRITES {
        let Some(value) = set.get(*key) else {
            continue;
        };
        sets.push(format!("{column} = ?"));
        values.push(match value {
            serde_json::Value::Null => SqlValue::Null,
            serde_json::Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
            serde_json::Value::Number(n) => n.as_i64().map_or_else(
                || SqlValue::Real(n.as_f64().unwrap_or_default()),
                SqlValue::Integer,
            ),
            serde_json::Value::String(s) => SqlValue::Text(s.clone()),
            json => SqlValue::Text(json.to_string()),
        });
    }
    if sets.is_empty() {
        return Ok(());
    }
    values.push(SqlValue::Text(row.updated_at().to_string()));
    values.push(SqlValue::Text(id.to_string()));
    let sql = format!(
        "UPDATE {table} SET {}, updated_at = ? WHERE id = ?",
        sets.join(", ")
    );
    conn.execute(&sql, rusqlite::params_from_iter(values))?;
    Ok(())
}

/// Run `f` with a fresh database connection on a blocking thread.
pub(crate) async fn with_db<T: Send + 'static>(
    f: impl FnOnce(&mut Connection) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    task::spawn_blocking(move || f(&mut open_db()?)).await?
}

pub(crate) fn open_db() -> AppResult<Connection> {
    let path = db_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("failed to create app data dir: {e}"))?;
    }
    let conn = Connection::open(path)?;
    configure_connection(&conn)?;
    Ok(conn)
}

/// Per-connection setup applied to every open. FK enforcement is per-connection and
/// defaults OFF in SQLite; without it every ON DELETE CASCADE in the schema is dead.
pub(super) fn configure_connection(conn: &Connection) -> AppResult<()> {
    // Default busy timeout is 0: any write-lock contention (second window, lingering
    // process) fails instantly with "database is locked" instead of waiting.
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "foreign_keys", true)?;
    Ok(())
}

/// A map's changes since the last commit, as last recorded by [`set_map_counts`].
pub(crate) fn map_pending(conn: &Connection, map_id: &Id<MapMeta, String>) -> AppResult<Counts> {
    Ok(conn.query_row(
        "SELECT pending_added, pending_removed, pending_modified FROM maps WHERE id = ?1",
        [map_id.raw()],
        |row| {
            Ok(Counts {
                added: row.get(0)?,
                removed: row.get(1)?,
                updated: row.get(2)?,
            })
        },
    )?)
}

/// Record a map's live location count and its changes since the last commit, together,
/// so the map list never shows one without the other.
pub(crate) fn set_map_counts(
    conn: &Connection,
    map_id: &Id<MapMeta, String>,
    count: usize,
    pending: Counts,
) -> AppResult<()> {
    conn.execute(
        "UPDATE maps SET location_count = ?1, pending_added = ?2, pending_removed = ?3, pending_modified = ?4 WHERE id = ?5",
        rusqlite::params![count, pending.added, pending.removed, pending.updated, map_id.raw()],
    )?;
    Ok(())
}

/// Apply all pending schema migrations from [`MIGRATIONS`] in order.
/// Sets WAL mode and foreign keys as part of the connection setup.
pub(crate) fn run_migrations() -> AppResult<()> {
    let conn = open_db()?;
    let wiped_blobs = run_migrations_on(&conn)?;

    if wiped_blobs {
        let blobs = arrow_dir()?.join("blobs");
        if blobs.exists() {
            if let Err(e) = fs::remove_dir_all(&blobs) {
                log::warn!("[migrations] failed to remove old blob store {blobs:?}: {e}");
            } else {
                log::info!("[migrations] removed retired blob store {blobs:?}");
            }
        }
    }
    Ok(())
}

/// Run the migration chain against an arbitrary connection. Returns whether v16
/// was newly applied (the caller owns the retired blob-store cleanup).
pub(crate) fn run_migrations_on(conn: &Connection) -> AppResult<bool> {
    conn.execute_batch(
        "
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
    ",
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS _mma_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
        [],
    )?;

    let applied: HashSet<u32> = conn
        .prepare("SELECT version FROM _mma_migrations")?
        .query_map([], |row| row.get(0))?
        .filter_map(Result::ok)
        .collect();

    let mut wiped_blobs = false;
    for (version, sql) in MIGRATIONS {
        if applied.contains(version) {
            continue;
        }
        log::info!("[migrations] applying v{version}");
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)
            .map_err(|e| format!("migration v{version} failed: {e}"))?;
        tx.execute(
            "INSERT INTO _mma_migrations (version, applied_at) VALUES (?1, datetime('now'))",
            rusqlite::params![version],
        )?;
        tx.commit()?;
        if *version == 16 {
            wiped_blobs = true;
        }
    }

    // auto_vacuum must be set before the DB has data, or toggled with a one-time VACUUM.
    let auto_vacuum: i32 = conn.pragma_query_value(None, "auto_vacuum", |r| r.get(0))?;
    if auto_vacuum != 1 {
        log::info!("[migrations] enabling auto_vacuum");
        conn.pragma_update(None, "auto_vacuum", 1)?;
        conn.execute_batch("VACUUM")?;
    }

    Ok(wiped_blobs)
}

pub(super) const MIGRATIONS: &[(u32, &str)] = &[
    (
        1,
        "CREATE TABLE IF NOT EXISTS maps (
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
          CREATE INDEX IF NOT EXISTS idx_location_tags_tag ON location_tags(tag_id);",
    ),
    (
        2,
        "DROP TABLE IF EXISTS location_tags;
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
          CREATE INDEX IF NOT EXISTS idx_commits_map ON commits(map_id);",
    ),
    (
        3,
        "CREATE TABLE IF NOT EXISTS edit_history (
            map_id TEXT PRIMARY KEY NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
            undo_stack TEXT NOT NULL DEFAULT '[]',
            redo_stack TEXT NOT NULL DEFAULT '[]'
          );",
    ),
    (
        4,
        "CREATE TABLE IF NOT EXISTS pano_date_cache (
            pano_id TEXT PRIMARY KEY NOT NULL,
            timestamp INTEGER NOT NULL
          );",
    ),
    (
        5,
        "ALTER TABLE commits ADD COLUMN tree_hash TEXT;
          ALTER TABLE commits ADD COLUMN added INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE commits ADD COLUMN removed INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE commits ADD COLUMN modified INTEGER NOT NULL DEFAULT 0;",
    ),
    (
        6,
        "ALTER TABLE tags ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;",
    ),
    (
        7,
        "CREATE TABLE IF NOT EXISTS seen (
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
          CREATE INDEX IF NOT EXISTS idx_seen_entered ON seen(entered_at DESC);",
    ),
    (
        8,
        "DROP TABLE IF EXISTS seen;
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
          CREATE INDEX IF NOT EXISTS idx_seen_entered ON seen(entered_at DESC);",
    ),
    (
        9,
        "ALTER TABLE maps ADD COLUMN extra TEXT NOT NULL DEFAULT '{}';",
    ),
    (
        10,
        "CREATE TABLE IF NOT EXISTS working_tree_new (
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
          DROP TABLE IF EXISTS blobs;",
    ),
    (
        11,
        "ALTER TABLE maps ADD COLUMN location_count INTEGER NOT NULL DEFAULT 0;",
    ),
    (
        12,
        "ALTER TABLE maps ADD COLUMN tags TEXT NOT NULL DEFAULT '{}';",
    ),
    (
        13,
        "DROP TABLE IF EXISTS seen;
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
          CREATE INDEX IF NOT EXISTS idx_seen_entered ON seen(entered_at DESC);",
    ),
    (
        14,
        "ALTER TABLE maps ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
          ALTER TABLE maps ADD COLUMN last_opened_at TEXT;",
    ),
    (15, "DROP TABLE IF EXISTS pano_date_cache;"),
    (
        16,
        "DROP TABLE IF EXISTS commit_trees;
          DROP TABLE IF EXISTS working_tree;
          DELETE FROM commits;",
    ),
    (
        17,
        "CREATE TABLE IF NOT EXISTS review_sessions (
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
          CREATE INDEX IF NOT EXISTS idx_review_sessions_map ON review_sessions(map_id, status);",
    ),
    (
        18,
        "DROP TABLE IF EXISTS tags;
          DROP INDEX IF EXISTS idx_tags_map_id;",
    ),
    (
        19,
        "CREATE TABLE IF NOT EXISTS remote_mapping (
            provider   TEXT    NOT NULL,
            map_id     TEXT    NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
            local_id   INTEGER NOT NULL,
            remote_id  INTEGER NOT NULL,
            hash       TEXT    NOT NULL,
            PRIMARY KEY (provider, map_id, local_id)
          );
          CREATE INDEX IF NOT EXISTS idx_remote_mapping_remote ON remote_mapping(provider, map_id, remote_id);",
    ),
    (
        20,
        "CREATE INDEX IF NOT EXISTS idx_seen_country ON seen(country_code);
          CREATE INDEX IF NOT EXISTS idx_seen_map ON seen(map_id);",
    ),
    (
        21,
        "CREATE TABLE IF NOT EXISTS saved_selections (
            id         TEXT PRIMARY KEY NOT NULL,
            name       TEXT NOT NULL,
            selector   TEXT NOT NULL,
            tag_names  TEXT NOT NULL DEFAULT '{}',
            color      TEXT NOT NULL,
            created_at TEXT NOT NULL
          );",
    ),
    (
        22,
        "ALTER TABLE maps ADD COLUMN pending_added INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE maps ADD COLUMN pending_removed INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE maps ADD COLUMN pending_modified INTEGER NOT NULL DEFAULT 0;",
    ),
    (
        23,
        "CREATE TABLE IF NOT EXISTS sync_log (
            id         INTEGER PRIMARY KEY,
            map_id     TEXT    NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
            provider   TEXT    NOT NULL,
            started_at INTEGER NOT NULL,
            entry      TEXT    NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_sync_log_map ON sync_log(map_id, provider, started_at);",
    ),
    (
        24,
        "CREATE TABLE IF NOT EXISTS map_defaults (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            preferences TEXT NOT NULL
          );",
    ),
    (
        25,
        "CREATE TABLE IF NOT EXISTS edit_entries (
            map_id TEXT    NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
            seq    INTEGER NOT NULL,
            stack  INTEGER NOT NULL,
            max_id INTEGER NOT NULL,
            entry  BLOB    NOT NULL,
            PRIMARY KEY (map_id, seq)
          );
          DROP TABLE IF EXISTS edit_history;",
    ),
    (26, "DELETE FROM edit_entries;"),
    (
        27,
        "ALTER TABLE edit_entries ADD COLUMN piles TEXT;
          DELETE FROM edit_entries;",
    ),
    (28, "ALTER TABLE edit_entries RENAME COLUMN piles TO parts;"),
    (29, "ALTER TABLE commits DROP COLUMN tree_hash;"),
    (
        30,
        "CREATE TABLE IF NOT EXISTS value_records (
            map_id  TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
            field   TEXT NOT NULL,
            records TEXT NOT NULL,
            PRIMARY KEY (map_id, field)
          );
          INSERT INTO value_records (map_id, field, records)
            SELECT id, 'tags', tags FROM maps WHERE tags NOT IN ('', '{}');
          ALTER TABLE maps DROP COLUMN tags;",
    ),
    (
        31,
        "ALTER TABLE saved_selections ADD COLUMN value_names TEXT NOT NULL DEFAULT '{}';
          UPDATE saved_selections SET value_names = '{\"tags\":' || tag_names || '}'
            WHERE tag_names NOT IN ('', '{}');
          ALTER TABLE saved_selections DROP COLUMN tag_names;",
    ),
];
