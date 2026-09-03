use super::*;

#[test]
fn wrap_dlng_normalizes() {
    assert_eq!(wrap_dlng(0.0), 0.0);
    assert_eq!(wrap_dlng(179.0), 179.0);
    assert_eq!(wrap_dlng(-179.0), -179.0);
    assert_eq!(wrap_dlng(359.0), -1.0);
    assert_eq!(wrap_dlng(-359.0), 1.0);
    assert_eq!(wrap_dlng(360.0), 0.0);
    assert!((wrap_dlng(179.9995 - -179.9995) - -0.001).abs() < 1e-9);
}

#[test]
fn haversine_zero_distance() {
    assert_eq!(haversine_m(0.0, 0.0, 0.0, 0.0), 0.0);
}

#[test]
fn haversine_known_distance() {
    // London to Paris ~ 343 km
    let d = haversine_m(51.5074, -0.1278, 48.8566, 2.3522);
    assert!(
        (d - 343_500.0).abs() < 5000.0,
        "London-Paris should be ~343km, got {:.0}m",
        d
    );
}

#[test]
fn equirect_matches_haversine_at_small_range() {
    let (lat, lng) = (70.0, 25.0);
    let (lat2, lng2) = (70.0003, 25.001);
    let e = equirect_m2(lat, lng, lat2, lng2, lat.to_radians().cos()).sqrt();
    let h = haversine_m(lat, lng, lat2, lng2);
    assert!((e - h).abs() < 0.01, "equirect {} vs haversine {}", e, h);
}

#[test]
fn equirect_wraps_antimeridian() {
    // ~222m apart across the seam; without wrap this reads as ~half the globe.
    let d2 = equirect_m2(0.0, 179.999, 0.0, -179.999, 1.0);
    let h = haversine_m(0.0, 179.999, 0.0, -179.999);
    assert!((d2.sqrt() - h).abs() < 0.01, "got {}m", d2.sqrt());
}

#[test]
fn within_m2_across_antimeridian() {
    // ~222m apart across the seam; unwrapped dlng would read as ~360 degrees.
    assert!(within_m2(0.0, 179.999, 0.0, -179.999, 300.0 * 300.0));
    assert!(!within_m2(0.0, 179.999, 0.0, -179.999, 150.0 * 150.0));
}

#[test]
fn within_m2_plain_pair_thresholds() {
    // ~157m apart at 45N.
    assert!(within_m2(45.0, 10.0, 45.0, 10.002, 200.0 * 200.0));
    assert!(!within_m2(45.0, 10.0, 45.0, 10.002, 100.0 * 100.0));
}

#[test]
fn within_m2_latitude_early_out_keeps_borderline_pairs() {
    let d = 100.0 / M_PER_DEG;
    assert!(within_m2(0.0, 0.0, d, 0.0, 100.0 * 100.0 + 1.0));
    assert!(!within_m2(0.0, 0.0, d, 0.0, 99.0 * 99.0));
}

#[test]
fn cover_mid_latitude_is_compact() {
    let cell = 100.0 / M_PER_DEG * 1.5;
    let c = covering_cells(45.0, 10.0, 100.0, cell);
    assert!(c.cx[1].is_none());
    // 200m lat span / 150m cells -> at most 3 rows; 282m lng span -> at most 3 columns.
    assert!(c.cy.end() - c.cy.start() <= 2);
    assert!(c.cx[0].as_ref().unwrap().end() - c.cx[0].as_ref().unwrap().start() <= 2);
}

#[test]
fn cover_widens_at_high_latitude() {
    let cell = 100.0 / M_PER_DEG * 1.5;
    let c = covering_cells(78.0, 10.0, 100.0, cell);
    // 1/(1.5*cos 78°) ≈ 3.2 cells each side.
    let w = c.cx[0].as_ref().unwrap().end() - c.cx[0].as_ref().unwrap().start();
    assert!(w >= 6, "expected >= 6 columns at 78N, got {}", w + 1);
}

#[test]
fn cover_splits_across_antimeridian() {
    let cell = 100.0 / M_PER_DEG * 1.5;
    for lng in [179.9999f64, -179.9999] {
        let c = covering_cells(0.0, lng, 100.0, cell);
        assert!(c.cx[1].is_some(), "no wrap range at lng={}", lng);
        // A point ~22m away on the far side of the seam must be in a covered cell.
        let far = -lng.signum() * 179.9999;
        let cx_far = (far / cell).floor() as i32;
        assert!(
            c.cells().any(|(cx, _)| cx == cx_far),
            "cover at lng={} misses the far-side cell",
            lng
        );
    }
}

#[test]
fn cover_degrades_to_full_circle_at_pole() {
    let c = covering_cells(89.99999, 0.0, 100.0, 1.0);
    assert!(c.cx[1].is_none());
    assert_eq!(*c.cx[0].as_ref().unwrap(), -180..=180);
}

#[test]
fn cover_contains_and_len_agree_with_cells() {
    let cell = 100.0 / M_PER_DEG * 1.5;
    // Seam-splitting cover: two cx ranges; len/contains must agree with cells().
    let c = covering_cells(0.0, 179.9999, 100.0, cell);
    let listed: Vec<(i32, i32)> = c.cells().collect();
    assert_eq!(c.len(), listed.len() as u64);
    for &(cx, cy) in &listed {
        assert!(c.contains(cx, cy), "({cx},{cy}) listed but not contained");
    }
    assert!(!c.contains(0, 0));
}

#[test]
fn cover_empty_for_non_finite() {
    assert_eq!(covering_cells(f64::NAN, 0.0, 100.0, 0.1).cells().count(), 0);
    assert_eq!(
        covering_cells(0.0, f64::INFINITY, 100.0, 0.1)
            .cells()
            .count(),
        0
    );
}

// The invariant every grid depends on: any point within radius_m (per haversine)
// of the query point lies in a covered cell. Seeded sweep over latitudes including
// polar and seam-adjacent longitudes.
#[test]
fn cover_contains_all_neighbors_within_radius() {
    let mut seed = 7u64;
    let mut rnd = move || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) as f64 / (1u64 << 31) as f64
    };
    for &radius in &[10.0, 250.0, 900.0] {
        let cell = radius / M_PER_DEG * 1.5;
        for _ in 0..2000 {
            let lat = rnd() * 176.0 - 88.0;
            let lng = rnd() * 360.0 - 180.0;
            // Random offset within the radius (equirect placement, then verified).
            let ang = rnd() * std::f64::consts::TAU;
            let dist = rnd() * radius;
            let dlat = dist * ang.sin() / M_PER_DEG;
            let dlng = dist * ang.cos() / (M_PER_DEG * lat.to_radians().cos());
            let (plat, plng) = (lat + dlat, wrap_dlng(lng + dlng));
            if plat.abs() > 90.0 || haversine_m(lat, lng, plat, plng) > radius {
                continue;
            }
            let (pcx, pcy) = ((plng / cell).floor() as i32, (plat / cell).floor() as i32);
            let cover = covering_cells(lat, lng, radius, cell);
            assert!(
                cover.cells().any(|c| c == (pcx, pcy)),
                "point at ({plat},{plng}) not covered from ({lat},{lng}) r={radius}"
            );
        }
    }
}

/// A jagged ring with `n` vertices around `(clng, clat)`: radius varies with a fixed
/// pseudo-random sequence, so edges span many latitude bands and overlap in longitude.
fn jagged_ring(n: usize, clng: f64, clat: f64) -> Vec<[f64; 2]> {
    let mut seed = 0x9e37_79b9_u32;
    (0..n)
        .map(|k| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let r = 5.0 + 4.0 * (seed >> 8) as f64 / (1u32 << 24) as f64;
            let t = k as f64 / n as f64 * std::f64::consts::TAU;
            [clng + r * t.cos(), clat + r * t.sin() * 0.6]
        })
        .collect()
}

#[test]
fn prepared_ring_agrees_with_point_in_ring_on_a_dense_grid() {
    for (n, clng) in [(4, 10.0), (37, 10.0), (5000, 10.0), (5000, 178.0)] {
        let ring = jagged_ring(n, clng, 40.0);
        let prep = PreparedRing::new(&ring);
        let mut checked = 0;
        for yi in 0..120 {
            for xi in 0..120 {
                let lat = 28.0 + yi as f64 * 0.2;
                let lng = wrap_dlng(clng - 12.0 + xi as f64 * 0.2);
                assert_eq!(
                    prep.contains(lng, lat),
                    point_in_ring(lng, lat, &ring),
                    "n={n} at ({lng}, {lat})"
                );
                checked += 1;
            }
        }
        assert_eq!(checked, 14_400);
    }
}

#[test]
fn prepared_ring_matches_on_its_own_vertices_and_edge_latitudes() {
    let ring = jagged_ring(600, -60.0, -20.0);
    let prep = PreparedRing::new(&ring);
    for v in &ring {
        for dl in [-0.01, 0.0, 0.01] {
            let (lng, lat) = (v[0] + dl, v[1]);
            assert_eq!(prep.contains(lng, lat), point_in_ring(lng, lat, &ring));
        }
    }
}
