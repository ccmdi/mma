use super::*;

#[test]
fn custom_weights_use_total_default_uses_max_satisfying() {
    let country_code = "DK";
    let subdivision = "DK-81";
    let available: &[&str] = &["DK-81", "DK-82", "DK-83", "DK-84", "DK-85"];
    let custom_weights = vec![("DK-81".to_string(), 1), ("DK-82".to_string(), 1)];
    let total = 1000;
    let max_satisfying = 500;

    let resolved_custom = resolve_subdivision_goal(
        country_code,
        subdivision,
        Some(&custom_weights),
        available,
        total,
        max_satisfying,
    );
    assert_eq!(
        resolved_custom,
        subdivision_goal_from_custom_weights(&custom_weights, subdivision, total)
    );
    assert_ne!(
        resolved_custom,
        subdivision_goal_from_custom_weights(&custom_weights, subdivision, max_satisfying)
    );

    let resolved_default = resolve_subdivision_goal(
        country_code,
        subdivision,
        None,
        available,
        total,
        max_satisfying,
    );
    assert_eq!(
        resolved_default,
        goal_for_subdivision(country_code, subdivision, max_satisfying, Some(available))
    );
    assert_ne!(
        resolved_default,
        goal_for_subdivision(country_code, subdivision, total, Some(available))
    );
}
