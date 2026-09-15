use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct FilterGolden {
    locations: Vec<vali_core::Location>,
    cases: Vec<FilterCase>,
}

#[derive(Deserialize)]
struct FilterCase {
    expression: Option<String>,
    defaults: bool,
    deterministic: bool,
    #[serde(default)]
    proximity_points: Option<Vec<(f64, f64)>>,
    #[serde(default)]
    proximity_radius: Option<i32>,
    #[serde(default)]
    neighbor: Option<NeighborGolden>,
    #[serde(default)]
    geometry: Option<GeometryGolden>,
    node_ids: Vec<i64>,
}

#[derive(Deserialize)]
struct NeighborGolden {
    radius: i32,
    bound: String,
    limit: Option<i32>,
    separately: bool,
    expression: String,
}

#[derive(Deserialize)]
struct GeometryGolden {
    combination_mode: String,
    filters: Vec<GeometryFilterGolden>,
}

#[derive(Deserialize)]
struct GeometryFilterGolden {
    inclusion_mode: String,
    geojson: String,
}

#[test]
fn filter_pipeline_matches_oracle() {
    let path: PathBuf =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ru-al.filter.json");
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|e| panic!("cannot read golden fixture {}: {e}", path.display()));
    let golden: FilterGolden = serde_json::from_slice(&bytes).expect("parse filter golden");

    assert!(!golden.locations.is_empty(), "golden had no locations");
    assert!(!golden.cases.is_empty(), "golden had no filter cases");

    let mut failures: Vec<String> = Vec::new();

    for (ci, case) in golden.cases.iter().enumerate() {
        let proximity = case.proximity_points.as_ref().map(|points| {
            vali_generate::proximity::ProximityIndex::build(
                points.clone(),
                case.proximity_radius.unwrap(),
            )
        });
        let neighbor = case.neighbor.as_ref().map(|n| {
            let spec = vali_generate::neighbor::NeighborFilterSpec::from_def(
                &vali_core::NeighborFilterDef {
                    check_each_cardinal_direction_separately: n.separately,
                    radius: n.radius,
                    expression: n.expression.clone(),
                    limit: n.limit,
                    bound: n.bound.clone(),
                },
            );
            let context = vali_generate::neighbor::NeighborContext::build(
                &golden.locations,
                vali_generate::neighbor::precision_from_max_radius(n.radius),
            );
            (context, vec![spec])
        });
        let neighbor_specs: Vec<&vali_generate::neighbor::NeighborFilterSpec> = neighbor
            .as_ref()
            .map(|(_, specs)| specs.iter().collect())
            .unwrap_or_default();
        let geometry_context = case.geometry.as_ref().map(|g| {
            let filters = g
                .filters
                .iter()
                .map(|f| {
                    let text = match f.geojson.strip_prefix("region:") {
                        Some("european-turkey") => vali_generate::geometry::EUROPEAN_TURKEY,
                        Some("european-russia") => vali_generate::geometry::EUROPEAN_RUSSIA,
                        Some("european-kazakhstan") => vali_generate::geometry::EUROPEAN_KAZAKHSTAN,
                        Some("african-spain") => vali_generate::geometry::AFRICAN_SPAIN,
                        Some("hawaii") => vali_generate::geometry::HAWAII,
                        Some(other) => panic!("unknown region {other}"),
                        None => f.geojson.as_str(),
                    };
                    (
                        f.inclusion_mode != "exclude",
                        vali_generate::geometry::parse_geojson(text).expect("golden geojson"),
                    )
                })
                .collect();
            vali_generate::geometry::GeometryContext::build(&g.combination_mode, filters)
                .expect("geometry context")
        });

        let kept = vali_generate::filter(
            &golden.locations,
            case.expression.as_deref(),
            proximity.as_ref(),
            geometry_context.as_ref(),
            neighbor
                .as_ref()
                .map(|(ctx, _)| (ctx, neighbor_specs.as_slice())),
            case.defaults,
            case.deterministic,
        );
        let node_ids: Vec<i64> = match kept {
            Ok(indices) => indices
                .iter()
                .map(|&i| golden.locations[i as usize].node_id)
                .collect(),
            Err(e) => {
                failures.push(format!(
                    "case {ci} (expr={:?}): compile error {e}",
                    case.expression
                ));
                continue;
            }
        };
        if node_ids != case.node_ids {
            let first = node_ids
                .iter()
                .zip(&case.node_ids)
                .position(|(a, b)| a != b);
            failures.push(format!(
                "case {ci} (expr={:?}, defaults={}, deterministic={}): len {} vs {}, first divergence {:?}",
                case.expression,
                case.defaults,
                case.deterministic,
                node_ids.len(),
                case.node_ids.len(),
                first
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{}/{} filter cases diverged from the oracle:\n{}",
        failures.len(),
        golden.cases.len(),
        failures.join("\n")
    );
}
