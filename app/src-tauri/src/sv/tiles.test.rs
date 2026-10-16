use super::*;
use crate::net::fetch::SendFn;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::Duration;

fn world(width: i32, height: i32) -> ImageSize {
    ImageSize { height, width }
}

#[test]
fn gen4_fills_whole_tiles() {
    assert_eq!(
        grid(3, &world(16384, 8192)),
        Grid {
            zoom: 3,
            cols: 8,
            rows: 4,
            width: 4096,
            height: 2048
        }
    );
}

#[test]
fn gen3_crops_the_padding_a_full_grid_would_carry() {
    assert_eq!(
        grid(3, &world(6656, 3328)),
        Grid {
            zoom: 3,
            cols: 7,
            rows: 4,
            width: 3328,
            height: 1664
        }
    );
}

#[test]
fn gen3_at_native_zoom_keeps_the_half_row() {
    assert_eq!(
        grid(4, &world(6656, 3328)),
        Grid {
            zoom: 4,
            cols: 13,
            rows: 7,
            width: 6656,
            height: 3328
        }
    );
}

#[test]
fn a_zoom_past_the_panoramas_own_clamps_to_it() {
    let g = grid(5, &world(6656, 3328));
    assert_eq!((g.zoom, g.width, g.height), (4, 6656, 3328));
}

/// A solid tile whose red and green channels name its column and row.
fn tile_jpeg(x: u32, y: u32) -> Vec<u8> {
    let tile = RgbImage::from_pixel(
        TILE_PX,
        TILE_PX,
        image::Rgb([x as u8 * 30, y as u8 * 60, 0]),
    );
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 100)
        .encode_image(&tile)
        .unwrap();
    out
}

fn param(url: &str, key: &str) -> u32 {
    url.split(['?', '&'])
        .find_map(|kv| kv.strip_prefix(&format!("{key}=")))
        .unwrap()
        .parse()
        .unwrap()
}

/// A session whose transport answers each tile with the status `status_of` gives its
/// column and row, carrying [`tile_jpeg`] when that is 200.
fn tile_server(status_of: impl Fn(u32, u32) -> u16 + Send + Sync + 'static) -> Session {
    let send: SendFn = Box::new(move |req: HttpRequestSpec| {
        let (x, y) = (param(&req.url, "x"), param(&req.url, "y"));
        let status = status_of(x, y);
        let body = if status == 200 {
            tile_jpeg(x, y)
        } else {
            Vec::new()
        };
        Box::pin(async move { Ok(HttpResponse { status, body }) })
    });
    Session::new(
        Arc::new(Transport {
            send,
            backoff: Duration::from_millis(1),
        }),
        Arc::default(),
    )
}

fn near(a: image::Rgb<u8>, b: [u8; 3]) -> bool {
    a.0.iter().zip(b).all(|(p, q)| p.abs_diff(q) <= 4)
}

#[test]
fn a_stitched_panorama_places_every_tile_and_crops_to_the_imagery() {
    let image = stitch(&tile_server(|_, _| 200), "abc", &world(6656, 3328), 3).unwrap();

    assert_eq!(image.dimensions(), (3328, 1664));
    for y in 0..4 {
        for x in 0..7 {
            let px = image.get_pixel(x * TILE_PX + 100, (y * TILE_PX + 100).min(1663));
            assert!(
                near(*px, [x as u8 * 30, y as u8 * 60, 0]),
                "tile {x},{y} is {px:?}"
            );
        }
    }
}

#[test]
fn a_tile_that_fails_fails_the_panorama() {
    let missing = tile_server(|x, y| if (x, y) == (2, 1) { 404 } else { 200 });
    assert!(stitch(&missing, "abc", &world(6656, 3328), 3).is_err());
}

#[test]
fn a_transient_failure_is_retried_before_the_panorama_gives_up() {
    let calls = Arc::new(AtomicU32::new(0));
    let counted = calls.clone();
    let flaky = tile_server(move |x, y| {
        if (x, y) == (0, 0) && counted.fetch_add(1, Ordering::Relaxed) == 0 {
            503
        } else {
            200
        }
    });

    assert!(stitch(&flaky, "abc", &world(16384, 8192), 1).is_ok());
    assert_eq!(calls.load(Ordering::Relaxed), 2);
}

#[test]
fn a_cancelled_run_stops_its_panorama_short_of_the_remaining_tiles() {
    let cancel = Arc::new(AtomicBool::new(false));
    let calls = Arc::new(AtomicU32::new(0));
    let (cancelling, counted) = (cancel.clone(), calls.clone());
    let shared = tile_server(move |_, _| {
        counted.fetch_add(1, Ordering::SeqCst);
        cancelling.store(true, Ordering::SeqCst);
        200
    });

    assert!(stitch(&shared.cancelled_by(cancel), "abc", &world(16384, 8192), 3).is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1, "of 32 tiles");
    assert!(stitch(&shared, "abc", &world(16384, 8192), 1).is_ok());
}

#[test]
fn a_path_that_names_neither_a_panorama_nor_a_tile_is_refused() {
    for path in ["", "abc", "abc/x", "abc/1/2", "abc/1/2/3/4"] {
        assert!(fetch_path(path, None).is_err(), "{path}");
        let run_id = runs::run_reserve();
        assert!(fetch_path(path, Some(run_id)).is_err(), "{path}");
        assert!(
            runs::unregister_run(run_id).is_none(),
            "{path} left its run registered"
        );
    }
}
