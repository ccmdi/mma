use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct SubdivisionGolden {
    country: String,
    available: Vec<String>,
    cases: Vec<SubdivisionCase>,
}

#[derive(Deserialize)]
struct SubdivisionCase {
    goal: i32,
    min_min: i32,
    global: Option<String>,
    country_filter: Option<String>,
    sub_filter: Option<String>,
    defaults: bool,
    custom: Option<serde_json::Map<String, serde_json::Value>>,
    region_goal: i32,
    min_distance: i32,
    node_ids: Vec<i64>,
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

#[test]
fn subdivision_distribution_matches_oracle() {
    let golden_path = fixture("ru-al.subdivision.json");
    let golden: SubdivisionGolden = serde_json::from_slice(
        &std::fs::read(&golden_path)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", golden_path.display())),
    )
    .expect("parse subdivision golden");

    let locations = vali_data::decode_file(&fixture("ru-al-1000.bin")).expect("decode fixture bin");
    assert!(!golden.cases.is_empty(), "golden had no cases");

    let available: Vec<&str> = vali_generate::weights::subdivision_weights(&golden.country)
        .map(|subs| {
            subs.iter()
                .filter(|(_, w)| *w > 0)
                .map(|(code, _)| *code)
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(
        available,
        golden
            .available
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        "available subdivisions differ from oracle for {}",
        golden.country
    );

    let mut failures: Vec<String> = Vec::new();

    for (ci, case) in golden.cases.iter().enumerate() {
        let merged = vali_generate::merge_location_filters(&[
            case.global.as_deref(),
            case.country_filter.as_deref(),
            case.sub_filter.as_deref(),
        ]);
        let custom: Option<Vec<(String, i32)>> = case.custom.as_ref().map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), v.as_i64().unwrap() as i32))
                .collect()
        });
        let result = vali_generate::subdivision_by_max_min_distance(
            &locations,
            &golden.country,
            case.goal,
            &available,
            merged.as_deref(),
            None,
            None,
            None,
            &[],
            &[],
            &Default::default(),
            custom.as_deref(),
            case.defaults,
            case.min_min,
            true,
        );
        let result = match result {
            Ok(r) => r,
            Err(e) => {
                failures.push(format!("case {ci}: compile error {e}"));
                continue;
            }
        };
        let node_ids: Vec<i64> = result
            .indices
            .iter()
            .map(|&i| locations[i as usize].node_id)
            .collect();

        let mut errors: Vec<String> = Vec::new();
        if result.region_goal_count != case.region_goal {
            errors.push(format!(
                "region_goal {} != {}",
                result.region_goal_count, case.region_goal
            ));
        }
        if result.min_distance != case.min_distance {
            errors.push(format!(
                "min_distance {} != {}",
                result.min_distance, case.min_distance
            ));
        }
        if node_ids != case.node_ids {
            let first = node_ids
                .iter()
                .zip(&case.node_ids)
                .position(|(a, b)| a != b);
            errors.push(format!(
                "node_ids differ (len {} vs {}, first divergence {:?})",
                node_ids.len(),
                case.node_ids.len(),
                first
            ));
        }
        if !errors.is_empty() {
            failures.push(format!(
                "case {ci} (goal={}, min_min={}): {}",
                case.goal,
                case.min_min,
                errors.join("; ")
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{}/{} subdivision cases diverged from the oracle:\n{}",
        failures.len(),
        golden.cases.len(),
        failures.join("\n")
    );
}
