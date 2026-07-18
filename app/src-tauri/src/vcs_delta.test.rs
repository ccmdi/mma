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
        provider: None,
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
    let deltas = vec![(
        vec![loc(3, 1.0, 1.0), loc(1, 2.0, 2.0), loc(2, 3.0, 3.0)],
        vec![],
    )];
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
        (
            vec![loc(1, 10.0, 20.0), loc(2, 30.0, 40.0), loc(3, 50.0, 60.0)],
            vec![],
        ),
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

// -----------------------------------------------------------------------
// Model-based property test: diff_states + replay_deltas against a plain
// BTreeMap model driven by a random script of add/remove/modify commits.
// -----------------------------------------------------------------------

use proptest::prelude::*;

fn finite_f64() -> impl Strategy<Value = f64> {
    prop_oneof![
        1 => Just(0.0),
        1 => Just(-0.0),
        1 => Just(f64::MIN),
        1 => Just(f64::MAX),
        1 => Just(1.0 / 3.0),
        5 => -1.0e6f64..1.0e6,
    ]
}

fn arb_lat() -> impl Strategy<Value = f64> {
    prop_oneof![
        1 => Just(0.0),
        1 => Just(-0.0),
        1 => Just(90.0),
        1 => Just(-90.0),
        1 => Just(48.858_222_222_195_44),
        5 => -90.0f64..=90.0,
    ]
}

fn arb_lng() -> impl Strategy<Value = f64> {
    prop_oneof![
        1 => Just(0.0),
        1 => Just(-0.0),
        1 => Just(180.0),
        1 => Just(-180.0),
        1 => Just(2.352_222_222_195_44),
        5 => -180.0f64..=180.0,
    ]
}

fn arb_heading() -> impl Strategy<Value = f64> {
    prop_oneof![
        1 => Just(0.0),
        1 => Just(-0.0),
        1 => Just(360.0),
        1 => Just(123.456_789_012_3),
        5 => 0.0f64..=360.0,
    ]
}

fn arb_string() -> impl Strategy<Value = String> {
    prop_oneof![
        3 => "[a-zA-Z0-9_]{0,16}",
        2 => ".{0,12}",
        1 => Just(String::new()),
        1 => Just("caf\u{00e9}_\u{4e2d}\u{6587}_\u{1f600}".to_string()),
        1 => Just("\u{0000}\u{001f}".to_string()),
    ]
}

fn arb_pano_id() -> impl Strategy<Value = Option<String>> {
    prop_oneof![1 => Just(None), 3 => arb_string().prop_map(Some)]
}

fn arb_tags() -> impl Strategy<Value = Vec<u32>> {
    prop::collection::vec(any::<u32>(), 0..64)
}

fn arb_extra_map() -> impl Strategy<Value = serde_json::Map<String, serde_json::Value>> {
    prop::collection::vec((arb_string(), arb_string()), 1..5).prop_map(|pairs| {
        pairs
            .into_iter()
            .map(|(k, v)| (k, serde_json::Value::String(v)))
            .collect()
    })
}

fn arb_extra() -> impl Strategy<Value = Option<crate::types::RawExtra>> {
    prop_oneof![
        1 => Just(None),
        3 => arb_extra_map().prop_map(|m| crate::types::RawExtra::from_map(&m)),
    ]
}

fn arb_modified_at() -> impl Strategy<Value = Option<u32>> {
    prop_oneof![1 => Just(None), 3 => any::<u32>().prop_map(Some)]
}

/// A location body with a placeholder id; the caller assigns the real id.
fn arb_location_body() -> impl Strategy<Value = Location> {
    (
        arb_lat(),
        arb_lng(),
        arb_heading(),
        finite_f64(),
        finite_f64(),
        arb_pano_id(),
        any::<u32>().prop_map(crate::types::LocationFlags::from_bits_retain),
        arb_tags(),
        arb_extra(),
        any::<u32>(),
        arb_modified_at(),
    )
        .prop_map(
            |(
                lat,
                lng,
                heading,
                pitch,
                zoom,
                pano_id,
                flags,
                tags,
                extra,
                created_at,
                modified_at,
            )| {
                Location {
                    id: 0,
                    lat,
                    lng,
                    heading,
                    pitch,
                    zoom,
                    pano_id,
                    provider: None,
                    flags,
                    tags,
                    extra,
                    created_at,
                    modified_at,
                }
            },
        )
}

#[derive(Clone, Debug)]
enum Op {
    Add(Location),
    Remove(usize),
    Modify(usize, Location),
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        3 => arb_location_body().prop_map(Op::Add),
        1 => (0usize..64).prop_map(Op::Remove),
        3 => (0usize..64, arb_location_body()).prop_map(|(i, l)| Op::Modify(i, l)),
    ]
}

/// Apply one op to the model in place, assigning fresh ids for `Add` and
/// picking an existing id (by position, modulo the live count) for
/// `Remove`/`Modify`. A `Remove`/`Modify` against an empty model is a no-op.
fn apply_op(model: &mut BTreeMap<u32, Location>, op: &Op, next_id: &mut u32) {
    match op {
        Op::Add(body) => {
            let id = *next_id;
            *next_id += 1;
            let mut l = body.clone();
            l.id = id;
            model.insert(id, l);
        }
        Op::Remove(sel) => {
            if model.is_empty() {
                return;
            }
            let id = *model.keys().nth(sel % model.len()).unwrap();
            model.remove(&id);
        }
        Op::Modify(sel, body) => {
            if model.is_empty() {
                return;
            }
            let id = *model.keys().nth(sel % model.len()).unwrap();
            let mut l = body.clone();
            l.id = id;
            model.insert(id, l);
        }
    }
}

/// Independent reference implementation of `diff_states`' counts, computed by
/// direct set comparison of the two full states rather than reusing the SUT.
fn expected_counts(
    parent: &BTreeMap<u32, Location>,
    current: &BTreeMap<u32, Location>,
) -> (u32, u32, u32) {
    let mut added = 0u32;
    let mut removed = 0u32;
    let mut modified = 0u32;
    for id in parent.keys() {
        if !current.contains_key(id) {
            removed += 1;
        }
    }
    for (id, loc) in current {
        match parent.get(id) {
            None => added += 1,
            Some(ploc) => {
                if ploc != loc {
                    modified += 1;
                }
            }
        }
    }
    (added, removed, modified)
}

proptest! {
    #[test]
    fn prop_diff_and_replay_match_model(
        commits in prop::collection::vec(prop::collection::vec(op_strategy(), 0..5), 0..8)
    ) {
        let mut model: BTreeMap<u32, Location> = BTreeMap::new();
        let mut next_id: u32 = 1;
        let mut deltas: Vec<(Vec<Location>, Vec<Location>)> = Vec::new();

        for ops in &commits {
            let parent = model.clone();
            for op in ops {
                apply_op(&mut model, op, &mut next_id);
            }
            let current: Vec<Location> = model.values().cloned().collect();
            let (created, removed, added_n, removed_n, modified_n) = diff_states(&parent, &current);

            let (exp_added, exp_removed, exp_modified) = expected_counts(&parent, &model);
            prop_assert_eq!(added_n, exp_added);
            prop_assert_eq!(removed_n, exp_removed);
            prop_assert_eq!(modified_n, exp_modified);

            deltas.push((created, removed));
        }

        let replayed = replay_deltas(&deltas);
        prop_assert_eq!(&replayed, &model);

        let ids: Vec<u32> = replayed.keys().copied().collect();
        prop_assert!((1..ids.len()).all(|i| ids[i - 1] < ids[i]));
    }
}
