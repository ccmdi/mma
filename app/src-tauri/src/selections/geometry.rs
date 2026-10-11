//! Polygon containment and bounding boxes for polygon selections.

use super::*;

impl PolygonGeometry {
    /// Every polygon of the geometry (the primary one, then the extras), each an outer
    /// ring followed by its holes.
    pub(crate) fn parts(&self) -> impl Iterator<Item = &[Vec<[f64; 2]>]> {
        std::iter::once(self.coordinates.as_slice())
            .chain(self.extra_polygons.iter().flatten().map(Vec::as_slice))
    }

    /// The geometry preprocessed for repeated point tests. Build once per resolve.
    pub(crate) fn prepared(&self) -> mma_geo::PreparedPolygons<'_> {
        mma_geo::PreparedPolygons::new(self.parts())
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

pub(crate) struct DistanceTo {
    pub lat: f64,
    pub lng: f64,
}

impl DistanceTo {
    pub(crate) fn score(&self, row: &RowRef) -> f64 {
        haversine_m(self.lat, self.lng, row.lat(), row.lng())
    }

    pub(crate) fn within(&self, scope: &Scope, radius: f64) -> IdSet<Location> {
        let keep = |row: &RowRef| self.score(row) <= radius;
        match scope.view.spatial {
            Some(index) => {
                let mut candidates = Vec::new();
                index.candidates(self.lat, self.lng, radius, &mut candidates);
                let candidates = candidates.into_iter().map(Id::new).collect();
                scope.within(&candidates).keep(keep)
            }
            None => scope.keep(keep),
        }
    }

    pub(crate) fn minimum(&self, scope: &Scope) -> Option<Id<Location>> {
        let mut radius = SPATIAL_CELL_M;
        while radius < 1e8 {
            let candidates = self.within(scope, radius);
            if let Some(id) = scope
                .within(&candidates)
                .rank_by(|row| Some(self.score(row)), Some(1), true)
                .first()
            {
                return Some(*id);
            }
            radius *= 8.0;
        }
        None
    }
}
