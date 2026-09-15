//! A honeycomb of points: rows along parallels `spacing * sqrt(3) / 2` apart, points along
//! each row `spacing` apart in true metres, every other row shifted half a step. Each row
//! keeps its own longitude step, so far from the anchor meridian the rows slide against
//! each other instead of stretching.

use crate::{fold_lng, PreparedRing, M_PER_DEG};

/// Grid points along one row: `count` points from `lng` eastward, `lng_step` degrees apart,
/// all within [-180, 180).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GridRun {
    pub lat: f64,
    pub lng: f64,
    pub lng_step: f64,
    pub count: u32,
}

pub struct HexGrid {
    lat: f64,
    lng: f64,
    spacing_m: f64,
    row_deg: f64,
}

struct Row {
    lat: f64,
    lng_step: f64,
    phase: f64,
}

impl HexGrid {
    /// A honeycomb with a point at (`lat`, `lng`) and neighbors `spacing_m` metres apart.
    pub fn new(lat: f64, lng: f64, spacing_m: f64) -> Self {
        HexGrid {
            lat,
            lng,
            spacing_m,
            row_deg: spacing_m * 3f64.sqrt() / 2.0 / M_PER_DEG,
        }
    }

    fn row(&self, index: i64) -> Row {
        let lat = (self.lat + index as f64 * self.row_deg).clamp(-90.0, 90.0);
        Row {
            lat,
            lng_step: (self.spacing_m / (M_PER_DEG * lat.to_radians().cos())).min(360.0),
            phase: index.rem_euclid(2) as f64 * 0.5,
        }
    }

    /// The grid points inside the polygons (each an outer ring then its holes, `[lng, lat]`
    /// vertices), as runs along each row.
    pub fn runs(&self, polygons: &[Vec<Vec<[f64; 2]>>]) -> Vec<GridRun> {
        let mut runs = Vec::new();
        let mut crossings = Vec::new();
        for polygon in polygons {
            let rings: Vec<(PreparedRing, f64)> = polygon
                .iter()
                .map(|ring| {
                    let prepared = PreparedRing::new(ring);
                    let [west, _, east, _] = prepared.bbox();
                    let turn = ((self.lng - (west + east) / 2.0) / 360.0).round() * 360.0;
                    (prepared, turn)
                })
                .collect();
            let Some((outer, _)) = rings.first() else {
                continue;
            };
            let [_, south, _, north] = outer.bbox();
            if south > north {
                continue;
            }
            let first = ((south - self.lat) / self.row_deg).ceil() as i64;
            let last = ((north - self.lat) / self.row_deg).floor() as i64;
            for index in first..=last {
                let row = self.row(index);
                crossings.clear();
                for (ring, turn) in &rings {
                    crossings.extend(ring.crossings(row.lat).map(|x| x + turn));
                }
                crossings.sort_by(f64::total_cmp);
                let col = |lng: f64| (lng - self.lng) / row.lng_step - row.phase;
                for span in crossings.chunks_exact(2) {
                    let (from, to) = (col(span[0]).ceil(), col(span[1]).floor());
                    if to >= from {
                        push_run(
                            &mut runs,
                            row.lat,
                            self.lng + (from + row.phase) * row.lng_step,
                            row.lng_step,
                            (to - from) as u64 + 1,
                        );
                    }
                }
            }
        }
        runs
    }
}

/// Splits a run at the antimeridian, so every run starts and stays within [-180, 180).
fn push_run(runs: &mut Vec<GridRun>, lat: f64, lng: f64, lng_step: f64, count: u64) {
    let count = count.min((360.0 / lng_step) as u64);
    let lng = fold_lng(lng, -180.0);
    let past_antimeridian = |m: u64| lng + m as f64 * lng_step >= 180.0;
    let mut west_of_antimeridian = (((180.0 - lng) / lng_step).ceil() as u64).min(count);
    while west_of_antimeridian > 0 && past_antimeridian(west_of_antimeridian - 1) {
        west_of_antimeridian -= 1;
    }
    while west_of_antimeridian < count && !past_antimeridian(west_of_antimeridian) {
        west_of_antimeridian += 1;
    }
    if west_of_antimeridian > 0 {
        runs.push(GridRun {
            lat,
            lng,
            lng_step,
            count: west_of_antimeridian as u32,
        });
    }
    if count > west_of_antimeridian {
        runs.push(GridRun {
            lat,
            lng: lng + west_of_antimeridian as f64 * lng_step - 360.0,
            lng_step,
            count: (count - west_of_antimeridian) as u32,
        });
    }
}

#[cfg(test)]
#[path = "hex.test.rs"]
mod tests;
