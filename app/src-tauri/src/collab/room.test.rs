use super::super::rtc::{Addresses, INTERNET};
use super::*;
use crate::collab::support::{runtime, stand_in, within, Accepted};
use crate::net::github::tests::signed_in;
use serde_json::json;
use std::time::Instant;
use str0m::Rtc;

/// An offer of a data channel, which carries its certificate's fingerprint.
fn offered() -> String {
    let mut rtc = Rtc::new(Instant::now());
    let mut api = rtc.sdp_api();
    api.add_channel("frames".into());
    api.apply().unwrap().0.to_sdp_string()
}

fn offer(sdp: &str) -> Signal {
    Signal::Offer(SdpOffer::from_sdp_string(sdp).unwrap())
}

#[test]
fn signals_and_room_messages_have_the_contract_shapes() {
    let sdp = offered();
    assert_eq!(
        serde_json::to_value(offer(&sdp)).unwrap(),
        json!({ "offer": { "type": "offer", "sdp": sdp } })
    );
    let candidate = Candidate::host("127.0.0.1:5000".parse().unwrap(), "udp").unwrap();
    assert_eq!(
        serde_json::to_value(Signal::Candidate(candidate.clone())).unwrap(),
        json!({ "candidate": {
            "candidate": candidate.to_sdp_string(),
            "sdpMid": null,
            "sdpMLineIndex": 0,
            "usernameFragment": null
        } })
    );
    assert_eq!(
        serde_json::to_value(Signal::Restart).unwrap(),
        json!("restart")
    );
    let heard = |json: serde_json::Value| serde_json::from_value::<Heard>(json).unwrap();
    assert_eq!(
        heard(json!({ "type": "host", "live": true })),
        Heard::Host { live: true }
    );
    assert_eq!(
        heard(json!({ "type": "joined", "peer": "j1", "login": "bob" })),
        Heard::Joined {
            peer: "j1".into(),
            login: "bob".into()
        }
    );
    assert_eq!(
        heard(json!({
            "type": "signal", "from": "j1", "login": "bob",
            "data": { "offer": { "type": "offer", "sdp": sdp } }
        })),
        Heard::Signal {
            from: Some("j1".into()),
            login: Some("bob".into()),
            guest: false,
            data: offer(&sdp),
        }
    );
    assert_eq!(
        heard(json!({ "type": "signal", "data": "restart" })),
        Heard::Signal {
            from: None,
            login: None,
            guest: false,
            data: Signal::Restart,
        }
    );
    assert!(serde_json::from_value::<Heard>(json!({ "type": "left", "peer": "j1" })).is_err());
}

/// The next message `socket` hears, as JSON.
async fn said(socket: &mut Accepted) -> serde_json::Value {
    let Some(Ok(Message::Text(said))) = within(socket.next()).await else {
        panic!("the room heard nothing");
    };
    serde_json::from_str(said.as_str()).unwrap()
}

#[test]
fn a_joiner_offers_through_the_room_once_the_host_is_in() {
    let _github = signed_in("ghu_alice");
    let rt = runtime();
    let (worker, mut entering) = stand_in(&rt, None);
    let map = Id::new("m 1".to_string());
    let (room, running) = Room::enter(worker, "alice", &map, Role::Join, Credential::Account);
    rt.spawn(running);
    let tuning = Tuning {
        addresses: Addresses::Loopback,
        stun: &[],
        ..INTERNET
    };
    rt.block_on(async {
        let (entered, mut socket) = within(entering.recv()).await.unwrap();
        assert_eq!(entered.path, "/room/alice/m%201?role=join");
        assert_eq!(entered.auth.as_deref(), Some("Bearer pass-1"));
        socket
            .send(Message::text(
                json!({ "type": "host", "live": true }).to_string(),
            ))
            .await
            .unwrap();
        let reaching = tokio::spawn(async move { room.reach(tuning).await.map(|_| ()) });
        let offered = said(&mut socket).await;
        assert_eq!(offered["type"], "signal");
        assert_eq!(offered["to"], serde_json::Value::Null);
        assert_eq!(offered["data"]["offer"]["type"], "offer");
        assert!(offered["data"]["offer"]["sdp"]
            .as_str()
            .unwrap()
            .starts_with("v=0"));
        reaching.abort();
    });
}

#[test]
fn a_host_is_handed_each_new_offer_and_answers_the_joiner_where_it_is_now() {
    let _github = signed_in("ghu_alice");
    let rt = runtime();
    let (worker, mut entering) = stand_in(&rt, None);
    let map = Id::new("m1".to_string());
    let (mut room, running) = Room::enter(worker, "alice", &map, Role::Host, Credential::Account);
    rt.spawn(running);
    rt.block_on(async {
        let (entered, mut first) = within(entering.recv()).await.unwrap();
        assert_eq!(entered.path, "/room/alice/m1?role=host");
        first.close(None).await.unwrap();
        drop(first);
        let (_, mut socket) = within(entering.recv()).await.unwrap();
        let sdp = offered();
        let signal = json!({
            "type": "signal", "from": "j1", "login": "bob", "guest": true,
            "data": { "offer": { "type": "offer", "sdp": sdp } }
        });
        socket
            .send(Message::text(signal.to_string()))
            .await
            .unwrap();
        let (member, mut negotiation) = within(room.offers.recv()).await.unwrap();
        let bob = Member {
            login: "bob".into(),
            guest: true,
        };
        assert_eq!(member, bob);
        assert_eq!(within(negotiation.rx.recv()).await, Some(offer(&sdp)));
        socket
            .send(Message::text(
                json!({ "type": "joined", "peer": "j2", "login": "bob" }).to_string(),
            ))
            .await
            .unwrap();
        socket
            .send(Message::text(
                json!({ "type": "signal", "from": "j2", "login": "bob", "data": "restart" })
                    .to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(within(negotiation.rx.recv()).await, Some(Signal::Restart));
        assert!(room.offers.try_recv().is_err());
        let mut answering = Rtc::new(Instant::now());
        let answer = answering
            .sdp_api()
            .accept_offer(SdpOffer::from_sdp_string(&sdp).unwrap())
            .unwrap();
        let answered = answer.to_sdp_string();
        negotiation.tx.send(Signal::Answer(answer)).unwrap();
        assert_eq!(
            said(&mut socket).await,
            json!({
                "type": "signal", "to": "j2",
                "data": { "answer": { "type": "answer", "sdp": answered } }
            })
        );
    });
}

#[test]
fn a_room_that_turns_the_app_away_is_not_entered_again() {
    let _github = signed_in("ghu_alice");
    let rt = runtime();
    let (worker, _entering) = stand_in(&rt, Some(403));
    let map = Id::new("m1".to_string());
    let (mut room, running) = Room::enter(worker, "alice", &map, Role::Host, Credential::Account);
    let running = rt.spawn(running);
    rt.block_on(async {
        within(running).await.unwrap();
        assert!(room.turned_away());
        assert!(room.offers.recv().await.is_none());
    });
}

#[test]
fn a_room_is_left_once_its_handle_drops() {
    let _github = signed_in("ghu_alice");
    let rt = runtime();
    let (worker, mut entering) = stand_in(&rt, None);
    let map = Id::new("m1".to_string());
    let (room, running) = Room::enter(worker, "alice", &map, Role::Join, Credential::Account);
    let running = rt.spawn(running);
    rt.block_on(async {
        let (_, mut socket) = within(entering.recv()).await.unwrap();
        drop(room);
        within(running).await.unwrap();
        assert!(matches!(
            within(socket.next()).await,
            Some(Ok(Message::Close(_))) | None
        ));
    });
}

#[test]
fn backoff_doubles_up_to_its_cap_with_jitter() {
    for failures in 1..40u32 {
        let full = BACKOFF_FIRST
            .saturating_mul(1 << (failures - 1).min(16))
            .min(BACKOFF_MOST);
        let wait = backoff(failures);
        assert!(wait <= full && wait >= full / 2, "{failures}: {wait:?}");
    }
}
