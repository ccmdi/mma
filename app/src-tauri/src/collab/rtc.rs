//! Direct connections between a host and its peers: one WebRTC data channel over one UDP
//! socket each, negotiated through the room.

use super::protocol::MAX_FRAME;
use super::room::{Negotiation, Role, Signal};
use crate::types::AppResult;
use crate::util::Duplex;
use futures::future::join_all;
use if_addrs::{get_if_addrs, IfAddr, IfOperStatus};
use std::collections::{HashSet, VecDeque};
use std::io::ErrorKind;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::{Duration, Instant};
use std::{array, mem, net};
use str0m::change::{SdpApi, SdpPendingOffer};
use str0m::channel::{ChannelData, ChannelId};
use str0m::net::{Protocol, Receive, Transmit};
use str0m::{Candidate, Event, Input, Output, Rtc};
use tokio::net::{lookup_host, UdpSocket};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{sleep_until, timeout, timeout_at};

/// The most bytes of a frame one data channel message carries.
const CHUNK: usize = 16 << 10;

/// The first byte of a message that ends its frame.
const LAST: u8 = 1;

/// The first byte of a message whose frame goes on in the next.
const MORE: u8 = 0;

/// The whole of a message that only shows the other end this one is there.
const BEAT: u8 = 2;

/// The most bytes a connection holds unsent before it is taken to have fallen behind for good.
const BEHIND_MOST: usize = 512 << 20;

/// The longest a connection waits between looking after its timers.
const TICK: Duration = Duration::from_millis(100);

/// When a STUN server that has not answered is asked again.
const STUN_AGAIN: Duration = Duration::from_secs(1);

/// How long looking up the STUN servers may take.
const RESOLVE_WITHIN: Duration = Duration::from_secs(2);

/// How long a closing connection waits for what it sent to arrive.
const CLOSE_WITHIN: Duration = Duration::from_secs(5);

const MAGIC: [u8; 4] = [0x21, 0x12, 0xA4, 0x42];

/// Which of this machine's addresses a connection offers.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Addresses {
    /// Every address on a network, without loopback.
    Network,
    /// Loopback alone.
    Loopback,
}

/// Where a connection looks for its own addresses, and how patient it is.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Tuning {
    pub(crate) addresses: Addresses,
    /// The STUN servers asked for this machine's public address.
    pub(crate) stun: &'static [&'static str],
    /// How often this end shows the other it is there.
    pub(crate) heartbeat: Duration,
    /// How much longer than a heartbeat the other end may stay silent before connectivity
    /// checks restart, doubling with each restart.
    pub(crate) restart_after: Duration,
    /// How long the other end may stay silent before the connection is given up.
    pub(crate) dead_after: Duration,
    /// How long a new connection may take to open.
    pub(crate) open_within: Duration,
}

/// How connections across the internet behave.
pub(crate) const INTERNET: Tuning = Tuning {
    addresses: Addresses::Network,
    stun: &[
        "stun.l.google.com:19302",
        "stun.cloudflare.com:3478",
        "stun1.l.google.com:19302",
    ],
    heartbeat: Duration::from_secs(5),
    restart_after: Duration::from_secs(3),
    dead_after: Duration::from_secs(15),
    open_within: Duration::from_secs(20),
};

/// One end of an ordered, reliable connection that carries whole frames. Dropping its `tx`
/// closes it once what was sent has arrived; its `rx` ends once it is closed and every frame
/// sent before that arrived.
pub(crate) type Link = Duplex<Vec<u8>>;

impl Addresses {
    /// This machine's IPv4 addresses these name, with their netmasks.
    fn local(self) -> AppResult<Vec<(Ipv4Addr, Ipv4Addr)>> {
        if self == Addresses::Loopback {
            return Ok(vec![(Ipv4Addr::LOCALHOST, Ipv4Addr::new(255, 0, 0, 0))]);
        }
        let found: Vec<_> = get_if_addrs()?
            .into_iter()
            .filter(|interface| {
                !interface.is_loopback()
                    && !interface.is_link_local()
                    && !matches!(
                        interface.oper_status,
                        IfOperStatus::Down
                            | IfOperStatus::NotPresent
                            | IfOperStatus::LowerLayerDown
                    )
            })
            .filter_map(|interface| match interface.addr {
                IfAddr::V4(v4) if !v4.ip.is_unspecified() => Some((v4.ip, v4.netmask)),
                _ => None,
            })
            .collect();
        if found.is_empty() {
            return Err("this machine is on no network to connect over".into());
        }
        Ok(found)
    }

    /// The address a socket offering these binds to.
    fn bound(self) -> Ipv4Addr {
        match self {
            Addresses::Loopback => Ipv4Addr::LOCALHOST,
            Addresses::Network => Ipv4Addr::UNSPECIFIED,
        }
    }
}

/// A STUN binding request with transaction id `id`.
fn binding_request(id: &[u8; 12]) -> [u8; 20] {
    let mut request = [0; 20];
    request[1] = 0x01;
    request[4..8].copy_from_slice(&MAGIC);
    request[8..].copy_from_slice(id);
    request
}

/// The transaction id of the STUN binding success response in `bytes`, and the address it
/// saw this machine at.
fn mapped_address(bytes: &[u8]) -> Option<([u8; 12], SocketAddr)> {
    if bytes.get(..2)? != [0x01, 0x01] || bytes.get(4..8)? != MAGIC {
        return None;
    }
    let id: [u8; 12] = bytes.get(8..20)?.try_into().ok()?;
    let mut plain = None;
    let mut at = 20;
    while let Some(head) = bytes.get(at..at + 4) {
        let kind = u16::from_be_bytes([head[0], head[1]]);
        let len = usize::from(u16::from_be_bytes([head[2], head[3]]));
        let value = bytes.get(at + 4..at + 4 + len)?;
        let address = |xor_port: u16, xor_ip: u32| {
            if value.len() < 8 || value[1] != 0x01 {
                return None;
            }
            let port = u16::from_be_bytes([value[2], value[3]]) ^ xor_port;
            let ip = u32::from_be_bytes([value[4], value[5], value[6], value[7]]) ^ xor_ip;
            Some(SocketAddr::from((Ipv4Addr::from(ip), port)))
        };
        match kind {
            0x0020 => return Some((id, address(0x2112, u32::from_be_bytes(MAGIC))?)),
            0x0001 => plain = address(0, 0),
            _ => {}
        }
        at += 4 + len.div_ceil(4) * 4;
    }
    Some((id, plain?))
}

/// Asking STUN servers for this machine's public address: the servers that have not answered,
/// each by the transaction id it was asked with, the addresses they named, and when the silent
/// ones are asked again.
struct Gathering {
    asked: Vec<([u8; 12], SocketAddrV4)>,
    found: HashSet<SocketAddr>,
    again: Option<Instant>,
}

impl Gathering {
    fn new(servers: Vec<SocketAddrV4>) -> Self {
        Gathering {
            asked: servers
                .into_iter()
                .map(|server| (array::from_fn(|_| fastrand::u8(..)), server))
                .collect(),
            found: HashSet::new(),
            again: Some(Instant::now() + STUN_AGAIN),
        }
    }

    /// Ask every server that has not answered, over `socket`.
    fn ask(&self, socket: &UdpSocket) {
        for (id, server) in &self.asked {
            let _ = socket.try_send_to(&binding_request(id), (*server).into());
        }
    }

    /// Ask the silent servers once more when that is due at `now`.
    fn tend(&mut self, now: Instant, socket: &UdpSocket) {
        if self.again.is_some_and(|at| now >= at) {
            self.again = None;
            self.ask(socket);
        }
    }

    /// The address an asked server's answer in `bytes` names, when no other named it before.
    fn heard(&mut self, bytes: &[u8]) -> Option<SocketAddr> {
        let (id, mapped) = mapped_address(bytes)?;
        let asked = self.asked.iter().position(|(held, _)| *held == id)?;
        self.asked.swap_remove(asked);
        self.found.insert(mapped).then_some(mapped)
    }
}

/// The IPv4 addresses of `servers`, each its first, given up on past [`RESOLVE_WITHIN`], and
/// the address of this machine's that faces them, else the first of `addresses`.
async fn stun_servers(
    servers: &[&str],
    addresses: &[(Ipv4Addr, Ipv4Addr)],
) -> (Vec<SocketAddrV4>, Ipv4Addr) {
    let lookups = servers.iter().map(|server| lookup_host(*server));
    let found = match timeout(RESOLVE_WITHIN, join_all(lookups)).await {
        Ok(found) => found,
        Err(_) => {
            log::info!("[collab] the STUN servers were not found in time");
            Vec::new()
        }
    };
    let servers: Vec<SocketAddrV4> = found
        .into_iter()
        .flatten()
        .filter_map(|mut addresses| {
            addresses.find_map(|address| match address {
                SocketAddr::V4(v4) => Some(v4),
                SocketAddr::V6(_) => None,
            })
        })
        .collect();
    let facing = servers.first().and_then(|server| {
        let probe = net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
        probe.connect(server).ok()?;
        match probe.local_addr().ok()? {
            SocketAddr::V4(v4) => Some(*v4.ip()),
            SocketAddr::V6(_) => None,
        }
    });
    (servers, facing.unwrap_or(addresses[0].0))
}

/// A connection to the other end of `negotiation` as `role`, open once its data channel is:
/// the peer offers, the host answers.
pub(crate) async fn open(role: Role, negotiation: Negotiation, tuning: Tuning) -> AppResult<Link> {
    let deadline = tokio::time::Instant::now() + tuning.open_within;
    let addresses = tuning.addresses.local()?;
    let socket = UdpSocket::bind((tuning.addresses.bound(), 0)).await?;
    let port = socket.local_addr()?.port();
    let mut rtc = Rtc::new(Instant::now());
    for (ip, _) in &addresses {
        match Candidate::host(SocketAddr::from((*ip, port)), "udp") {
            Ok(candidate) => {
                rtc.add_local_candidate(candidate);
            }
            Err(error) => log::debug!("[collab] {ip} is no candidate: {error}"),
        }
    }
    let (servers, base) = stun_servers(tuning.stun, &addresses).await;

    let (tx, sending) = mpsc::unbounded_channel();
    let (arrived, rx) = mpsc::unbounded_channel();
    let (opened, opening) = oneshot::channel();
    let now = Instant::now();
    let mut driver = Driver {
        rtc,
        socket,
        port,
        addresses,
        base,
        role,
        pending: None,
        negotiation,
        sending,
        frames: arrived,
        opened: Some(opened),
        channel: None,
        outgoing: VecDeque::new(),
        sent: 0,
        behind: 0,
        arriving: Vec::new(),
        gathering: Gathering::new(servers),
        tuning,
        heard_at: now,
        restarts: 0,
        closing: None,
        ended: None,
    };
    if role == Role::Join {
        driver.offer(|api| {
            api.add_channel("collab".into());
        });
    }
    tokio::spawn(driver.run());
    match timeout_at(deadline, opening).await {
        Ok(Ok(())) => Ok(Link { tx, rx }),
        Ok(Err(_)) | Err(_) => Err(format!("could not reach the {} directly", role.other()).into()),
    }
}

/// The running half of a connection: its socket, its WebRTC state, and what it still has to
/// send and to deliver.
struct Driver {
    rtc: Rtc,
    socket: UdpSocket,
    port: u16,
    addresses: Vec<(Ipv4Addr, Ipv4Addr)>,
    base: Ipv4Addr,
    role: Role,
    pending: Option<SdpPendingOffer>,
    negotiation: Negotiation,
    sending: mpsc::UnboundedReceiver<Vec<u8>>,
    frames: mpsc::UnboundedSender<Vec<u8>>,
    opened: Option<oneshot::Sender<()>>,
    channel: Option<ChannelId>,
    outgoing: VecDeque<Vec<u8>>,
    sent: usize,
    behind: usize,
    arriving: Vec<u8>,
    gathering: Gathering,
    tuning: Tuning,
    heard_at: Instant,
    restarts: u32,
    closing: Option<Instant>,
    ended: Option<String>,
}

impl Driver {
    async fn run(mut self) {
        self.gathering.ask(&self.socket);
        let mut buf = vec![0; 2048];
        let mut beating = tokio::time::interval(self.tuning.heartbeat);
        loop {
            let wake = match self.drain() {
                Ok(wake) => wake,
                Err(error) => {
                    log::warn!("[collab] a connection failed: {error}");
                    return;
                }
            };
            if let Some(reason) = &self.ended {
                log::info!("[collab] a connection ended: {reason}");
                return;
            }
            if !self.rtc.is_alive() {
                return;
            }
            let now = Instant::now();
            if self.tend(now) {
                continue;
            }
            let wake = tokio::time::Instant::from_std(wake.min(now + TICK));
            tokio::select! {
                received = self.socket.recv_from(&mut buf) => match received {
                    Ok((len, source)) => self.receive(&buf[..len], source),
                    Err(error) if matches!(error.kind(), ErrorKind::ConnectionReset | ErrorKind::ConnectionRefused) => {}
                    Err(error) => {
                        log::warn!("[collab] a connection's socket failed: {error}");
                        return;
                    }
                },
                () = sleep_until(wake) => {
                    if let Err(error) = self.rtc.handle_input(Input::Timeout(Instant::now())) {
                        log::warn!("[collab] a connection failed: {error}");
                        return;
                    }
                },
                bytes = self.sending.recv(), if self.closing.is_none() => match bytes {
                    Some(bytes) => self.queue(bytes),
                    None => self.closing = Some(now + CLOSE_WITHIN),
                },
                _ = beating.tick() => {
                    if let Some(mut channel) = self.channel.and_then(|id| self.rtc.channel(id)) {
                        let _ = channel.write(true, &[BEAT]);
                    }
                },
                Some(signal) = self.negotiation.rx.recv() => self.signal(signal),
            }
        }
    }

    /// Take everything the connection has to say until it next wants waking, writing what is
    /// queued to the channel as it has room.
    fn drain(&mut self) -> Result<Instant, str0m::RtcError> {
        loop {
            match self.rtc.poll_output()? {
                Output::Timeout(wake) => {
                    if !self.pump() {
                        return Ok(wake);
                    }
                }
                Output::Transmit(transmit) => self.transmit(&transmit),
                Output::Event(event) => self.event(event),
            }
        }
    }

    /// Queue `bytes` to send, ending the connection once it falls too far behind.
    fn queue(&mut self, bytes: Vec<u8>) {
        self.behind += bytes.len();
        if self.behind > BEHIND_MOST {
            self.ended = Some(format!("it fell {} bytes behind", self.behind));
        }
        self.outgoing.push_back(bytes);
    }

    /// Write the next chunk of the oldest queued frame to the channel, if it has room for it.
    fn pump(&mut self) -> bool {
        let (Some(id), Some(frame)) = (self.channel, self.outgoing.front()) else {
            return false;
        };
        let Some(mut channel) = self.rtc.channel(id) else {
            return false;
        };
        let end = (self.sent + CHUNK).min(frame.len());
        let last = end == frame.len();
        let mut message = Vec::with_capacity(end - self.sent + 1);
        message.push(if last { LAST } else { MORE });
        message.extend_from_slice(&frame[self.sent..end]);
        match channel.write(true, &message) {
            Ok(true) => {
                self.behind -= end - self.sent;
                if last {
                    self.outgoing.pop_front();
                    self.sent = 0;
                } else {
                    self.sent = end;
                }
                true
            }
            Ok(false) => false,
            Err(error) => {
                self.ended = Some(format!("its channel refused a write: {error}"));
                false
            }
        }
    }

    fn transmit(&self, transmit: &Transmit) {
        let _ = self
            .socket
            .try_send_to(&transmit.contents, transmit.destination);
    }

    fn event(&mut self, event: Event) {
        let now = Instant::now();
        match event {
            Event::ChannelOpen(id, _) => {
                self.channel = Some(id);
                self.heard_at = now;
                if let Some(opened) = self.opened.take() {
                    let _ = opened.send(());
                }
            }
            Event::ChannelData(ChannelData { data, .. }) => {
                self.heard_at = now;
                self.restarts = 0;
                let Some((&end, payload)) = data.split_first() else {
                    self.ended = Some("the other end sent an empty message".into());
                    return;
                };
                if end == BEAT {
                    return;
                }
                self.arriving.extend_from_slice(payload);
                if self.arriving.len() > MAX_FRAME {
                    self.ended = Some("the other end sent a frame past the limit".into());
                } else if end == LAST {
                    let _ = self.frames.send(mem::take(&mut self.arriving));
                }
            }
            Event::ChannelClose(_) | Event::Closed => {
                self.ended = Some("the other end closed it".into());
            }
            _ => {}
        }
    }

    fn receive(&mut self, bytes: &[u8], source: SocketAddr) {
        if let Some(mapped) = self.gathering.heard(bytes) {
            let base = SocketAddr::from((self.base, self.port));
            match Candidate::server_reflexive(mapped, base, "udp") {
                Ok(candidate) => {
                    if let Some(added) = self.rtc.add_local_candidate(candidate) {
                        let _ = self.negotiation.tx.send(Signal::Candidate(added.clone()));
                    }
                }
                Err(error) => log::debug!("[collab] {mapped} is no candidate: {error}"),
            }
            return;
        }
        let reached = match source {
            SocketAddr::V4(v4) => self
                .addresses
                .iter()
                .find(|(ip, mask)| {
                    let mask = u32::from(*mask);
                    u32::from(*ip) & mask == u32::from(*v4.ip()) & mask
                })
                .map_or(self.base, |(ip, _)| *ip),
            SocketAddr::V6(_) => self.base,
        };
        let destination = SocketAddr::from((reached, self.port));
        let Ok(receive) = Receive::new(Protocol::Udp, source, destination, bytes) else {
            return;
        };
        let input = Input::Receive(Instant::now(), receive);
        if self.rtc.accepts(&input) {
            if let Err(error) = self.rtc.handle_input(input) {
                log::debug!("[collab] a packet from {source} was refused: {error}");
            }
        }
    }

    fn signal(&mut self, signal: Signal) {
        let negotiated = match (signal, self.role) {
            (Signal::Offer(offer), Role::Host) => {
                self.rtc.sdp_api().accept_offer(offer).map(|answer| {
                    let _ = self.negotiation.tx.send(Signal::Answer(answer));
                })
            }
            (Signal::Answer(answer), Role::Join) => {
                let Some(pending) = self.pending.take() else {
                    return log::debug!("[collab] an answer came to no offer");
                };
                self.rtc.sdp_api().accept_answer(pending, answer)
            }
            (Signal::Candidate(candidate), _) => {
                self.rtc.add_remote_candidate(candidate);
                Ok(())
            }
            (Signal::Restart, Role::Join) => {
                if self.channel.is_some() {
                    self.restart();
                }
                Ok(())
            }
            _ => return log::debug!("[collab] a signal came the wrong way"),
        };
        if let Err(error) = negotiated {
            let far = self.role.other();
            log::warn!("[collab] what the {far} sent was refused: {error}");
        }
    }

    /// Offer the other end the session `change` makes of this one.
    fn offer(&mut self, change: impl FnOnce(&mut SdpApi<'_>)) {
        let mut api = self.rtc.sdp_api();
        change(&mut api);
        if let Some((offer, pending)) = api.apply() {
            self.pending = Some(pending);
            let _ = self.negotiation.tx.send(Signal::Offer(offer));
        }
    }

    /// Restart connectivity checks: offer new credentials as the peer, or ask the peer to.
    fn restart(&mut self) {
        self.restarts += 1;
        match self.role {
            Role::Join => self.offer(|api| {
                api.ice_restart(true);
            }),
            Role::Host => {
                let _ = self.negotiation.tx.send(Signal::Restart);
            }
        }
    }

    /// Look after what is due at `now`: STUN, closing, and restarting connectivity checks
    /// that went quiet. True when that changed the connection, which then has more to say.
    fn tend(&mut self, now: Instant) -> bool {
        self.gathering.tend(now, &self.socket);
        if let Some(deadline) = self.closing {
            let buffered = self
                .channel
                .and_then(|id| self.rtc.channel(id))
                .map_or(0, |mut channel| channel.buffered_amount());
            if (self.outgoing.is_empty() && buffered == 0) || now >= deadline {
                self.ended = Some(match self.rtc.close() {
                    Ok(()) => "this end closed it".into(),
                    Err(error) => format!("it did not close cleanly: {error}"),
                });
                return true;
            }
            return false;
        }
        if self.channel.is_none() {
            return false;
        }
        let silent = now.duration_since(self.heard_at);
        if silent > self.tuning.dead_after {
            self.ended = Some("the other end stopped answering".into());
            return true;
        }
        let restarting = silent
            > self.tuning.heartbeat + self.tuning.restart_after * (1 << self.restarts.min(6));
        if restarting {
            log::info!("[collab] a connection went quiet, so its checks restart");
            self.restart();
        }
        restarting
    }
}

#[cfg(test)]
#[path = "rtc.test.rs"]
mod tests;
