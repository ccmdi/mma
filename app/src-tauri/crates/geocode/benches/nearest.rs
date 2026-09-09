use criterion::{criterion_group, criterion_main, Criterion};
use mma_geocode::Geocoder;
use std::hint::black_box;

#[repr(align(4))]
struct Aligned<B: ?Sized>(B);
static TABLE: &Aligned<[u8]> = &Aligned(*include_bytes!("../../../data/cities.bin"));

fn land_coords(g: &Geocoder<'_>, n: usize) -> Vec<(f64, f64)> {
    fastrand::seed(7);
    (0..n)
        .map(|_| {
            let r = g.get(fastrand::usize(..g.len())).unwrap();
            (r.lat + fastrand::f64() * 0.1 - 0.05, r.lng + fastrand::f64() * 0.1 - 0.05)
        })
        .collect()
}

fn uniform_coords(n: usize) -> Vec<(f64, f64)> {
    fastrand::seed(11);
    (0..n)
        .map(|_| (fastrand::f64() * 180.0 - 90.0, fastrand::f64() * 360.0 - 180.0))
        .collect()
}

fn bench(c: &mut Criterion) {
    let g = Geocoder::new(&TABLE.0).unwrap();
    let oracle = reverse_geocoder::ReverseGeocoder::new();
    let land = land_coords(&g, 4096);
    let uniform = uniform_coords(4096);

    for (set, coords) in [("land", &land), ("uniform", &uniform)] {
        let mut i = 0;
        c.bench_function(&format!("mma-geocode/{set}"), |b| {
            b.iter(|| {
                let (lat, lng) = coords[i & 4095];
                i += 1;
                black_box(g.nearest(black_box(lat), black_box(lng)))
            })
        });
        let mut i = 0;
        c.bench_function(&format!("reverse_geocoder/{set}"), |b| {
            b.iter(|| {
                let (lat, lng) = coords[i & 4095];
                i += 1;
                black_box(oracle.search(black_box((lat, lng))))
            })
        });
    }
}

criterion_group!(benches, bench);
criterion_main!(benches);
