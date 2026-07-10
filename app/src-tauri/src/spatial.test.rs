use super::*;

fn ids(mut v: Vec<u32>) -> Vec<u32> {
    v.sort_unstable();
    v.dedup();
    v
}

fn query(ix: &SpatialIndex, lat: f64, lng: f64, r: f64) -> Vec<u32> {
    let mut out = Vec::new();
    ix.candidates(lat, lng, r, &mut out);
    ids(out)
}

#[test]
fn insert_then_query_finds_point() {
    let mut ix = SpatialIndex::new();
    ix.insert(1, 51.5074, -0.1278);
    assert_eq!(query(&ix, 51.5074, -0.1278, 10.0), vec![1]);
    assert_eq!(ix.len(), 1);
}

#[test]
fn query_zero_radius_hits_same_cell() {
    let mut ix = SpatialIndex::new();
    ix.insert(1, 10.0, 10.0);
    assert_eq!(query(&ix, 10.0, 10.0, 0.0), vec![1]);
}

#[test]
fn query_spans_cell_boundaries() {
    // Two points ~40m apart straddle 25m cells; a 50m query from either must see both.
    let mut ix = SpatialIndex::new();
    let (lat, lng) = (48.8566, 2.3522);
    let lat2 = lat + 40.0 / 111_320.0;
    ix.insert(1, lat, lng);
    ix.insert(2, lat2, lng);
    assert_eq!(query(&ix, lat, lng, 50.0), vec![1, 2]);
    assert_eq!(query(&ix, lat2, lng, 50.0), vec![1, 2]);
}

#[test]
fn candidates_are_superset_never_missing() {
    // Deterministic pseudo-random points in a ~2km box; every point within r of the
    // probe must appear among candidates (false positives are fine, misses are not).
    let mut ix = SpatialIndex::new();
    let mut pts = Vec::new();
    let mut seed = 42u64;
    let mut rnd = || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 33) as f64 / (1u64 << 31) as f64
    };
    for i in 0..500u32 {
        let lat = 45.0 + rnd() * 0.02;
        let lng = 7.0 + rnd() * 0.02;
        pts.push((i, lat, lng));
        ix.insert(i, lat, lng);
    }
    let (plat, plng) = (45.01, 7.01);
    for r in [5.0, 50.0, 300.0] {
        let cand = query(&ix, plat, plng, r);
        for &(id, lat, lng) in &pts {
            let d = crate::selections::haversine_m(plat, plng, lat, lng);
            if d <= r {
                assert!(
                    cand.contains(&id),
                    "id {id} at {d:.1}m missing from r={r} candidates"
                );
            }
        }
    }
}

#[test]
fn remove_by_coords_and_fallback() {
    let mut ix = SpatialIndex::new();
    ix.insert(1, 10.0, 10.0);
    ix.insert(2, 10.0, 10.0);
    ix.remove(1, 10.0, 10.0);
    assert_eq!(query(&ix, 10.0, 10.0, 1.0), vec![2]);
    // Stale coords still remove via the fallback scan.
    ix.remove(2, -50.0, 120.0);
    assert_eq!(ix.len(), 0);
    assert!(query(&ix, 10.0, 10.0, 1.0).is_empty());
}

#[test]
fn non_finite_coords_are_ignored() {
    let mut ix = SpatialIndex::new();
    ix.insert(1, f64::NAN, 10.0);
    ix.insert(2, 10.0, f64::INFINITY);
    assert_eq!(ix.len(), 0);
    let mut out = Vec::new();
    ix.candidates(f64::NAN, 10.0, 100.0, &mut out);
    assert!(out.is_empty());
}
