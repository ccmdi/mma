use super::*;
use std::collections::BTreeMap;

fn loc(id: u32, lat: f64, lng: f64) -> Location {
    Location {
        id,
        lat,
        lng,
        heading: 0.0,
        pitch: 0.0,
        zoom: 1.0,
        pano_id: None,
        flags: crate::types::LocationFlags::empty(),
        tags: vec![],
        extra: None,
        created_at: crate::util::iso_to_unix("2024-01-01T00:00:00Z").unwrap() as u32,
        modified_at: None,
    }
}

#[test]
fn diff_genesis_all_added() {
    let parent = BTreeMap::new();
    let current = vec![loc(1, 10.0, 20.0), loc(2, 30.0, 40.0), loc(3, 50.0, 60.0)];
    let (created, removed, added, removed_n, modified) = diff_states(&parent, &current);
    assert_eq!(created.len(), 3);
    assert!(removed.is_empty());
    assert_eq!((added, removed_n, modified), (3, 0, 0));
}

#[test]
fn diff_add_remove_modify() {
    // parent {1, 2}; current {2 (heading changed), 3}
    let mut parent = BTreeMap::new();
    parent.insert(1, loc(1, 10.0, 20.0));
    parent.insert(2, loc(2, 30.0, 40.0));
    let mut two_changed = loc(2, 30.0, 40.0);
    two_changed.heading = 90.0;
    let current = vec![two_changed, loc(3, 50.0, 60.0)];

    let (created, removed, added, removed_n, modified) = diff_states(&parent, &current);
    assert_eq!((added, removed_n, modified), (1, 1, 1));

    let created_ids: Vec<u32> = created.iter().map(|l| l.id).collect();
    let removed_ids: Vec<u32> = removed.iter().map(|l| l.id).collect();
    assert!(created_ids.contains(&3)); // added
    assert!(created_ids.contains(&2)); // modified-new
    assert!(removed_ids.contains(&1)); // deleted
    assert!(removed_ids.contains(&2)); // modified-old

    // The update carries new on the created side, old on the removed side.
    assert_eq!(created.iter().find(|l| l.id == 2).unwrap().heading, 90.0);
    assert_eq!(removed.iter().find(|l| l.id == 2).unwrap().heading, 0.0);
}

#[test]
fn replay_reconstructs_state() {
    // genesis: add 1,2 ; c2: add 3 remove 1 ; c3: modify 2
    let mut two_v2 = loc(2, 30.0, 40.0);
    two_v2.heading = 90.0;
    let deltas = vec![
        (vec![loc(1, 10.0, 20.0), loc(2, 30.0, 40.0)], vec![]),
        (vec![loc(3, 50.0, 60.0)], vec![loc(1, 10.0, 20.0)]),
        (vec![two_v2], vec![loc(2, 30.0, 40.0)]),
    ];
    let state = replay_deltas(&deltas);
    let ids: Vec<u32> = state.keys().copied().collect();
    assert_eq!(ids, vec![2, 3]); // 1 was removed
    assert_eq!(state.get(&2).unwrap().heading, 90.0); // 2 was updated
}

#[test]
fn replay_yields_strictly_sorted_ids() {
    // Out-of-order ids must come back ascending (the base-batch bake invariant).
    let deltas = vec![(vec![loc(3, 1.0, 1.0), loc(1, 2.0, 2.0), loc(2, 3.0, 3.0)], vec![])];
    let locs: Vec<Location> = replay_deltas(&deltas).into_values().collect();
    let ids: Vec<u32> = locs.iter().map(|l| l.id).collect();
    assert_eq!(ids, vec![1, 2, 3]);
    assert!((1..ids.len()).all(|i| ids[i - 1] < ids[i]));
}

#[test]
fn empty_commit_yields_empty_delta() {
    let mut parent = BTreeMap::new();
    parent.insert(1, loc(1, 10.0, 20.0));
    let current = vec![loc(1, 10.0, 20.0)];
    let (created, removed, added, removed_n, modified) = diff_states(&parent, &current);
    assert!(created.is_empty());
    assert!(removed.is_empty());
    assert_eq!((added, removed_n, modified), (0, 0, 0));
}

#[test]
fn delta_batch_round_trip_preserves_all_fields() {
    let mut l = loc(7, 12.5, -3.25);
    l.pano_id = Some("PANO123".into());
    l.modified_at = Some(1_767_330_245);
    l.tags = vec![1, 5, 9];
    let mut extra = serde_json::Map::new();
    extra.insert("note".into(), serde_json::Value::String("hi".into()));
    l.extra = crate::types::RawExtra::from_map(&extra);
    let removed = loc(3, 1.0, 2.0);

    let batch = arrow_bridge::delta_to_batch(&[l.clone()], &[removed.clone()]);
    let (created_out, removed_out) = arrow_bridge::batch_to_delta(&batch);

    assert_eq!(created_out, vec![l]);
    assert_eq!(removed_out, vec![removed]);
}

/// End-to-end storage path (minus the SQL chain walk): write each commit's delta
/// to a real Arrow file, read them back, replay, and materialize the checkout batch.
#[test]
fn deltas_round_trip_through_disk_and_replay() {
    use crate::storage::{read_arrow_ipc, write_arrow_ipc};

    // genesis: add 1,2,3 ; c2: modify 1, remove 2 ; c3: add 4
    let mut one_v2 = loc(1, 10.0, 20.0);
    one_v2.heading = 45.0;
    let commits: Vec<(Vec<Location>, Vec<Location>)> = vec![
        (vec![loc(1, 10.0, 20.0), loc(2, 30.0, 40.0), loc(3, 50.0, 60.0)], vec![]),
        (vec![one_v2], vec![loc(1, 10.0, 20.0), loc(2, 30.0, 40.0)]),
        (vec![loc(4, 70.0, 80.0)], vec![]),
    ];

    let dir = std::env::temp_dir().join("mma_test_vcs_delta_disk");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    for (i, (created, removed)) in commits.iter().enumerate() {
        let batch = arrow_bridge::delta_to_batch(created, removed);
        write_arrow_ipc(&dir.join(format!("c{i}.arrow")), &batch).unwrap();
    }

    let mut deltas = Vec::new();
    for i in 0..commits.len() {
        let batch = read_arrow_ipc(&dir.join(format!("c{i}.arrow"))).unwrap();
        deltas.push(arrow_bridge::batch_to_delta(&batch));
    }
    let state = replay_deltas(&deltas);

    // Final state {1 (heading 45), 3, 4}; 2 was removed.
    assert_eq!(state.keys().copied().collect::<Vec<_>>(), vec![1, 3, 4]);
    assert_eq!(state.get(&1).unwrap().heading, 45.0);

    // Checkout path: materialized base batch round-trips with strictly sorted ids.
    let locs: Vec<Location> = state.into_values().collect();
    let back = arrow_bridge::batch_to_locations(&arrow_bridge::locations_to_batch(&locs));
    assert_eq!(back.iter().map(|l| l.id).collect::<Vec<_>>(), vec![1, 3, 4]);

    let _ = std::fs::remove_dir_all(&dir);
}
