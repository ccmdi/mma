use rustc_hash::FxHashSet;
use vali_core::Location;
use vali_expr::error::ExprError;
const RESOLUTION_GEN4: i32 = 8192;
pub const COUNTRY_CODES_ACCEPTABLE_WITHOUT_DESCRIPTION: [&str; 23] = [
    "CX", "CC", "MP", "GU", "EG", "ML", "MG", "PN", "GL", "MN", "KR", "FO", "UG", "KG", "RW", "LB",
    "RE", "MQ", "NP", "PK", "BY", "UM", "XK",
];
pub const SUBDIVISION_CODES_ACCEPTABLE_WITHOUT_DESCRIPTION: [&str; 4] =
    ["NO-21", "CA-NU", "US-AK", "BR-PE"];
pub fn filter(
    locations: &[Location],
    location_filter_expression: Option<&str>,
    proximity: Option<&crate::proximity::ProximityIndex>,
    geometry: Option<&crate::geometry::GeometryContext>,
    neighbors: Option<(
        &crate::neighbor::NeighborContext,
        &[&crate::neighbor::NeighborFilterSpec],
    )>,
    enable_default_location_filters: bool,
    deterministic: bool,
) -> Result<Vec<u32>, ExprError> {
    let all: Vec<u32> = (0..locations.len() as u32).collect();
    filter_subset(
        locations,
        &all,
        location_filter_expression,
        proximity,
        geometry,
        neighbors,
        enable_default_location_filters,
        deterministic,
    )
}
#[allow(clippy::too_many_arguments)]
pub fn filter_subset(
    locations: &[Location],
    candidates: &[u32],
    location_filter_expression: Option<&str>,
    proximity: Option<&crate::proximity::ProximityIndex>,
    geometry: Option<&crate::geometry::GeometryContext>,
    neighbors: Option<(
        &crate::neighbor::NeighborContext,
        &[&crate::neighbor::NeighborFilterSpec],
    )>,
    enable_default_location_filters: bool,
    deterministic: bool,
) -> Result<Vec<u32>, ExprError> {
    let expression = location_filter_expression.unwrap_or("");
    let has_expression = !expression.is_empty();
    let apply_tunnels = !has_expression || !expression.contains("Tunnels");
    let apply_description = !has_expression
        || (!expression.contains("DescriptionLength") && !expression.contains("IsScout"));
    let compiled = if has_expression {
        Some(vali_expr::compile_bool(expression)?)
    } else {
        None
    };
    let mut kept: Vec<u32> = Vec::new();
    for &i in candidates {
        let loc = &locations[i as usize];
        if enable_default_location_filters && !resolution_gate(loc) {
            continue;
        }
        if apply_tunnels && loc.osm.tunnels10 != 0 {
            continue;
        }
        if apply_description && !description_gate(loc) {
            continue;
        }
        if let Some(f) = &compiled {
            if !f.eval(loc) {
                continue;
            }
        }
        if let Some(index) = proximity {
            if !index.matches(loc.lat, loc.lng) {
                continue;
            }
        }
        if let Some(context) = geometry {
            if !context.matches(loc.lat, loc.lng) {
                continue;
            }
        }
        kept.push(i);
    }
    if let Some((context, specs)) = neighbors {
        for &spec in specs {
            kept = crate::neighbor::apply_neighbor_filter(locations, context, spec, &kept);
        }
    }
    let mut seen: FxHashSet<i64> = FxHashSet::default();
    kept.retain(|&i| seen.insert(locations[i as usize].node_id));
    if deterministic {
        kept.sort_by_key(|&i| locations[i as usize].node_id);
    }
    Ok(kept)
}
fn resolution_gate(loc: &Location) -> bool {
    match loc.nominatim.country_code.as_str() {
        "FI" => loc.google.resolution_height >= RESOLUTION_GEN4 || loc.google.year < 2022,
        "EC" | "NG" => loc.google.resolution_height >= RESOLUTION_GEN4 || loc.google.year < 2021,
        _ => true,
    }
}
fn description_gate(loc: &Location) -> bool {
    let desc_ok = matches!(loc.google.description_length, None | Some(1..)) && !loc.google.is_scout;
    desc_ok
        || COUNTRY_CODES_ACCEPTABLE_WITHOUT_DESCRIPTION
            .contains(&loc.nominatim.country_code.as_str())
        || SUBDIVISION_CODES_ACCEPTABLE_WITHOUT_DESCRIPTION
            .contains(&loc.nominatim.subdivision_code.as_str())
}
