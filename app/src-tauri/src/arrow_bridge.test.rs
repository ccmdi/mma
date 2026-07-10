use super::*;

fn sample_locations() -> Vec<Location> {
    vec![
        Location {
            id: 1,
            lat: 48.8566,
            lng: 2.3522,
            heading: 90.0,
            pitch: 5.0,
            zoom: 1.5,
            pano_id: Some("CAoSLEF...".to_string()),
            flags: crate::types::LocationFlags::LOAD_AS_PANO_ID,
            tags: vec![1, 2],
            extra: Some(serde_json::from_str(r#"{"countryCode":"FR","altitude":35.2}"#).unwrap()),
            created_at: crate::util::iso_to_unix("2024-01-15T10:30:00Z").unwrap() as u32,
            modified_at: Some(crate::util::iso_to_unix("2024-01-15T11:00:00Z").unwrap() as u32),
        },
        Location {
            id: 2,
            lat: -33.8688,
            lng: 151.2093,
            heading: 0.0,
            pitch: 0.0,
            zoom: 1.0,
            pano_id: None,
            flags: crate::types::LocationFlags::empty(),
            tags: vec![],
            extra: None,
            created_at: crate::util::iso_to_unix("2024-06-20T15:00:00Z").unwrap() as u32,
            modified_at: None,
        },
    ]
}

#[test]
fn schema_field_names_match_column_indices() {
    // The `columns!` table generates the COL_* indices and the schema together;
    // this pins that they agree, so a mis-expansion can't silently shift columns.
    let schema = location_schema();
    let expected = [
        (COL_ID, "id"),
        (COL_LAT, "lat"),
        (COL_LNG, "lng"),
        (COL_HEADING, "heading"),
        (COL_PITCH, "pitch"),
        (COL_ZOOM, "zoom"),
        (COL_PANO_ID, "pano_id"),
        (COL_FLAGS, "flags"),
        (COL_TAGS, "tags"),
        (COL_EXTRA, "extra"),
        (COL_CREATED_AT, "created_at"),
        (COL_MODIFIED_AT, "modified_at"),
    ];
    assert_eq!(schema.fields().len(), expected.len());
    for (idx, name) in expected {
        assert_eq!(
            schema.field(idx).name().as_str(),
            name,
            "column index {idx}"
        );
    }
}

#[test]
fn round_trip() {
    let locs = sample_locations();
    let batch = locations_to_batch(&locs);
    assert_eq!(batch.num_rows(), 2);
    assert_eq!(batch.num_columns(), 12);

    let restored = batch_to_locations(&batch);
    assert_eq!(restored.len(), 2);

    for (orig, rest) in locs.iter().zip(restored.iter()) {
        assert_eq!(orig.id, rest.id);
        assert!((orig.lat - rest.lat).abs() < 1e-10);
        assert!((orig.lng - rest.lng).abs() < 1e-10);
        assert!((orig.heading - rest.heading).abs() < 1e-10);
        assert!((orig.pitch - rest.pitch).abs() < 1e-10);
        assert!((orig.zoom - rest.zoom).abs() < 1e-10);
        assert_eq!(orig.pano_id, rest.pano_id);
        assert_eq!(orig.flags, rest.flags);
        assert_eq!(orig.tags, rest.tags);
        assert_eq!(
            orig.extra
                .as_ref()
                .map(|e| serde_json::to_string(e).unwrap()),
            rest.extra
                .as_ref()
                .map(|e| serde_json::to_string(e).unwrap()),
        );
        assert_eq!(orig.created_at, rest.created_at);
        assert_eq!(orig.modified_at, rest.modified_at);
    }
}

#[test]
fn snapshot_batch_reads_as_all_created() {
    // A genesis commit stores its delta as a plain 12-column base snapshot (no `op`
    // column). batch_to_delta must read every row as created so it materializes back
    // to the full location set — this is what lets the genesis commit reuse the base
    // file instead of re-serializing a separate delta.
    let locs = sample_locations();
    let snapshot = locations_to_batch(&locs); // base format, 12 columns, no op
    let (created, removed) = batch_to_delta(&snapshot);
    assert!(removed.is_empty());
    assert_eq!(
        created.iter().map(|l| l.id).collect::<Vec<_>>(),
        locs.iter().map(|l| l.id).collect::<Vec<_>>(),
    );
    assert_eq!(created[0].created_at, locs[0].created_at);
    assert_eq!(created[0].pano_id, locs[0].pano_id);
}

#[test]
fn patch_batch_applies_values_and_reuses_untouched_columns() {
    let locs = sample_locations();
    let batch = locations_to_batch(&locs);

    let mut patched = locs[0].clone();
    patched.heading = 270.0;
    patched.tags = vec![7];
    let patches = std::collections::HashMap::from([(1u32, patched)]);

    let out = patch_batch(&batch, &patches);
    assert_eq!(out.num_rows(), 2);

    let restored = batch_to_locations(&out);
    assert_eq!(restored[0].heading, 270.0);
    assert_eq!(restored[0].tags, vec![7]);
    // unpatched fields and rows survive intact
    assert_eq!(restored[0].pano_id, locs[0].pano_id);
    assert_eq!(restored[0].extra, locs[0].extra);
    assert_eq!(restored[1], locs[1]);

    // untouched columns are the same Arc, not rebuilt copies
    for ci in 0..out.num_columns() {
        let reused = Arc::ptr_eq(batch.column(ci), out.column(ci));
        match ci {
            COL_HEADING | COL_TAGS => assert!(!reused, "col {ci} should be rebuilt"),
            _ => assert!(reused, "col {ci} should be reused"),
        }
    }
}

#[test]
fn patch_batch_noop_when_no_patch_id_matches() {
    let locs = sample_locations();
    let batch = locations_to_batch(&locs);
    let patches = std::collections::HashMap::from([(99u32, locs[0].clone())]);
    let out = patch_batch(&batch, &patches);
    for ci in 0..out.num_columns() {
        assert!(Arc::ptr_eq(batch.column(ci), out.column(ci)));
    }
}

#[test]
fn patch_batch_identical_patch_rebuilds_nothing() {
    let locs = sample_locations();
    let batch = locations_to_batch(&locs);
    // patch present but equal to the stored row: no column is "touched"
    let stored = row_to_location(&batch, 0);
    let patches = std::collections::HashMap::from([(1u32, stored)]);
    let out = patch_batch(&batch, &patches);
    for ci in 0..out.num_columns() {
        assert!(Arc::ptr_eq(batch.column(ci), out.column(ci)));
    }
}

#[test]
fn patch_batch_nullable_transitions() {
    let locs = sample_locations();
    let batch = locations_to_batch(&locs);

    // row 1: pano_id None -> Some, extra None -> Some, modified_at None -> Some
    let mut p2 = locs[1].clone();
    p2.pano_id = Some("newpano".into());
    p2.extra = Some(serde_json::from_str(r#"{"k":"v"}"#).unwrap());
    p2.modified_at = Some(123);
    // row 0: Some -> None
    let mut p1 = locs[0].clone();
    p1.pano_id = None;
    p1.extra = None;
    p1.modified_at = None;

    let patches = std::collections::HashMap::from([(1u32, p1), (2u32, p2)]);
    let restored = batch_to_locations(&patch_batch(&batch, &patches));

    assert_eq!(restored[0].pano_id, None);
    assert_eq!(restored[0].extra, None);
    assert_eq!(restored[0].modified_at, None);
    assert_eq!(restored[1].pano_id, Some("newpano".into()));
    assert_eq!(restored[1].extra.as_ref().unwrap().get("k").unwrap(), "v");
    assert_eq!(restored[1].modified_at, Some(123));
}

#[test]
fn empty_batch() {
    let batch = locations_to_batch(&[]);
    assert_eq!(batch.num_rows(), 0);
    let restored = batch_to_locations(&batch);
    assert!(restored.is_empty());
}

#[test]
fn single_row_access() {
    let locs = sample_locations();
    let batch = locations_to_batch(&locs);
    let loc = row_to_location(&batch, 1);
    assert_eq!(loc.id, locs[1].id);
    assert_eq!(loc.pano_id, None);
    assert!(loc.tags.is_empty());
    assert!(loc.extra.is_none());
}
