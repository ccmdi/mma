use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tokio::sync::Semaphore;

const TILE_URL: &str = "https://geo0.ggpht.com/cbk";
const CONCURRENCY: usize = 60;
const FETCH_ZOOM: u32 = 2;
const TILE_PX: u32 = 512;

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

async fn fetch_tile(cl: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
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

fn tile_layout(zoom: u32, world_w: u32, world_h: u32) -> (u32, u32, u32, u32, u32) {
    let max_zoom = ((world_w as f64) / TILE_PX as f64).log2().ceil() as u32;
    let z = zoom.min(max_zoom);
    let scale = 1u32 << (max_zoom - z);
    let width = (world_w as f64 / scale as f64).round() as u32;
    let height = (world_h as f64 / scale as f64).round() as u32;
    let cols = width.div_ceil(TILE_PX);
    let rows = height.div_ceil(TILE_PX);
    (z, cols, rows, width, height)
}

async fn fetch_and_stitch(
    client: &reqwest::Client,
    sem: &Semaphore,
    pano_id: &str,
    world_w: u32,
    world_h: u32,
) -> Result<image::RgbImage, String> {
    let (z, cols, rows, width, height) = tile_layout(FETCH_ZOOM, world_w, world_h);

    let futs: Vec<_> = (0..rows).flat_map(|y| {
        (0..cols).map(move |x| {
            let pid = pano_id.to_string();
            async move {
                let _permit = sem.acquire().await.map_err(|e| e.to_string())?;
                let url = format!(
                    "{TILE_URL}?cb_client=apiv3&panoid={pid}&output=tile&zoom={z}&x={x}&y={y}"
                );
                let data = fetch_tile(client, &url).await?;
                Ok::<(u32, u32, Vec<u8>), String>((x, y, data))
            }
        })
    }).collect();

    let results = futures::future::join_all(futs).await;

    // Refuse to embed a partially-black pano: any failed or undecodable tile
    // fails the whole pano so a later run retries it.
    let mut pano = image::RgbImage::new(width, height);
    for result in results {
        let (tx, ty, data) = result?;
        let tile = image::load_from_memory(&data)
            .map_err(|e| format!("tile decode failed: {e}"))?
            .to_rgb8();
        let dst_x = tx * TILE_PX;
        let dst_y = ty * TILE_PX;
        let copy_w = tile.width().min(width.saturating_sub(dst_x));
        let copy_h = tile.height().min(height.saturating_sub(dst_y));
        for py in 0..copy_h {
            for px in 0..copy_w {
                pano.put_pixel(dst_x + px, dst_y + py, *tile.get_pixel(px, py));
            }
        }
    }

    Ok(pano)
}

/// Fetch and stitch panos concurrently. Each entry is (pano_id, world_w, world_h).
pub fn fetch_panos_concurrent(entries: &[(&str, u32, u32)]) -> HashMap<String, Result<image::RgbImage, String>> {
    let rt = runtime();
    let cl = client();
    let sem = Arc::new(Semaphore::new(CONCURRENCY));

    rt.block_on(async {
        let mut handles = Vec::with_capacity(entries.len());
        for &(pid, ww, wh) in entries {
            let sem = sem.clone();
            let pid = pid.to_string();
            handles.push(tokio::spawn(async move {
                let result = fetch_and_stitch(cl, &sem, &pid, ww, wh).await;
                (pid, result)
            }));
        }

        let mut results = HashMap::with_capacity(entries.len());
        for handle in handles {
            if let Ok((pid, result)) = handle.await {
                results.insert(pid, result);
            }
        }
        results
    })
}
