use super::*;
use crate::M_PER_DEG;

/// Deterministic [0, 1) source (SplitMix64), so every run draws the same points.
fn rng(seed: u64) -> impl FnMut() -> f64 {
    let mut state = seed;
    move || {
        state = state.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn ring(pts: &[(f64, f64)]) -> Vec<[f64; 2]> {
    let mut out: Vec<[f64; 2]> = pts.iter().map(|&(lng, lat)| [lng, lat]).collect();
    out.push(out[0]);
    out
}

fn square(west: f64, south: f64, east: f64, north: f64) -> Vec<Vec<[f64; 2]>> {
    vec![ring(&[
        (west, south),
        (east, south),
        (east, north),
        (west, north),
    ])]
}

fn prepared(polygons: &[Vec<Vec<[f64; 2]>>]) -> PreparedPolygons<'_> {
    PreparedPolygons::new(polygons.iter().map(|p| p.as_slice()))
}

#[test]
fn random_points_land_inside_and_stop_at_count() {
    let poly = square(10.0, 50.0, 11.0, 51.0);
    let polys = prepared(std::slice::from_ref(&poly));
    let pts = random_points(&polys, 500, rng(1));
    assert_eq!(pts.len(), 500);
    for [lng, lat] in pts {
        assert!((10.0..=11.0).contains(&lng) && (50.0..=51.0).contains(&lat));
    }
}

#[test]
fn random_points_respect_holes_and_concavity() {
    // A U-shape with a hole in its left arm: inside means inside the U, outside the hole.
    let u = vec![
        ring(&[
            (0.0, 0.0),
            (3.0, 0.0),
            (3.0, 3.0),
            (2.0, 3.0),
            (2.0, 1.0),
            (1.0, 1.0),
            (1.0, 3.0),
            (0.0, 3.0),
        ]),
        ring(&[(0.2, 0.2), (0.8, 0.2), (0.8, 0.8), (0.2, 0.8)]),
    ];
    let polys = prepared(std::slice::from_ref(&u));
    let pts = random_points(&polys, 300, rng(2));
    assert!(!pts.is_empty());
    for [lng, lat] in pts {
        let in_notch = (1.0..2.0).contains(&lng) && lat > 1.0;
        let in_hole = (0.2..0.8).contains(&lng) && (0.2..0.8).contains(&lat);
        assert!(!in_notch && !in_hole, "({lng}, {lat}) escaped the U");
    }
}

#[test]
fn random_points_cover_every_part_of_a_multipolygon() {
    let parts = [square(-10.0, 0.0, -9.0, 1.0), square(9.0, 0.0, 10.0, 1.0)];
    let polys = prepared(&parts);
    let pts = random_points(&polys, 400, rng(3));
    let west = pts.iter().filter(|p| p[0] < 0.0).count();
    assert!(west > 0 && west < pts.len());
}

#[test]
fn random_points_cross_the_antimeridian() {
    let poly = square(179.5, -1.0, 180.5, 1.0);
    let polys = prepared(std::slice::from_ref(&poly));
    let pts = random_points(&polys, 200, rng(4));
    assert_eq!(pts.len(), 200);
    for [lng, lat] in pts {
        assert!((-180.0..180.0).contains(&lng));
        assert!(lng >= 179.5 || lng <= -179.5, "lng {lng} outside the strip");
        assert!((-1.0..=1.0).contains(&lat));
    }
}

#[test]
fn random_points_give_up_on_an_empty_shape() {
    let polys = prepared(&[]);
    assert!(random_points(&polys, 100, rng(5)).is_empty());
    // A degenerate sliver never accepts, so the attempt cap answers instead of spinning.
    let line = vec![ring(&[(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)])];
    let polys = prepared(std::slice::from_ref(&line));
    assert!(random_points(&polys, 100, rng(6)).is_empty());
}

#[test]
fn random_points_are_deterministic_for_one_seed() {
    let poly = square(10.0, 50.0, 11.0, 51.0);
    let polys = prepared(std::slice::from_ref(&poly));
    assert_eq!(
        random_points(&polys, 50, rng(7)),
        random_points(&polys, 50, rng(7))
    );
    assert_ne!(
        random_points(&polys, 50, rng(7)),
        random_points(&polys, 50, rng(8))
    );
}

#[test]
fn poisson_points_land_inside() {
    let poly = square(10.0, 50.0, 11.0, 51.0);
    let polys = prepared(std::slice::from_ref(&poly));
    let pts = poisson_points(&polys, 5_000.0, rng(9));
    assert!(!pts.is_empty());
    for [lng, lat] in pts {
        assert!((10.0..=11.0).contains(&lng) && (50.0..=51.0).contains(&lat));
    }
}

#[test]
fn poisson_points_keep_the_minimum_distance() {
    let poly = square(10.0, 50.0, 10.5, 50.5);
    let polys = prepared(std::slice::from_ref(&poly));
    let min = 3_000.0;
    let pts = poisson_points(&polys, min, rng(10));
    let m_per_deg_lng = M_PER_DEG * (50.25f64).to_radians().cos();
    for i in 0..pts.len() {
        for j in i + 1..pts.len() {
            let dx = (pts[i][0] - pts[j][0]) * m_per_deg_lng;
            let dy = (pts[i][1] - pts[j][1]) * M_PER_DEG;
            assert!((dx * dx + dy * dy).sqrt() >= min * 0.99);
        }
    }
}

#[test]
fn poisson_points_fill_the_area() {
    let poly = square(10.0, 50.0, 11.0, 51.0);
    let polys = prepared(std::slice::from_ref(&poly));
    let min = 5_000.0;
    let pts = poisson_points(&polys, min, rng(11));
    let area = M_PER_DEG * (50.5f64).to_radians().cos() * M_PER_DEG;
    let max_packing = area / (min * min * std::f64::consts::PI * 0.25);
    assert!(pts.len() as f64 > max_packing * 0.3);
    assert!((pts.len() as f64) < max_packing * 1.5);
}

#[test]
fn poisson_points_cross_the_antimeridian() {
    let poly = square(170.0, -5.0, 190.0, 5.0);
    let polys = prepared(std::slice::from_ref(&poly));
    let pts = poisson_points(&polys, 40_000.0, rng(14));
    assert!(!pts.is_empty());
    for [lng, lat] in &pts {
        assert!((-180.0..180.0).contains(lng));
        assert!(*lng >= 170.0 || *lng <= -170.0);
        assert!((-5.0..=5.0).contains(lat));
    }
    assert!(
        pts.iter().any(|p| p[0] < 0.0),
        "never reached past the seam"
    );
}

#[test]
fn poisson_points_answer_a_tiny_shape_with_at_most_one() {
    let poly = square(10.0, 50.0, 10.001, 50.001);
    let polys = prepared(std::slice::from_ref(&poly));
    assert!(poisson_points(&polys, 5_000.0, rng(12)).len() <= 1);
}

#[test]
fn poisson_points_are_deterministic_for_one_seed() {
    let poly = square(10.0, 50.0, 10.3, 50.3);
    let polys = prepared(std::slice::from_ref(&poly));
    assert_eq!(
        poisson_points(&polys, 4_000.0, rng(13)),
        poisson_points(&polys, 4_000.0, rng(13))
    );
}

#[test]
fn prepared_polygons_bbox_matches_the_ring_extent() {
    let poly = square(179.5, -1.0, 180.5, 1.0);
    let polys = prepared(std::slice::from_ref(&poly));
    let [w, s, e, n] = polys.bbox().unwrap();
    assert_eq!((w, s, e, n), (179.5, -1.0, 180.5, 1.0));
    assert!(prepared(&[]).bbox().is_none());
}
