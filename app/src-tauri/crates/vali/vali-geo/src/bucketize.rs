use crate::geohash::{encode, neighbors, HashPrecision};
use rustc_hash::FxHashMap;
pub fn bucketize(
    points: &[(f64, f64)],
    precision: Option<HashPrecision>,
) -> FxHashMap<u64, Vec<u32>> {
    let Some(precision) = precision else {
        return FxHashMap::default();
    };
    let mut buckets: FxHashMap<u64, Vec<u32>> = FxHashMap::default();
    for (i, &(lat, lng)) in points.iter().enumerate() {
        buckets
            .entry(encode(lat, lng, precision))
            .or_default()
            .push(i as u32);
    }
    buckets
}
pub fn nearby<'a>(
    buckets: &'a FxHashMap<u64, Vec<u32>>,
    hash: u64,
) -> impl Iterator<Item = u32> + 'a {
    const EMPTY: &[u32] = &[];
    let center = buckets.get(&hash).map_or(EMPTY, |v| v.as_slice());
    center
        .iter()
        .copied()
        .chain(neighbors(hash).into_iter().flat_map(move |h| {
            buckets
                .get(&h)
                .map_or(EMPTY, |v| v.as_slice())
                .iter()
                .copied()
        }))
}
