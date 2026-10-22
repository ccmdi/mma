use super::*;
use crate::net::github::tests::{signed_in, switch_account};
use reqwest::Method;
use serde::de::IgnoredAny;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use tauri::async_runtime::block_on;

/// One request a stand-in Worker was sent.
#[derive(Clone, Debug)]
struct Asked {
    method: String,
    url: String,
    auth: Option<String>,
    body: String,
}

/// A stand-in Worker on loopback, answering each request as `reply` says.
struct Stub {
    origin: String,
    asked: Arc<Mutex<Vec<Asked>>>,
}

impl Stub {
    fn new(reply: impl Fn(&Asked) -> (u16, serde_json::Value) + Send + 'static) -> Self {
        crate::install_crypto_provider();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let asked = Arc::new(Mutex::new(Vec::new()));
        let kept = Arc::clone(&asked);
        thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).unwrap();
                let auth = request
                    .headers()
                    .iter()
                    .find(|header| header.field.equiv("Authorization"))
                    .map(|header| header.value.to_string());
                let seen = Asked {
                    method: request.method().as_str().to_string(),
                    url: request.url().to_string(),
                    auth,
                    body,
                };
                let (status, json) = reply(&seen);
                kept.lock().unwrap().push(seen);
                let header =
                    tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap();
                let response = tiny_http::Response::from_string(json.to_string())
                    .with_status_code(status)
                    .with_header(header);
                let _ = request.respond(response);
            }
        });
        Stub {
            origin: format!("http://127.0.0.1:{port}"),
            asked,
        }
    }

    fn worker(&self) -> Worker {
        Worker::at(&self.origin)
    }

    fn asked(&self) -> Vec<Asked> {
        self.asked.lock().unwrap().clone()
    }

    fn minted(&self) -> usize {
        self.asked()
            .iter()
            .filter(|asked| asked.url == "/session")
            .count()
    }
}

fn passing(exp: u64) -> impl Fn(&Asked) -> (u16, serde_json::Value) {
    move |asked| match asked.url.as_str() {
        "/session" => (
            200,
            serde_json::json!({ "token": "pass-1", "login": "alice", "exp": exp }),
        ),
        "/shares" => (
            200,
            serde_json::json!({
                "mine": [{ "map": "m1", "name": "Mine", "logins": ["bob"] }],
                "withMe": [{ "host": "carol", "map": "m2", "name": "Theirs", "live": true }],
            }),
        ),
        _ => (200, serde_json::json!({})),
    }
}

#[test]
fn a_pass_is_issued_for_the_github_session_and_reused_until_near_its_expiry() {
    let stub = Stub::new(passing(now() + 86_400));
    let worker = stub.worker();
    let _github = signed_in("ghu_alice");
    let pass = block_on(worker.pass(&Credential::Account)).unwrap();
    assert_eq!(
        (pass.token.as_str(), pass.login.as_str()),
        ("pass-1", "alice")
    );
    block_on(worker.pass(&Credential::Account)).unwrap();
    assert_eq!(stub.minted(), 1);
    let session = &stub.asked()[0];
    assert_eq!(session.method, "POST");
    assert_eq!(session.auth.as_deref(), Some("Bearer ghu_alice"));
}

#[test]
fn a_pass_near_its_expiry_is_issued_again() {
    let stub = Stub::new(passing(now() + PASS_SKEW - 1));
    let worker = stub.worker();
    let _github = signed_in("ghu_alice");
    block_on(worker.pass(&Credential::Account)).unwrap();
    block_on(worker.pass(&Credential::Account)).unwrap();
    assert_eq!(stub.minted(), 2);
}

#[test]
fn a_new_github_session_is_issued_a_new_pass() {
    let stub = Stub::new(passing(now() + 86_400));
    let worker = stub.worker();
    let github = signed_in("ghu_alice");
    block_on(worker.pass(&Credential::Account)).unwrap();
    drop(github);
    let _github = signed_in("ghu_bob");
    block_on(worker.pass(&Credential::Account)).unwrap();
    assert_eq!(stub.minted(), 2);
    assert_eq!(stub.asked()[1].auth.as_deref(), Some("Bearer ghu_bob"));
}

#[test]
fn a_pass_is_kept_against_the_session_it_was_issued_for_when_the_account_switches_meanwhile() {
    let stub = Stub::new(|asked| {
        let login = match asked.auth.as_deref() {
            Some("Bearer ghu_alice") => {
                switch_account("ghu_bob");
                "alice"
            }
            _ => "bob",
        };
        let exp = now() + 86_400;
        (
            200,
            serde_json::json!({ "token": format!("pass-{login}"), "login": login, "exp": exp }),
        )
    });
    let worker = stub.worker();
    let _github = signed_in("ghu_alice");
    let during = block_on(worker.pass(&Credential::Account)).unwrap();
    let after = block_on(worker.pass(&Credential::Account)).unwrap();
    assert_eq!(
        (during.login.as_str(), after.login.as_str()),
        ("alice", "bob")
    );
    assert_eq!(stub.minted(), 2);
}

#[test]
fn a_refused_pass_says_what_the_worker_said() {
    let stub = Stub::new(|_| (403, serde_json::json!({ "error": "not allowed" })));
    let worker = stub.worker();
    let _github = signed_in("ghu_alice");
    let error = block_on(worker.pass(&Credential::Account)).err().unwrap();
    assert!(error.0.contains("not allowed"), "{}", error.0);
}

#[test]
fn a_call_sends_its_method_path_and_body_with_the_pass_and_reads_the_answer() {
    let stub = Stub::new(passing(now() + 86_400));
    let worker = stub.worker();
    let _github = signed_in("ghu_alice");
    let body = serde_json::json!({ "name": "Map one", "logins": ["bob"] });
    let _: IgnoredAny = block_on(worker.call(Method::PUT, "/shares/m1", Some(&body))).unwrap();
    let shared = stub.asked().into_iter().last().unwrap();
    assert_eq!(
        (shared.method.as_str(), shared.url.as_str()),
        ("PUT", "/shares/m1")
    );
    assert_eq!(shared.auth.as_deref(), Some("Bearer pass-1"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&shared.body).unwrap(),
        body
    );
    let shares: Shares = block_on(worker.call(Method::GET, "/shares", None)).unwrap();
    assert_eq!(
        shares,
        Shares {
            mine: vec![Share {
                map: Id::new("m1".into()),
                name: "Mine".into(),
                logins: vec!["bob".into()],
                invite: None,
            }],
            with_me: vec![Shared {
                host: "carol".into(),
                map: Id::new("m2".into()),
                name: "Theirs".into(),
                live: true,
            }],
        }
    );
}

#[test]
fn a_pass_the_worker_turns_away_is_issued_again_once() {
    let stub = Stub::new(|asked| match asked.url.as_str() {
        "/session" => (
            200,
            serde_json::json!({ "token": "pass-1", "login": "alice", "exp": now() + 86_400 }),
        ),
        _ => (401, serde_json::json!({ "error": "expired" })),
    });
    let worker = stub.worker();
    let _github = signed_in("ghu_alice");
    let error = block_on(worker.call::<Shares>(Method::GET, "/shares", None))
        .err()
        .unwrap();
    assert!(error.0.contains("expired"), "{}", error.0);
    assert_eq!(stub.minted(), 2);
    assert_eq!(stub.asked().len(), 4);
}

#[test]
fn an_invite_code_is_traded_for_a_guest_pass_once_and_leaves_the_account_pass_alone() {
    let exp = now() + 86_400;
    let stub = Stub::new(move |asked| match asked.url.as_str() {
        "/guest" => (
            200,
            serde_json::json!({
                "token": "guest-pass", "login": "guest--a1b2c3", "exp": exp,
                "invited": { "host": "carol", "map": "m2", "name": "Theirs" },
            }),
        ),
        "/session" => (
            200,
            serde_json::json!({ "token": "pass-1", "login": "alice", "exp": exp }),
        ),
        _ => (200, serde_json::json!({})),
    });
    let worker = stub.worker();
    let _github = signed_in("ghu_alice");

    let typed = Credential::Invite(" ABCD-2345 ".into());
    let pass = block_on(worker.pass(&typed)).unwrap();
    assert_eq!(pass.login, "guest--a1b2c3");
    assert_eq!(
        pass.invited,
        Some(Invited {
            host: "carol".into(),
            map: Id::new("m2".into()),
            name: "Theirs".into(),
        })
    );
    block_on(worker.pass(&typed)).unwrap();
    let traded: Vec<Asked> = stub
        .asked()
        .into_iter()
        .filter(|asked| asked.url == "/guest")
        .collect();
    assert_eq!(traded.len(), 1);
    assert_eq!(traded[0].auth, None);
    assert!(
        traded[0].body.contains("\" ABCD-2345 \""),
        "{}",
        traded[0].body
    );
    let account = block_on(worker.pass(&Credential::Account)).unwrap();
    assert_eq!((account.login.as_str(), account.invited), ("alice", None));
}

#[test]
fn an_invite_code_traded_again_shows_the_worker_the_same_guest() {
    let stub = Stub::new(|asked| match asked.url.as_str() {
        "/guest" => (
            200,
            serde_json::json!({
                "token": "guest-pass", "login": "guest--a1b2c3", "exp": now() + 86_400,
            }),
        ),
        _ => (200, serde_json::json!({})),
    });
    let worker = stub.worker();
    let code = Credential::Invite("abcd2345".into());
    block_on(worker.pass(&code)).unwrap();
    block_on(worker.forget(&code));
    block_on(worker.pass(&code)).unwrap();
    let keys: Vec<serde_json::Value> = stub
        .asked()
        .iter()
        .filter(|asked| asked.url == "/guest")
        .map(|asked| serde_json::from_str::<serde_json::Value>(&asked.body).unwrap())
        .map(|body| body["key"].clone())
        .collect();
    assert_eq!(keys.len(), 2);
    assert!(
        keys[0].as_str().is_some_and(|key| key.len() >= 16),
        "{keys:?}"
    );
    assert_eq!(keys[0], keys[1]);
}
