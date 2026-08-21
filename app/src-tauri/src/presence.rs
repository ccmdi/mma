//! Discord Rich Presence (opt-in). Thin primitive: JS composes the activity
//! payload -- respecting the user's privacy setting -- and pushes it here; this
//! module only owns the process-global IPC client and forwards. Every path is a
//! silent no-op when Discord isn't running, so nothing here ever surfaces an error.

use crate::types::AppResult;
use discord_rich_presence::{
    activity::{Activity, Assets, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::time::Duration;

const CLIENT_ID: &str = "1525958540181901475";

type Job<C> = Box<dyn FnOnce(&mut C) -> Result<(), Box<dyn std::error::Error>> + Send>;

/// Serial executor owning the lazily connected client; IPC never runs on a command thread.
struct Worker<C> {
    tx: Sender<(bool, Job<C>)>,
}

impl<C: Send + 'static> Worker<C> {
    fn spawn(connect: impl Fn() -> Option<C> + Send + 'static) -> Self {
        let (tx, rx) = channel::<(bool, Job<C>)>();
        std::thread::spawn(move || {
            let mut client: Option<C> = None;
            for (may_connect, job) in rx {
                if client.is_none() {
                    if !may_connect {
                        continue;
                    }
                    client = connect();
                }
                if let Some(c) = client.as_mut() {
                    if job(c).is_err() {
                        client = None;
                    }
                }
            }
        });
        Worker { tx }
    }

    /// With `may_connect` false the job is dropped unless already connected.
    fn submit(
        &self,
        may_connect: bool,
        job: impl FnOnce(&mut C) -> Result<(), Box<dyn std::error::Error>> + Send + 'static,
    ) {
        let _ = self.tx.send((may_connect, Box::new(job)));
    }
}

static WORKER: OnceLock<Worker<DiscordIpcClient>> = OnceLock::new();

fn worker() -> &'static Worker<DiscordIpcClient> {
    WORKER.get_or_init(|| {
        Worker::spawn(|| {
            let mut client = DiscordIpcClient::new(CLIENT_ID).ok()?;
            client.connect().ok().map(|_| client)
        })
    })
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PresenceActivity {
    pub details: Option<String>,
    pub state: Option<String>,
    pub large_image: Option<String>,
    pub large_text: Option<String>,
    pub small_image: Option<String>,
    pub small_text: Option<String>,
    /// Unix seconds; Discord renders an "elapsed" timer counting up from here.
    pub start: Option<i64>,
}

#[tauri::command]
#[specta::specta]
pub fn discord_presence_set(activity: PresenceActivity) -> AppResult<()> {
    worker().submit(true, move |client| {
        let mut act = Activity::new();
        if let Some(d) = activity.details.as_deref() {
            act = act.details(d);
        }
        if let Some(s) = activity.state.as_deref() {
            act = act.state(s);
        }
        let mut assets = Assets::new();
        if let Some(v) = activity.large_image.as_deref() {
            assets = assets.large_image(v);
        }
        if let Some(v) = activity.large_text.as_deref() {
            assets = assets.large_text(v);
        }
        if let Some(v) = activity.small_image.as_deref() {
            assets = assets.small_image(v);
        }
        if let Some(v) = activity.small_text.as_deref() {
            assets = assets.small_text(v);
        }
        act = act.assets(assets);
        if let Some(ts) = activity.start {
            act = act.timestamps(Timestamps::new().start(ts));
        }
        client.set_activity(act)
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn discord_presence_clear() -> AppResult<()> {
    worker().submit(false, |client| client.clear_activity());
    Ok(())
}

/// Clear presence and drop the connection on app exit; never waits on a stuck pipe.
pub fn shutdown() {
    let Some(w) = WORKER.get() else { return };
    let (tx, rx) = channel();
    w.submit(false, move |client| {
        let _ = client.clear_activity();
        let _ = client.close();
        let _ = tx.send(());
        Ok(())
    });
    let _ = rx.recv_timeout(Duration::from_millis(500));
}

#[cfg(test)]
#[path = "presence.test.rs"]
mod presence_tests;
