//! One map's room on the collab Worker: the socket this app keeps in it, entered again whenever
//! it drops, and the negotiations it routes between this app's connections and the people in it.

use super::protocol::Member;
use super::rtc::{self, Link, Tuning};
use super::worker::{refusal, Credential, Worker};
use crate::net::encoded;
use crate::store::maps::MapMeta;
use crate::types::AppResult;
use crate::util::Duplex;
use futures::{SinkExt, StreamExt};
use mma_algebra::Id;
use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::time::Duration;
use str0m::change::{SdpAnswer, SdpOffer};
use str0m::config::Fingerprint;
use str0m::Candidate;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio::time::{sleep_until, timeout, Instant};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::{Error as SocketError, Message};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

/// How long issuing a pass may take.
const MINT_WITHIN: Duration = Duration::from_secs(20);

/// How long entering a room may take.
const ENTER_WITHIN: Duration = Duration::from_secs(10);

/// How long one message to a room may take to send.
const SEND_WITHIN: Duration = Duration::from_secs(10);

/// How often a room is asked to answer, to show the socket is alive.
const PING_EVERY: Duration = Duration::from_secs(20);

/// How long a room may stay silent before its socket is taken for dead.
const QUIET_FOR: Duration = Duration::from_secs(45);

/// The wait before the first attempt to enter a room again.
const BACKOFF_FIRST: Duration = Duration::from_secs(1);

/// The longest wait between attempts to enter a room again.
const BACKOFF_MOST: Duration = Duration::from_secs(30);

/// One message of a connection's negotiation, relayed through the room.
#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Signal {
    /// A session description offering a connection.
    Offer(SdpOffer),
    /// A session description answering an offer.
    Answer(SdpAnswer),
    /// One candidate.
    Candidate(Candidate),
    /// Asks the peer for an offer that restarts connectivity checks.
    Restart,
}

/// Which side of a room this app is on.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Role {
    /// The app hosting the map, which answers each peer's offer.
    Host,
    /// An app joining the map, which offers.
    Join,
}

impl Role {
    /// Who is on the other side, as people name them.
    pub(crate) fn other(self) -> &'static str {
        match self {
            Role::Host => "peer",
            Role::Join => "host",
        }
    }
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Role::Host => "host",
            Role::Join => "join",
        })
    }
}

/// Where one connection's negotiation travels.
pub(crate) type Negotiation = Duplex<Signal>;

/// What a room tells this app.
#[derive(Debug, PartialEq, serde::Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(super) enum Heard {
    /// Whether the host is in the room, told to peers.
    Host { live: bool },
    /// A peer came in, told to the host.
    Joined { peer: String, login: String },
    /// A negotiation message, from peer `from` as `login`, a guest or not, when told to the
    /// host.
    Signal {
        #[serde(default)]
        from: Option<String>,
        #[serde(default)]
        login: Option<String>,
        #[serde(default)]
        guest: bool,
        #[specta(type = specta_typescript::Unknown)]
        data: Signal,
    },
}

/// What this app tells a room.
#[derive(Debug, PartialEq, serde::Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(super) enum Said {
    /// A negotiation message, to peer `to` when the host says it.
    Signal {
        to: Option<String>,
        #[specta(type = specta_typescript::Unknown)]
        data: Signal,
    },
}

/// This app in one map's room: whether the host is in it, where a peer opens its
/// negotiations, and the peers' offers a host answers.
pub(crate) struct Room {
    live: watch::Receiver<bool>,
    opened: mpsc::UnboundedSender<Negotiation>,
    /// Each peer's offer of a new connection, by who they are, until the room turns this app
    /// away.
    pub(crate) offers: mpsc::UnboundedReceiver<(Member, Negotiation)>,
}

/// How long to wait before entering a room again after `failures` attempts in a row failed,
/// jittered so many apps do not come back at once.
pub(super) fn backoff(failures: u32) -> Duration {
    let doubled = BACKOFF_FIRST.saturating_mul(1 << failures.saturating_sub(1).min(16));
    doubled
        .min(BACKOFF_MOST)
        .mul_f64(0.5 + fastrand::f64() / 2.0)
}

impl Room {
    /// Enter `host`'s room for map `map` on `worker` as `role` with `credential`, for as long
    /// as the future returned with it runs and this handle is held.
    pub(crate) fn enter(
        worker: &'static Worker,
        host: &str,
        map: &Id<MapMeta, String>,
        role: Role,
        credential: Credential,
    ) -> (Self, impl Future<Output = ()> + Send + 'static) {
        let origin = &worker.origin;
        let origin = match origin.split_once("://") {
            Some(("https", rest)) => format!("wss://{rest}"),
            Some(("http", rest)) => format!("ws://{rest}"),
            _ => origin.to_string(),
        };
        let url = format!(
            "{origin}/room/{}/{}?role={role}",
            encoded(host),
            encoded(map.raw())
        );
        let (live, watching) = watch::channel(false);
        let (opened, opening) = mpsc::unbounded_channel();
        let (offered, offers) = mpsc::unbounded_channel();
        let (said, saying) = mpsc::unbounded_channel();
        let seat = Seat {
            worker,
            url,
            credential,
            live,
            opening,
            offered,
            said,
            saying,
            routes: HashMap::new(),
        };
        let room = Room {
            live: watching,
            opened,
            offers,
        };
        (room, seat.run())
    }

    /// Whether the room turned this app away for good.
    pub(crate) fn turned_away(&self) -> bool {
        self.live.has_changed().is_err()
    }

    /// A new connection to the host, offered once the host is in the room.
    pub(crate) async fn reach(&self, tuning: Tuning) -> AppResult<Link> {
        let mut live = self.live.clone();
        match timeout(tuning.open_within, live.wait_for(|live| *live)).await {
            Ok(Ok(_)) => {}
            Ok(Err(_)) => return Err("the room turned this app away".into()),
            Err(_) => return Err("the map's host is not online".into()),
        }
        let (routed, negotiation) = Negotiation::pair();
        self.opened.send(routed).map_err(|_| "the room was left")?;
        rtc::open(Role::Join, negotiation, tuning).await
    }
}

/// A negotiation the room routes: the room's id for the person at the other end, the
/// fingerprint of the offer that opened it, and where what they send goes.
struct Route {
    peer: Option<String>,
    fingerprint: Option<Fingerprint>,
    to: mpsc::UnboundedSender<Signal>,
}

/// The running side of a [`Room`]: its socket, and its routes, by the login at their other
/// end, or none for a peer's one route to its host.
struct Seat {
    worker: &'static Worker,
    url: String,
    credential: Credential,
    live: watch::Sender<bool>,
    opening: mpsc::UnboundedReceiver<Negotiation>,
    offered: mpsc::UnboundedSender<(Member, Negotiation)>,
    said: mpsc::UnboundedSender<(Option<String>, Signal)>,
    saying: mpsc::UnboundedReceiver<(Option<String>, Signal)>,
    routes: HashMap<Option<String>, Route>,
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Why a room was not entered.
enum Unentered {
    /// Turned away for good.
    Refused(String),
    /// Worth trying again.
    Failed(String),
}

impl Seat {
    async fn run(mut self) {
        let mut failures = 0;
        loop {
            match self.enter().await {
                Ok(socket) => {
                    failures = 0;
                    log::info!("[collab] entered the room at {}", self.url);
                    if !self.converse(socket).await {
                        return;
                    }
                    log::info!("[collab] lost the room at {}", self.url);
                }
                Err(Unentered::Refused(reason)) => {
                    let url = &self.url;
                    return log::warn!("[collab] the room at {url} turned this app away: {reason}");
                }
                Err(Unentered::Failed(error)) => {
                    log::info!("[collab] could not enter the room at {}: {error}", self.url);
                }
            }
            failures += 1;
            let until = Instant::now() + backoff(failures);
            loop {
                tokio::select! {
                    () = sleep_until(until) => break,
                    opened = self.opening.recv() => match opened {
                        Some(negotiation) => self.route(None, None, None, negotiation),
                        None => return,
                    },
                    _ = self.saying.recv() => {},
                }
            }
        }
    }

    /// Route what the other end of `negotiation`, `login` known to the room as `peer`, sends
    /// and what it is sent.
    fn route(
        &mut self,
        login: Option<String>,
        peer: Option<String>,
        fingerprint: Option<Fingerprint>,
        Negotiation { tx, mut rx }: Negotiation,
    ) {
        let said = self.said.clone();
        let from = login.clone();
        tokio::spawn(async move {
            while let Some(signal) = rx.recv().await {
                if said.send((from.clone(), signal)).is_err() {
                    return;
                }
            }
        });
        let route = Route {
            peer,
            fingerprint,
            to: tx,
        };
        self.routes.insert(login, route);
    }

    /// Take what the room said: whether the host is in, who joined, or a signal to route.
    fn hear(&mut self, heard: Heard) {
        match heard {
            Heard::Host { live } => {
                self.live.send_replace(live);
            }
            Heard::Joined { peer, login } => {
                if let Some(route) = self.routes.get_mut(&Some(login)) {
                    route.peer = Some(peer);
                }
            }
            Heard::Signal {
                from,
                login,
                guest,
                data,
            } => {
                if let (Signal::Offer(offer), Some(peer)) = (&data, &login) {
                    let print = offer
                        .session
                        .fingerprint()
                        .or_else(|| offer.media_lines.iter().find_map(|line| line.fingerprint()));
                    let fresh = self
                        .routes
                        .get(&login)
                        .is_none_or(|known| known.to.is_closed() || known.fingerprint != print);
                    if fresh {
                        let (routed, negotiation) = Negotiation::pair();
                        let member = Member {
                            login: peer.clone(),
                            guest,
                        };
                        let _ = self.offered.send((member, negotiation));
                        self.route(login.clone(), from.clone(), print, routed);
                    }
                }
                if let Some(route) = self.routes.get_mut(&login) {
                    if from.is_some() {
                        route.peer = from;
                    }
                    let _ = route.to.send(data);
                }
            }
        }
    }

    /// A socket to the room, entered with a pass for this seat's credential.
    async fn enter(&self) -> Result<Socket, Unentered> {
        let pass = match timeout(MINT_WITHIN, self.worker.pass(&self.credential)).await {
            Ok(Ok(pass)) => pass,
            Ok(Err(error)) => return Err(Unentered::Failed(error.0)),
            Err(_) => return Err(Unentered::Failed("no pass was issued in time".into())),
        };
        let mut request = self
            .url
            .as_str()
            .into_client_request()
            .map_err(|error| Unentered::Refused(error.to_string()))?;
        let bearer = HeaderValue::from_str(&format!("Bearer {}", pass.token))
            .map_err(|error| Unentered::Failed(error.to_string()))?;
        request.headers_mut().insert("Authorization", bearer);
        match timeout(ENTER_WITHIN, connect_async(request)).await {
            Ok(Ok((socket, _))) => Ok(socket),
            Ok(Err(SocketError::Http(response))) => {
                let status = response.status();
                let said = refusal(status, response.body().as_deref().unwrap_or_default()).0;
                match status.as_u16() {
                    401 => {
                        self.worker.forget(&self.credential).await;
                        Err(Unentered::Failed(said))
                    }
                    403 | 404 => Err(Unentered::Refused(said)),
                    _ => Err(Unentered::Failed(said)),
                }
            }
            Ok(Err(error)) => Err(Unentered::Failed(error.to_string())),
            Err(_) => Err(Unentered::Failed("the room did not answer in time".into())),
        }
    }

    /// Relay between `socket` and this app's negotiations until the socket drops, which is
    /// worth entering again, or this app leaves the room, which is not.
    async fn converse(&mut self, socket: Socket) -> bool {
        let (mut sink, mut stream) = socket.split();
        let mut heard_at = Instant::now();
        let mut ping_at = Instant::now() + PING_EVERY;
        loop {
            tokio::select! {
                message = stream.next() => match message {
                    Some(Ok(Message::Text(text))) => {
                        heard_at = Instant::now();
                        if text.as_str() == "pong" {
                            continue;
                        }
                        match serde_json::from_str::<Heard>(text.as_str()) {
                            Ok(heard) => self.hear(heard),
                            Err(error) => log::warn!("[collab] the room said what this app cannot read: {error}"),
                        }
                    }
                    Some(Ok(Message::Close(_)) | Err(_)) | None => return true,
                    Some(Ok(_)) => heard_at = Instant::now(),
                },
                said = self.saying.recv() => {
                    let Some((login, data)) = said else {
                        continue;
                    };
                    let to = self.routes.get(&login).and_then(|route| route.peer.clone());
                    let line = serde_json::to_string(&Said::Signal { to, data }).unwrap_or_default();
                    let sent = timeout(SEND_WITHIN, sink.send(Message::text(line))).await;
                    if !matches!(sent, Ok(Ok(()))) {
                        return true;
                    }
                },
                opened = self.opening.recv() => match opened {
                    Some(negotiation) => self.route(None, None, None, negotiation),
                    None => {
                        let _ = timeout(SEND_WITHIN, sink.close()).await;
                        return false;
                    }
                },
                () = sleep_until(ping_at) => {
                    ping_at = Instant::now() + PING_EVERY;
                    let sent = timeout(SEND_WITHIN, sink.send(Message::text("ping"))).await;
                    if !matches!(sent, Ok(Ok(()))) {
                        return true;
                    }
                },
                () = sleep_until(heard_at + QUIET_FOR) => return true,
            }
        }
    }
}

#[cfg(test)]
#[path = "room.test.rs"]
mod tests;
