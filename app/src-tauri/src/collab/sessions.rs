//! This app's collab sessions: the maps it hosts and the maps it follows, kept going until
//! they end or are left.

use super::copy::{copies, CollabCopy, Origin, Via};
use super::host::{Admission, Hosting};
use super::peer::{Joining, Peer};
use super::protocol::{End, Member, Parting, Shown};
use super::room::{backoff, Role, Room};
use super::rtc::{self, Addresses, Tuning, INTERNET};
use super::worker::{Credential, Invite, Share, Shares, Worker};
use crate::net::encoded;
use crate::store::engine::{save, StoreState};
use crate::store::maps::{self, MapMeta};
use crate::store::storage;
use crate::types::AppResult;
use crate::util::Lock;
use futures::future::{BoxFuture, FutureExt};
use mma_algebra::Id;
use reqwest::Method;
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;
use tauri::async_runtime::{self, JoinHandle};
use tauri::Manager;
use tokio::sync::watch;
use tokio::task::JoinSet;
use tokio::time::sleep;

/// How often a session saves its map.
const SAVE_EVERY: Duration = Duration::from_secs(5);

/// A map this app hosts or follows, as the people in it see it.
#[derive(Clone, Debug, PartialEq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollabSession {
    /// This app's map the session edits.
    pub(crate) map: Id<MapMeta, String>,
    /// The login hosting the map.
    pub(crate) host: String,
    /// The login this app is in the session as.
    pub(crate) you: String,
    /// Whether this app is the host.
    pub(crate) hosting: bool,
    /// Everyone in the session, the host first.
    pub(crate) roster: Vec<Member>,
    /// How this app's connection to the session stands.
    pub(crate) link: SessionLink,
}

/// How a session's connection stands.
#[derive(Clone, Debug, PartialEq, serde::Serialize, specta::Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum SessionLink {
    /// Waiting for the host to come online.
    Waiting,
    /// Connecting to the host.
    Connecting,
    /// Connected, and receiving the map from the host.
    Syncing,
    /// Connected.
    Live,
    /// The connection dropped and is being made again.
    Reconnecting,
    /// The session is over, and why.
    Ended { reason: String },
}

/// Every collab session this app is in and every map it copied from another app's, sent
/// whenever a session changes.
#[derive(Clone, serde::Serialize, specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "collab-sessions")]
pub(crate) struct CollabSessions {
    /// The sessions, each on one of this app's maps.
    pub(crate) sessions: Vec<CollabSession>,
    /// The copies of other apps' maps.
    pub(crate) copies: Vec<CollabCopy>,
}

/// What someone else in the session on this app's map `map` shows everyone, sent each time
/// they show something new.
#[derive(Clone, serde::Serialize, specta::Type, tauri_specta::Event)]
#[tauri_specta(event_name = "collab-presence")]
pub(crate) struct CollabPresence {
    /// This app's map the session edits.
    pub(crate) map: Id<MapMeta, String>,
    /// Who shows it.
    pub(crate) login: String,
    /// What they show.
    pub(crate) data: Shown,
}

/// What happened when this app tried to join a map.
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub(crate) enum JoinOutcome {
    /// Joined, following the host into this app's map `map`.
    Following { map: Id<MapMeta, String> },
    /// This app's copy `map` was edited since its last session, so joining would replace those
    /// edits; join again with `replace` to go ahead.
    Edited { map: Id<MapMeta, String> },
}

impl SessionLink {
    /// Why the session ended, once it has.
    pub(crate) fn ended(&self) -> Option<String> {
        match self {
            SessionLink::Ended { reason } => Some(reason.clone()),
            _ => None,
        }
    }
}

impl CollabSession {
    /// The session, over for `reason`, with nobody left in it.
    pub(crate) fn end(&mut self, reason: &str) {
        self.link = SessionLink::Ended {
            reason: reason.into(),
        };
        self.roster.clear();
    }
}

/// A session this app is in: its status as it changes, this app's side of it, and the work
/// that runs it.
struct Running {
    status: watch::Receiver<CollabSession>,
    side: Side,
    task: JoinHandle<()>,
}

/// This app's side of a session.
#[derive(Clone)]
enum Side {
    Host(Arc<Hosting>),
    Peer(Arc<Peer>),
}

impl Side {
    fn status(&self) -> &watch::Sender<CollabSession> {
        match self {
            Side::Host(hosting) => &hosting.status,
            Side::Peer(peer) => &peer.status,
        }
    }

    /// The map this app hosts, when it is the host.
    fn hosting(self) -> Option<Arc<Hosting>> {
        match self {
            Side::Host(hosting) => Some(hosting),
            Side::Peer(_) => None,
        }
    }

    /// Show `data` to everyone else in the session.
    fn present(&self, data: Shown) {
        match self {
            Side::Host(hosting) => hosting.present(data),
            Side::Peer(peer) => peer.present(data),
        }
    }

    /// Leave the session: a host ends it for everyone, a peer keeps its copy.
    fn leave(&self) {
        match self {
            Side::Host(hosting) => hosting.end("the host stopped hosting the map"),
            Side::Peer(peer) => peer.leave(),
        }
    }
}

/// This app's side of the session on `map`, while it is in one.
fn side(map: &Id<MapMeta, String>) -> Option<Side> {
    running().get(map).map(|running| running.side.clone())
}

fn running() -> MutexGuard<'static, BTreeMap<Id<MapMeta, String>, Running>> {
    static RUNNING: OnceLock<Mutex<BTreeMap<Id<MapMeta, String>, Running>>> = OnceLock::new();
    RUNNING.get_or_init(Mutex::default).locked()
}

fn announce(sessions: &BTreeMap<Id<MapMeta, String>, Running>) {
    match listed(sessions) {
        Ok(listed) => crate::emit_event(listed),
        Err(error) => log::warn!("[collab] the sessions were not announced: {}", error.0),
    }
}

/// `sessions` as the app sees them, with every copy this app holds.
fn listed(sessions: &BTreeMap<Id<MapMeta, String>, Running>) -> AppResult<CollabSessions> {
    Ok(CollabSessions {
        sessions: sessions
            .values()
            .map(|running| running.status.borrow().clone())
            .collect(),
        copies: copies(store_state()?)?,
    })
}

/// Whether this app is in a session on `map` that has not ended.
fn in_session(map: &Id<MapMeta, String>) -> bool {
    running()
        .get(map)
        .is_some_and(|running| running.status.borrow().link.ended().is_none())
}

/// Run the session `side` is in until `run` exits, with `alongside` running for as long, list
/// it, and tell the app each time its status changes.
fn start(
    side: Side,
    run: impl Future<Output = ()> + Send + 'static,
    alongside: Vec<BoxFuture<'static, ()>>,
) {
    let task = async_runtime::spawn(async move {
        let mut work = JoinSet::new();
        for future in alongside {
            work.spawn(future);
        }
        run.await;
    });
    let mut changes = side.status().subscribe();
    async_runtime::spawn(async move {
        while changes.changed().await.is_ok() {
            announce(&running());
        }
    });
    let status = side.status().subscribe();
    let map = status.borrow().map.clone();
    let mut sessions = running();
    sessions.insert(map, Running { status, side, task });
    announce(&sessions);
}

fn store_state() -> AppResult<&'static StoreState> {
    let app = crate::app_handle().ok_or("the app has not started")?;
    Ok(app.state::<StoreState>().inner())
}

/// How this app's collab connections behave: on loopback with no STUN when the Worker is on
/// this machine too, as every app then is.
fn tuning() -> Tuning {
    let origin = &Worker::first_party().origin;
    if ["http://127.0.0.1", "http://localhost"]
        .iter()
        .any(|local| origin.starts_with(local))
    {
        return Tuning {
            addresses: Addresses::Loopback,
            stun: &[],
            ..INTERNET
        };
    }
    INTERNET
}

/// Save `map` every [`SAVE_EVERY`] for as long as it runs.
async fn saving(state: &'static StoreState, map: Id<MapMeta, String>) {
    loop {
        sleep(SAVE_EVERY).await;
        if let Err(error) = save(state, &map).await {
            log::warn!("[collab] map {map} was not saved: {}", error.0);
        }
    }
}

/// Every collab session this app is in, and every map it copied from another app's.
#[tauri::command]
#[specta::specta]
pub async fn collab_sessions() -> AppResult<CollabSessions> {
    listed(&running())
}

/// The maps the signed-in user shares, and the maps others share with them.
#[tauri::command]
#[specta::specta]
pub async fn collab_shares() -> AppResult<Shares> {
    Worker::first_party()
        .call(Method::GET, "/shares", None)
        .await
}

/// Share map `map` with exactly `logins`, or stop sharing it when there are none. Anyone left
/// out is turned away from the map's session.
#[tauri::command]
#[specta::specta]
pub async fn collab_share(map: Id<MapMeta, String>, logins: Vec<String>) -> AppResult<()> {
    let id = map.clone();
    let name = storage::with_db(move |conn| Ok(maps::read_map_meta(conn, &id)?))
        .await
        .map_err(|_| "the map is not in this app")?
        .name;
    let path = format!("/shares/{}", encoded(map.raw()));
    let worker = Worker::first_party();
    let logins: BTreeSet<String> = if logins.is_empty() {
        worker.call::<()>(Method::DELETE, &path, None).await?;
        BTreeSet::new()
    } else {
        let body = serde_json::json!({ "name": name, "logins": &logins });
        let share: Share = worker.call(Method::PUT, &path, Some(&body)).await?;
        share.logins.into_iter().collect()
    };
    if let Some(hosting) = side(&map).and_then(Side::hosting) {
        let unshared = logins.is_empty();
        hosting.admission(|admission| admission.logins = logins);
        if unshared {
            collab_leave(map).await?;
        }
    }
    Ok(())
}

/// Host map `map` for everyone it is shared with, until it is left.
#[tauri::command]
#[specta::specta]
pub async fn collab_host(map: Id<MapMeta, String>) -> AppResult<()> {
    if in_session(&map) {
        return Ok(());
    }
    let state = store_state()?;
    let worker = Worker::first_party();
    let login = worker.pass(&Credential::Account).await?.login;
    let shares: Shares = worker.call(Method::GET, "/shares", None).await?;
    let share = shares
        .mine
        .into_iter()
        .find(|share| share.map == map)
        .ok_or("share the map with someone before hosting it")?;
    let admission = Admission {
        logins: share.logins.into_iter().collect(),
        invite: share.invite.is_some(),
    };
    let (hosting, serving) = Hosting::start(state, map.clone(), login.clone(), admission).await?;
    let (room, entering) = Room::enter(worker, &login, &map, Role::Host, Credential::Account);
    let answering = Arc::clone(&hosting);
    let offers = async move {
        let mut room = room;
        while let Some((member, negotiation)) = room.offers.recv().await {
            let hosting = Arc::clone(&answering);
            tokio::spawn(async move {
                match rtc::open(Role::Host, negotiation, tuning()).await {
                    Ok(link) => hosting.serve(link, member),
                    Err(error) => {
                        log::info!("[collab] {} did not connect: {}", member.login, error.0);
                    }
                }
            });
        }
    };
    start(
        Side::Host(hosting),
        serving,
        vec![entering.boxed(), offers.boxed(), saving(state, map).boxed()],
    );
    Ok(())
}

/// Join the map `via` reaches, as an account it is shared with or as a guest with an invite
/// code, following it into this app's copy of it. A copy edited since its last session is
/// reported instead, unless `replace` says to replace those edits.
#[tauri::command]
#[specta::specta]
pub async fn collab_join(via: Via, replace: bool) -> AppResult<JoinOutcome> {
    let state = store_state()?;
    let credential = Credential::from(&via);
    let pass = Worker::first_party().pass(&credential).await?;
    let (host, map) = match (&via, pass.invited) {
        (Via::Map { host, map }, _) => (host.clone(), map.clone()),
        (Via::Code { .. }, Some(invited)) => (invited.host, invited.map),
        (Via::Code { .. }, None) => return Err("the invite opened no map".into()),
    };
    let origin = Origin {
        host: host.clone(),
        map: map.clone(),
        login: pass.login,
        parted: None,
        via,
    };
    let peer = match Peer::join(state, origin, replace).await? {
        Joining::Edited(copy) => return Ok(JoinOutcome::Edited { map: copy }),
        Joining::Ready(peer) => peer,
    };
    let copy = peer.map().clone();
    if in_session(&copy) {
        return Ok(JoinOutcome::Following { map: copy });
    }
    let (room, entering) = Room::enter(Worker::first_party(), &host, &map, Role::Join, credential);
    start(
        Side::Peer(Arc::clone(&peer)),
        follow(Arc::clone(&peer), room),
        vec![entering.boxed(), saving(state, copy.clone()).boxed()],
    );
    Ok(JoinOutcome::Following { map: copy })
}

/// Turn on the code that lets guests without a GitHub account join this app's shared map
/// `map`, returning it, or turn it off, which turns away every guest in its session.
#[tauri::command]
#[specta::specta]
pub async fn collab_invite(map: Id<MapMeta, String>, on: bool) -> AppResult<Option<String>> {
    let path = format!("/invites/{}", encoded(map.raw()));
    let worker = Worker::first_party();
    let code = if on {
        let invite: Invite = worker.call(Method::PUT, &path, None).await?;
        Some(invite.code)
    } else {
        worker.call::<()>(Method::DELETE, &path, None).await?;
        None
    };
    if let Some(hosting) = side(&map).and_then(Side::hosting) {
        hosting.admission(|admission| admission.invite = on);
    }
    Ok(code)
}

/// Keep `peer` connected to its host through `room`, connecting again whenever the
/// connection drops, until the session ends or the peer leaves.
async fn follow(peer: Arc<Peer>, room: Room) {
    let map = peer.map().clone();
    let mut leaving = peer.leaving();
    let mut failures = 0;
    let parting = loop {
        if *leaving.borrow() {
            break Parting::Left;
        }
        let reached = tokio::select! {
            reached = room.reach(tuning()) => reached,
            _ = leaving.changed() => continue,
        };
        match reached {
            Ok(connection) => {
                failures = 0;
                match peer.connect(connection).await {
                    Ok(Parting::Lost) => continue,
                    Ok(parting) => break parting,
                    Err(error) => break End::Ended(error.0).into(),
                }
            }
            Err(error) if room.turned_away() => break End::Refused(error.0).into(),
            Err(error) => {
                log::info!(
                    "[collab] could not reach the host of map {map}: {}",
                    error.0
                );
                failures += 1;
                peer.unreachable();
                tokio::select! {
                    () = sleep(backoff(failures)) => {}
                    _ = leaving.changed() => {}
                }
            }
        }
    };
    if let Err(error) = peer.part(&parting).await {
        log::warn!(
            "[collab] map {map} was not saved after its session: {}",
            error.0
        );
    }
}

/// Show `data` to everyone else in the session on this app's map `map`.
#[tauri::command]
#[specta::specta]
pub async fn collab_present(map: Id<MapMeta, String>, data: Shown) -> AppResult<()> {
    if let Some(side) = side(&map) {
        side.present(data);
    }
    Ok(())
}

/// Leave the session on this app's map `map`: a host ends it for everyone, a peer keeps its
/// copy. An ended session is dismissed.
#[tauri::command]
#[specta::specta]
pub async fn collab_leave(map: Id<MapMeta, String>) -> AppResult<()> {
    let Some(Running { side, task, .. }) = running().remove(&map) else {
        return Ok(());
    };
    side.leave();
    let _ = task.await;
    announce(&running());
    Ok(())
}
