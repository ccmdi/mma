//! The collab Worker: who this app is to it, and the maps people share through it.

use super::copy::Via;
use crate::net::{fetch, github, proxy};
use crate::store::maps::MapMeta;
use crate::types::{AppError, AppResult};
use crate::util::blocking;
use mma_algebra::Id;
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use std::cell::Cell;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

/// Seconds before a pass expires at which a new one is asked for instead.
const PASS_SKEW: u64 = 300;

/// A Worker this app talks to, with the passes it issued, each beside what it was issued
/// against.
pub(crate) struct Worker {
    pub(super) origin: String,
    passes: Mutex<HashMap<Credential, (String, Pass)>>,
    /// What this app shows the Worker with an invite code, so it is the same guest every time.
    guest: String,
}

/// Who this app is to the Worker.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Credential {
    /// The signed-in GitHub account.
    Account,
    /// A guest, by the invite code a host gave.
    Invite(String),
}

/// What a Worker issued: its token, the login it vouches for, the unix second it expires at,
/// and for a guest the map its invite opens.
#[derive(Clone, serde::Deserialize, specta::Type)]
pub(crate) struct Pass {
    pub(crate) token: String,
    pub(crate) login: String,
    #[specta(type = u32)]
    pub(crate) exp: u64,
    #[serde(default)]
    pub(crate) invited: Option<Invited>,
}

/// A map a guest was invited to, by its host.
#[derive(Clone, Debug, PartialEq, serde::Deserialize, specta::Type)]
pub(crate) struct Invited {
    pub(crate) host: String,
    pub(crate) map: Id<MapMeta, String>,
    pub(crate) name: String,
}

/// The invite code that lets guests join a shared map, and the unix second it expires at.
#[derive(Clone, Debug, PartialEq, serde::Deserialize, specta::Type)]
pub(crate) struct Invite {
    pub(crate) code: String,
    #[specta(type = u32)]
    pub(crate) exp: u64,
}

/// A map the signed-in user shares, and with whom.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
pub(crate) struct Share {
    /// The shared map.
    pub(crate) map: Id<MapMeta, String>,
    /// The map's name as it was shared.
    pub(crate) name: String,
    /// The GitHub logins it is shared with.
    pub(crate) logins: Vec<String>,
    /// The code that lets guests without a GitHub account join, while it is on.
    #[serde(default)]
    pub(crate) invite: Option<String>,
}

/// A map someone shares with the signed-in user, and whether they host it now.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
pub(crate) struct Shared {
    /// The GitHub login sharing the map.
    pub(crate) host: String,
    /// The shared map, as its host knows it.
    pub(crate) map: Id<MapMeta, String>,
    /// The map's name as it was shared.
    pub(crate) name: String,
    /// Whether the host is online with the map now.
    pub(crate) live: bool,
}

/// The maps the signed-in user shares, and the maps shared with them.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
pub(crate) struct Shares {
    /// The maps the signed-in user shares.
    pub(crate) mine: Vec<Share>,
    /// The maps others share with the signed-in user.
    #[serde(rename = "withMe")]
    pub(crate) with_me: Vec<Shared>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

/// The Worker's explanation of a refusal with `status` whose body is `body`.
pub(super) fn refusal(status: impl std::fmt::Display, body: &[u8]) -> AppError {
    let said = serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|body| Some(body.get("error")?.as_str()?.to_string()));
    match said {
        Some(error) => AppError(format!("the collab service refused ({status}): {error}")),
        None => AppError(format!("the collab service refused ({status})")),
    }
}

/// What the Worker answered with `status` and `body`, or why it refused.
fn answered<T: DeserializeOwned>(status: StatusCode, body: &[u8]) -> AppResult<T> {
    if status == StatusCode::NO_CONTENT {
        return Ok(serde_json::from_value(serde_json::Value::Null)?);
    }
    if status.is_success() {
        return Ok(serde_json::from_slice(body)?);
    }
    Err(refusal(status, body))
}

impl From<&Via> for Credential {
    fn from(via: &Via) -> Self {
        match via {
            Via::Map { .. } => Credential::Account,
            Via::Code { code } => Credential::Invite(code.clone()),
        }
    }
}

impl Credential {
    /// What a pass is issued against now: the GitHub session, or the code.
    async fn basis(&self) -> AppResult<String> {
        match self {
            Credential::Account => blocking(github::require_token).await?,
            Credential::Invite(code) => Ok(code.clone()),
        }
    }

    /// A pass from `worker`, beside what it was issued against.
    async fn mint(&self, worker: &Worker) -> AppResult<(String, Pass)> {
        let (basis, status, body) = match self {
            Credential::Account => {
                let url = format!("{}/session", worker.origin);
                blocking(move || -> AppResult<_> {
                    let sent = Cell::default();
                    let response = github::authed(|token| {
                        sent.set(token.to_string());
                        proxy::proxy_client()
                            .post(&url)
                            .header("Accept", "application/json")
                            .bearer_auth(token)
                    })?;
                    Ok((sent.into_inner(), response.status(), response.bytes()?))
                })
                .await??
            }
            Credential::Invite(code) => {
                let response = fetch::http_client()
                    .post(format!("{}/guest", worker.origin))
                    .header("Accept", "application/json")
                    .json(&serde_json::json!({ "code": code, "key": worker.guest }))
                    .send()
                    .await?;
                (code.clone(), response.status(), response.bytes().await?)
            }
        };
        Ok((basis, answered(status, &body)?))
    }
}

impl Worker {
    /// The Worker at `origin`.
    pub(crate) fn at(origin: &str) -> Self {
        Worker {
            origin: origin.trim_end_matches('/').into(),
            passes: Mutex::default(),
            guest: uuid::Uuid::new_v4().simple().to_string(),
        }
    }

    /// The first-party Worker, the only place this app sends the GitHub session to, or the
    /// one `MMA_COLLAB_WORKER` names.
    pub(crate) fn first_party() -> &'static Self {
        static WORKER: OnceLock<Worker> = OnceLock::new();
        WORKER.get_or_init(|| {
            let origin = crate::env::var("MMA_COLLAB_WORKER");
            Worker::at(origin.as_deref().unwrap_or("https://collab.ccmdi.com"))
        })
    }

    /// A pass for `credential`, issued again shortly before the last one expires or once what
    /// it was issued against changes.
    pub(crate) async fn pass(&self, credential: &Credential) -> AppResult<Pass> {
        let basis = credential.basis().await?;
        let mut passes = self.passes.lock().await;
        if let Some((held, pass)) = passes.get(credential) {
            if *held == basis && now() + PASS_SKEW < pass.exp {
                return Ok(pass.clone());
            }
        }
        let (basis, pass) = credential.mint(self).await?;
        passes.insert(credential.clone(), (basis, pass.clone()));
        Ok(pass)
    }

    /// Forget the pass issued for `credential`, so the next is issued afresh.
    pub(super) async fn forget(&self, credential: &Credential) {
        self.passes.lock().await.remove(credential);
    }

    /// Send `method` to `path` with `body` as the signed-in user, issuing a fresh pass once if
    /// the Worker turns the first away, and read what it answered.
    pub(crate) async fn call<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> AppResult<T> {
        let answer = self.answer(method.clone(), path, body).await;
        if let Err(error) = &answer {
            log::warn!("[collab] {method} {path} failed: {}", error.0);
        }
        answer
    }

    async fn answer<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> AppResult<T> {
        let send = |token: String| {
            let request = fetch::http_client()
                .request(method.clone(), format!("{}{path}", self.origin))
                .header("Accept", "application/json")
                .bearer_auth(token);
            match body {
                Some(body) => request.json(body),
                None => request,
            }
            .send()
        };
        let account = Credential::Account;
        let mut response = send(self.pass(&account).await?.token).await?;
        if response.status() == StatusCode::UNAUTHORIZED {
            self.forget(&account).await;
            response = send(self.pass(&account).await?.token).await?;
        }
        let status = response.status();
        answered(status, &response.bytes().await?)
    }
}

#[cfg(test)]
#[path = "worker.test.rs"]
mod tests;
