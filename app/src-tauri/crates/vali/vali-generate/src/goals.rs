
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::{Decimal, RoundingStrategy};
pub fn round_to_int(d: Decimal) -> i32 {
    d.round_dp_with_strategy(0, RoundingStrategy::MidpointNearestEven)
        .to_i32()
        .expect("goal count out of int range")
}
pub fn subdivision_weights(
    country_code: &str,
) -> Option<&'static [(&'static str, i32)]> {
    crate::weights::subdivision_weights(country_code)
}
pub fn country_location_count_goal(
    country_distribution: &[(String, i32)],
    location_count_goal: i32,
    country_code: &str,
) -> i32 {
    let total: i32 = country_distribution.iter().map(|(_, w)| *w).sum();
    let weight = country_distribution
        .iter()
        .find(|(cc, _)| cc == country_code)
        .unwrap_or_else(|| panic!("country {country_code} not in CountryDistribution"))
        .1;
    round_to_int(
        Decimal::from(location_count_goal) * Decimal::from(weight) / Decimal::from(total),
    )
}
pub fn goal_for_subdivision(
    country_code: &str,
    subdivision_code: &str,
    total_goal_count: i32,
    available_subdivisions: Option<&[&str]>,
) -> i32 {
    let weights = subdivision_weights(country_code)
        .unwrap_or_else(|| panic!("Weight for subdivision {subdivision_code} is null."));
    let region_total_weight: i32 = weights
        .iter()
        .filter(|(code, _)| available_subdivisions.is_none_or(|a| a.contains(code)))
        .map(|(_, w)| *w)
        .sum();
    let weight = weights
        .iter()
        .find(|(code, _)| *code == subdivision_code)
        .unwrap_or_else(|| panic!("Subdivision code {subdivision_code} is not defined."))
        .1;
    round_to_int(
        Decimal::from(weight) / Decimal::from(region_total_weight)
            * Decimal::from(total_goal_count),
    )
}
pub fn subdivision_goal_from_custom_weights(
    weights: &[(String, i32)],
    subdivision_code: &str,
    goal_count: i32,
) -> i32 {
    let weight = weights
        .iter()
        .find(|(code, _)| code == subdivision_code)
        .map_or(0, |(_, w)| *w);
    let total: i32 = weights.iter().map(|(_, w)| *w).sum();
    round_to_int(
        Decimal::from(weight) / Decimal::from(total) * Decimal::from(goal_count),
    )
}
