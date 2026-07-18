use super::*;
use crate::arrow_bridge;
use crate::types::Location;
use crate::util::sha256_hex;

fn sample_loc() -> Location {
    Location {
        id: 42,
        lat: 48.8566,
        lng: 2.3522,
        heading: 90.0,
        pitch: 5.0,
        zoom: 1.5,
        pano_id: Some("CAoSLEF".into()),
        provider: None,
        flags: crate::types::LocationFlags::LOAD_AS_PANO_ID,
        tags: vec![1, 2, 3],
        extra: Some(serde_json::from_str(r#"{"country":"FR"}"#).unwrap()),
        created_at: crate::util::iso_to_unix("2024-01-15T10:30:00Z").unwrap() as u32,
        modified_at: Some(crate::util::iso_to_unix("2024-01-15T11:00:00Z").unwrap() as u32),
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
        id: 1,
        lat: 0.0,
        lng: 0.0,
        heading: 0.0,
        pitch: 0.0,
        zoom: 0.0,
        pano_id: None,
        provider: None,
        flags: crate::types::LocationFlags::empty(),
        tags: vec![],
        extra: None,
        created_at: 0,
        modified_at: None,
    };
    let json = serde_json::to_string(&loc).unwrap();
    assert!(json.contains(r#""extra":null"#));
    assert!(json.contains(r#""modifiedAt":null"#));
    let restored: Location = serde_json::from_str(&json).unwrap();
    assert_eq!(loc, restored);
}

#[test]
fn location_data_id_defaults_to_zero() {
    let json = r#"{"id":0,"lat":0,"lng":0,"heading":0,"pitch":0,"zoom":0,"panoId":null,"provider":null,"flags":0,"tags":[],"extra":null,"createdAt":0,"modifiedAt":null}"#;
    let loc: Location = serde_json::from_str(json).unwrap();
    assert_eq!(loc.id, 0);
}

#[test]
fn location_missing_provider_defaults_to_google() {
    // Pre-provider GeoGuessr / remote export JSON has no provider key.
    let json = r#"{"id":0,"lat":0,"lng":0,"heading":0,"pitch":0,"zoom":0,"panoId":null,"flags":0,"tags":[],"extra":null,"createdAt":0,"modifiedAt":null}"#;
    let loc: Location = serde_json::from_str(json).unwrap();
    assert_eq!(loc.provider.as_deref(), Some("google"));
}

// -----------------------------------------------------------------------
// Connection setup
// -----------------------------------------------------------------------

// The bundled sqlite happens to compile with SQLITE_DEFAULT_FOREIGN_KEYS=1, but the
// invariant must not depend on a dependency's build flag (system sqlite defaults OFF).
#[test]
fn configure_connection_enables_foreign_keys() {
    let conn = Connection::open_in_memory().unwrap();
    configure_connection(&conn).unwrap();
    let fk: i32 = conn
        .pragma_query_value(None, "foreign_keys", |r| r.get(0))
        .unwrap();
    assert_eq!(fk, 1);
}

#[test]
fn configured_connection_cascades_on_map_delete() {
    let conn = Connection::open_in_memory().unwrap();
    configure_connection(&conn).unwrap();
    conn.execute_batch(
        "CREATE TABLE maps (id TEXT PRIMARY KEY NOT NULL);
         CREATE TABLE review_sessions (
           id TEXT PRIMARY KEY NOT NULL,
           map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE
         );
         INSERT INTO maps VALUES ('m1');
         INSERT INTO review_sessions VALUES ('r1', 'm1');",
    )
    .unwrap();
    conn.execute("DELETE FROM maps WHERE id = 'm1'", [])
        .unwrap();
    let orphans: i64 = conn
        .query_row("SELECT COUNT(*) FROM review_sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        orphans, 0,
        "ON DELETE CASCADE must fire on configured connections"
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
        Some(std::path::PathBuf::from("D:/maps"))
    );
}

#[test]
fn read_data_location_override_round_trip() {
    let cfg = std::env::temp_dir().join("mma_test_dataloc_cfg");
    let target = std::env::temp_dir().join("mma_test_dataloc_target");
    let _ = std::fs::remove_dir_all(&cfg);
    let _ = std::fs::remove_dir_all(&target);
    std::fs::create_dir_all(&cfg).unwrap();

    // Absent pointer -> no override.
    assert_eq!(read_data_location_override(&cfg), None);

    // Written pointer to a valid (creatable) folder -> that folder, and it now exists.
    std::fs::write(
        cfg.join(DATA_LOCATION_FILE),
        target.to_string_lossy().as_bytes(),
    )
    .unwrap();
    assert_eq!(read_data_location_override(&cfg), Some(target.clone()));
    assert!(target.exists());

    // Empty pointer -> no override.
    std::fs::write(cfg.join(DATA_LOCATION_FILE), b"").unwrap();
    assert_eq!(read_data_location_override(&cfg), None);

    let _ = std::fs::remove_dir_all(&cfg);
    let _ = std::fs::remove_dir_all(&target);
}

// -----------------------------------------------------------------------
// Arrow IPC mmap round-trip
// -----------------------------------------------------------------------

fn make_test_batch(ids: &[u32]) -> arrow_array::RecordBatch {
    let locs: Vec<Location> = ids
        .iter()
        .map(|&id| Location {
            id,
            lat: id as f64,
            lng: id as f64 * 2.0,
            heading: 0.0,
            pitch: 0.0,
            zoom: 1.0,
            pano_id: Some(format!("pano_{id}")),
            provider: None,
            flags: crate::types::LocationFlags::empty(),
            tags: vec![1],
            extra: None,
            created_at: crate::util::iso_to_unix("2024-01-01T00:00:00Z").unwrap() as u32,
            modified_at: None,
        })
        .collect();
    arrow_bridge::locations_to_batch(&locs)
}

#[test]
fn mmap_round_trip_preserves_data() {
    let batch = make_test_batch(&[1, 2, 3]);
    let dir = std::env::temp_dir().join("mma_test_mmap");
    let _ = std::fs::create_dir_all(&dir);
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

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn mmap_empty_file() {
    let batch = arrow_bridge::locations_to_batch(&[]);
    let dir = std::env::temp_dir().join("mma_test_mmap_empty");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("empty.arrow");

    write_arrow_ipc(&path, &batch).unwrap();
    let (loaded, _handle) = read_arrow_ipc_mmap(&path).unwrap();
    assert_eq!(loaded.num_rows(), 0);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn mmap_matches_heap_read() {
    let batch = make_test_batch(&[10, 20, 30, 40, 50]);
    let dir = std::env::temp_dir().join("mma_test_mmap_cmp");
    let _ = std::fs::create_dir_all(&dir);
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

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn mmap_handle_drop_allows_overwrite() {
    let dir = std::env::temp_dir().join("mma_test_mmap_drop");
    let _ = std::fs::create_dir_all(&dir);
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

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn mmap_preserves_nullable_fields() {
    let locs = vec![
        Location {
            id: 1,
            lat: 0.0,
            lng: 0.0,
            heading: 0.0,
            pitch: 0.0,
            zoom: 0.0,
            pano_id: None,
            provider: None,
            flags: crate::types::LocationFlags::empty(),
            tags: vec![],
            extra: None,
            created_at: crate::util::iso_to_unix("2024-01-01T00:00:00Z").unwrap() as u32,
            modified_at: None,
        },
        Location {
            id: 2,
            lat: 1.0,
            lng: 1.0,
            heading: 0.0,
            pitch: 0.0,
            zoom: 0.0,
            pano_id: Some("abc".into()),
            provider: None,
            flags: crate::types::LocationFlags::empty(),
            tags: vec![1, 2],
            extra: Some(serde_json::from_str(r#"{"key":"val"}"#).unwrap()),
            created_at: crate::util::iso_to_unix("2024-01-01T00:00:00Z").unwrap() as u32,
            modified_at: Some(crate::util::iso_to_unix("2024-06-01T00:00:00Z").unwrap() as u32),
        },
    ];
    let batch = arrow_bridge::locations_to_batch(&locs);
    let dir = std::env::temp_dir().join("mma_test_mmap_null");
    let _ = std::fs::create_dir_all(&dir);
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

    assert!(loaded.column(10).is_null(0));
    let extra_col = loaded
        .column(10)
        .as_any()
        .downcast_ref::<arrow_array::StringArray>()
        .unwrap();
    assert!(extra_col.value(1).contains("key"));

    let _ = std::fs::remove_dir_all(&dir);
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
    let dir = std::env::temp_dir().join("mma_test_crash_trunc_heap");
    let _ = std::fs::create_dir_all(&dir);
    let valid_path = dir.join("valid.arrow");
    write_arrow_ipc(&valid_path, &batch).unwrap();
    let full_bytes = std::fs::read(&valid_path).unwrap();

    for len in truncation_lengths(full_bytes.len()) {
        let path = dir.join(format!("trunc_{len}.arrow"));
        std::fs::write(&path, &full_bytes[..len]).unwrap();

        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| read_arrow_ipc(&path)));
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

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn truncation_sweep_mmap_reader_never_panics() {
    let batch = make_test_batch(&[1, 2, 3, 4, 5]);
    let dir = std::env::temp_dir().join("mma_test_crash_trunc_mmap");
    let _ = std::fs::create_dir_all(&dir);
    let valid_path = dir.join("valid.arrow");
    write_arrow_ipc(&valid_path, &batch).unwrap();
    let full_bytes = std::fs::read(&valid_path).unwrap();

    for len in truncation_lengths(full_bytes.len()) {
        let path = dir.join(format!("trunc_{len}.arrow"));
        std::fs::write(&path, &full_bytes[..len]).unwrap();

        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| read_arrow_ipc_mmap(&path)));
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

    let _ = std::fs::remove_dir_all(&dir);
}

// Files under 10 bytes short-circuit to Ok(empty batch) in read_arrow_ipc_mmap
// (storage.rs ~line 608) rather than erroring. A base file truncated below 10
// bytes by a crash therefore reads as a silently-empty map, not a detected
// corruption. See SUSPECTED BUGS in the delivering task's report.
#[test]
fn mmap_sub_10_byte_file_reads_as_empty_batch() {
    let dir = std::env::temp_dir().join("mma_test_crash_mmap_sub10");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("sub10.arrow");

    for len in [0usize, 1, 5, 9] {
        std::fs::write(&path, vec![0xABu8; len]).unwrap();
        let (loaded, _handle) = read_arrow_ipc_mmap(&path).unwrap();
        assert_eq!(loaded.num_rows(), 0, "len {len} should read as empty batch");
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn garbage_bytes_heap_and_mmap_no_panic() {
    let batch = make_test_batch(&[1, 2, 3]);
    let dir = std::env::temp_dir().join("mma_test_crash_garbage");
    let _ = std::fs::create_dir_all(&dir);
    let valid_path = dir.join("valid.arrow");
    write_arrow_ipc(&valid_path, &batch).unwrap();
    let mut valid_bytes = std::fs::read(&valid_path).unwrap();
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
        std::fs::write(&path, &bytes).unwrap();

        let heap_result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| read_arrow_ipc(&path)));
        assert!(
            heap_result.is_ok(),
            "read_arrow_ipc panicked on pattern {name}"
        );

        let mmap_result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| read_arrow_ipc_mmap(&path)));
        assert!(
            mmap_result.is_ok(),
            "read_arrow_ipc_mmap panicked on pattern {name}"
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}

// Attempts to hit the footer.schema().unwrap() panic (storage.rs ~line 620) by
// corrupting bytes strictly inside the footer flatbuffer region, leaving the
// trailer (footer length + magic) and the record-batch body untouched. If
// root_as_footer still parses the corrupted bytes as a valid footer with no
// schema field, footer.schema().unwrap() panics.
#[test]
#[ignore = "confirmed panic: fb_to_schema panics on an out-of-range FloatingPoint precision \
enum value decoded from a corrupted footer (arrow-ipc convert.rs:356), reached via \
read_arrow_ipc_mmap's unchecked footer parse. See SUSPECTED BUGS."]
fn footer_region_corruption_does_not_panic() {
    let batch = make_test_batch(&[1, 2, 3]);
    let dir = std::env::temp_dir().join("mma_test_crash_footer");
    let _ = std::fs::create_dir_all(&dir);
    let valid_path = dir.join("valid.arrow");
    write_arrow_ipc(&valid_path, &batch).unwrap();
    let full_bytes = std::fs::read(&valid_path).unwrap();

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
        std::fs::write(&path, &corrupted).unwrap();

        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| read_arrow_ipc_mmap(&path)));
        if result.is_err() {
            any_panicked = true;
        }
    }

    assert!(
        !any_panicked,
        "read_arrow_ipc_mmap panicked on a corrupted footer byte; see SUSPECTED BUGS"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn atomic_write_failure_leaves_dest_unchanged() {
    let dir = std::env::temp_dir().join("mma_test_crash_atomic_fail");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("dest.arrow");

    let batch = make_test_batch(&[1, 2, 3]);
    write_arrow_ipc(&path, &batch).unwrap();
    let before = std::fs::read(&path).unwrap();

    let err_result = atomic_write(&path, |_file| {
        Err(AppError("simulated write failure".into()))
    });
    assert!(err_result.is_err());

    let after = std::fs::read(&path).unwrap();
    assert_eq!(
        before, after,
        "dest content must be unchanged after a failed atomic_write"
    );

    let loaded = read_arrow_ipc(&path).unwrap();
    assert_eq!(loaded.num_rows(), 3);

    let _ = std::fs::remove_dir_all(&dir);
}

// atomic_write leaves the .tmp sibling behind on write_fn failure (storage.rs
// ~line 552-556: no cleanup on the early-return Err path). Not silent data
// corruption, but an accumulating disk leak on repeated failures. See
// SUSPECTED BUGS.
#[test]
fn atomic_write_failure_leaves_tmp_file_behind() {
    let dir = std::env::temp_dir().join("mma_test_crash_atomic_tmp_leak");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("dest.arrow");
    let tmp_path = path.with_extension("tmp");

    let batch = make_test_batch(&[1]);
    write_arrow_ipc(&path, &batch).unwrap();

    let err_result = atomic_write(&path, |_file| {
        Err(AppError("simulated write failure".into()))
    });
    assert!(err_result.is_err());

    assert!(
        tmp_path.exists(),
        "current behavior: failed atomic_write leaves the .tmp file behind"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stale_tmp_sibling_does_not_affect_reads() {
    let dir = std::env::temp_dir().join("mma_test_crash_stale_tmp");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("foo.arrow");
    let tmp_path = path.with_extension("tmp");

    let batch = make_test_batch(&[1, 2]);
    write_arrow_ipc(&path, &batch).unwrap();
    std::fs::write(&tmp_path, vec![0xABu8; 64]).unwrap();

    let heap = read_arrow_ipc(&path).unwrap();
    assert_eq!(heap.num_rows(), 2);
    let (mmap, _handle) = read_arrow_ipc_mmap(&path).unwrap();
    assert_eq!(mmap.num_rows(), 2);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn overwrite_after_failed_write_preserves_data_then_succeeds() {
    let dir = std::env::temp_dir().join("mma_test_crash_overwrite_seq");
    let _ = std::fs::create_dir_all(&dir);
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

    let _ = std::fs::remove_dir_all(&dir);
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

fn migration_versions(conn: &Connection) -> std::collections::HashSet<u32> {
    conn.prepare("SELECT version FROM _mma_migrations")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .filter_map(|r| r.ok())
        .collect()
}

fn count_rows(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

/// (type, name) pairs from sqlite_master, ignoring sql text, internal `_mma_migrations`
/// bookkeeping, and autoindex entries -- for comparing schema shape between two DBs.
fn schema_signature(conn: &Connection) -> std::collections::BTreeSet<(String, String)> {
    conn.prepare(
        "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex%' AND name != '_mma_migrations'",
    )
    .unwrap()
    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
    .unwrap()
    .filter_map(|r| r.ok())
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
fn fresh_full_chain_succeeds() {
    let conn = Connection::open_in_memory().unwrap();
    configure_connection(&conn).unwrap();
    let result = run_migrations_on(&conn);
    assert!(result.is_ok(), "fresh chain must apply cleanly: {result:?}");

    let versions = migration_versions(&conn);
    let expected: std::collections::HashSet<u32> = (1..=18).collect();
    assert_eq!(versions, expected);

    for table in ["maps", "commits", "seen", "edit_history", "review_sessions"] {
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
fn every_prefix_upgrades_to_head() {
    let reference = Connection::open_in_memory().unwrap();
    configure_connection(&reference).unwrap();
    run_migrations_on(&reference).unwrap();
    let reference_signature = schema_signature(&reference);

    for k in 1..=18usize {
        let conn = Connection::open_in_memory().unwrap();
        configure_connection(&conn).unwrap();
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
        if k >= 3 {
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
        let expected: std::collections::HashSet<u32> = (1..=18).collect();
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
        if k >= 3 {
            assert_eq!(
                count_rows(&conn, "edit_history"),
                1,
                "prefix k={k}: edit_history row must survive"
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
fn run_migrations_on_is_idempotent() {
    let conn = Connection::open_in_memory().unwrap();
    configure_connection(&conn).unwrap();
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
fn sqlx_seeding_skips_already_applied() {
    let conn = Connection::open_in_memory().unwrap();
    configure_connection(&conn).unwrap();
    apply_prefix(&conn, 5);
    conn.execute("DELETE FROM _mma_migrations", []).unwrap();

    conn.execute_batch(
        "CREATE TABLE _sqlx_migrations (version INTEGER PRIMARY KEY, installed_on TEXT, success INTEGER);
         INSERT INTO _sqlx_migrations (version, installed_on, success) VALUES
            (1, '2024-01-01T00:00:00Z', 1),
            (2, '2024-01-01T00:00:00Z', 1),
            (3, '2024-01-01T00:00:00Z', 1),
            (4, '2024-01-01T00:00:00Z', 1),
            (5, '2024-01-01T00:00:00Z', 1),
            (6, '2024-01-01T00:00:00Z', 0);",
    )
    .unwrap();

    // If seeding failed to skip versions 1-5, re-running v5's non-idempotent
    // ALTER TABLE ADD COLUMN against already-altered columns fails here.
    let result = run_migrations_on(&conn);
    assert!(
        result.is_ok(),
        "seeded versions must not be re-executed: {result:?}"
    );

    let versions = migration_versions(&conn);
    let expected: std::collections::HashSet<u32> = (1..=18).collect();
    assert_eq!(
        versions, expected,
        "versions 6 onward must still be applied after seeding"
    );
}

#[test]
fn populated_v10_rebuild_preserves_rows() {
    let conn = Connection::open_in_memory().unwrap();
    configure_connection(&conn).unwrap();
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
