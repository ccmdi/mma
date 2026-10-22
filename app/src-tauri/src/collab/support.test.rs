use super::copy::{Origin, Via};
use super::host::{Admission, Hosting};
use super::peer::{Joining, Peer};
use super::protocol::{Down, Frame, Member, Parting};
use super::rtc::Link;
use super::worker::Worker;
use crate::selections::Selector;
use crate::store::engine::{
    load_store, EditResult, Entry, Reached, Store, StoreManager, StoreState, Target, ValueRecord,
};
use crate::store::maps::MapMeta;
use crate::store::storage;
use crate::test_util::Now;
use crate::types::{AppResult, Location};
use mma_algebra::{Edit, Id, Op};
use serde_json::json;
use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::runtime::Runtime;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::timeout;

pub(super) const MAP: Target = Target::Map { id: None };

pub(super) fn runtime() -> Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

pub(super) async fn within<T>(future: impl Future<Output = T>) -> T {
    timeout(Duration::from_secs(30), future)
        .await
        .expect("in time")
}

pub(super) fn unfetched(_: u64) -> AppResult<Entry> {
    Err("a replica's step fetches nothing".into())
}

pub(super) fn nested_null() -> serde_json::Value {
    json!({ "nested": { "literal": null }, "n": 0.1 })
}

pub(super) fn edit(store: &mut Store, edits: Vec<Edit<Location>>) -> Reached<EditResult> {
    store.at(&MAP).write(edits)
}

pub(super) fn named(name: &str) -> Edit<ValueRecord> {
    Op::Add(ValueRecord {
        name: Some(name.into()),
        ..Default::default()
    })
}

/// One end of a connection in memory whose frames pass a relay, with faults a test injects
/// into what this end sends.
pub(super) struct Wire {
    relay: Arc<Relay>,
    end: usize,
}

#[derive(Default)]
struct Relay {
    lanes: [Mutex<Lane>; 2],
    moved: AtomicUsize,
}

/// What one end sent: where it goes, whether it is held back, how many to lose, and what arrived.
#[derive(Default)]
struct Lane {
    to: Option<mpsc::UnboundedSender<Vec<u8>>>,
    holding: bool,
    dropping: usize,
    delivered: Vec<Vec<u8>>,
}

impl Lane {
    fn deliver(&mut self, bytes: Vec<u8>) {
        if let Some(to) = &self.to {
            self.delivered.push(bytes.clone());
            let _ = to.send(bytes);
        }
    }
}

impl Wire {
    /// Both ends of a new connection, each with its link, relayed on `rt`.
    pub(super) fn pair(rt: &Runtime) -> ((Arc<Self>, Link), (Arc<Self>, Link)) {
        let relay = Arc::new(Relay::default());
        let (to_far, far_rx) = mpsc::unbounded_channel();
        let (to_near, near_rx) = mpsc::unbounded_channel();
        relay.lane(0).to = Some(to_far);
        relay.lane(1).to = Some(to_near);
        let near = Link {
            tx: relay.carry(rt, 0),
            rx: near_rx,
        };
        let far = Link {
            tx: relay.carry(rt, 1),
            rx: far_rx,
        };
        let wire = |end| {
            Arc::new(Wire {
                relay: Arc::clone(&relay),
                end,
            })
        };
        ((wire(0), near), (wire(1), far))
    }

    /// Lose the next `frames` this end sends.
    pub(super) fn drop_next(&self, frames: usize) {
        self.relay.lane(self.end).dropping += frames;
    }

    /// Keep what this end sends from now on from arriving.
    pub(super) fn hold(&self) {
        self.relay.lane(self.end).holding = true;
    }

    /// Cut the connection: both ends see it closed.
    pub(super) fn sever(&self) {
        for end in 0..2 {
            self.relay.lane(end).to = None;
        }
    }

    /// Every frame this end has received.
    pub(super) fn received(&self) -> Vec<Vec<u8>> {
        self.relay.lane(1 - self.end).delivered.clone()
    }

    /// How many frames either end has sent so far.
    fn moved(&self) -> usize {
        self.relay.moved.load(Ordering::SeqCst)
    }
}

impl Relay {
    fn lane(&self, end: usize) -> MutexGuard<'_, Lane> {
        self.lanes[end].lock().unwrap()
    }

    /// Where end `end` sends, relayed on `rt` to the other end with this relay's faults.
    fn carry(self: &Arc<Self>, rt: &Runtime, end: usize) -> mpsc::UnboundedSender<Vec<u8>> {
        let (tx, mut sent) = mpsc::unbounded_channel::<Vec<u8>>();
        let relay = Arc::clone(self);
        rt.spawn(async move {
            while let Some(bytes) = sent.recv().await {
                relay.moved.fetch_add(1, Ordering::SeqCst);
                let mut lane = relay.lane(end);
                if lane.dropping > 0 {
                    lane.dropping -= 1;
                } else if !lane.holding {
                    lane.deliver(bytes);
                }
            }
            relay.lane(end).to = None;
        });
        tx
    }
}

/// A hosted map in process on one store manager, with the connections of everyone who
/// joined it.
pub(super) struct Room {
    pub(super) rt: Runtime,
    pub(super) state: &'static StoreState,
    pub(super) host: Id<MapMeta, String>,
    pub(super) hosting: Arc<Hosting>,
    links: Vec<Arc<Wire>>,
    names: RefCell<HashMap<Id<MapMeta, String>, String>>,
}

/// A peer in a room: its map, both ends of its connection, and how the connection ends.
pub(super) struct Joined {
    pub(super) map: Id<MapMeta, String>,
    pub(super) peer: Arc<Peer>,
    pub(super) link: Arc<Wire>,
    pub(super) host_end: Arc<Wire>,
    pub(super) parting: JoinHandle<AppResult<Parting>>,
}

impl Room {
    pub(super) fn new(rows: &[Location]) -> Self {
        static ROOMS: AtomicU32 = AtomicU32::new(0);
        let name = format!("room-{}", ROOMS.fetch_add(1, Ordering::Relaxed));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let host = storage::tests::map_on_disk(&name);
        let mut store = load_store(&host).unwrap();
        edit(&mut store, rows.iter().cloned().map(Op::Add).collect()).now();
        let mut mgr = StoreManager::new();
        mgr.stores.insert(host.clone(), store);
        let state: &'static StoreState = Box::leak(Box::new(StoreState::new(mgr)));
        let admission = Admission {
            logins: ["alice", "bob"].map(String::from).into(),
            invite: true,
        };
        let starting = Hosting::start(state, host.clone(), "host".into(), admission);
        let (hosting, serving) = rt.block_on(starting).unwrap();
        rt.spawn(serving);
        let room = Room {
            rt,
            state,
            host,
            hosting,
            links: Vec::new(),
            names: RefCell::default(),
        };
        room.settle();
        room
    }

    /// Ready `name` to join the room's map, replacing edits made to its copy since its last
    /// session when `replace` says to.
    pub(super) fn joining(&self, name: &str, replace: bool) -> Joining {
        let via = if name.starts_with("guest--") {
            Via::Code {
                code: "k7m2p9qa".into(),
            }
        } else {
            Via::Map {
                host: "host".into(),
                map: self.host.clone(),
            }
        };
        let origin = Origin {
            host: "host".into(),
            map: self.host.clone(),
            login: name.into(),
            parted: None,
            via,
        };
        let joining = Peer::join(self.state, origin, replace);
        let joining = self.rt.block_on(joining).unwrap();
        if let Joining::Ready(peer) = &joining {
            self.names
                .borrow_mut()
                .insert(peer.map().clone(), name.into());
        }
        joining
    }

    pub(super) fn join(&mut self, name: &str) -> Joined {
        let Joining::Ready(peer) = self.joining(name, false) else {
            panic!("{name} found its copy edited");
        };
        self.follow(peer)
    }

    pub(super) fn follow(&mut self, peer: Arc<Peer>) -> Joined {
        let (link, host_end, parting) = self.connect(&peer);
        Joined {
            map: peer.map().clone(),
            peer,
            link,
            host_end,
            parting,
        }
    }

    pub(super) fn connect(
        &mut self,
        peer: &Arc<Peer>,
    ) -> (Arc<Wire>, Arc<Wire>, JoinHandle<AppResult<Parting>>) {
        let ((link, near), (host_end, far)) = Wire::pair(&self.rt);
        let name = self.names.borrow()[peer.map()].clone();
        self.serve(far, name);
        let following = Arc::clone(peer);
        let parting = self.rt.spawn(async move { following.connect(near).await });
        self.rt.block_on(async {
            while host_end.received().is_empty() && !parting.is_finished() {
                tokio::task::yield_now().await;
            }
        });
        self.links.push(Arc::clone(&link));
        self.settle();
        (link, host_end, parting)
    }

    /// Serve `login` at the other end of `link`, a guest when its login says so.
    pub(super) fn serve(&self, link: Link, login: String) {
        let _running = self.rt.enter();
        let guest = login.starts_with("guest--");
        self.hosting.serve(link, Member { login, guest });
    }

    /// Run every session until nothing is left in flight.
    pub(super) fn settle(&self) {
        let links = self.links.clone();
        self.rt.block_on(async move {
            let moved = || links.iter().map(|link| link.moved()).sum::<usize>();
            let (mut quiet, mut seen) = (0, moved());
            while quiet < 16 {
                tokio::task::yield_now().await;
                let now = moved();
                quiet = if now == seen { quiet + 1 } else { 0 };
                seen = now;
            }
        });
    }

    pub(super) fn wrote<T>(&self, written: Reached<T>) -> AppResult<T> {
        self.rt.block_on(written)
    }

    pub(super) fn parted(&self, parting: JoinHandle<AppResult<Parting>>) -> Parting {
        self.rt.block_on(parting).unwrap().unwrap()
    }

    /// Run `f` on map `map`'s store as the manager holds it.
    pub(super) fn with<R>(&self, map: &Id<MapMeta, String>, f: impl FnOnce(&mut Store) -> R) -> R {
        f(self.state.lock().unwrap().store_for_map(map).unwrap())
    }

    pub(super) fn edited(
        &self,
        map: &Id<MapMeta, String>,
        edits: Vec<Edit<Location>>,
    ) -> Reached<EditResult> {
        self.with(map, |store| edit(store, edits))
    }

    pub(super) fn rows(&self, map: &Id<MapMeta, String>) -> Vec<Location> {
        self.with(map, |store| store.at(&MAP).rows(&Selector::Everything))
    }

    pub(super) fn assert_same(&self, peer: &Id<MapMeta, String>) {
        assert_eq!(self.rows(&self.host), self.rows(peer));
        let (records, defs, name) = self.with(&self.host, |host| {
            (
                host.records("tags"),
                (*host.field_defs).clone(),
                host.meta.name.clone(),
            )
        });
        self.with(peer, |peer| {
            assert_eq!(records, peer.records("tags"));
            assert_eq!(defs, *peer.field_defs);
            assert_eq!(name, peer.meta.name);
        });
    }
}

impl Wire {
    /// Every frame this end has received, decoded.
    pub(super) fn received_frames(&self) -> Vec<Down> {
        self.received()
            .iter()
            .filter_map(|bytes| Down::decode(bytes).ok())
            .collect()
    }
}

/// How a stand-in room was entered: its path and the authorization it was sent.
#[derive(Debug)]
pub(super) struct Entered {
    pub(super) path: String,
    pub(super) auth: Option<String>,
}

pub(super) type Accepted = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

/// A stand-in Worker on loopback that issues the signed-in account a pass and lets sockets
/// into its room, each arriving on the receiver; with `refuse` it turns every one away with
/// that status.
pub(super) fn stand_in(
    rt: &Runtime,
    refuse: Option<u16>,
) -> (
    &'static Worker,
    mpsc::UnboundedReceiver<(Entered, Accepted)>,
) {
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
    use tokio_tungstenite::tungstenite::http::Response as HttpResponse;
    crate::install_crypto_provider();
    let listener = rt
        .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let (entered, entering) = mpsc::unbounded_channel();
    rt.spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut head = [0; 4];
            if stream.peek(&mut head).await.is_ok() && &head == b"POST" {
                let mut asked = Vec::new();
                let mut buf = [0; 4096];
                while !asked.windows(4).any(|end| end == b"\r\n\r\n") {
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(len) => asked.extend_from_slice(&buf[..len]),
                    }
                }
                let pass = json!({ "token": "pass-1", "login": "alice", "exp": 4_000_000_000_u64 });
                let body = pass.to_string();
                let answer = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
                     Connection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(answer.as_bytes()).await;
                continue;
            }
            let seen = Arc::new(Mutex::new(None));
            let kept = Arc::clone(&seen);
            let answer = move |request: &Request, response: Response| {
                *kept.lock().unwrap() = Some(Entered {
                    path: request.uri().to_string(),
                    auth: request
                        .headers()
                        .get("Authorization")
                        .and_then(|value| value.to_str().ok())
                        .map(String::from),
                });
                match refuse {
                    Some(status) => {
                        let refused: ErrorResponse = HttpResponse::builder()
                            .status(status)
                            .body(Some("{\"error\":\"not shared with you\"}".to_string()))
                            .unwrap();
                        Err(refused)
                    }
                    None => Ok(response),
                }
            };
            if let Ok(socket) = tokio_tungstenite::accept_hdr_async(stream, answer).await {
                let seen = seen.lock().unwrap().take().unwrap();
                let _ = entered.send((seen, socket));
            }
        }
    });
    let worker = Box::leak(Box::new(Worker::at(&format!("http://127.0.0.1:{port}"))));
    (worker, entering)
}
