//! Point sampling inside prepared polygons. Callers supply the randomness as a
//! `FnMut() -> f64` over [0, 1), so the geometry stays deterministic under test.

use crate::{fold_lng, PreparedPolygons, M_PER_DEG};

/// Up to `count` points drawn uniformly by area inside the polygons, as `[lng, lat]`
/// pairs in [-180, 180). Draws are rejection-sampled from the bbox, latitude weighted
/// by its cosine; sampling stops after `count * 200` draws so a sliver of a bbox
/// answers short instead of spinning.
pub fn random_points(
    polys: &PreparedPolygons,
    count: usize,
    mut rng: impl FnMut() -> f64,
) -> Vec<[f64; 2]> {
    let Some([w, s, e, n]) = polys.bbox() else {
        return Vec::new();
    };
    let (sin_s, sin_n) = (s.to_radians().sin(), n.to_radians().sin());
    let mut out = Vec::new();
    let max_attempts = count.saturating_mul(200);
    let mut attempts = 0;
    while out.len() < count && attempts < max_attempts {
        attempts += 1;
        let lng = w + rng() * (e - w);
        let lat = (rng() * (sin_n - sin_s) + sin_s).asin().to_degrees();
        if polys.contains(lng, lat) {
            out.push([fold_lng(lng, -180.0), lat]);
        }
    }
    out
}

/// The number of candidates tried around each accepted point.
const POISSON_K: usize = 30;
/// Draws allowed to find the first point inside the polygons before giving up.
const SEED_ATTEMPTS: usize = 10_000;

/// Points covering the polygons with no two closer than `min_distance_m` and no gap
/// wider than twice it (Bridson's blue-noise sampling), as `[lng, lat]` pairs in
/// [-180, 180), in random order. Distances are planar, scaled at the bbox's middle
/// latitude. Empty when no draw lands inside the polygons.
pub fn poisson_points(
    polys: &PreparedPolygons,
    min_distance_m: f64,
    mut rng: impl FnMut() -> f64,
) -> Vec<[f64; 2]> {
    let Some([w, s, e, n]) = polys.bbox() else {
        return Vec::new();
    };
    let m_per_deg_lng = M_PER_DEG * ((s + n) / 2.0).to_radians().cos();
    let to_lng = |mx: f64| fold_lng(mx / m_per_deg_lng + w, -180.0);
    let to_lat = |my: f64| my / M_PER_DEG + s;

    let width_m = (e - w) * m_per_deg_lng;
    let height_m = (n - s) * M_PER_DEG;
    let cell = min_distance_m / std::f64::consts::SQRT_2;
    let cols = ((width_m / cell).ceil() as usize).max(1);
    let rows = ((height_m / cell).ceil() as usize).max(1);
    let mut grid = vec![-1i32; cols * rows];
    let r2 = min_distance_m * min_distance_m;

    let mut xs: Vec<f64> = Vec::new();
    let mut ys: Vec<f64> = Vec::new();
    let mut active: Vec<usize> = Vec::new();

    let add = |xs: &mut Vec<f64>,
               ys: &mut Vec<f64>,
               active: &mut Vec<usize>,
               grid: &mut Vec<i32>,
               mx: f64,
               my: f64| {
        let idx = xs.len();
        xs.push(mx);
        ys.push(my);
        active.push(idx);
        let gx = ((mx / cell) as usize).min(cols - 1);
        let gy = ((my / cell) as usize).min(rows - 1);
        grid[gx + gy * cols] = idx as i32;
    };

    let mut seeded = false;
    for _ in 0..SEED_ATTEMPTS {
        let lng = w + rng() * (e - w);
        let (sin_s, sin_n) = (s.to_radians().sin(), n.to_radians().sin());
        let lat = (rng() * (sin_n - sin_s) + sin_s).asin().to_degrees();
        if polys.contains(lng, lat) {
            add(
                &mut xs,
                &mut ys,
                &mut active,
                &mut grid,
                (lng - w) * m_per_deg_lng,
                (lat - s) * M_PER_DEG,
            );
            seeded = true;
            break;
        }
    }
    if !seeded {
        return Vec::new();
    }

    while !active.is_empty() {
        let a = (rng() * active.len() as f64) as usize % active.len();
        let (px, py) = (xs[active[a]], ys[active[a]]);
        let mut accepted = false;

        for _ in 0..POISSON_K {
            let angle = rng() * 2.0 * std::f64::consts::PI;
            let dist = min_distance_m * (1.0 + rng());
            let cx = px + dist * angle.cos();
            let cy = py + dist * angle.sin();
            if cx < 0.0 || cx >= width_m || cy < 0.0 || cy >= height_m {
                continue;
            }
            let gx = (cx / cell) as usize;
            let gy = (cy / cell) as usize;
            let mut too_close = false;
            'scan: for ny in gy.saturating_sub(2)..=(gy + 2).min(rows - 1) {
                for nx in gx.saturating_sub(2)..=(gx + 2).min(cols - 1) {
                    let idx = grid[nx + ny * cols];
                    if idx < 0 {
                        continue;
                    }
                    let (dx, dy) = (cx - xs[idx as usize], cy - ys[idx as usize]);
                    if dx * dx + dy * dy < r2 {
                        too_close = true;
                        break 'scan;
                    }
                }
            }
            if too_close || !polys.contains(to_lng(cx), to_lat(cy)) {
                continue;
            }
            add(&mut xs, &mut ys, &mut active, &mut grid, cx, cy);
            accepted = true;
        }

        if !accepted {
            active.swap_remove(a);
        }
    }

    let mut out: Vec<[f64; 2]> = xs
        .iter()
        .zip(&ys)
        .map(|(&mx, &my)| [to_lng(mx), to_lat(my)])
        .collect();
    for i in (1..out.len()).rev() {
        let j = (rng() * (i + 1) as f64) as usize % (i + 1);
        out.swap(i, j);
    }
    out
}

#[cfg(test)]
#[path = "sample.test.rs"]
mod tests;
