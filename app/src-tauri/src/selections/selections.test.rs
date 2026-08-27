#![allow(clippy::needless_pass_by_value)]
use super::*;
use crate::store::arrow_bridge::locations_to_batch;
use crate::test_util::{loc, Fx};
use crate::types::Location;
use crate::types::RawExtra;
use chrono::TimeZone;
use std::iter;
use std::slice;

// for_each must visit every alive location exactly once, overlay applied: dead rows
// skipped, patched rows surfaced with the patch's coordinates, then the overlay adds.
#[test]
fn for_each_visits_alive_overlay_applied() {
    let base = vec![loc(1, 1.0, 1.0), loc(2, 2.0, 2.0), loc(3, 3.0, 3.0)];

    let adds = vec![loc(4, 4.0, 4.0)];
    let fx = Fx::base(&base)
        .with_adds(adds)
        .with_dead([2])
        .with_patch(3, loc(3, 30.0, 30.0));
    let view = fx.view();

    let mut seen: Vec<(u32, f64, f64)> = Vec::new();
    view.for_each(|row| {
        seen.push((row.id(), row.lat(), row.lng()));
    });

    // id 1 from base, id 2 skipped (dead), id 3 with patched coords, id 4 the add.
    assert_eq!(seen, vec![(1, 1.0, 1.0), (3, 30.0, 30.0), (4, 4.0, 4.0)]);
}

// within(None) is the full alive walk; within(Some) filters to the resolved set,
// preserving view order (batch rows, then adds).
#[test]
fn within_iterates_resolved_set_in_view_order() {
    let base = vec![loc(1, 1.0, 1.0), loc(2, 2.0, 2.0), loc(3, 3.0, 3.0)];
    let fx = Fx::base(&base)
        .with_adds(vec![loc(4, 4.0, 4.0)])
        .with_dead([2]);
    let view = fx.view();

    let ids = |set: Option<&RoaringBitmap>| view.within(set).map(|r| r.id()).collect::<Vec<u32>>();
    assert_eq!(ids(None), vec![1, 3, 4]);
    let set: RoaringBitmap = [4u32, 1].into_iter().collect();
    assert_eq!(ids(Some(&set)), vec![1, 4]);
    assert_eq!(ids(Some(&RoaringBitmap::new())), Vec::<u32>::new());
}

// -----------------------------------------------------------------------
// Geometry: point_in_ring / point_in_polygon
// -----------------------------------------------------------------------

#[test]
fn point_inside_square() {
    let ring = vec![
        [0.0, 0.0],
        [10.0, 0.0],
        [10.0, 10.0],
        [0.0, 10.0],
        [0.0, 0.0],
    ];
    assert!(point_in_ring(5.0, 5.0, &ring));
}

#[test]
fn point_outside_square() {
    let ring = vec![
        [0.0, 0.0],
        [10.0, 0.0],
        [10.0, 10.0],
        [0.0, 10.0],
        [0.0, 0.0],
    ];
    assert!(!point_in_ring(15.0, 5.0, &ring));
}

#[test]
fn point_in_polygon_with_hole() {
    let outer = vec![
        [0.0, 0.0],
        [20.0, 0.0],
        [20.0, 20.0],
        [0.0, 20.0],
        [0.0, 0.0],
    ];
    let hole = vec![
        [5.0, 5.0],
        [15.0, 5.0],
        [15.0, 15.0],
        [5.0, 15.0],
        [5.0, 5.0],
    ];
    let coords = vec![outer, hole];
    assert!(point_in_polygon(2.0, 2.0, &coords)); // outside hole, inside outer
    assert!(!point_in_polygon(10.0, 10.0, &coords)); // inside hole
}

#[test]
fn point_in_geometry_extra_polygons() {
    let main = vec![vec![
        [0.0, 0.0],
        [10.0, 0.0],
        [10.0, 10.0],
        [0.0, 10.0],
        [0.0, 0.0],
    ]];
    let extra = vec![vec![
        [20.0, 20.0],
        [30.0, 20.0],
        [30.0, 30.0],
        [20.0, 30.0],
        [20.0, 20.0],
    ]];
    let geom = PolygonGeometry {
        coordinates: main,
        extra_polygons: Some(vec![extra]),
        properties: None,
    };
    assert!(point_in_geometry(5.0, 5.0, &geom));
    assert!(point_in_geometry(25.0, 25.0, &geom));
    assert!(!point_in_geometry(15.0, 15.0, &geom));
}

// -----------------------------------------------------------------------
// Polygon bbox broad-phase reject
// -----------------------------------------------------------------------

#[test]
fn geometry_bbox_spans_all_rings() {
    // Outer [0..10] plus an extra polygon [20..30] -> bbox covers both.
    let main = vec![vec![
        [0.0, 0.0],
        [10.0, 0.0],
        [10.0, 10.0],
        [0.0, 10.0],
        [0.0, 0.0],
    ]];
    let extra = vec![vec![
        [20.0, 20.0],
        [30.0, 20.0],
        [30.0, 30.0],
        [20.0, 30.0],
        [20.0, 20.0],
    ]];
    let geom = PolygonGeometry {
        coordinates: main,
        extra_polygons: Some(vec![extra]),
        properties: None,
    };
    // [min_lng, min_lat, max_lng, max_lat]
    assert_eq!(geometry_bbox(&geom), Some([0.0, 0.0, 30.0, 30.0]));
    assert_eq!(
        geometry_bbox(&PolygonGeometry {
            coordinates: vec![],
            extra_polygons: None,
            properties: None
        }),
        None
    );
}

#[test]
fn in_bbox_edges_and_outside() {
    let bb = [0.0, 0.0, 10.0, 10.0]; // min_lng, min_lat, max_lng, max_lat
    assert!(in_bbox(5.0, 5.0, &bb));
    assert!(in_bbox(0.0, 0.0, &bb)); // corner inclusive
    assert!(in_bbox(10.0, 10.0, &bb));
    assert!(!in_bbox(-0.1, 5.0, &bb));
    assert!(!in_bbox(5.0, 10.1, &bb));
}

// The bbox reject must not change WHICH points a polygon selection returns. The
// tricky case is a point inside the bbox but outside the (concave) polygon: the
// broad-phase lets it through, the full crossing test must still exclude it.
#[test]
fn polygon_resolve_matches_full_test_with_bbox_reject() {
    // L-shaped (concave) polygon: covers bbox [0..10]x[0..10] but the top-right
    // quadrant (>5,>5) is carved out.
    let l_shape = vec![vec![
        [0.0, 0.0],
        [10.0, 0.0],
        [10.0, 5.0],
        [5.0, 5.0],
        [5.0, 10.0],
        [0.0, 10.0],
        [0.0, 0.0],
    ]];
    let geom = PolygonGeometry {
        coordinates: l_shape,
        extra_polygons: None,
        properties: None,
    };

    let adds = vec![
        loc(1, 1.0, 1.0),   // inside L  -> selected
        loc(2, 8.0, 8.0),   // inside bbox, in the carved-out notch -> NOT selected
        loc(3, 50.0, 50.0), // outside bbox -> rejected by broad-phase
        loc(4, 1.0, 8.0),   // inside L (left column) -> selected
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(
        &view,
        &Selector::Polygon {
            polygon: geom.clone(),
            include_informational: true,
        },
    );
    assert!(ids.contains(&1));
    assert!(!ids.contains(&2)); // bbox would include it; full test must exclude
    assert!(!ids.contains(&3));
    assert!(ids.contains(&4));

    // Cross-check: resolve agrees with point_in_geometry applied directly.
    for l in &fx.adds {
        let want = point_in_geometry(l.lng, l.lat, &geom);
        assert_eq!(ids.contains(&l.id), want, "mismatch for loc {}", l.id);
    }
}

// -----------------------------------------------------------------------
// Antimeridian
// -----------------------------------------------------------------------

#[test]
fn point_in_ring_across_antimeridian() {
    // Polygon spanning the antimeridian: 170E to 170W (i.e., 170 to -170)
    let ring = vec![
        [170.0, -10.0],
        [-170.0, -10.0],
        [-170.0, 10.0],
        [170.0, 10.0],
        [170.0, -10.0],
    ];
    assert!(point_in_ring(175.0, 0.0, &ring)); // inside, east side
    assert!(point_in_ring(-175.0, 0.0, &ring)); // inside, west side
    assert!(point_in_ring(180.0, 0.0, &ring)); // on the dateline
    assert!(!point_in_ring(160.0, 0.0, &ring)); // outside, well west
    assert!(!point_in_ring(-160.0, 0.0, &ring)); // outside, well east
    assert!(!point_in_ring(0.0, 0.0, &ring)); // outside, other side of world
}

#[test]
fn geometry_bbox_antimeridian() {
    let ring = vec![
        [170.0, -10.0],
        [-170.0, -10.0],
        [-170.0, 10.0],
        [170.0, 10.0],
        [170.0, -10.0],
    ];
    let geom = PolygonGeometry {
        coordinates: vec![ring],
        extra_polygons: None,
        properties: None,
    };
    let bb = geometry_bbox(&geom).unwrap();
    // After normalization: 170 and 190 (= -170 + 360)
    assert_eq!(bb[0], 170.0); // min_lng
    assert_eq!(bb[2], 190.0); // max_lng

    // in_bbox handles the normalized space transparently
    assert!(in_bbox(175.0, 0.0, &bb));
    assert!(in_bbox(-175.0, 0.0, &bb)); // negative lng auto-shifted
    assert!(!in_bbox(0.0, 0.0, &bb));
}

#[test]
fn prepared_geometry_matches_point_in_geometry() {
    // PreparedGeometry (per-ring bbox + cached antimeridian flag) must agree with the
    // per-point path everywhere, or polygon selections change under the optimization.
    let square =
        |x0: f64, y0: f64, x1: f64, y1: f64| vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
    let geoms = vec![
        // plain polygon
        PolygonGeometry {
            coordinates: vec![square(0.0, 0.0, 10.0, 10.0)],
            extra_polygons: None,
            properties: None,
        },
        // polygon with a hole
        PolygonGeometry {
            coordinates: vec![square(0.0, 0.0, 10.0, 10.0), square(4.0, 4.0, 6.0, 6.0)],
            extra_polygons: None,
            properties: None,
        },
        // antimeridian-crossing (wrapped coords)
        PolygonGeometry {
            coordinates: vec![vec![
                [170.0, -10.0],
                [-170.0, -10.0],
                [-170.0, 10.0],
                [170.0, 10.0],
                [170.0, -10.0],
            ]],
            extra_polygons: None,
            properties: None,
        },
        // antimeridian-crossing (unwrapped coords, lng > 180)
        PolygonGeometry {
            coordinates: vec![square(170.0, -10.0, 190.0, 10.0)],
            extra_polygons: None,
            properties: None,
        },
        // multipolygon: island near the origin + island past the dateline
        PolygonGeometry {
            coordinates: vec![square(0.0, 0.0, 10.0, 10.0)],
            extra_polygons: Some(vec![vec![square(175.0, -5.0, 185.0, 5.0)]]),
            properties: None,
        },
    ];
    for geom in &geoms {
        let prepared = PreparedGeometry::new(geom);
        let mut lat = -20.0;
        while lat <= 20.0 {
            let mut lng = -180.0;
            while lng < 180.0 {
                assert_eq!(
                    prepared.contains(lng, lat),
                    point_in_geometry(lng, lat, geom),
                    "divergence at ({lng}, {lat})"
                );
                lng += 0.5;
            }
            lat += 0.5;
        }
    }
}

#[test]
fn polygon_resolve_across_antimeridian() {
    let ring = vec![
        [170.0, -10.0],
        [-170.0, -10.0],
        [-170.0, 10.0],
        [170.0, 10.0],
        [170.0, -10.0],
    ];
    let geom = PolygonGeometry {
        coordinates: vec![ring],
        extra_polygons: None,
        properties: None,
    };
    let adds = vec![
        loc(1, 5.0, 175.0),  // inside (east of dateline)
        loc(2, 5.0, -175.0), // inside (west of dateline)
        loc(3, 5.0, 0.0),    // outside (other side of world)
        loc(4, 5.0, 160.0),  // outside (west of polygon)
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(
        &view,
        &Selector::Polygon {
            polygon: geom,
            include_informational: true,
        },
    );
    assert!(ids.contains(&1));
    assert!(ids.contains(&2));
    assert!(!ids.contains(&3));
    assert!(!ids.contains(&4));
}

#[test]
fn point_in_ring_unwrapped_antimeridian() {
    // Rectangle-style unwrapped: east > 180 instead of negative
    let ring = vec![
        [170.0, -10.0],
        [190.0, -10.0],
        [190.0, 10.0],
        [170.0, 10.0],
        [170.0, -10.0],
    ];
    assert!(point_in_ring(175.0, 0.0, &ring));
    assert!(point_in_ring(-175.0, 0.0, &ring)); // = 185 after normalization
    assert!(!point_in_ring(0.0, 0.0, &ring));
    assert!(!point_in_ring(160.0, 0.0, &ring));
}

#[test]
fn polygon_resolve_unwrapped_antimeridian() {
    // Rectangle-mode coordinates: east=190 instead of -170
    let ring = vec![
        [170.0, -10.0],
        [190.0, -10.0],
        [190.0, 10.0],
        [170.0, 10.0],
        [170.0, -10.0],
    ];
    let geom = PolygonGeometry {
        coordinates: vec![ring],
        extra_polygons: None,
        properties: None,
    };
    let adds = vec![
        loc(1, 5.0, 175.0),  // inside
        loc(2, 5.0, -175.0), // inside (other side of IDL)
        loc(3, 5.0, 0.0),    // outside
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(
        &view,
        &Selector::Polygon {
            polygon: geom,
            include_informational: true,
        },
    );
    assert!(ids.contains(&1));
    assert!(ids.contains(&2));
    assert!(!ids.contains(&3));
}

/// A box `west` -> `east` with the mid-edge vertices the drawing tools densify in, so
/// no edge reaches 180° and the span survives `unwrap_ring`.
fn wide_box(west: f64, east: f64) -> Vec<[f64; 2]> {
    let mid = (west + east) / 2.0;
    vec![
        [west, 10.0],
        [mid, 10.0],
        [east, 10.0],
        [east, -10.0],
        [mid, -10.0],
        [west, -10.0],
        [west, 10.0],
    ]
}

#[test]
fn unwrap_ring_keeps_a_span_wider_than_180() {
    // 190° box drawn westward from 20. Normalized vertices alone can't tell it from the
    // 170° box on the other side of the seam, so the span has to survive untouched.
    let ring = wide_box(-170.0, 20.0);
    let unwrapped = unwrap_ring(&ring);
    assert_eq!(&*unwrapped, &ring[..]);
}

#[test]
fn point_in_ring_wide_box_selects_the_drawn_side() {
    let ring = wide_box(-170.0, 20.0);
    assert!(point_in_ring(0.0, 0.0, &ring));
    assert!(point_in_ring(-100.0, 0.0, &ring));
    assert!(point_in_ring(-169.0, 0.0, &ring));
    assert!(!point_in_ring(100.0, 0.0, &ring));
    assert!(!point_in_ring(-175.0, 0.0, &ring));
    assert!(!point_in_ring(170.0, 0.0, &ring));
}

#[test]
fn point_in_ring_across_both_meridians() {
    // 195° box running east from 170: over the antimeridian and on past Greenwich.
    // Shifting to [0, 360) used to only move the seam, tearing this one at lng 0.
    let ring = wide_box(170.0, 365.0);
    assert!(point_in_ring(180.0, 0.0, &ring));
    assert!(point_in_ring(-90.0, 0.0, &ring));
    assert!(point_in_ring(0.0, 0.0, &ring));
    assert!(point_in_ring(3.0, 0.0, &ring));
    assert!(!point_in_ring(30.0, 0.0, &ring));
    assert!(!point_in_ring(100.0, 0.0, &ring));
}

#[test]
fn polygon_resolve_wide_box() {
    // End-to-end through geometry_bbox + in_bbox + PreparedGeometry, which is where a
    // broad-phase in the wrong frame would silently reject the whole selection.
    let geom = PolygonGeometry {
        coordinates: vec![wide_box(-170.0, 20.0)],
        extra_polygons: None,
        properties: None,
    };
    let adds = vec![
        loc(1, 5.0, 0.0),    // inside
        loc(2, 5.0, -100.0), // inside
        loc(3, 5.0, 100.0),  // outside, the short way round
        loc(4, 5.0, -175.0), // outside, just past the western edge
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(
        &view,
        &Selector::Polygon {
            polygon: geom,
            include_informational: true,
        },
    );
    assert!(ids.contains(&1));
    assert!(ids.contains(&2));
    assert!(!ids.contains(&3));
    assert!(!ids.contains(&4));
}

#[test]
fn geometry_bbox_merges_straddling_parts_into_one_frame() {
    // One part unwrapped past 180, the other still negative. Read in their own frames
    // the box would span the globe and reject nothing.
    let geom = PolygonGeometry {
        coordinates: vec![vec![
            [170.0, -10.0],
            [190.0, -10.0],
            [190.0, 10.0],
            [170.0, 10.0],
            [170.0, -10.0],
        ]],
        extra_polygons: Some(vec![vec![vec![
            [-175.0, -5.0],
            [-172.0, -5.0],
            [-172.0, 5.0],
            [-175.0, 5.0],
            [-175.0, -5.0],
        ]]]),
        properties: None,
    };
    let bb = geometry_bbox(&geom).unwrap();
    assert_eq!([bb[0], bb[2]], [170.0, 190.0]);
    assert!(in_bbox(-174.0, 0.0, &bb));
    assert!(!in_bbox(0.0, 0.0, &bb));
    assert!(!in_bbox(160.0, 0.0, &bb));
}

// -----------------------------------------------------------------------
// compare_filter
// -----------------------------------------------------------------------

#[test]
fn filter_eq_string() {
    assert!(compare_filter(
        &serde_json::json!("BR"),
        FilterOp::Eq,
        &serde_json::json!("BR"),
        None
    ));
    assert!(!compare_filter(
        &serde_json::json!("US"),
        FilterOp::Eq,
        &serde_json::json!("BR"),
        None
    ));
}

#[test]
fn filter_neq() {
    assert!(compare_filter(
        &serde_json::json!("US"),
        FilterOp::Neq,
        &serde_json::json!("BR"),
        None
    ));
    assert!(!compare_filter(
        &serde_json::json!("BR"),
        FilterOp::Neq,
        &serde_json::json!("BR"),
        None
    ));
}

#[test]
fn filter_gt_numeric() {
    assert!(compare_filter(
        &serde_json::json!(100),
        FilterOp::Gt,
        &serde_json::json!(50),
        None
    ));
    assert!(!compare_filter(
        &serde_json::json!(50),
        FilterOp::Gt,
        &serde_json::json!(100),
        None
    ));
}

#[test]
fn filter_between() {
    assert!(compare_filter(
        &serde_json::json!(500),
        FilterOp::Between,
        &serde_json::json!(100),
        Some(&serde_json::json!(1000))
    ));
    assert!(!compare_filter(
        &serde_json::json!(50),
        FilterOp::Between,
        &serde_json::json!(100),
        Some(&serde_json::json!(1000))
    ));
}

#[test]
fn filter_between_anyyear_normal_range() {
    // April 15 2023 00:00 UTC = 1681516800
    let apr15 = serde_json::json!(1681516800.0);
    // May 1 2021 00:00 UTC = 1619827200
    let may1 = serde_json::json!(1619827200.0);
    // June 10 2020 00:00 UTC = 1591747200
    let jun10 = serde_json::json!(1591747200.0);

    let lo = serde_json::json!("04-15");
    let hi = serde_json::json!("05-15");

    assert!(compare_filter(
        &apr15,
        FilterOp::BetweenAnyyear,
        &lo,
        Some(&hi)
    ));
    assert!(compare_filter(
        &may1,
        FilterOp::BetweenAnyyear,
        &lo,
        Some(&hi)
    ));
    assert!(!compare_filter(
        &jun10,
        FilterOp::BetweenAnyyear,
        &lo,
        Some(&hi)
    ));
}

#[test]
fn filter_between_anyyear_wrapping_range() {
    // Dec 1 2022 00:00 UTC = 1669852800
    let dec1 = serde_json::json!(1669852800.0);
    // Jan 15 2023 00:00 UTC = 1673740800
    let jan15 = serde_json::json!(1673740800.0);
    // July 4 2021 00:00 UTC = 1625356800
    let jul4 = serde_json::json!(1625356800.0);

    let lo = serde_json::json!("11-15");
    let hi = serde_json::json!("02-15");

    assert!(compare_filter(
        &dec1,
        FilterOp::BetweenAnyyear,
        &lo,
        Some(&hi)
    ));
    assert!(compare_filter(
        &jan15,
        FilterOp::BetweenAnyyear,
        &lo,
        Some(&hi)
    ));
    assert!(!compare_filter(
        &jul4,
        FilterOp::BetweenAnyyear,
        &lo,
        Some(&hi)
    ));
}

#[test]
fn filter_between_anyyear_string_field() {
    let ym = serde_json::json!("2023-04");
    let lo = serde_json::json!("03-01");
    let hi = serde_json::json!("05-01");
    assert!(compare_filter(
        &ym,
        FilterOp::BetweenAnyyear,
        &lo,
        Some(&hi)
    ));

    let ym_out = serde_json::json!("2023-07");
    assert!(!compare_filter(
        &ym_out,
        FilterOp::BetweenAnyyear,
        &lo,
        Some(&hi)
    ));
}

#[test]
fn filter_between_anytime_normal_range() {
    // 2023-04-15 14:30 UTC = 1681567800
    let ts_1430 = serde_json::json!(1681567800.0);
    // 2021-05-01 08:00 UTC = 1619856000
    let ts_0800 = serde_json::json!(1619856000.0);
    // 2020-06-10 22:00 UTC = 1591826400
    let ts_2200 = serde_json::json!(1591826400.0);

    let lo = serde_json::json!("08:00");
    let hi = serde_json::json!("15:00");

    assert!(compare_filter(
        &ts_1430,
        FilterOp::BetweenAnytime,
        &lo,
        Some(&hi)
    ));
    assert!(compare_filter(
        &ts_0800,
        FilterOp::BetweenAnytime,
        &lo,
        Some(&hi)
    ));
    assert!(!compare_filter(
        &ts_2200,
        FilterOp::BetweenAnytime,
        &lo,
        Some(&hi)
    ));
}

#[test]
fn filter_between_anytime_wrapping_range() {
    // 2023-01-01 23:00 UTC = 1672614000
    let ts_2300 = serde_json::json!(1672614000.0);
    // 2023-01-01 02:00 UTC = 1672538400
    let ts_0200 = serde_json::json!(1672538400.0);
    // 2023-01-01 12:00 UTC = 1672574400
    let ts_1200 = serde_json::json!(1672574400.0);

    let lo = serde_json::json!("22:00");
    let hi = serde_json::json!("06:00");

    assert!(compare_filter(
        &ts_2300,
        FilterOp::BetweenAnytime,
        &lo,
        Some(&hi)
    ));
    assert!(compare_filter(
        &ts_0200,
        FilterOp::BetweenAnytime,
        &lo,
        Some(&hi)
    ));
    assert!(!compare_filter(
        &ts_1200,
        FilterOp::BetweenAnytime,
        &lo,
        Some(&hi)
    ));
}

#[test]
fn filter_between_anytime_string_field_returns_false() {
    let ym = serde_json::json!("2023-04");
    let lo = serde_json::json!("08:00");
    let hi = serde_json::json!("15:00");
    assert!(!compare_filter(
        &ym,
        FilterOp::BetweenAnytime,
        &lo,
        Some(&hi)
    ));
}

#[test]
fn filter_has_nothas() {
    assert!(compare_filter(
        &serde_json::json!("anything"),
        FilterOp::Has,
        &serde_json::json!(null),
        None
    ));
    assert!(!compare_filter(
        &serde_json::json!("anything"),
        FilterOp::Nothas,
        &serde_json::json!(null),
        None
    ));
}

#[test]
fn val_eq_same_type() {
    assert!(val_eq(&serde_json::json!("BR"), &serde_json::json!("BR")));
    assert!(val_eq(&serde_json::json!(42), &serde_json::json!(42)));
    assert!(!val_eq(&serde_json::json!("a"), &serde_json::json!("b")));
}

#[test]
fn val_eq_cross_type() {
    // number vs string
    assert!(val_eq(&serde_json::json!(2), &serde_json::json!("2")));
    assert!(val_eq(&serde_json::json!("2"), &serde_json::json!(2)));
    assert!(val_eq(&serde_json::json!(10), &serde_json::json!("10")));
    assert!(!val_eq(&serde_json::json!(2), &serde_json::json!("3")));
    // float vs int
    assert!(val_eq(&serde_json::json!(2.0), &serde_json::json!(2)));
    assert!(val_eq(&serde_json::json!(100), &serde_json::json!(100.0)));
    // float vs string
    assert!(val_eq(&serde_json::json!(3.5), &serde_json::json!("3.5")));
    // bool never equals number/string
    assert!(!val_eq(&serde_json::json!(true), &serde_json::json!(1)));
    assert!(!val_eq(
        &serde_json::json!(true),
        &serde_json::json!("true")
    ));
    // null
    assert!(val_eq(&serde_json::json!(null), &serde_json::json!(null)));
    assert!(!val_eq(&serde_json::json!(null), &serde_json::json!(0)));
    assert!(!val_eq(&serde_json::json!(null), &serde_json::json!("")));
}

// -----------------------------------------------------------------------
// resolve with LocView (overlay adds only, no batch)
// -----------------------------------------------------------------------

#[test]
fn resolve_everything() {
    let adds = vec![loc(1, 10.0, 20.0), loc(2, 30.0, 40.0)];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(&view, &Selector::Everything);
    assert_eq!(ids.len(), 2);
}

#[test]
fn resolve_tag_on_adds() {
    let mut l1 = loc(1, 0.0, 0.0);
    l1.tags = vec![10];
    let l2 = loc(2, 0.0, 0.0);
    let adds = vec![l1, l2];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(&view, &Selector::Tag { tag_id: 10 });
    assert_eq!(ids, vec![1]);
}

#[test]
fn resolve_untagged() {
    let mut l1 = loc(1, 0.0, 0.0);
    l1.tags = vec![10];
    let l2 = loc(2, 0.0, 0.0);
    let adds = vec![l1, l2];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(&view, &Selector::Untagged);
    assert_eq!(ids, vec![2]);
}

// The built-in field vocabulary is one table. All three resolver paths (Location, Arrow
// columns, and the single-parse tz path) must cover exactly its keys: extras shadow every
// builtin key here, so a key missing from a path resolves to the sentinel instead.
#[test]
fn builtin_fields_resolve_on_every_path() {
    let mut l = loc(1, 12.0, 34.0);
    l.tags = vec![10, 11];
    l.modified_at = Some(99);
    let shadow: serde_json::Map<String, serde_json::Value> = BUILTIN_FIELDS
        .iter()
        .map(|f| (f.key.to_string(), serde_json::json!("SHADOW")))
        .chain(iter::once((
            "timezone".to_string(),
            serde_json::json!("UTC"),
        )))
        .collect();
    l.extra = RawExtra::from_map(&shadow);

    let fx = Fx::batch(locations_to_batch(slice::from_ref(&l)));
    let view = fx.view();
    let base_row = RowRef {
        inner: RowInner::Base(&view, 0),
    };

    let sentinel = Some(serde_json::json!("SHADOW"));
    for f in BUILTIN_FIELDS {
        assert!(is_builtin_field(f.key), "{} not a builtin", f.key);
        assert_ne!(
            resolve_field_loc(&l, f.key),
            sentinel,
            "{} falls through to extras on the Location path",
            f.key
        );
        assert_ne!(
            resolve_field_arrow(&view, 0, f.key),
            sentinel,
            "{} falls through to extras on the Arrow path",
            f.key
        );
        assert_ne!(
            base_row.resolve_field_and_tz(f.key).0,
            sentinel,
            "{} falls through to extras on the tz path",
            f.key
        );
    }

    // Non-builtin keys still come from extras on every path.
    assert!(!is_builtin_field("timezone"));
    let utc = Some(serde_json::json!("UTC"));
    assert_eq!(resolve_field_loc(&l, "timezone"), utc);
    assert_eq!(resolve_field_arrow(&view, 0, "timezone"), utc);
    assert_eq!(base_row.resolve_field_and_tz("timezone").0, utc);
}

// tagCount is a virtual field: filtered through the Filter primitive, resolved as the
// length of the tag list. Counts every assigned tag (visibility is a display concern).
// Covers both resolution paths: base-batch rows (resolve_field_arrow) and overlay adds
// (resolve_field_loc).
#[test]
fn resolve_filter_tag_count() {
    let b1 = loc(1, 0.0, 0.0); // base: 0 tags
    let mut b2 = loc(2, 0.0, 0.0);
    b2.tags = vec![10, 11]; // base: 2 tags

    let mut a3 = loc(3, 0.0, 0.0);
    a3.tags = vec![10, 11, 12]; // add: 3 tags
    let adds = vec![a3];
    let fx = Fx::base(&[b1, b2]).with_adds(adds);
    let view = fx.view();

    let eq2 = Selector::Filter {
        field: "tagCount".into(),
        op: FilterOp::Eq,
        value: serde_json::json!(2),
        value2: None,
        tz_local: false,
    };
    assert_eq!(ids_of(&view, &eq2), vec![2]);

    let gt1 = Selector::Filter {
        field: "tagCount".into(),
        op: FilterOp::Gt,
        value: serde_json::json!(1),
        value2: None,
        tz_local: false,
    };
    assert_eq!(ids_of(&view, &gt1), vec![2, 3]);

    let eq0 = Selector::Filter {
        field: "tagCount".into(),
        op: FilterOp::Eq,
        value: serde_json::json!(0),
        value2: None,
        tz_local: false,
    };
    assert_eq!(ids_of(&view, &eq0), vec![1]);
}

// Uncommitted resolves to overlay membership: committed base rows are excluded, while
// both overlay adds (new) and patched base rows (edited since commit) are included.
#[test]
fn resolve_uncommitted() {
    let b1 = loc(1, 0.0, 0.0); // committed, untouched
    let b2 = loc(2, 0.0, 0.0); // committed, will be patched
    let batch = locations_to_batch(&[b1, b2]);

    let mut p2 = loc(2, 1.0, 1.0); // edited -> uncommitted
    p2.heading = 90.0;
    let a3 = loc(3, 0.0, 0.0); // new add -> uncommitted
    let adds = vec![a3];
    let fx = Fx::batch(batch).with_adds(adds).with_patch(2, p2);
    let view = fx.view();

    assert_eq!(ids_of(&view, &Selector::Uncommitted), vec![2, 3]);
}

#[test]
fn resolve_reviewed_is_an_id_set_leaf_over_batch() {
    let locs = vec![
        loc(1, 0.0, 0.0),
        loc(2, 0.0, 0.0),
        loc(3, 0.0, 0.0),
        loc(4, 0.0, 0.0),
    ];
    let fx = Fx::base(&locs);
    let view = fx.view();
    let ids = ids_of(
        &view,
        &Selector::Reviewed {
            locations: vec![2, 4],
            session_id: "abc".into(),
            mode: "reviewed".into(),
        },
    );
    assert_eq!(ids, vec![2, 4]);
}

#[test]
fn resolve_reviewed_on_adds() {
    let adds = vec![loc(1, 0.0, 0.0), loc(2, 0.0, 0.0), loc(3, 0.0, 0.0)];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(
        &view,
        &Selector::Reviewed {
            locations: vec![1, 3],
            session_id: "s".into(),
            mode: "unreviewed".into(),
        },
    );
    assert_eq!(ids, vec![1, 3]);
}

// -----------------------------------------------------------------------
// Tag membership index (roaring fast-path) — must match the scan path exactly.
// -----------------------------------------------------------------------

// Build a batch of tagged locations + the matching tag index, so the indexed Tag
// leaf and the scan-path Tag leaf can be compared on identical data.
fn tagged_batch_and_index(locs: &[Location]) -> (RecordBatch, HashMap<u32, RoaringBitmap>) {
    let batch = locations_to_batch(locs);
    let mut sets: HashMap<u32, RoaringBitmap> = HashMap::new();
    for l in locs {
        for &t in &l.tags {
            sets.entry(t).or_default().insert(l.id);
        }
    }
    (batch, sets)
}

#[test]
fn tag_index_matches_scan_path() {
    let mut a = loc(1, 0.0, 0.0);
    a.tags = vec![10, 20];
    let mut b = loc(2, 0.0, 0.0);
    b.tags = vec![20];
    let mut c = loc(3, 0.0, 0.0);
    c.tags = vec![10];
    let locs = vec![a, b, c];
    let (batch, sets) = tagged_batch_and_index(&locs);
    let fx = Fx::batch(batch);
    let scan = fx.view();
    let idx = fx.view_indexed(&sets);

    for tag_id in [10u32, 20, 99] {
        let s = ids_of(&scan, &Selector::Tag { tag_id });
        let i = ids_of(&idx, &Selector::Tag { tag_id });
        assert_eq!(s, i, "tag {tag_id}: scan {s:?} != index {i:?}");
    }
    // sanity on the actual membership
    assert_eq!(ids_of(&idx, &Selector::Tag { tag_id: 10 }), vec![1, 3]);
}

#[test]
fn tag_index_excludes_dead_includes_adds() {
    let mut a = loc(1, 0.0, 0.0);
    a.tags = vec![10];
    let mut b = loc(2, 0.0, 0.0);
    b.tags = vec![10];
    let (batch, sets) = tagged_batch_and_index(&[a, b]);
    let mut add = loc(3, 0.0, 0.0);
    add.tags = vec![10]; // overlay add carries the tag
    let fx = Fx::batch(batch).with_adds(vec![add]).with_dead([2]);
    let idx = fx.view_indexed(&sets);
    // 2 is dead -> excluded; 3 is an overlay add -> included; 1 stays.
    assert_eq!(ids_of(&idx, &Selector::Tag { tag_id: 10 }), vec![1, 3]);
}

#[test]
fn tag_index_honors_patches() {
    // Base: loc 1 has tag 10, loc 2 has nothing. Index reflects the base.
    let mut a = loc(1, 0.0, 0.0);
    a.tags = vec![10];
    let b = loc(2, 0.0, 0.0);
    let (batch, sets) = tagged_batch_and_index(&[a, b]);
    // Patch: loc 1 LOSES tag 10, loc 2 GAINS tag 10 (uncommitted edits the index can't see).
    let mut p1 = loc(1, 0.0, 0.0);
    p1.tags = vec![];
    let mut p2 = loc(2, 0.0, 0.0);
    p2.tags = vec![10];
    let fx = Fx::batch(batch).with_patch(1, p1).with_patch(2, p2);
    let idx = fx.view_indexed(&sets);
    // Patches must override the stale index: 1 dropped, 2 added.
    assert_eq!(ids_of(&idx, &Selector::Tag { tag_id: 10 }), vec![2]);
}

#[test]
fn tag_index_in_composite() {
    let mut a = loc(1, 0.0, 0.0);
    a.tags = vec![10, 20];
    let mut b = loc(2, 0.0, 0.0);
    b.tags = vec![10];
    let mut c = loc(3, 0.0, 0.0);
    c.tags = vec![20];
    let (batch, sets) = tagged_batch_and_index(&[a, b, c]);
    let fx = Fx::batch(batch);
    let idx = fx.view_indexed(&sets);

    let t10 = Selection {
        key: "t10".into(),
        color: [0, 0, 0],
        selector: Selector::Tag { tag_id: 10 },
    };
    let t20 = Selection {
        key: "t20".into(),
        color: [0, 0, 0],
        selector: Selector::Tag { tag_id: 20 },
    };
    // 10 AND 20 -> only loc 1
    let inter = ids_of(
        &idx,
        &Selector::Intersection {
            selections: vec![t10.clone(), t20.clone()],
        },
    );
    assert_eq!(inter, vec![1]);
    // 10 OR 20 -> all three
    let union = ids_of(
        &idx,
        &Selector::Union {
            selections: vec![t10, t20],
        },
    );
    assert_eq!(union, vec![1, 2, 3]);
}

#[test]
fn resolve_unpanned() {
    let l1 = loc(1, 0.0, 0.0); // heading = 0
    let mut l2 = loc(2, 0.0, 0.0);
    l2.heading = 90.0;
    let adds = vec![l1, l2];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(&view, &Selector::Unpanned);
    assert_eq!(ids, vec![1]);
}

#[test]
fn resolve_panoids() {
    let mut l1 = loc(1, 0.0, 0.0);
    l1.flags = LocationFlags::LOAD_AS_PANO_ID;
    let l2 = loc(2, 0.0, 0.0);
    let adds = vec![l1, l2];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let pano = ids_of(&view, &Selector::PanoIds);
    let not_pano = ids_of(&view, &Selector::NotPanoIds);
    assert_eq!(pano, vec![1]);
    assert_eq!(not_pano, vec![2]);
}

#[test]
fn resolve_with_dead_batch_rows() {
    let locs = vec![loc(1, 10.0, 20.0), loc(2, 30.0, 40.0), loc(3, 50.0, 60.0)];
    let fx = Fx::base(&locs).with_dead([2]);
    let view = fx.view();
    let ids = ids_of(&view, &Selector::Everything);
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&1));
    assert!(ids.contains(&3));
    assert!(!ids.contains(&2));
}

#[test]
fn resolve_with_patched_tags() {
    let locs = vec![loc(1, 0.0, 0.0), loc(2, 0.0, 0.0)];
    let mut patched = loc(1, 0.0, 0.0);
    patched.tags = vec![10];
    let fx = Fx::base(&locs).with_patch(1, patched);
    let view = fx.view();
    let ids = ids_of(&view, &Selector::Tag { tag_id: 10 });
    assert_eq!(ids, vec![1]);
}

// -----------------------------------------------------------------------
// Composite selections
// -----------------------------------------------------------------------

#[test]
fn resolve_intersection() {
    let mut l1 = loc(1, 0.0, 0.0);
    l1.tags = vec![10];
    l1.flags = LocationFlags::LOAD_AS_PANO_ID;
    let mut l2 = loc(2, 0.0, 0.0);
    l2.tags = vec![10];
    let mut l3 = loc(3, 0.0, 0.0);
    l3.flags = LocationFlags::LOAD_AS_PANO_ID;
    let adds = vec![l1, l2, l3];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let selector = Selector::Intersection {
        selections: vec![
            Selection {
                key: "a".into(),
                color: [0, 0, 0],
                selector: Selector::Tag { tag_id: 10 },
            },
            Selection {
                key: "b".into(),
                color: [0, 0, 0],
                selector: Selector::PanoIds,
            },
        ],
    };
    let ids = ids_of(&view, &selector);
    assert_eq!(ids, vec![1]); // only l1 has both tag 10 and PanoId flag
}

#[test]
fn resolve_union() {
    let mut l1 = loc(1, 0.0, 0.0);
    l1.tags = vec![10];
    let mut l2 = loc(2, 0.0, 0.0);
    l2.flags = LocationFlags::LOAD_AS_PANO_ID;
    let l3 = loc(3, 0.0, 0.0);
    let adds = vec![l1, l2, l3];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let selector = Selector::Union {
        selections: vec![
            Selection {
                key: "a".into(),
                color: [0, 0, 0],
                selector: Selector::Tag { tag_id: 10 },
            },
            Selection {
                key: "b".into(),
                color: [0, 0, 0],
                selector: Selector::PanoIds,
            },
        ],
    };
    let ids = ids_of(&view, &selector);
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&1));
    assert!(ids.contains(&2));
}

#[test]
fn resolve_invert() {
    let mut l1 = loc(1, 0.0, 0.0);
    l1.flags = LocationFlags::LOAD_AS_PANO_ID;
    let l2 = loc(2, 0.0, 0.0);
    let l3 = loc(3, 0.0, 0.0);
    let adds = vec![l1, l2, l3];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let selector = Selector::Invert {
        selections: vec![Selection {
            key: "a".into(),
            color: [0, 0, 0],
            selector: Selector::PanoIds,
        }],
    };
    let ids = ids_of(&view, &selector);
    assert_eq!(ids.len(), 2);
    assert!(ids.contains(&2));
    assert!(ids.contains(&3));
}

// -----------------------------------------------------------------------
// Per-node counts (resolve_node_counts)
// -----------------------------------------------------------------------

// Counts must cover every node — the composite AND its nested children, keyed by key.
#[test]
fn node_counts_cover_nested_children() {
    let mut l1 = loc(1, 0.0, 0.0);
    l1.tags = vec![10, 20];
    let mut l2 = loc(2, 0.0, 0.0);
    l2.tags = vec![10];
    let mut l3 = loc(3, 0.0, 0.0);
    l3.tags = vec![20];
    let adds = vec![l1, l2, l3];
    let fx = Fx::adds(adds);
    let view = fx.view();

    let tree = vec![Selection {
        key: "root".into(),
        color: [0, 0, 0],
        selector: Selector::Intersection {
            selections: vec![
                Selection {
                    key: "a".into(),
                    color: [0, 0, 0],
                    selector: Selector::Tag { tag_id: 10 },
                },
                Selection {
                    key: "b".into(),
                    color: [0, 0, 0],
                    selector: Selector::Tag { tag_id: 20 },
                },
            ],
        },
    }];

    let counts = resolve_node_counts(&view, &tree);
    assert_eq!(counts.get("a"), Some(&2)); // tag 10: l1, l2
    assert_eq!(counts.get("b"), Some(&2)); // tag 20: l1, l3
    assert_eq!(counts.get("root"), Some(&1)); // intersection: only l1 has both
}

// Invert's count is the global complement (universe - inner), not parent-relative.
#[test]
fn node_counts_invert_is_global_complement() {
    let mut l1 = loc(1, 0.0, 0.0);
    l1.tags = vec![10];
    let l2 = loc(2, 0.0, 0.0);
    let l3 = loc(3, 0.0, 0.0);
    let adds = vec![l1, l2, l3];
    let fx = Fx::adds(adds);
    let view = fx.view();

    let tree = vec![Selection {
        key: "inv".into(),
        color: [0, 0, 0],
        selector: Selector::Invert {
            selections: vec![Selection {
                key: "t".into(),
                color: [0, 0, 0],
                selector: Selector::Tag { tag_id: 10 },
            }],
        },
    }];

    let counts = resolve_node_counts(&view, &tree);
    assert_eq!(counts.get("t"), Some(&1)); // tag 10: l1
    assert_eq!(counts.get("inv"), Some(&2)); // NOT tag 10: l2, l3 (universe of 3 minus 1)
}

// The single-pass forest must produce exactly what per-selection resolve does —
// same top-level sets, same count for every node key.
#[test]
fn resolve_forest_matches_individual_resolve() {
    let mut l1 = loc(1, 0.0, 0.0);
    l1.tags = vec![10, 20];
    let mut l2 = loc(2, 0.0, 0.0);
    l2.tags = vec![10];
    let mut l3 = loc(3, 5.0, 5.0);
    l3.tags = vec![20];
    let l4 = loc(4, 5.0, 5.0);
    let adds = vec![l1, l2, l3, l4];
    let fx = Fx::adds(adds);
    let view = fx.view();

    let sels = vec![
        Selection {
            key: "t10".into(),
            color: [0, 0, 0],
            selector: Selector::Tag { tag_id: 10 },
        },
        Selection {
            key: "inv".into(),
            color: [0, 0, 0],
            selector: Selector::Invert {
                selections: vec![Selection {
                    key: "u".into(),
                    color: [0, 0, 0],
                    selector: Selector::Union {
                        selections: vec![
                            Selection {
                                key: "a".into(),
                                color: [0, 0, 0],
                                selector: Selector::Tag { tag_id: 10 },
                            },
                            Selection {
                                key: "b".into(),
                                color: [0, 0, 0],
                                selector: Selector::Tag { tag_id: 20 },
                            },
                        ],
                    },
                }],
            },
        },
        Selection {
            key: "none".into(),
            color: [0, 0, 0],
            selector: Selector::Untagged,
        },
    ];

    let (sets, counts) = resolve_forest(&view, &sels);
    assert_eq!(sets.len(), sels.len());
    for (i, sel) in sels.iter().enumerate() {
        assert_eq!(
            sets[i],
            resolve(&view, &sel.selector),
            "set mismatch for {}",
            sel.key
        );
    }
    for key in ["t10", "inv", "u", "a", "b", "none"] {
        assert!(counts.contains_key(key), "missing count for {key}");
    }
    assert_eq!(counts.get("t10"), Some(&2));
    assert_eq!(counts.get("u"), Some(&3)); // union of tag10 {1,2} and tag20 {1,3}
    assert_eq!(counts.get("inv"), Some(&1)); // universe {1..4} minus union {1,2,3}
    assert_eq!(counts.get("none"), Some(&1)); // l4
}

// -----------------------------------------------------------------------
// Duplicates
// -----------------------------------------------------------------------

#[test]
fn duplicates_finds_nearby() {
    let adds = vec![
        loc(1, 51.5000, -0.1000),
        loc(2, 51.5000, -0.1000), // exact same
        loc(3, 0.0, 0.0),         // far away
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(&view, &Selector::Duplicates { distance: 1.0 });
    assert!(ids.contains(&1));
    assert!(ids.contains(&2));
    assert!(!ids.contains(&3));
}

// Chain A~B~C at ~1.1m steps, 2m threshold, A-C out of range: every point with a
// within-distance neighbour is a duplicate. C's only witness pair (B, C) fires from
// anchor B, so B must not be skipped just because an earlier anchor grouped it.
#[test]
fn duplicates_chain_marks_all_members() {
    let adds = vec![
        loc(1, 0.00000, 0.0),
        loc(2, 0.00001, 0.0),
        loc(3, 0.00002, 0.0),
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(&view, &Selector::Duplicates { distance: 2.0 });
    assert_eq!(ids, vec![1, 2, 3]);
}

// The Duplicates selection and the merge dialog's groups are two views of the same
// relation: "has a neighbour within d" == "member of a component of size >= 2".
#[test]
fn duplicates_bitmask_matches_flattened_groups() {
    let adds = vec![
        // chain of three
        loc(1, 0.00000, 0.0),
        loc(2, 0.00001, 0.0),
        loc(3, 0.00002, 0.0),
        // tight pair
        loc(4, 10.0, 10.0),
        loc(5, 10.000005, 10.0),
        // singletons
        loc(6, 20.0, 20.0),
        loc(7, -30.0, 40.0),
        // coincident stack
        loc(8, 50.0, 50.0),
        loc(9, 50.0, 50.0),
        loc(10, 50.0, 50.0),
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    for d in [0.5, 2.0, 25.0] {
        let selected = ids_of(&view, &Selector::Duplicates { distance: d });
        let mut grouped: Vec<u32> = find_duplicate_groups(&view, d)
            .into_iter()
            .flatten()
            .collect();
        grouped.sort_unstable();
        assert_eq!(selected, grouped, "bitmask != groups at d={d}");
    }
}

// The grid broad-phase must not miss longitude-separated pairs at high latitude.
// Oracle: brute-force nearest-neighbor haversine, with a 0.5m dead band around the
// threshold so equirect-vs-haversine rounding on borderline pairs can't flake the assert.
#[test]
fn duplicates_match_brute_force_at_high_latitude() {
    let mut rng = fastrand::Rng::with_seed(42);
    for &lat0 in &[70.0f64, 78.0] {
        let adds: Vec<Location> = (0..300)
            .map(|i| {
                let lat = lat0 + (rng.f64() - 0.5) * 0.01;
                let lng = 20.0 + (rng.f64() - 0.5) * 0.05;
                loc(i + 1, lat, lng)
            })
            .collect();
        let d = 100.0;
        let fx = Fx::adds(adds);
        let ids: HashSet<u32> = ids_of(&fx.view(), &Selector::Duplicates { distance: d })
            .into_iter()
            .collect();
        for a in &fx.adds {
            let nn = fx
                .adds
                .iter()
                .filter(|b| b.id != a.id)
                .map(|b| haversine_m(a.lat, a.lng, b.lat, b.lng))
                .fold(f64::INFINITY, f64::min);
            if nn <= d - 0.5 {
                assert!(
                    ids.contains(&a.id),
                    "missed dup id {} at lat0={} (nn={nn:.1}m)",
                    a.id,
                    lat0
                );
            } else if nn >= d + 0.5 {
                assert!(
                    !ids.contains(&a.id),
                    "false dup id {} at lat0={} (nn={nn:.1}m)",
                    a.id,
                    lat0
                );
            }
        }
    }
}

// Pairs straddling the antimeridian are real neighbors (~106m here) and must be
// detected; the third point is ~1km away on the same side and must not be.
#[test]
fn duplicates_detected_across_antimeridian() {
    let fx = Fx::adds(vec![
        loc(1, -17.8, 179.9995),
        loc(2, -17.8, -179.9995),
        loc(3, -17.8, 179.99),
    ]);
    let ids = ids_of(&fx.view(), &Selector::Duplicates { distance: 150.0 });
    assert_eq!(ids, vec![1, 2]);
}

// Dense cluster: every member of a same-cell stack is a duplicate at d > 0.
#[test]
fn duplicates_dense_cluster_marks_every_member() {
    let adds: Vec<Location> = (0..50).map(|i| loc(i + 1, 12.0, 34.0)).collect();
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(&view, &Selector::Duplicates { distance: 5.0 });
    assert_eq!(ids.len(), 50);
}

// distance == 0 means exact-coordinate duplicates. Must not overflow (debug) and must
// match only locations at the identical coordinate. (#69)
#[test]
fn duplicates_zero_distance_is_exact_match() {
    let adds = vec![
        loc(1, 51.5000, -0.1000),
        loc(2, 51.5000, -0.1000), // exact same -> dup of 1
        loc(3, 51.5000, -0.1001), // 1 m off -> not a 0 m dup
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(&view, &Selector::Duplicates { distance: 0.0 });
    assert!(ids.contains(&1));
    assert!(ids.contains(&2));
    assert!(!ids.contains(&3));
}

// A non-finite coordinate floors to i32::MAX; the neighbor key must not overflow.
#[test]
fn duplicates_non_finite_coord_does_not_overflow() {
    let adds = vec![
        loc(1, 51.5, -0.1),
        loc(2, 51.5, -0.1),
        loc(3, f64::INFINITY, 0.0),
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(&view, &Selector::Duplicates { distance: 10.0 });
    assert!(ids.contains(&1));
    assert!(ids.contains(&2));
    assert!(!ids.contains(&3));
}

// 0.00001 deg latitude ~= 1.11 m. Three points spaced one step apart chain pairwise
// (1-2, 2-3) but 1-3 (~2.22 m) exceeds a 2 m threshold: only transitivity unites them.
#[test]
fn duplicate_groups_are_transitive() {
    let adds = vec![
        loc(1, 0.00000, 0.0),
        loc(2, 0.00001, 0.0),
        loc(3, 0.00002, 0.0),
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let groups = find_duplicate_groups(&view, 2.0);
    assert_eq!(groups, vec![vec![1, 2, 3]]);
}

#[test]
fn duplicate_groups_separate_clusters_and_drop_singletons() {
    let adds = vec![
        loc(1, 0.00000, 0.0),
        loc(2, 0.00001, 0.0), // with 1
        loc(4, 0.50000, 0.0),
        loc(5, 0.50001, 0.0), // with 4
        loc(6, 0.80000, 0.0), // alone -> excluded
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let groups = find_duplicate_groups(&view, 2.0);
    assert_eq!(groups, vec![vec![1, 2], vec![4, 5]]);
}

#[test]
fn duplicate_groups_empty_when_all_far() {
    let adds = vec![loc(1, 0.0, 0.0), loc(2, 0.5, 0.0), loc(3, 1.0, 0.0)];
    let fx = Fx::adds(adds);
    let view = fx.view();
    assert!(find_duplicate_groups(&view, 2.0).is_empty());
}

// -----------------------------------------------------------------------
// prune_duplicates
// -----------------------------------------------------------------------

fn no_keep() -> HashSet<u32> {
    HashSet::new()
}

// <= 25m relevance mode: the best-scored location in a cluster survives.
#[test]
fn prune_relevance_keeps_highest_score() {
    let mut best = loc(1, 0.00000, 0.0);
    best.pano_id = Some("p".into());
    best.tags = vec![7];
    let locs = vec![best, loc(2, 0.00001, 0.0), loc(3, 0.00002, 0.0)];
    let mut removed = prune_duplicates(&locs, 10.0, &no_keep());
    removed.sort_unstable();
    assert_eq!(removed, vec![2, 3]);
}

// Keep-tag bonus (+5) outweighs raw tag count.
#[test]
fn prune_relevance_keep_tag_beats_tag_count() {
    let mut tagged = loc(1, 0.00000, 0.0);
    tagged.tags = vec![1, 2, 3];
    let mut keep = loc(2, 0.00001, 0.0);
    keep.tags = vec![9];
    let keep_ids: HashSet<u32> = [9].into_iter().collect();
    let removed = prune_duplicates(&[tagged, keep], 10.0, &keep_ids);
    assert_eq!(removed, vec![1]);
}

// Score tie: the oldest location survives.
#[test]
fn prune_relevance_tie_keeps_oldest() {
    let mut old = loc(1, 0.00000, 0.0);
    old.created_at = 100;
    let mut new = loc(2, 0.00001, 0.0);
    new.created_at = 200;
    let removed = prune_duplicates(&[new, old], 10.0, &no_keep());
    assert_eq!(removed, vec![2]);
}

// Informational locations are never pruned and never anchor a cluster.
#[test]
fn prune_never_touches_informational() {
    let mut info = loc(1, 0.00000, 0.0);
    info.flags = LocationFlags::INFORMATIONAL;
    let locs = vec![info, loc(2, 0.00001, 0.0), loc(3, 0.00002, 0.0)];
    let removed = prune_duplicates(&locs, 10.0, &no_keep());
    assert_eq!(removed.len(), 1);
    assert!(!removed.contains(&1));
}

// Chain at ~1.1m steps with 2m threshold: clusters are radius-based, not transitive.
// Anchor 1's cluster {1,2} keeps 1; then 3 is alone (2 pruned) -> 3 survives too.
#[test]
fn prune_relevance_is_radius_scoped_not_transitive() {
    let locs = vec![
        loc(1, 0.00000, 0.0),
        loc(2, 0.00001, 0.0),
        loc(3, 0.00002, 0.0),
    ];
    let removed = prune_duplicates(&locs, 2.0, &no_keep());
    assert_eq!(removed, vec![2]);
}

// > 25m thinning mode: the chain's hub (most neighbours) goes first, endpoints survive.
// 0.0003 deg ~= 33m; threshold 40m links 1-2 and 2-3 but not 1-3 (~66m).
#[test]
fn prune_thinning_drops_hub_keeps_endpoints() {
    let locs = vec![
        loc(1, 0.0000, 0.0),
        loc(2, 0.0003, 0.0),
        loc(3, 0.0006, 0.0),
    ];
    let removed = prune_duplicates(&locs, 40.0, &no_keep());
    assert_eq!(removed, vec![2]);
}

// Thinning invariant: no two survivors remain within the distance.
#[test]
fn prune_thinning_no_survivors_in_range() {
    let mut locs = Vec::new();
    for i in 0..12u32 {
        locs.push(loc(i + 1, 0.0003 * f64::from(i), 0.0)); // ~33m spacing
    }
    let removed = prune_duplicates(&locs, 40.0, &no_keep());
    let removed_set: HashSet<u32> = removed.iter().copied().collect();
    let survivors: Vec<&Location> = locs
        .iter()
        .filter(|l| !removed_set.contains(&l.id))
        .collect();
    assert!(survivors.len() >= 2);
    for a in 0..survivors.len() {
        for b in (a + 1)..survivors.len() {
            let d = haversine_m(
                survivors[a].lat,
                survivors[a].lng,
                survivors[b].lat,
                survivors[b].lng,
            );
            assert!(
                d > 40.0,
                "survivors {} and {} are {}m apart",
                survivors[a].id,
                survivors[b].id,
                d
            );
        }
    }
}

// -----------------------------------------------------------------------
// Filter on adds
// -----------------------------------------------------------------------

#[test]
fn extra_filter_eq_on_adds() {
    let mut l1 = loc(1, 0.0, 0.0);
    l1.extra = Some(serde_json::from_str(r#"{"country":"BR"}"#).unwrap());
    let mut l2 = loc(2, 0.0, 0.0);
    l2.extra = Some(serde_json::from_str(r#"{"country":"US"}"#).unwrap());
    let adds = vec![l1, l2];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(
        &view,
        &Selector::Filter {
            field: "country".into(),
            op: FilterOp::Eq,
            value: serde_json::json!("BR"),
            value2: None,
            tz_local: false,
        },
    );
    assert_eq!(ids, vec![1]);
}

// Base-batch extras go through the byte-scan path (no full JSON parse per row):
// top-level keys resolve; the same key nested inside another value must not.
#[test]
fn extra_filter_scans_base_batch_top_level_only() {
    let mut l1 = loc(1, 0.0, 0.0);
    l1.extra =
        Some(serde_json::from_str(r#"{"alt":100,"note":"a\"b}","wrap":{"alt":999}}"#).unwrap());
    let mut l2 = loc(2, 0.0, 0.0);
    l2.extra = Some(serde_json::from_str(r#"{"wrap":{"alt":100}}"#).unwrap());
    let fx = Fx::base(&[l1, l2]);
    let view = fx.view();

    let filter = |field: &str, op: FilterOp, value: serde_json::Value| Selector::Filter {
        field: field.into(),
        op,
        value,
        value2: None,
        tz_local: false,
    };
    // l1 matches on its top-level alt; l2's nested alt must not count.
    assert_eq!(
        ids_of(&view, &filter("alt", FilterOp::Eq, serde_json::json!(100))),
        vec![1]
    );
    assert_eq!(
        ids_of(
            &view,
            &filter("alt", FilterOp::Has, serde_json::Value::Null)
        ),
        vec![1]
    );
    // Escaped quote and brace inside a string value must not derail the scan.
    assert_eq!(
        ids_of(
            &view,
            &filter("note", FilterOp::Eq, serde_json::json!("a\"b}"))
        ),
        vec![1]
    );
}

// A field whose name arrived ASCII-escaped (`"café"`) is canonicalized on ingest,
// so filtering it by name matches instead of silently returning nothing.
#[test]
fn extra_filter_matches_ascii_escaped_field_name() {
    let bs = '\\';
    let mut l1 = loc(1, 0.0, 0.0);
    l1.extra = RawExtra::from_string(format!("{{\"caf{bs}u00e9\":\"noir\"}}"));
    let fx = Fx::batch(locations_to_batch(&[l1]));
    let view = fx.view();

    assert_eq!(
        ids_of(
            &view,
            &Selector::Filter {
                field: "café".into(),
                op: FilterOp::Eq,
                value: serde_json::json!("noir"),
                value2: None,
                tz_local: false,
            }
        ),
        vec![1]
    );
}

// -----------------------------------------------------------------------
// tz_local filters: bucket each location's absolute `datetime` into its own
// timezone before comparing. Same instant, different zones -> different days.
// -----------------------------------------------------------------------

fn tz_fixture() -> Vec<Location> {
    // 2020-03-01 00:00:00 UTC. In Tokyo that's Mar 1 09:00; in New York Feb 29 19:00.
    let ts = 1583020800u64;
    let mut tokyo = loc(1, 0.0, 0.0);
    tokyo.extra =
        RawExtra::from_value(&serde_json::json!({ "datetime": ts, "timezone": "Asia/Tokyo" }));
    let mut newyork = loc(2, 0.0, 0.0);
    newyork.extra = RawExtra::from_value(
        &serde_json::json!({ "datetime": ts, "timezone": "America/New_York" }),
    );
    let mut no_tz = loc(3, 0.0, 0.0);
    no_tz.extra = RawExtra::from_value(&serde_json::json!({ "datetime": ts }));
    vec![tokyo, newyork, no_tz]
}

#[test]
fn filter_tz_local_between_buckets_per_timezone() {
    let adds = tz_fixture();
    let fx = Fx::adds(adds);
    let view = fx.view();

    // Filter "all of Mar 1, 2020" as wall-clock-as-UTC epoch seconds.
    let lo = serde_json::json!(1583020800u64); // 2020-03-01 00:00
    let hi = serde_json::json!(1583107140u64); // 2020-03-01 23:59
    let ids = ids_of(
        &view,
        &Selector::Filter {
            field: "datetime".into(),
            op: FilterOp::Between,
            value: lo,
            value2: Some(hi),
            tz_local: true,
        },
    );
    // Tokyo lands on Mar 1 -> in; New York is Feb 29 -> out; no timezone -> excluded.
    assert_eq!(ids, vec![1]);
}

// Same assertions against baked Arrow rows: covers the single-parse extras path
// in resolve_field_and_tz (the adds-based tests go through the Location path).
#[test]
fn filter_tz_local_between_on_base_batch() {
    let fx = Fx::base(&tz_fixture());
    let view = fx.view();
    let ids = ids_of(
        &view,
        &Selector::Filter {
            field: "datetime".into(),
            op: FilterOp::Between,
            value: serde_json::json!(1583020800u64),
            value2: Some(serde_json::json!(1583107140u64)),
            tz_local: true,
        },
    );
    assert_eq!(ids, vec![1]);
}

#[test]
fn filter_tz_local_anyyear_uses_local_month_day() {
    let adds = tz_fixture();
    let fx = Fx::adds(adds);
    let view = fx.view();

    // Feb 29 in the pano's local clock: only New York (Feb 29 19:00 local) matches.
    let ids = ids_of(
        &view,
        &Selector::Filter {
            field: "datetime".into(),
            op: FilterOp::BetweenAnyyear,
            value: serde_json::json!("02-29"),
            value2: Some(serde_json::json!("02-29")),
            tz_local: true,
        },
    );
    assert_eq!(ids, vec![2]);
}

#[test]
fn filter_tz_local_anytime_uses_local_clock() {
    let adds = tz_fixture();
    let fx = Fx::adds(adds);
    let view = fx.view();

    // Morning (in the pano's local clock): Tokyo is 09:00 -> in; New York 19:00 -> out.
    let ids = ids_of(
        &view,
        &Selector::Filter {
            field: "datetime".into(),
            op: FilterOp::BetweenAnytime,
            value: serde_json::json!("06:00"),
            value2: Some(serde_json::json!("12:00")),
            tz_local: true,
        },
    );
    assert_eq!(ids, vec![1]);
}

// The flag is ignored for ops where a clock frame is meaningless: nothas keeps its
// normal missing-field semantics instead of excluding everything.
#[test]
fn filter_tz_local_ignored_for_nothas() {
    let mut with_field = loc(1, 0.0, 0.0);
    with_field.extra = RawExtra::from_value(&serde_json::json!({ "datetime": 100 }));
    let without = loc(2, 0.0, 0.0);
    let adds = vec![with_field, without];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(
        &view,
        &Selector::Filter {
            field: "datetime".into(),
            op: FilterOp::Nothas,
            value: serde_json::Value::Null,
            value2: None,
            tz_local: true,
        },
    );
    assert_eq!(ids, vec![2]);
}

// -----------------------------------------------------------------------
// Partition: group-by aggregation (parity with JS fieldOps/binNumeric)
// -----------------------------------------------------------------------

fn loc_extra(id: u32, extra: serde_json::Value) -> Location {
    Location {
        extra: RawExtra::from_value(&extra),
        ..loc(id, 0.0, 0.0)
    }
}

// --- TopK ---

#[test]
fn topk_selects_highest() {
    let locs = vec![
        loc_extra(1, serde_json::json!({"alt": 100})),
        loc_extra(2, serde_json::json!({"alt": 300})),
        loc_extra(3, serde_json::json!({"alt": 200})),
        loc_extra(4, serde_json::json!({"alt": 500})),
        loc_extra(5, serde_json::json!({"alt": 400})),
    ];
    let fx = Fx::adds(locs);
    let view = fx.view();
    let ids = ids_of(
        &view,
        &Selector::TopK {
            field: "alt".into(),
            k: 3,
            ascending: false,
        },
    );
    assert_eq!(ids, vec![2, 4, 5]); // 500, 400, 300
}

#[test]
fn topk_selects_lowest() {
    let locs = vec![
        loc_extra(1, serde_json::json!({"alt": 100})),
        loc_extra(2, serde_json::json!({"alt": 300})),
        loc_extra(3, serde_json::json!({"alt": 200})),
        loc_extra(4, serde_json::json!({"alt": 500})),
        loc_extra(5, serde_json::json!({"alt": 400})),
    ];
    let fx = Fx::adds(locs);
    let view = fx.view();
    let ids = ids_of(
        &view,
        &Selector::TopK {
            field: "alt".into(),
            k: 2,
            ascending: true,
        },
    );
    assert_eq!(ids, vec![1, 3]); // 100, 200
}

#[test]
fn topk_skips_missing_field() {
    let locs = vec![
        loc_extra(1, serde_json::json!({"alt": 100})),
        loc_extra(2, serde_json::json!({})),
        loc_extra(3, serde_json::json!({"alt": 50})),
    ];
    let fx = Fx::adds(locs);
    let view = fx.view();
    let ids = ids_of(
        &view,
        &Selector::TopK {
            field: "alt".into(),
            k: 10,
            ascending: false,
        },
    );
    assert_eq!(ids, vec![1, 3]); // only 2 have the field, k=10 returns all available
}

#[test]
fn topk_works_on_base_batch() {
    let locs = vec![
        loc_extra(1, serde_json::json!({"val": 10})),
        loc_extra(2, serde_json::json!({"val": 30})),
        loc_extra(3, serde_json::json!({"val": 20})),
    ];
    let fx = Fx::base(&locs);
    let view = fx.view();
    let ids = ids_of(
        &view,
        &Selector::TopK {
            field: "val".into(),
            k: 1,
            ascending: false,
        },
    );
    assert_eq!(ids, vec![2]); // 30 is highest
}

#[test]
fn topk_zero_k_selects_nothing() {
    let locs = vec![
        loc_extra(1, serde_json::json!({"alt": 100})),
        loc_extra(2, serde_json::json!({"alt": 200})),
    ];
    let fx = Fx::adds(locs);
    let view = fx.view();
    let ids = ids_of(
        &view,
        &Selector::TopK {
            field: "alt".into(),
            k: 0,
            ascending: false,
        },
    );
    assert_eq!(ids, Vec::<u32>::new());
}

#[test]
fn topk_k_equals_len_selects_all() {
    let locs = vec![
        loc_extra(1, serde_json::json!({"alt": 100})),
        loc_extra(2, serde_json::json!({"alt": 300})),
        loc_extra(3, serde_json::json!({"alt": 200})),
    ];
    let fx = Fx::adds(locs);
    let view = fx.view();
    let ids = ids_of(
        &view,
        &Selector::TopK {
            field: "alt".into(),
            k: 3,
            ascending: false,
        },
    );
    assert_eq!(ids, vec![1, 2, 3]);
}

#[test]
fn partition_numeric_count_matches_js() {
    let adds = vec![
        loc_extra(1, serde_json::json!({"alt": 0})),
        loc_extra(2, serde_json::json!({"alt": 50})),
        loc_extra(3, serde_json::json!({"alt": 100})),
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let groups = partition(
        &view,
        "alt",
        &KeySpec::NumericBin {
            binning: NumericBinning::Count { n: 2 },
        },
        None,
    );
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0].key, "0–50");
    assert_eq!(groups[0].bin, Some([0.0, 50.0]));
    assert_eq!(groups[1].key, "50–100");
    assert_eq!(groups[1].bin, Some([50.0, 100.0]));
    let mut all: Vec<u32> = groups.iter().flat_map(|g| g.ids.clone()).collect();
    all.sort();
    assert_eq!(all, vec![1, 2, 3]);
}

#[test]
fn partition_numeric_width_anchors_at_multiples() {
    let adds = vec![
        loc_extra(1, serde_json::json!({"n": 84})),
        loc_extra(2, serde_json::json!({"n": 1237})),
        loc_extra(3, serde_json::json!({"n": 1300})),
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let groups = partition(
        &view,
        "n",
        &KeySpec::NumericBin {
            binning: NumericBinning::Width { w: 500.0 },
        },
        None,
    );
    let g0 = groups.iter().find(|g| g.key == "0–500").unwrap();
    assert_eq!(g0.ids, vec![1]);
    let g2 = groups.iter().find(|g| g.key == "1000–1500").unwrap();
    let mut ids = g2.ids.clone();
    ids.sort();
    assert_eq!(ids, vec![2, 3]);
    let gap = groups.iter().find(|g| g.key == "500–1000").unwrap();
    assert!(gap.ids.is_empty());
    assert_eq!(gap.bin, Some([500.0, 1000.0]));
}

#[test]
fn partition_numeric_drops_empties_once_the_table_would_be_unusable() {
    let adds = vec![
        loc_extra(1, serde_json::json!({"n": 0})),
        loc_extra(2, serde_json::json!({"n": 150})),
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let groups = partition(
        &view,
        "n",
        &KeySpec::NumericBin {
            binning: NumericBinning::Width { w: 1.0 },
        },
        None,
    );
    assert_eq!(groups.len(), 2);
    assert!(groups.iter().all(|g| !g.ids.is_empty()));
}

#[test]
fn partition_value_never_invents_a_group() {
    let adds = vec![
        loc_extra(1, serde_json::json!({"c": "a"})),
        loc_extra(2, serde_json::json!({"c": "c"})),
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let groups = partition(&view, "c", &KeySpec::Value, None);
    assert_eq!(groups.len(), 2);
    assert!(groups.iter().all(|g| !g.ids.is_empty()));
}

#[test]
fn partition_value_groups_by_distinct() {
    let adds = vec![
        loc_extra(1, serde_json::json!({"c": "FR"})),
        loc_extra(2, serde_json::json!({"c": "DE"})),
        loc_extra(3, serde_json::json!({"c": "FR"})),
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let groups = partition(&view, "c", &KeySpec::Value, None);
    assert_eq!(groups.len(), 2);
    assert!(groups.iter().all(|g| g.bin.is_none()));
    assert_eq!(
        groups.iter().find(|g| g.key == "FR").unwrap().ids,
        vec![1, 3]
    );
}

#[test]
fn partition_date_tz_local_matches_js_golden() {
    // 2019-12-31T20:00:00Z is 2020-01-01 05:00 in Tokyo (UTC+9, no DST) — same vectors as
    // the JS fieldOps tzLocal test.
    let ts = Utc
        .with_ymd_and_hms(2019, 12, 31, 20, 0, 0)
        .unwrap()
        .timestamp();
    let adds = vec![loc_extra(
        1,
        serde_json::json!({"t": ts, "timezone": "Asia/Tokyo"}),
    )];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let part = |p: DatePart| {
        partition(
            &view,
            "t",
            &KeySpec::DatePart {
                part: p,
                tz_local: true,
            },
            None,
        )[0]
        .key
        .clone()
    };
    assert_eq!(part(DatePart::Year), "2020");
    assert_eq!(part(DatePart::Day), "2020-01-01");
    assert_eq!(part(DatePart::HourOfDay), "05:00");
}

#[test]
fn partition_date_non_local_reads_utc() {
    // tz_local=false reads the UTC frame (not device-local).
    let ts = Utc
        .with_ymd_and_hms(2021, 3, 14, 9, 0, 0)
        .unwrap()
        .timestamp();
    let adds = vec![loc_extra(1, serde_json::json!({"t": ts}))];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let day = partition(
        &view,
        "t",
        &KeySpec::DatePart {
            part: DatePart::Day,
            tz_local: false,
        },
        None,
    );
    assert_eq!(day[0].key, "2021-03-14");
    let hour = partition(
        &view,
        "t",
        &KeySpec::DatePart {
            part: DatePart::HourOfDay,
            tz_local: false,
        },
        None,
    );
    assert_eq!(hour[0].key, "09:00");
}

#[test]
fn partition_month_field_year_and_month_of_year() {
    let adds = vec![
        loc_extra(1, serde_json::json!({"m": "2019-07"})),
        loc_extra(2, serde_json::json!({"m": "2019-07"})),
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let y = partition(
        &view,
        "m",
        &KeySpec::DatePart {
            part: DatePart::Year,
            tz_local: false,
        },
        None,
    );
    assert_eq!(y[0].key, "2019");
    assert_eq!(y[0].ids, vec![1, 2]);
    let mo = partition(
        &view,
        "m",
        &KeySpec::DatePart {
            part: DatePart::MonthOfYear,
            tz_local: false,
        },
        None,
    );
    assert_eq!(mo[0].key, "July");
}

#[test]
fn partition_respects_the_selector() {
    let adds = vec![
        loc_extra(1, serde_json::json!({"c": "FR"})),
        loc_extra(2, serde_json::json!({"c": "DE"})),
        loc_extra(3, serde_json::json!({"c": "FR"})),
    ];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let set = resolve(
        &view,
        &Selector::Locations {
            locations: vec![1, 2],
            name: None,
        },
    );
    let groups = partition(&view, "c", &KeySpec::Value, Some(&set));
    assert_eq!(groups.iter().find(|g| g.key == "FR").unwrap().ids, vec![1]);
    assert_eq!(groups.iter().find(|g| g.key == "DE").unwrap().ids, vec![2]);
}

#[test]
fn bound_label_matches_js_fmt() {
    assert_eq!(bound_label(0.0, 50.0), "0–50");
    assert_eq!(bound_label(42.567, 43.0), "42.57–43");
    assert_eq!(bound_label(-500.0, 0.0), "-500–0");
}

// -----------------------------------------------------------------------
// Property-based oracle tests for resolve / resolve / resolve_forest.
//
// The oracle is a naive HashSet-based evaluator over an explicit alive-id
// snapshot (id -> effective tags), built to mirror LocView's overlay rules:
// dead batch rows are excluded, a patch's tags win over the batch row's, and
// adds carry their own tags untouched. Composite semantics are copied
// verbatim from resolve: Intersection([]) = empty (not universe), Union
// = fold with |, Invert uses only its FIRST child (extra children ignored
// for the set, only for resolve_forest's per-node counts).
// -----------------------------------------------------------------------

use proptest::prelude::*;

#[derive(Clone, Debug)]
enum OracleProps {
    Tag(u32),
    Manual(Vec<u32>),
    Intersection(Vec<OracleProps>),
    Union(Vec<OracleProps>),
    Invert(Vec<OracleProps>),
}

fn oracle_resolve(alive: &[(u32, Vec<u32>)], selector: &OracleProps) -> HashSet<u32> {
    match selector {
        OracleProps::Tag(t) => alive
            .iter()
            .filter(|(_, tags)| tags.contains(t))
            .map(|(id, _)| *id)
            .collect(),
        OracleProps::Manual(ids) => {
            let want: HashSet<u32> = ids.iter().copied().collect();
            alive
                .iter()
                .filter(|(id, _)| want.contains(id))
                .map(|(id, _)| *id)
                .collect()
        }
        OracleProps::Intersection(children) => {
            if children.is_empty() {
                return HashSet::new();
            }
            let mut acc = oracle_resolve(alive, &children[0]);
            for c in &children[1..] {
                let next = oracle_resolve(alive, c);
                acc = acc.intersection(&next).copied().collect();
            }
            acc
        }
        OracleProps::Union(children) => {
            let mut acc = HashSet::new();
            for c in children {
                acc.extend(oracle_resolve(alive, c));
            }
            acc
        }
        OracleProps::Invert(children) => {
            let universe: HashSet<u32> = alive.iter().map(|(id, _)| *id).collect();
            match children.first() {
                Some(first) => universe
                    .difference(&oracle_resolve(alive, first))
                    .copied()
                    .collect(),
                None => universe,
            }
        }
    }
}

fn to_selection(o: &OracleProps, counter: &mut u32) -> Selection {
    *counter += 1;
    let key = format!("k{counter}");
    let selector = match o {
        OracleProps::Tag(t) => Selector::Tag { tag_id: *t },
        OracleProps::Manual(ids) => Selector::Manual {
            locations: ids.clone(),
        },
        OracleProps::Intersection(cs) => Selector::Intersection {
            selections: cs.iter().map(|c| to_selection(c, counter)).collect(),
        },
        OracleProps::Union(cs) => Selector::Union {
            selections: cs.iter().map(|c| to_selection(c, counter)).collect(),
        },
        OracleProps::Invert(cs) => Selector::Invert {
            selections: cs.iter().map(|c| to_selection(c, counter)).collect(),
        },
    };
    Selection {
        key,
        color: [0, 0, 0],
        selector,
    }
}

fn tags_from_mask(mask: u8) -> Vec<u32> {
    (0..6u32)
        .filter(|b| mask & (1 << b) != 0)
        .map(|b| b + 1)
        .collect()
}

fn masks_strategy(max: usize) -> impl Strategy<Value = Vec<u8>> {
    prop::collection::vec(0u8..64, 1..=max)
}

// (tag mask, role, patch tag mask). role 0 = plain base row, 1 = dead base row,
// 2 = patched base row (patch_mask replaces mask's tags), 3 = overlay add.
fn entries_strategy(max: usize) -> impl Strategy<Value = Vec<(u8, u8, u8)>> {
    prop::collection::vec((0u8..64, 0u8..4, 0u8..64), 1..=max)
}

fn oracle_tree_strategy() -> impl Strategy<Value = OracleProps> {
    let leaf = prop_oneof![
        (1u32..=6).prop_map(OracleProps::Tag),
        prop::collection::vec(1u32..=60, 0..5).prop_map(OracleProps::Manual),
    ];
    leaf.prop_recursive(3, 12, 3, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..3).prop_map(OracleProps::Intersection),
            prop::collection::vec(inner.clone(), 0..3).prop_map(OracleProps::Union),
            prop::collection::vec(inner, 0..2).prop_map(OracleProps::Invert),
        ]
    })
}

// All ids as overlay adds, no dead/patches.
fn build_adds_view(masks: &[u8]) -> (Vec<Location>, Vec<(u32, Vec<u32>)>) {
    let mut adds = Vec::new();
    let mut alive = Vec::new();
    for (i, &m) in masks.iter().enumerate() {
        let id = (i + 1) as u32;
        let tags = tags_from_mask(m);
        let mut l = loc(id, 0.0, 0.0);
        l.tags = tags.clone();
        adds.push(l);
        alive.push((id, tags));
    }
    (adds, alive)
}

// Mixed batch + overlay: dead/patched rows only take effect for ids that live in
// the Arrow batch (LocView only consults dead/patches while scanning batch rows),
// so roles 0/1/2 go into the batch and role 3 goes straight into adds.
#[allow(clippy::type_complexity)]
fn build_overlay_view(
    entries: &[(u8, u8, u8)],
) -> (
    RecordBatch,
    HashSet<u32>,
    HashMap<u32, Location>,
    Vec<Location>,
    Vec<(u32, Vec<u32>)>,
) {
    let mut base_locs = Vec::new();
    let mut dead = HashSet::new();
    let mut patches = HashMap::new();
    let mut adds = Vec::new();
    let mut alive = Vec::new();
    for (i, &(mask, role, patch_mask)) in entries.iter().enumerate() {
        let id = (i + 1) as u32;
        let tags = tags_from_mask(mask);
        match role {
            0 => {
                let mut l = loc(id, 0.0, 0.0);
                l.tags = tags.clone();
                base_locs.push(l);
                alive.push((id, tags));
            }
            1 => {
                let mut l = loc(id, 0.0, 0.0);
                l.tags = tags;
                base_locs.push(l);
                dead.insert(id);
            }
            2 => {
                let mut l = loc(id, 0.0, 0.0);
                l.tags = tags;
                base_locs.push(l);
                let patch_tags = tags_from_mask(patch_mask);
                let mut p = loc(id, 0.0, 0.0);
                p.tags = patch_tags.clone();
                patches.insert(id, p);
                alive.push((id, patch_tags));
            }
            _ => {
                let mut l = loc(id, 0.0, 0.0);
                l.tags = tags.clone();
                adds.push(l);
                alive.push((id, tags));
            }
        }
    }
    let batch = locations_to_batch(&base_locs);
    (batch, dead, patches, adds, alive)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn resolve_matches_oracle_adds_only(masks in masks_strategy(60), tree in oracle_tree_strategy()) {
        let (adds, alive) = build_adds_view(&masks);
        let fx = Fx::adds(adds);
        let view = fx.view();
        let selector = to_selection(&tree, &mut 0).selector;
        let got: HashSet<u32> = resolve(&view, &selector).into_iter().collect();
        let want = oracle_resolve(&alive, &tree);
        prop_assert_eq!(got, want);
    }

    #[test]
    fn resolve_matches_oracle_with_overlay(entries in entries_strategy(60), tree in oracle_tree_strategy()) {
        let (batch, dead, patches, adds, alive) = build_overlay_view(&entries);
        let fx = Fx { batch: Some(batch), dead, patches, adds };
        let view = fx.view();
        let selector = to_selection(&tree, &mut 0).selector;
        let got: HashSet<u32> = resolve(&view, &selector).into_iter().collect();
        let want = oracle_resolve(&alive, &tree);
        prop_assert_eq!(got, want);
    }

    #[test]
    fn resolve_output_is_sorted_and_dedup(masks in masks_strategy(60), tree in oracle_tree_strategy()) {
        let (adds, _alive) = build_adds_view(&masks);
        let fx = Fx::adds(adds);
        let view = fx.view();
        let selector = to_selection(&tree, &mut 0).selector;
        let ids = ids_of(&view, &selector);
        for w in ids.windows(2) {
            prop_assert!(w[0] < w[1]);
        }
    }

    #[test]
    fn resolve_forest_agrees_with_resolve_set(
        masks in masks_strategy(60),
        trees in prop::collection::vec(oracle_tree_strategy(), 1..=4),
    ) {
        let (adds, _alive) = build_adds_view(&masks);
        let fx = Fx::adds(adds);
        let view = fx.view();
        let mut counter = 0u32;
        let sels: Vec<Selection> = trees.iter().map(|t| to_selection(t, &mut counter)).collect();
        let (sets, _counts) = resolve_forest(&view, &sels);
        prop_assert_eq!(sets.len(), sels.len());
        for (i, sel) in sels.iter().enumerate() {
            prop_assert_eq!(&sets[i], &resolve(&view, &sel.selector));
        }
    }

    // Invert = universe - ids_of(first child), and a leaf/composite's own set is
    // always a subset of the alive universe, so double-inverting is the identity.
    #[test]
    fn invert_is_involutive_on_alive_set(masks in masks_strategy(60), tree in oracle_tree_strategy()) {
        let (adds, _alive) = build_adds_view(&masks);
        let fx = Fx::adds(adds);
        let view = fx.view();
        let inner = to_selection(&tree, &mut 0);
        let x_set = resolve(&view, &inner.selector);
        let double_invert = Selector::Invert {
            selections: vec![Selection {
                key: "outer".into(),
                color: [0, 0, 0],
                selector: Selector::Invert {
                    selections: vec![inner],
                },
            }],
        };
        let got = resolve(&view, &double_invert);
        prop_assert_eq!(got, x_set);
    }
}

// -----------------------------------------------------------------------
// Composite edge pins: empty selections vecs. resolve explicitly checks
// `is_empty()` before indexing, so none of these panic -- pinning the chosen
// (non-obvious) semantics rather than reproducing a crash.
// -----------------------------------------------------------------------

#[test]
fn intersection_of_empty_selections_is_empty_not_universe() {
    let adds = vec![loc(1, 0.0, 0.0), loc(2, 0.0, 0.0)];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(&view, &Selector::Intersection { selections: vec![] });
    assert!(
        ids.is_empty(),
        "empty Intersection is vacuously empty, not the universe: {ids:?}"
    );
}

#[test]
fn union_of_empty_selections_is_empty() {
    let adds = vec![loc(1, 0.0, 0.0), loc(2, 0.0, 0.0)];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(&view, &Selector::Union { selections: vec![] });
    assert!(ids.is_empty());
}

#[test]
fn invert_of_empty_selections_is_the_alive_universe() {
    let adds = vec![loc(1, 0.0, 0.0), loc(2, 0.0, 0.0), loc(3, 0.0, 0.0)];
    let fx = Fx::adds(adds);
    let view = fx.view();
    let ids = ids_of(&view, &Selector::Invert { selections: vec![] });
    assert_eq!(ids, vec![1, 2, 3]);
}

// -----------------------------------------------------------------------
// Query projections: one traversal, several accumulators
// -----------------------------------------------------------------------

#[test]
fn ids_within_applies_the_overlay_and_the_set() {
    let base = vec![loc(1, 1.0, 1.0), loc(2, 2.0, 2.0), loc(3, 3.0, 3.0)];
    let fx = Fx::base(&base)
        .with_adds(vec![loc(4, 4.0, 4.0)])
        .with_dead([2]);

    assert_eq!(ids_within(&fx.view(), None), vec![1, 3, 4]);

    let set: RoaringBitmap = [2u32, 3, 4].into_iter().collect();
    // 2 is dead, so the set cannot resurrect it.
    assert_eq!(ids_within(&fx.view(), Some(&set)), vec![3, 4]);
}

#[test]
fn sample_draws_n_distinct_ids_and_clamps_to_the_pool() {
    let pool: Vec<u32> = (1..=100).collect();

    let drawn = sample(pool.clone(), 5);
    assert_eq!(drawn.len(), 5);
    let unique: HashSet<u32> = drawn.iter().copied().collect();
    assert_eq!(unique.len(), 5, "sample returned duplicates");
    assert!(drawn.iter().all(|id| pool.contains(id)));

    assert_eq!(sample(pool.clone(), 1000).len(), pool.len());
    assert!(sample(pool, 0).is_empty());
    assert!(sample(Vec::new(), 5).is_empty());
}

#[test]
fn sample_reaches_every_member_of_the_pool() {
    // Uniformity isn't asserted, but a draw that can't reach an element is a bug.
    let mut seen = HashSet::new();
    for _ in 0..200 {
        seen.extend(sample(vec![1, 2, 3, 4], 1));
    }
    assert_eq!(seen.len(), 4);
}

#[test]
fn distinct_values_sorts_stringifies_scalars_and_skips_the_rest() {
    let locs = vec![
        loc_extra(1, serde_json::json!({"t":"UTC"})),
        loc_extra(2, serde_json::json!({"t":"Asia/Tokyo"})),
        loc_extra(3, serde_json::json!({"t":"UTC"})),
        loc_extra(4, serde_json::json!({"t":2})),
        loc_extra(5, serde_json::json!({"t":true})),
        loc_extra(6, serde_json::json!({"t":null})),
        loc_extra(7, serde_json::json!({"t":{"a":1}})),
        loc_extra(8, serde_json::json!({"t":[3]})),
        loc_extra(9, serde_json::json!({"t":""})),
        loc_extra(10, serde_json::json!({"other":1})),
    ];
    let fx = Fx::base(&locs);
    assert_eq!(
        distinct_values(&fx.view(), "t", None),
        vec!["2", "Asia/Tokyo", "UTC", "true"]
    );
}

#[test]
fn distinct_values_honours_the_set() {
    let locs = vec![
        loc_extra(1, serde_json::json!({"t":"a"})),
        loc_extra(2, serde_json::json!({"t":"b"})),
    ];
    let fx = Fx::base(&locs);
    let set: RoaringBitmap = [1u32].into_iter().collect();
    assert_eq!(distinct_values(&fx.view(), "t", Some(&set)), vec!["a"]);
}

#[test]
fn count_by_matches_the_group_sizes_partition_reports() {
    let locs = vec![
        loc_extra(1, serde_json::json!({"c":"US"})),
        loc_extra(2, serde_json::json!({"c":"US"})),
        loc_extra(3, serde_json::json!({"c":"FR"})),
        loc_extra(4, serde_json::json!({"other":1})),
    ];
    let fx = Fx::base(&locs);
    let view = fx.view();

    let mut counts = count_by(&view, "c", &KeySpec::Value, None);
    counts.sort();
    assert_eq!(
        counts,
        vec![("FR".to_string(), 1u32), ("US".to_string(), 2)]
    );

    let mut sizes: Vec<(String, u32)> = partition(&view, "c", &KeySpec::Value, None)
        .into_iter()
        .map(|g| (g.key, g.ids.len() as u32))
        .collect();
    sizes.sort();
    assert_eq!(counts, sizes);
}

#[test]
fn extra_key_coverage_counts_rows_per_key_across_the_overlay() {
    let base = vec![
        loc_extra(1, serde_json::json!({"a":1,"b":2})),
        loc_extra(2, serde_json::json!({"a":1})),
        loc_extra(3, serde_json::json!({"b":2})),
    ];
    let fx = Fx::base(&base)
        .with_adds(vec![loc_extra(
            4,
            serde_json::json!({"a":9,"c":{"nested":1}}),
        )])
        .with_dead([3]);

    assert_eq!(
        extra_key_coverage(&fx.view(), None),
        vec![
            ("a".to_string(), 3u32),
            ("b".to_string(), 1),
            ("c".to_string(), 1)
        ]
    );
}

#[test]
fn every_projection_id_is_value_or_a_date_part_wire_name() {
    for p in PROJECTIONS {
        if p.id == "value" {
            continue;
        }
        let parsed: Result<DatePart, _> = serde_json::from_str(&format!("\"{}\"", p.id));
        assert!(parsed.is_ok(), "projection id {} is not a DatePart", p.id);
        assert!(p.needs_tz, "date projection {} reads a clock", p.id);
    }
    assert_eq!(PROJECTIONS.iter().filter(|p| p.id == "value").count(), 1);
}

#[test]
fn columns_within_projects_one_value_per_row_per_field() {
    let mut tagged = loc_extra(2, serde_json::json!({"a":"x"}));
    tagged.tags = vec![7, 9];
    tagged.heading = 45.0;
    let base = vec![loc_extra(1, serde_json::json!({"a":1,"b":2})), tagged];
    let fx = Fx::base(&base).with_adds(vec![loc_extra(3, serde_json::json!({"b":3}))]);
    let fields: Vec<String> = ["a", "b", "heading", "tags", "nope"]
        .iter()
        .map(ToString::to_string)
        .collect();
    let cols = columns_within(&fx.view(), None, &fields);
    assert_eq!(
        cols[0],
        vec![
            serde_json::json!(1),
            serde_json::json!("x"),
            serde_json::Value::Null
        ]
    );
    assert_eq!(
        cols[1],
        vec![
            serde_json::json!(2),
            serde_json::Value::Null,
            serde_json::json!(3)
        ]
    );
    assert_eq!(
        cols[2],
        vec![
            serde_json::json!(0.0),
            serde_json::json!(45.0),
            serde_json::json!(0.0)
        ]
    );
    assert_eq!(
        cols[3],
        vec![
            serde_json::json!([]),
            serde_json::json!([7, 9]),
            serde_json::json!([])
        ]
    );
    assert_eq!(cols[4], vec![serde_json::Value::Null; 3]);

    let set: RoaringBitmap = [2u32].into_iter().collect();
    let cols = columns_within(&fx.view(), Some(&set), &fields[..1]);
    assert_eq!(cols[0], vec![serde_json::json!("x")]);
}

#[test]
fn extra_key_coverage_decodes_escaped_base_row_keys() {
    // Blobs baked before key canonicalization can still carry `café` on disk; coverage
    // must report the decoded spelling, matching overlay rows and the field-def registry.
    let mut l = loc(1, 0.0, 0.0);
    l.extra = RawExtra::from_string_uncanonicalized("{\"caf\\u00e9\":1}");
    let fx = Fx::base(&[l]);
    assert_eq!(
        extra_key_coverage(&fx.view(), None),
        vec![("café".to_string(), 1u32)]
    );
}

#[test]
fn extra_key_coverage_does_not_descend_into_nested_objects() {
    let locs = vec![loc_extra(1, serde_json::json!({"outer":{"inner":1}}))];
    let fx = Fx::base(&locs);
    assert_eq!(
        extra_key_coverage(&fx.view(), None),
        vec![("outer".to_string(), 1u32)]
    );
}

fn pinned(id: u32, pano: Option<&str>, flag: bool) -> Location {
    Location {
        pano_id: pano.map(Into::into),
        flags: if flag {
            LocationFlags::LOAD_AS_PANO_ID
        } else {
            LocationFlags::empty()
        },
        ..loc(id, 0.0, 0.0)
    }
}

fn leaf(key: &str, selector: Selector) -> Selection {
    Selection {
        key: key.into(),
        color: [0, 0, 0],
        selector,
    }
}

/// Base rows exercise the Arrow pano_id column; the add exercises the overlay row.
fn pano_fx() -> Fx {
    Fx::base(&[
        pinned(1, Some("a"), true),
        pinned(2, Some("b"), false),
        pinned(3, None, true),
        pinned(4, Some("d"), true),
    ])
    .with_adds(vec![pinned(5, Some("e"), true)])
    .with_dead([4])
}

#[test]
fn count_is_the_selected_size() {
    let fx = pano_fx();
    let view = fx.view();

    assert_eq!(count_within(&view, None), 4);

    // A named id list is raw: the dead id must not be counted.
    let set: RoaringBitmap = [2u32, 3, 4].into_iter().collect();
    assert_eq!(count_within(&view, Some(&set)), 2);
}

/// `panoId` is a builtin field: the generic Filter predicate reaches the Arrow column
/// and the overlay row, so no bespoke selection variant is needed.
fn pano_filter(op: FilterOp) -> Selector {
    Selector::Filter {
        field: "panoId".into(),
        op,
        value: serde_json::Value::Null,
        value2: None,
        tz_local: false,
    }
}

/// Count through a selector: the shape the bulk modal builds.
fn count_selector(view: &LocView, selector: Selector) -> u32 {
    count_within(view, narrow(view, &selector).as_ref())
}

/// Resolved ids as a vec, for order-and-content assertions.
fn ids_of(view: &LocView, selector: &Selector) -> Vec<u32> {
    resolve(view, selector).into_iter().collect()
}

fn intersect(selector: Vec<Selector>) -> Selector {
    Selector::Intersection {
        selections: selector
            .into_iter()
            .enumerate()
            .map(|(i, p)| leaf(&format!("c{i}"), p))
            .collect(),
    }
}

#[test]
fn pano_id_filter_counts_base_and_overlay_rows_and_skips_dead_ones() {
    let fx = pano_fx();
    let view = fx.view();
    let _none = RoaringBitmap::new();

    assert_eq!(count_selector(&view, pano_filter(FilterOp::Has)), 3);
    assert_eq!(count_selector(&view, pano_filter(FilterOp::Nothas)), 1);

    // Narrowed by ids, the way a bulk operation does it.
    let ids = Selector::Locations {
        locations: vec![2, 3],
        name: None,
    };
    let narrow = |op| intersect(vec![ids.clone(), pano_filter(op)]);
    assert_eq!(count_selector(&view, narrow(FilterOp::Has)), 1);
    assert_eq!(count_selector(&view, narrow(FilterOp::Nothas)), 1);
}

#[test]
fn pano_id_filter_intersected_with_pano_ids_is_the_pinned_count() {
    let fx = pano_fx();
    let view = fx.view();
    let _none = RoaringBitmap::new();
    let pinned = intersect(vec![pano_filter(FilterOp::Has), Selector::PanoIds]);

    // 1 and 5 carry a pano ID and the flag; 3 has the flag but no pano ID.
    assert_eq!(count_selector(&view, pinned.clone()), 2);

    let narrowed = intersect(vec![
        Selector::Locations {
            locations: vec![2, 3],
            name: None,
        },
        pinned,
    ]);
    assert_eq!(count_selector(&view, narrowed), 0);
}

#[test]
fn pano_id_resolves_from_both_row_variants_and_is_none_when_absent() {
    let fx = pano_fx();
    let view = fx.view();

    let base = |i| {
        RowRef {
            inner: RowInner::Base(&view, i),
        }
        .resolve_field("panoId")
    };
    assert_eq!(base(0), Some(serde_json::json!("a")));
    assert_eq!(base(2), None);

    let add = RowRef {
        inner: RowInner::Loc(&fx.adds[0]),
    };
    assert_eq!(add.resolve_field("panoId"), Some(serde_json::json!("e")));

    let bare = pinned(9, None, false);
    let bare_row = RowRef {
        inner: RowInner::Loc(&bare),
    };
    assert_eq!(bare_row.resolve_field("panoId"), None);
}

#[test]
fn narrow_resolves_to_the_id_set_it_names() {
    let locs = vec![loc(1, 0.0, 0.0), loc(2, 1.0, 1.0), loc(7, 2.0, 2.0)];
    let fx = Fx::base(&locs);
    let view = fx.view();

    // Everything is the whole map: no narrowing set at all.
    assert!(narrow(&view, &Selector::Everything).is_none());
    // A named id list answers as itself, without resolving.
    assert_eq!(
        narrow(
            &view,
            &Selector::Locations {
                locations: vec![1, 2],
                name: None,
            }
        )
        .unwrap(),
        [1u32, 2].into_iter().collect::<RoaringBitmap>()
    );
    // Any other selector resolves like the selection it is.
    assert_eq!(
        narrow(
            &view,
            &Selector::Manual {
                locations: vec![1, 7]
            }
        )
        .unwrap(),
        [1u32, 7].into_iter().collect::<RoaringBitmap>()
    );
}

#[test]
fn every_projection_honours_a_named_id_list() {
    let locs = vec![
        loc_extra(1, serde_json::json!({"c":"US"})),
        loc_extra(2, serde_json::json!({"c":"FR"})),
        loc_extra(3, serde_json::json!({"c":"FR"})),
    ];
    let fx = Fx::base(&locs);
    let view = fx.view();
    let resolved = narrow(
        &view,
        &Selector::Locations {
            locations: vec![2, 3],
            name: None,
        },
    );
    let set = resolved.as_ref();

    assert_eq!(ids_within(&view, set), vec![2, 3]);
    assert_eq!(distinct_values(&view, "c", set), vec!["FR"]);
    assert_eq!(
        count_by(&view, "c", &KeySpec::Value, set),
        vec![("FR".to_string(), 2u32)]
    );
    assert_eq!(
        extra_key_coverage(&view, set),
        vec![("c".to_string(), 2u32)]
    );
}

#[test]
fn has_pano_id_matches_a_pinned_row_in_base_and_overlay() {
    let mut pinned = loc(1, 0.0, 0.0);
    pinned.pano_id = Some("abcdefghijklmnopqrstuv".into());
    let bare = loc(2, 0.0, 0.0);
    let filter = Selector::Filter {
        field: "panoId".into(),
        op: FilterOp::Has,
        value: serde_json::Value::Null,
        value2: None,
        tz_local: false,
    };
    let base = Fx::base(&[pinned.clone(), bare.clone()]);
    assert_eq!(ids_of(&base.view(), &filter), vec![1]);
    let adds = Fx::adds(vec![pinned.clone(), bare.clone()]);
    assert_eq!(ids_of(&adds.view(), &filter), vec![1]);
    // Pinned after a commit: the base row is bare, the pano lives in a patch.
    let patched = Fx::base(&[bare.clone(), loc(1, 0.0, 0.0)]).with_patch(1, pinned);
    assert_eq!(ids_of(&patched.view(), &filter), vec![1]);
}
