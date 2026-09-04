use rust_decimal::Decimal;
use rustc_hash::FxHashMap;
use vali_core::Location;
use vali_geo::geohash::HashPrecision;
use vali_geo::{bucketize, encode, nearby, points_are_closer_than};
use vali_expr::CompiledBool;
pub fn precision_from_max_radius(max_radius: i32) -> HashPrecision {
    if max_radius > 500 {
        HashPrecision::Size_km_5x5
    } else {
        HashPrecision::Size_km_1x1
    }
}
pub struct NeighborContext {
    buckets: FxHashMap<u64, Vec<u32>>,
    precision: HashPrecision,
}
pub struct NeighborFilterSpec {
    pub compiled: Option<CompiledBool>,
    prefilter: Option<CompiledBool>,
    pub radius: i32,
    pub bound: String,
    pub limit: Option<i32>,
    pub check_each_cardinal_direction_separately: bool,
}
fn is_pre_filter_safe_bound(bound: &str) -> bool {
    matches!(bound, "some" | "gte" | "lte" | "none")
}
impl NeighborFilterSpec {
    pub fn from_def(def: &vali_core::NeighborFilterDef) -> NeighborFilterSpec {
        let prefilter = if is_pre_filter_safe_bound(&def.bound)
            && !def.expression.is_empty()
        {
            vali_expr::neighbor_only_expression(&def.expression)
                .and_then(|e| vali_expr::compile_bool(&e).ok())
        } else {
            None
        };
        NeighborFilterSpec {
            compiled: if def.expression.is_empty() {
                None
            } else {
                Some(
                    vali_expr::compile_bool_with_parent(&def.expression)
                        .expect("validated earlier"),
                )
            },
            prefilter,
            radius: def.radius,
            bound: def.bound.clone(),
            limit: def.limit,
            check_each_cardinal_direction_separately: def
                .check_each_cardinal_direction_separately,
        }
    }
}
impl NeighborContext {
    pub fn build(
        all_locations: &[Location],
        precision: HashPrecision,
    ) -> NeighborContext {
        let points: Vec<(f64, f64)> = all_locations
            .iter()
            .map(|l| (l.lat, l.lng))
            .collect();
        NeighborContext {
            buckets: bucketize(&points, Some(precision)),
            precision,
        }
    }
}
#[derive(Clone, Copy)]
enum Direction {
    North,
    East,
    South,
    West,
}
const DIRECTIONS: [Direction; 4] = [
    Direction::North,
    Direction::East,
    Direction::South,
    Direction::West,
];
fn is_in_direction(direction: Direction, l: &Location, l2: &Location) -> bool {
    match direction {
        Direction::West => l.lng < l2.lng,
        Direction::East => l.lng > l2.lng,
        Direction::North => l.lat > l2.lat,
        Direction::South => l.lat < l2.lat,
    }
}
pub fn apply_neighbor_filter(
    locations: &[Location],
    context: &NeighborContext,
    spec: &NeighborFilterSpec,
    candidates: &[u32],
) -> Vec<u32> {
    let prefiltered: Option<FxHashMap<u64, Vec<u32>>> = spec
        .prefilter
        .as_ref()
        .map(|p| {
            context
                .buckets
                .iter()
                .filter_map(|(&key, list)| {
                    let kept: Vec<u32> = list
                        .iter()
                        .copied()
                        .filter(|&i| p.eval(&locations[i as usize]))
                        .collect();
                    (!kept.is_empty()).then_some((key, kept))
                })
                .collect()
        });
    let buckets = prefiltered.as_ref().unwrap_or(&context.buckets);
    let radius_squared = spec.radius as f64 * spec.radius as f64;
    candidates
        .iter()
        .copied()
        .filter(|&i| survives(
            locations,
            buckets,
            context.precision,
            spec,
            radius_squared,
            &locations[i as usize],
        ))
        .collect()
}
fn survives(
    locations: &[Location],
    buckets: &FxHashMap<u64, Vec<u32>>,
    precision: HashPrecision,
    spec: &NeighborFilterSpec,
    radius_squared: f64,
    l: &Location,
) -> bool {
    let hash = encode(l.lat, l.lng, precision);
    let in_radius = |l2: &Location| {
        l.node_id != l2.node_id
            && points_are_closer_than(l.lat, l.lng, l2.lat, l2.lng, radius_squared)
    };
    let expr_ok = |l2: &Location| {
        spec.compiled.as_ref().is_none_or(|f| f.eval_with_parent(l2, l))
    };
    let matching = |l2: &Location| in_radius(l2) && expr_ok(l2);
    let neighbors = || nearby(buckets, hash).map(|i| &locations[i as usize]);
    let count_matching = |dir: Option<Direction>| {
        neighbors()
            .filter(|l2| dir.is_none_or(|d| is_in_direction(d, l, l2)))
            .filter(|l2| { matching(l2) })
            .count() as i32
    };
    let any_matching = |dir: Option<Direction>| {
        neighbors()
            .any(|l2| dir.is_none_or(|d| is_in_direction(d, l, l2)) && matching(l2))
    };
    let separately = spec.check_each_cardinal_direction_separately;
    let bound = spec.bound.as_str();
    let limit = spec.limit;
    if bound == "gte" && separately {
        return DIRECTIONS
            .iter()
            .any(|&d| limit.is_some_and(|lim| count_matching(Some(d)) >= lim));
    }
    if (bound == "gte" && !separately && limit == Some(1)) || bound == "some" {
        return any_matching(None);
    }
    if bound == "gte" && !separately {
        return limit.is_some_and(|lim| count_matching(None) >= lim);
    }
    if (bound == "lte" && separately && limit == Some(0))
        || (bound == "none" && separately)
    {
        return DIRECTIONS.iter().any(|&d| !any_matching(Some(d)));
    }
    if (bound == "lte" && !separately && limit == Some(0)) || bound == "none" {
        return !any_matching(None);
    }
    if bound == "lte" && separately && limit.is_some_and(|lim| lim > 0) {
        return DIRECTIONS
            .iter()
            .any(|&d| limit.is_some_and(|lim| count_matching(Some(d)) <= lim));
    }
    if bound == "lte" && !separately {
        return limit.is_some_and(|lim| count_matching(None) <= lim);
    }
    if bound == "all" {
        let mut any = false;
        for l2 in neighbors().filter(|l2| in_radius(l2)) {
            if !expr_ok(l2) {
                return false;
            }
            any = true;
        }
        return any;
    }
    if bound == "percentage-gte" || bound == "percentage-lte" {
        let mut all_count = 0i64;
        let mut match_count = 0i64;
        for l2 in neighbors() {
            if in_radius(l2) {
                all_count += 1;
                if expr_ok(l2) {
                    match_count += 1;
                }
            }
        }
        let percentage = if all_count > 0 {
            Decimal::from(match_count) / Decimal::from(all_count) * Decimal::from(100)
        } else {
            Decimal::ZERO
        };
        return match (bound, limit) {
            (_, None) => false,
            ("percentage-gte", Some(lim)) => percentage >= Decimal::from(lim),
            (_, Some(lim)) => percentage <= Decimal::from(lim),
        };
    }
    panic!(
        "Neighbor filter combination is not valid/implemented. Bound: {bound}. Check separately: {separately}. Limit: {limit:?}"
    );
}
