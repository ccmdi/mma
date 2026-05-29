//! Tests for the selection disambiguation engine. These exercise the pure
//! `compute_divergence` path and the statistical/labeling helpers — no store needed.

use super::*;
use crate::map_meta::{ComparisonType, ExtraFieldDef, ExtraFieldType};
use crate::types::Location;
use serde_json::json;
use std::collections::HashMap;

fn loc(heading: f64, extra: serde_json::Value, tags: Vec<u32>) -> Location {
    Location {
        id: 0,
        lat: 0.0,
        lng: 0.0,
        heading,
        pitch: 0.0,
        zoom: 0.0,
        pano_id: None,
        flags: 0,
        tags,
        extra: extra.as_object().cloned(),
        created_at: String::new(),
        modified_at: None,
    }
}

fn number_def() -> ExtraFieldDef {
    ExtraFieldDef { field_type: ExtraFieldType::Number, label: None, values: None, labels: None, comparison: None }
}

fn defs(pairs: &[(&str, ExtraFieldDef)]) -> HashMap<String, ExtraFieldDef> {
    pairs.iter().map(|(k, d)| (k.to_string(), d.clone())).collect()
}

fn find<'a>(r: &'a DisambiguateResult, key: &str) -> &'a FieldDivergence {
    r.fields.iter().find(|f| f.key == key).unwrap_or_else(|| panic!("field {key} not found"))
}

/// Build labeled locations: `groups[g]` is the list of locations for group g.
fn labeled(groups: Vec<Vec<Location>>) -> Vec<(usize, Location)> {
    let mut out = Vec::new();
    for (g, locs) in groups.into_iter().enumerate() {
        for l in locs {
            out.push((g, l));
        }
    }
    out
}

// --- Numeric (linear) -------------------------------------------------------

#[test]
fn separated_numeric_scores_high() {
    let a: Vec<Location> = (0..12).map(|i| loc(0.0, json!({ "alt": i as f64 }), vec![])).collect();
    let b: Vec<Location> = (0..12).map(|i| loc(0.0, json!({ "alt": 1000.0 + i as f64 }), vec![])).collect();
    let r = compute_divergence(&labeled(vec![a, b]), 2, &defs(&[("alt", number_def())]), &HashMap::new());
    let f = find(&r, "alt");
    assert!(matches!(f.comparison, ComparisonType::Linear));
    assert!(f.value_score.unwrap() > 0.8, "got {:?}", f.value_score);
    assert!(!f.low_confidence);
}

#[test]
fn overlapping_numeric_scores_low() {
    let a: Vec<Location> = (0..12).map(|i| loc(0.0, json!({ "alt": (i % 10) as f64 }), vec![])).collect();
    let b: Vec<Location> = (0..12).map(|i| loc(0.0, json!({ "alt": (i % 10) as f64 }), vec![])).collect();
    let r = compute_divergence(&labeled(vec![a, b]), 2, &defs(&[("alt", number_def())]), &HashMap::new());
    assert!(find(&r, "alt").value_score.unwrap() < 0.15);
}

#[test]
fn ranking_puts_most_separating_field_first() {
    // alt cleanly separates; noise is identical across groups.
    let a: Vec<Location> = (0..12).map(|i| loc(0.0, json!({ "alt": i as f64, "noise": (i % 3) as f64 }), vec![])).collect();
    let b: Vec<Location> = (0..12).map(|i| loc(0.0, json!({ "alt": 1000.0 + i as f64, "noise": (i % 3) as f64 }), vec![])).collect();
    let r = compute_divergence(&labeled(vec![a, b]), 2, &defs(&[("alt", number_def()), ("noise", number_def())]), &HashMap::new());
    assert_eq!(r.fields[0].key, "alt");
}

// --- Categorical ------------------------------------------------------------

#[test]
fn separated_categorical_scores_high() {
    let a: Vec<Location> = (0..12).map(|_| loc(0.0, json!({ "cc": "US" }), vec![])).collect();
    let b: Vec<Location> = (0..12).map(|_| loc(0.0, json!({ "cc": "FR" }), vec![])).collect();
    let cc = ExtraFieldDef { field_type: ExtraFieldType::String, label: None, values: None, labels: None, comparison: None };
    let r = compute_divergence(&labeled(vec![a, b]), 2, &defs(&[("cc", cc)]), &HashMap::new());
    let f = find(&r, "cc");
    assert!(matches!(f.comparison, ComparisonType::Categorical));
    assert!(f.value_score.unwrap() > 0.8, "got {:?}", f.value_score);
}

#[test]
fn shared_dominant_value_scores_low() {
    // Both groups are mostly "gen2" — a common modal value that does NOT separate them.
    let mk = |_| loc(0.0, json!({ "cam": "gen2" }), vec![]);
    let a: Vec<Location> = (0..12).map(mk).collect();
    let b: Vec<Location> = (0..12).map(mk).collect();
    let cam = ExtraFieldDef { field_type: ExtraFieldType::Enum, label: None, values: None, labels: None, comparison: None };
    let r = compute_divergence(&labeled(vec![a, b]), 2, &defs(&[("cam", cam)]), &HashMap::new());
    assert!(find(&r, "cam").value_score.unwrap() < 0.15);
}

// --- Circular ---------------------------------------------------------------

#[test]
fn circular_treats_wraparound_as_close() {
    // Group A ~350deg, group B ~10deg: only ~20deg apart across the 0/360 seam.
    let a: Vec<Location> = (0..12).map(|i| loc(348.0 + (i % 5) as f64, json!({}), vec![])).collect();
    let b: Vec<Location> = (0..12).map(|i| loc(8.0 + (i % 5) as f64, json!({}), vec![])).collect();
    let lab = labeled(vec![a, b]);
    let r = compute_divergence(&lab, 2, &HashMap::new(), &HashMap::new());
    let f = find(&r, "heading");
    assert!(matches!(f.comparison, ComparisonType::Circular { period } if period == 360.0));
    let circular = f.value_score.unwrap();
    assert!(circular < 0.3, "circular score should be low, got {circular}");

    // A naive LINEAR metric on the same data would rank these as far apart.
    let mut per_group = vec![Vec::new(), Vec::new()];
    for (g, l) in &lab {
        per_group[*g].push(l.heading);
    }
    let linear = kruskal_eps2(&per_group).unwrap();
    assert!(linear > 0.7, "linear metric should be high (proves circular differs), got {linear}");
}

#[test]
fn circular_opposite_directions_score_high() {
    let a: Vec<Location> = (0..12).map(|i| loc((i % 5) as f64, json!({}), vec![])).collect();
    let b: Vec<Location> = (0..12).map(|i| loc(178.0 + (i % 5) as f64, json!({}), vec![])).collect();
    let r = compute_divergence(&labeled(vec![a, b]), 2, &HashMap::new(), &HashMap::new());
    assert!(find(&r, "heading").value_score.unwrap() > 0.8);
}

// --- Coverage & missing data ------------------------------------------------

#[test]
fn coverage_asymmetry_is_flagged() {
    // alt present in group A, entirely absent in group B.
    let a: Vec<Location> = (0..12).map(|i| loc(0.0, json!({ "alt": i as f64 }), vec![])).collect();
    let b: Vec<Location> = (0..12).map(|_| loc(0.0, json!({}), vec![])).collect();
    let r = compute_divergence(&labeled(vec![a, b]), 2, &defs(&[("alt", number_def())]), &HashMap::new());
    let f = find(&r, "alt");
    assert!(f.coverage_score > 0.8, "coverage should be high, got {}", f.coverage_score);
    // Only one group has values -> no value comparison possible.
    assert!(f.value_score.is_none());
}

#[test]
fn missing_values_not_treated_as_zero() {
    // Both groups share the same present value (5); group B is mostly absent.
    // If absent were treated as 0, B would look very different -> high score (WRONG).
    let a: Vec<Location> = (0..12).map(|_| loc(0.0, json!({ "alt": 5.0 }), vec![])).collect();
    let mut b: Vec<Location> = (0..3).map(|_| loc(0.0, json!({ "alt": 5.0 }), vec![])).collect();
    b.extend((0..9).map(|_| loc(0.0, json!({}), vec![])));
    let r = compute_divergence(&labeled(vec![a, b]), 2, &defs(&[("alt", number_def())]), &HashMap::new());
    let f = find(&r, "alt");
    assert!(f.value_score.unwrap() < 0.15, "shared present value must not fabricate separation, got {:?}", f.value_score);
    assert!(f.low_confidence, "group B has < MIN_PRESENT present values");
    assert!(f.coverage_score > 0.5, "coverage difference IS the real signal here");
}

// --- Tags -------------------------------------------------------------------

#[test]
fn discriminating_tag_scores_high() {
    let a: Vec<Location> = (0..12).map(|_| loc(0.0, json!({}), vec![7])).collect();
    let b: Vec<Location> = (0..12).map(|_| loc(0.0, json!({}), vec![])).collect();
    let names: HashMap<u32, String> = [(7u32, "Verified".to_string())].into_iter().collect();
    let r = compute_divergence(&labeled(vec![a, b]), 2, &HashMap::new(), &names);
    let f = find(&r, "tag:7");
    assert_eq!(f.label, "Verified");
    assert!(f.value_score.unwrap() > 0.8);
    // Tags are always present -> no coverage asymmetry.
    assert!(f.coverage_score < 1e-9);
}

// --- Excluded fields & labeling ---------------------------------------------

#[test]
fn spatial_and_timestamp_fields_never_analyzed() {
    let a = vec![loc(0.0, json!({}), vec![]); 4];
    let b = vec![loc(0.0, json!({}), vec![]); 4];
    let r = compute_divergence(&labeled(vec![a, b]), 2, &HashMap::new(), &HashMap::new());
    for bad in ["lat", "lng", "createdAt", "modifiedAt"] {
        assert!(!r.fields.iter().any(|f| f.key == bad), "{bad} must not be analyzed");
    }
}

#[test]
fn group_sizes_reflect_labels() {
    let a = vec![loc(0.0, json!({}), vec![]); 5];
    let b = vec![loc(0.0, json!({}), vec![]); 3];
    let r = compute_divergence(&labeled(vec![a, b]), 2, &HashMap::new(), &HashMap::new());
    assert_eq!(r.group_sizes, vec![5, 3]);
}

#[test]
fn sole_group_detects_overlap() {
    // row 0: only group 0; row 1: groups 0 and 1 (overlap); row 2: none.
    let masks = vec![
        vec![true, true, false],
        vec![false, true, false],
    ];
    assert_eq!(sole_group(&masks, 0), Ok(Some(0)));
    assert_eq!(sole_group(&masks, 1), Err(()));
    assert_eq!(sole_group(&masks, 2), Ok(None));
}

// --- Undeclared field inference ---------------------------------------------

#[test]
fn undeclared_numeric_field_treated_as_linear() {
    // No field def passed; values are numbers -> must be inferred Linear, not Categorical.
    let a: Vec<Location> = (0..12).map(|i| loc(0.0, json!({ "mystery": i as f64 }), vec![])).collect();
    let b: Vec<Location> = (0..12).map(|i| loc(0.0, json!({ "mystery": 1000.0 + i as f64 }), vec![])).collect();
    let r = compute_divergence(&labeled(vec![a, b]), 2, &HashMap::new(), &HashMap::new());
    let f = find(&r, "mystery");
    assert!(matches!(f.comparison, ComparisonType::Linear));
    assert!(f.value_score.unwrap() > 0.8);
}
