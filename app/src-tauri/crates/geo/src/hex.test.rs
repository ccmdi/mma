use super::*;
use crate::{haversine_m, polygon_contains};

fn square(west: f64, south: f64, east: f64, north: f64) -> Vec<[f64; 2]> {
    vec![
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
    ]
}

fn points(grid: &HexGrid, polygons: &[Vec<Vec<[f64; 2]>>]) -> Vec<(f64, f64)> {
    let mut pts = Vec::new();
    grid.for_each_run(polygons, |lat, lng, lng_step, count| {
        pts.extend((0..count).map(|m| (lat, lng + m as f64 * lng_step)));
    });
    pts
}

fn sorted(mut pts: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    pts.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    pts
}

#[test]
fn neighbors_sit_one_spacing_apart() {
    for lat in [0.0, 45.0, 70.0] {
        let grid = HexGrid::new(lat, 10.0, 1000.0);
        let node = |index: i64, col: f64| {
            let row = grid.row(index);
            (row.lat, grid.lng + (col + row.phase) * row.lng_step)
        };
        let (clat, clng) = node(0, 0.0);
        for (index, col) in [
            (0, 1.0),
            (0, -1.0),
            (1, 0.0),
            (1, -1.0),
            (-1, 0.0),
            (-1, -1.0),
        ] {
            let (nlat, nlng) = node(index, col);
            let d = haversine_m(clat, clng, nlat, nlng);
            assert!(
                (d - 1000.0).abs() < 5.0,
                "at {lat}: neighbor ({index}, {col}) is {d}m away"
            );
        }
    }
}

#[test]
fn runs_are_exactly_the_grid_points_inside_the_polygon() {
    let outer = vec![
        [10.0, 50.0],
        [10.4, 50.0],
        [10.4, 50.3],
        [10.2, 50.1],
        [10.0, 50.3],
        [10.0, 50.0],
    ];
    let hole = square(10.05, 50.02, 10.12, 50.07);
    let grid = HexGrid::new(50.15, 10.2, 700.0);
    let got = sorted(points(&grid, &[vec![outer.clone(), hole.clone()]]));

    let mut expected = Vec::new();
    for index in -30..=30 {
        let row = grid.row(index);
        for col in -40..=40 {
            let lng = grid.lng + (col as f64 + row.phase) * row.lng_step;
            if polygon_contains(
                lng,
                row.lat,
                [outer.as_slice(), hole.as_slice()].into_iter(),
            ) {
                expected.push((row.lat, lng));
            }
        }
    }
    let expected = sorted(expected);

    assert!(expected.len() > 200, "{} points", expected.len());
    assert_eq!(got.len(), expected.len());
    for (g, e) in got.iter().zip(&expected) {
        assert!(
            (g.0 - e.0).abs() < 1e-9 && (g.1 - e.1).abs() < 1e-9,
            "{g:?} != {e:?}"
        );
    }
}

#[test]
fn every_point_well_inside_is_within_the_covering_radius() {
    let radius = 500.0;
    let grid = HexGrid::new(45.15, 5.2, radius * 3f64.sqrt());
    let pts = points(&grid, &[vec![square(5.0, 45.0, 5.4, 45.3)]]);
    for yi in 0..30 {
        for xi in 0..30 {
            let lat = 45.02 + yi as f64 * 0.26 / 29.0;
            let lng = 5.03 + xi as f64 * 0.34 / 29.0;
            let nearest = pts
                .iter()
                .map(|&(plat, plng)| haversine_m(lat, lng, plat, plng))
                .fold(f64::INFINITY, f64::min);
            assert!(
                nearest <= radius * 1.01,
                "({lng}, {lat}) is {nearest}m from the grid"
            );
        }
    }
}

#[test]
fn every_part_of_a_multipolygon_gets_points() {
    let grid = HexGrid::new(50.5, 11.0, 2000.0);
    let pts = points(
        &grid,
        &[
            vec![square(10.0, 50.0, 10.2, 50.2)],
            vec![square(12.0, 51.0, 12.2, 51.2)],
        ],
    );
    assert!(pts.iter().any(|&(_, lng)| lng < 11.0));
    assert!(pts.iter().any(|&(_, lng)| lng > 11.0));
}

#[test]
fn a_polygon_across_the_antimeridian_matches_one_away_from_it() {
    let spacing = 1500.0;
    let across = points(
        &HexGrid::new(0.0, -180.0, spacing),
        &[vec![vec![
            [179.9, -0.1],
            [-179.9, -0.1],
            [-179.9, 0.1],
            [179.9, 0.1],
            [179.9, -0.1],
        ]]],
    );
    let away = points(
        &HexGrid::new(0.0, 0.0, spacing),
        &[vec![square(-0.1, -0.1, 0.1, 0.1)]],
    );

    assert_eq!(across.len(), away.len());
    assert!(across
        .iter()
        .all(|&(_, lng)| (-180.0..180.0).contains(&lng)));
    assert!(across.iter().any(|&(_, lng)| lng > 179.0));
    assert!(across.iter().any(|&(_, lng)| lng < -179.0));
}

#[test]
fn a_row_at_the_pole_holds_one_point() {
    let grid = HexGrid::new(90.0, 0.0, 1000.0);
    assert_eq!(grid.row(0).lng_step, 360.0);
}

#[test]
fn nearest_is_the_closest_grid_point() {
    let grid = HexGrid::new(48.0, 2.0, 800.0);
    let nodes: Vec<(f64, f64)> = (-20..=20)
        .flat_map(|index| {
            let row = grid.row(index);
            let lng0 = grid.lng;
            (-25..=25).map(move |col| (row.lat, lng0 + (col as f64 + row.phase) * row.lng_step))
        })
        .collect();
    let mut seed = 0x2545_f491_u32;
    let mut next = move || {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        (seed >> 8) as f64 / (1u32 << 24) as f64
    };
    for _ in 0..2000 {
        let (lat, lng) = (47.92 + next() * 0.16, 1.88 + next() * 0.24);
        let node = grid.nearest(lat, lng);
        let got = haversine_m(lat, lng, node.lat, node.lng);
        let closest = nodes
            .iter()
            .map(|&(nlat, nlng)| haversine_m(lat, lng, nlat, nlng))
            .fold(f64::INFINITY, f64::min);
        assert!(
            got <= closest + 1e-6,
            "({lng}, {lat}): nearest is {got}m away, the closest grid point {closest}m"
        );
    }
}

#[test]
fn every_run_point_is_its_own_nearest_grid_point() {
    let grid = HexGrid::new(50.15, 10.2, 700.0);
    for (lat, lng) in points(&grid, &[vec![square(10.0, 50.0, 10.4, 50.3)]]) {
        let node = grid.nearest(lat, lng);
        assert!(
            (node.lat - lat).abs() < 1e-9 && (node.lng - lng).abs() < 1e-9,
            "({lng}, {lat}) snaps to {node:?}"
        );
    }
}
