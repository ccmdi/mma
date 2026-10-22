//! A peer's side of a session: following a map another app hosts.

use super::copy::{copies, digest, Origin};
use super::host::LEASE;
use super::protocol::{
    Call, Catchup, Down, Frame, Member, Part, Parting, Reply, Resume, Shown, Snapshot, Up, Wrote,
    PROTOCOL,
};
use super::rtc::Link;
use super::sessions::{CollabPresence, CollabSession, SessionLink};
use crate::store::engine::{
    hold, load_store, EditResult, Entry, Hold, Holder, Intent, Mutation, Reached, Recording, Store,
    StoreState, Target, Upstream,
};
use crate::store::maps::{self, MapMeta, MapSettings};
use crate::store::storage;
use crate::types::{AppError, AppResult, Location};
use crate::util::Lock;
use mma_algebra::{by_key, Change, Id, IdRange, Patchable, Transition};
use std::collections::{BTreeMap, BTreeSet};
use std::mem;
use std::ops::ControlFlow;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::{self, JoinHandle};
use tokio::time::{timeout_at, Instant};

/// How few lent ids a peer has left when it asks for more.
const LOW_WATER: u32 = LEASE / 4;

/// How long a peer waits for its host to answer a call.
const ANSWER_WITHIN: Duration = Duration::from_secs(60);

/// A peer following a map another app hosts into a map of its own, sending its writes to
/// that host.
pub(crate) struct Peer {
    state: &'static StoreState,
    map: Id<MapMeta, String>,
    origin: Origin,
    /// The session as the people in it see it.
    pub(crate) status: watch::Sender<CollabSession>,
    leaving: watch::Sender<bool>,
    hold: Mutex<Option<Hold>>,
    following: Mutex<Following>,
}

/// Whether a peer is ready to follow its host.
pub(crate) enum Joining {
    /// Ready to connect.
    Ready(Arc<Peer>),
    /// This app's copy `map` was edited after its last session ended, and joining replaces
    /// those edits.
    Edited(Id<MapMeta, String>),
}

/// Where a peer is in its host's session, and what it is still waiting on: the calls the host
/// has not answered, by number, and the answered writes waiting for the change that carries
/// them, by its number.
#[derive(Default)]
struct Following {
    reach: Reach,
    roster: Vec<Member>,
    session: Option<u64>,
    seq: u64,
    phase: Phase,
    backlog: Vec<(u64, Arc<Entry>)>,
    called: u64,
    calls: BTreeMap<u64, Open>,
    joins: BTreeMap<u64, (Open, Result<Reply, String>)>,
    top_up: Option<JoinHandle<()>>,
}

/// Whether a peer reaches its host.
#[derive(Default)]
enum Reach {
    /// Its first connection is being made.
    #[default]
    Connecting,
    /// The host is not online yet.
    Waiting,
    /// Connected, sending to the host here.
    Connected(mpsc::UnboundedSender<Vec<u8>>),
    /// The connection dropped and is being made again.
    Lost,
    /// The session is over, and why.
    Ended(String),
}

/// Whether a peer applies its host's changes as they come.
#[derive(Default)]
enum Phase {
    /// Each change applies as it arrives.
    #[default]
    Live,
    /// The map is coming from the host, after a welcome or a missed change.
    Behind,
    /// Changes wait until the host has answered every call up to this one, sent again on a
    /// new connection, so each write's change files the step its call carries.
    Answering(u64),
    /// A snapshot is arriving.
    Receiving(Box<Snapshot>),
}

/// A call the host has not answered: its frame, sent again on every new connection, where the
/// undo step of the write it makes goes, and who waits for its answer with the version this
/// peer reached by then.
struct Open {
    frame: Vec<u8>,
    recording: Recording,
    answer: oneshot::Sender<(Result<Reply, String>, u64)>,
}

impl Following {
    fn deliver(&self, bytes: Vec<u8>) {
        if let Reach::Connected(to_host) = &self.reach {
            let _ = to_host.send(bytes);
        }
    }

    /// How this peer's connection to the session stands.
    fn link(&self) -> SessionLink {
        match (&self.reach, &self.phase) {
            (Reach::Connecting, _) => SessionLink::Connecting,
            (Reach::Waiting, _) => SessionLink::Waiting,
            (Reach::Connected(_), Phase::Live) => SessionLink::Live,
            (Reach::Connected(_), _) => SessionLink::Syncing,
            (Reach::Lost, _) => SessionLink::Reconnecting,
            (Reach::Ended(reason), _) => SessionLink::Ended {
                reason: reason.clone(),
            },
        }
    }

    fn send(&self, frame: &Up) {
        if let Some(bytes) = frame.bytes() {
            self.deliver(bytes);
        }
    }

    /// Send `call` to the host, the undo step of the write it makes filed as `recording` says,
    /// answered with the version this peer reached by then and failing past
    /// [`ANSWER_WITHIN`]. A call that cannot be sent leaves `recording` here.
    fn call<T>(&mut self, call: Call, recording: &mut Recording) -> Reached<(T, u64)>
    where
        T: TryFrom<Reply, Error = AppError> + Send + 'static,
    {
        if !matches!(self.reach, Reach::Connected(_)) {
            return Reached::ready(Err("not connected to the map's host".into()));
        }
        self.called += 1;
        let id = self.called;
        let frame = match (Up::Call { id, call }).encode() {
            Ok(frame) => frame,
            Err(error) => return Reached::ready(Err(error)),
        };
        self.deliver(frame.clone());
        let (answer, answered) = oneshot::channel();
        let open = Open {
            frame,
            recording: recording.carried(),
            answer,
        };
        self.calls.insert(id, open);
        let deadline = Instant::now() + ANSWER_WITHIN;
        Reached::later(async move {
            match timeout_at(deadline, answered).await {
                Err(_) => Err("the map's host did not answer in time".into()),
                Ok(Err(_)) => Err("the map's host stopped before answering".into()),
                Ok(Ok((reply, version))) => Ok((T::try_from(reply.map_err(AppError)?)?, version)),
            }
        })
    }

    /// Fail every call still waiting on the host with `error`.
    fn fail(&mut self, error: &str) {
        let joins = mem::take(&mut self.joins)
            .into_values()
            .map(|(open, _)| open);
        for open in mem::take(&mut self.calls).into_values().chain(joins) {
            let _ = open.answer.send((Err(error.into()), 0));
        }
    }

    /// Apply the host's change `seq` in order: the next one at once, its undo step filed as the
    /// write waiting on it says, one already applied never, and one past a gap once the map
    /// comes again.
    fn apply(&mut self, store: &mut Store, seq: u64, change: Arc<Entry>) {
        match self.phase {
            Phase::Live if seq <= self.seq => {}
            Phase::Live if seq == self.seq + 1 => {
                let mut recording = self
                    .joins
                    .get_mut(&seq)
                    .map_or(Recording::Off, |(open, _)| open.recording.carried());
                let _ = store
                    .at(&Target::Map { id: None })
                    .joining(&mut recording)
                    .write(Arc::unwrap_or_clone(change));
                self.seq = seq;
            }
            Phase::Live => {
                self.phase = Phase::Behind;
                self.backlog.push((seq, change));
                self.send(&Up::Resync);
            }
            _ => self.backlog.push((seq, change)),
        }
    }

    /// Apply each change in order as it arrives from now on, starting with those that waited.
    fn go_live(&mut self, store: &mut Store) {
        self.phase = Phase::Live;
        for (seq, change) in mem::take(&mut self.backlog) {
            self.apply(store, seq, change);
        }
    }

    /// Send again every call the host has not answered, which it answers from memory when it
    /// made it.
    fn resend(&mut self) {
        self.calls.retain(|_, open| !open.answer.is_closed());
        for open in self.calls.values() {
            self.deliver(open.frame.clone());
        }
    }
}

impl Peer {
    /// A peer that follows the map `origin` names into this app's copy of it for its login,
    /// made on the first join and refilled on every one after. A copy edited since its last
    /// session ended is reported instead, unless `replace` says to replace those edits.
    pub(crate) async fn join(
        state: &'static StoreState,
        origin: Origin,
        replace: bool,
    ) -> AppResult<Joining> {
        let copied = task::spawn_blocking(move || copies(state))
            .await??
            .into_iter()
            .find_map(|copy| {
                let held = copy.origin;
                let same = held.host == origin.host
                    && held.map == origin.map
                    && held.login == origin.login;
                same.then_some((copy.map, held.parted))
            });
        let copy = match copied {
            Some((copy, Some(parted))) if !replace => {
                let open = state.lock()?.stores.get(&copy).map(digest);
                let now = match open {
                    Some(now) => now?,
                    None => {
                        let closed = copy.clone();
                        digest(&task::spawn_blocking(move || load_store(&closed)).await??)?
                    }
                };
                if now != parted {
                    return Ok(Joining::Edited(copy));
                }
                copy
            }
            Some((copy, _)) => copy,
            None => {
                let stamped = origin.clone();
                storage::with_db(move |conn| {
                    let copy = maps::insert_map(conn, "", None, &MapSettings::default())?;
                    storage::patch_row(conn, "maps", copy.id.raw(), &copy, &stamped.stamp(&copy)?)?;
                    Ok(copy.id)
                })
                .await?
            }
        };
        let status = CollabSession {
            map: copy.clone(),
            host: origin.host.clone(),
            you: origin.login.clone(),
            hosting: false,
            roster: Vec::new(),
            link: SessionLink::Connecting,
        };
        Ok(Joining::Ready(Arc::new(Self {
            state,
            map: copy,
            origin,
            status: watch::Sender::new(status),
            leaving: watch::Sender::new(false),
            hold: Mutex::default(),
            following: Mutex::default(),
        })))
    }

    /// This app's copy of the map, which the peer follows its host into.
    pub(crate) fn map(&self) -> &Id<MapMeta, String> {
        &self.map
    }

    /// Whether this peer is leaving, as it changes.
    pub(crate) fn leaving(&self) -> watch::Receiver<bool> {
        self.leaving.subscribe()
    }

    /// Show everyone in the session `data`.
    pub(crate) fn present(&self, data: Shown) {
        self.following.locked().send(&Up::Presence(data));
    }

    /// Join the host at the other end of `link`, resuming where this peer left off when it
    /// is the same session, and follow it until the connection ends. The map's store stays
    /// open from the first connection until the peer parts: a lost connection leaves it
    /// following, its writes refused until the next one, and any other ending parts.
    pub(crate) async fn connect(self: &Arc<Self>, Link { tx, mut rx }: Link) -> AppResult<Parting> {
        if self.hold.locked().is_none() {
            let held = hold(self.state, Holder::Session(self.map.clone()), &self.map).await?;
            self.stamp(&held);
            *self.hold.locked() = Some(held);
        }
        {
            let mut state = self.following.locked();
            state.reach = Reach::Connected(tx);
            state.phase = Phase::Behind;
            state.backlog.clear();
            state.send(&Up::Hello {
                protocol: PROTOCOL,
                resume: state.session.map(|session| Resume {
                    session,
                    seq: state.seq,
                }),
            });
            self.publish(&state);
        }
        let parting = loop {
            let Some(bytes) = rx.recv().await else {
                break if *self.leaving.borrow() {
                    Parting::Left
                } else {
                    Parting::Lost
                };
            };
            let received = self.store(|store| Ok(self.receive(store, &bytes)));
            match received {
                Ok(ControlFlow::Continue(())) => {}
                Ok(ControlFlow::Break(parting)) => break parting,
                Err(error) => {
                    log::warn!(
                        "[collab] left the session of a map that is gone: {}",
                        error.0
                    );
                    break Parting::Left;
                }
            }
        };
        if parting == Parting::Lost {
            let mut state = self.following.locked();
            state.reach = Reach::Lost;
            self.publish(&state);
        } else {
            self.part(&parting).await?;
        }
        Ok(parting)
    }

    /// Leave the session.
    pub(crate) fn leave(&self) {
        self.leaving.send_replace(true);
        let mut state = self.following.locked();
        state.send(&Up::Bye);
        state.reach = Reach::Lost;
    }

    /// Hear that the host could not be reached: waiting for it, unless a connection was lost.
    pub(crate) fn unreachable(&self) {
        let mut state = self.following.locked();
        if !matches!(state.reach, Reach::Lost) {
            state.reach = Reach::Waiting;
        }
        self.publish(&state);
    }

    /// Publish the session as `state` has it.
    fn publish(&self, state: &Following) {
        let session = CollabSession {
            roster: state.roster.clone(),
            link: state.link(),
            ..self.status.borrow().clone()
        };
        self.status.send_if_modified(|held| {
            let changed = *held != session;
            *held = session;
            changed
        });
    }

    /// Run `f` on the copy's store while the peer holds it.
    fn store<R>(&self, f: impl FnOnce(&mut Store) -> AppResult<R>) -> AppResult<R> {
        match &*self.hold.locked() {
            Some(held) => held.store(f),
            None => Err("the copy of the map is no longer followed".into()),
        }
    }

    /// Record on the copy what it holds now, so a later join can tell whether it was edited
    /// since. Done as a session starts too, so a copy a crash left mid-session counts as
    /// edited unless it still holds what it held then.
    fn stamp(&self, hold: &Hold) {
        let stamped = hold.store(|store| {
            let origin = Origin {
                parted: Some(digest(store)?),
                ..self.origin.clone()
            };
            let patch = origin.stamp(&store.meta)?;
            store.at(&Target::Map { id: None }).write(patch).settled()
        });
        if let Err(error) = stamped {
            log::warn!("[collab] the copy of the map was not stamped: {}", error.0);
        }
    }

    /// Stop following, as `parting` says: the session is over, every write still waiting on
    /// the host fails, and the store keeps the map as its own, stamped with what it holds,
    /// and is let go.
    pub(crate) async fn part(&self, parting: &Parting) -> AppResult<()> {
        {
            let mut state = self.following.locked();
            state.fail(&parting.to_string());
            state.roster.clear();
            state.reach = Reach::Ended(parting.to_string());
            self.publish(&state);
        }
        let Some(held) = self.hold.locked().take() else {
            return Ok(());
        };
        let _ = held.store(|store| {
            store.detach();
            Ok(())
        });
        self.stamp(&held);
        held.release().await
    }

    fn receive(self: &Arc<Self>, store: &mut Store, bytes: &[u8]) -> ControlFlow<Parting> {
        let frame = match Down::decode(bytes) {
            Ok(frame) => frame,
            Err(error) => {
                log::warn!(
                    "[collab] the host sent what this app cannot read: {}",
                    error.0
                );
                return ControlFlow::Break(Parting::Lost);
            }
        };
        let mut guard = self.following.locked();
        let state = &mut *guard;
        match frame {
            Down::Welcome {
                session,
                roster,
                catchup,
            } => {
                if state.session != Some(session) {
                    if state.session.is_some() {
                        state.fail("the map's host started a new session before answering");
                    }
                    store.replicate(Arc::clone(self) as Arc<dyn Upstream>);
                    state.session = Some(session);
                    state.seq = 0;
                }
                state.roster = roster;
                state.resend();
                state.phase = match catchup {
                    Catchup::Replay => Phase::Answering(state.called),
                    Catchup::Snapshot => Phase::Behind,
                };
            }
            Down::End(end) => return ControlFlow::Break(end.into()),
            Down::Snapshot(Part::Head(head)) => {
                state.phase = Phase::Receiving(Box::new(Snapshot {
                    rows: Vec::new(),
                    head: *head,
                }));
            }
            Down::Snapshot(Part::Rows(rows)) => match &mut state.phase {
                Phase::Receiving(snapshot) => snapshot.rows.extend(rows),
                _ => log::warn!("[collab] snapshot rows arrived outside a snapshot"),
            },
            Down::Snapshot(Part::End) => match mem::take(&mut state.phase) {
                Phase::Receiving(snapshot) => install(store, state, *snapshot),
                phase => {
                    state.phase = phase;
                    log::warn!("[collab] a snapshot ended that never began");
                }
            },
            Down::Change { seq, change } => state.apply(store, seq, change),
            Down::Reply { id, reply } => {
                if let Some(open) = state.calls.remove(&id) {
                    match &reply {
                        Ok(Reply::Wrote(Wrote { seq: Some(seq), .. })) => {
                            state.joins.insert(*seq, (open, reply));
                        }
                        _ => {
                            let _ = open.answer.send((reply, store.version));
                        }
                    }
                }
            }
            Down::Roster(roster) => state.roster = roster,
            Down::Presence { login, data } => {
                if login != self.origin.login {
                    crate::emit_event(CollabPresence {
                        map: self.map.clone(),
                        login,
                        data,
                    });
                }
            }
        }
        if let Phase::Answering(upto) = state.phase {
            if state.calls.range(..=upto).next().is_none() {
                state.go_live(store);
            }
        }
        self.publish(state);
        if !matches!(state.phase, Phase::Live) || state.session.is_none() {
            return ControlFlow::Continue(());
        }
        let waiting = state.joins.split_off(&(state.seq + 1));
        for (open, reply) in mem::replace(&mut state.joins, waiting).into_values() {
            let _ = open.answer.send((reply, store.version));
        }
        let left = store.next_id.remaining().unwrap_or(0);
        if left >= LOW_WATER
            || state
                .top_up
                .as_ref()
                .is_some_and(|top_up| !top_up.is_finished())
        {
            return ControlFlow::Continue(());
        }
        let session = state.session;
        drop(guard);
        let lent = self.lease(LEASE);
        let peer = Arc::clone(self);
        let top_up = tokio::spawn(async move {
            match lent.await {
                Ok(range) => {
                    let _ = peer.store(|store| {
                        if peer.following.locked().session == session {
                            store.next_id.lease(range);
                        }
                        Ok(())
                    });
                }
                Err(error) => log::warn!("[collab] the host lent no more ids: {}", error.0),
            }
        });
        self.following.locked().top_up = Some(top_up);
        ControlFlow::Continue(())
    }
}

/// Bring `store` to the map a snapshot carried, then apply what arrived after it in order and
/// send again every write still unanswered, which the host answers from memory when it made it.
fn install(store: &mut Store, state: &mut Following, Snapshot { head, rows }: Snapshot) {
    let held = by_key(store.all().rows().map(|row| row.to_location()));
    let locations = Change::between(&held, &by_key(rows));
    let fields: BTreeSet<String> = store
        .records
        .keys()
        .chain(head.records.keys())
        .cloned()
        .collect();
    let records = fields
        .into_iter()
        .map(|field| {
            let arriving = head.records.get(&field).cloned().unwrap_or_default();
            let delta = Change::between(&store.records(&field), &arriving);
            (field, delta)
        })
        .collect();
    let entry = Entry {
        locations,
        records,
        defs: Change::between(&*store.field_defs, &head.defs),
        meta: Change::from_iter([Transition::new(
            Some((*store.meta).clone()),
            Some(store.meta.patched(&head.meta)),
        )]),
        selections: Default::default(),
    };
    let _ = store
        .at(&Target::Map { id: None })
        .unrecorded()
        .write(entry);
    state.seq = head.seq;
    state.go_live(store);
    if matches!(state.phase, Phase::Live) {
        state.resend();
    }
}

impl Upstream for Peer {
    fn send(&self, intent: Intent, recording: &mut Recording) -> Reached<EditResult> {
        let mut state = self.following.locked();
        state
            .call::<Wrote>(Call::Write(intent), recording)
            .map(|(wrote, version)| EditResult {
                mutation: Mutation {
                    version,
                    ..Mutation::default()
                },
                invalidated: Vec::new(),
                records: wrote.keys,
                changed: wrote.changed,
                failed: wrote.failed,
            })
    }

    fn lease(&self, len: u32) -> Reached<IdRange<Location>> {
        let mut state = self.following.locked();
        state
            .call(Call::Lease(len), &mut Recording::Off)
            .map(|(range, _)| range)
    }
}
