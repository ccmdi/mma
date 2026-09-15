use crate::country_weights as cw;
use crate::geometry::{self, GeometrySource, PreparedGeometryFilter};
use crate::goals::subdivision_weights;
use std::collections::HashMap;
use std::path::Path;
use vali_core::{
    DistributionStrategy, LocationPreferenceFilterDef, MapDefinition, NeighborFilterDef,
    ProximityFilterDef,
};
use vali_expr::expand;
pub const HARDCODED_PANO_ID_COUNTRIES: [&str; 5] = ["ML", "JE", "IM", "CW", "BT"];
#[derive(Debug)]
pub struct Prepared {
    pub country_codes: Vec<String>,
    pub country_distribution: Vec<(String, i32)>,
    pub strategy_key: String,
    pub location_count_goal: i32,
    pub min_min_distance: i32,
    pub fixed_min_distance: i32,
    pub treat_countries_as_single_subdivision: Vec<String>,
    pub coverage_density_tuning_factor: f64,
    pub enable_default_location_filters: bool,
    pub global_location_filter: String,
    pub country_location_filters: HashMap<String, String>,
    pub subdivision_location_filters: HashMap<String, HashMap<String, String>>,
    pub subdivision_inclusions: HashMap<String, Vec<String>>,
    pub subdivision_exclusions: HashMap<String, Vec<String>>,
    pub subdivision_distribution: HashMap<String, Vec<(String, i32)>>,
    pub proximity_filter: ProximityFilterDef,
    pub country_proximity_filters: HashMap<String, ProximityFilterDef>,
    pub subdivision_proximity_filters: HashMap<String, HashMap<String, ProximityFilterDef>>,
    pub neighbor_filters: Vec<NeighborFilterDef>,
    pub neighbor_bucket_precision: Option<vali_geo::geohash::HashPrecision>,
    pub geometry_filters: Vec<PreparedGeometryFilter>,
    pub country_geometry_filters: HashMap<String, Vec<PreparedGeometryFilter>>,
    pub subdivision_geometry_filters: HashMap<String, HashMap<String, Vec<PreparedGeometryFilter>>>,
    pub global_location_preference_filters: Vec<LocationPreferenceFilterDef>,
    pub country_location_preference_filters: HashMap<String, Vec<LocationPreferenceFilterDef>>,
    pub subdivision_location_preference_filters:
        HashMap<String, HashMap<String, Vec<LocationPreferenceFilterDef>>>,
    pub global_location_probability: vali_core::LocationProbabilityDef,
    pub country_location_probabilities: HashMap<String, vali_core::LocationProbabilityDef>,
    pub subdivision_location_probabilities:
        HashMap<String, HashMap<String, vali_core::LocationProbabilityDef>>,
    pub location_tags: Vec<String>,
    pub pano_id_country_codes: Vec<String>,
    pub global_heading_expression: Option<String>,
    pub country_heading_expressions: HashMap<String, String>,
    pub global_zoom: Option<f64>,
    pub global_pitch: Option<f64>,
}
pub fn prepare(def: &MapDefinition) -> Result<Prepared, String> {
    reject_unsupported(def)?;
    let strategy = &def.distribution_strategy;
    const VALID_STRATEGY_KEYS: [&str; 4] = [
        "FixedCountByMaxMinDistance",
        "MaxCountByFixedMinDistance",
        "EvenlyByDistanceWithinCountry",
        "FixedCountByCoverageDensity",
    ];
    let key = strategy.key.as_deref().unwrap_or("");
    if !VALID_STRATEGY_KEYS.contains(&key) {
        return Err(format!(
            "distributionStrategy.key must be one of {}.",
            VALID_STRATEGY_KEYS.join(", ")
        ));
    }
    if strategy.location_count_goal <= 0 && key == "FixedCountByMaxMinDistance" {
        return Err("locationCountGoal must be greater than zero.".to_string());
    }
    if strategy.location_count_goal > 1_000_000 {
        return Err("locationCountGoal cannot be greater than 1,000,000.".to_string());
    }
    let ladder_text = || vali_geo::DISTANCES.map(|d| d.to_string()).join(", ");
    if key == "FixedCountByMaxMinDistance"
        && !vali_geo::DISTANCES.contains(&strategy.min_min_distance)
    {
        return Err(format!("minMinDistance must be one of {}", ladder_text()));
    }
    if matches!(
        key,
        "MaxCountByFixedMinDistance" | "EvenlyByDistanceWithinCountry"
    ) && !vali_geo::DISTANCES.contains(&strategy.fixed_min_distance)
    {
        return Err(format!("fixedMinDistance must be one of {}", ladder_text()));
    }
    if key == "FixedCountByCoverageDensity" {
        if strategy
            .coverage_density_tuning_factor
            .is_some_and(|t| !(0.01..=1.0).contains(&t))
        {
            return Err(
                "coverageDensityTuningFactor must be between 0.01 and 1. Default is 0.6"
                    .to_string(),
            );
        }
        if strategy
            .coverage_density_cluster_size
            .is_some_and(|s| !(1..=6).contains(&s))
        {
            return Err(
                "coverageDensityClusterSize must be between 1 and 6. Default is 3.".to_string(),
            );
        }
    }
    let country_codes = map_country_codes(&def.country_codes, strategy)?;
    if country_codes.is_empty() {
        return Err("countryCodes resolved to an empty set.".to_string());
    }
    for cc in &country_codes {
        if subdivision_weights(cc).is_none() {
            return Err(format!("Unknown country code '{cc}'."));
        }
    }
    let country_distribution = resolve_country_distribution(def, &country_codes)?;
    for cc in &country_codes {
        if !country_distribution.iter().any(|(c, _)| c == cc) {
            return Err(format!(
                "Country '{cc}' is missing from the country distribution."
            ));
        }
    }
    let named: Vec<(String, String)> = def
        .named_expressions
        .0
        .iter()
        .map(|(k, v)| (k.clone(), expand(&def.named_expressions.0, v)))
        .collect();
    let global_location_filter = match def.global_location_filter.as_deref() {
        Some(f) if !f.is_empty() => expand(&named, f),
        _ => String::new(),
    };
    let country_location_filters: HashMap<String, String> =
        expand_country_dictionary(&def.country_location_filters, strategy)?
            .into_iter()
            .map(|(k, v)| (k, expand(&named, &v)))
            .collect();
    let subdivision_location_filters: HashMap<String, HashMap<String, String>> = def
        .subdivision_location_filters
        .iter()
        .map(|(cc, subs)| {
            (
                cc.clone(),
                subs.iter()
                    .map(|(s, f)| (s.clone(), expand(&named, f)))
                    .collect(),
            )
        })
        .collect();
    validate_bool_expression("globalLocationFilter", &global_location_filter)?;
    for (cc, f) in &country_location_filters {
        validate_bool_expression(&format!("countryLocationFilters[{cc}]"), f)?;
    }
    for (cc, subs) in &subdivision_location_filters {
        for (sub, f) in subs {
            validate_bool_expression(&format!("subdivisionLocationFilters[{cc}][{sub}]"), f)?;
        }
    }
    let country_heading_expressions =
        expand_country_dictionary(&def.output.country_heading_expressions, strategy)?;
    if let Some(e) = def.output.global_heading_expression.as_deref() {
        vali_expr::compile_int(e).map_err(|err| format!("globalHeadingExpression: {err}"))?;
    }
    for (cc, e) in &country_heading_expressions {
        vali_expr::compile_int(e)
            .map_err(|err| format!("countryHeadingExpressions[{cc}]: {err}"))?;
    }
    let mut pano_id_country_codes = map_country_codes(&def.output.pano_id_country_codes, strategy)?;
    for hardcoded in HARDCODED_PANO_ID_COUNTRIES {
        if !pano_id_country_codes.iter().any(|c| c == hardcoded) {
            pano_id_country_codes.push(hardcoded.to_string());
        }
    }
    for (cc, subs) in def
        .subdivision_inclusions
        .iter()
        .chain(def.subdivision_exclusions.iter())
    {
        let Some(weights) = subdivision_weights(cc) else {
            return Err(format!(
                "subdivision inclusions/exclusions reference unknown country '{cc}'."
            ));
        };
        for sub in subs {
            if !weights.iter().any(|(code, _)| code == sub) {
                return Err(format!(
                    "Unknown subdivision code '{sub}' for country '{cc}'."
                ));
            }
        }
    }
    let all_proximity = std::iter::once(&def.proximity_filter)
        .chain(def.country_proximity_filters.values())
        .chain(
            def.subdivision_proximity_filters
                .values()
                .flat_map(|m| m.values()),
        );
    for pf in all_proximity {
        if pf.radius <= 0 && !pf.locations_path.is_empty() {
            return Err(
                "Using proximityFilter with radius less than 1 is not supported.".to_string(),
            );
        }
        if pf.radius > 30_000 {
            return Err(
                "Using proximityFilter with radius larger than 30000 is not supported due to performance reasons."
                    .to_string(),
            );
        }
        if !pf.locations_path.is_empty() && !Path::new(&pf.locations_path).exists() {
            return Err(format!(
                "File {} used in a proximityFilter does not exist.",
                pf.locations_path
            ));
        }
    }
    let expand_neighbor = |f: &NeighborFilterDef| NeighborFilterDef {
        expression: expand(&named, &f.expression),
        ..f.clone()
    };
    let neighbor_filters: Vec<NeighborFilterDef> =
        def.neighbor_filters.iter().map(expand_neighbor).collect();
    let expand_pref =
        |p: &LocationPreferenceFilterDef| -> Result<LocationPreferenceFilterDef, String> {
            let expression = expand(&named, &p.expression);
            validate_bool_expression("preference filter expression", &expression)?;
            let mode = geometry::normalized_combination_mode(&p.geometry_filters);
            let geometry_filters = p
                .geometry_filters
                .iter()
                .map(|g| vali_core::GeometryFilterDef {
                    combination_mode: mode.clone(),
                    ..g.clone()
                })
                .collect();
            let neighbor_filters = p.neighbor_filters.iter().map(expand_neighbor).collect();
            Ok(LocationPreferenceFilterDef {
                expression,
                geometry_filters,
                neighbor_filters,
                ..p.clone()
            })
        };
    let expand_pref_list =
        |list: &[LocationPreferenceFilterDef]| -> Result<Vec<LocationPreferenceFilterDef>, String> {
            let expanded: Result<Vec<_>, _> = list.iter().map(expand_pref).collect();
            let expanded = expanded?;
            if expanded
                .iter()
                .any(|p| !p.fill && p.percentage.is_some_and(|pct| !(1..=100).contains(&pct)))
            {
                return Err(
                    "Preference filter percentages must be between 1 and 100 or set fill to true"
                        .to_string(),
                );
            }
            if expanded.iter().filter_map(|p| p.percentage).sum::<i32>() > 100 {
                return Err(
                "Preference filter percentages must sum to less than 100. Use * to match anything."
                    .to_string(),
            );
            }
            if expanded.iter().filter(|p| p.fill).count() > 1 {
                return Err("Preference filter fill can only be true for one entry.".to_string());
            }
            Ok(expanded)
        };
    let global_location_preference_filters =
        expand_pref_list(&def.global_location_preference_filters)?;
    let mut country_location_preference_filters: HashMap<String, Vec<LocationPreferenceFilterDef>> =
        HashMap::new();
    for (cc, list) in &def.country_location_preference_filters {
        for code in map_country_codes(std::slice::from_ref(cc), &DistributionStrategy::default())? {
            country_location_preference_filters
                .entry(code)
                .or_insert(expand_pref_list(list)?);
        }
    }
    let mut subdivision_location_preference_filters: HashMap<
        String,
        HashMap<String, Vec<LocationPreferenceFilterDef>>,
    > = HashMap::new();
    for (cc, subs) in &def.subdivision_location_preference_filters {
        let mut inner = HashMap::new();
        for (sub, list) in subs {
            inner.insert(sub.clone(), expand_pref_list(list)?);
        }
        subdivision_location_preference_filters.insert(cc.clone(), inner);
    }
    const VALID_NEIGHBOR_BOUNDS: [&str; 7] = [
        "gte",
        "lte",
        "all",
        "none",
        "some",
        "percentage-gte",
        "percentage-lte",
    ];
    let all_neighbor_filters = neighbor_filters
        .iter()
        .chain(
            global_location_preference_filters
                .iter()
                .flat_map(|p| &p.neighbor_filters),
        )
        .chain(
            country_location_preference_filters
                .values()
                .flatten()
                .flat_map(|p| &p.neighbor_filters),
        )
        .chain(
            subdivision_location_preference_filters
                .values()
                .flat_map(|m| m.values().flatten())
                .flat_map(|p| &p.neighbor_filters),
        );
    let mut max_neighbor_radius: Option<i32> = None;
    for nf in all_neighbor_filters {
        max_neighbor_radius = Some(max_neighbor_radius.unwrap_or(i32::MIN).max(nf.radius));
        if nf.radius <= 0 {
            return Err("All neighborFilters must have radius larger than 0.".to_string());
        }
        if nf.radius > 5000 {
            return Err(
                "Using neighborFilters with radius larger than 5000 is not supported due to performance reasons."
                    .to_string(),
            );
        }
        if !VALID_NEIGHBOR_BOUNDS.contains(&nf.bound.as_str()) {
            return Err(
                format!(
                    "neighborFilter bound (\"{}\") must be either 'gte' / 'lte' / 'all' / 'none' / 'some' / 'percentage-gte' / 'percentage-lte'.",
                    nf.bound
                ),
            );
        }
        if nf.limit.is_some() && matches!(nf.bound.as_str(), "all" | "none" | "some") {
            return Err(
                "Do not set limit when using 'all' / 'none' / 'some' as bound.".to_string(),
            );
        }
        if nf.limit.is_some_and(|l| l < 0) {
            return Err(
                "Using neighborFilters with limit less than 0 is not supported.".to_string(),
            );
        }
        if nf.limit == Some(0) && matches!(nf.bound.as_str(), "gte" | "percentage-gte") {
            return Err(
                "Using neighborFilters with limit 0 and a gte bound is not supported.".to_string(),
            );
        }
        if nf.limit.is_some_and(|l| l > 100)
            && matches!(nf.bound.as_str(), "percentage-gte" | "percentage-lte")
        {
            return Err(
                "Using neighborFilters with limit bigger than 100 and a percentage bound is not supported."
                    .to_string(),
            );
        }
        if !nf.expression.is_empty() {
            vali_expr::compile_bool_with_parent(&nf.expression)
                .map_err(|e| format!("neighborFilter expression: {e}"))?;
        }
    }
    let validate_geometry_list = |defs: &[vali_core::GeometryFilterDef]| -> Result<(), String> {
        let mode = geometry::normalized_combination_mode(defs);
        if !matches!(mode.as_str(), "union" | "intersection") {
            return Err(
                "Only union/intersection can be used as values for combinationMode.".to_string(),
            );
        }
        for g in defs {
            if !g.inclusion_mode.is_empty()
                && !matches!(g.inclusion_mode.as_str(), "include" | "exclude")
            {
                return Err(
                    "Only exclude/include can be used as values for inclusionMode.".to_string(),
                );
            }
            if !Path::new(&g.file_path).exists() {
                return Err(format!(
                    "File {} used in a geometryFilter does not exist.",
                    g.file_path
                ));
            }
            if geometry::geometries_from_file(&g.file_path).is_empty() {
                return Err(format!(
                    "Invalid GeoJSON in file {}. Try checking using https://geojsonlint.com/.",
                    g.file_path
                ));
            }
        }
        Ok(())
    };
    let geometry_def_lists = std::iter::once(def.geometry_filters.as_slice())
        .chain(def.country_geometry_filters.values().map(Vec::as_slice))
        .chain(
            def.subdivision_geometry_filters
                .values()
                .flat_map(|m| m.values().map(Vec::as_slice)),
        )
        .chain(
            def.global_location_preference_filters
                .iter()
                .map(|p| p.geometry_filters.as_slice()),
        )
        .chain(
            def.country_location_preference_filters
                .values()
                .flatten()
                .map(|p| p.geometry_filters.as_slice()),
        )
        .chain(
            def.subdivision_location_preference_filters
                .values()
                .flat_map(|m| m.values().flatten())
                .map(|p| p.geometry_filters.as_slice()),
        );
    for list in geometry_def_lists {
        validate_geometry_list(list)?;
    }
    let geometry_filters = geometry::prepare_list(&def.geometry_filters);
    let mut country_geometry_filters: HashMap<String, Vec<PreparedGeometryFilter>> = def
        .country_geometry_filters
        .iter()
        .map(|(cc, list)| (cc.clone(), geometry::prepare_list(list)))
        .collect();
    let continent_injections: &[(&str, bool, &'static str)] = match def.country_codes.as_slice() {
        [c] if c == "europe" => &[
            ("TR", true, geometry::EUROPEAN_TURKEY),
            ("RU", true, geometry::EUROPEAN_RUSSIA),
            ("KZ", true, geometry::EUROPEAN_KAZAKHSTAN),
            ("ES", false, geometry::AFRICAN_SPAIN),
        ],
        [c] if c == "asia" => &[
            ("TR", false, geometry::EUROPEAN_TURKEY),
            ("RU", false, geometry::EUROPEAN_RUSSIA),
            ("KZ", false, geometry::EUROPEAN_KAZAKHSTAN),
        ],
        [c] if c == "africa" => &[("ES", true, geometry::AFRICAN_SPAIN)],
        [c] if c == "oceania" => &[("US", true, geometry::HAWAII)],
        [c] if c == "northamerica" => &[("US", false, geometry::HAWAII)],
        _ => &[],
    };
    for (cc, inside, text) in continent_injections {
        country_geometry_filters
            .entry(cc.to_string())
            .or_default()
            .push(PreparedGeometryFilter {
                locations_inside: *inside,
                combination_mode: "intersection".to_string(),
                source: GeometrySource::Preloaded(text),
            });
    }
    let subdivision_geometry_filters: HashMap<
        String,
        HashMap<String, Vec<PreparedGeometryFilter>>,
    > = def
        .subdivision_geometry_filters
        .iter()
        .map(|(cc, subs)| {
            (
                cc.clone(),
                subs.iter()
                    .map(|(s, list)| (s.clone(), geometry::prepare_list(list)))
                    .collect(),
            )
        })
        .collect();
    let all_probabilities = std::iter::once(&def.global_location_probability)
        .chain(def.country_location_probabilities.values())
        .chain(
            def.subdivision_location_probabilities
                .values()
                .flat_map(|m| m.values()),
        )
        .filter(|p| !p.weight_overrides.is_empty());
    for probability in all_probabilities {
        if probability.default_weight <= 0 {
            return Err("defaultWeight must be larger than 0.".to_string());
        }
        for weight_override in &probability.weight_overrides {
            if weight_override.weight <= 0 {
                return Err("locationProbability.weight must be larger than 0.".to_string());
            }
            vali_expr::compile_bool(&weight_override.expression).map_err(|e| {
                format!(
                    "Invalid location probability override expression {}: {e}",
                    weight_override.expression
                )
            })?;
        }
    }
    let subdivision_distribution: HashMap<String, Vec<(String, i32)>> = def
        .subdivision_distribution
        .iter()
        .map(|(cc, subs)| {
            let mut pairs: Vec<(String, i32)> = subs.iter().map(|(s, w)| (s.clone(), *w)).collect();
            pairs.sort_by(|a, b| a.0.cmp(&b.0));
            (cc.clone(), pairs)
        })
        .collect();
    Ok(Prepared {
        country_codes,
        country_distribution,
        strategy_key: key.to_string(),
        location_count_goal: strategy.location_count_goal,
        min_min_distance: strategy.min_min_distance,
        fixed_min_distance: strategy.fixed_min_distance,
        treat_countries_as_single_subdivision: map_country_codes(
            &strategy.treat_countries_as_single_subdivision,
            strategy,
        )?,
        coverage_density_tuning_factor: strategy
            .coverage_density_tuning_factor
            .expect("coverageDensityTuningFactor is null"),
        enable_default_location_filters: def.enable_default_location_filters,
        global_location_filter,
        country_location_filters,
        subdivision_location_filters,
        subdivision_inclusions: def.subdivision_inclusions.clone(),
        subdivision_exclusions: def.subdivision_exclusions.clone(),
        subdivision_distribution,
        proximity_filter: def.proximity_filter.clone(),
        country_proximity_filters: def.country_proximity_filters.clone(),
        subdivision_proximity_filters: def.subdivision_proximity_filters.clone(),
        neighbor_filters,
        neighbor_bucket_precision: max_neighbor_radius
            .map(crate::neighbor::precision_from_max_radius),
        geometry_filters,
        country_geometry_filters,
        subdivision_geometry_filters,
        global_location_preference_filters,
        country_location_preference_filters,
        subdivision_location_preference_filters,
        global_location_probability: def.global_location_probability.clone(),
        country_location_probabilities: def.country_location_probabilities.clone(),
        subdivision_location_probabilities: def.subdivision_location_probabilities.clone(),
        location_tags: def.output.location_tags.clone(),
        pano_id_country_codes,
        global_heading_expression: def.output.global_heading_expression.clone(),
        country_heading_expressions,
        global_zoom: def.output.global_zoom,
        global_pitch: def.output.global_pitch,
    })
}
fn validate_bool_expression(name: &str, expression: &str) -> Result<(), String> {
    if expression.is_empty() {
        return Ok(());
    }
    vali_expr::compile_bool(expression)
        .map(|_| ())
        .map_err(|e| format!("{name}: {e}"))
}
fn reject_unsupported(def: &MapDefinition) -> Result<(), String> {
    let unsupported: [(&str, bool); 6] = [
        ("usedLocationsPaths", !def.used_locations_paths.is_empty()),
        (
            "externalDataFiles",
            !def.global_external_data_files.is_empty()
                || !def.country_external_data_files.is_empty()
                || !def.subdivision_external_data_files.is_empty(),
        ),
        (
            "output.panoVerificationStrategy",
            def.output
                .pano_verification_strategy
                .as_deref()
                .is_some_and(|s| !s.is_empty() && s != "None"),
        ),
        (
            "output.panoVerificationExpression",
            def.output
                .pano_verification_expression
                .as_deref()
                .is_some_and(|s| !s.is_empty()),
        ),
        (
            "countryCodes alias lefthandtraffic",
            def.country_codes.iter().any(|c| c == "lefthandtraffic"),
        ),
        (
            "countryCodes alias righthandtraffic",
            def.country_codes.iter().any(|c| c == "righthandtraffic"),
        ),
    ];
    for (name, present) in unsupported {
        if present {
            return Err(format!(
                "{name} is configured but not supported by the Rust port yet (P1)."
            ));
        }
    }
    Ok(())
}
pub(crate) fn map_country_codes(
    codes: &[String],
    strategy: &DistributionStrategy,
) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in codes {
        for part in raw.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            for code in expand_country_code(part, strategy) {
                if !out.contains(&code) {
                    out.push(code);
                }
            }
        }
    }
    Ok(out)
}
pub(crate) fn expand_country_code(code: &str, strategy: &DistributionStrategy) -> Vec<String> {
    let codes_from = |weights: &[(&str, i32)]| {
        weights
            .iter()
            .filter(|(_, w)| *w > 0)
            .map(|(c, _)| c.to_string())
            .collect::<Vec<_>>()
    };
    match code {
        "*" | "world" => codes_from(default_distribution(strategy)),
        "europe" => codes_from(cw::preset(cw::EUROPE)),
        "asia" => codes_from(cw::preset(cw::ASIA)),
        "africa" => codes_from(cw::preset(cw::AFRICA)),
        "southamerica" => codes_from(cw::preset(cw::SOUTH_AMERICA)),
        "northamerica" => codes_from(cw::preset(cw::NORTH_AMERICA)),
        "oceania" => codes_from(cw::preset(cw::OCEANIA)),
        _ => vec![code.to_uppercase()],
    }
}
pub(crate) fn default_distribution(
    strategy: &DistributionStrategy,
) -> &'static [(&'static str, i32)] {
    match strategy
        .country_distribution_from_map
        .as_deref()
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("aarw") => cw::preset(cw::ARBITRARY_RURAL_WORLD),
        Some("aaw") => cw::preset(cw::WORLD),
        Some("acw") => cw::preset(cw::COMMUNITY_WORLD),
        Some("abw") => cw::preset(cw::BALANCED_WORLD),
        Some("aiw") => cw::preset(cw::IMPROVED_WORLD),
        Some("proworld") => cw::preset(cw::PRO_WORLD),
        Some("aow") => cw::preset(cw::OFFICIAL_WORLD),
        Some("rainboltworld") => cw::preset(cw::RAINBOLT_WORLD),
        Some("geotime") => cw::preset(cw::GEO_TIME),
        Some("lerg") => cw::preset(cw::LESS_EXTREME_REGION_GUESSING),
        Some("amw") => cw::preset(cw::MOVING_WORLD),
        Some("yellowbelly") => cw::preset(cw::YELLOW_BELLY),
        Some("5kable") => cw::preset(cw::A5KABLE_WORLD),
        Some(s) if !s.is_empty() => &[],
        _ => cw::preset(cw::COMMUNITY_WORLD),
    }
}
pub(crate) fn resolve_country_distribution(
    def: &MapDefinition,
    expanded_codes: &[String],
) -> Result<Vec<(String, i32)>, String> {
    let owned = |weights: &[(&str, i32)]| {
        weights
            .iter()
            .filter(|(_, w)| *w > 0)
            .map(|(c, w)| (c.to_string(), *w))
            .collect::<Vec<_>>()
    };
    let given: Vec<(String, i32)> = {
        let mut pairs: Vec<(String, i32)> = def
            .country_distribution
            .iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect();
        pairs.sort_by(|a, b| a.0.cmp(&b.0));
        pairs
    };
    if !given.is_empty() {
        return Ok(given);
    }
    let raw: Vec<&str> = def.country_codes.iter().map(String::as_str).collect();
    let result = match raw.as_slice() {
        ["*"] => owned(default_distribution(&def.distribution_strategy)),
        ["europe"] => owned(cw::preset(cw::EUROPE)),
        ["asia"] => owned(cw::preset(cw::ASIA)),
        ["africa"] => owned(cw::preset(cw::AFRICA)),
        ["southamerica"] => owned(cw::preset(cw::SOUTH_AMERICA)),
        ["northamerica"] => owned(cw::preset(cw::NORTH_AMERICA)),
        ["oceania"] => owned(cw::preset(cw::OCEANIA)),
        _ if expanded_codes.len() == 1 => vec![(expanded_codes[0].clone(), 10)],
        _ => default_distribution(&def.distribution_strategy)
            .iter()
            .filter(|(c, _)| expanded_codes.iter().any(|e| e == c))
            .map(|(c, w)| (c.to_string(), *w))
            .collect(),
    };
    Ok(result)
}
fn expand_country_dictionary(
    dict: &HashMap<String, String>,
    strategy: &DistributionStrategy,
) -> Result<HashMap<String, String>, String> {
    let mut sorted: Vec<(&String, &String)> = dict.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    let mut out: HashMap<String, String> = HashMap::new();
    for (key, value) in sorted {
        for code in map_country_codes(std::slice::from_ref(key), &DistributionStrategy::default())?
        {
            out.entry(code).or_insert_with(|| value.clone());
        }
    }
    let _ = strategy;
    Ok(out)
}
