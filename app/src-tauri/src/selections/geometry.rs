//! Polygon containment and bounding boxes for polygon selections.

use super::*;

/// A whole geometry (primary polygon + extras) preprocessed with per-ring bboxes and
/// antimeridian flags. Build once per resolve; `contains` is then bbox-rejected per
/// polygon and per hole instead of paying the O(V) antimeridian pre-scan per point.
pub(crate) struct PreparedGeometry<'a> {
    /// Each entry is one polygon: outer ring first, then holes.
    polys: Vec<Vec<PreparedRing<'a>>>,
}

impl<'a> PreparedGeometry<'a> {
    pub(crate) fn new(geom: &'a PolygonGeometry) -> Self {
        let prep = |rings: &'a [Vec<[f64; 2]>]| -> Vec<PreparedRing<'a>> {
            rings.iter().map(|r| PreparedRing::new(r)).collect()
        };
        let mut polys = vec![prep(&geom.coordinates)];
        if let Some(extras) = &geom.extra_polygons {
            for p in extras {
                polys.push(prep(p));
            }
        }
        Self { polys }
    }

    /// Equivalent to `point_in_geometry`.
    #[inline]
    pub(crate) fn contains(&self, lng: f64, lat: f64) -> bool {
        self.polys.iter().any(|rings| match rings.split_first() {
            Some((outer, holes)) => {
                outer.contains(lng, lat) && !holes.iter().any(|h| h.contains(lng, lat))
            }
            None => false,
        })
    }
}

pub(super) fn point_in_polygon(lng: f64, lat: f64, coords: &[Vec<[f64; 2]>]) -> bool {
    polygon_contains(lng, lat, coords.iter().map(Vec::as_slice))
}

/// Test against the full geometry (primary polygon + extra_polygons). Any hit = true.
pub(crate) fn point_in_geometry(lng: f64, lat: f64, geom: &PolygonGeometry) -> bool {
    if point_in_polygon(lng, lat, &geom.coordinates) {
        return true;
    }
    if let Some(extras) = &geom.extra_polygons {
        for poly in extras {
            if point_in_polygon(lng, lat, poly) {
                return true;
            }
        }
    }
    false
}

/// Axis-aligned bounding box `[min_lng, min_lat, max_lng, max_lat]` over every ring of
/// a geometry (outer + holes + extra polygons). Used as a cheap broad-phase reject
/// before the full crossing-number test in polygon selections. `None` if no coords.
/// Longitudes are in the unwrapped frame of the first ring, so `min_lng` may sit below
/// -180 and `max_lng` above it - `in_bbox` handles this transparently.
pub(crate) fn geometry_bbox(geom: &PolygonGeometry) -> Option<[f64; 4]> {
    let mut bb = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    let mut any = false;
    for ring in &geom.coordinates {
        extend_bbox_with_ring(&mut bb, &mut any, ring);
    }
    if let Some(extras) = &geom.extra_polygons {
        for poly in extras {
            for ring in poly {
                extend_bbox_with_ring(&mut bb, &mut any, ring);
            }
        }
    }
    if any {
        anchor_bbox(&mut bb);
        Some(bb)
    } else {
        None
    }
}
