//! A host's side of a session: serving its map to the peers who join it.

use super::protocol::{
    Call, Catchup, Down, End, Frame, Member, Parting, Reply, Resume, Shown, Snapshot, Up, Wrote,
    PROTOCOL,
};
use super::rtc::Link;
use super::sessions::{CollabPresence, CollabSession, SessionLink};
use crate::store::engine::{
    hold, ChangeEvent, Finished, Hold, Holder, Intent, Store, StoreState, Target,
};
use crate::store::maps::MapMeta;
use crate::types::AppResult;
use crate::util::Lock;
use futures::future::{self, Either};
use mma_algebra::{Field, Id, JsonWrite, Patchable, Recent};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::{poll_fn, Future};
use std::ops::ControlFlow;
use std::pin::pin;
use std::sync::{Arc, Mutex};
use std::task::{ready, Poll};
use std::{iter, mem};
use tokio::sync::{mpsc, watch};

/// The field each location added in a session records the login that added it in.
pub(crate) const AUTHOR: &str = "author";

/// How many ids a peer is lent at a time.
pub(crate) const LEASE: u32 = 1024;

/// How many recent changes a host keeps for peers that come back.
pub(crate) const RING: usize = 256;

/// How many answers a host keeps per peer for writes it is sent again.
const ANSWERS: usize = 256;

/// Who may join a hosted map: the logins it is shared with, and guests while its invite is on.
#[derive(Clone, Debug, Default)]
pub(crate) struct Admission {
    pub(crate) logins: BTreeSet<String>,
    pub(crate) invite: bool,
}

impl Admission {
    /// Whether `member` may join.
    pub(crate) fn admits(&self, member: &Member) -> bool {
        if member.guest {
            self.invite
        } else {
            self.logins.contains(&member.login)
        }
    }
}

/// A map this app serves to the peers who join it, for one session.
pub(crate) struct Hosting {
    hold: Hold,
    map: Id<MapMeta, String>,
    name: String,
    session: u64,
    /// The session as the people in it see it.
    pub(crate) status: watch::Sender<CollabSession>,
    serving: Mutex<Serving>,
}

/// What a host's session keeps as it serves: who may join, its numbered changes, the peers
/// connected that have yet to say hello and those it welcomed, and what it answered each.
struct Serving {
    admission: Admission,
    log: Log,
    waiting: BTreeMap<u32, Peer>,
    welcomed: BTreeMap<u32, Peer>,
    answers: HashMap<String, Recent<u64, Vec<u8>>>,
    next: u32,
}

/// A peer's connection, and who its room vouched for.
struct Peer {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    member: Member,
}

/// A host's numbered changes to its map, the newest kept for peers that come back.
struct Log {
    feed: mpsc::UnboundedReceiver<ChangeEvent>,
    seq: u64,
    ring: Recent<u64, Vec<u8>>,
}

/// How a peer that comes back after a change catches up.
enum Since {
    /// With the frames of every change after it.
    Replay(Vec<Vec<u8>>),
    /// With the whole map.
    Snapshot,
}

impl Log {
    /// Number every change the map finished, `fed` first, and hand back the frames that send
    /// them on: each change that touches what the session shares, or once the base was
    /// rewritten or a change was too large for one frame, the map as `store` holds it.
    fn number(&mut self, fed: Option<ChangeEvent>, store: &Store) -> Vec<Vec<u8>> {
        let mut fed: Vec<ChangeEvent> = fed.into_iter().collect();
        while let Ok(more) = self.feed.try_recv() {
            fed.push(more);
        }
        let mut rebased = false;
        let mut frames = Vec::new();
        for fed in fed.into_iter().filter_map(|change| change.finished) {
            let framed = match fed {
                Finished::Entry(entry) => {
                    let shared = Arc::unwrap_or_clone(entry).shared();
                    if shared.keys().next().is_none() {
                        continue;
                    }
                    self.seq += 1;
                    let change = Down::Change {
                        seq: self.seq,
                        change: Arc::new(shared),
                    };
                    change.encode().ok()
                }
                Finished::Base => {
                    self.seq += 1;
                    None
                }
            };
            match framed {
                Some(bytes) => {
                    self.ring.put(self.seq, bytes.clone());
                    frames.push(bytes);
                }
                None => {
                    self.ring.clear();
                    rebased = true;
                }
            }
        }
        if !rebased {
            return frames;
        }
        Snapshot::of(store, self.seq)
            .frames()
            .unwrap_or_else(|error| {
                log::warn!("[collab] the map was not sent again: {}", error.0);
                Vec::new()
            })
    }

    /// How a peer that applied change `seq` of this session catches up.
    fn since(&self, seq: Option<u64>) -> Since {
        let Some(seq) = seq.filter(|seq| *seq <= self.seq) else {
            return Since::Snapshot;
        };
        if seq != self.seq && self.ring.oldest().is_none_or(|oldest| *oldest > seq + 1) {
            return Since::Snapshot;
        }
        Since::Replay(self.ring.after(&seq).cloned().collect())
    }
}

impl Hosting {
    /// Host map `map` as `name` for whoever `admission` admits, in a new session that keeps the
    /// map's store open and runs until the future returned with it exits.
    pub(crate) async fn start(
        stores: &'static StoreState,
        map: Id<MapMeta, String>,
        name: String,
        admission: Admission,
    ) -> AppResult<(Arc<Self>, impl Future<Output = ()> + Send + 'static)> {
        let session = Holder::Session(map.clone());
        let held = hold(stores, session.clone(), &map).await?;
        let (sink, feed) = mpsc::unbounded_channel();
        held.store(|store| {
            store.changes.insert(session, sink);
            Ok(())
        })?;
        let status = CollabSession {
            map: map.clone(),
            host: name.clone(),
            you: name.clone(),
            hosting: true,
            roster: vec![Member {
                login: name.clone(),
                guest: false,
            }],
            link: SessionLink::Live,
        };
        let hosting = Arc::new(Hosting {
            hold: held,
            map,
            name,
            session: fastrand::u64(1..),
            status: watch::Sender::new(status),
            serving: Mutex::new(Serving {
                admission,
                log: Log {
                    feed,
                    seq: 0,
                    ring: Recent::new(RING),
                },
                waiting: BTreeMap::new(),
                welcomed: BTreeMap::new(),
                answers: HashMap::new(),
                next: 0,
            }),
        });
        let serving = Arc::clone(&hosting);
        let running = async move {
            let mut status = serving.status.subscribe();
            let ended = pin!(status.wait_for(|session| session.link.ended().is_some()));
            let fed = pin!(poll_fn(|cx| loop {
                let mut session = serving.serving.locked();
                let Some(fed) = ready!(session.log.feed.poll_recv(cx)) else {
                    return Poll::Ready("the host deleted the map".to_string());
                };
                let caught_up = serving.hold.store(|store| {
                    session.catch_up(Some(fed), store);
                    Ok(())
                });
                if caught_up.is_err() {
                    return Poll::Ready("the host deleted the map".to_string());
                }
            }));
            if let Either::Right((reason, _)) = future::select(ended, fed).await {
                serving.end(&reason);
            }
            if let Err(error) = serving.hold.release().await {
                let map = &serving.map;
                log::warn!(
                    "[collab] map {map} was not saved after hosting: {}",
                    error.0
                );
            }
        };
        Ok((hosting, running))
    }

    /// Serve the peer at the other end of `link`, vouched for as `member`, until it parts.
    pub(crate) fn serve(self: &Arc<Self>, Link { tx, mut rx }: Link, member: Member) {
        let id = {
            let mut serving = self.serving.locked();
            let id = serving.next;
            serving.next += 1;
            let peer = Peer { tx, member };
            serving.waiting.insert(id, peer);
            id
        };
        let hosting = Arc::clone(self);
        tokio::spawn(async move {
            let parting = loop {
                let Some(bytes) = rx.recv().await else {
                    break Parting::Lost;
                };
                let frame = match Up::decode(&bytes) {
                    Ok(frame) => frame,
                    Err(error) => break End::Refused(error.0).into(),
                };
                if let ControlFlow::Break(parting) =
                    hosting.serving.locked().receive(&hosting, id, frame)
                {
                    break parting;
                }
            };
            log::info!("[collab] peer {id}: {parting}");
            hosting.serving.locked().close(&hosting, id);
        });
    }

    /// Change who may join, turning away anyone here who no longer may.
    pub(crate) fn admission(&self, change: impl FnOnce(&mut Admission)) {
        let mut serving = self.serving.locked();
        change(&mut serving.admission);
        let barred: Vec<(u32, bool)> = serving
            .waiting
            .iter()
            .chain(&serving.welcomed)
            .filter(|(_, peer)| !serving.admission.admits(&peer.member))
            .map(|(id, peer)| (*id, peer.member.guest))
            .collect();
        for (id, guest) in barred {
            let reason = if guest {
                "the host turned the invite off"
            } else {
                "the host stopped sharing the map with you"
            };
            let _ = serving.refuse(self, id, reason.into());
        }
    }

    /// Show `data` to everyone in the session.
    pub(crate) fn present(&self, data: Shown) {
        let login = self.name.clone();
        self.serving
            .locked()
            .relay(None, &Down::Presence { login, data });
    }

    /// End the session, telling every peer why.
    pub(crate) fn end(&self, reason: &str) {
        let ended = Down::End(End::Ended(reason.into()));
        let mut serving = self.serving.locked();
        let peers = mem::take(&mut serving.waiting).into_values();
        for peer in peers.chain(mem::take(&mut serving.welcomed).into_values()) {
            peer.send(&ended);
        }
        drop(serving);
        self.status.send_modify(|session| session.end(reason));
    }
}

impl Peer {
    fn deliver(&self, bytes: Vec<u8>) {
        let _ = self.tx.send(bytes);
    }

    fn send(&self, frame: &Down) {
        if let Some(bytes) = frame.bytes() {
            self.deliver(bytes);
        }
    }
}

impl Serving {
    /// Send every change the map finished and the session has not to every welcomed peer, so
    /// the log numbers the map as `store` holds it.
    fn catch_up(&mut self, fed: Option<ChangeEvent>, store: &Store) {
        let frames = self.log.number(fed, store);
        self.spread(frames);
    }

    /// Send `frames` to every welcomed peer.
    fn spread(&self, frames: Vec<Vec<u8>>) {
        for bytes in frames {
            for peer in self.welcomed.values() {
                peer.deliver(bytes.clone());
            }
        }
    }

    /// Send `frame` to every welcomed peer but `from`.
    fn relay(&self, from: Option<u32>, frame: &Down) {
        let Some(bytes) = frame.bytes() else {
            return;
        };
        for (id, peer) in &self.welcomed {
            if Some(*id) != from {
                peer.deliver(bytes.clone());
            }
        }
    }

    fn close(&mut self, host: &Hosting, id: u32) {
        self.waiting.remove(&id);
        if self.welcomed.remove(&id).is_some() {
            self.announce(host);
        }
    }

    /// Everyone welcomed, the host first.
    fn everyone(&self, host: &Hosting) -> Vec<Member> {
        let host = Member {
            login: host.name.clone(),
            guest: false,
        };
        iter::once(host)
            .chain(self.welcomed.values().map(|peer| peer.member.clone()))
            .collect()
    }

    /// Tell every welcomed peer, and the session's status, who is here now.
    fn announce(&self, host: &Hosting) {
        let roster = self.everyone(host);
        self.relay(None, &Down::Roster(roster.clone()));
        host.status.send_modify(|session| session.roster = roster);
    }

    fn refuse(&mut self, host: &Hosting, id: u32, reason: String) -> ControlFlow<Parting> {
        let refused = End::Refused(reason);
        if let Some(peer) = self.waiting.get(&id).or_else(|| self.welcomed.get(&id)) {
            peer.send(&Down::End(refused.clone()));
        }
        self.close(host, id);
        ControlFlow::Break(refused.into())
    }

    fn receive(&mut self, host: &Hosting, id: u32, frame: Up) -> ControlFlow<Parting> {
        if self.waiting.contains_key(&id) {
            return match frame {
                Up::Hello { protocol, resume } => self.welcome(host, id, protocol, resume),
                _ => self.refuse(host, id, "it did not say hello first".into()),
            };
        }
        let Some(login) = self.welcomed.get(&id).map(|peer| peer.member.login.clone()) else {
            return ControlFlow::Break(Parting::Left);
        };
        match frame {
            Up::Hello { .. } => return self.refuse(host, id, "it said hello twice".into()),
            Up::Resync => {
                let frames = host.hold.store(|store| {
                    self.catch_up(None, store);
                    Snapshot::of(store, self.log.seq).frames()
                });
                match frames {
                    Ok(frames) => frames
                        .into_iter()
                        .for_each(|bytes| self.welcomed[&id].deliver(bytes)),
                    Err(error) => return self.refuse(host, id, error.0),
                }
            }
            Up::Call {
                id: call,
                call: Call::Write(intent),
            } => self.answer(host, id, &login, call, intent),
            Up::Call {
                id: call,
                call: Call::Lease(len),
            } => {
                let reply = host
                    .hold
                    .store(|store| store.take_run(len))
                    .map(Reply::Lent)
                    .map_err(|error| error.0);
                self.welcomed[&id].send(&Down::Reply { id: call, reply });
            }
            Up::Presence(data) => {
                crate::emit_event(CollabPresence {
                    map: host.map.clone(),
                    login: login.clone(),
                    data: data.clone(),
                });
                self.relay(Some(id), &Down::Presence { login, data });
            }
            Up::Bye => return ControlFlow::Break(Parting::Left),
        }
        ControlFlow::Continue(())
    }

    fn welcome(
        &mut self,
        host: &Hosting,
        id: u32,
        protocol: u32,
        resume: Option<Resume>,
    ) -> ControlFlow<Parting> {
        if protocol != PROTOCOL {
            let reason = format!(
                "the host speaks collab protocol {PROTOCOL} and this app speaks {protocol}, so \
                 the older of the two needs an update"
            );
            return self.refuse(host, id, reason);
        }
        let Some(member) = self.waiting.get(&id).map(|peer| peer.member.clone()) else {
            return ControlFlow::Break(Parting::Left);
        };
        if !self.admission.admits(&member) {
            return self.refuse(host, id, "the host does not share the map with you".into());
        }
        let login = member.login.clone();
        let replaced: Vec<u32> = self
            .welcomed
            .iter()
            .filter(|(_, peer)| peer.member.login == login)
            .map(|(other, _)| *other)
            .collect();
        for other in replaced {
            self.close(host, other);
        }
        let resume = resume.filter(|resume| resume.session == host.session);
        if resume.is_none() {
            self.answers.remove(&login);
        }

        let caught_up = host.hold.store(|store| {
            self.catch_up(None, store);
            Ok(match self.log.since(resume.map(|resume| resume.seq)) {
                Since::Replay(frames) => (Catchup::Replay, frames),
                Since::Snapshot => (
                    Catchup::Snapshot,
                    Snapshot::of(store, self.log.seq).frames()?,
                ),
            })
        });
        let (catchup, caught_up) = match caught_up {
            Ok(caught_up) => caught_up,
            Err(error) => return self.refuse(host, id, error.0),
        };

        let roster = self
            .everyone(host)
            .into_iter()
            .chain(iter::once(member))
            .collect();
        let welcome = Down::Welcome {
            session: host.session,
            roster,
            catchup,
        };
        let Some(peer) = self.waiting.remove(&id) else {
            return ControlFlow::Break(Parting::Left);
        };
        peer.send(&welcome);
        for bytes in caught_up {
            peer.deliver(bytes);
        }
        log::info!("[collab] {login} joined as peer {id}");
        self.welcomed.insert(id, peer);
        self.announce(host);
        ControlFlow::Continue(())
    }

    /// Answer write `call` from `login`: from memory when it was answered before, else by
    /// making it, answering, and sending on the change that carries it.
    fn answer(&mut self, host: &Hosting, id: u32, login: &str, call: u64, mut intent: Intent) {
        let answers = self
            .answers
            .entry(login.to_string())
            .or_insert_with(|| Recent::new(ANSWERS));
        let Some(peer) = self.welcomed.get(&id) else {
            return;
        };
        if let Some(bytes) = answers.get(&call) {
            return peer.deliver(bytes.clone());
        }
        if answers.newest().is_some_and(|newest| call <= *newest) {
            let reply = Err("this write was answered too long ago to answer again".into());
            return peer.send(&Down::Reply { id: call, reply });
        }
        let wrote = host.hold.store(|store| {
            self.catch_up(None, store);
            intent.keeping_local(&store.meta);
            let author = Field::Set(JsonWrite::Merge(serde_json::json!({ AUTHOR: login })));
            for row in intent.adds_mut(store) {
                row.extra = row.extra.patched(&author);
            }
            let made = store
                .at(&Target::Map { id: None })
                .unrecorded()
                .write(intent)
                .settled();
            Ok((made, self.log.number(None, store)))
        });
        let (made, carried) = wrote.unwrap_or_else(|error| (Err(error), Vec::new()));
        let reply = made
            .map(|edited| {
                Reply::Wrote(Wrote {
                    seq: (!carried.is_empty()).then_some(self.log.seq),
                    keys: edited.records,
                    changed: edited.changed,
                    failed: edited.failed,
                })
            })
            .map_err(|error| error.0);
        if let Some(bytes) = (Down::Reply { id: call, reply }).bytes() {
            if let Some(answers) = self.answers.get_mut(login) {
                answers.put(call, bytes.clone());
            }
            if let Some(peer) = self.welcomed.get(&id) {
                peer.deliver(bytes);
            }
        }
        self.spread(carried);
    }
}
