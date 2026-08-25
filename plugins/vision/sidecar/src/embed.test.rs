use super::*;

fn tmp_dir(tag: &str) -> String {
    let mut p = std::env::temp_dir();
    let uniq = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    p.push(format!("mma_vision_test_{tag}_{uniq}"));
    std::fs::create_dir_all(&p).unwrap();
    p.to_string_lossy().to_string()
}

#[test]
fn cache_roundtrips_entries() {
    let dir = tmp_dir("rt");
    let mut cache = EmbedCache::default();
    let crops = vec![[0.5f32; EMBED_DIM]; NUM_CROPS];
    cache.entries.insert("pano_a".into(), crops.clone());
    cache.save(&dir);

    let loaded = EmbedCache::load(&dir);
    assert_eq!(loaded.entries.len(), 1);
    assert_eq!(loaded.entries.get("pano_a").unwrap(), &crops);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn cache_rejects_wrong_version() {
    let dir = tmp_dir("ver");
    let p = Path::new(&dir).join(CACHE_FILE);
    // header with a stale version number, no entries
    fs::write(&p, 5u32.to_le_bytes()).unwrap();
    let loaded = EmbedCache::load(&dir);
    assert!(loaded.entries.is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn cache_dims_are_siglip() {
    assert_eq!(EMBED_DIM, 768);
    assert_eq!(CACHE_VERSION, 6);
    assert_eq!(NUM_CROPS, 4);
}

#[test]
fn canonicalize_folds_case_punctuation_and_whitespace() {
    assert_eq!(canonicalize_text("White Car"), canonicalize_text("white car"));
    assert_eq!(canonicalize_text("A Map."), "a map");
    assert_eq!(canonicalize_text("  snow,   indoor!  "), "snow indoor");
    // SigLIP deletes punctuation rather than splitting on it.
    assert_eq!(canonicalize_text("snow-covered"), "snowcovered");
    assert_eq!(canonicalize_text("Ålesund"), "ålesund");
}
