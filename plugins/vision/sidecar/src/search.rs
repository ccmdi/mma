use std::path::Path;
use serde::{Deserialize, Serialize};
use crate::embed::{self, EmbedCache, EMBED_DIM};

/// SigLIP sigmoid scoring parameters, loaded from models/scoring.json.
/// logit_scale here is already exp'd (the multiplier applied to cosine).
#[derive(Deserialize)]
pub struct Scoring {
    pub logit_scale: f32,
    pub logit_bias: f32,
}

impl Scoring {
    pub fn load(model_dir: &str) -> Self {
        let p = Path::new(model_dir).join("scoring.json");
        let raw = std::fs::read_to_string(&p)
            .unwrap_or_else(|e| panic!("failed to read scoring.json at {}: {e}", p.display()));
        serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("invalid scoring.json: {e}"))
    }
}

fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

/// SigLIP text-to-image probability from a cosine similarity.
pub fn text_probability(cosine: f32, scoring: &Scoring) -> f32 {
    sigmoid(cosine * scoring.logit_scale + scoring.logit_bias)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearchInput {
    pub query: String,
    pub k: Option<usize>,
    pub threshold: Option<f32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSearchInput {
    pub pano_id: String,
    pub k: Option<usize>,
    pub threshold: Option<f32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub results: Vec<SearchHit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub pano_id: String,
    pub score: f32,
}

fn max_crop_score(query: &[f32; EMBED_DIM], crops: &[[f32; EMBED_DIM]]) -> f32 {
    crops.iter()
        .map(|emb| emb.iter().zip(query.iter()).map(|(a, b)| a * b).sum::<f32>())
        .fold(f32::NEG_INFINITY, f32::max)
}

fn search(
    cache: &EmbedCache,
    query: &[f32; EMBED_DIM],
    k: Option<usize>,
    threshold: Option<f32>,
    exclude: Option<&str>,
    score_fn: impl Fn(f32) -> f32 + Sync,
) -> Vec<SearchHit> {
    use rayon::prelude::*;
    if k == Some(0) {
        return vec![];
    }
    let desc = |a: &(&String, f32), b: &(&String, f32)| {
        b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
    };
    // Score borrowing the ids; only the k winners get cloned into SearchHits.
    let mut scored: Vec<(&String, f32)> = cache.entries.par_iter()
        .filter(|(pid, _)| exclude.is_none_or(|ex| pid.as_str() != ex))
        .map(|(pid, crops)| {
            (pid, (score_fn(max_crop_score(query, crops)) * 10000.0).round() / 10000.0)
        })
        .filter(|(_, s)| threshold.is_none_or(|t| *s >= t))
        .collect();
    if let Some(k) = k
        && k < scored.len()
    {
        scored.select_nth_unstable_by(k - 1, desc);
        scored.truncate(k);
    }
    scored.sort_by(desc);
    scored.into_iter()
        .map(|(pid, score)| SearchHit { pano_id: pid.clone(), score })
        .collect()
}

/// Text query pipeline held together so a resident process loads the tokenizer,
/// scoring table, and ONNX session once instead of per query (the dominant
/// per-search cost by far).
pub struct TextSearcher {
    tokenizer: tokenizers::Tokenizer,
    scoring: Scoring,
    session: embed::Session,
}

impl TextSearcher {
    pub fn load(model_dir: &str) -> Result<Self, String> {
        let tokenizer_path = Path::new(model_dir).join("tokenizer.json");
        let tokenizer = tokenizers::Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| format!("failed to load tokenizer: {e}"))?;
        Ok(Self {
            tokenizer,
            scoring: Scoring::load(model_dir),
            session: embed::load_text_encoder(model_dir),
        })
    }

    pub fn search(&mut self, cache: &EmbedCache, input: &TextSearchInput) -> SearchResults {
        if cache.entries.is_empty() {
            return SearchResults { results: vec![] };
        }
        match embed::embed_text(&mut self.session, &self.tokenizer, &input.query) {
            Ok(query_emb) => SearchResults {
                results: search(cache, &query_emb, input.k, input.threshold, None,
                    |cos| text_probability(cos, &self.scoring)),
            },
            Err(e) => {
                eprintln!("text encoding error: {e}");
                SearchResults { results: vec![] }
            }
        }
    }
}

pub fn text_search(input: &TextSearchInput, model_dir: &str, cache_dir: &str) -> SearchResults {
    let cache = EmbedCache::load(cache_dir);
    if cache.entries.is_empty() {
        return SearchResults { results: vec![] };
    }
    let mut searcher =
        TextSearcher::load(model_dir).unwrap_or_else(|e| panic!("{e}"));
    searcher.search(&cache, input)
}

/// Image-to-image search over an already-loaded cache.
pub fn image_search_in(cache: &EmbedCache, input: &ImageSearchInput) -> SearchResults {
    let Some(ref_crops) = cache.entries.get(&input.pano_id) else {
        eprintln!("pano {} not in cache", input.pano_id);
        return SearchResults { results: vec![] };
    };
    // Average crop embeddings as reference
    let mut ref_emb = [0f32; EMBED_DIM];
    for crop in ref_crops {
        for (i, &v) in crop.iter().enumerate() { ref_emb[i] += v; }
    }
    let n = ref_crops.len() as f32;
    for v in &mut ref_emb { *v /= n; }
    let norm: f32 = ref_emb.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 { for v in &mut ref_emb { *v /= norm; } }

    SearchResults {
        results: search(cache, &ref_emb, input.k, input.threshold, Some(&input.pano_id),
            |cos| cos),
    }
}

pub fn image_search(input: &ImageSearchInput, cache_dir: &str) -> SearchResults {
    image_search_in(&EmbedCache::load(cache_dir), input)
}

#[cfg(test)]
#[path = "search.test.rs"]
mod tests;
