use super::*;
use crate::collab::peer::Joining;
use crate::collab::protocol::Parting;
use crate::collab::support::{runtime, within, Room};
use crate::store::maps::MapMeta;
use crate::test_util::{loc, patch, Now};
use mma_algebra::{Id, Op};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use str0m::change::{SdpAnswer, SdpOffer};
use tokio::runtime::Runtime;

const FAST: Tuning = Tuning {
    addresses: Addresses::Loopback,
    stun: &[],
    heartbeat: Duration::from_millis(250),
    restart_after: Duration::from_millis(250),
    dead_after: Duration::from_secs(20),
    open_within: Duration::from_secs(10),
};

/// A peer's and a host's negotiations wired to each other on `rt` through `rewrite`, which
/// sees each signal and whether the peer sent it, with a count of the offers the peer made.
fn wired(
    rt: &Runtime,
    rewrite: impl Fn(Signal, bool) -> Signal + Send + Sync + 'static,
) -> (Negotiation, Negotiation, Arc<AtomicUsize>) {
    let rewrite = Arc::new(rewrite);
    let (peer, joiner_said) = Negotiation::pair();
    let (host, host_said) = Negotiation::pair();
    let offers = Arc::new(AtomicUsize::new(0));
    let (counted, from_joiner) = (Arc::clone(&offers), Arc::clone(&rewrite));
    let (
        Duplex {
            tx: to_joiner,
            rx: mut joiner_says,
        },
        Duplex {
            tx: to_host,
            rx: mut host_says,
        },
    ) = (joiner_said, host_said);
    rt.spawn(async move {
        while let Some(signal) = joiner_says.recv().await {
            if matches!(signal, Signal::Offer(_)) {
                counted.fetch_add(1, Ordering::SeqCst);
            }
            let _ = to_host.send(from_joiner(signal, true));
        }
    });
    rt.spawn(async move {
        while let Some(signal) = host_says.recv().await {
            let _ = to_joiner.send(rewrite(signal, false));
        }
    });
    (peer, host, offers)
}

/// Both ends of a new connection over loopback whose signals pass `rewrite`, with a count of
/// the peer's offers.
fn opened(
    rt: &Runtime,
    rewrite: impl Fn(Signal, bool) -> Signal + Send + Sync + 'static,
) -> (Link, Link, Arc<AtomicUsize>) {
    let (peer, host, offers) = wired(rt, rewrite);
    let (peer, host) = rt.block_on(async {
        tokio::join!(open(Role::Join, peer, FAST), open(Role::Host, host, FAST))
    });
    let (Ok(peer), Ok(host)) = (peer, host) else {
        panic!("the connection did not open");
    };
    (peer, host, offers)
}

fn connected(rt: &Runtime) -> (Link, Link, Arc<AtomicUsize>) {
    opened(rt, |signal, _| signal)
}

/// A UDP relay standing between a peer and a host on loopback, which loses every packet
/// while it is dark. Each end's address in the signals is rewritten to the relay's socket that
/// faces the other end.
struct UdpRelay {
    dark: Arc<AtomicBool>,
}

impl UdpRelay {
    fn open(
        rt: &Runtime,
    ) -> (
        Self,
        impl Fn(Signal, bool) -> Signal + Send + Sync + 'static,
    ) {
        let bind = || std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        let (for_joiner, for_host) = (bind(), bind());
        let posing = [
            for_joiner.local_addr().unwrap().port(),
            for_host.local_addr().unwrap().port(),
        ];
        let ends: Arc<Mutex<[Option<SocketAddr>; 2]>> = Arc::default();
        let dark = Arc::new(AtomicBool::new(false));
        let (relaying, darkened) = (Arc::clone(&ends), Arc::clone(&dark));
        rt.spawn(async move {
            for_joiner.set_nonblocking(true).unwrap();
            for_host.set_nonblocking(true).unwrap();
            let sockets = [
                UdpSocket::from_std(for_joiner).unwrap(),
                UdpSocket::from_std(for_host).unwrap(),
            ];
            let (mut joiner_buf, mut host_buf) = (vec![0; 2048], vec![0; 2048]);
            loop {
                let (from, len) = tokio::select! {
                    Ok((len, _)) = sockets[0].recv_from(&mut joiner_buf) => (0, len),
                    Ok((len, _)) = sockets[1].recv_from(&mut host_buf) => (1, len),
                    else => continue,
                };
                if darkened.load(Ordering::SeqCst) {
                    continue;
                }
                let to = relaying.lock().unwrap()[1 - from];
                let bytes = if from == 0 {
                    &joiner_buf[..len]
                } else {
                    &host_buf[..len]
                };
                if let Some(to) = to {
                    let _ = sockets[1 - from].send_to(bytes, to).await;
                }
            }
        });
        let rewrite = move |signal: Signal, peer: bool| {
            let end = usize::from(!peer);
            let pose = |sdp: &str| {
                sdp.split("\r\n")
                    .filter(|line| !line.contains("candidate:") || line.contains(" typ host"))
                    .map(|line| {
                        let mut parts: Vec<String> = line.split(' ').map(String::from).collect();
                        if !line.contains("candidate:") {
                            return line.to_string();
                        }
                        let port: u16 = parts[5].parse().unwrap();
                        ends.lock().unwrap()[end] = Some(SocketAddr::from(([127, 0, 0, 1], port)));
                        parts[5] = posing[1 - end].to_string();
                        parts.join(" ")
                    })
                    .collect::<Vec<_>>()
                    .join("\r\n")
            };
            match signal {
                Signal::Offer(offer) => {
                    Signal::Offer(SdpOffer::from_sdp_string(&pose(&offer.to_sdp_string())).unwrap())
                }
                Signal::Answer(answer) => Signal::Answer(
                    SdpAnswer::from_sdp_string(&pose(&answer.to_sdp_string())).unwrap(),
                ),
                Signal::Candidate(candidate) => Signal::Candidate(
                    Candidate::from_sdp_string(&pose(&candidate.to_sdp_string())).unwrap(),
                ),
                signal => signal,
            }
        };
        (UdpRelay { dark }, rewrite)
    }

    fn black_out(&self, dark: bool) {
        self.dark.store(dark, Ordering::SeqCst);
    }
}

/// The next `count` frames `end` receives.
fn arrived(rt: &Runtime, end: &mut Link, count: usize) -> Vec<Vec<u8>> {
    rt.block_on(async {
        let mut frames = Vec::new();
        while frames.len() < count {
            frames.push(within(end.rx.recv()).await.expect("a frame"));
        }
        frames
    })
}

fn patterned(len: usize, seed: usize) -> Vec<u8> {
    (0..len).map(|at| ((at + seed) % 251) as u8).collect()
}

#[test]
fn frames_cross_a_loopback_connection_whole_and_in_order_both_ways() {
    let rt = runtime();
    let (mut peer, mut host, _) = connected(&rt);
    for frame in [vec![1, 2], vec![], vec![3]] {
        peer.tx.send(frame).unwrap();
    }
    host.tx.send(vec![9]).unwrap();
    assert_eq!(arrived(&rt, &mut host, 3), [vec![1, 2], vec![], vec![3]]);
    assert_eq!(arrived(&rt, &mut peer, 1), [vec![9]]);
}

#[test]
fn a_frame_larger_than_one_chunk_arrives_whole() {
    let rt = runtime();
    let (peer, mut host, _) = connected(&rt);
    let frames = [
        patterned(CHUNK * 64 + 7, 0),
        patterned(CHUNK, 1),
        patterned(CHUNK + 1, 2),
        patterned(CHUNK - 1, 3),
    ];
    for frame in &frames {
        peer.tx.send(frame.clone()).unwrap();
    }
    assert_eq!(arrived(&rt, &mut host, frames.len()), frames);
}

#[test]
fn a_closed_connection_delivers_what_was_sent_then_ends() {
    let rt = runtime();
    let (Link { tx, mut rx }, mut host, _) = connected(&rt);
    let big = patterned(CHUNK * 20, 5);
    tx.send(big.clone()).unwrap();
    drop(tx);
    assert_eq!(arrived(&rt, &mut host, 1), [big]);
    rt.block_on(async {
        for end in [&mut host.rx, &mut rx] {
            assert_eq!(within(end.recv()).await, None);
        }
    });
    assert!(host.tx.send(vec![1]).is_err());
}

#[test]
fn connectivity_lost_for_a_while_comes_back_by_restarting_checks_and_loses_no_frame() {
    let rt = runtime();
    let (relay, rewrite) = UdpRelay::open(&rt);
    let (mut peer, mut host, offers) = opened(&rt, rewrite);
    assert_eq!(offers.load(Ordering::SeqCst), 1);
    relay.black_out(true);
    let sent: Vec<Vec<u8>> = (0..40).map(|at| patterned(CHUNK / 2 + at, at)).collect();
    for frame in &sent {
        peer.tx.send(frame.clone()).unwrap();
        host.tx.send(frame.clone()).unwrap();
    }
    rt.block_on(async { tokio::time::sleep(Duration::from_millis(1500)).await });
    assert!(offers.load(Ordering::SeqCst) > 1, "no restart was offered");
    relay.black_out(false);
    assert_eq!(arrived(&rt, &mut host, sent.len()), sent);
    assert_eq!(arrived(&rt, &mut peer, sent.len()), sent);
}

#[test]
fn a_host_that_cannot_be_reached_is_reported_once_the_open_deadline_passes() {
    let rt = runtime();
    let (peer, mut host) = Negotiation::pair();
    let deaf = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let silent = deaf.local_addr().unwrap();
    let answering = async move {
        let Some(Signal::Offer(offer)) = host.rx.recv().await else {
            panic!("no offer");
        };
        let mut rtc = Rtc::new(Instant::now());
        rtc.add_local_candidate(Candidate::host(silent, "udp").unwrap());
        let answer = rtc.sdp_api().accept_offer(offer).unwrap();
        host.tx.send(Signal::Answer(answer)).unwrap();
        (rtc, host)
    };
    let tuning = Tuning {
        open_within: Duration::from_secs(3),
        ..FAST
    };
    let (reached, _held) =
        rt.block_on(async { tokio::join!(open(Role::Join, peer, tuning), answering) });
    let Err(error) = reached else {
        panic!("a host nobody answers for was reached");
    };
    assert_eq!(error.0, "could not reach the host directly");
    drop(deaf);
}

#[test]
fn stun_answers_name_the_address_they_saw_and_nothing_else_passes_for_one() {
    let id = [7; 12];
    let request = binding_request(&id);
    assert_eq!(mapped_address(&request), None);

    let seen: SocketAddr = "203.0.113.7:54321".parse().unwrap();
    let mut answer = vec![0x01, 0x01, 0, 0];
    answer.extend_from_slice(&MAGIC);
    answer.extend_from_slice(&id);
    answer.extend_from_slice(&[0x80, 0x22, 0, 3, b'a', b'b', b'c', 0]);
    answer.extend_from_slice(&[0, 0x20, 0, 8, 0, 0x01]);
    answer.extend_from_slice(&(54321u16 ^ 0x2112).to_be_bytes());
    let ip = u32::from(Ipv4Addr::new(203, 0, 113, 7)) ^ u32::from_be_bytes(MAGIC);
    answer.extend_from_slice(&ip.to_be_bytes());
    let len = (answer.len() - 20) as u16;
    answer[2..4].copy_from_slice(&len.to_be_bytes());
    assert_eq!(mapped_address(&answer), Some((id, seen)));

    let mut plain = answer[..20].to_vec();
    plain.extend_from_slice(&[0, 0x01, 0, 8, 0, 0x01]);
    plain.extend_from_slice(&54321u16.to_be_bytes());
    plain.extend_from_slice(&[203, 0, 113, 7]);
    assert_eq!(mapped_address(&plain), Some((id, seen)));

    assert_eq!(mapped_address(&[0x17, 0xfe, 0xfd, 0, 0]), None);
    assert_eq!(mapped_address(&answer[..30]), None);
}

#[test]
fn connections_across_the_internet_restart_their_checks_well_before_giving_up() {
    assert_eq!(INTERNET.addresses, Addresses::Network);
    assert!((2..=3).contains(&INTERNET.stun.len()));
    assert!(INTERNET.heartbeat * 2 < INTERNET.dead_after);
    assert!(INTERNET.heartbeat + INTERNET.restart_after < INTERNET.dead_after);
}

#[test]
fn a_connection_offers_loopback_alone_or_only_network_addresses() {
    assert_eq!(
        Addresses::Loopback.local().unwrap(),
        [(Ipv4Addr::LOCALHOST, Ipv4Addr::new(255, 0, 0, 0))]
    );
    if let Ok(found) = Addresses::Network.local() {
        for (ip, _) in found {
            assert!(!ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified());
        }
    }
}

/// Run `room` until `map` is open and holds what the host's map does.
fn caught_up(room: &Room, map: &Id<MapMeta, String>) {
    room.rt.block_on(within(async {
        loop {
            let open = room.state.lock().unwrap().stores.contains_key(map);
            if open && room.rows(&room.host) == room.rows(map) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }));
}

#[test]
fn a_hosted_map_converges_over_real_connections_and_a_joiner_that_leaves_comes_back() {
    let room = Room::new(&[loc(0, 1.0, 1.0), loc(0, 2.0, 2.0)]);
    let Joining::Ready(peer) = room.joining("bob", false) else {
        panic!("bob found his copy edited");
    };
    let follow = |room: &Room| {
        let (offering, host, _) = wired(&room.rt, |signal, _| signal);
        let (link, hosted) = room.rt.block_on(async {
            tokio::join!(
                open(Role::Join, offering, FAST),
                open(Role::Host, host, FAST)
            )
        });
        room.serve(hosted.unwrap(), "bob".into());
        let (following, link) = (Arc::clone(&peer), link.unwrap());
        room.rt.spawn(async move { following.connect(link).await })
    };

    let parting = follow(&room);
    caught_up(&room, peer.map());
    room.edited(&room.host, vec![Op::Put(patch!(1; heading: 45.0))])
        .now();
    let added = room.edited(peer.map(), vec![Op::Add(loc(0, 3.0, 3.0))]);
    room.wrote(added).unwrap();
    caught_up(&room, peer.map());
    room.assert_same(peer.map());

    peer.leave();
    assert_eq!(room.parted(parting), Parting::Left);
    room.edited(&room.host, vec![Op::Remove(Id::new(1))]).now();
    let parting = follow(&room);
    caught_up(&room, peer.map());
    assert_eq!(room.rows(peer.map()).len(), 2);
    room.assert_same(peer.map());
    peer.leave();
    assert_eq!(room.parted(parting), Parting::Left);
}
