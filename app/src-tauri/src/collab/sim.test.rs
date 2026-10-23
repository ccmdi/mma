use super::peer::Peer;
use super::protocol::Parting;
use super::support::{edit, named, nested_null, unfetched, Joined, Room, Wire, MAP};
use crate::selections::Selector;
use crate::store::engine::{Finished, Intent, Stack, Store, Target, Timeline, ValueRecord};
use crate::store::maps::{FieldDef, MapMeta};
use crate::test_util::{loc, patch, Now};
use crate::types::{AppResult, Location, RawExtra};
use mma_algebra::{Field, Id, JsonWrite, Op, Patch};
use proptest::collection;
use proptest::prelude::*;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::task::JoinHandle;

const PEERS: usize = 2;

/// Who writes a step.
#[derive(Clone, Copy, Debug)]
enum Who {
    Host,
    Peer(usize),
}

/// What a patch to a row changes.
#[derive(Clone, Debug)]
enum Patching {
    Heading(u16),
    Tags(Vec<usize>),
    Extra,
}

/// One thing that happens during a session.
#[derive(Clone, Debug)]
enum Step {
    Add {
        by: Who,
        at: u16,
    },
    Patch {
        by: Who,
        pick: usize,
        change: Patching,
    },
    Remove {
        by: Who,
        pick: usize,
    },
    Tag {
        by: Who,
        name: u8,
    },
    Untag {
        by: Who,
        pick: usize,
    },
    Rename {
        by: Who,
        name: u8,
    },
    Undo {
        peer: usize,
    },
    Redo {
        peer: usize,
    },
    Commit,
    Lose {
        peer: usize,
        at: u16,
    },
    Sever {
        peer: usize,
    },
    Resume {
        peer: usize,
    },
    Settle,
}

fn who() -> impl Strategy<Value = Who> {
    prop_oneof![Just(Who::Host), (0..PEERS).prop_map(Who::Peer)]
}

fn patching() -> impl Strategy<Value = Patching> {
    prop_oneof![
        any::<u16>().prop_map(Patching::Heading),
        collection::vec(any::<usize>(), 0..3).prop_map(Patching::Tags),
        Just(Patching::Extra),
    ]
}

fn step() -> impl Strategy<Value = Step> {
    prop_oneof![
        3 => (who(), any::<u16>()).prop_map(|(by, at)| Step::Add { by, at }),
        3 => (who(), any::<usize>(), patching())
            .prop_map(|(by, pick, change)| Step::Patch { by, pick, change }),
        2 => (who(), any::<usize>()).prop_map(|(by, pick)| Step::Remove { by, pick }),
        1 => (who(), 0u8..4).prop_map(|(by, name)| Step::Tag { by, name }),
        1 => (who(), any::<usize>()).prop_map(|(by, pick)| Step::Untag { by, pick }),
        1 => (who(), 0u8..4).prop_map(|(by, name)| Step::Rename { by, name }),
        2 => (0..PEERS).prop_map(|peer| Step::Undo { peer }),
        1 => (0..PEERS).prop_map(|peer| Step::Redo { peer }),
        1 => Just(Step::Commit),
        1 => (0..PEERS, any::<u16>()).prop_map(|(peer, at)| Step::Lose { peer, at }),
        1 => (0..PEERS).prop_map(|peer| Step::Sever { peer }),
        1 => (0..PEERS).prop_map(|peer| Step::Resume { peer }),
        2 => Just(Step::Settle),
    ]
}

/// A host and its peers on one store manager.
struct Sim {
    room: Room,
    peers: Vec<Follower>,
}

/// A peer in a sim, and its connection while it has one.
struct Follower {
    map: Id<MapMeta, String>,
    peer: Arc<Peer>,
    connection: Option<(Arc<Wire>, JoinHandle<AppResult<Parting>>)>,
}

impl Sim {
    fn new() -> Self {
        let rows = [
            Location {
                extra: RawExtra::from_value(&nested_null()),
                ..loc(0, 1.0, 1.0)
            },
            loc(0, 2.0, 2.0),
        ];
        let mut room = Room::new(&rows);
        room.with(&room.host, |host| {
            host.at(&MAP)
                .field("tags")
                .unwrap()
                .write(vec![named("Rural")])
                .now();
        });
        let peers = ["alice", "bob"]
            .into_iter()
            .map(|name| {
                let Joined {
                    map,
                    peer,
                    host_end,
                    parting,
                    ..
                } = room.join(name);
                Follower {
                    map,
                    peer,
                    connection: Some((host_end, parting)),
                }
            })
            .collect();
        Sim { room, peers }
    }

    /// The map `by` writes to, when it can write now.
    fn writer(&self, by: Who) -> Option<Id<MapMeta, String>> {
        match by {
            Who::Host => Some(self.room.host.clone()),
            Who::Peer(peer) => {
                let follower = &self.peers[peer];
                follower.connection.as_ref().map(|_| follower.map.clone())
            }
        }
    }

    fn write(&self, by: Who, write: impl FnOnce(&mut Store)) {
        if let Some(map) = self.writer(by) {
            self.room.with(&map, write);
        }
    }

    fn run(&mut self, step: &Step) {
        match step {
            Step::Add { by, at } => self.write(*by, |store| {
                let row = Location {
                    extra: (at % 2 == 0)
                        .then(|| RawExtra::from_value(&nested_null()))
                        .flatten(),
                    ..loc(0, f64::from(*at) / 1000.0, 0.5)
                };
                let _ = edit(store, vec![Op::Add(row)]);
            }),
            Step::Patch { by, pick, change } => self.write(*by, |store| {
                let Some(id) = picked(store, *pick) else {
                    return;
                };
                let put = match change {
                    Patching::Heading(heading) => patch!(id.get(); heading: f64::from(*heading)),
                    Patching::Tags(picks) => {
                        let held: Vec<Id<ValueRecord>> = {
                            let mut held: Vec<_> = store.records("tags").into_keys().collect();
                            held.sort();
                            held
                        };
                        let mut tags: Vec<Id<ValueRecord>> = picks
                            .iter()
                            .filter_map(|pick| held.get(pick % held.len().max(1)).copied())
                            .collect();
                        tags.sort();
                        tags.dedup();
                        patch!(id.get(); tags: tags)
                    }
                    Patching::Extra => patch!(id.get(); extra: Field::Set(JsonWrite::Merge(
                        json!({ "nested": { "literal": null, "deep": { "gone": null } }, "n": 2 })
                    ))),
                };
                let _ = edit(store, vec![Op::Put(put)]);
            }),
            Step::Remove { by, pick } => self.write(*by, |store| {
                if let Some(id) = picked(store, *pick) {
                    let _ = edit(store, vec![Op::Remove(id)]);
                }
            }),
            Step::Tag { by, name } => self.write(*by, |store| {
                let _ = store
                    .at(&MAP)
                    .field("tags")
                    .unwrap()
                    .write(vec![named(&format!("Tag {name}"))]);
            }),
            Step::Untag { by, pick } => self.write(*by, |store| {
                let mut held: Vec<Id<ValueRecord>> = store.records("tags").into_keys().collect();
                held.sort();
                if let Some(id) = held.get(pick % held.len().max(1)) {
                    let _ = store
                        .at(&MAP)
                        .field("tags")
                        .unwrap()
                        .write(vec![Op::Remove(*id)]);
                }
            }),
            Step::Rename { by, name } => self.write(*by, |store| {
                let renamed = Patch::<MapMeta> {
                    id: store.meta.id.clone(),
                    name: Some(format!("Map {name}")),
                    description: Some(format!("Described by {by:?}")),
                    ..Default::default()
                };
                let _ = store
                    .at(&Target::Map { id: None })
                    .write(Intent::Meta(Box::new(renamed)));
            }),
            Step::Undo { peer } => self.write(Who::Peer(*peer), |store| {
                let _ = store.step(Stack::Undo, Timeline::Edits, unfetched);
            }),
            Step::Redo { peer } => self.write(Who::Peer(*peer), |store| {
                let _ = store.step(Stack::Redo, Timeline::Edits, unfetched);
            }),
            Step::Commit => self.write(Who::Host, |host| {
                host.bake().unwrap();
                host.steps[Timeline::Edits].edit().clear();
                host.finish(Finished::Base, &HashMap::new());
            }),
            Step::Lose { peer, at } => {
                if let Some((host_end, _)) = &self.peers[*peer].connection {
                    self.room.settle();
                    host_end.drop_next(1);
                    self.run(&Step::Add {
                        by: Who::Host,
                        at: *at,
                    });
                }
            }
            Step::Sever { peer } => {
                if let Some((host_end, parting)) = self.peers[*peer].connection.take() {
                    host_end.sever();
                    self.room.settle();
                    assert_eq!(self.room.parted(parting), Parting::Lost);
                }
            }
            Step::Resume { peer } => self.resume(*peer),
            Step::Settle => self.room.settle(),
        }
    }

    fn resume(&mut self, peer: usize) {
        let follower = &mut self.peers[peer];
        if follower.connection.is_none() {
            let (_, host_end, parting) = self.room.connect(&follower.peer);
            follower.connection = Some((host_end, parting));
        }
    }

    /// Bring every peer back and let a last host change show anyone behind that they missed
    /// something.
    fn heal(&mut self) {
        for peer in 0..PEERS {
            self.resume(peer);
        }
        self.room.settle();
        self.run(&Step::Add {
            by: Who::Host,
            at: 1,
        });
        self.room.settle();
    }

    /// What a store shares with its session, in a form two stores compare by.
    fn held(&self, map: &Id<MapMeta, String>) -> Held {
        self.room.with(map, |store| {
            let mut rows = store.at(&MAP).rows(&Selector::Everything);
            rows.sort_by_key(|row| row.id);
            let meta = (*store.meta).clone();
            let mut settings = serde_json::to_value(&meta.settings).unwrap();
            settings.sort_all_objects();
            Held {
                rows,
                records: store.records("tags"),
                defs: (*store.field_defs).clone(),
                meta: (meta.name, meta.description, settings, meta.labels),
            }
        })
    }
}

/// Everything a host shares with its peers.
#[derive(Debug, PartialEq)]
struct Held {
    rows: Vec<Location>,
    records: HashMap<Id<ValueRecord>, ValueRecord>,
    defs: HashMap<String, FieldDef>,
    meta: (String, String, serde_json::Value, Vec<String>),
}

/// The id of the row `pick` lands on among the rows `store` holds.
fn picked(store: &Store, pick: usize) -> Option<Id<Location>> {
    let mut ids: Vec<Id<Location>> = store.all().rows().map(|row| row.id()).collect();
    ids.sort();
    ids.get(pick % ids.len().max(1)).copied()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]

    #[test]
    fn a_host_and_its_peers_hold_the_same_map_once_a_session_settles(
        steps in collection::vec(step(), 1..24),
    ) {
        let mut sim = Sim::new();
        for step in &steps {
            sim.run(step);
        }
        sim.heal();

        let host = sim.held(&sim.room.host);
        let mut ids: Vec<Id<Location>> = host.rows.iter().map(|row| row.id).collect();
        ids.dedup();
        prop_assert_eq!(ids.len(), host.rows.len());
        for joined in &sim.peers {
            prop_assert_eq!(&sim.held(&joined.map), &host);
        }
    }
}
