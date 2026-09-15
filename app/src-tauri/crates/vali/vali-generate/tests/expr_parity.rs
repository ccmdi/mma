use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct ExprGolden {
    locations: Vec<vali_core::Location>,
    bool_results: Vec<ExprResult>,
    int_results: Vec<ExprResult>,
}

#[derive(Deserialize)]
struct ExprResult {
    expr: String,
    status: String,
    #[serde(default)]
    bits: Option<String>,
    #[serde(default)]
    values: Option<Vec<i32>>,
    #[serde(default)]
    error_index: Option<usize>,
    #[serde(default)]
    message: Option<String>,
}

#[test]
fn expression_semantics_match_oracle() {
    let path: PathBuf =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ru-al.expr.json");
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|e| panic!("cannot read golden fixture {}: {e}", path.display()));
    let golden: ExprGolden = serde_json::from_slice(&bytes).expect("parse expr golden");

    let locs = &golden.locations;
    assert!(!locs.is_empty(), "golden fixture had no locations");
    assert!(
        !golden.bool_results.is_empty() && !golden.int_results.is_empty(),
        "golden fixture had no expression rows"
    );

    let mut failures: Vec<String> = Vec::new();

    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));

    for row in &golden.bool_results {
        let compiled = vali_expr::compile_bool(&row.expr);
        match (row.status.as_str(), compiled) {
            ("compile_error", Err(_)) => {}
            ("compile_error", Ok(_)) => failures.push(format!(
                "bool `{}`: compiled OK but C# failed with: {}",
                row.expr,
                row.message.as_deref().unwrap_or("?")
            )),
            (_, Err(e)) => failures.push(format!(
                "bool `{}`: failed to compile ({e}) but C# status={}",
                row.expr, row.status
            )),
            ("ok", Ok(f)) => {
                let expected = row.bits.as_deref().unwrap_or("");
                let mut got = String::with_capacity(locs.len());
                let mut panicked: Option<usize> = None;
                for (i, loc) in locs.iter().enumerate() {
                    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.eval(loc))) {
                        Ok(b) => got.push(if b { '1' } else { '0' }),
                        Err(_) => {
                            panicked = Some(i);
                            break;
                        }
                    }
                }
                if let Some(i) = panicked {
                    failures.push(format!(
                        "bool `{}`: panicked at location {i} but C# evaluated all",
                        row.expr
                    ));
                } else if got != expected {
                    let diff = got.bytes().zip(expected.bytes()).position(|(a, b)| a != b);
                    failures.push(format!(
                        "bool `{}`: bits differ (first divergence at location {:?})",
                        row.expr, diff
                    ));
                }
            }
            ("runtime_error", Ok(f)) => {
                let expected_index = row.error_index.unwrap_or(usize::MAX);
                let mut panicked: Option<usize> = None;
                for (i, loc) in locs.iter().enumerate() {
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.eval(loc)))
                        .is_err()
                    {
                        panicked = Some(i);
                        break;
                    }
                }
                if panicked != Some(expected_index) {
                    failures.push(format!(
                        "bool `{}`: runtime error at {:?}, C# at {} ({})",
                        row.expr,
                        panicked,
                        expected_index,
                        row.message.as_deref().unwrap_or("?")
                    ));
                }
            }
            (other, _) => failures.push(format!(
                "bool `{}`: unknown golden status {other}",
                row.expr
            )),
        }
    }

    for row in &golden.int_results {
        let compiled = vali_expr::compile_int(&row.expr);
        match (row.status.as_str(), compiled) {
            ("compile_error", Err(_)) => {}
            ("compile_error", Ok(_)) => failures.push(format!(
                "int `{}`: compiled OK but C# failed with: {}",
                row.expr,
                row.message.as_deref().unwrap_or("?")
            )),
            (_, Err(e)) => failures.push(format!(
                "int `{}`: failed to compile ({e}) but C# status={}",
                row.expr, row.status
            )),
            ("ok", Ok(f)) => {
                let expected = row.values.as_deref().unwrap_or(&[]);
                let mut got: Vec<i32> = Vec::with_capacity(locs.len());
                let mut panicked: Option<usize> = None;
                for (i, loc) in locs.iter().enumerate() {
                    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.eval(loc))) {
                        Ok(v) => got.push(v),
                        Err(_) => {
                            panicked = Some(i);
                            break;
                        }
                    }
                }
                if let Some(i) = panicked {
                    failures.push(format!(
                        "int `{}`: panicked at location {i} but C# evaluated all",
                        row.expr
                    ));
                } else if got != expected {
                    let diff = got.iter().zip(expected).position(|(a, b)| a != b);
                    failures.push(format!(
                        "int `{}`: values differ (first divergence at {:?})",
                        row.expr, diff
                    ));
                }
            }
            ("runtime_error", Ok(f)) => {
                let expected_index = row.error_index.unwrap_or(usize::MAX);
                let mut panicked: Option<usize> = None;
                for (i, loc) in locs.iter().enumerate() {
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f.eval(loc)))
                        .is_err()
                    {
                        panicked = Some(i);
                        break;
                    }
                }
                if panicked != Some(expected_index) {
                    failures.push(format!(
                        "int `{}`: runtime error at {:?}, C# at {}",
                        row.expr, panicked, expected_index
                    ));
                }
            }
            (other, _) => {
                failures.push(format!("int `{}`: unknown golden status {other}", row.expr))
            }
        }
    }

    std::panic::set_hook(default_hook);

    assert!(
        failures.is_empty(),
        "{}/{} expression rows diverged from the oracle:\n{}",
        failures.len(),
        golden.bool_results.len() + golden.int_results.len(),
        failures.join("\n")
    );
}
