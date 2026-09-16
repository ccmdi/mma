use super::*;
use crate::selections::PolygonGeometry;

fn square(w: f64, s: f64, e: f64, n: f64) -> Vec<[f64; 2]> {
    vec![[w, s], [e, s], [e, n], [w, n], [w, s]]
}

fn geom(coordinates: Vec<Vec<[f64; 2]>>) -> PolygonGeometry {
    PolygonGeometry {
        coordinates,
        extra_polygons: None,
        properties: None,
    }
}

#[test]
fn crossing_bounds_keeps_a_plain_box() {
    assert_eq!(
        crossing_bounds([10.0, 0.0, 20.0, 5.0]),
        [10.0, 0.0, 20.0, 5.0]
    );
}

#[test]
fn crossing_bounds_folds_a_seam_box_to_west_past_east() {
    assert_eq!(
        crossing_bounds([170.0, -5.0, 190.0, 5.0]),
        [170.0, -5.0, -170.0, 5.0]
    );
}

#[test]
fn crossing_bounds_spells_a_full_turn_as_the_whole_world() {
    assert_eq!(
        crossing_bounds([-180.0, -85.0, 180.0, -60.0]),
        [-180.0, -85.0, 180.0, -60.0]
    );
    assert_eq!(
        crossing_bounds([100.0, -85.0, 470.0, -60.0]),
        [-180.0, -85.0, 180.0, -60.0]
    );
}

#[test]
fn polygon_bounds_spans_the_extra_polygons_too() {
    let mut g = geom(vec![square(0.0, 0.0, 10.0, 10.0)]);
    g.extra_polygons = Some(vec![vec![square(40.0, 0.0, 50.0, 10.0)]]);
    let bb = crossing_bounds(g.prepared().bbox().unwrap());
    assert_eq!(bb, [0.0, 0.0, 50.0, 10.0]);
    assert!(geom(vec![]).prepared().bbox().is_none());
}

#[test]
fn seam_straddling_parts_merge_into_one_frame() {
    let mut g = geom(vec![square(170.0, -5.0, 180.0, 5.0)]);
    g.extra_polygons = Some(vec![vec![square(-180.0, -5.0, -170.0, 5.0)]]);
    let bb = crossing_bounds(g.prepared().bbox().unwrap());
    assert_eq!(bb, [170.0, -5.0, -170.0, 5.0]);
}
