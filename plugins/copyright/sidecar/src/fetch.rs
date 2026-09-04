use std::collections::HashMap;
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

// Streaming variant: returns a receiver that yields each (pano_id, result) the
// moment its fetch completes, so callers can classify/emit without waiting for the
// whole batch. Kills the per-chunk fetch barrier.
pub fn fetch_tiles_streaming(
    pano_ids: &[&str],
    zoom: u32,
    x: u32,
    y: u32,
) -> std::sync::mpsc::Receiver<(String, Result<Vec<u8>, String>)> {
    let rt = runtime();
    let cl = client();
    let sem = Arc::new(Semaphore::new(CONCURRENCY));
    let (tx, rx) = std::sync::mpsc::channel();
    let ids: Vec<String> = pano_ids.iter().map(|s| s.to_string()).collect();

    rt.spawn(async move {
        let mut handles = Vec::with_capacity(ids.len());
        for pid in ids {
            let sem = sem.clone();
            let tx = tx.clone();
            handles.push(tokio::spawn(async move {
                let cache = cache_path(&pid, zoom, x, y);
                if let Some(ref p) = cache
                    && let Ok(data) = std::fs::read(p)
                {
                    let _ = tx.send((pid, Ok(data)));
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
                let _ = tx.send((pid, result));
            }));
        }
        for h in handles {
            let _ = h.await;
        }
    });
    rx
}

pub fn fetch_tiles_concurrent(
    pano_ids: &[&str],
    zoom: u32,
    x: u32,
    y: u32,
) -> HashMap<String, Result<Vec<u8>, String>> {
    let rt = runtime();
    let cl = client();
    let sem = Arc::new(Semaphore::new(CONCURRENCY));

    rt.block_on(async {
        let mut handles = Vec::with_capacity(pano_ids.len());
        for &pid in pano_ids {
            let sem = sem.clone();
            let pid = pid.to_string();
            handles.push(tokio::spawn(async move {
                let cache = cache_path(&pid, zoom, x, y);
                if let Some(ref p) = cache
                    && let Ok(data) = std::fs::read(p)
                {
                    return (pid, Ok(data));
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
                (pid, result)
            }));
        }

        let mut results = HashMap::with_capacity(pano_ids.len());
        for handle in handles {
            if let Ok((pid, result)) = handle.await {
                results.insert(pid, result);
            }
        }
        results
    })
}
