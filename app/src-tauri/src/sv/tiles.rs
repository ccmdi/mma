//! Panorama imagery: the tile grid Google serves a panorama in, and the one way the app,
//! its webview and its sidecars fetch it.

use std::borrow::Cow;
use std::sync::{Arc, OnceLock};

use image::codecs::jpeg::JpegEncoder;
use image::{imageops, ImageFormat, RgbImage};

use crate::net::fetch::{Endpoint, HttpRequestSpec, HttpResponse, Policy, Session, Transport};
use crate::runs;
use crate::sv::pano::fetch_metadata;
use crate::sv::schema::owned::ImageSize;
use crate::types::{AppError, AppResult};

const TILE_URL: &str = "https://geo0.ggpht.com/cbk";
/// Tiles are a fixed pitch in `worldSize` space at every zoom.
const TILE_PX: u32 = 512;
const JPEG_QUALITY: u8 = 95;

/// Every tile request the app and its sidecars make shares this one lane.
pub static TILES: Endpoint = Endpoint {
    name: Cow::Borrowed("PanoTiles"),
    policy: Policy {
        rate: None,
        retry: None,
        inflight: Some(96),
    },
    idempotent: true,
};

fn session() -> &'static Session {
    static S: OnceLock<Session> = OnceLock::new();
    S.get_or_init(|| Session::new(Transport::production(), Arc::default()))
}

/// The tiles a panorama spans at a zoom and the image they crop to. The grid rounds up to
/// whole tiles while the imagery spans only `worldSize`, and a zoom past the panorama's
/// own maximum is clamped to it.
#[derive(Debug, PartialEq)]
pub(crate) struct Grid {
    pub zoom: u32,
    pub cols: u32,
    pub rows: u32,
    pub width: u32,
    pub height: u32,
}

pub(crate) fn grid(zoom: u32, world: &ImageSize) -> Grid {
    let (world_w, world_h) = (
        f64::from(world.width.max(1)),
        f64::from(world.height.max(1)),
    );
    let max_zoom = (world_w / f64::from(TILE_PX)).log2().ceil().max(0.0) as u32;
    let zoom = zoom.min(max_zoom);
    let scale = f64::from(1u32 << (max_zoom - zoom));
    let width = (world_w / scale).round() as u32;
    let height = (world_h / scale).round() as u32;
    Grid {
        zoom,
        cols: width.div_ceil(TILE_PX),
        rows: height.div_ceil(TILE_PX),
        width,
        height,
    }
}

pub(crate) struct Tile<'a> {
    pub pano_id: &'a str,
    pub zoom: u32,
    pub x: u32,
    pub y: u32,
}

fn tile_request(tile: &Tile) -> HttpRequestSpec {
    HttpRequestSpec {
        method: "GET".into(),
        url: format!(
            "{TILE_URL}?cb_client=apiv3&panoid={}&output=tile&zoom={}&x={}&y={}",
            tile.pano_id, tile.zoom, tile.x, tile.y
        ),
        headers: Vec::new(),
        body: None,
    }
}

fn tile_body(answer: AppResult<HttpResponse>) -> AppResult<Vec<u8>> {
    let resp = answer?;
    if (200..300).contains(&resp.status) {
        Ok(resp.body)
    } else {
        Err(AppError(format!("tile answered {}", resp.status)))
    }
}

/// Each tile's JPEG, aligned to `tiles`.
fn fetch_tiles(session: &Session, tiles: &[Tile]) -> Vec<AppResult<Vec<u8>>> {
    let reqs: Vec<HttpRequestSpec> = tiles.iter().map(tile_request).collect();
    session
        .fetch(&TILES, 1, &reqs)
        .into_iter()
        .map(tile_body)
        .collect()
}

/// A panorama of `world` size stitched at `zoom` and cropped to its imagery. A tile that
/// fails fails the panorama rather than leave a hole in it.
fn stitch(session: &Session, pano_id: &str, world: &ImageSize, zoom: u32) -> AppResult<RgbImage> {
    let g = grid(zoom, world);
    let tiles: Vec<Tile> = (0..g.rows)
        .flat_map(|y| (0..g.cols).map(move |x| (x, y)))
        .map(|(x, y)| Tile {
            pano_id,
            zoom: g.zoom,
            x,
            y,
        })
        .collect();
    let mut image = RgbImage::new(g.width, g.height);
    for (tile, jpeg) in tiles.iter().zip(fetch_tiles(session, &tiles)) {
        let piece = image::load_from_memory_with_format(&jpeg?, ImageFormat::Jpeg)?.to_rgb8();
        imageops::replace(
            &mut image,
            &piece,
            i64::from(tile.x * TILE_PX),
            i64::from(tile.y * TILE_PX),
        );
    }
    Ok(image)
}

fn fetch_pano(session: &Session, pano_id: &str, zoom: u32) -> AppResult<Vec<u8>> {
    let pano = fetch_metadata(session, &[pano_id.to_owned()])
        .metas
        .pop()
        .flatten()
        .ok_or_else(|| AppError(format!("no panorama {pano_id}")))?;
    let image = stitch(session, pano_id, &pano.world_size, zoom)?;
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY).encode_image(&image)?;
    Ok(jpeg)
}

/// A JPEG by path: `{pano}/{zoom}` is the whole panorama, stitched and cropped to its
/// imagery, and `{pano}/{zoom}/{x}/{y}` is one tile. Under a run, cancelling it stops the fetch.
pub(crate) fn fetch_path(path: &str, run: Option<u32>) -> AppResult<Vec<u8>> {
    let Some(run_id) = run else {
        return fetch_from(session(), path);
    };
    let run_session = session().cancelled_by(runs::register_run(run_id, None)?);
    let out = fetch_from(&run_session, path);
    drop(runs::unregister_run(run_id));
    out
}

fn fetch_from(session: &Session, path: &str) -> AppResult<Vec<u8>> {
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let num = |s: &str| {
        s.parse::<u32>()
            .map_err(|_| AppError(format!("bad panorama path '{path}'")))
    };
    match parts.as_slice() {
        [pano_id, zoom] => fetch_pano(session, pano_id, num(zoom)?),
        [pano_id, zoom, x, y] => {
            let tile = Tile {
                pano_id,
                zoom: num(zoom)?,
                x: num(x)?,
                y: num(y)?,
            };
            fetch_tiles(session, &[tile])
                .pop()
                .expect("one tile answers once")
        }
        _ => Err(AppError(format!("bad panorama path '{path}'"))),
    }
}

#[cfg(test)]
#[path = "tiles.test.rs"]
mod tests;
