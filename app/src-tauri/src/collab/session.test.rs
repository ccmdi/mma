use super::copy::{copies, digest, Origin, Via};
use super::host::{Admission, Hosting, AUTHOR, LEASE, RING};
use super::peer::Joining;
use super::protocol::{Down, End, Frame, Member, Part, Parting, Shown, Up, PROTOCOL};
use super::rtc::Link;
use super::sessions::SessionLink;
use super::support::{edit, named, unfetched, Room, Wire, MAP};
use crate::selections::Selector;
use crate::store::engine::{
    load_store, release, with_target, Finished, Holder, Intent, LocationOp, Stack, Target,
    Timeline, WindowLabel, Work,
};
use crate::store::maps::MapMeta;
use crate::test_util::{loc, patch, Now};
use crate::types::{Location, RawExtra};
use futures::FutureExt;
use mma_algebra::{Id, Op, Patch};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

#[test]
fn a_map_edited_in_a_host_window_reaches_its_peers() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    let window = WindowLabel("host-window".into());
    room.state
        .lock()
        .unwrap()
        .holders
        .insert(Holder::Window(window.clone()), room.host.clone());

    with_target(room.state, &window, &MAP, |store| {
        Ok(edit(store, vec![Op::Put(patch!(1; heading: 90.0))]).now())
    })
    .unwrap();
    room.settle();

    assert_eq!(room.rows(&alice.map)[0].heading, 90.0);
    room.assert_same(&alice.map);
}

#[test]
fn closing_the_last_window_on_a_hosted_map_or_its_copy_keeps_the_session_going() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    let windows = [
        (WindowLabel("host-window".into()), room.host.clone()),
        (WindowLabel("alice-window".into()), alice.map.clone()),
    ];
    for (window, map) in &windows {
        room.state
            .lock()
            .unwrap()
            .holders
            .insert(Holder::Window(window.clone()), map.clone());
    }
    for (window, _) in &windows {
        room.rt
            .block_on(release(room.state, &Holder::Window(window.clone())))
            .unwrap();
    }
    for (_, map) in &windows {
        assert!(room.state.lock().unwrap().stores.contains_key(map));
    }

    room.edited(&room.host, vec![Op::Put(patch!(1; pitch: 5.0))])
        .now();
    let added = room.edited(&alice.map, vec![Op::Add(loc(0, 2.0, 2.0))]);
    room.wrote(added).unwrap();
    room.settle();

    assert_eq!(room.rows(&room.host).len(), 2);
    room.assert_same(&alice.map);
}

#[test]
fn a_peers_write_returns_the_hosts_keys_at_the_version_the_peer_reached() {
    let mut room = Room::new(&[]);
    room.with(&room.host, |host| {
        host.at(&MAP)
            .field("tags")
            .unwrap()
            .write(vec![named("Rural")])
            .now();
    });
    let alice = room.join("alice");

    let urban = room.with(&alice.map, |store| {
        store
            .at(&MAP)
            .field("tags")
            .unwrap()
            .write(vec![named("Urban")])
    });
    let urban = room.wrote(urban).unwrap();
    let added = room
        .wrote(room.edited(&alice.map, vec![Op::Add(loc(0, 1.0, 1.0))]))
        .unwrap();

    let key = room.with(&room.host, |host| {
        host.records("tags")
            .into_iter()
            .find(|(_, record)| record.name.as_deref() == Some("Urban"))
            .map(|(id, _)| id)
    });
    assert_eq!(urban.keys, key.into_iter().collect::<Vec<_>>());
    let added_key = added.mutation.keys[0];
    let on_host = room.with(&room.host, |host| host.get_loc_by_id(added_key));
    room.with(&alice.map, |held| {
        assert_eq!(added.mutation.version, held.version);
        assert_eq!(held.get_loc_by_id(added_key), on_host);
        assert!(held.get_loc_by_id(added_key).is_some());
    });
}

#[test]
fn a_write_sent_again_after_its_answer_was_lost_is_answered_from_memory_and_made_once() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");

    alice.host_end.drop_next(2);
    let added = room.edited(&alice.map, vec![Op::Add(loc(0, 5.0, 5.0))]);
    room.settle();
    assert_eq!(room.rows(&room.host).len(), 2);
    assert_eq!(room.rows(&alice.map).len(), 1);

    room.edited(&room.host, vec![Op::Add(loc(0, 6.0, 6.0))])
        .now();
    let added = room.wrote(added).unwrap();
    room.settle();

    assert_eq!(room.rows(&room.host).len(), 3);
    room.assert_same(&alice.map);
    let key = added.mutation.keys[0];
    assert!(room.with(&alice.map, |store| store.get_loc_by_id(key).is_some()));
}

#[test]
fn a_missed_change_or_a_host_commit_makes_a_peer_take_the_map_again() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    assert_eq!(snapshots(&alice.link), 1);

    alice.host_end.drop_next(1);
    room.edited(&room.host, vec![Op::Put(patch!(1; lat: 7.0))])
        .now();
    room.edited(&room.host, vec![Op::Add(loc(0, 8.0, 8.0))])
        .now();
    room.settle();
    assert_eq!(snapshots(&alice.link), 2);

    room.with(&room.host, |host| host.finish(Finished::Base));
    room.settle();
    assert_eq!(snapshots(&alice.link), 3);
}
#[test]
fn a_late_joiner_takes_the_map_then_follows_it_live() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    room.wrote(room.edited(&alice.map, vec![Op::Add(loc(0, 2.0, 2.0))]))
        .unwrap();
    room.edited(&room.host, vec![Op::Put(patch!(1; zoom: 2.0))])
        .now();
    room.settle();

    let bob = room.join("bob");
    assert_eq!(snapshots(&bob.link), 1);
    assert_eq!(changes(&bob.link), 0);
    room.assert_same(&bob.map);
    for peer in [&alice.peer, &bob.peer] {
        assert_eq!(
            logins(&peer.status.borrow().roster),
            ["host", "alice", "bob"]
        );
    }
    assert_eq!(
        logins(&room.hosting.status.borrow().roster),
        ["host", "alice", "bob"]
    );

    room.edited(&room.host, vec![Op::Remove(Id::new(1))]).now();
    room.settle();
    assert_eq!(changes(&bob.link), 1);
    room.assert_same(&bob.map);
    room.assert_same(&alice.map);
}

#[test]
fn a_peer_back_within_the_ring_has_what_it_missed_replayed_and_past_it_takes_the_map() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    let peer = Arc::clone(&alice.peer);
    alice.peer.leave();
    assert_eq!(room.parted(alice.parting), Parting::Left);

    room.edited(&room.host, vec![Op::Add(loc(0, 2.0, 2.0))])
        .now();
    room.edited(&room.host, vec![Op::Put(patch!(1; lat: 3.0))])
        .now();
    let (link, _, parting) = room.connect(&peer);
    assert_eq!(snapshots(&link), 0);
    assert_eq!(changes(&link), 2);
    room.assert_same(&alice.map);

    peer.leave();
    assert_eq!(room.parted(parting), Parting::Left);
    for lat in 0..=RING {
        room.edited(&room.host, vec![Op::Add(loc(0, lat as f64, 0.0))])
            .now();
    }
    let (link, ..) = room.connect(&peer);
    assert_eq!(snapshots(&link), 1);
    room.assert_same(&alice.map);
}

#[test]
fn a_peer_speaking_another_protocol_or_no_login_is_turned_away() {
    let mut room = Room::new(&[]);
    let (mut near, far) = Link::pair();
    room.serve(far, "alice".into());
    let hello = Up::Hello {
        protocol: PROTOCOL + 1,
        resume: None,
    };
    near.tx.send(hello.encode().unwrap()).unwrap();

    let reply = room.rt.block_on(near.rx.recv()).unwrap();
    let Ok(Down::End(End::Refused(reason))) = Down::decode(&reply) else {
        panic!("a refusal");
    };
    assert!(reason.contains("protocol"));
    assert_eq!(room.rt.block_on(near.rx.recv()), None);

    let stranger = room.join("not a login");
    assert!(matches!(
        room.parted(stranger.parting),
        Parting::Over(End::Refused(_))
    ));
}

#[test]
fn a_peer_renames_the_hosts_map_and_its_copy_still_knows_where_it_came_from() {
    let mut room = Room::new(&[]);
    let alice = room.join("alice");

    let renamed = room.with(&alice.map, |store| {
        let patch = Patch::<MapMeta> {
            id: store.meta.id.clone(),
            name: Some("Renamed".into()),
            ..Default::default()
        };
        store
            .at(&Target::Map { id: None })
            .write(Intent::Meta(Box::new(patch)))
    });
    room.wrote(renamed).unwrap();
    room.settle();

    assert_eq!(
        room.with(&room.host, |host| host.meta.name.clone()),
        "Renamed"
    );
    assert_eq!(
        room.with(&alice.map, |peer| peer.meta.name.clone()),
        "Renamed"
    );
    assert_eq!(
        origin_of(&room, &alice.map).map(|origin| origin.map),
        Some(room.host.clone())
    );
}

#[test]
fn an_ended_session_and_a_lost_one_both_leave_the_peer_its_rows_as_its_own() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    let bob = room.join("bob");
    let windows = [
        ("host-window", &room.host),
        ("alice-window", &alice.map),
        ("bob-window", &bob.map),
    ];
    for (window, map) in windows {
        room.state
            .lock()
            .unwrap()
            .holders
            .insert(Holder::Window(WindowLabel(window.into())), map.clone());
    }

    bob.host_end.hold();
    let unanswered = room.edited(&bob.map, vec![Op::Add(loc(0, 2.0, 2.0))]);
    room.settle();
    bob.link.sever();
    room.hosting.end("the host closed the map");
    room.settle();
    let held = room.rows(&room.host);

    assert_eq!(
        room.parted(alice.parting),
        End::Ended("the host closed the map".into()).into()
    );
    assert_eq!(room.parted(bob.parting), Parting::Lost);
    room.rt.block_on(bob.peer.part(&Parting::Lost)).unwrap();
    assert!(room.wrote(unanswered).is_err());
    assert!(alice.peer.status.borrow().roster.is_empty());
    assert_eq!(room.rows(&alice.map), held);
    assert_eq!(room.rows(&bob.map), held[..1]);
    for map in [&alice.map, &bob.map] {
        let added = room.edited(map, vec![Op::Add(loc(0, 9.0, 9.0))]);
        assert!(added.now_or_never().is_some_and(|added| added.is_ok()));
    }
    assert_eq!(room.rows(&room.host), held);
}

#[test]
fn a_peers_undo_and_redo_reach_the_host_and_both_converge() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    let before = room.rows(&room.host);
    room.wrote(room.edited(&alice.map, vec![Op::Put(patch!(1; lat: 5.0))]))
        .unwrap();
    let after = room.rows(&room.host);
    assert_ne!(after, before);

    for (stack, held) in [(Stack::Undo, &before), (Stack::Redo, &after)] {
        let step = room.with(&alice.map, |store| {
            store.step(stack, Timeline::Edits, unfetched)
        });
        let stepped = room.wrote(step).unwrap().expect("a step to take");

        assert_eq!(&room.rows(&room.host), held);
        room.assert_same(&alice.map);
        assert_eq!(
            stepped.version,
            room.with(&alice.map, |store| store.version)
        );
    }
}
#[test]
fn a_peer_tops_up_its_lease_so_adds_keep_working_past_the_first_block() {
    let mut room = Room::new(&[]);
    let alice = room.join("alice");
    let batches = 2 * LEASE as usize / 100;
    let mut keys = Vec::new();
    for batch in 0..batches {
        let adds = (0..100).map(|row| Op::Add(loc(0, batch as f64, row as f64)));
        let added = room.wrote(room.edited(&alice.map, adds.collect())).unwrap();
        keys.extend(added.mutation.keys);
        room.settle();
    }

    keys.sort();
    keys.dedup();
    assert_eq!(keys.len(), batches * 100);
    assert_eq!(room.rows(&room.host).len(), batches * 100);
    room.assert_same(&alice.map);
}

#[test]
fn a_peer_back_in_a_restarted_hosts_new_session_adds_with_ids_that_session_lent() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    alice.link.sever();
    room.settle();
    assert_eq!(room.parted(alice.parting), Parting::Lost);

    room.hosting.end("restarting");
    let (state, host) = (room.state, room.host.clone());
    room.rt.block_on(async move {
        while state.lock().unwrap().stores.contains_key(&host) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });
    let admission = Admission {
        logins: ["alice".to_string()].into(),
        invite: false,
    };
    let starting = Hosting::start(room.state, room.host.clone(), "host".into(), admission);
    let (hosting, serving) = room.rt.block_on(starting).unwrap();
    room.rt.spawn(serving);
    room.hosting = hosting;
    room.connect(&alice.peer);

    room.edited(&room.host, vec![Op::Add(loc(0, 2.0, 2.0))])
        .now();
    room.wrote(room.edited(&alice.map, vec![Op::Add(loc(0, 3.0, 3.0))]))
        .unwrap();
    room.settle();

    assert_eq!(room.rows(&room.host).len(), 3);
    room.assert_same(&alice.map);
}

/// Every map stamped as a copy of the room's host, with where it says it came from.
fn copies_of(room: &Room) -> Vec<(Id<MapMeta, String>, Origin)> {
    copies(room.state)
        .unwrap()
        .into_iter()
        .filter(|copy| copy.origin.map == room.host)
        .map(|copy| (copy.map, copy.origin))
        .collect()
}

/// Where this app's map `copy` was copied from.
fn origin_of(room: &Room, copy: &Id<MapMeta, String>) -> Option<Origin> {
    copies(room.state)
        .unwrap()
        .into_iter()
        .find(|listed| &listed.map == copy)
        .map(|listed| listed.origin)
}

#[test]
fn a_first_join_makes_a_listed_local_map_stamped_with_where_it_came_from() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");

    let origin = Origin {
        host: "host".into(),
        map: room.host.clone(),
        login: "alice".into(),
        parted: None,
        via: Via::Map {
            host: "host".into(),
            map: room.host.clone(),
        },
    };
    let [(copy, held)] = copies_of(&room).try_into().unwrap();
    assert_eq!(copy, alice.map);
    assert!(held.parted.is_some());
    assert_eq!(
        Origin {
            parted: None,
            ..held
        },
        origin
    );
    room.assert_same(&alice.map);
}

#[test]
fn rejoining_a_hosted_map_refills_the_copy_the_first_join_made() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    alice.peer.leave();
    room.parted(alice.parting);
    room.edited(&room.host, vec![Op::Add(loc(0, 2.0, 2.0))])
        .now();

    let again = room.join("alice");

    assert_eq!(again.map, alice.map);
    assert_eq!(copies_of(&room).len(), 1);
    assert_eq!(room.rows(&again.map).len(), 2);
    room.assert_same(&again.map);
}

#[test]
fn rejoining_over_edits_made_to_the_copy_since_reports_them_and_replaces_them_only_when_told() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    alice.peer.leave();
    room.parted(alice.parting);
    let copy = Target::Map {
        id: Some(alice.map.clone()),
    };
    with_target(room.state, &WindowLabel("w".into()), &copy, |store| {
        Ok(edit(store, vec![Op::Add(loc(0, 5.0, 5.0))]).now())
    })
    .unwrap();
    let edited = load_store(&alice.map)
        .unwrap()
        .at(&MAP)
        .rows(&Selector::Everything);
    assert_eq!(edited.len(), 2);

    let Joining::Edited(reported) = room.joining("alice", false) else {
        panic!("a join over edits reports them");
    };
    assert_eq!(reported, alice.map);
    assert!(!room.state.lock().unwrap().stores.contains_key(&alice.map));
    assert_eq!(
        load_store(&alice.map)
            .unwrap()
            .at(&MAP)
            .rows(&Selector::Everything),
        edited
    );

    let Joining::Ready(peer) = room.joining("alice", true) else {
        panic!("a join told to replace the edits goes ahead");
    };
    let again = room.follow(peer);
    assert_eq!(again.map, alice.map);
    assert_eq!(room.rows(&again.map).len(), 1);
    room.assert_same(&again.map);
}

#[test]
fn after_its_host_ends_the_session_a_copy_is_a_plain_local_map_that_reopens_with_its_rows() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    room.wrote(room.edited(&alice.map, vec![Op::Add(loc(0, 2.0, 2.0))]))
        .unwrap();
    room.settle();
    let held = room.rows(&room.host);
    let name = room.with(&room.host, |host| host.meta.name.clone());

    room.hosting.end("done for today");
    room.settle();
    assert_eq!(
        room.parted(alice.parting),
        End::Ended("done for today".into()).into()
    );
    assert!(!room.state.lock().unwrap().stores.contains_key(&alice.map));

    let mut reopened = load_store(&alice.map).unwrap();
    assert!(reopened.upstream.is_none());
    assert_eq!(reopened.meta.name, name);
    assert_eq!(reopened.at(&MAP).rows(&Selector::Everything), held);
    let origin = origin_of(&room, &alice.map).unwrap();
    assert_eq!(origin.parted, Some(digest(&reopened).unwrap()));
    let added = edit(&mut reopened, vec![Op::Add(loc(0, 3.0, 3.0))]);
    assert!(added.now_or_never().is_some_and(|added| added.is_ok()));
}

#[test]
fn a_lost_peer_keeps_following_refuses_writes_until_back_and_its_unanswered_write_lands_once() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    assert_eq!(alice.peer.status.borrow().link, SessionLink::Live);
    alice.host_end.hold();
    let unanswered = room.edited(&alice.map, vec![Op::Add(loc(0, 2.0, 2.0))]);
    room.settle();
    alice.link.sever();
    room.settle();
    assert_eq!(room.parted(alice.parting), Parting::Lost);
    assert_ne!(alice.peer.status.borrow().link, SessionLink::Live);
    assert!(room.with(&alice.map, |store| store.upstream.is_some()));

    let offline = room.edited(&alice.map, vec![Op::Add(loc(0, 3.0, 3.0))]);
    assert!(room.wrote(offline).is_err());

    let (_, _, parting) = room.connect(&alice.peer);
    assert_eq!(alice.peer.status.borrow().link, SessionLink::Live);
    room.wrote(unanswered).unwrap();
    room.settle();
    assert_eq!(room.rows(&room.host).len(), 2);
    room.assert_same(&alice.map);
    alice.peer.leave();
    assert_eq!(room.parted(parting), Parting::Left);
}

#[test]
fn a_write_whose_answer_a_lost_connection_kept_back_still_files_its_undo_step() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    alice.host_end.drop_next(2);
    let moved = room.edited(&alice.map, vec![Op::Put(patch!(1; lat: 5.0))]);
    room.settle();
    alice.link.sever();
    room.settle();
    assert_eq!(room.parted(alice.parting), Parting::Lost);

    let (link, ..) = room.connect(&alice.peer);
    room.wrote(moved).unwrap();
    room.settle();
    assert_eq!((snapshots(&link), changes(&link)), (0, 1));
    room.assert_same(&alice.map);

    let undo = room.with(&alice.map, |store| {
        store.step(Stack::Undo, Timeline::Edits, unfetched)
    });
    room.wrote(undo).unwrap().expect("the write's step to undo");
    room.settle();
    assert_eq!(room.rows(&room.host)[0].lat, 1.0);
    room.assert_same(&alice.map);
}

#[test]
fn the_host_turns_away_a_login_it_does_not_share_with() {
    let room = Room::new(&[]);
    let (mut near, far) = Link::pair();
    room.serve(far, "carol".into());
    let hello = Up::Hello {
        protocol: PROTOCOL,
        resume: None,
    };
    near.tx.send(hello.encode().unwrap()).unwrap();
    let reply = room.rt.block_on(near.rx.recv()).unwrap();
    assert!(matches!(
        Down::decode(&reply),
        Ok(Down::End(End::Refused(_)))
    ));
    assert_eq!(logins(&room.hosting.status.borrow().roster), ["host"]);
}

#[test]
fn unsharing_a_login_turns_its_peer_away_and_everyone_sees_it_go() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    let bob = room.join("bob");
    room.hosting
        .admission(|admission| admission.logins = ["alice".to_string()].into());
    room.settle();

    assert!(matches!(
        room.parted(bob.parting),
        Parting::Over(End::Refused(_))
    ));
    assert_eq!(
        logins(&alice.peer.status.borrow().roster),
        ["host", "alice"]
    );
    assert_eq!(
        logins(&room.hosting.status.borrow().roster),
        ["host", "alice"]
    );
}

#[test]
fn a_copy_a_crash_left_mid_session_counts_as_edited_on_the_next_join() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    room.rt
        .block_on(crate::store::engine::save(room.state, &alice.map))
        .unwrap();

    let Joining::Edited(copy) = room.joining("alice", false) else {
        panic!("a copy no session ended is taken as edited");
    };
    assert_eq!(copy, alice.map);
}

#[test]
fn a_hosts_undo_refuses_to_wipe_a_peers_later_edit_and_keeps_its_history() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    room.edited(&room.host, vec![Op::Put(patch!(1; lat: 5.0))])
        .now();
    room.settle();
    room.wrote(room.edited(&alice.map, vec![Op::Put(patch!(1; lat: 7.0))]))
        .unwrap();
    room.settle();
    let held = room.rows(&room.host);

    let refused = room.with(&room.host, |store| {
        store
            .step(Stack::Undo, Timeline::Edits, unfetched)
            .settled()
    });
    assert!(refused.is_err_and(|error| error.0.contains("edited since")));
    assert_eq!(room.rows(&room.host), held);
    room.assert_same(&alice.map);
    assert!(room.with(&room.host, |store| store.history()[&Timeline::Edits].undo));
}

#[test]
fn a_hosts_undo_takes_back_its_own_edit_and_leaves_a_peers_later_one() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0), loc(0, 2.0, 2.0)]);
    let alice = room.join("alice");
    room.edited(&room.host, vec![Op::Put(patch!(1; lat: 5.0))])
        .now();
    room.settle();
    room.wrote(room.edited(&alice.map, vec![Op::Put(patch!(2; lat: 7.0))]))
        .unwrap();
    room.settle();

    room.with(&room.host, |store| {
        store.step(Stack::Undo, Timeline::Edits, unfetched).now()
    })
    .expect("the host's own edit to undo");
    room.settle();

    let lats: Vec<f64> = room.rows(&room.host).iter().map(|row| row.lat).collect();
    assert_eq!(lats, [1.0, 7.0]);
    room.assert_same(&alice.map);
    assert!(room.with(&room.host, |store| store.history()[&Timeline::Edits].redo));
}

#[test]
fn a_peers_undo_the_host_refuses_leaves_its_history_instead_of_failing_every_time() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    room.wrote(room.edited(&alice.map, vec![Op::Put(patch!(1; lat: 5.0))]))
        .unwrap();
    room.edited(&room.host, vec![Op::Put(patch!(1; lat: 7.0))])
        .now();
    room.settle();

    let undo = room.with(&alice.map, |store| {
        store.step(Stack::Undo, Timeline::Edits, unfetched)
    });
    assert!(room.wrote(undo).is_err());
    room.settle();

    assert!(!room.with(&alice.map, |store| store.history()[&Timeline::Edits].undo));
    room.assert_same(&alice.map);
}

#[test]
fn a_write_the_host_leaves_unanswered_fails_once_its_deadline_passes() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    alice.host_end.hold();
    let unanswered = room.edited(&alice.map, vec![Op::Add(loc(0, 2.0, 2.0))]);
    room.settle();

    room.rt.block_on(async { tokio::time::pause() });
    let Err(failed) = room.wrote(unanswered) else {
        panic!("an unanswered write fails past its deadline");
    };
    assert!(failed.0.contains("did not answer in time"), "{}", failed.0);
}

#[test]
fn what_someone_shows_reaches_everyone_else_each_time_and_their_leaving_reaches_the_roster() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    let bob = room.join("bob");
    let pointing = serde_json::from_value::<Shown>(
        json!({ "cursor": { "lat": 1.0, "lng": 2.0 }, "open": { "location": 7 } }),
    )
    .unwrap();
    let hosting =
        serde_json::from_value::<Shown>(json!({ "cursor": { "lat": 5.0, "lng": 5.0 } })).unwrap();

    alice.peer.present(pointing.clone());
    alice.peer.present(pointing.clone());
    room.hosting.present(hosting.clone());
    room.settle();

    let seen = shown(&bob.link);
    let from = |login: &str| seen.iter().filter(|(by, _)| by == login).count();
    assert_eq!((from("alice"), from("host")), (2, 1));
    assert!(seen.contains(&("alice".into(), pointing)));
    assert!(seen.contains(&("host".into(), hosting)));
    assert!(shown(&alice.link).iter().all(|(by, _)| by != "alice"));

    alice.peer.leave();
    room.settle();
    assert_eq!(logins(&bob.peer.status.borrow().roster), ["host", "bob"]);
}

#[test]
fn a_guest_joins_while_the_invite_is_on_and_is_turned_away_once_it_goes_off() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let guest = room.join("guest--a1b2c3");
    room.assert_same(&guest.map);
    let origin = origin_of(&room, &guest.map);
    assert_eq!(
        origin.map(|origin| origin.via),
        Some(Via::Code {
            code: "k7m2p9qa".into()
        })
    );
    assert!(room.hosting.status.borrow().roster.contains(&Member {
        login: "guest--a1b2c3".into(),
        guest: true,
    }));

    room.hosting.admission(|admission| admission.invite = false);
    room.settle();
    assert!(matches!(
        room.parted(guest.parting),
        Parting::Over(End::Refused(_))
    ));

    let again = room.join("guest--d4e5f6");
    assert!(matches!(
        room.parted(again.parting),
        Parting::Over(End::Refused(_))
    ));
}

fn author_of(room: &Room, map: &Id<MapMeta, String>, lat: f64) -> Option<serde_json::Value> {
    room.rows(map)
        .into_iter()
        .find(|row| row.lat == lat)
        .and_then(|row| row.extra?.get(AUTHOR))
}

#[test]
fn every_location_a_peer_adds_names_who_added_it_and_a_peer_cannot_claim_another() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    room.edited(&room.host, vec![Op::Add(loc(0, 2.0, 2.0))])
        .now();
    room.wrote(room.edited(&alice.map, vec![Op::Add(loc(0, 3.0, 3.0))]))
        .unwrap();
    let claimed = Location {
        extra: RawExtra::from_value(&json!({ AUTHOR: "bob" })),
        ..loc(0, 4.0, 4.0)
    };
    room.wrote(room.edited(&alice.map, vec![Op::Add(claimed)]))
        .unwrap();
    room.settle();

    assert_eq!(author_of(&room, &room.host, 1.0), None);
    assert_eq!(author_of(&room, &room.host, 2.0), None);
    assert_eq!(author_of(&room, &room.host, 3.0), Some(json!("alice")));
    assert_eq!(author_of(&room, &room.host, 4.0), Some(json!("alice")));
    room.assert_same(&alice.map);
    assert!(room.with(&room.host, |store| store.field_defs.contains_key(AUTHOR)));
}

#[test]
fn an_undo_while_reconnecting_is_refused_and_stays_to_undo() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    room.wrote(room.edited(&alice.map, vec![Op::Put(patch!(1; lat: 5.0))]))
        .unwrap();
    alice.link.sever();
    room.settle();
    assert_eq!(room.parted(alice.parting), Parting::Lost);

    let undo = room.with(&alice.map, |store| {
        store.step(Stack::Undo, Timeline::Edits, unfetched)
    });
    assert!(room.wrote(undo).is_err());
    assert!(room.with(&alice.map, |store| store.history()[&Timeline::Edits].undo));
}

#[test]
fn a_peers_write_that_changes_nothing_is_answered_and_leaves_no_step() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    let version = room.with(&alice.map, |store| store.version);

    room.wrote(room.edited(&alice.map, vec![Op::Put(patch!(1; lat: 1.0))]))
        .unwrap();
    room.settle();

    assert_eq!(room.with(&alice.map, |store| store.version), version);
    assert!(!room.with(&alice.map, |store| store.history()[&Timeline::Edits].undo));
    room.assert_same(&alice.map);
}

#[test]
fn work_on_a_copy_is_planned_by_the_host_against_rows_the_copy_has_not_seen_yet() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0), loc(0, 2.0, 2.0)]);
    let alice = room.join("alice");
    alice.host_end.drop_next(1);
    room.edited(&room.host, vec![Op::Put(patch!(1; lat: 7.0))])
        .now();
    room.settle();

    let worked = room.with(&alice.map, |store| {
        store
            .at(&MAP)
            .scope(&Selector::Everything)
            .write(Work::Locations(LocationOp::Set {
                key: "kind".into(),
                value: json!("rural"),
            }))
    });
    let worked = room.wrote(worked).unwrap();
    room.settle();

    assert_eq!(worked.changed, 2);
    let kinds: Vec<_> = room
        .rows(&room.host)
        .into_iter()
        .map(|row| (row.lat, row.extra.and_then(|extra| extra.get("kind"))))
        .collect();
    assert_eq!(
        kinds,
        [(7.0, Some(json!("rural"))), (2.0, Some(json!("rural")))]
    );
    room.assert_same(&alice.map);
}

#[test]
fn a_change_too_large_for_one_frame_reaches_peers_as_the_map_before_its_write_is_answered() {
    let rows: Vec<Location> = (0..2400).map(|n| loc(0, n as f64 / 100.0, 0.0)).collect();
    let mut room = Room::new(&rows);
    let alice = room.join("alice");
    let bob = room.join("bob");

    let worked = room.with(&alice.map, |store| {
        store
            .at(&MAP)
            .scope(&Selector::Everything)
            .write(Work::Locations(LocationOp::Set {
                key: "blob".into(),
                value: json!("x".repeat(15_000)),
            }))
    });
    let worked = room.wrote(worked).unwrap();

    assert_eq!(worked.changed, 2400);
    room.assert_same(&alice.map);
    room.settle();
    room.assert_same(&bob.map);
}

#[test]
fn work_on_a_copy_answers_the_locations_the_host_could_not_work_out() {
    let counted = Location {
        extra: RawExtra::from_value(&json!({ "n": 1 })),
        ..loc(0, 1.0, 1.0)
    };
    let mut room = Room::new(&[counted, loc(0, 2.0, 2.0)]);
    let alice = room.join("alice");

    let worked = room.with(&alice.map, |store| {
        store
            .at(&MAP)
            .scope(&Selector::Everything)
            .write(Work::Locations(LocationOp::Expr {
                key: "double".into(),
                expr: "n * 2".into(),
            }))
    });
    let worked = room.wrote(worked).unwrap();
    room.settle();

    assert_eq!((worked.changed, worked.failed), (1, vec![Id::new(2)]));
    room.assert_same(&alice.map);
}

#[test]
fn the_host_never_sends_where_it_files_its_map() {
    let mut room = Room::new(&[loc(0, 1.0, 1.0)]);
    let alice = room.join("alice");
    let details = |patch: Patch<MapMeta>| {
        room.with(&room.host, |store| store.at(&MAP).write(patch).now());
        room.settle();
    };

    details(Patch::<MapMeta> {
        folder: Some("mine".to_string()).into(),
        ..Patch::<MapMeta>::of(room.host.clone())
    });
    assert_eq!(changes(&alice.link), 0);
    details(Patch::<MapMeta> {
        name: Some("Renamed".into()),
        ..Patch::<MapMeta>::of(room.host.clone())
    });
    assert_eq!(changes(&alice.link), 1);
    assert_eq!(
        room.with(&alice.map, |store| store.meta.folder.clone()),
        None
    );
}

fn logins(roster: &[Member]) -> Vec<&str> {
    roster.iter().map(|member| member.login.as_str()).collect()
}

fn snapshots(link: &Wire) -> usize {
    let frames = link.received_frames();
    frames
        .iter()
        .filter(|frame| matches!(frame, Down::Snapshot(Part::Head(_))))
        .count()
}

fn changes(link: &Wire) -> usize {
    let frames = link.received_frames();
    frames
        .iter()
        .filter(|frame| matches!(frame, Down::Change { .. }))
        .count()
}

fn shown(link: &Wire) -> Vec<(String, Shown)> {
    let frames = link.received_frames();
    frames
        .into_iter()
        .filter_map(|frame| match frame {
            Down::Presence { login, data } => Some((login, data)),
            _ => None,
        })
        .collect()
}
