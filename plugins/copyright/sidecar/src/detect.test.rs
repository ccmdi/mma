use super::*;

fn win(year_idx: usize, p: f32) -> [f32; NUM_CLASSES] {
    let mut w = [0.0f32; NUM_CLASSES];
    w[0] = 0.01;
    w[year_idx] = p;
    w
}

#[test]
fn luma601_matches_pil_fixed_point() {
    assert_eq!(luma601(0, 0, 0), 0);
    assert_eq!(luma601(255, 255, 255), 255);
    // pure channels: PIL (R*19595+G*38470+B*7471+0x8000)>>16
    assert_eq!(luma601(255, 0, 0), 76);
    assert_eq!(luma601(0, 255, 0), 150);
    assert_eq!(luma601(0, 0, 255), 29);
}

#[test]
fn year_of_maps_class_indices() {
    assert_eq!(year_of(1), 2017);
    assert_eq!(year_of(2), 2018);
    assert_eq!(year_of(10), 2026);
}

#[test]
fn classes_table_is_none_then_years() {
    assert_eq!(CLASSES.len(), NUM_CLASSES);
    assert_eq!(CLASSES[0], "none");
    assert_eq!(CLASSES[1], "2017");
    assert_eq!(CLASSES[10], "2026");
}

#[test]
fn softmax_sums_to_one_and_peaks_at_argmax() {
    let mut logits = [0.0f32; NUM_CLASSES];
    logits[3] = 5.0;
    let p = softmax(&logits);
    let sum: f32 = p.iter().sum();
    assert!((sum - 1.0).abs() < 1e-5);
    let amax = (0..NUM_CLASSES).max_by(|&a, &b| p[a].partial_cmp(&p[b]).unwrap()).unwrap();
    assert_eq!(amax, 3);
}

#[test]
fn tier_a_fires_on_two_votes() {
    let probs = vec![win(2, 0.6), win(2, 0.7), win(5, 0.55)];
    assert_eq!(tier_a_vote(&probs, 1), Some(2018));
}

#[test]
fn tier_a_fires_on_solo_threshold() {
    // single window, one class above solo_thresh (0.9)
    let probs = vec![win(3, 0.95)];
    assert_eq!(tier_a_vote(&probs, 1), Some(2019));
}

#[test]
fn tier_a_falls_through_without_votes_or_solo() {
    // single mid-confidence window: one vote, solo below 0.9
    assert_eq!(tier_a_vote(&[win(4, 0.6)], 1), None);
    // nothing above thresh at all
    assert_eq!(tier_a_vote(&[win(4, 0.4)], 1), None);
    assert_eq!(tier_a_vote(&[], 1), None);
}

#[test]
fn tier_a_picks_year_with_most_votes() {
    let probs = vec![win(2, 0.6), win(5, 0.9), win(5, 0.8)];
    assert_eq!(tier_a_vote(&probs, 1), Some(2021));
}

#[test]
fn tier_b_requires_two_votes() {
    assert_eq!(tier_b_vote(&[win(2, 0.6)], 1), None);
    assert_eq!(tier_b_vote(&[win(2, 0.6), win(2, 0.7)], 1), Some(2018));
}

#[test]
fn tier_b_skips_none_predictions_and_low_conf() {
    // pred==none (year prob below the 0.01 none floor) is skipped
    let mut none_win = [0.0f32; NUM_CLASSES];
    none_win[0] = 0.9;
    none_win[6] = 0.05;
    assert_eq!(tier_b_vote(&[none_win, none_win], 1), None);
    // year predicted but below thresh -> skipped
    assert_eq!(tier_b_vote(&[win(6, 0.4), win(6, 0.45)], 1), None);
}

#[test]
fn class_floor_maps_min_year_to_first_allowed_index() {
    assert_eq!(class_floor(None), 1);
    assert_eq!(class_floor(Some(2016)), 1);
    assert_eq!(class_floor(Some(2017)), 1);
    assert_eq!(class_floor(Some(2018)), 2);
    assert_eq!(class_floor(Some(2026)), 10);
    assert_eq!(class_floor(Some(2027)), NUM_CLASSES);
}

#[test]
fn vote_floor_excludes_years_below_capture() {
    // strong 2018 votes, capture year 2021 (floor 5): 2018 is a misread, not a fact
    let probs = vec![win(2, 0.9), win(2, 0.9)];
    assert_eq!(tier_a_vote(&probs, 1), Some(2018));
    assert_eq!(tier_a_vote(&probs, 5), None);
    assert_eq!(tier_b_vote(&probs, 1), Some(2018));
    assert_eq!(tier_b_vote(&probs, 5), None);
    // floor past the last year never fires
    assert_eq!(tier_a_vote(&probs, NUM_CLASSES), None);
}

#[test]
fn vote_floor_picks_next_best_allowed_year() {
    // windows where 2018 peaks but an allowed 2022 is also above thresh
    let mut w = [0.0f32; NUM_CLASSES];
    w[2] = 0.55;
    w[6] = 0.52;
    assert_eq!(tier_a_vote(&[w, w], 1), Some(2018));
    assert_eq!(tier_a_vote(&[w, w], 5), Some(2022));
    assert_eq!(tier_b_vote(&[w, w], 5), Some(2022));
}

fn jpeg_bytes(luma: u8, size: u32) -> Vec<u8> {
    let img = image::RgbImage::from_pixel(size, size, image::Rgb([luma, luma, luma]));
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut buf, image::ImageFormat::Jpeg)
        .unwrap();
    buf.into_inner()
}

#[test]
fn decode_gray_rejects_black_dead_tiles_only() {
    // uniform black = dead coverage
    assert!(decode_gray(&jpeg_bytes(0, TILE as u32)).is_none());
    // bright near-flat (hazy scene) is alive even below the std floor
    assert!(decode_gray(&jpeg_bytes(200, TILE as u32)).is_some());
    // wrong dimensions still rejected
    assert!(decode_gray(&jpeg_bytes(200, 256)).is_none());
}

#[test]
fn fallback_profile_is_valid() {
    let cells = fallback_profile();
    assert!(cells.iter().any(|c| c.primary), "at least one primary cell");
    for c in &cells {
        assert!(c.x < 16 && (c.y == 6 || c.y == 7), "cell ({},{}) outside z4 nadir band", c.x, c.y);
        assert!(!c.boxes.is_empty());
        for &(x0, y0, w, h) in &c.boxes {
            assert!(w > 0 && h > 0 && x0 + w <= TILE && y0 + h <= TILE,
                "box ({x0},{y0},{w},{h}) exceeds tile bounds");
        }
    }
}

#[test]
fn load_profile_falls_back_when_file_absent() {
    let cells = load_profile("nonexistent-dir");
    assert_eq!(cells.len(), fallback_profile().len());
}

#[test]
fn ncc_output_dims_are_valid_region() {
    assert_eq!(OH, TILE - TH + 1);
    assert_eq!(OW, TILE - TW + 1);
    assert_eq!(OH, 494);
    assert_eq!(OW, 389);
}

#[test]
fn gaussian_blur_of_flat_is_flat() {
    let flat = vec![120u8; TILE * TILE];
    let blur = gaussian_blur_u8(&flat);
    assert!(blur.iter().all(|&v| v == 120));
    // high-pass of a flat plane is ~zero
    let h = high_pass(&flat);
    assert!(h.iter().all(|&v| v.abs() < 1e-6));
}

#[test]
fn top6_returns_six_largest() {
    let mut ncc = vec![0f64; OH * OW];
    // plant six ascending peaks at known flat indices
    let spots = [(0usize, 0usize), (1, 1), (2, 2), (3, 3), (4, 4), (5, 5)];
    for (k, &(y, x)) in spots.iter().enumerate() {
        ncc[y * OW + x] = 10.0 + k as f64;
    }
    let peaks = top6(&ncc);
    assert_eq!(peaks.len(), 6);
    // every planted (x,y) must be present as a window top-left
    for &(y, x) in &spots {
        assert!(peaks.iter().any(|&(_, px, py)| px == x && py == y));
    }
}

#[test]
fn official_pano_regex_accepts_valid_ids() {
    let prefix = "a".repeat(21);
    for suffix in ["A", "Q", "g", "w"] {
        assert!(is_official_pano(&format!("{prefix}{suffix}")));
    }
}

#[test]
fn official_pano_regex_rejects_wrong_length() {
    assert!(!is_official_pano("tooshort"));
    let too_long = format!("{}A", "a".repeat(22));
    assert!(!is_official_pano(&too_long));
    let too_short = format!("{}A", "a".repeat(20));
    assert!(!is_official_pano(&too_short));
}

#[test]
fn official_pano_regex_rejects_wrong_suffix() {
    let id = format!("{}Z", "a".repeat(21));
    assert!(!is_official_pano(&id));
}

#[test]
fn bundled_template_has_expected_size() {
    // models/ is an exported artifact, absent in fresh clones
    let model_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/models");
    if !std::path::Path::new(model_dir).join("wm_template.bin").exists() {
        eprintln!("skipping: no models/ present");
        return;
    }
    assert_eq!(load_template(model_dir).len(), TH * TW);
}

#[test]
fn bundled_model_class_count_is_eleven() {
    let model_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/models");
    if !std::path::Path::new(model_dir).join("wm_cls.onnx").exists() {
        eprintln!("skipping: no models/ present");
        return;
    }
    let mut session = load_session(model_dir);
    assert_eq!(wm_num_classes(&mut session), Some(NUM_CLASSES));
}
