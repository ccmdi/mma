use super::*;
use serde_json::{json, Value};
use std::collections::HashMap;

type Row = HashMap<String, Value>;

fn row(pairs: &[(&str, f64)]) -> Row {
    pairs.iter().map(|(k, v)| (k.to_string(), json!(v))).collect()
}

fn json_row(pairs: &[(&str, Value)]) -> Row {
    pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

fn run(src: &str, fields: &Row) -> Option<f64> {
    eval(&parse(src).unwrap(), &|k| fields.get(k).cloned())
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

fn err(src: &str) -> ExprError {
    parse(src).unwrap_err()
}

#[test]
fn syntax_errors_name_the_problem() {
    assert_eq!(err("1 +"), ExprError::UnexpectedEnd);
    assert_eq!(
        err("foo(1)"),
        ExprError::UnknownFunction { name: "foo".into() }
    );
    assert_eq!(
        err("mod(1)"),
        ExprError::WrongArgCount {
            name: "mod".into(),
            expected: 2
        }
    );
    assert_eq!(
        err("abs(1, 2)"),
        ExprError::WrongArgCount {
            name: "abs".into(),
            expected: 1
        }
    );
    assert_eq!(
        err("(1 + 2"),
        ExprError::ExpectedSymbol { symbol: ")".into() }
    );
    assert_eq!(err("1 2"), ExprError::TrailingToken { token: "2".into() });
    assert_eq!(
        err("a $ b"),
        ExprError::UnexpectedCharacter {
            character: "$".into(),
            position: 2
        }
    );
    assert_eq!(err("1."), ExprError::InvalidNumber { position: 0 });
    assert_eq!(err(")"), ExprError::UnexpectedToken { token: ")".into() });
}

/// Every kind the TS renderer switches on; both sides must list the same set.
#[test]
fn every_kind_serialises_with_its_parameters() {
    let json = |src: &str| serde_json::to_value(err(src)).unwrap();
    assert_eq!(json("1."), json!({ "kind": "invalidNumber", "position": 0 }));
    assert_eq!(json("\"abc"), json!({ "kind": "unterminatedString" }));
    assert_eq!(
        json("a $ b"),
        json!({ "kind": "unexpectedCharacter", "character": "$", "position": 2 })
    );
    assert_eq!(
        json("(1 + 2"),
        json!({ "kind": "expectedSymbol", "symbol": ")" })
    );
    assert_eq!(json("1 < 2 < 3"), json!({ "kind": "chainedComparison" }));
    assert_eq!(json("1 +"), json!({ "kind": "unexpectedEnd" }));
    assert_eq!(json("< 2"), json!({ "kind": "missingLeftOperand" }));
    assert_eq!(json("has(1)"), json!({ "kind": "hasTakesFieldName" }));
    assert_eq!(
        json("foo(1)"),
        json!({ "kind": "unknownFunction", "name": "foo" })
    );
    assert_eq!(
        json("abs(1, 2)"),
        json!({ "kind": "wrongArgCount", "name": "abs", "expected": 1 })
    );
    assert_eq!(
        json(")"),
        json!({ "kind": "unexpectedToken", "token": ")" })
    );
    assert_eq!(
        json("1 2"),
        json!({ "kind": "trailingToken", "token": "2" })
    );
}

#[test]
fn the_live_check_reports_only_failures() {
    assert_eq!(field_expr_error("a + 1".into()), None);
    assert_eq!(
        field_expr_error("a +".into()),
        Some(ExprError::UnexpectedEnd)
    );
}

#[test]
fn comparisons_yield_one_or_zero_so_a_predicate_is_a_score_term() {
    let r = row(&[("heading", 90.0), ("tagCount", 3.0)]);
    assert_eq!(run("heading != 0", &r), Some(1.0));
    assert_eq!(run("heading == 0", &r), Some(0.0));
    assert_eq!(run("tagCount >= 3", &r), Some(1.0));
    assert_eq!(run("tagCount > 3", &r), Some(0.0));
    assert_eq!(run("tagCount <= 2", &r), Some(0.0));
    assert_eq!(run("tagCount < 9", &r), Some(1.0));
    assert_eq!(run("tagCount + 5 * (heading != 0)", &r), Some(8.0));
}

#[test]
fn comparisons_bind_looser_than_arithmetic() {
    let r = row(&[("a", 2.0)]);
    assert_eq!(run("a + 1 == 3", &r), Some(1.0));
    assert_eq!(run("a * 2 > 3", &r), Some(1.0));
    assert_eq!(err("1 < 2 < 3"), ExprError::ChainedComparison);
    assert_eq!(run("(1 < 2) < 3", &row(&[])), Some(1.0));
}

#[test]
fn a_comparison_the_row_cannot_answer_is_false_not_a_skip() {
    let r = row(&[("a", 1.0)]);
    // `b + 1` alone skips the row; as a comparison operand it just loses.
    assert_eq!(run("b + 1", &r), None);
    assert_eq!(run("b == 1", &r), Some(0.0));
    assert_eq!(run("b != 1", &r), Some(0.0));
    assert_eq!(run("a + (b > 0)", &r), Some(1.0));
}

#[test]
fn has_reports_presence_without_skipping() {
    let r = json_row(&[("panoId", json!("abc")), ("zero", json!(0))]);
    assert_eq!(run("has(panoId)", &r), Some(1.0));
    assert_eq!(run("has(missing)", &r), Some(0.0));
    assert_eq!(run("has(zero)", &r), Some(1.0));
    // A non-numeric field is still present, which bare arithmetic could never say.
    assert_eq!(run("panoId + 1", &r), None);
}

#[test]
fn strings_compare_as_strings() {
    let r = json_row(&[("panoId", json!("abc"))]);
    assert_eq!(run("panoId == \"abc\"", &r), Some(1.0));
    assert_eq!(run("panoId == \"xyz\"", &r), Some(0.0));
    assert_eq!(run("panoId != \"xyz\"", &r), Some(1.0));
    assert_eq!(run("\"a\\\"b\" == \"a\\\"b\"", &r), Some(1.0));
}

#[test]
fn if_evaluates_only_the_branch_it_takes() {
    let r = row(&[("a", 4.0)]);
    assert_eq!(run("if(1, 2, 3)", &r), Some(2.0));
    assert_eq!(run("if(0, 2, 3)", &r), Some(3.0));
    // The untaken branch references a missing field and must not skip the row.
    assert_eq!(run("if(has(a), a * 2, missing)", &r), Some(8.0));
    assert_eq!(run("if(has(missing), missing, a)", &r), Some(4.0));
}

#[test]
fn the_prune_default_is_expressible() {
    let src = "tagCount + has(panoId) + loadAsPanoId + (heading != 0)";
    let best = json_row(&[
        ("tagCount", json!(2)),
        ("panoId", json!("abc")),
        ("loadAsPanoId", json!(1)),
        ("heading", json!(90)),
    ]);
    let bare = json_row(&[
        ("tagCount", json!(0)),
        ("loadAsPanoId", json!(0)),
        ("heading", json!(0)),
    ]);
    assert_eq!(run(src, &best), Some(5.0));
    assert_eq!(run(src, &bare), Some(0.0));
}

#[test]
fn new_syntax_errors_name_the_problem() {
    assert_eq!(err("has(1)"), ExprError::HasTakesFieldName);
    assert_eq!(
        err("if(1, 2)"),
        ExprError::WrongArgCount {
            name: "if".into(),
            expected: 3
        }
    );
    assert_eq!(err("< 2"), ExprError::MissingLeftOperand);
    assert_eq!(err("\"abc"), ExprError::UnterminatedString);
}
