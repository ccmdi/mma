use std::collections::HashMap;
use std::fs;
use std::path::Path;

use ndarray::Array3;
pub use ort::session::Session;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};

use crate::fetch::fetch_panos_concurrent;

const INPUT_SIZE: usize = 224;
// SigLIP normalization: mean/std 0.5 across all channels (x/255 -> [-1, 1]).
const MEAN: [f32; 3] = [0.5, 0.5, 0.5];
const STD: [f32; 3] = [0.5, 0.5, 0.5];

pub const EMBED_DIM: usize = 768;
pub const NUM_CROPS: usize = 4;
const CHUNK_SIZE: usize = 500;

// SigLIP text encoder is trained with a fixed sequence length padded with the
// pad/eos token (</s> == id 1). No attention mask input.
const TEXT_SEQ_LEN: usize = 64;
const PAD_ID: i64 = 1;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanoEntry {
    pub pano_id: String,
    pub world_width: u32,
    pub world_height: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedInput {
    pub panos: Vec<PanoEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbedStatus {
    pub pano_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
}

// --- Equirectangular -> perspective crops via precomputed remap ---

use std::sync::Mutex;
use crate::project::RemapTable;

static REMAP_CACHE: Mutex<Vec<((u32, u32), Vec<RemapTable>)>> = Mutex::new(Vec::new());

pub fn debug_extract_crops(pano: &image::RgbImage) -> Vec<image::RgbImage> {
    extract_crops(pano)
}

fn extract_crops(pano: &image::RgbImage) -> Vec<image::RgbImage> {
    let pw = pano.width();
    let ph = pano.height();

    // Ensure tables exist
    {
        let cache = REMAP_CACHE.lock().unwrap();
        if !cache.iter().any(|((w, h), _)| *w == pw && *h == ph) {
            drop(cache);
            let yaws = [0.0f32, 90.0, 180.0, 270.0];
            let tables: Vec<RemapTable> = yaws.iter().map(|&yaw| {
                RemapTable::new(
                    INPUT_SIZE as u32, INPUT_SIZE as u32,
                    90.0, yaw, 0.0,
                    pw, ph,
                )
            }).collect();
            REMAP_CACHE.lock().unwrap().push(((pw, ph), tables));
        }
    }

    let cache = REMAP_CACHE.lock().unwrap();
    let (_, tables) = cache.iter().find(|((w, h), _)| *w == pw && *h == ph).unwrap();
    let src = pano.as_raw();
    tables.iter().map(|t| t.remap(src, pw, ph)).collect()
}

// --- Preprocessing ---

fn preprocess_image(img: &image::RgbImage) -> Array3<f32> {
    let resized = image::imageops::resize(
        img, INPUT_SIZE as u32, INPUT_SIZE as u32,
        image::imageops::FilterType::CatmullRom,
    );
    let mut tensor = Array3::<f32>::zeros((3, INPUT_SIZE, INPUT_SIZE));
    for y in 0..INPUT_SIZE {
        for x in 0..INPUT_SIZE {
            let p = resized.get_pixel(x as u32, y as u32).0;
            for c in 0..3 {
                tensor[[c, y, x]] = (p[c] as f32 / 255.0 - MEAN[c]) / STD[c];
            }
        }
    }
    tensor
}

fn normalize_embedding(emb: &mut [f32]) {
    let norm: f32 = emb.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for v in emb.iter_mut() { *v /= norm; }
    }
}

// --- Model loading ---

// GPU builds run fp16 models: DirectML/CoreML/CUDA crash on int8 dynamic-quant
// graphs, and fp16 is far faster on GPU. CPU builds run the int8 models.
#[cfg(any(feature = "directml", feature = "coreml", feature = "cuda"))]
const PREFER_FP16: bool = true;
#[cfg(not(any(feature = "directml", feature = "coreml", feature = "cuda")))]
const PREFER_FP16: bool = false;

fn model_path(model_dir: &str, int8_name: &str, fp16_name: &str) -> std::path::PathBuf {
    let dir = Path::new(model_dir);
    if PREFER_FP16 {
        let fp16 = dir.join(fp16_name);
        if fp16.exists() { return fp16; }
    }
    dir.join(int8_name)
}

fn load_session(path: &Path) -> Session {
    Session::builder()
        .expect("failed to create ONNX session builder")
        .commit_from_file(path)
        .unwrap_or_else(|e| panic!("failed to load model at {}: {e}", path.display()))
}

pub fn load_image_encoder(model_dir: &str) -> Session {
    load_session(&model_path(model_dir, "vision_model.onnx", "vision_model_fp16.onnx"))
}

pub fn load_text_encoder(model_dir: &str) -> Session {
    load_session(&model_path(model_dir, "text_model.onnx", "text_model_fp16.onnx"))
}

// --- Inference ---

pub fn embed_image_batch(session: &mut Session, images: &[image::RgbImage]) -> Result<Vec<[f32; EMBED_DIM]>, String> {
    if images.is_empty() { return Ok(vec![]); }
    let n = images.len();
    let mut data = vec![0f32; n * 3 * INPUT_SIZE * INPUT_SIZE];
    for (i, img) in images.iter().enumerate() {
        let t = preprocess_image(img);
        let offset = i * 3 * INPUT_SIZE * INPUT_SIZE;
        data[offset..offset + 3 * INPUT_SIZE * INPUT_SIZE]
            .copy_from_slice(t.as_slice().unwrap());
    }
    let shape = [n as i64, 3, INPUT_SIZE as i64, INPUT_SIZE as i64];
    let tensor = Tensor::from_array((shape.as_slice(), data.into_boxed_slice()))
        .map_err(|e| e.to_string())?;

    let mut outputs = session.run(ort::inputs!["pixel_values" => tensor])
        .map_err(|e| e.to_string())?;
    let output = outputs.remove("pooler_output").ok_or("no pooler_output")?;
    let (_, slice) = output.try_extract_tensor::<f32>().map_err(|e| e.to_string())?;

    let mut results = Vec::with_capacity(n);
    for i in 0..n {
        let mut emb = [0f32; EMBED_DIM];
        emb.copy_from_slice(&slice[i * EMBED_DIM..(i + 1) * EMBED_DIM]);
        normalize_embedding(&mut emb);
        results.push(emb);
    }
    Ok(results)
}

/// SigLIP canonicalizes captions (delete punctuation, collapse whitespace, lowercase).
fn canonicalize_text(text: &str) -> String {
    let folded: String = text
        .chars()
        .filter(|c| !c.is_ascii_punctuation())
        .flat_map(char::to_lowercase)
        .collect();
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn embed_text(session: &mut Session, tokenizer: &tokenizers::Tokenizer, text: &str) -> Result<[f32; EMBED_DIM], String> {
    let encoding = tokenizer.encode(canonicalize_text(text), true).map_err(|e| e.to_string())?;
    let mut ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
    ids.truncate(TEXT_SEQ_LEN);
    ids.resize(TEXT_SEQ_LEN, PAD_ID);

    let ids_tensor = Tensor::from_array(([1i64, TEXT_SEQ_LEN as i64].as_slice(), ids.into_boxed_slice()))
        .map_err(|e| e.to_string())?;

    let mut outputs = session.run(ort::inputs!["input_ids" => ids_tensor])
        .map_err(|e| e.to_string())?;
    let output = outputs.remove("pooler_output").ok_or("no pooler_output")?;
    let (_, slice) = output.try_extract_tensor::<f32>().map_err(|e| e.to_string())?;

    let mut emb = [0f32; EMBED_DIM];
    emb.copy_from_slice(&slice[..EMBED_DIM]);
    normalize_embedding(&mut emb);
    Ok(emb)
}

// --- Cache I/O (multi-crop: NUM_CROPS embeddings per pano) ---

const CACHE_VERSION: u32 = 6;
const CACHE_FILE: &str = "embeddings_v6.bin";

/// Modification time of the on-disk cache; `None` when absent. Lets a resident
/// process detect that a concurrent `embed` run rewrote the cache.
pub fn cache_mtime(cache_dir: &str) -> Option<std::time::SystemTime> {
    fs::metadata(Path::new(cache_dir).join(CACHE_FILE))
        .and_then(|m| m.modified())
        .ok()
}

#[derive(Default)]
pub struct EmbedCache {
    pub entries: HashMap<String, Vec<[f32; EMBED_DIM]>>,
}

impl EmbedCache {
    pub fn pano_ids(&self) -> Vec<&str> {
        self.entries.keys().map(String::as_str).collect()
    }

    pub fn load(cache_dir: &str) -> Self {
        let p = Path::new(cache_dir).join(CACHE_FILE);
        let mut cache = Self::default();
        let Ok(data) = fs::read(&p) else { return cache; };
        let mut pos = 0;
        if data.len() < 4 { return cache; }
        let version = u32::from_le_bytes(data[pos..pos + 4].try_into().unwrap());
        pos += 4;
        if version != CACHE_VERSION { return cache; }
        while pos + 2 <= data.len() {
            let id_len = u16::from_le_bytes(data[pos..pos + 2].try_into().unwrap()) as usize;
            pos += 2;
            let emb_bytes = NUM_CROPS * EMBED_DIM * 4;
            if pos + id_len + emb_bytes > data.len() { break; }
            let pano_id = String::from_utf8_lossy(&data[pos..pos + id_len]).to_string();
            pos += id_len;
            let mut crops = Vec::with_capacity(NUM_CROPS);
            for c in 0..NUM_CROPS {
                let mut emb = [0f32; EMBED_DIM];
                let off = pos + c * EMBED_DIM * 4;
                for (val, chunk) in emb
                    .iter_mut()
                    .zip(data[off..off + EMBED_DIM * 4].chunks_exact(4))
                {
                    *val = f32::from_le_bytes(chunk.try_into().unwrap());
                }
                crops.push(emb);
            }
            pos += emb_bytes;
            cache.entries.insert(pano_id, crops);
        }
        cache
    }

    pub fn save(&self, cache_dir: &str) {
        let dir = Path::new(cache_dir);
        let _ = fs::create_dir_all(dir);
        let mut buf = Vec::new();
        buf.extend_from_slice(&CACHE_VERSION.to_le_bytes());
        for (id, crops) in &self.entries {
            let id_bytes = id.as_bytes();
            buf.extend_from_slice(&(id_bytes.len() as u16).to_le_bytes());
            buf.extend_from_slice(id_bytes);
            for emb in crops {
                for &v in emb { buf.extend_from_slice(&v.to_le_bytes()); }
            }
        }
        // Atomic: write to a temp file in the same dir, then rename.
        let tmp = dir.join(format!("{CACHE_FILE}.tmp"));
        if fs::write(&tmp, &buf).is_ok() {
            let _ = fs::rename(&tmp, dir.join(CACHE_FILE));
        }
    }
}

// --- Main embed command ---

pub fn run(
    input: &EmbedInput,
    model_dir: &str,
    cache_dir: &str,
    mut emit: impl FnMut(EmbedStatus),
) {
    let mut cache = EmbedCache::load(cache_dir);
    let to_compute: Vec<&PanoEntry> = input.panos.iter()
        .filter(|p| !cache.entries.contains_key(p.pano_id.as_str()))
        .collect();

    let cached_count = input.panos.len() - to_compute.len();
    if cached_count > 0 {
        emit(EmbedStatus {
            pano_id: String::new(), status: "cache_hit".into(),
            error: None, done: Some(cached_count), total: Some(input.panos.len()),
        });
    }
    if to_compute.is_empty() { return; }

    let mut session = load_image_encoder(model_dir);
    let total = to_compute.len();
    let mut done = 0usize;

    for chunk in to_compute.chunks(CHUNK_SIZE) {
        let t_fetch = std::time::Instant::now();
        let fetch_args: Vec<(&str, u32, u32)> = chunk.iter()
            .map(|p| (p.pano_id.as_str(), p.world_width, p.world_height))
            .collect();
        let fetched = fetch_panos_concurrent(&fetch_args);
        let fetch_ms = t_fetch.elapsed().as_millis();

        let t_crop = std::time::Instant::now();
        let mut batch_pids: Vec<&str> = Vec::new();
        let mut batch_crops: Vec<image::RgbImage> = Vec::new();
        let mut fetch_errors = 0;

        for entry in chunk {
            let pid = entry.pano_id.as_str();
            let result = fetched.get(pid);
            match result {
                None => {
                    done += 1; fetch_errors += 1;
                    emit(EmbedStatus {
                        pano_id: pid.to_string(), status: "error".into(),
                        error: Some("fetch missing".into()), done: Some(done), total: Some(total),
                    });
                    continue;
                }
                Some(Err(e)) => {
                    done += 1; fetch_errors += 1;
                    emit(EmbedStatus {
                        pano_id: pid.to_string(), status: "error".into(),
                        error: Some(e.clone()), done: Some(done), total: Some(total),
                    });
                }
                Some(Ok(img)) => {
                    let crops = extract_crops(img);
                    batch_pids.push(pid);
                    batch_crops.extend(crops);
                }
            }
        }
        let crop_ms = t_crop.elapsed().as_millis();

        eprintln!("[vision] chunk {}: fetch={}ms stitch+crop={}ms panos={} errors={} crops={}",
            done / CHUNK_SIZE, fetch_ms, crop_ms, batch_pids.len(), fetch_errors, batch_crops.len());

        if batch_crops.is_empty() { continue; }

        // Inference in small GPU batches (BATCH_SIZE crops at a time), emit per pano
        const BATCH_SIZE: usize = 32;
        let mut pid_offset = 0usize;
        let mut all_embs: Vec<[f32; EMBED_DIM]> = Vec::with_capacity(batch_crops.len());
        // Parallel to all_embs: marks entries from a failed inference batch, so
        // they can be excluded from the cache instead of poisoning it with zeros.
        let mut failed: Vec<bool> = Vec::with_capacity(batch_crops.len());
        let t_infer = std::time::Instant::now();

        for crop_batch in batch_crops.chunks(BATCH_SIZE) {
            match embed_image_batch(&mut session, crop_batch) {
                Ok(embs) => {
                    all_embs.extend_from_slice(&embs);
                    failed.extend(std::iter::repeat(false).take(crop_batch.len()));
                }
                Err(e) => {
                    // Zero-fill so indexing stays aligned; `failed` keeps these out of the cache.
                    for _ in 0..crop_batch.len() {
                        all_embs.push([0f32; EMBED_DIM]);
                        failed.push(true);
                    }
                    eprintln!("batch inference error: {e}");
                }
            }
            // Emit for any panos fully covered by embeddings so far
            while pid_offset < batch_pids.len() && (pid_offset + 1) * NUM_CROPS <= all_embs.len() {
                let pid = batch_pids[pid_offset];
                let start = pid_offset * NUM_CROPS;
                let pano_failed = failed[start..start + NUM_CROPS].iter().any(|&f| f);
                done += 1;
                pid_offset += 1;
                if pano_failed {
                    emit(EmbedStatus {
                        pano_id: pid.to_string(), status: "error".into(),
                        error: Some("inference failed".into()), done: Some(done), total: Some(total),
                    });
                } else {
                    let crop_embs: Vec<[f32; EMBED_DIM]> = all_embs[start..start + NUM_CROPS].to_vec();
                    cache.entries.insert(pid.to_string(), crop_embs);
                    emit(EmbedStatus {
                        pano_id: pid.to_string(), status: "computed".into(),
                        error: None, done: Some(done), total: Some(total),
                    });
                }
            }
        }
        // Handle any remaining (shouldn't happen if math is right, but be safe)
        while pid_offset < batch_pids.len() {
            let pid = batch_pids[pid_offset];
            done += 1;
            pid_offset += 1;
            emit(EmbedStatus {
                pano_id: pid.to_string(), status: "error".into(),
                error: Some("incomplete inference".into()), done: Some(done), total: Some(total),
            });
        }

        let infer_ms = t_infer.elapsed().as_millis();
        eprintln!("[vision] chunk {}: inference={}ms ({} crops, {:.0}ms/crop)",
            done / CHUNK_SIZE, infer_ms, batch_crops.len(),
            infer_ms as f64 / batch_crops.len().max(1) as f64);

        // Save after each chunk
        cache.save(cache_dir);
    }
}

#[cfg(test)]
#[path = "embed.test.rs"]
mod tests;
