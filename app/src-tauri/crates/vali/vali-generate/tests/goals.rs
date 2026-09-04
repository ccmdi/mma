use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Deserialize)]
struct GoalsGolden {
    subdivision_goals: Vec<SubdivisionGoalCase>,
    country_goals: Vec<CountryGoalCase>,
    custom_subdivision_goals: Vec<CustomGoalCase>,
}

#[derive(Deserialize)]
struct SubdivisionGoalCase {
    country: String,
    goal: i32,
    available: Option<Vec<String>>,
    goals: serde_json::Map<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct CountryGoalCase {
    distribution: serde_json::Map<String, serde_json::Value>,
    goal: i32,
    results: serde_json::Map<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct CustomGoalCase {
    weights: serde_json::Map<String, serde_json::Value>,
    goal: i32,
    results: serde_json::Map<String, serde_json::Value>,
}

fn golden() -> &'static GoalsGolden {
    static GOLDEN: OnceLock<GoalsGolden> = OnceLock::new();
    GOLDEN.get_or_init(|| {
        let path: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/goals.json");
        let bytes = std::fs::read(&path)
            .unwrap_or_else(|e| panic!("cannot read golden fixture {}: {e}", path.display()));
        serde_json::from_slice(&bytes).expect("parse goals golden")
    })
}

fn as_i32(v: &serde_json::Value) -> i32 {
    v.as_i64().unwrap() as i32
}

#[test]
fn subdivision_goals_match_oracle() {
    let mut failures = Vec::new();
    let mut checked = 0usize;
    for case in &golden().subdivision_goals {
        let available: Option<Vec<&str>> = case
            .available
            .as_ref()
            .map(|a| a.iter().map(|s| s.as_str()).collect());
        for (sub, expected) in &case.goals {
            checked += 1;
            let got = vali_generate::goal_for_subdivision(
                &case.country,
                sub,
                case.goal,
                available.as_deref(),
            );
            if got != as_i32(expected)
                && failures.len() < 10 {
                    failures.push(format!(
                        "{} {} goal={} available={:?}: {} != {}",
                        case.country,
                        sub,
                        case.goal,
                        case.available,
                        got,
                        as_i32(expected)
                    ));
                }
        }
    }
    assert!(checked > 0, "golden fixture had no subdivision goal cases");
    assert!(
        failures.is_empty(),
        "{}/{checked} subdivision goals mismatched:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn country_goals_match_oracle() {
    let mut failures = Vec::new();
    let mut checked = 0usize;
    for case in &golden().country_goals {
        let distribution: Vec<(String, i32)> = case
            .distribution
            .iter()
            .map(|(k, v)| (k.clone(), as_i32(v)))
            .collect();
        for (cc, expected) in &case.results {
            checked += 1;
            let got = vali_generate::country_location_count_goal(&distribution, case.goal, cc);
            if got != as_i32(expected) && failures.len() < 10 {
                failures.push(format!(
                    "{cc} goal={}: {} != {}",
                    case.goal,
                    got,
                    as_i32(expected)
                ));
            }
        }
    }
    assert!(checked > 0, "golden fixture had no country goal cases");
    assert!(
        failures.is_empty(),
        "{}/{checked} country goals mismatched:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn custom_subdivision_goals_match_oracle() {
    let mut failures = Vec::new();
    let mut checked = 0usize;
    for case in &golden().custom_subdivision_goals {
        let weights: Vec<(String, i32)> = case
            .weights
            .iter()
            .map(|(k, v)| (k.clone(), as_i32(v)))
            .collect();
        for (sub, expected) in &case.results {
            checked += 1;
            let got = vali_generate::subdivision_goal_from_custom_weights(&weights, sub, case.goal);
            if got != as_i32(expected) && failures.len() < 10 {
                failures.push(format!(
                    "{sub} goal={}: {} != {}",
                    case.goal,
                    got,
                    as_i32(expected)
                ));
            }
        }
    }
    assert!(
        checked > 0,
        "golden fixture had no custom subdivision goal cases"
    );
    assert!(
        failures.is_empty(),
        "{}/{checked} custom subdivision goals mismatched:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
