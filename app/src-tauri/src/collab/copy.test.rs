use super::*;
use crate::collab::support::edit;
use crate::store::engine::{StoreManager, Tracked};
use crate::store::storage;
use crate::test_util::{loc, patch, Now};
use mma_algebra::Op;

fn origin() -> Origin {
    Origin {
        host: "host".into(),
        map: Id::new("hosted".into()),
        login: "alice".into(),
        parted: Some("digest".into()),
        via: Via::Map {
            host: "host".into(),
            map: Id::new("hosted".into()),
        },
    }
}

#[test]
fn a_copys_digest_moves_with_what_it_shares_and_not_with_what_stays_its_own() {
    let mut store = Store::new();
    edit(&mut store, vec![Op::Add(loc(0, 1.0, 1.0))]).now();
    let before = digest(&store).unwrap();

    let mut meta = (*store.meta).clone();
    meta.folder = Some("elsewhere".into());
    meta.last_opened_at = Some("now".into());
    meta.local_plugin_data.insert(
        "collab".into(),
        [("origin".into(), Json(serde_json::json!("here")))].into(),
    );
    store.meta = Tracked::new(meta);
    assert_eq!(digest(&store).unwrap(), before);

    edit(&mut store, vec![Op::Put(patch!(1; heading: 10.0))]).now();
    let moved = digest(&store).unwrap();
    assert_ne!(moved, before);

    store.meta.edit().name = "Renamed".into();
    assert_ne!(digest(&store).unwrap(), moved);
}

#[test]
fn a_stamp_lists_the_map_as_a_copy_and_stamping_again_replaces_it() {
    let copy = storage::tests::map_on_disk("stamped-copy");
    let conn = storage::open_db().unwrap();
    let parted = Origin {
        parted: Some("later".into()),
        ..origin()
    };
    for origin in [origin(), parted.clone()] {
        let meta = maps::read_map_meta(&conn, &copy).unwrap();
        storage::patch_row(
            &conn,
            "maps",
            copy.raw(),
            &meta,
            &origin.stamp(&meta).unwrap(),
        )
        .unwrap();
    }

    let listed: Vec<CollabCopy> = copies(&StoreState::new(StoreManager::new()))
        .unwrap()
        .into_iter()
        .filter(|listed| listed.map == copy)
        .collect();
    assert_eq!(
        listed,
        [CollabCopy {
            map: copy,
            origin: parted
        }]
    );
}
