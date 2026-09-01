use std::sync::{Arc, OnceLock};
use tokio::sync::Semaphore;

const TILE_URL: &str = "https://geo0.ggpht.com/cbk";
const CONCURRENCY: usize = 50;

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("failed to build tokio runtime")
    })
}

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .pool_max_idle_per_host(CONCURRENCY)
            .build()
            .unwrap()
    })
}

const RETRY_BACKOFFS_MS: [u64; 2] = [500, 1500];

// Opt-in disk cache for eval iteration; unset in production.
fn cache_path(pano_id: &str, zoom: u32, x: u32, y: u32) -> Option<std::path::PathBuf> {
    let dir = std::env::var_os("MMA_TILE_CACHE")?;
    let safe: String = pano_id.chars().map(|c| if c == '/' { '_' } else { c }).collect();
    Some(std::path::Path::new(&dir).join(format!("{safe}_{zoom}_{x}_{y}.jpg")))
}

async fn fetch_one(cl: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let mut attempt = 0;
    loop {
        match cl.get(url).send().await {
            Ok(resp) if resp.status().is_client_error() => {
                return Err(format!("HTTP {}", resp.status()));
            }
            Ok(resp) => match resp.error_for_status() {
                Ok(resp) => return resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string()),
                Err(e) => {
                    if attempt >= RETRY_BACKOFFS_MS.len() {
                        return Err(e.to_string());
                    }
                }
            },
            Err(e) => {
                if attempt >= RETRY_BACKOFFS_MS.len() {
                    return Err(e.to_string());
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(RETRY_BACKOFFS_MS[attempt])).await;
        attempt += 1;
    }
}

/// One tile request; workers route the result by zoom (5 = fixed-spot rung, 4 = band cell).
pub struct TileJob {
    pub pano_id: String,
    pub zoom: u32,
    pub x: u32,
    pub y: u32,
}

pub type TileResult = (TileJob, Result<Vec<u8>, String>);

/// Handle for enqueueing tile fetches; dropping every clone (after the queue drains)
/// closes the result channel.
#[derive(Clone)]
pub struct JobSender(tokio::sync::mpsc::UnboundedSender<TileJob>);

impl JobSender {
    pub fn send(&self, job: TileJob) {
        let _ = self.0.send(job);
    }
}

/// Streaming fetch pump: jobs go in at any time, each result comes out the moment its
/// fetch completes. Lets escalation fetches overlap classification with no phase barrier.
pub fn start_fetcher() -> (JobSender, std::sync::mpsc::Receiver<TileResult>) {
    let rt = runtime();
    let cl = client();
    let sem = Arc::new(Semaphore::new(CONCURRENCY));
    let (job_tx, mut job_rx) = tokio::sync::mpsc::unbounded_channel::<TileJob>();
    let (res_tx, res_rx) = std::sync::mpsc::channel::<TileResult>();

    rt.spawn(async move {
        let mut set = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                job = job_rx.recv() => match job {
                    Some(job) => {
                        let sem = sem.clone();
                        let res_tx = res_tx.clone();
                        set.spawn(async move {
                            let (pid, zoom, x, y) = (&job.pano_id, job.zoom, job.x, job.y);
                            let cache = cache_path(pid, zoom, x, y);
                            if let Some(ref p) = cache
                                && let Ok(data) = std::fs::read(p)
                            {
                                let _ = res_tx.send((job, Ok(data)));
                                return;
                            }
                            let result = match sem.acquire().await {
                                Ok(_permit) => {
                                    let url = format!(
                                        "{TILE_URL}?cb_client=apiv3&panoid={pid}&output=tile&x={x}&y={y}&zoom={zoom}"
                                    );
                                    fetch_one(cl, &url).await
                                }
                                Err(e) => Err(e.to_string()),
                            };
                            if let (Some(p), Ok(data)) = (&cache, &result) {
                                std::fs::write(p, data).ok();
                            }
                            let _ = res_tx.send((job, result));
                        });
                    }
                    None => break,
                },
                Some(_) = set.join_next(), if !set.is_empty() => {}
            }
        }
        while set.join_next().await.is_some() {}
    });
    (JobSender(job_tx), res_rx)
}
