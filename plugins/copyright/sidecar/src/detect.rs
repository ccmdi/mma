use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use image::{imageops, GrayImage};
use ort::session::Session;
use ort::value::Tensor;
use regex::Regex;
use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use serde::{Deserialize, Serialize};

use crate::fetch::{fetch_tiles_concurrent, fetch_tiles_streaming};


// Google SV tiles are 512x512 regardless of zoom/pano generation.
const TILE: usize = 512;

// CNN input footprint.
const WIN_W: usize = 256;
const WIN_H: usize = 32;
const NUM_CLASSES: usize = 11;
const BATCH: usize = 512;

// index 0 = none; the rest are watermark years.
const CLASSES: [&str; NUM_CLASSES] = [
    "none", "2017", "2018", "2019", "2020", "2021", "2022", "2023", "2024", "2025", "2026",
];

const THRESH: f32 = 0.5;
const SOLO_THRESH: f32 = 0.9;

// Generic z4-scale watermark template for tier-B NCC localization.
const TH: usize = 19;
const TW: usize = 124;

// A near-flat tile (grayscale std below this) is treated as dead/absent.
const DEAD_STD: f32 = 2.0;

// Pre-2021 watermarks scatter across the z4 nadir band but cluster into a fixed set
// of cells (position analysis, geography-independent). Fetching these top cells (x, row)
// catches ~98% of readable panos at ~1/5 the tiles/FFTs of a full 32-tile sweep.
const TIER_B_CELLS: [(u32, u32); 6] = [(6, 7), (15, 7), (13, 7), (5, 6), (1, 6), (2, 7)];

fn is_official_pano(pano_id: &str) -> bool {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[-_A-Za-z0-9]{21}[AQgw]$").unwrap())
        .is_match(pano_id)
}

fn year_of(idx: usize) -> u32 {
    CLASSES[idx].parse().expect("class label is a year")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectInput {
    pub pano_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectResult {
    pub pano_id: String,
    pub year: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
}

// PIL "L" conversion: fixed-point ITU-R 601 luma with rounding. Rec709 (image
// crate's to_luma8) shifts every pixel and quietly wrecks parity.
fn luma601(r: u8, g: u8, b: u8) -> u8 {
    ((r as u32 * 19595 + g as u32 * 38470 + b as u32 * 7471 + 0x8000) >> 16) as u8
}

// Decodes a tile to a 512x512 grayscale plane; None if the decode fails or the
// tile is near-flat (dead), mirroring window_sweep.fetch_tile.
fn decode_gray(data: &[u8]) -> Option<Vec<u8>> {
    let rgb = image::load_from_memory(data).ok()?.to_rgb8();
    if rgb.width() as usize != TILE || rgb.height() as usize != TILE {
        return None;
    }
    let mut gray = vec![0u8; TILE * TILE];
    for (i, p) in rgb.pixels().enumerate() {
        gray[i] = luma601(p[0], p[1], p[2]);
    }
    let mut sum = 0f64;
    for &v in &gray {
        sum += v as f64;
    }
    let mean = sum / gray.len() as f64;
    let mut var = 0f64;
    for &v in &gray {
        let d = v as f64 - mean;
        var += d * d;
    }
    let std = (var / gray.len() as f64).sqrt() as f32;
    if std < DEAD_STD {
        return None;
    }
    Some(gray)
}

fn softmax(logits: &[f32]) -> [f32; NUM_CLASSES] {
    let mx = logits.iter().copied().fold(f32::MIN, f32::max);
    let mut out = [0f32; NUM_CLASSES];
    let mut sum = 0f32;
    for i in 0..NUM_CLASSES {
        let e = (logits[i] - mx).exp();
        out[i] = e;
        sum += e;
    }
    for v in &mut out {
        *v /= sum;
    }
    out
}

// windows: each is a WIN_H*WIN_W grayscale plane (row-major). Returns per-window softmax.
fn classify(session: &mut Session, windows: &[Vec<u8>]) -> Vec<[f32; NUM_CLASSES]> {
    let mut out = Vec::with_capacity(windows.len());
    let out_name = session.outputs()[0].name().to_string();
    for batch in windows.chunks(BATCH) {
        let n = batch.len();
        let plane = WIN_H * WIN_W;
        let mut data = vec![0f32; n * plane];
        for (j, w) in batch.iter().enumerate() {
            let base = j * plane;
            for k in 0..plane {
                data[base + k] = (w[k] as f32 / 255.0 - 0.5) / 0.5;
            }
        }
        let shape = [n as i64, 1, WIN_H as i64, WIN_W as i64];
        let Ok(tensor) = Tensor::from_array((shape.as_slice(), data.into_boxed_slice())) else {
            out.extend(std::iter::repeat_n([0f32; NUM_CLASSES], n));
            continue;
        };
        let Ok(mut outputs) = session.run(ort::inputs!["x" => tensor]) else {
            out.extend(std::iter::repeat_n([0f32; NUM_CLASSES], n));
            continue;
        };
        let Some(output) = outputs.remove(&out_name) else {
            out.extend(std::iter::repeat_n([0f32; NUM_CLASSES], n));
            continue;
        };
        let Ok((_, raw)) = output.try_extract_tensor::<f32>() else {
            out.extend(std::iter::repeat_n([0f32; NUM_CLASSES], n));
            continue;
        };
        for b in 0..n {
            out.push(softmax(&raw[b * NUM_CLASSES..(b + 1) * NUM_CLASSES]));
        }
    }
    out
}

fn wm_num_classes(session: &mut Session) -> Option<usize> {
    let data = vec![0f32; WIN_H * WIN_W];
    let shape = [1i64, 1, WIN_H as i64, WIN_W as i64];
    let tensor = Tensor::from_array((shape.as_slice(), data.into_boxed_slice())).ok()?;
    let out_name = session.outputs()[0].name().to_string();
    let mut outputs = session.run(ort::inputs!["x" => tensor]).ok()?;
    let output = outputs.remove(&out_name)?;
    let (shape_info, _) = output.try_extract_tensor::<f32>().ok()?;
    let dims: Vec<usize> = shape_info.iter().map(|&d| d as usize).collect();
    (dims.len() == 2).then(|| dims[1])
}

// Crops a sub-region of a 512-wide gray plane and Lanczos-resizes it to WIN_WxWIN_H.
fn crop_resize(gray: &[u8], x0: usize, y0: usize, w: usize, h: usize) -> Vec<u8> {
    let mut sub = GrayImage::new(w as u32, h as u32);
    for yy in 0..h {
        for xx in 0..w {
            sub.put_pixel(xx as u32, yy as u32, image::Luma([gray[(y0 + yy) * TILE + (x0 + xx)]]));
        }
    }
    let resized = imageops::resize(&sub, WIN_W as u32, WIN_H as u32, imageops::FilterType::Lanczos3);
    resized.into_raw()
}

// Native WIN_HxWIN_W slice of a 512-wide gray plane, no resize.
fn slice_window(gray: &[u8], wx: usize, wy: usize) -> Vec<u8> {
    let mut w = vec![0u8; WIN_H * WIN_W];
    for y in 0..WIN_H {
        let src = (wy + y) * TILE + wx;
        w[y * WIN_W..(y + 1) * WIN_W].copy_from_slice(&gray[src..src + WIN_W]);
    }
    w
}

// -------- Tier A: z5 fixed crop + coarse grid --------

fn tier_a_windows(gray: &[u8]) -> Vec<Vec<u8>> {
    // fixed crop (140,244)-(380,280) -> 240x36, resized to 256x32
    let mut wins = vec![crop_resize(gray, 140, 244, 240, 36)];
    let mut wy = 200;
    while wy <= 320 {
        let mut wx = 0;
        while wx + WIN_W <= TILE {
            wins.push(slice_window(gray, wx, wy));
            wx += 128;
        }
        wy += 16;
    }
    wins
}

// Returns the fired year, or None to fall through to tier B.
fn tier_a_vote(probs: &[[f32; NUM_CLASSES]]) -> Option<u32> {
    let mut votes = [0u32; NUM_CLASSES];
    let mut conf = [0f64; NUM_CLASSES];
    for p in probs {
        let mut bi = 1;
        let mut bp = p[1];
        for (i, &v) in p.iter().enumerate().skip(2) {
            if v > bp {
                bp = v;
                bi = i;
            }
        }
        if bp >= THRESH {
            votes[bi] += 1;
            conf[bi] += bp as f64;
        }
    }
    let mut best = 0usize;
    for i in 1..NUM_CLASSES {
        if votes[i] > 0 && (best == 0 || (votes[i], conf[i]) > (votes[best], conf[best])) {
            best = i;
        }
    }
    if best == 0 {
        return None;
    }
    let solo = probs.iter().map(|p| p[best]).fold(f32::MIN, f32::max);
    if votes[best] >= 2 || solo >= SOLO_THRESH {
        Some(year_of(best))
    } else {
        None
    }
}

// -------- Tier B: z4 band NCC-localize then read --------

// Separable Gaussian blur (sigma=2), quantized to u8 like PIL's GaussianBlur so
// the high-pass subtraction matches. clamp-to-edge boundary.
fn gaussian_blur_u8(gray: &[u8]) -> Vec<u8> {
    const SIGMA: f32 = 2.0;
    let radius = (3.0 * SIGMA).ceil() as isize;
    let mut kernel = vec![0f32; (2 * radius + 1) as usize];
    let mut ksum = 0f32;
    for (i, k) in kernel.iter_mut().enumerate() {
        let d = i as isize - radius;
        let v = (-(d * d) as f32 / (2.0 * SIGMA * SIGMA)).exp();
        *k = v;
        ksum += v;
    }
    for k in &mut kernel {
        *k /= ksum;
    }
    let clampi = |v: isize, hi: isize| v.clamp(0, hi) as usize;
    let hi = (TILE - 1) as isize;

    // horizontal pass -> f32
    let mut tmp = vec![0f32; TILE * TILE];
    for y in 0..TILE {
        for x in 0..TILE {
            let mut acc = 0f32;
            for (i, &k) in kernel.iter().enumerate() {
                let sx = clampi(x as isize + i as isize - radius, hi);
                acc += k * gray[y * TILE + sx] as f32;
            }
            tmp[y * TILE + x] = acc;
        }
    }
    // vertical pass -> quantized u8
    let mut out = vec![0u8; TILE * TILE];
    for y in 0..TILE {
        for x in 0..TILE {
            let mut acc = 0f32;
            for (i, &k) in kernel.iter().enumerate() {
                let sy = clampi(y as isize + i as isize - radius, hi);
                acc += k * tmp[sy * TILE + x];
            }
            out[y * TILE + x] = (acc + 0.5).clamp(0.0, 255.0) as u8;
        }
    }
    out
}

// high-pass: g_f32 - quantized_blur (matches sweep_cnn.hp)
fn high_pass(gray: &[u8]) -> Vec<f64> {
    let blur = gaussian_blur_u8(gray);
    (0..TILE * TILE).map(|i| gray[i] as f64 - blur[i] as f64).collect()
}

struct Fft2 {
    fwd: Arc<dyn Fft<f64>>,
    inv: Arc<dyn Fft<f64>>,
}

impl Fft2 {
    fn new() -> Self {
        let mut planner = FftPlanner::<f64>::new();
        Fft2 {
            fwd: planner.plan_fft_forward(TILE),
            inv: planner.plan_fft_inverse(TILE),
        }
    }

    fn transform(&self, buf: &mut [Complex<f64>], fft: &Arc<dyn Fft<f64>>) {
        for r in 0..TILE {
            fft.process(&mut buf[r * TILE..(r + 1) * TILE]);
        }
        let mut col = vec![Complex::new(0.0, 0.0); TILE];
        for c in 0..TILE {
            for r in 0..TILE {
                col[r] = buf[r * TILE + c];
            }
            fft.process(&mut col);
            for r in 0..TILE {
                buf[r * TILE + c] = col[r];
            }
        }
    }

    fn forward(&self, buf: &mut [Complex<f64>]) {
        let fwd = self.fwd.clone();
        self.transform(buf, &fwd);
    }

    fn inverse(&self, buf: &mut [Complex<f64>]) {
        let inv = self.inv.clone();
        self.transform(buf, &inv);
    }
}

// FFT of the flipped, zero-padded template, precomputed once.
fn kernel_fft(template: &[f32], fft2: &Fft2) -> Vec<Complex<f64>> {
    let mut buf = vec![Complex::new(0.0, 0.0); TILE * TILE];
    for u in 0..TH {
        for v in 0..TW {
            // flip2d(GEN)[u][v] = GEN[TH-1-u][TW-1-v]
            let g = template[(TH - 1 - u) * TW + (TW - 1 - v)] as f64;
            buf[u * TILE + v] = Complex::new(g, 0.0);
        }
    }
    fft2.forward(&mut buf);
    buf
}

const OH: usize = TILE - TH + 1; // 494
const OW: usize = TILE - TW + 1; // 389

// Normalized cross-correlation map of the template over high-pass image h.
fn ncc_map(h: &[f64], kfft: &[Complex<f64>], fft2: &Fft2) -> Vec<f64> {
    let mut hf: Vec<Complex<f64>> = h.iter().map(|&v| Complex::new(v, 0.0)).collect();
    fft2.forward(&mut hf);
    for i in 0..hf.len() {
        hf[i] *= kfft[i];
    }
    fft2.inverse(&mut hf);
    let n = (TILE * TILE) as f64;

    // integral image of h*h
    let mut ii = vec![0f64; (TILE + 1) * (TILE + 1)];
    for y in 0..TILE {
        for x in 0..TILE {
            let v = h[y * TILE + x];
            ii[(y + 1) * (TILE + 1) + (x + 1)] =
                v * v + ii[y * (TILE + 1) + (x + 1)] + ii[(y + 1) * (TILE + 1) + x]
                    - ii[y * (TILE + 1) + x];
        }
    }

    let mut ncc = vec![0f64; OH * OW];
    let idx = |y: usize, x: usize| y * (TILE + 1) + x;
    for oy in 0..OH {
        for ox in 0..OW {
            // numerator: circular-conv value at (TH-1+oy, TW-1+ox), real part / N
            let ci = (TH - 1 + oy) * TILE + (TW - 1 + ox);
            let num = hf[ci].re / n;
            let loc = ii[idx(oy + TH, ox + TW)] - ii[idx(oy, ox + TW)] - ii[idx(oy + TH, ox)]
                + ii[idx(oy, ox)];
            ncc[oy * OW + ox] = num / (loc.sqrt() + 1e-6);
        }
    }
    ncc
}

// Top-6 peaks (unordered) of an ncc map: (score, xx, yy) with (xx,yy) = window top-left.
fn top6(ncc: &[f64]) -> Vec<(f64, usize, usize)> {
    let mut best: Vec<(f64, usize)> = Vec::with_capacity(7);
    for (i, &v) in ncc.iter().enumerate() {
        if best.len() < 6 {
            best.push((v, i));
            if best.len() == 6 {
                best.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            }
        } else if v > best[0].0 {
            best[0] = (v, i);
            best.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        }
    }
    best.into_iter()
        .map(|(score, i)| (score, i % OW, i / OW))
        .collect()
}

// Vote over CNN reads of tight crops around peaks. thr=0.5, minvotes=2.
fn tier_b_vote(probs: &[[f32; NUM_CLASSES]]) -> Option<u32> {
    let mut votes = [0u32; NUM_CLASSES];
    let mut conf = [0f64; NUM_CLASSES];
    for p in probs {
        let mut pred = 0usize;
        let mut pm = p[0];
        for (i, &v) in p.iter().enumerate().skip(1) {
            if v > pm {
                pm = v;
                pred = i;
            }
        }
        if pred == 0 {
            continue;
        }
        let yp = p[1..].iter().copied().fold(f32::MIN, f32::max);
        if yp < THRESH {
            continue;
        }
        votes[pred] += 1;
        conf[pred] += yp as f64;
    }
    let mut best = 0usize;
    for i in 1..NUM_CLASSES {
        if votes[i] > 0 && (best == 0 || (votes[i], conf[i]) > (votes[best], conf[best])) {
            best = i;
        }
    }
    if best != 0 && votes[best] >= 2 {
        Some(year_of(best))
    } else {
        None
    }
}

// tiles: alive z4 grays in localize order (rows 6,7 x 0..15). Returns detected year.
fn tier_b(
    session: &mut Session,
    tiles: &[Vec<u8>],
    kfft: &[Complex<f64>],
    fft2: &Fft2,
) -> Option<u32> {
    if tiles.is_empty() {
        return None;
    }
    // The 32 per-tile FFTs dominate tier-B cost; run them across cores. rustfft's
    // Fft is Send+Sync, so &fft2/&kfft share safely and each call allocates its own scratch.
    let nthreads = std::thread::available_parallelism().map_or(4, |n| n.get());
    let group = tiles.len().div_ceil(nthreads).max(1);
    let mut peaks: Vec<(f64, usize, usize, usize)> = std::thread::scope(|scope| {
        let handles: Vec<_> = tiles
            .chunks(group)
            .enumerate()
            .map(|(gi, chunk)| {
                scope.spawn(move || {
                    let mut local = Vec::new();
                    for (li, g) in chunk.iter().enumerate() {
                        let ncc = ncc_map(&high_pass(g), kfft, fft2);
                        for (score, xx, yy) in top6(&ncc) {
                            local.push((score, gi * group + li, xx, yy));
                        }
                    }
                    local
                })
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    peaks.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    peaks.truncate(14);
    if peaks.is_empty() {
        return None;
    }

    let mut wins = Vec::with_capacity(peaks.len() * 2);
    for &(_, ti, xx, yy) in &peaks {
        for (pw, ph) in [(20usize, 7usize), (32, 10)] {
            let a = xx.saturating_sub(pw);
            let b = (xx + TW + pw).min(TILE);
            let c = yy.saturating_sub(ph);
            let e = (yy + TH + ph).min(TILE);
            wins.push(crop_resize(&tiles[ti], a, c, b - a, e - c));
        }
    }
    tier_b_vote(&classify(session, &wins))
}

// -------- session + template loading --------

fn load_session(model_dir: &str) -> Session {
    let path = Path::new(model_dir).join("wm_cls.onnx");
    Session::builder()
        .expect("failed to create session builder")
        .commit_from_file(&path)
        .unwrap_or_else(|e| panic!("failed to load wm_cls model at {}: {e}", path.display()))
}

fn load_template(model_dir: &str) -> Vec<f32> {
    let path = Path::new(model_dir).join("wm_template.bin");
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|e| panic!("failed to read template at {}: {e}", path.display()));
    assert_eq!(bytes.len(), TH * TW * 4, "wm_template.bin wrong size");
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

pub fn run(input: &DetectInput, model_dir: &str, mut emit: impl FnMut(DetectResult)) {
    let mut session = load_session(model_dir);
    match wm_num_classes(&mut session) {
        Some(nc) if nc == NUM_CLASSES => {}
        got => {
            let classes = got.map_or("unknown".into(), |n: usize| n.to_string());
            let msg = format!("model mismatch: wm_cls outputs {classes} classes, expected {NUM_CLASSES}");
            eprintln!("[copyright] FATAL: {msg}");
            let total = input.pano_ids.len();
            for (i, pid) in input.pano_ids.iter().enumerate() {
                emit(DetectResult {
                    pano_id: pid.clone(), year: None, text: None,
                    error: Some(msg.clone()),
                    done: Some(i + 1), total: Some(total),
                });
            }
            return;
        }
    }

    let fft2 = Fft2::new();
    let template = load_template(model_dir);
    let kfft = kernel_fft(&template, &fft2);
    // Pool of single-threaded sessions: tier-A CNN throughput is otherwise capped
    // by one core. Reuse the guard session as sessions[0].
    let pool_size = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    let mut sessions: Vec<Session> = std::iter::once(session)
        .chain((1..pool_size).map(|_| load_session(model_dir)))
        .collect();
    eprintln!("[copyright] wm_cls loaded, {NUM_CLASSES} classes, {} sessions", sessions.len());

    let total = input.pano_ids.len();
    let mut done = 0;
    let pano_strs: Vec<&str> = input.pano_ids.iter().map(|s| s.as_str()).collect();

    let mut officials: Vec<&str> = Vec::with_capacity(pano_strs.len());
    for &pid in &pano_strs {
        if is_official_pano(pid) {
            officials.push(pid);
        } else {
            done += 1;
            emit(DetectResult {
                pano_id: pid.to_string(), year: None, text: None,
                error: Some("unofficial pano".into()),
                done: Some(done), total: Some(total),
            });
        }
    }

    // Tier A: stream z5 (18,13) fetches over ALL panos and classify each the moment
    // it lands, across the session pool. No chunk barrier -> continuous progress.
    let fetch_rx = std::sync::Mutex::new(fetch_tiles_streaming(&officials, 5, 18, 13));
    let (res_tx, res_rx) = std::sync::mpsc::channel::<(String, Option<u32>, Option<String>)>();
    let need_b: Vec<(String, Option<String>)> = std::thread::scope(|scope| {
        for session in sessions.iter_mut() {
            let res_tx = res_tx.clone();
            let fetch_rx = &fetch_rx;
            scope.spawn(move || {
                loop {
                    // Lock held only for the recv; classification runs unlocked.
                    let item = { fetch_rx.lock().unwrap().recv() };
                    let (pid, data) = match item {
                        Ok(v) => v,
                        Err(_) => break,
                    };
                    let (year, err) = match data {
                        Ok(bytes) => match decode_gray(&bytes) {
                            Some(g) => (tier_a_vote(&classify(session, &tier_a_windows(&g))), None),
                            None => (None, None),
                        },
                        Err(e) => (None, Some(e)),
                    };
                    let _ = res_tx.send((pid, year, err));
                }
            });
        }
        drop(res_tx);
        let mut nb = Vec::new();
        for (pid, year, err) in res_rx {
            match year {
                Some(y) => {
                    done += 1;
                    emit(DetectResult {
                        pano_id: pid, year: Some(y), text: Some("A".into()),
                        error: None, done: Some(done), total: Some(total),
                    });
                }
                None => nb.push((pid, err)),
            }
        }
        nb
    });

    // Tier B: fetch the 32-tile z4 band across the need_b subset, classify each
    // (tier_b parallelizes its own FFTs), emit as each pano finishes.
    if !need_b.is_empty() {
        let nb_ids: Vec<&str> = need_b.iter().map(|(pid, _)| pid.as_str()).collect();
        let mut btiles: HashMap<&str, Vec<Vec<u8>>> = HashMap::new();
        for &(x, row) in &TIER_B_CELLS {
            let fetched = fetch_tiles_concurrent(&nb_ids, 4, x, row);
            for &pid in &nb_ids {
                if let Some(Ok(data)) = fetched.get(pid)
                    && let Some(g) = decode_gray(data)
                {
                    btiles.entry(pid).or_default().push(g);
                }
            }
        }
        for (pid, z5err) in &need_b {
            let tiles = btiles.get(pid.as_str()).map(|v| v.as_slice()).unwrap_or(&[]);
            let year = tier_b(&mut sessions[0], tiles, &kfft, &fft2);
            done += 1;
            let (text, error) = match year {
                Some(_) => (Some("B".to_string()), None),
                None => (None, z5err.clone()),
            };
            emit(DetectResult {
                pano_id: pid.clone(), year, text, error,
                done: Some(done), total: Some(total),
            });
        }
    }
}

#[cfg(test)]
#[path = "detect.test.rs"]
mod tests;
