use rustc_hash::FxHashMap;
use serde::Deserialize;
use std::path::Path;
use vali_geo::geohash::HashPrecision;
use vali_geo::{bucketize, encode, nearby, points_are_closer_than};
pub struct ProximityIndex {
    points: Vec<(f64, f64)>,
    buckets: FxHashMap<u64, Vec<u32>>,
    radius_squared: f64,
    precision: HashPrecision,
}
pub fn precision_from_radius(radius: i32) -> HashPrecision {
    if radius < 500 {
        HashPrecision::Size_km_1x1
    } else if radius < 3000 {
        HashPrecision::Size_km_5x5
    } else {
        HashPrecision::Size_km_39x20
    }
}
impl ProximityIndex {
    pub fn build(points: Vec<(f64, f64)>, radius: i32) -> ProximityIndex {
        let precision = precision_from_radius(radius);
        let buckets = bucketize(&points, Some(precision));
        ProximityIndex {
            points,
            buckets,
            radius_squared: radius as f64 * radius as f64,
            precision,
        }
    }
    pub fn matches(&self, lat: f64, lng: f64) -> bool {
        let hash = encode(lat, lng, self.precision);
        nearby(&self.buckets, hash).any(|i| {
            let (plat, plng) = self.points[i as usize];
            points_are_closer_than(lat, lng, plat, plng, self.radius_squared)
        })
    }
}
#[derive(Deserialize)]
struct LatLngRecord {
    lat: f64,
    lng: f64,
}
pub fn read_locations_lat_lng(path: &Path) -> anyhow::Result<Vec<(f64, f64)>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = std::fs::read(path)?;
    let json = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    let records: Vec<LatLngRecord> = serde_json::from_slice(json)?;
    Ok(records.into_iter().map(|r| (r.lat, r.lng)).collect())
}
