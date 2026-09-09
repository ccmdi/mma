use super::*;
use mma_geo::haversine_m;
use reverse_geocoder::ReverseGeocoder;

#[repr(align(4))]
struct Aligned<B: ?Sized>(B);
static TABLE: &Aligned<[u8]> = &Aligned(*include_bytes!("../../../data/cities.bin"));

fn geocoder() -> Geocoder<'static> {
    Geocoder::new(&TABLE.0).unwrap()
}

/// The oracle: `ReverseGeocoder::search` ranks by chord distance too, so it must return
/// the exact same record.
fn assert_agrees(g: &Geocoder<'_>, oracle: &ReverseGeocoder, lat: f64, lng: f64) {
    let want = oracle.search((lat, lng)).record;
    let got = g.nearest(lat, lng).expect("the dataset covers every coordinate");
    if got.name == want.name && got.admin1 == want.admin1 && got.country_code == want.cc {
        return;
    }
    // Only an exact distance tie may pick a different record; anything else is a bug.
    let theirs = haversine_m(lat, lng, want.lat, want.lon);
    let mine = haversine_m(lat, lng, got.lat, got.lng);
    assert!(
        (mine - theirs).abs() < 1.0,
        "({lat}, {lng}): got {}/{}/{} at {mine:.1}m, oracle {}/{}/{} at {theirs:.1}m",
        got.name,
        got.admin1,
        got.country_code,
        want.name,
        want.admin1,
        want.cc,
    );
}

fn axis_value(g: &Geocoder<'_>, i: usize, axis: usize) -> f64 {
    let (x, y, z) = g.point(i);
    [x, y, z][axis]
}

/// Every node in `node`'s subtree must sit on the correct side of `pivot`.
fn assert_side(g: &Geocoder<'_>, node: usize, axis: usize, pivot: f64, le: bool) {
    if node >= g.count {
        return;
    }
    let v = axis_value(g, node, axis);
    assert!(
        if le { v <= pivot } else { v >= pivot },
        "kd order violated: node {node} has {v} on axis {axis}, pivot {pivot}"
    );
    assert_side(g, 2 * node + 1, axis, pivot, le);
    assert_side(g, 2 * node + 2, axis, pivot, le);
}

#[test]
fn header_matches_the_generator() {
    assert_eq!(geocoder().len(), 144_563);
}

/// The index is the array order, so if this holds the tree is sound.
#[test]
fn points_are_in_implicit_kd_tree_order() {
    let g = geocoder();
    for node in 0..g.count {
        let depth = (usize::BITS - (node + 1).leading_zeros() - 1) as usize;
        let axis = depth % 3;
        let pivot = axis_value(&g, node, axis);
        assert_side(&g, 2 * node + 1, axis, pivot, true);
        assert_side(&g, 2 * node + 2, axis, pivot, false);
    }
}

#[test]
fn agrees_with_the_kd_tree_oracle_over_random_coordinates() {
    let g = geocoder();
    let oracle = ReverseGeocoder::new();
    fastrand::seed(0x9E3779B9);
    for _ in 0..5_000 {
        let lat = fastrand::f64() * 180.0 - 90.0;
        let lng = fastrand::f64() * 360.0 - 180.0;
        assert_agrees(&g, &oracle, lat, lng);
    }
}

#[test]
fn agrees_with_the_oracle_at_the_poles_and_the_antimeridian() {
    let g = geocoder();
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
        assert_agrees(&g, &oracle, lat, lng);
    }
}

#[test]
fn agrees_with_the_oracle_on_every_city_s_own_coordinate() {
    let g = geocoder();
    let oracle = ReverseGeocoder::new();
    let step = g.count / 2_000;
    for i in (0..g.count).step_by(step.max(1)) {
        let r = g.get(i).unwrap();
        assert_agrees(&g, &oracle, r.lat, r.lng);
    }
}

#[test]
fn rejects_a_misaligned_table() {
    let mut buf = vec![0u8; TABLE.0.len() + 4];
    let shift = if (buf.as_ptr() as usize + 1) % 4 == 0 { 2 } else { 1 };
    buf[shift..shift + TABLE.0.len()].copy_from_slice(&TABLE.0);
    assert_eq!(Geocoder::new(&buf[shift..shift + TABLE.0.len()]).err(), Some(Error::Misaligned));
}

#[test]
fn rejects_garbage() {
    assert_eq!(Geocoder::new(b"nope").err(), Some(Error::Truncated));
    assert_eq!(Geocoder::new(&[0u8; 64]).err(), Some(Error::BadMagic));
}
