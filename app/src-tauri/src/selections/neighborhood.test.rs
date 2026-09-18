use super::*;
use crate::test_util::{loc, Fx};
use crate::types::RawExtra;

/// Metres per degree of latitude, so a test can place a point a known distance north.
const DEG_PER_M: f64 = 1.0 / mma_geo::M_PER_DEG;

fn at(id: u32, north_m: f64) -> Location {
    loc(id, north_m * DEG_PER_M, 0.0)
}

fn ids(hits: &[Neighbor]) -> Vec<u32> {
    hits.iter().map(|n| n.id).collect()
}

#[test]
fn within_answers_nearest_first() {
    let fx = Fx::adds(vec![at(1, 90.0), at(2, 30.0), at(3, 60.0)]);
    let index = Index::build(&fx.view(), 100.0, &[]);
    assert_eq!(ids(&index.within(0.0, 0.0)), vec![2, 3, 1]);
}

#[test]
fn equidistant_neighbors_break_the_tie_by_id() {
    let fx = Fx::adds(vec![at(7, 40.0), at(3, -40.0), at(5, 40.0)]);
    let index = Index::build(&fx.view(), 100.0, &[]);
    assert_eq!(ids(&index.within(0.0, 0.0)), vec![3, 5, 7]);
}

#[test]
fn a_point_at_the_query_coordinate_is_a_hit() {
    let fx = Fx::adds(vec![at(1, 0.0), at(2, 50.0)]);
    let hits = index_within(&fx, 100.0, 0.0, 0.0);
    assert_eq!(ids(&hits), vec![1, 2]);
    assert_eq!(hits[0].dist_m, 0.0);
}

fn index_within(fx: &Fx, radius_m: f64, lat: f64, lng: f64) -> Vec<Neighbor> {
    Index::build(&fx.view(), radius_m, &[]).within(lat, lng)
}

#[test]
fn a_point_beyond_the_built_radius_is_not_a_hit() {
    let fx = Fx::adds(vec![at(1, 50.0), at(2, 150.0)]);
    assert_eq!(ids(&index_within(&fx, 100.0, 0.0, 0.0)), vec![1]);
}

#[test]
fn a_degenerate_radius_answers_the_points_at_exactly_that_coordinate() {
    let fx = Fx::adds(vec![at(1, 0.0), at(2, 10.0), at(3, 0.0)]);
    assert_eq!(ids(&index_within(&fx, 0.0, 0.0, 0.0)), vec![1, 3]);
    assert_eq!(ids(&index_within(&fx, 0.0, -0.0, 0.0)), vec![1, 3]);
    assert!(index_within(&fx, 0.0, 1.0, 0.0).is_empty());
}

#[test]
fn a_neighbor_carries_the_named_fields_it_had_and_no_others() {
    let mut a = at(1, 10.0);
    a.heading = 42.0;
    a.extra = RawExtra::from_value(&serde_json::json!({ "quality": 3 }));
    let mut b = at(2, 20.0);
    b.heading = 7.0;
    let fx = Fx::adds(vec![a, b]);
    let want = ["heading".to_string(), "quality".to_string()];
    let hits = Index::build(&fx.view(), 100.0, &want).within(0.0, 0.0);

    assert_eq!(
        serde_json::to_value(&hits[0].fields).unwrap(),
        serde_json::json!({ "heading": 42.0, "quality": 3 })
    );
    // `quality` is absent on 2, so it is missing rather than null.
    assert_eq!(
        serde_json::to_value(&hits[1].fields).unwrap(),
        serde_json::json!({ "heading": 7.0 })
    );
}

#[test]
fn a_neighbor_serializes_its_fields_beside_its_coordinates() {
    let mut a = at(1, 10.0);
    a.extra = RawExtra::from_value(&serde_json::json!({ "quality": 3 }));
    let fx = Fx::adds(vec![a]);
    let want = ["quality".to_string()];
    let hits = Index::build(&fx.view(), 100.0, &want).within(0.0, 0.0);
    let json = serde_json::to_value(&hits[0]).unwrap();

    assert_eq!(json["id"], 1);
    assert_eq!(json["quality"], 3);
    assert!(json["distM"].as_f64().unwrap() > 0.0);
}

#[test]
fn the_grid_walk_from_a_bare_coordinate_agrees_with_the_walk_from_a_point() {
    let pts: Vec<(f64, f64)> = (0..40)
        .map(|i| (f64::from(i) * 3.0 * DEG_PER_M, f64::from(i % 7) * DEG_PER_M))
        .collect();
    let grid = Grid::build(&pts, 25.0).expect("a positive radius builds");
    for (pi, &(lat, lng)) in pts.iter().enumerate() {
        let mut from_point = Vec::new();
        grid.for_each_neighbor(pi, 0, |pj| {
            from_point.push(pj);
            false
        });
        let mut from_coord = Vec::new();
        grid.for_each_near(lat, lng, |pj| {
            if pj != pi {
                from_coord.push(pj);
            }
            false
        });
        from_point.sort_unstable();
        from_coord.sort_unstable();
        assert_eq!(from_point, from_coord, "point {pi}");
    }
}
