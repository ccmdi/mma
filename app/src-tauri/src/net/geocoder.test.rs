use super::*;
use mma_geo::haversine_m;
use reverse_geocoder::ReverseGeocoder;

/// The oracle: `ReverseGeocoder::search` ranks by chord distance too, so it must return
/// the exact same record.
fn assert_agrees(oracle: &ReverseGeocoder, lat: f64, lng: f64) {
    let want = oracle.search((lat, lng)).record;
    let got = reverse_geocode(lat, lng).expect("the dataset covers every coordinate");
    if got.city == want.name && got.admin == want.admin1 && got.country_code == want.cc {
        return;
    }
    // Only an exact distance tie may pick a different record; anything else is a bug.
    let theirs = haversine_m(lat, lng, want.lat, want.lon);
    let i = nearest(lat, lng).unwrap();
    let (plat, plng) = cities().lat_lng(i);
    let mine = haversine_m(lat, lng, plat, plng);
    assert!(
        (mine - theirs).abs() < 1.0,
        "({lat}, {lng}): got {}/{}/{} at {mine:.1}m, oracle {}/{}/{} at {theirs:.1}m",
        got.city,
        got.admin,
        got.country_code,
        want.name,
        want.admin1,
        want.cc,
    );
}

fn axis_value(c: &Cities, i: usize, axis: usize) -> f64 {
    let (x, y, z) = c.xyz(i);
    [x, y, z][axis]
}

/// Every node in `node`'s subtree must sit on the correct side of `pivot`.
fn assert_side(c: &Cities, node: usize, axis: usize, pivot: f64, le: bool) {
    if node >= c.count {
        return;
    }
    let v = axis_value(c, node, axis);
    assert!(
        if le { v <= pivot } else { v >= pivot },
        "kd order violated: node {node} has {v} on axis {axis}, pivot {pivot}"
    );
    assert_side(c, 2 * node + 1, axis, pivot, le);
    assert_side(c, 2 * node + 2, axis, pivot, le);
}

#[test]
fn header_matches_the_generator() {
    let c = cities();
    assert_eq!(c.count, 144_563);
}

/// The index is the array order, so if this holds the tree is sound.
#[test]
fn points_are_in_implicit_kd_tree_order() {
    let c = cities();
    for node in 0..c.count {
        let depth = (usize::BITS - (node + 1).leading_zeros() - 1) as usize;
        let axis = depth % 3;
        let pivot = axis_value(c, node, axis);
        assert_side(c, 2 * node + 1, axis, pivot, true);
        assert_side(c, 2 * node + 2, axis, pivot, false);
    }
}

#[test]
fn agrees_with_the_kd_tree_oracle_over_random_coordinates() {
    let oracle = ReverseGeocoder::new();
    fastrand::seed(0x9E3779B9);
    for _ in 0..5_000 {
        let lat = fastrand::f64() * 180.0 - 90.0;
        let lng = fastrand::f64() * 360.0 - 180.0;
        assert_agrees(&oracle, lat, lng);
    }
}

#[test]
fn agrees_with_the_oracle_at_the_poles_and_the_antimeridian() {
    let oracle = ReverseGeocoder::new();
    let edges = [
        (90.0, 0.0),
        (-90.0, 0.0),
        (89.9999, 179.9999),
        (-89.9999, -179.9999),
        (0.0, 180.0),
        (0.0, -180.0),
        (0.0, 0.0),
        (78.22334, 15.6469),
        (-77.846, 166.6683),
    ];
    for (lat, lng) in edges {
        assert_agrees(&oracle, lat, lng);
    }
}

#[test]
fn agrees_with_the_oracle_on_every_city_s_own_coordinate() {
    let oracle = ReverseGeocoder::new();
    let c = cities();
    let step = c.count / 2_000;
    for i in (0..c.count).step_by(step.max(1)) {
        let (lat, lng) = c.lat_lng(i);
        assert_agrees(&oracle, lat, lng);
    }
}
