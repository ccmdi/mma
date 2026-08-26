use super::*;
use std::collections::HashMap;

fn row(pairs: &[(&str, f64)]) -> HashMap<String, f64> {
    pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

fn run(src: &str, fields: &HashMap<String, f64>) -> Option<f64> {
    eval(&parse(src).unwrap(), &|k| fields.get(k).copied())
}

#[test]
fn constants_and_arithmetic_follow_precedence() {
    let none = row(&[]);
    assert_eq!(run("1 + 2 * 3", &none), Some(7.0));
    assert_eq!(run("(1 + 2) * 3", &none), Some(9.0));
    assert_eq!(run("-4 + 10", &none), Some(6.0));
    assert_eq!(run("10 % 4", &none), Some(2.0));
    assert_eq!(run("7 / 2", &none), Some(3.5));
    assert_eq!(run(".5 + 1", &none), Some(1.5));
}

#[test]
fn field_references_read_the_row() {
    let r = row(&[("a", 10.0), ("heading", 350.0)]);
    assert_eq!(run("a * 2", &r), Some(20.0));
    assert_eq!(run("mod(heading + 20, 360)", &r), Some(10.0));
}

#[test]
fn functions_match_the_js_originals() {
    let none = row(&[]);
    assert_eq!(run("mod(-10, 360)", &none), Some(350.0));
    assert_eq!(run("clamp(500, 0, 360)", &none), Some(360.0));
    assert_eq!(run("clamp(-5, 0, 360)", &none), Some(0.0));
    assert_eq!(run("abs(-3)", &none), Some(3.0));
    assert_eq!(run("min(2, 9)", &none), Some(2.0));
    assert_eq!(run("max(2, 9)", &none), Some(9.0));
    assert_eq!(run("round(2.5)", &none), Some(3.0));
    assert_eq!(run("round(-2.5)", &none), Some(-2.0));
    assert_eq!(run("floor(-2.5)", &none), Some(-3.0));
}

#[test]
fn a_missing_field_or_non_finite_result_skips_the_row() {
    let r = row(&[("a", 1.0)]);
    assert_eq!(run("b + 1", &r), None);
    assert_eq!(run("a / 0", &r), None);
    assert_eq!(run("0 / 0", &r), None);
}

#[test]
fn syntax_errors_name_the_problem() {
    let err = |src: &str| parse(src).unwrap_err().0;
    assert_eq!(err("1 +"), "Unexpected end of expression");
    assert_eq!(err("foo(1)"), "Unknown function \"foo\"");
    assert_eq!(err("mod(1)"), "mod() takes 2 arguments");
    assert_eq!(err("abs(1, 2)"), "abs() takes 1 argument");
    assert_eq!(err("(1 + 2"), "Expected \")\"");
    assert_eq!(err("1 2"), "Unexpected \"2\" after expression");
    assert_eq!(err("a $ b"), "Unexpected character \"$\" at position 2");
    assert_eq!(err("1."), "Invalid number at position 0");
    assert_eq!(err(")"), "Unexpected \")\"");
}

#[test]
fn the_live_check_reports_only_failures() {
    assert_eq!(field_expr_error("a + 1".into()), None);
    assert_eq!(
        field_expr_error("a +".into()).as_deref(),
        Some("Unexpected end of expression")
    );
}
