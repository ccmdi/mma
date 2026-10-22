use super::*;
use crate::selections::Selector;
use crate::test_util::{loc, patch, Host, Now};
use futures::executor::block_on;
use futures::FutureExt;
use mma_algebra::{Edit, Id, IdRange, Op};

const MAP: Target = Target::Map { id: None };

fn rows(store: &mut Store) -> Vec<Location> {
    store.at(&MAP).rows(&Selector::Everything)
}

#[test]
fn a_replica_writes_nothing_locally_before_the_host_answers() {
    let (host, mut replica) = Host::pair("shared", &[loc(0, 1.0, 1.0)]);
    let before = (replica.version, rows(&mut replica), replica.history());

    let edited = replica.at(&MAP).write(vec![Op::Remove(Id::new(1))]);

    assert!(edited.now_or_never().is_none());
    assert_eq!(
        (replica.version, rows(&mut replica), replica.history()),
        before
    );
    assert!(rows(&mut host.store.lock().unwrap()).is_empty());
}

#[test]
fn a_host_error_reaches_the_caller_and_leaves_both_stores_unchanged() {
    let (host, mut replica) = Host::pair("shared", &[loc(0, 1.0, 1.0)]);
    let versions = |replica: &Store| (replica.version, host.store.lock().unwrap().version);
    let before = versions(&replica);

    let refused = replica
        .at(&MAP)
        .field("tags")
        .unwrap()
        .write(vec![Op::Remove(Id::new(1))]);
    host.answer(&mut replica);

    assert!(block_on(refused).is_err());
    assert_eq!(versions(&replica), before);
}

#[test]
fn a_layer_landing_on_a_replica_forwards_its_edits() {
    let (host, mut replica) = Host::pair("shared", &[loc(0, 1.0, 1.0)]);
    let draft = Target::Pending {
        name: "draft".into(),
    };
    let held = replica
        .at(&draft)
        .write(vec![Op::Add(loc(0, 2.0, 2.0))])
        .now_or_never();
    assert!(held.is_some_and(|held| held.is_ok()));
    assert_eq!(rows(&mut host.store.lock().unwrap()).len(), 1);

    let landed = replica
        .at(&Target::Pending {
            name: "draft".into(),
        })
        .land();
    assert_eq!(rows(&mut host.store.lock().unwrap()).len(), 2);
    assert_eq!(rows(&mut replica).len(), 1);

    host.answer(&mut replica);
    let landed = block_on(landed).unwrap();
    assert_eq!(landed.version, replica.version);
    assert_eq!(rows(&mut replica), rows(&mut host.store.lock().unwrap()));
}

#[test]
fn a_replica_refuses_to_commit_and_has_nothing_to_step_through_before_it_edits() {
    let (_host, mut replica) = Host::pair("shared", &[loc(0, 1.0, 1.0)]);
    let version = replica.version;

    assert!(replica.bake().is_err());
    for (stack, timeline) in [
        (Stack::Undo, Timeline::Edits),
        (Stack::Redo, Timeline::Edits),
        (Stack::Undo, Timeline::Selections),
    ] {
        assert!(replica.step(stack, timeline, unfetched).now().is_none());
    }
    assert_eq!(replica.version, version);
}

fn unfetched(_: u64) -> AppResult<Entry> {
    panic!("a replica's step fetches nothing")
}

fn moved(lat: f64) -> Vec<Edit<Location>> {
    vec![Op::Put(patch!(1; lat: lat))]
}

fn edited(host: &Host, replica: &mut Store, edits: Vec<Edit<Location>>, join: &mut Recording) {
    let edited = replica.at(&MAP).joining(join).write(edits);
    host.answer(replica);
    block_on(edited).unwrap();
}

#[test]
fn writes_joined_into_one_replica_step_undo_together() {
    let (host, mut replica) = Host::pair("shared", &[loc(0, 1.0, 1.0)]);
    let before = rows(&mut replica);
    let mut join = Recording::default();
    edited(&host, &mut replica, moved(5.0), &mut join);
    edited(
        &host,
        &mut replica,
        vec![Op::Add(loc(0, 3.0, 3.0))],
        &mut join,
    );
    assert_eq!(rows(&mut replica).len(), 2);

    let undone = replica.step(Stack::Undo, Timeline::Edits, unfetched);
    host.answer(&mut replica);
    block_on(undone).unwrap();

    assert_eq!(rows(&mut replica), before);
    assert_eq!(rows(&mut host.store.lock().unwrap()), before);
    assert_eq!(
        replica.history()[&Timeline::Edits],
        History {
            undo: false,
            redo: true
        }
    );
}

fn lent(host: &Host, replica: &mut Store, len: u32) -> IdRange<Location> {
    let lease = host.store.lock().unwrap().take_run(len).unwrap();
    replica.next_id.lease(lease.clone());
    lease
}

#[test]
fn an_exhausted_lease_refuses_the_write_and_changes_nothing() {
    let (host, mut replica) = Host::pair("shared", &[loc(0, 1.0, 1.0)]);
    let lease = lent(&host, &mut replica, 1);
    let two = || vec![Op::Add(loc(0, 2.0, 2.0)), Op::Add(loc(0, 3.0, 3.0))];
    let draft = Target::Pending {
        name: "draft".into(),
    };
    let before = (replica.version, rows(&mut replica), replica.history());

    assert!(replica.at(&MAP).write(two()).settled().is_err());
    assert!(replica.at(&draft).write(two()).settled().is_err());

    assert_eq!(
        (replica.version, rows(&mut replica), replica.history()),
        before
    );
    assert!(!replica.pending.contains_key("draft"));
    assert_eq!(rows(&mut host.store.lock().unwrap()).len(), 1);
    let one = replica.at(&MAP).write(vec![Op::Add(loc(0, 2.0, 2.0))]);
    host.answer(&mut replica);
    let keys = block_on(one).unwrap().mutation.keys;
    assert_eq!(keys, [lease.first]);
}

#[test]
fn adopting_host_rows_never_moves_a_replicas_allocation_out_of_its_lease() {
    let (host, mut replica) = Host::pair("shared", &[loc(0, 1.0, 1.0)]);
    let lease = lent(&host, &mut replica, 4);
    let theirs = host
        .store
        .lock()
        .unwrap()
        .at(&MAP)
        .write(vec![Op::Add(loc(0, 8.0, 8.0))])
        .now()
        .mutation
        .keys;
    edited(&host, &mut replica, moved(5.0), &mut Recording::default());
    assert!(replica.get_loc_by_id(theirs[0]).is_some());
    assert!(!lease.contains(theirs[0]));

    let mine = replica.at(&MAP).write(vec![Op::Add(loc(0, 2.0, 2.0))]);
    host.answer(&mut replica);
    let keys = block_on(mine).unwrap().mutation.keys;
    assert_eq!(keys, [lease.first]);
}

#[test]
fn a_detached_replica_keeps_its_rows_and_writes_new_ones_itself_above_them() {
    let (host, mut replica) = Host::pair("shared", &[loc(0, 1.0, 1.0)]);
    let theirs = host
        .store
        .lock()
        .unwrap()
        .at(&MAP)
        .write(vec![Op::Add(loc(0, 8.0, 8.0))])
        .now()
        .mutation
        .keys;
    edited(&host, &mut replica, moved(5.0), &mut Recording::default());
    let held = rows(&mut replica);

    replica.detach();
    let added = replica
        .at(&MAP)
        .write(vec![Op::Add(loc(0, 2.0, 2.0))])
        .now()
        .mutation;

    assert!(added.keys[0] > theirs[0]);
    assert_eq!(rows(&mut replica).len(), held.len() + 1);
    assert_eq!(rows(&mut host.store.lock().unwrap()), held);
}

#[test]
fn a_write_from_another_app_keeps_this_devices_own_map_details() {
    let (host, _) = Host::pair("shared", &[]);
    let here = MapMeta {
        folder: Some("mine".into()),
        ..(*host.store.lock().unwrap().meta).clone()
    };
    let theirs = MapMeta {
        folder: Some("theirs".into()),
        name: "Renamed".into(),
        ..here.clone()
    };

    let mut details = Intent::Meta(Box::new(Patch::<MapMeta> {
        folder: Some("theirs".to_string()).into(),
        name: Some("Renamed".into()),
        ..Patch::<MapMeta>::of(here.id.clone())
    }));
    details.keeping_local(&here);
    let Intent::Meta(patch) = details else {
        unreachable!()
    };
    assert_eq!(
        *patch,
        Patch::<MapMeta> {
            name: Some("Renamed".into()),
            ..Patch::<MapMeta>::of(here.id.clone())
        }
    );

    let mut whole = Intent::Entry(Box::new(Entry {
        meta: [Transition::new(Some(here.clone()), Some(theirs))]
            .into_iter()
            .collect(),
        ..Default::default()
    }));
    whole.keeping_local(&here);
    let Intent::Entry(entry) = whole else {
        unreachable!()
    };
    let after = entry
        .meta
        .transitions()
        .find_map(|t| t.after.cloned())
        .unwrap();
    assert_eq!(
        (after.folder.as_deref(), after.name.as_str()),
        (Some("mine"), "Renamed")
    );
}
