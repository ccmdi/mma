use crate::filter::filter;
use crate::goals::{goal_for_subdivision, subdivision_goal_from_custom_weights};
use rustc_hash::FxHashMap;
use vali_core::Location;
use vali_expr::error::ExprError;
use vali_geo::geohash::HashPrecision;
/// Chosen location indices, their tags, and the min distance achieved.
pub type Selected = (Vec<u32>, Vec<Option<String>>, i32);

pub struct SubdivisionResult {
    pub indices: Vec<u32>,
    pub tags: Vec<Option<String>>,
    pub region_goal_count: i32,
    pub min_distance: i32,
}
#[derive(Default)]
pub struct ResolvedProbability {
    pub default_weight: i32,
    pub overrides: Vec<(vali_expr::CompiledBool, i32)>,
}
impl ResolvedProbability {
    pub fn from_def(def: &vali_core::LocationProbabilityDef) -> ResolvedProbability {
        ResolvedProbability {
            default_weight: def.default_weight,
            overrides: def
                .weight_overrides
                .iter()
                .map(|o| (
                    vali_expr::compile_bool(&o.expression).expect("validated earlier"),
                    o.weight,
                ))
                .collect(),
        }
    }
    pub fn is_weighted(&self) -> bool {
        !self.overrides.is_empty()
    }
    fn weight(&self, loc: &Location) -> i32 {
        self.overrides
            .iter()
            .find(|(compiled, _)| compiled.eval(loc))
            .map(|&(_, w)| w)
            .unwrap_or(self.default_weight)
    }
}
fn order_candidates(
    locations: &[Location],
    mut candidates: Vec<u32>,
    probability: &ResolvedProbability,
    deterministic: bool,
) -> Vec<u32> {
    if deterministic {
        return candidates;
    }
    if probability.is_weighted() {
        let mut keyed: Vec<(f64, u32)> = candidates
            .iter()
            .map(|&i| {
                let weight = probability.weight(&locations[i as usize]);
                let w = if weight <= 0 { f64::EPSILON } else { weight as f64 };
                (-(fastrand::f64() + f64::EPSILON).ln() / w, i)
            })
            .collect();
        keyed.sort_by(|a, b| a.0.total_cmp(&b.0));
        return keyed.into_iter().map(|(_, i)| i).collect();
    }
    fastrand::shuffle(&mut candidates);
    candidates
}
pub struct PreferenceSpec<'a> {
    pub expression: &'a str,
    pub percentage: Option<i32>,
    pub fill: bool,
    pub location_tag: Option<&'a str>,
    pub min_min_distance: Option<i32>,
    pub proximity: Option<&'a crate::proximity::ProximityIndex>,
    pub geometry: Option<&'a crate::geometry::GeometryContext>,
    pub neighbor_specs: Vec<crate::neighbor::NeighborFilterSpec>,
}
pub fn merge_location_filters(parts: &[Option<&str>]) -> Option<String> {
    let merged: Vec<String> = parts
        .iter()
        .filter_map(|p| p.filter(|x| !x.trim().is_empty()).map(|x| format!("({x})")))
        .collect();
    if merged.is_empty() { None } else { Some(merged.join(" and ")) }
}
#[allow(clippy::too_many_arguments)]
pub fn subdivision_by_max_min_distance(
    locations: &[Location],
    country_code: &str,
    goal_count: i32,
    available_subdivisions: &[&str],
    merged_filter_expression: Option<&str>,
    proximity: Option<&crate::proximity::ProximityIndex>,
    geometry: Option<&crate::geometry::GeometryContext>,
    neighbors: Option<&crate::neighbor::NeighborContext>,
    map_neighbor_specs: &[crate::neighbor::NeighborFilterSpec],
    preference_filters: &[PreferenceSpec<'_>],
    probability: &ResolvedProbability,
    custom_subdivision_weights: Option<&[(String, i32)]>,
    enable_default_filters: bool,
    min_min_distance: i32,
    deterministic: bool,
) -> Result<SubdivisionResult, ExprError> {
    let empty = |goal: i32| SubdivisionResult {
        indices: Vec::new(),
        tags: Vec::new(),
        region_goal_count: goal,
        min_distance: 0,
    };
    let subdivision = locations
        .first()
        .map(|l| l.nominatim.subdivision_code.as_str())
        .unwrap_or("");
    if !available_subdivisions.contains(&subdivision) {
        return Ok(empty(0));
    }
    let map_spec_refs: Vec<&crate::neighbor::NeighborFilterSpec> = map_neighbor_specs
        .iter()
        .collect();
    let filtered = filter(
        locations,
        merged_filter_expression,
        proximity,
        geometry,
        neighbors.map(|ctx| (ctx, map_spec_refs.as_slice())),
        enable_default_filters,
        deterministic,
    )?;
    let region_goal_count = match custom_subdivision_weights {
        Some(weights) => {
            subdivision_goal_from_custom_weights(weights, subdivision, goal_count)
        }
        None => {
            goal_for_subdivision(
                country_code,
                subdivision,
                goal_count,
                Some(available_subdivisions),
            )
        }
    };
    if region_goal_count == 0 {
        return Ok(empty(0));
    }
    if filtered.is_empty() {
        return Ok(empty(region_goal_count));
    }
    let (indices, tags, min_distance) = by_max_min_distance(
        locations,
        filtered,
        region_goal_count,
        neighbors,
        map_neighbor_specs,
        preference_filters,
        probability,
        enable_default_filters,
        min_min_distance,
        deterministic,
    )?;
    Ok(SubdivisionResult {
        indices,
        tags,
        region_goal_count,
        min_distance,
    })
}
#[allow(clippy::too_many_arguments)]
pub fn by_max_min_distance(
    locations: &[Location],
    filtered: Vec<u32>,
    region_goal_count: i32,
    neighbors: Option<&crate::neighbor::NeighborContext>,
    map_neighbor_specs: &[crate::neighbor::NeighborFilterSpec],
    preference_filters: &[PreferenceSpec<'_>],
    probability: &ResolvedProbability,
    enable_default_filters: bool,
    min_min_distance: i32,
    deterministic: bool,
) -> Result<Selected, ExprError> {
    if !preference_filters.is_empty() {
        let result = preference_selection(
            locations,
            &filtered,
            preference_filters,
            neighbors,
            map_neighbor_specs,
            probability,
            region_goal_count,
            enable_default_filters,
            min_min_distance,
            deterministic,
        )?;
        return Ok((result.indices, result.tags, result.min_distance));
    }
    let ordered = order_candidates(locations, filtered, probability, deterministic);
    let (indices, min_distance) = distribute(
        locations,
        &ordered,
        region_goal_count,
        min_min_distance,
        &[],
    );
    let tags = vec![None; indices.len()];
    Ok((indices, tags, min_distance))
}
pub fn precision_for_min_distance(min_distance: i32) -> HashPrecision {
    match min_distance {
        i32::MIN..=200 => HashPrecision::Size_km_1x1,
        201..=1000 => HashPrecision::Size_km_5x5,
        1001..=15000 => HashPrecision::Size_km_39x20,
        _ => HashPrecision::Size_km_156x156,
    }
}
fn get_some_indices(
    locations: &[Location],
    candidates: &[u32],
    goal_count: i32,
    min_distance: i32,
    already_in_map: &[(f64, f64)],
    probability: &ResolvedProbability,
    deterministic: bool,
) -> Vec<u32> {
    if goal_count <= 0 {
        return Vec::new();
    }
    if probability.is_weighted() {
        return weighted_get_some(
            locations,
            candidates,
            goal_count,
            min_distance,
            already_in_map,
            probability,
        );
    }
    let mut ordered: Vec<u32> = candidates.to_vec();
    if !deterministic {
        fastrand::shuffle(&mut ordered);
    }
    let points: Vec<(f64, f64)> = ordered
        .iter()
        .map(|&i| {
            let l = &locations[i as usize];
            (l.lat, l.lng)
        })
        .collect();
    vali_geo::get_some(&points, goal_count as usize, min_distance, already_in_map)
        .into_iter()
        .map(|s| ordered[s as usize])
        .collect()
}
fn weighted_get_some(
    locations: &[Location],
    candidates: &[u32],
    goal_count: i32,
    min_distance: i32,
    already_in_map: &[(f64, f64)],
    probability: &ResolvedProbability,
) -> Vec<u32> {
    let d_squared = min_distance as f64 * min_distance as f64;
    let mut alive: Vec<(u32, f64, f64, f64)> = candidates
        .iter()
        .map(|&i| {
            let l = &locations[i as usize];
            (i, l.lat, l.lng, probability.weight(l) as f64)
        })
        .filter(|&(_, lat, lng, _)| {
            !already_in_map
                .iter()
                .any(|&(plat, plng)| vali_geo::points_are_closer_than(
                    plat,
                    plng,
                    lat,
                    lng,
                    d_squared,
                ))
        })
        .collect();
    let mut selected: Vec<u32> = Vec::new();
    while (selected.len() as i32) < goal_count && !alive.is_empty() {
        let total: f64 = alive.iter().map(|&(_, _, _, w)| w).sum();
        let mut r = fastrand::f64() * total;
        let mut pick = alive.len() - 1;
        for (slot, &(_, _, _, w)) in alive.iter().enumerate() {
            r -= w;
            if r < 0.0 {
                pick = slot;
                break;
            }
        }
        let (i, lat, lng, _) = alive.remove(pick);
        selected.push(i);
        alive
            .retain(|&(_, la, ln, _)| {
                !vali_geo::points_are_closer_than(la, ln, lat, lng, d_squared)
            });
    }
    selected
}
pub fn distribute_evenly(
    locations: &[Location],
    candidates: &[u32],
    min_distance: i32,
    probability: &ResolvedProbability,
    deterministic: bool,
) -> Vec<u32> {
    let precision = precision_for_min_distance(min_distance);
    let mut group_of: FxHashMap<u64, usize> = FxHashMap::default();
    let mut groups: Vec<(u64, Vec<u32>)> = Vec::new();
    for &i in candidates {
        let l = &locations[i as usize];
        let hash = vali_geo::encode(l.lat, l.lng, precision);
        let slot = *group_of
            .entry(hash)
            .or_insert_with(|| {
                groups.push((hash, Vec::new()));
                groups.len() - 1
            });
        groups[slot].1.push(i);
    }
    let mut placed_by_hash: FxHashMap<u64, Vec<(f64, f64)>> = FxHashMap::default();
    let mut selected: Vec<u32> = Vec::new();
    for (hash, group) in &groups {
        let mut already: Vec<(f64, f64)> = Vec::new();
        for neighbor_hash in vali_geo::neighbors(*hash) {
            if let Some(bucket) = placed_by_hash.get(&neighbor_hash) {
                already.extend_from_slice(bucket);
            }
        }
        for idx in get_some_indices(
            locations,
            group,
            1_000_000,
            min_distance,
            &already,
            probability,
            deterministic,
        ) {
            let l = &locations[idx as usize];
            selected.push(idx);
            placed_by_hash
                .entry(vali_geo::encode(l.lat, l.lng, precision))
                .or_default()
                .push((l.lat, l.lng));
        }
    }
    selected
}
pub fn densify_country(
    locations: &[Location],
    filtered: &[u32],
    files_count: usize,
    min_distance: i32,
    probability: &ResolvedProbability,
    deterministic: bool,
) -> Vec<u32> {
    let per_cell_goal = crate::goals::round_to_int(
        rust_decimal::Decimal::from(120_000)
            / rust_decimal::Decimal::from(files_count as i64),
    );
    let mut group_of: FxHashMap<u64, usize> = FxHashMap::default();
    let mut groups: Vec<Vec<u32>> = Vec::new();
    for &i in filtered {
        let l = &locations[i as usize];
        let hash = vali_geo::encode(l.lat, l.lng, HashPrecision::Size_km_1x1);
        let slot = *group_of
            .entry(hash)
            .or_insert_with(|| {
                groups.push(Vec::new());
                groups.len() - 1
            });
        groups[slot].push(i);
    }
    let mut selected: Vec<u32> = Vec::new();
    for group in &groups {
        selected
            .extend(
                get_some_indices(
                    locations,
                    group,
                    per_cell_goal,
                    min_distance / 2,
                    &[],
                    probability,
                    deterministic,
                ),
            );
    }
    if deterministic {
        selected.sort_by_key(|&i| locations[i as usize].node_id);
    }
    selected
}
#[allow(clippy::too_many_arguments)]
pub fn locations_by_coverage_density(
    locations: &[Location],
    filtered: &[u32],
    region_goal_count: i32,
    tuning_factor: f64,
    neighbors: Option<&crate::neighbor::NeighborContext>,
    map_neighbor_specs: &[crate::neighbor::NeighborFilterSpec],
    preference_filters: &[PreferenceSpec<'_>],
    probability: &ResolvedProbability,
    enable_default_filters: bool,
    min_min_distance: i32,
    deterministic: bool,
) -> Result<Selected, ExprError> {
    let mut group_of: FxHashMap<u64, usize> = FxHashMap::default();
    let mut clusters: Vec<Vec<u32>> = Vec::new();
    for &i in filtered {
        let l = &locations[i as usize];
        let hash = vali_geo::encode(l.lat, l.lng, HashPrecision::Size_km_156x156);
        let slot = *group_of
            .entry(hash)
            .or_insert_with(|| {
                clusters.push(Vec::new());
                clusters.len() - 1
            });
        clusters[slot].push(i);
    }
    let weights: Vec<f64> = clusters
        .iter()
        .map(|c| 1.0 / (c.len() as f64).powf(tuning_factor) * c.len() as f64)
        .collect();
    let weight_sum: f64 = weights.iter().sum();
    let mut indices: Vec<u32> = Vec::new();
    let mut tags: Vec<Option<String>> = Vec::new();
    let mut min_distance = i32::MAX;
    for (cluster, weight) in clusters.iter().zip(&weights) {
        let count = (region_goal_count as f64 * (weight / weight_sum)).round_ties_even()
            as i32;
        let (cluster_indices, cluster_tags, cluster_min) = by_max_min_distance(
            locations,
            cluster.clone(),
            count,
            neighbors,
            map_neighbor_specs,
            preference_filters,
            probability,
            enable_default_filters,
            min_min_distance,
            deterministic,
        )?;
        indices.extend(cluster_indices);
        tags.extend(cluster_tags);
        min_distance = min_distance.min(cluster_min);
    }
    Ok((indices, tags, min_distance))
}
pub fn max_count_goal_search(
    subs: &[(&str, &[Location], Vec<u32>)],
    country_code: &str,
    custom_weights: Option<&[(String, i32)]>,
    available_subdivisions: &[&str],
    fixed_min_distance: i32,
    probability: &ResolvedProbability,
    deterministic: bool,
) -> Vec<i32> {
    let goal_for = |sub: &str, total: i32| -> i32 {
        match custom_weights {
            Some(w) => subdivision_goal_from_custom_weights(w, sub, total),
            None => {
                goal_for_subdivision(
                    country_code,
                    sub,
                    total,
                    Some(available_subdivisions),
                )
            }
        }
    };
    let mut total: i32 = 110_000;
    let mut tried: Vec<(i32, bool)> = Vec::new();
    let mut selected_counts: Vec<i32> = vec![0; subs.len()];
    while tried.len() < 10 {
        let goals: Vec<i32> = subs
            .iter()
            .map(|(sub, _, _)| goal_for(sub, total))
            .collect();
        for (i, (_, locations, filtered)) in subs.iter().enumerate() {
            if (filtered.len() as i32) < goals[i] {
                tried.push((total, false));
                break;
            }
            let selected = get_some_indices(
                locations,
                filtered,
                goals[i],
                fixed_min_distance,
                &[],
                probability,
                deterministic,
            );
            if (selected.len() as i32) < goals[i] {
                tried.push((total, false));
                break;
            }
            selected_counts[i] = selected.len() as i32;
        }
        if selected_counts.iter().zip(&goals).all(|(c, g)| c >= g) {
            tried.push((total, true));
        }
        if tried.len() == 1 && tried[0].1 {
            break;
        }
        total = if tried.iter().any(|t| t.1) {
            let largest_success = tried
                .iter()
                .filter(|t| t.1)
                .map(|t| t.0)
                .max()
                .unwrap();
            let min_fail_above = tried
                .iter()
                .filter(|t| !t.1 && t.0 > largest_success)
                .map(|t| t.0)
                .min()
                .unwrap_or(0);
            largest_success + (min_fail_above - largest_success) / 2
        } else {
            tried.iter().map(|t| t.0).min().unwrap() / 2
        };
    }
    let max_satisfying = tried
        .iter()
        .filter(|t| t.1)
        .map(|t| t.0)
        .max()
        .filter(|&c| c != 0)
        .unwrap_or_else(|| tried.iter().map(|t| t.0).min().unwrap());
    subs.iter()
        .map(|(sub, _, _)| match custom_weights {
            Some(w) => subdivision_goal_from_custom_weights(w, sub, total),
            None => {
                goal_for_subdivision(
                    country_code,
                    sub,
                    max_satisfying,
                    Some(available_subdivisions),
                )
            }
        })
        .collect()
}
#[allow(clippy::too_many_arguments)]
fn preference_selection(
    locations: &[Location],
    main_filtered: &[u32],
    preference_filters: &[PreferenceSpec<'_>],
    neighbors: Option<&crate::neighbor::NeighborContext>,
    map_neighbor_specs: &[crate::neighbor::NeighborFilterSpec],
    probability: &ResolvedProbability,
    region_goal_count: i32,
    enable_default_filters: bool,
    min_min_distance: i32,
    deterministic: bool,
) -> Result<SubdivisionResult, ExprError> {
    let mut indices: Vec<u32> = Vec::new();
    let mut tags: Vec<Option<String>> = Vec::new();
    let mut placed: Vec<(f64, f64)> = Vec::new();
    let mut last_min_distance = min_min_distance;
    for pref in preference_filters {
        let expression = if pref.expression.is_empty() {
            None
        } else {
            Some(pref.expression)
        };
        let combined_specs: Vec<&crate::neighbor::NeighborFilterSpec> = pref
            .neighbor_specs
            .iter()
            .chain(map_neighbor_specs)
            .collect();
        let pref_filtered = crate::filter::filter_subset(
            locations,
            main_filtered,
            expression,
            pref.proximity,
            pref.geometry,
            neighbors.map(|ctx| (ctx, combined_specs.as_slice())),
            enable_default_filters,
            deterministic,
        )?;
        let pref_filtered = order_candidates(
            locations,
            pref_filtered,
            probability,
            deterministic,
        );
        let goal = match (pref.fill, pref.percentage) {
            (false, Some(pct)) => {
                crate::goals::round_to_int(
                    rust_decimal::Decimal::from(region_goal_count.wrapping_mul(pct))
                        / rust_decimal::Decimal::from(100),
                )
            }
            _ => region_goal_count - indices.len() as i32,
        };
        let min_min = pref.min_min_distance.unwrap_or(min_min_distance);
        let (selected, min_distance) = distribute(
            locations,
            &pref_filtered,
            goal,
            min_min,
            &placed,
        );
        last_min_distance = min_distance;
        for &idx in &selected {
            let l = &locations[idx as usize];
            placed.push((l.lat, l.lng));
            indices.push(idx);
            tags.push(pref.location_tag.map(str::to_string));
        }
    }
    Ok(SubdivisionResult {
        indices,
        tags,
        region_goal_count,
        min_distance: last_min_distance,
    })
}
fn distribute(
    locations: &[Location],
    ordered: &[u32],
    goal_count: i32,
    min_min_distance: i32,
    already_in_map: &[(f64, f64)],
) -> (Vec<u32>, i32) {
    if goal_count <= 0 {
        return (Vec::new(), 0);
    }
    let candidates: Vec<(f64, f64)> = ordered
        .iter()
        .map(|&i| {
            let l = &locations[i as usize];
            (l.lat, l.lng)
        })
        .collect();
    let (selected, min_distance) = vali_geo::with_max_min_distance(
        &candidates,
        goal_count as usize,
        Some(min_min_distance),
        already_in_map,
    );
    (selected.iter().map(|&s| ordered[s as usize]).collect(), min_distance)
}
