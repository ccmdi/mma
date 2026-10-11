use super::*;
use crate::embed::{EmbedCache, EMBED_DIM, NUM_CROPS};

/// Unit vector in the plane of dims 0/1.
fn unit(x: f32, y: f32) -> [f32; EMBED_DIM] {
    let n = (x * x + y * y).sqrt();
    let mut e = [0f32; EMBED_DIM];
    e[0] = x / n;
    e[1] = y / n;
    e
}

fn crops(e: [f32; EMBED_DIM]) -> Vec<[f32; EMBED_DIM]> {
    vec![e; NUM_CROPS]
}

fn temp_cache_dir(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("mma_vision_serve_test_{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.to_string_lossy().into_owned()
}

fn save_cache(dir: &str, panos: &[(&str, [f32; EMBED_DIM])]) {
    let mut cache = EmbedCache::default();
    for (id, e) in panos {
        cache.entries.insert((*id).to_string(), crops(*e));
    }
    cache.save(dir);
}

fn result_ids(body: &str) -> Vec<String> {
    let v: serde_json::Value = serde_json::from_str(body).unwrap();
    v["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["panoId"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn ping_and_unknown_routes() {
    let cd = temp_cache_dir("ping");
    let mut s = ServeState::new("unused-model-dir", &cd);
    assert_eq!(s.handle("GET", "/ping", ""), (200, r#"{"ok":true}"#.into()));
    assert_eq!(s.handle("GET", "/nope", "").0, 404);
    assert_eq!(s.handle("POST", "/search-image", "{not json").0, 400);
}

#[test]
fn search_image_orders_and_excludes_query() {
    let cd = temp_cache_dir("image");
    save_cache(
        &cd,
        &[
            ("q", unit(1.0, 0.0)),
            ("close", unit(0.8, 0.6)),
            ("far", unit(0.0, 1.0)),
        ],
    );
    let mut s = ServeState::new("unused-model-dir", &cd);
    let (status, body) = s.handle("POST", "/search-image", r#"{"panoId":"q"}"#);
    assert_eq!(status, 200);
    assert_eq!(result_ids(&body), vec!["close", "far"]);
}

#[test]
fn cache_reloads_when_file_changes() {
    let cd = temp_cache_dir("reload");
    save_cache(&cd, &[("q", unit(1.0, 0.0)), ("far", unit(0.0, 1.0))]);
    let baseline = crate::embed::cache_mtime(&cd).expect("initial cache was written");
    let cache_file = std::path::Path::new(&cd).join("embeddings_v6.bin");
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(&cache_file)
        .unwrap();
    file.set_modified(baseline - std::time::Duration::from_secs(60))
        .unwrap();
    drop(file);
    let baseline = crate::embed::cache_mtime(&cd).expect("cache timestamp was set");
    let mut s = ServeState::new("unused-model-dir", &cd);
    let (_, body) = s.handle("POST", "/search-image", r#"{"panoId":"q"}"#);
    assert_eq!(result_ids(&body).len(), 1);

    save_cache(
        &cd,
        &[
            ("q", unit(1.0, 0.0)),
            ("close", unit(0.8, 0.6)),
            ("far", unit(0.0, 1.0)),
        ],
    );
    assert_ne!(crate::embed::cache_mtime(&cd), Some(baseline));
    let (_, body) = s.handle("POST", "/search-image", r#"{"panoId":"q"}"#);
    assert_eq!(result_ids(&body).len(), 2);
}
