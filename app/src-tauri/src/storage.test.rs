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
    assert!(v["createdAt"].is_number(), "createdAt must reach JS as a number, not ISO");
    assert!(v["modifiedAt"].is_number(), "modifiedAt must reach JS as a number, not ISO");
}

#[test]
fn location_data_null_optionals() {
    let loc = Location {
        id: 1, lat: 0.0, lng: 0.0, heading: 0.0, pitch: 0.0, zoom: 0.0,
        pano_id: None, flags: crate::types::LocationFlags::empty(), tags: vec![], extra: None,
        created_at: 0, modified_at: None,
    };
    let json = serde_json::to_string(&loc).unwrap();
    assert!(!json.contains("extra"));
    assert!(!json.contains("modifiedAt"));
    let restored: Location = serde_json::from_str(&json).unwrap();
    assert_eq!(loc, restored);
}

#[test]
fn location_data_id_defaults_to_zero() {
    let json = r#"{"lat":0,"lng":0,"heading":0,"pitch":0,"zoom":0,"panoId":null,"flags":0,"tags":[],"createdAt":0}"#;
    let loc: Location = serde_json::from_str(json).unwrap();
    assert_eq!(loc.id, 0);
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
    assert_eq!(h, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
}

#[test]
fn sha256_hex_differs_for_different_input() {
    assert_ne!(sha256_hex(b"hello"), sha256_hex(b"world"));
}

// -----------------------------------------------------------------------
// Arrow IPC mmap round-trip
// -----------------------------------------------------------------------

fn make_test_batch(ids: &[u32]) -> arrow::array::RecordBatch {
    let locs: Vec<Location> = ids.iter().map(|&id| Location {
        id, lat: id as f64, lng: id as f64 * 2.0,
        heading: 0.0, pitch: 0.0, zoom: 1.0,
        pano_id: Some(format!("pano_{id}")),
        flags: crate::types::LocationFlags::empty(), tags: vec![1], extra: None,
        created_at: crate::util::iso_to_unix("2024-01-01T00:00:00Z").unwrap() as u32,
        modified_at: None,
    }).collect();
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
    let ids = loaded.column(0).as_any().downcast_ref::<arrow::array::UInt32Array>().unwrap();
    assert_eq!(ids.value(0), 1);
    assert_eq!(ids.value(1), 2);
    assert_eq!(ids.value(2), 3);
    let lats = loaded.column(1).as_any().downcast_ref::<arrow::array::Float64Array>().unwrap();
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
        assert_eq!(heap.column(col).as_ref(), mmap.column(col).as_ref(),
            "column {col} mismatch between heap and mmap read");
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
            id: 1, lat: 0.0, lng: 0.0, heading: 0.0, pitch: 0.0, zoom: 0.0,
            pano_id: None, flags: crate::types::LocationFlags::empty(), tags: vec![], extra: None,
            created_at: crate::util::iso_to_unix("2024-01-01T00:00:00Z").unwrap() as u32, modified_at: None,
        },
        Location {
            id: 2, lat: 1.0, lng: 1.0, heading: 0.0, pitch: 0.0, zoom: 0.0,
            pano_id: Some("abc".into()), flags: crate::types::LocationFlags::empty(), tags: vec![1, 2],
            extra: Some(serde_json::from_str(r#"{"key":"val"}"#).unwrap()),
            created_at: crate::util::iso_to_unix("2024-01-01T00:00:00Z").unwrap() as u32, modified_at: Some(crate::util::iso_to_unix("2024-06-01T00:00:00Z").unwrap() as u32),
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
    let pano_col = loaded.column(6).as_any().downcast_ref::<arrow::array::StringArray>().unwrap();
    assert_eq!(pano_col.value(1), "abc");

    assert!(loaded.column(9).is_null(0));
    let extra_col = loaded.column(9).as_any().downcast_ref::<arrow::array::StringArray>().unwrap();
    assert!(extra_col.value(1).contains("key"));

    let _ = std::fs::remove_dir_all(&dir);
}
