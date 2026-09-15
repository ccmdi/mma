//! Oracle port, not general geometry -- see `distance.rs`. The grid walk and its
//! constants mirror Vali.Core; `mma-geo`'s `covering_cells`/`M_PER_DEG` are a
//! different contract and must not be substituted here.

use crate::distance::points_are_closer_than;
use rustc_hash::FxHashMap;
use std::f64::consts::PI;
pub const DISTANCES: [i32; 53] = [
    25, 50, 75, 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900,
    1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750, 3000, 3300, 3600, 3900, 4200, 4500, 5000, 6000,
    7000, 8000, 9000, 10000, 12500, 15000, 20000, 25000, 30000, 35000, 40000, 45000, 50000, 55000,
    60000, 65000, 70000, 75000,
];
const METRES_PER_DEGREE: f64 = 6371137.0 * PI / 180.0;
pub fn with_max_min_distance(
    ordered_candidates: &[(f64, f64)],
    goal_count: usize,
    min_min_distance: Option<i32>,
    already_in_map: &[(f64, f64)],
) -> (Vec<u32>, i32) {
    let start = match min_min_distance {
        Some(m) => DISTANCES
            .iter()
            .position(|&x| x >= m)
            .unwrap_or(DISTANCES.len()),
        None => 0,
    };
    let distances = &DISTANCES[start..];
    if distances.is_empty() || goal_count == 0 {
        return (Vec::new(), 0);
    }
    let mut cache: Vec<Option<Vec<u32>>> = vec![None; distances.len()];
    let eval = |idx: usize, cache: &mut Vec<Option<Vec<u32>>>| -> usize {
        if cache[idx].is_none() {
            cache[idx] = Some(place_spaced(
                ordered_candidates,
                goal_count,
                distances[idx],
                already_in_map,
            ));
        }
        cache[idx].as_ref().unwrap().len()
    };
    let seed = seed_index(ordered_candidates, distances, goal_count);
    let mut low: i32 = 0;
    let mut high: i32 = distances.len() as i32 - 1;
    let mut best_idx: Option<usize> = None;
    let mut best_distance = 0;
    let mut probe: i32 = (seed as i32).clamp(low, high);
    while low <= high {
        let count = eval(probe as usize, &mut cache);
        if count >= goal_count {
            best_idx = Some(probe as usize);
            best_distance = distances[probe as usize];
            low = probe + 1;
        } else {
            high = probe - 1;
        }
        if low > high {
            break;
        }
        probe = low + (high - low) / 2;
    }
    if let Some(idx) = best_idx {
        return (cache[idx].take().unwrap(), best_distance);
    }
    let count = eval(0, &mut cache);
    let fallback = cache[0].take().unwrap();
    (fallback, if count == 0 { 0 } else { distances[0] })
}
pub fn get_some(
    ordered_candidates: &[(f64, f64)],
    goal_count: usize,
    min_distance: i32,
    already_in_map: &[(f64, f64)],
) -> Vec<u32> {
    if goal_count == 0 || ordered_candidates.is_empty() {
        return Vec::new();
    }
    let d_squared = min_distance as f64 * min_distance as f64;
    let mut alive: Vec<bool> = vec![true; ordered_candidates.len()];
    if !already_in_map.is_empty() {
        for (i, &(lat, lng)) in ordered_candidates.iter().enumerate() {
            if already_in_map
                .iter()
                .any(|&(plat, plng)| points_are_closer_than(plat, plng, lat, lng, d_squared))
            {
                alive[i] = false;
            }
        }
    }
    let mut selected: Vec<u32> = Vec::new();
    let mut cursor = 0usize;
    while selected.len() < goal_count {
        while cursor < alive.len() && !alive[cursor] {
            cursor += 1;
        }
        if cursor == alive.len() {
            break;
        }
        let (lat, lng) = ordered_candidates[cursor];
        alive[cursor] = false;
        selected.push(cursor as u32);
        for i in cursor + 1..alive.len() {
            if alive[i] {
                let (lat2, lng2) = ordered_candidates[i];
                if points_are_closer_than(lat2, lng2, lat, lng, d_squared) {
                    alive[i] = false;
                }
            }
        }
    }
    selected
}
pub fn place_spaced(
    ordered_candidates: &[(f64, f64)],
    goal_count: usize,
    min_distance: i32,
    already_in_map: &[(f64, f64)],
) -> Vec<u32> {
    if goal_count == 0 || ordered_candidates.is_empty() {
        return Vec::new();
    }
    let d = min_distance;
    let d_squared = d as f64 * d as f64;
    let mut max_abs_lat = 0.0f64;
    for &(lat, _) in ordered_candidates {
        let a = lat.abs();
        if a > max_abs_lat {
            max_abs_lat = a;
        }
    }
    for &(lat, _) in already_in_map {
        let a = lat.abs();
        if a > max_abs_lat {
            max_abs_lat = a;
        }
    }
    let mut cos_ref = (max_abs_lat.min(89.0) * PI / 180.0).cos();
    if cos_ref < 1e-6 {
        cos_ref = 1e-6;
    }
    let cell_lat = d as f64 / METRES_PER_DEGREE;
    let cell_lng = d as f64 / (METRES_PER_DEGREE * cos_ref);
    let mut grid: FxHashMap<i64, Vec<(f64, f64)>> = FxHashMap::default();
    for &(lat, lng) in already_in_map {
        let key = pack(
            (lng / cell_lng).floor() as i32,
            (lat / cell_lat).floor() as i32,
        );
        grid.entry(key)
            .or_insert_with(|| Vec::with_capacity(1))
            .push((lat, lng));
    }
    let mut result: Vec<u32> = Vec::with_capacity(goal_count.min(ordered_candidates.len()));
    for (i, &(lat, lng)) in ordered_candidates.iter().enumerate() {
        if result.len() >= goal_count {
            break;
        }
        let cx = (lng / cell_lng).floor() as i32;
        let cy = (lat / cell_lat).floor() as i32;
        let mut ok = true;
        'scan: for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(bucket) = grid.get(&pack(cx + dx, cy + dy)) {
                    for &(blat, blng) in bucket {
                        if points_are_closer_than(blat, blng, lat, lng, d_squared) {
                            ok = false;
                            break 'scan;
                        }
                    }
                }
            }
        }
        if ok {
            result.push(i as u32);
            grid.entry(pack(cx, cy))
                .or_insert_with(|| Vec::with_capacity(1))
                .push((lat, lng));
        }
    }
    result
}
fn seed_index(candidates: &[(f64, f64)], distances: &[i32], goal_count: usize) -> usize {
    let mut min_lat = f64::MAX;
    let mut max_lat = f64::MIN;
    let mut min_lng = f64::MAX;
    let mut max_lng = f64::MIN;
    for &(lat, lng) in candidates {
        if lat < min_lat {
            min_lat = lat;
        }
        if lat > max_lat {
            max_lat = lat;
        }
        if lng < min_lng {
            min_lng = lng;
        }
        if lng > max_lng {
            max_lng = lng;
        }
    }
    let mid_lat_rad = (min_lat + max_lat) * 0.5 * PI / 180.0;
    let height_m = (max_lat - min_lat) * METRES_PER_DEGREE;
    let width_m = (max_lng - min_lng) * METRES_PER_DEGREE * mid_lat_rad.cos();
    let area = height_m.max(1.0) * width_m.max(1.0);
    let guess_distance = (area / goal_count.max(1) as f64).sqrt();
    nearest_index(distances, guess_distance)
}
fn nearest_index(sorted_ascending: &[i32], target: f64) -> usize {
    let mut best = 0;
    let mut best_diff = f64::MAX;
    for (i, &d) in sorted_ascending.iter().enumerate() {
        let diff = (d as f64 - target).abs();
        if diff < best_diff {
            best_diff = diff;
            best = i;
        }
    }
    best
}
fn pack(cx: i32, cy: i32) -> i64 {
    ((cx as i64) << 32) | (cy as u32 as i64)
}
