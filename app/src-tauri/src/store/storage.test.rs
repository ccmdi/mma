use super::*;
use crate::selections::saved;
use crate::store::arrow::{read_arrow_ipc, read_arrow_ipc_mmap, write_arrow_ipc};
use crate::store::maps;
use crate::store::maps::MapMeta;
use crate::store::{arrow, engine};
use crate::test_util::{tag_ids, TempDir};
use crate::types::{AppError, ErrCode, Location, LocationFlags};
use crate::util;
use crate::util::sha256_hex;
use mma_algebra::{Counts, Id};
use rusqlite::Connection;
use std::collections::{BTreeSet, HashSet};
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::Once;
use std::{env, fs, panic};

/// A map row in a migrated database under a data folder this test process owns, for tests
/// that open and save maps the way the app does.
pub(crate) fn map_on_disk(id: &str) -> Id<MapMeta, String> {
    static DISK: Once = Once::new();
    DISK.call_once(|| {
        let dir = env::temp_dir().join("mma_unit_disk");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        APP_DATA_DIR.set(dir).unwrap();
        run_migrations_on(&open_db().unwrap()).unwrap();
    });
    open_db()
        .unwrap()
        .execute(
            "INSERT INTO maps (id, name, settings, created_at, updated_at) VALUES (?1, ?1, '{}', '', '')",
            [id],
        )
        .unwrap();
    Id::new(id.into())
}

fn sample_loc() -> Location {
    Location {
        id: Id::new(42),
        lat: 48.8566,
        lng: 2.3522,
        heading: 90.0,
        pitch: 5.0,
        zoom: 1.5,
        pano_id: Some("CAoSLEF".into()),
        flags: LocationFlags::LOAD_AS_PANO_ID,
        tags: tag_ids([1, 2, 3]),
        extra: Some(serde_json::from_str(r#"{"country":"FR"}"#).unwrap()),
        created_at: util::iso_to_unix("2024-01-15T10:30:00Z").unwrap() as u32,
        modified_at: Some(util::iso_to_unix("2024-01-15T11:00:00Z").unwrap() as u32),
    }
}

#[test]
fn location_data_serde_round_trip() {
    let loc = sample_loc();
    let json = serde_json::to_string(&loc).unwrap();
    let restored: Location = serde_json::from_str(&json).unwrap();
    assert_eq!(loc, restored);
}

#[test]
fn timestamps_serialize_as_numbers_not_iso() {
    let loc = sample_loc();
    let v: serde_json::Value = serde_json::to_value(&loc).unwrap();
    assert!(
        v["createdAt"].is_number(),
        "createdAt must reach JS as a number, not ISO"
    );
    assert!(
        v["modifiedAt"].is_number(),
        "modifiedAt must reach JS as a number, not ISO"
    );
}

#[test]
fn location_data_null_optionals() {
    let loc = Location {
        id: Id::new(1),
        ..Default::default()
    };
    let json = serde_json::to_string(&loc).unwrap();
    assert!(json.contains(r#""extra":null"#));
    assert!(json.contains(r#""modifiedAt":null"#));
    let restored: Location = serde_json::from_str(&json).unwrap();
    assert_eq!(loc, restored);
}

#[test]
fn location_data_id_defaults_to_zero() {
    let json = r#"{"id":0,"lat":0,"lng":0,"heading":0,"pitch":0,"zoom":0,"panoId":null,"flags":0,"tags":[],"extra":null,"createdAt":0,"modifiedAt":null}"#;
    let loc: Location = serde_json::from_str(json).unwrap();
    assert_eq!(loc.id, Id::new(0));
}

// -----------------------------------------------------------------------
// Connection setup
// -----------------------------------------------------------------------

// The bundled sqlite happens to compile with SQLITE_DEFAULT_FOREIGN_KEYS=1, but the
// invariant must not depend on a dependency's build flag (system sqlite defaults OFF).
#[test]
fn an_opened_database_enforces_foreign_keys() {
    let map = map_on_disk("fk-cascade");
    let conn = open_db().unwrap();
    let fk: i32 = conn
        .pragma_query_value(None, "foreign_keys", |r| r.get(0))
        .unwrap();
    assert_eq!(fk, 1);

    conn.execute(
        "INSERT INTO review_sessions (id, map_id, source_key, ordering, cursor_id, created_at, updated_at)
         VALUES ('fk-cascade-session', ?1, 'k', '[1]', 1, '', '')",
        [map.raw()],
    )
    .unwrap();
    conn.execute("DELETE FROM maps WHERE id = ?1", [map.raw()])
        .unwrap();
    let orphans: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM review_sessions WHERE map_id = ?1",
            [map.raw()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        orphans, 0,
        "ON DELETE CASCADE must fire on opened connections"
    );
}

#[test]
fn sha256_hex_deterministic() {
    let a = sha256_hex(b"hello");
    let b = sha256_hex(b"hello");
    assert_eq!(a, b);
}

#[test]
fn sha256_hex_length() {
    let h = sha256_hex(b"test");
    assert_eq!(h.len(), 64);
}

#[test]
fn sha256_hex_known_value() {
    // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    let h = sha256_hex(b"");
    assert_eq!(
        h,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn sha256_hex_differs_for_different_input() {
    assert_ne!(sha256_hex(b"hello"), sha256_hex(b"world"));
}

// -----------------------------------------------------------------------
// Data-folder override pointer
// -----------------------------------------------------------------------

#[test]
fn parse_data_location_trims_and_rejects_empty() {
    assert_eq!(parse_data_location(""), None);
    assert_eq!(parse_data_location("   \n\t "), None);
    assert_eq!(
        parse_data_location("  D:/maps  \n"),
        Some(PathBuf::from("D:/maps"))
    );
}

#[test]
fn read_data_location_override_round_trip() {
    let cfg = TempDir::new("mma_test_dataloc_cfg");
    let target = TempDir::slot("mma_test_dataloc_target");

    // Absent pointer -> no override.
    assert_eq!(read_data_location_override(&cfg), None);

    // Written pointer to a valid (creatable) folder -> that folder, and it now exists.
    fs::write(
        cfg.join(DATA_LOCATION_FILE),
        target.to_string_lossy().as_bytes(),
    )
    .unwrap();
    assert_eq!(
        read_data_location_override(&cfg),
        Some(target.to_path_buf())
    );
    assert!(target.exists());

    // Empty pointer -> no override.
    fs::write(cfg.join(DATA_LOCATION_FILE), b"").unwrap();
    assert_eq!(read_data_location_override(&cfg), None);
}

// -----------------------------------------------------------------------
// Arrow IPC mmap round-trip
// -----------------------------------------------------------------------

fn make_test_batch(ids: &[u32]) -> arrow_array::RecordBatch {
    let locs: Vec<Location> = ids
        .iter()
        .map(|&id| Location {
            id: Id::new(id),
            lat: id as f64,
            lng: id as f64 * 2.0,
            zoom: 1.0,
            pano_id: Some(format!("pano_{id}").into()),
            tags: tag_ids([1]),
            created_at: util::iso_to_unix("2024-01-01T00:00:00Z").unwrap() as u32,
            ..Default::default()
        })
        .collect();
    arrow::locations_to_batch(&locs)
}

#[test]
fn mmap_round_trip_preserves_data() {
    let batch = make_test_batch(&[1, 2, 3]);
    let dir = TempDir::new("mma_test_mmap");
    let path = dir.join("round_trip.arrow");

    write_arrow_ipc(&path, &batch).unwrap();
    let (loaded, _handle) = read_arrow_ipc_mmap(&path).unwrap();

    assert_eq!(loaded.num_rows(), 3);
    let ids = loaded
        .column(0)
        .as_any()
        .downcast_ref::<arrow_array::UInt32Array>()
        .unwrap();
    assert_eq!(ids.value(0), 1);
    assert_eq!(ids.value(1), 2);
    assert_eq!(ids.value(2), 3);
    let lats = loaded
        .column(1)
        .as_any()
        .downcast_ref::<arrow_array::Float64Array>()
        .unwrap();
    assert_eq!(lats.value(0), 1.0);
    assert_eq!(lats.value(1), 2.0);
    assert_eq!(lats.value(2), 3.0);
}

#[test]
fn mmap_empty_file() {
    let batch = arrow::locations_to_batch(&[]);
    let dir = TempDir::new("mma_test_mmap_empty");
    let path = dir.join("empty.arrow");

    write_arrow_ipc(&path, &batch).unwrap();
    let (loaded, _handle) = read_arrow_ipc_mmap(&path).unwrap();
    assert_eq!(loaded.num_rows(), 0);
}

#[test]
fn mmap_matches_heap_read() {
    let batch = make_test_batch(&[10, 20, 30, 40, 50]);
    let dir = TempDir::new("mma_test_mmap_cmp");
    let path = dir.join("compare.arrow");

    write_arrow_ipc(&path, &batch).unwrap();
    let heap = read_arrow_ipc(&path).unwrap();
    let (mmap, _handle) = read_arrow_ipc_mmap(&path).unwrap();

    assert_eq!(heap.num_rows(), mmap.num_rows());
    for col in 0..heap.num_columns() {
        assert_eq!(
            heap.column(col).as_ref(),
            mmap.column(col).as_ref(),
            "column {col} mismatch between heap and mmap read"
        );
    }
}

#[test]
fn mmap_handle_drop_allows_overwrite() {
    let dir = TempDir::new("mma_test_mmap_drop");
    let path = dir.join("overwrite.arrow");

    let batch1 = make_test_batch(&[1, 2]);
    write_arrow_ipc(&path, &batch1).unwrap();
    let (loaded, handle) = read_arrow_ipc_mmap(&path).unwrap();
    assert_eq!(loaded.num_rows(), 2);

    // Drop batch and handle, then overwrite
    drop(loaded);
    drop(handle);
    let batch2 = make_test_batch(&[10, 20, 30]);
    write_arrow_ipc(&path, &batch2).unwrap();
    let (loaded2, _handle2) = read_arrow_ipc_mmap(&path).unwrap();
    assert_eq!(loaded2.num_rows(), 3);
}

#[test]
fn mmap_preserves_nullable_fields() {
    let locs = vec![
        Location {
            id: Id::new(1),
            created_at: util::iso_to_unix("2024-01-01T00:00:00Z").unwrap() as u32,
            ..Default::default()
        },
        Location {
            id: Id::new(2),
            lat: 1.0,
            lng: 1.0,
            pano_id: Some("abc".into()),
            tags: tag_ids([1, 2]),
            extra: Some(serde_json::from_str(r#"{"key":"val"}"#).unwrap()),
            created_at: util::iso_to_unix("2024-01-01T00:00:00Z").unwrap() as u32,
            modified_at: Some(util::iso_to_unix("2024-06-01T00:00:00Z").unwrap() as u32),
            ..Default::default()
        },
    ];
    let batch = arrow::locations_to_batch(&locs);
    let dir = TempDir::new("mma_test_mmap_null");
    let path = dir.join("nullable.arrow");

    write_arrow_ipc(&path, &batch).unwrap();
    let (loaded, _handle) = read_arrow_ipc_mmap(&path).unwrap();

    // Verify nullable columns preserved via the raw column (Array trait)
    assert!(loaded.column(6).is_null(0));
    let pano_col = loaded
        .column(6)
        .as_any()
        .downcast_ref::<arrow_array::StringArray>()
        .unwrap();
    assert_eq!(pano_col.value(1), "abc");

    assert!(loaded.column(9).is_null(0));
    let extra_col = loaded
        .column(9)
        .as_any()
        .downcast_ref::<arrow_array::StringArray>()
        .unwrap();
    assert!(extra_col.value(1).contains("key"));
}

// -----------------------------------------------------------------------
// Crash consistency / corruption
// -----------------------------------------------------------------------

fn truncation_lengths(total_len: usize) -> Vec<usize> {
    let mut lens = vec![
        0,
        1,
        5,
        9,
        10,
        11,
        total_len / 4,
        total_len / 2,
        total_len - 1,
    ];
    lens.retain(|&l| l < total_len);
    lens.sort_unstable();
    lens.dedup();
    lens
}

#[test]
fn truncation_sweep_heap_reader_never_panics() {
    let batch = make_test_batch(&[1, 2, 3, 4, 5]);
    let dir = TempDir::new("mma_test_crash_trunc_heap");
    let valid_path = dir.join("valid.arrow");
    write_arrow_ipc(&valid_path, &batch).unwrap();
    let full_bytes = fs::read(&valid_path).unwrap();

    for len in truncation_lengths(full_bytes.len()) {
        let path = dir.join(format!("trunc_{len}.arrow"));
        fs::write(&path, &full_bytes[..len]).unwrap();

        let result = panic::catch_unwind(AssertUnwindSafe(|| read_arrow_ipc(&path)));
        assert!(
            result.is_ok(),
            "read_arrow_ipc panicked at truncation len {len}"
        );
        assert!(
            result.unwrap().is_err(),
            "read_arrow_ipc must Err on truncated file (len {len} of {})",
            full_bytes.len()
        );
    }
}

#[test]
fn truncation_sweep_mmap_reader_never_panics() {
    let batch = make_test_batch(&[1, 2, 3, 4, 5]);
    let dir = TempDir::new("mma_test_crash_trunc_mmap");
    let valid_path = dir.join("valid.arrow");
    write_arrow_ipc(&valid_path, &batch).unwrap();
    let full_bytes = fs::read(&valid_path).unwrap();

    for len in truncation_lengths(full_bytes.len()) {
        let path = dir.join(format!("trunc_{len}.arrow"));
        fs::write(&path, &full_bytes[..len]).unwrap();

        let result = panic::catch_unwind(AssertUnwindSafe(|| read_arrow_ipc_mmap(&path)));
        assert!(
            result.is_ok(),
            "read_arrow_ipc_mmap panicked at truncation len {len}"
        );
        let read_result = result.unwrap();
        if len < 10 {
            // Pinned separately in mmap_sub_10_byte_file_reads_as_empty_batch.
            continue;
        }
        assert!(
            read_result.is_err(),
            "read_arrow_ipc_mmap must Err on truncated file (len {len} of {})",
            full_bytes.len()
        );
    }
}

#[test]
fn mmap_sub_10_byte_file_errs_as_truncated() {
    let dir = TempDir::new("mma_test_crash_mmap_sub10");
    let path = dir.join("sub10.arrow");

    for len in [0usize, 1, 5, 9] {
        fs::write(&path, vec![0xABu8; len]).unwrap();
        assert!(
            read_arrow_ipc_mmap(&path).is_err(),
            "len {len} must Err, not read as an empty map"
        );
    }
}

#[test]
fn garbage_bytes_heap_and_mmap_no_panic() {
    let batch = make_test_batch(&[1, 2, 3]);
    let dir = TempDir::new("mma_test_crash_garbage");
    let valid_path = dir.join("valid.arrow");
    write_arrow_ipc(&valid_path, &batch).unwrap();
    let mut valid_bytes = fs::read(&valid_path).unwrap();
    let tail_start = valid_bytes.len().saturating_sub(100);
    for b in &mut valid_bytes[tail_start..] {
        *b = 0xFF;
    }

    let patterns: Vec<(&str, Vec<u8>)> = vec![
        ("repeating_ab", vec![0xABu8; 256]),
        (
            "ascii_text",
            b"this is not an arrow file at all, just plain text".to_vec(),
        ),
        ("valid_tail_ff", valid_bytes),
    ];

    for (name, bytes) in patterns {
        let path = dir.join(format!("garbage_{name}.arrow"));
        fs::write(&path, &bytes).unwrap();

        let heap_result = panic::catch_unwind(AssertUnwindSafe(|| read_arrow_ipc(&path)));
        assert!(
            heap_result.is_ok(),
            "read_arrow_ipc panicked on pattern {name}"
        );

        let mmap_result = panic::catch_unwind(AssertUnwindSafe(|| read_arrow_ipc_mmap(&path)));
        assert!(
            mmap_result.is_ok(),
            "read_arrow_ipc_mmap panicked on pattern {name}"
        );
    }
}

// Corrupts bytes strictly inside the footer flatbuffer region, leaving the
// trailer (footer length + magic) and the record-batch body untouched. The
// reader must Err or succeed, never panic (fb_to_schema panics on out-of-range
// enum values, so the conversion is unwind-guarded in read_arrow_ipc_mmap).
#[test]
fn footer_region_corruption_does_not_panic() {
    let batch = make_test_batch(&[1, 2, 3]);
    let dir = TempDir::new("mma_test_crash_footer");
    let valid_path = dir.join("valid.arrow");
    write_arrow_ipc(&valid_path, &batch).unwrap();
    let full_bytes = fs::read(&valid_path).unwrap();

    let len = full_bytes.len();
    let trailer: [u8; 10] = full_bytes[len - 10..].try_into().unwrap();
    let footer_len = u32::from_le_bytes(trailer[0..4].try_into().unwrap()) as usize;
    let footer_start = len - 10 - footer_len;
    let footer_end = len - 10;

    let mut any_panicked = false;
    for offset in (footer_start..footer_end).step_by((footer_len / 8).max(1)) {
        let mut corrupted = full_bytes.clone();
        corrupted[offset] = corrupted[offset].wrapping_add(0x55);
        let path = dir.join(format!("footer_corrupt_{offset}.arrow"));
        fs::write(&path, &corrupted).unwrap();

        let result = panic::catch_unwind(AssertUnwindSafe(|| read_arrow_ipc_mmap(&path)));
        if result.is_err() {
            any_panicked = true;
        }
    }

    assert!(
        !any_panicked,
        "read_arrow_ipc_mmap panicked on a corrupted footer byte; see SUSPECTED BUGS"
    );
}

#[test]
fn atomic_write_leaves_no_tmp_on_success() {
    let dir = TempDir::new("mma_test_atomic_no_tmp");
    let path = dir.join("dest.arrow");
    write_arrow_ipc(&path, &make_test_batch(&[1])).unwrap();
    assert!(path.exists());
    assert!(!dir.join("dest.tmp").exists());
}

#[test]
fn sweep_tmp_under_removes_only_tmp_recursively() {
    let dir = TempDir::new("mma_test_sweep_tmp");
    fs::create_dir_all(dir.join("commits").join("m1")).unwrap();
    fs::write(dir.join("a.tmp"), b"x").unwrap();
    fs::write(dir.join("commits").join("m1").join("b.tmp"), b"x").unwrap();
    fs::write(dir.join("keep.arrow"), b"x").unwrap();
    assert_eq!(sweep_tmp_under(&dir), 2);
    assert!(!dir.join("a.tmp").exists());
    assert!(!dir.join("commits").join("m1").join("b.tmp").exists());
    assert!(dir.join("keep.arrow").exists());
}

#[test]
fn atomic_write_failure_leaves_dest_unchanged() {
    let dir = TempDir::new("mma_test_crash_atomic_fail");
    let path = dir.join("dest.arrow");

    let batch = make_test_batch(&[1, 2, 3]);
    write_arrow_ipc(&path, &batch).unwrap();
    let before = fs::read(&path).unwrap();

    let err_result = atomic_write(&path, |_file| {
        Err(AppError("simulated write failure".into()))
    });
    assert!(err_result.is_err());

    let after = fs::read(&path).unwrap();
    assert_eq!(
        before, after,
        "dest content must be unchanged after a failed atomic_write"
    );

    let loaded = read_arrow_ipc(&path).unwrap();
    assert_eq!(loaded.num_rows(), 3);
}

// atomic_write leaves the .tmp sibling behind when write_fn fails (no cleanup on the
// early-return Err path). Not data corruption, but an accumulating disk leak.
#[test]
fn atomic_write_failure_leaves_tmp_file_behind() {
    let dir = TempDir::new("mma_test_crash_atomic_tmp_leak");
    let path = dir.join("dest.arrow");

    let batch = make_test_batch(&[1]);
    write_arrow_ipc(&path, &batch).unwrap();

    let err_result = atomic_write(&path, |_file| {
        Err(AppError("simulated write failure".into()))
    });
    assert!(err_result.is_err());

    let leftover_tmp = fs::read_dir(&*dir)
        .unwrap()
        .filter_map(Result::ok)
        .any(|e| e.path().extension().is_some_and(|x| x == "tmp"));
    assert!(
        leftover_tmp,
        "current behavior: failed atomic_write leaves the .tmp file behind"
    );
}

#[test]
fn stale_tmp_sibling_does_not_affect_reads() {
    let dir = TempDir::new("mma_test_crash_stale_tmp");
    let path = dir.join("foo.arrow");
    let tmp_path = path.with_extension("tmp");

    let batch = make_test_batch(&[1, 2]);
    write_arrow_ipc(&path, &batch).unwrap();
    fs::write(&tmp_path, vec![0xABu8; 64]).unwrap();

    let heap = read_arrow_ipc(&path).unwrap();
    assert_eq!(heap.num_rows(), 2);
    let (mmap, _handle) = read_arrow_ipc_mmap(&path).unwrap();
    assert_eq!(mmap.num_rows(), 2);
}

#[test]
fn overwrite_after_failed_write_preserves_data_then_succeeds() {
    let dir = TempDir::new("mma_test_crash_overwrite_seq");
    let path = dir.join("seq.arrow");

    let original = make_test_batch(&[1, 2, 3]);
    write_arrow_ipc(&path, &original).unwrap();

    let err_result = atomic_write(&path, |_file| {
        Err(AppError("simulated write failure".into()))
    });
    assert!(err_result.is_err());

    let intact = read_arrow_ipc(&path).unwrap();
    assert_eq!(
        intact.num_rows(),
        3,
        "data must survive a failed write attempt"
    );

    let replacement = make_test_batch(&[10, 20, 30, 40]);
    write_arrow_ipc(&path, &replacement).unwrap();
    let updated = read_arrow_ipc(&path).unwrap();
    assert_eq!(
        updated.num_rows(),
        4,
        "successful write must be readable after a prior failure"
    );
}

// -----------------------------------------------------------------------
// Migration chain
// -----------------------------------------------------------------------

/// Applies MIGRATIONS[0..k] directly (bypassing run_migrations_on's pending-check
/// loop), recording each version, to simulate a DB frozen partway through the chain.
fn apply_prefix(conn: &Connection, k: usize) {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS _mma_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
        [],
    )
    .unwrap();
    for (version, sql) in &MIGRATIONS[..k] {
        conn.execute_batch(sql).unwrap();
        conn.execute(
            "INSERT INTO _mma_migrations (version, applied_at) VALUES (?1, datetime('now'))",
            rusqlite::params![version],
        )
        .unwrap();
    }
}

/// Applies a single migration version's SQL and records it. Assumes _mma_migrations
/// already exists and earlier versions are already applied.
fn apply_migration(conn: &Connection, version: u32) {
    let (v, sql) = MIGRATIONS.iter().find(|(v, _)| *v == version).unwrap();
    conn.execute_batch(sql).unwrap();
    conn.execute(
        "INSERT INTO _mma_migrations (version, applied_at) VALUES (?1, datetime('now'))",
        rusqlite::params![v],
    )
    .unwrap();
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name = ?1",
        rusqlite::params![name],
        |r| r.get(0),
    )
    .unwrap()
}

fn migration_versions(conn: &Connection) -> HashSet<u32> {
    conn.prepare("SELECT version FROM _mma_migrations")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .filter_map(Result::ok)
        .collect()
}

/// Every version in the chain, derived from MIGRATIONS so adding one doesn't
/// require touching each test.
fn all_versions() -> HashSet<u32> {
    MIGRATIONS.iter().map(|(v, _)| *v).collect()
}

fn count_rows(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

/// (type, name) pairs from sqlite_master, ignoring sql text, internal `_mma_migrations`
/// bookkeeping, and autoindex entries -- for comparing schema shape between two DBs.
fn schema_signature(conn: &Connection) -> BTreeSet<(String, String)> {
    conn.prepare(
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex%' AND name != '_mma_migrations'",
    )
    .unwrap()
    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
    .unwrap()
    .filter_map(Result::ok)
    .collect()
}

fn insert_map(conn: &Connection, id: &str, name: &str) {
    conn.execute(
        "INSERT INTO maps (id, name, created_at, updated_at) VALUES (?1, ?2, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')",
        rusqlite::params![id, name],
    )
    .unwrap();
}

#[test]
fn failed_migration_record_rolls_back_schema_and_can_retry() {
    let conn = Connection::open_in_memory().unwrap();
    apply_prefix(&conn, MIGRATIONS.len() - 1);
    let version = MIGRATIONS.last().unwrap().0;
    conn.execute_batch(&format!(
        "CREATE TRIGGER reject_migration BEFORE INSERT ON _mma_migrations
         WHEN NEW.version = {version}
         BEGIN SELECT RAISE(ABORT, 'simulated record failure'); END;"
    ))
    .unwrap();
    let schema_before = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name = 'edit_entries'",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap();
    let versions_before = migration_versions(&conn);

    assert_eq!(
        run_migrations_on(&conn).unwrap_err().0,
        ErrCode::MigrationFailed.with(version).0
    );
    assert_eq!(
        conn.query_row(
            "SELECT sql FROM sqlite_master WHERE name = 'edit_entries'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        schema_before
    );
    assert_eq!(migration_versions(&conn), versions_before);

    conn.execute_batch("DROP TRIGGER reject_migration").unwrap();
    run_migrations_on(&conn).unwrap();
    assert_eq!(migration_versions(&conn), all_versions());
}

#[test]
fn database_from_a_newer_build_is_refused_untouched() {
    let conn = Connection::open_in_memory().unwrap();
    run_migrations_on(&conn).unwrap();
    let newer = MIGRATIONS.last().unwrap().0 + 1;
    conn.execute(
        "INSERT INTO _mma_migrations (version, applied_at) VALUES (?1, datetime('now'))",
        [newer],
    )
    .unwrap();
    let before = schema_signature(&conn);

    assert_eq!(
        run_migrations_on(&conn).unwrap_err().0,
        ErrCode::DatabaseNewer.wire()
    );
    assert_eq!(schema_signature(&conn), before);
}

#[test]
fn file_that_is_not_a_database_is_unreadable() {
    let dir = TempDir::new("mma_unreadable_db");
    let path = dir.join("mma.db");
    fs::write(&path, b"this is not a sqlite database, just some bytes").unwrap();
    let conn = Connection::open(&path).unwrap();

    assert_eq!(
        run_migrations_on(&conn).unwrap_err().0,
        ErrCode::DatabaseUnreadable.wire()
    );
}

#[test]
fn fresh_full_chain_succeeds() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    let result = run_migrations_on(&conn);
    assert!(result.is_ok(), "fresh chain must apply cleanly: {result:?}");

    let versions = migration_versions(&conn);
    let expected = all_versions();
    assert_eq!(versions, expected);

    for table in ["maps", "commits", "seen", "edit_entries", "review_sessions"] {
        assert!(
            table_exists(&conn, table),
            "{table} should exist after full chain"
        );
    }
    for table in [
        "blobs",
        "working_tree",
        "commit_trees",
        "locations",
        "tags",
        "pano_date_cache",
    ] {
        assert!(
            !table_exists(&conn, table),
            "{table} should not exist after full chain"
        );
    }
}

#[test]
fn map_counts_carry_pending_changes_and_reset_to_clean() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    run_migrations_on(&conn).unwrap();
    conn.execute(
        "INSERT INTO maps (id, name, folder, settings, created_at, updated_at) VALUES ('m', 'm', NULL, '{}', '', '')",
        [],
    )
    .unwrap();
    let pending = |conn: &Connection| {
        let p = maps::read_map_meta(conn, &Id::new("m".into()))
            .unwrap()
            .pending;
        (p.added, p.removed, p.updated)
    };
    assert_eq!(pending(&conn), (0, 0, 0), "a map starts clean");

    set_map_counts(
        &conn,
        &Id::new("m".into()),
        12,
        Counts {
            added: 5,
            removed: 1,
            updated: 2,
        },
    )
    .unwrap();
    assert_eq!(pending(&conn), (5, 1, 2));
    let count: i64 = conn
        .query_row("SELECT location_count FROM maps WHERE id = 'm'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(count, 12);

    set_map_counts(&conn, &Id::new("m".into()), 12, Counts::default()).unwrap();
    assert_eq!(pending(&conn), (0, 0, 0), "a commit leaves nothing pending");
}

#[test]
fn seen_dropdown_queries_use_covering_indexes() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    run_migrations_on(&conn).unwrap();

    for (query, index) in [
        (
            "SELECT DISTINCT country_code FROM seen WHERE country_code IS NOT NULL ORDER BY country_code",
            "idx_seen_country",
        ),
        (
            "SELECT DISTINCT s.map_id AS id, m.name FROM seen s JOIN maps m ON m.id = s.map_id WHERE s.map_id IS NOT NULL ORDER BY m.name",
            "idx_seen_map",
        ),
    ] {
        let plan: Vec<String> = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {query}"))
            .unwrap()
            .query_map([], |r| r.get::<_, String>(3))
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(
            plan.iter()
                .any(|d| d.contains("COVERING INDEX") && d.contains(index)),
            "seen dropdown query must scan {index}, got plan: {plan:?}"
        );
    }
}

#[test]
fn every_prefix_upgrades_to_head() {
    let reference = Connection::open_in_memory().unwrap();
    reference.pragma_update(None, "foreign_keys", true).unwrap();
    run_migrations_on(&reference).unwrap();
    let reference_signature = schema_signature(&reference);

    for k in 1..=MIGRATIONS.len() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        apply_prefix(&conn, k);

        insert_map(&conn, "map1", "Test Map");

        if k >= 5 {
            conn.execute(
                "INSERT INTO commits (id, map_id, parent_id, message, location_count, created_at) VALUES ('c1', 'map1', NULL, 'first', 0, '2024-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO commits (id, map_id, parent_id, message, location_count, created_at) VALUES ('c2', 'map1', 'c1', 'second', 0, '2024-01-02T00:00:00Z')",
                [],
            )
            .unwrap();
        }
        if k >= 13 {
            conn.execute(
                "INSERT INTO seen (pano_id, lat, lng, heading, pitch, zoom, entered_at, map_id, location_id, country_code, address, thumbnail) VALUES ('pano1', 1.0, 2.0, 0.0, 0.0, 0.0, 100, 'map1', 5, 'FR', 'addr', 'thumb')",
                [],
            )
            .unwrap();
        }
        if k >= 25 {
            conn.execute(
                "INSERT INTO edit_entries (map_id, seq, stack, max_id, entry) VALUES ('map1', 0, 0, 0, x'90')",
                [],
            )
            .unwrap();
        } else if k >= 3 {
            conn.execute(
                "INSERT INTO edit_history (map_id, undo_stack, redo_stack) VALUES ('map1', '[]', '[]')",
                [],
            )
            .unwrap();
        }

        let result = run_migrations_on(&conn);
        assert!(
            result.is_ok(),
            "prefix k={k} must upgrade to head: {result:?}"
        );

        let versions = migration_versions(&conn);
        let expected = all_versions();
        assert_eq!(
            versions, expected,
            "prefix k={k} missing versions after upgrade"
        );

        let name: String = conn
            .query_row("SELECT name FROM maps WHERE id = 'map1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "Test Map", "prefix k={k} lost maps row");

        if k >= 5 {
            let commits = count_rows(&conn, "commits");
            if k < 16 {
                assert_eq!(
                    commits, 0,
                    "prefix k={k} < 16: v16 must wipe commits on upgrade"
                );
            } else {
                assert_eq!(
                    commits, 2,
                    "prefix k={k} >= 16: v16 already ran, commits must survive"
                );
            }
        }
        if k >= 13 {
            assert_eq!(
                count_rows(&conn, "seen"),
                1,
                "prefix k={k}: seen row must survive"
            );
        }
        if k >= 27 {
            assert_eq!(
                count_rows(&conn, "edit_entries"),
                1,
                "prefix k={k}: edit_entries row must survive"
            );
        } else if k >= 25 {
            assert_eq!(
                count_rows(&conn, "edit_entries"),
                0,
                "prefix k={k}: v27 drops undo entries in the retired encoding"
            );
        } else {
            assert!(
                !table_exists(&conn, "edit_history"),
                "prefix k={k}: v25 retires the single-blob history"
            );
        }

        assert_eq!(
            schema_signature(&conn),
            reference_signature,
            "prefix k={k} schema diverges from fresh full-chain schema"
        );
    }
}

#[test]
fn v26_clears_every_stored_undo_entry() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    let before = MIGRATIONS.iter().position(|(v, _)| *v == 26).unwrap();
    apply_prefix(&conn, before);
    insert_map(&conn, "m1", "n");
    insert_map(&conn, "m2", "n");
    for (map, seq) in [("m1", 0), ("m1", 1), ("m2", 0)] {
        conn.execute(
            "INSERT INTO edit_entries (map_id, seq, stack, max_id, entry) VALUES (?1, ?2, 0, 0, x'90')",
            rusqlite::params![map, seq],
        )
        .unwrap();
    }

    run_migrations_on(&conn).unwrap();
    assert_eq!(count_rows(&conn, "edit_entries"), 0);
}

#[test]
fn run_migrations_on_is_idempotent() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    let first = run_migrations_on(&conn).unwrap();
    assert!(first, "v16 should be newly applied on the first run");

    insert_map(&conn, "m1", "n");
    let count_before = count_rows(&conn, "_mma_migrations");

    let second = run_migrations_on(&conn).unwrap();
    assert!(!second, "second run must apply nothing new");

    let count_after = count_rows(&conn, "_mma_migrations");
    assert_eq!(
        count_before, count_after,
        "idempotent run must not add migration rows"
    );

    let name: String = conn
        .query_row("SELECT name FROM maps WHERE id = 'm1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        name, "n",
        "data inserted between runs must survive the second run"
    );
}

#[test]
fn populated_v10_rebuild_preserves_rows() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    apply_prefix(&conn, 9);

    insert_map(&conn, "map1", "m");
    conn.execute("INSERT INTO blobs (hash, data) VALUES ('h1', 'data1')", [])
        .unwrap();
    conn.execute(
        "INSERT INTO working_tree (map_id, geohash, blob_hash, location_count) VALUES ('map1', 'gh1', 'h1', 3)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO commits (id, map_id, parent_id, message, location_count, created_at, tree_hash, added, removed, modified) VALUES ('c1', 'map1', NULL, 'msg', 0, '2024-01-01T00:00:00Z', NULL, 0, 0, 0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO commit_trees (commit_id, geohash, blob_hash, location_count) VALUES ('c1', 'gh1', 'h1', 3)",
        [],
    )
    .unwrap();

    apply_migration(&conn, 10);

    assert_eq!(
        count_rows(&conn, "working_tree"),
        1,
        "working_tree row must survive v10 rebuild"
    );
    assert_eq!(
        count_rows(&conn, "commit_trees"),
        1,
        "commit_trees row must survive v10 rebuild"
    );

    let (map_id, geohash, blob_hash, loc_count): (String, String, String, i64) = conn
        .query_row(
            "SELECT map_id, geohash, blob_hash, location_count FROM working_tree",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        (
            map_id.as_str(),
            geohash.as_str(),
            blob_hash.as_str(),
            loc_count
        ),
        ("map1", "gh1", "h1", 3)
    );
}

#[test]
fn resolve_within_keeps_paths_under_root() {
    let root = TempDir::new("mma_test_resolve_root");
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(root.join("sub/file.txt"), "x").unwrap();

    let resolved = resolve_within(&root, "sub/file.txt").unwrap();
    assert!(resolved.ends_with("file.txt"));
    assert!(resolved.starts_with(root.canonicalize().unwrap()));

    // A file that does not exist yet still resolves, against its existing parent.
    assert!(resolve_within(&root, "sub/new.txt").is_ok());
}

#[test]
fn resolve_within_refuses_escapes() {
    let root = TempDir::new("mma_test_resolve_escape");
    fs::create_dir_all(root.join("sub")).unwrap();

    assert!(resolve_within(&root, "sub/../../outside.txt").is_err());
    assert!(resolve_within(&root, "../outside.txt").is_err());
    let absolute = root.parent().unwrap().join("elsewhere.txt");
    assert!(resolve_within(&root, &absolute).is_err());
}

#[test]
fn v28_keeps_a_stored_undo_step_readable_under_its_renamed_column() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    let before = MIGRATIONS.iter().position(|(v, _)| *v == 28).unwrap();
    apply_prefix(&conn, before);
    insert_map(&conn, "m", "n");
    let blob = arrow::arrow_ipc_bytes(&arrow::delta_to_batch(&[], &[])).unwrap();
    let parts = serde_json::json!({
        "piles": { "tags": { "added": [[1, { "id": 1, "name": "a" }]], "removed": [], "updated": [] } },
        "defs": { "added": [], "removed": [], "updated": [] },
    });
    conn.execute(
        "INSERT INTO edit_entries (map_id, seq, stack, max_id, entry, piles) VALUES ('m', 0, 0, 0, ?1, ?2)",
        rusqlite::params![blob, parts.to_string()],
    )
    .unwrap();

    run_migrations_on(&conn).unwrap();
    let entry = engine::load_edit(&conn, &Id::new("m".into()), 0).unwrap();
    let tags = &entry.records["tags"];
    assert_eq!(tags.added.len(), 1);
    assert_eq!(tags.added[0].1.name.as_deref(), Some("a"));
}

#[test]
fn v29_drops_the_commit_tree_hash_and_keeps_every_commit() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    let before = MIGRATIONS.iter().position(|(v, _)| *v == 29).unwrap();
    apply_prefix(&conn, before);
    insert_map(&conn, "map1", "m");
    conn.execute(
        "INSERT INTO commits (id, map_id, parent_id, message, location_count, created_at, tree_hash, added, removed, modified) VALUES ('c1', 'map1', NULL, 'msg', 4, '2024-01-01T00:00:00Z', 'abc', 1, 2, 3)",
        [],
    )
    .unwrap();

    run_migrations_on(&conn).unwrap();
    let columns: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('commits')")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(!columns.iter().any(|c| c == "tree_hash"));
    let kept: (String, i64, i64, i64, i64) = conn
        .query_row(
            "SELECT id, location_count, added, removed, modified FROM commits",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap();
    assert_eq!(kept, ("c1".to_string(), 4, 1, 2, 3));
}

#[test]
fn tag_records_held_on_the_map_row_move_to_the_records_table() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    apply_prefix(
        &conn,
        MIGRATIONS.iter().position(|(v, _)| *v == 30).unwrap(),
    );
    insert_map(&conn, "tagged", "Tagged");
    insert_map(&conn, "bare", "Bare");
    conn.execute(
        "UPDATE maps SET tags = ?1 WHERE id = 'tagged'",
        [r##"{"1":{"id":1,"name":"Urban","color":"#ff0000","visible":false},"2":{"name":"Rural","order":3}}"##],
    )
    .unwrap();

    run_migrations_on(&conn).unwrap();

    let tagged = engine::load_value_records(&conn, &Id::new("tagged".into())).unwrap();
    let tags = &tagged["tags"];
    assert_eq!(tags.len(), 2);
    assert_eq!(tags[&Id::new(1)].name.as_deref(), Some("Urban"));
    assert_eq!(tags[&Id::new(1)].color(), Some("#ff0000".parse().unwrap()));
    assert!(!tags[&Id::new(1)].extra.contains_key("visible"));
    assert_eq!(tags[&Id::new(2)].order, Some(3));
    assert!(engine::load_value_records(&conn, &Id::new("bare".into()))
        .unwrap()
        .is_empty());
    let tags_column: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('maps') WHERE name = 'tags'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(tags_column, 0);
}

#[test]
fn a_saved_rules_tag_names_become_its_names_for_the_tags_field() {
    let conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", true).unwrap();
    apply_prefix(
        &conn,
        MIGRATIONS.iter().position(|(v, _)| *v == 31).unwrap(),
    );
    conn.execute_batch(
        r#"INSERT INTO saved_selections (id, name, selector, tag_names, color, created_at) VALUES
             ('named', 'n', '{"type":"Filter","field":"tags","test":{"op":"contains","value":5}}', '{"5":"Japan"}', '[1,2,3]', 'a'),
             ('bare', 'b', '{"type":"Everything"}', '{}', '[1,2,3]', 'b');"#,
    )
    .unwrap();

    run_migrations_on(&conn).unwrap();

    let saved = saved::get(&conn, &[Id::new("named".into()), Id::new("bare".into())]).unwrap();
    assert_eq!(saved.len(), 2);
    assert_eq!(saved[0].value_names["tags"][&Id::new(5)], "Japan");
    assert!(saved[1].value_names.is_empty());
}
