use super::*;
use crate::arrow_bridge;
use crate::types::Location;
use arrow_array::{Array, ArrayRef, RecordBatch, StringArray, UInt32Array, UInt8Array};
use arrow_schema::{DataType, Field, Schema};
use std::collections::HashMap;
use std::sync::Arc;

fn loc(id: u32) -> Location {
    Location {
        id,
        lat: 1.0,
        lng: 2.0,
        heading: 0.0,
        pitch: 0.0,
        zoom: 0.0,
        pano_id: None,
        flags: crate::types::LocationFlags::empty(),
        tags: vec![1],
        extra: None,
        created_at: crate::util::iso_to_unix("2024-01-01T00:00:00Z").unwrap() as u32,
        modified_at: None,
    }
}

/// Rebuild a current (v2) batch in the v1 on-disk shape: `created_at`/`modified_at`
/// back to `Utf8`, schema metadata stripped (so it reads as v1). All other columns
/// (including a delta `op` column) pass through untouched.
fn downgrade_to_v1(
    batch: &RecordBatch,
    created: Vec<Option<&str>>,
    modified: Vec<Option<&str>>,
) -> RecordBatch {
    let mut fields: Vec<Arc<Field>> = Vec::new();
    let mut cols: Vec<ArrayRef> = Vec::new();
    for (i, f) in batch.schema().fields().iter().enumerate() {
        match f.name().as_str() {
            "created_at" => {
                fields.push(Arc::new(Field::new("created_at", DataType::Utf8, false)));
                cols.push(Arc::new(StringArray::from(created.clone())) as ArrayRef);
            }
            "modified_at" => {
                fields.push(Arc::new(Field::new("modified_at", DataType::Utf8, true)));
                cols.push(Arc::new(StringArray::from(modified.clone())) as ArrayRef);
            }
            _ => {
                fields.push(f.clone());
                cols.push(batch.column(i).clone());
            }
        }
    }
    RecordBatch::try_new(Arc::new(Schema::new(fields)), cols).unwrap()
}

#[test]
fn version_defaults_to_one_when_unstamped() {
    assert_eq!(batch_version(&HashMap::new()), 1);
    assert_eq!(batch_version(&version_metadata()), CURRENT_VERSION);
}

#[test]
fn migrate_v1_converts_timestamps_to_epoch() {
    let v2 = arrow_bridge::locations_to_batch(&[loc(1), loc(2)]);
    let v1 = downgrade_to_v1(
        &v2,
        vec![
            Some("2024-01-15T10:30:00Z"),
            Some("2024-06-20T15:00:00.500Z"),
        ],
        vec![None, Some("2024-06-20T16:00:00Z")],
    );
    assert_eq!(batch_version(v1.schema().metadata()), 1);

    let out = migrate(v1).unwrap();
    assert_eq!(batch_version(out.schema().metadata()), CURRENT_VERSION);

    let created = out
        .column(10)
        .as_any()
        .downcast_ref::<UInt32Array>()
        .unwrap();
    let modified = out
        .column(11)
        .as_any()
        .downcast_ref::<UInt32Array>()
        .unwrap();
    assert_eq!(
        created.value(0),
        crate::util::iso_to_unix("2024-01-15T10:30:00Z").unwrap() as u32
    );
    // sub-second precision is dropped (second resolution)
    assert_eq!(
        created.value(1),
        crate::util::iso_to_unix("2024-06-20T15:00:00Z").unwrap() as u32
    );
    assert!(modified.is_null(0));
    assert_eq!(
        modified.value(1),
        crate::util::iso_to_unix("2024-06-20T16:00:00Z").unwrap() as u32
    );
}

#[test]
fn migrate_v1_unparseable_created_falls_back_to_zero() {
    let v2 = arrow_bridge::locations_to_batch(&[loc(1)]);
    let v1 = downgrade_to_v1(&v2, vec![Some("garbage")], vec![None]);
    let out = migrate(v1).unwrap();
    let created = out
        .column(10)
        .as_any()
        .downcast_ref::<UInt32Array>()
        .unwrap();
    assert!(!created.is_null(0)); // created_at is non-nullable
    assert_eq!(created.value(0), 0);
}

#[test]
fn migrate_v2_is_noop() {
    let v2 = arrow_bridge::locations_to_batch(&[loc(1)]);
    let out = migrate(v2.clone()).unwrap();
    assert_eq!(out.schema(), v2.schema());
    assert_eq!(out.num_rows(), v2.num_rows());
}

#[test]
fn migrate_preserves_delta_op_column() {
    let delta = arrow_bridge::delta_to_batch(&[loc(1)], &[loc(2)]);
    let v1 = downgrade_to_v1(
        &delta,
        vec![Some("2024-01-01T00:00:00Z"), Some("2024-01-01T00:00:00Z")],
        vec![None, None],
    );
    let out = migrate(v1).unwrap();
    assert_eq!(batch_version(out.schema().metadata()), CURRENT_VERSION);

    let op = out
        .column(out.num_columns() - 1)
        .as_any()
        .downcast_ref::<UInt8Array>()
        .unwrap();
    assert_eq!(op.value(0), arrow_bridge::OP_REMOVED);
    assert_eq!(op.value(1), arrow_bridge::OP_CREATED);
    assert!(out
        .column(10)
        .as_any()
        .downcast_ref::<UInt32Array>()
        .is_some());
}
