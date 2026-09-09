//! Spherical geometry shared across the workspace: one authority for
//! meters<->degrees conversion, wrap-aware distances, the "which grid cells cover
//! a radius around a point" computation, and ray-casting point-in-polygon with
//! antimeridian handling. Consumed by the app's grids (`DupGrid`, `SpatialIndex`),
//! polygon selections, borders, and vali-generate's region filters, so latitude
//! scaling and antimeridian handling cannot drift between consumers.

use std::f64::consts::PI;
use std::ops::RangeInclusive;

mod grid;
mod polygon;
pub use grid::SpatialIndex;
pub use polygon::*;

pub const EARTH_R_M: f64 = 6_371_000.0;

/// Meters per degree of latitude (and of longitude at the equator). Derived from
/// `EARTH_R_M` so broad-phase spans and the distance functions below agree exactly.
pub const M_PER_DEG: f64 = EARTH_R_M * PI / 180.0;

/// Longitude difference normalized to [-180, 180].
#[inline]
pub fn wrap_dlng(dlng: f64) -> f64 {
    (dlng + 180.0).rem_euclid(360.0) - 180.0
}

/// Great-circle distance in metres using the haversine formula. Assumes spherical Earth (R = 6371 km).
pub fn haversine_m(lat1: f64, lng1: f64, lat2: f64, lng2: f64) -> f64 {
    let dlat = (lat2 - lat1).to_radians();
    let dlng = (lng2 - lng1).to_radians();
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (dlng / 2.0).sin().powi(2);
    2.0 * EARTH_R_M * a.sqrt().asin()
}

/// Squared equirectangular distance in metres², for cheap threshold tests at small
/// separations (no trig beyond the wrap, no sqrt). `cos_lat` is `cos(reference
/// latitude)`, precomputed once per query point. Error vs haversine is sub-mm under
/// ~1km — negligible for the meter-scale radii dedup/find-nearby use. Compare
/// against `threshold * threshold`.
#[inline]
pub fn equirect_m2(lat1: f64, lng1: f64, lat2: f64, lng2: f64, cos_lat: f64) -> f64 {
    let x = wrap_dlng(lng2 - lng1).to_radians() * cos_lat;
    let y = (lat2 - lat1).to_radians();
    (x * x + y * y) * EARTH_R_M * EARTH_R_M
}

/// Are the two points within `threshold_m2` (metres², i.e. `radius * radius`) of each
/// other? `equirect_m2` about the mean latitude, with a latitude-only early-out that
/// rejects most pairs before the wrap and the cosine.
#[inline]
pub fn within_m2(lat1: f64, lng1: f64, lat2: f64, lng2: f64, threshold_m2: f64) -> bool {
    let dlat = lat2 - lat1;
    if dlat * dlat * M_PER_DEG * M_PER_DEG > threshold_m2 {
        return false;
    }
    let cos_lat = ((lat1 + lat2) * 0.5).to_radians().cos();
    equirect_m2(lat1, lng1, lat2, lng2, cos_lat) < threshold_m2
}

/// Grid cells covering the `radius_m` disc around a point, for a grid keyed by
/// `(floor(lng/cell_deg), floor(lat/cell_deg))`. Row range plus up to two column
/// ranges: the longitude span widens by 1/cos(lat) and splits in two when it
/// crosses the antimeridian.
pub struct CellCover {
    pub cy: RangeInclusive<i32>,
    pub cx: [Option<RangeInclusive<i32>>; 2],
}

impl CellCover {
    pub fn cells(&self) -> impl Iterator<Item = (i32, i32)> + '_ {
        self.cy.clone().flat_map(move |cy| {
            self.cx
                .iter()
                .flatten()
                .flat_map(move |r| r.clone().map(move |cx| (cx, cy)))
        })
    }

    pub fn contains(&self, cx: i32, cy: i32) -> bool {
        self.cy.contains(&cy) && self.cx.iter().flatten().any(|r| r.contains(&cx))
    }

    /// Number of cells `cells()` would yield. Saturating; never overflows.
    pub fn len(&self) -> u64 {
        let rows = (*self.cy.end() as i64 - *self.cy.start() as i64 + 1).max(0) as u64;
        let cols: u64 = self
            .cx
            .iter()
            .flatten()
            .map(|r| (*r.end() as i64 - *r.start() as i64 + 1).max(0) as u64)
            .sum();
        rows.saturating_mul(cols)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// At extreme latitudes the span degrades to the full circle of columns — correct
/// but wide; callers with bounded budgets cap the returned ranges themselves.
/// Non-finite coordinates yield an empty cover.
pub fn covering_cells(lat: f64, lng: f64, radius_m: f64, cell_deg: f64) -> CellCover {
    if !lat.is_finite() || !lng.is_finite() {
        #[allow(clippy::reversed_empty_ranges)]
        return CellCover {
            cy: 0..=-1,
            cx: [None, None],
        };
    }
    let to_range =
        |lo: f64, hi: f64| ((lo / cell_deg).floor() as i32)..=((hi / cell_deg).floor() as i32);
    let d_lat = radius_m / M_PER_DEG;
    let cy = to_range(lat - d_lat, lat + d_lat);
    // Longitude extent of the spherical cap: asin(sin(r/R)/cos(lat)). The cap's extreme
    // longitudes sit poleward of `lat`, so the linear r/(R*cos(lat)) underestimates at
    // large radii. Cap touching a pole -> full circle.
    let sin_r = (radius_m / EARTH_R_M).sin();
    let cos_lat = lat.to_radians().cos();
    let full_circle = lat.abs() + d_lat >= 90.0
        || radius_m >= EARTH_R_M * std::f64::consts::FRAC_PI_2
        || sin_r >= cos_lat;
    let cx = if full_circle {
        [Some(to_range(-180.0, 180.0)), None]
    } else {
        let d_lng = (sin_r / cos_lat).asin().to_degrees();
        let (lo, hi) = (lng - d_lng, lng + d_lng);
        if lo < -180.0 {
            [Some(to_range(-180.0, hi)), Some(to_range(lo + 360.0, 180.0))]
        } else if hi > 180.0 {
            [Some(to_range(lo, 180.0)), Some(to_range(-180.0, hi - 360.0))]
        } else {
            [Some(to_range(lo, hi)), None]
        }
    };
    CellCover { cy, cx }
}

#[cfg(test)]
#[path = "lib.test.rs"]
mod tests;
