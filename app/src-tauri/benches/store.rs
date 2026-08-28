//! Criterion suite over the store's hot paths.
//!
//! Every case is named for the app operation it measures and runs against a
//! realistically populated store (22-char pano ids, 0-5 tags, ~120B of `extra` on
//! a quarter of rows). Nothing here asserts an absolute time; the suite exists to
//! be diffed against itself.
//!
//! Running it:
//!
//! ```sh
//! export CARGO_TARGET_DIR=E:/cargo-build/mma-dev/target   # never src-tauri/target
//!
//! # (a) quick smoke -- 10k rows, one pass, no statistics
//! cargo bench --features bench --bench store -- --quick
//!
//! # (b) full scale -- 200k rows (or 1000000), full sampling
//! MMA_BENCH_SCALE=200000 cargo bench --features bench --bench store
//!
//! # a single case or group
//! cargo bench --features bench --bench store -- update_locations
//! ```
//!
//! A/B across a change:
//!
//! ```sh
//! git stash                                                     # or check out the base rev
//! MMA_BENCH_SCALE=200000 cargo bench --features bench --bench store -- --save-baseline before
//! git stash pop
//! MMA_BENCH_SCALE=200000 cargo bench --features bench --bench store -- --baseline before
//! ```
//!
//! The second run prints a change percentage and a significance verdict per case.
//! Keep `MMA_BENCH_SCALE` identical across the two halves -- it is part of the
//! bench id, so a mismatched run silently compares nothing. Baselines live in
//! `$CARGO_TARGET_DIR/criterion/`, so both halves must use the same target dir.
//!
//! The bench profile inherits `[profile.release]`, fat LTO included, so a rebuild
//! after touching the store costs ~6 min. Halve that while iterating:
//!
//! ```sh
//! cargo bench --features bench --bench store \
//!   --config 'profile.bench.lto=false' --config 'profile.bench.codegen-units=16'
//! ```
//!
//! Absolute numbers shift under it (less cross-crate inlining of arrow/roaring), so
//! use it for both halves of an A/B or neither.

use app_lib::bench_api as bench;
use bench::{LocationPatch, Selection, SelectionInput, Selector};
use criterion::{criterion_group, criterion_main, BatchSize, BenchmarkId, Criterion, Throughput};
use roaring::RoaringBitmap;
use std::env;
use std::fs;
use std::hint::black_box;

/// Rows in the fixture population. `MMA_BENCH_SCALE` overrides.
fn n() -> usize {
    bench::scale()
}

fn add_locations(c: &mut Criterion) {
    let n = n();
    let fx = bench::Fixture::new(n);
    let app = bench::BenchApp::new();

    let mut g = c.benchmark_group("add_locations");
    g.sample_size(30);
    let mut sizes = vec![1, 100, n.min(10_000), n];
    sizes.sort_unstable();
    sizes.dedup();
    for batch_size in sizes {
        let incoming = bench::locations(batch_size, 0xADD5);
        g.throughput(Throughput::Elements(batch_size as u64));
        g.bench_function(BenchmarkId::from_parameter(batch_size), |b| {
            b.iter_batched(
                || {
                    app.set_store(fx.store());
                    incoming.clone()
                },
                |locs| black_box(app.add_locations(locs)),
                BatchSize::PerIteration,
            );
        });
    }
    g.finish();
}

fn update_locations(c: &mut Criterion) {
    let n = n();
    let fx = bench::Fixture::new(n);
    let updates = fx.heading_updates(n);

    let mut g = c.benchmark_group("update_locations");
    g.sample_size(10);
    g.throughput(Throughput::Elements(n as u64));
    for record_undo in [true, false] {
        let id = format!("{n}/undo_{record_undo}");
        g.bench_function(id, |b| {
            b.iter_batched_ref(
                || fx.store(),
                |store| black_box(bench::update_locations(store, &updates, record_undo)),
                BatchSize::PerIteration,
            );
        });
    }
    g.finish();
}

fn noop_updates(c: &mut Criterion) {
    let n = n();
    let fx = bench::Fixture::new(n);
    let app = bench::BenchApp::new();

    let mut g = c.benchmark_group("noop_updates");
    g.sample_size(10);
    g.throughput(Throughput::Elements(n as u64));
    g.bench_function(format!("{n}/no_selection/{n}"), |b| {
        b.iter_batched(
            || {
                app.set_store(fx.rendered_store());
                fx.noop_heading_updates(n)
            },
            |updates| black_box(app.update_locations(updates, false)),
            BatchSize::PerIteration,
        );
    });
    for count in [100, 101] {
        g.throughput(Throughput::Elements(count as u64));
        g.bench_function(format!("{n}/tag_selection/{count}"), |b| {
            b.iter_batched(
                || {
                    app.set_store(fx.rendered_store());
                    app.sync_selections(vec![SelectionInput {
                        key: "tag:3".into(),
                        selector: Selector::Tag { tag_id: 3 },
                        color: [255, 0, 0],
                        ghosted: false,
                    }]);
                    fx.noop_heading_updates(count)
                },
                |updates| black_box(app.update_locations(updates, false)),
                BatchSize::PerIteration,
            );
        });
    }
    g.finish();
}

/// Per-row internals that explain the bulk-update headline.
fn row_ops(c: &mut Criterion) {
    let fx = bench::Fixture::new(n());
    let store = fx.store();
    let loc = bench::one_location(7);

    let mut g = c.benchmark_group("row_ops");
    g.bench_function("location_clone", |b| {
        b.iter(|| black_box(loc.clone()));
    });
    g.bench_function("base_loc_by_id", |b| {
        b.iter(|| black_box(bench::base_loc_by_id(&store, 1)));
    });
    g.bench_function("get_loc_by_id/base", |b| {
        b.iter(|| black_box(bench::get_loc_by_id(&store, 1)));
    });

    // A store with row 1 living in the overlay patches instead of the base batch.
    let mut patched = fx.store();
    bench::overlay_update(
        &mut patched,
        1,
        &LocationPatch {
            heading: Some(123.0),
            ..Default::default()
        },
    );
    g.bench_function("get_loc_by_id/patched", |b| {
        b.iter(|| black_box(bench::get_loc_by_id(&patched, 1)));
    });

    // overlay_write, the two branches that decide the bulk-update cost: writing a row
    // back unchanged (compare against the caller's old row, no Arrow materialization)
    // versus changing a row that is already patched (the one branch that still has to
    // materialize the base row to test for a revert).
    // The row clone happens in setup so only the write itself is measured.
    let base_row = bench::get_loc_by_id(&store, 1).unwrap();
    let mut wstore = fx.store();
    g.bench_function("overlay_write/no_op", |b| {
        b.iter_batched(
            || base_row.clone(),
            |loc| bench::overlay_write(&mut wstore, loc, &base_row),
            BatchSize::SmallInput,
        );
    });

    let mut wstore2 = fx.store();
    let mut heading = 0.0f64;
    bench::overlay_write(
        &mut wstore2,
        {
            let mut l = base_row.clone();
            l.heading = 1.0;
            l
        },
        &base_row,
    );
    g.bench_function("overlay_write/patched_row_change", |b| {
        b.iter_batched(
            || {
                heading = (heading + 1.0) % 360.0;
                let mut l = base_row.clone();
                l.heading = heading;
                l
            },
            |l| bench::overlay_write(&mut wstore2, l, &base_row),
            BatchSize::SmallInput,
        );
    });
    g.finish();
}

fn selections(c: &mut Criterion) {
    let n = n();
    let fx = bench::Fixture::new(n);
    let store = fx.rendered_store();
    let app = bench::BenchApp::new();
    app.set_store(fx.rendered_store());

    let tag_leaf = Selector::Tag { tag_id: 3 };
    let composite = Selector::Intersection {
        selections: vec![
            Selection {
                key: "tag:1".into(),
                color: [255, 0, 0],
                selector: Selector::Tag { tag_id: 1 },
            },
            Selection {
                key: "tag:2".into(),
                color: [0, 255, 0],
                selector: Selector::Tag { tag_id: 2 },
            },
        ],
    };
    let input = |key: &str, selector: &Selector| SelectionInput {
        key: key.into(),
        selector: selector.clone(),
        color: [255, 0, 0],
        ghosted: false,
    };

    let mut g = c.benchmark_group("selections");
    g.sample_size(20);
    g.throughput(Throughput::Elements(n as u64));
    g.bench_function(format!("{n}/resolve/tag"), |b| {
        b.iter(|| black_box(bench::resolve_selection(&store, &tag_leaf)));
    });
    g.bench_function(format!("{n}/resolve/intersection"), |b| {
        b.iter(|| black_box(bench::resolve_selection(&store, &composite)));
    });

    g.bench_function(format!("{n}/sync/tag"), |b| {
        b.iter(|| black_box(app.sync_selections(vec![input("tag:3", &tag_leaf)])));
    });
    g.bench_function(format!("{n}/sync/intersection"), |b| {
        b.iter(|| black_box(app.sync_selections(vec![input("int:1+2", &composite)])));
    });
    g.finish();
}

fn scope_traversal(c: &mut Criterion) {
    let n = n();
    let fx = bench::Fixture::new(n);
    let store = fx.store();
    let sparse: RoaringBitmap = (1..=100)
        .map(|i| ((i * n / 100).max(1).min(n)) as u32)
        .collect();
    let dense: RoaringBitmap = (1..=n as u32).step_by(2).collect();

    let mut g = c.benchmark_group("scope_traversal");
    g.sample_size(20);
    for (name, set) in [("sparse_100", sparse), ("dense_50pct", dense)] {
        g.throughput(Throughput::Elements(set.len()));
        g.bench_function(format!("{n}/{name}"), |b| {
            b.iter(|| black_box(bench::traverse_scope(&store, &set)));
        });
    }
    g.finish();
}

fn spatial_queries(c: &mut Criterion) {
    let n = n();
    let fx = bench::Fixture::new(n);
    let app = bench::BenchApp::new();
    app.set_store(fx.store());
    app.near_any(vec![80.0], vec![0.0], 2.0);

    let hit = fx.coords((n / 2).max(1) as u32);
    let mut g = c.benchmark_group("find_nearby");
    g.sample_size(20);
    g.bench_function(format!("{n}/hit_2m"), |b| {
        b.iter(|| black_box(app.find_nearby(hit.0, hit.1, 2.0)));
    });
    g.bench_function(format!("{n}/miss_2m"), |b| {
        b.iter(|| black_box(app.find_nearby(80.0, 0.0, 2.0)));
    });
    g.bench_function(format!("{n}/dense_1000km"), |b| {
        b.iter(|| black_box(app.find_nearby(0.0, 0.0, 1_000_000.0)));
    });
    g.finish();

    let count = 1_000usize.min(n);
    let ids = (1..=count).map(|i| ((i * n / count).max(1)) as u32);
    let (hit_lats, hit_lngs): (Vec<_>, Vec<_>) = ids.map(|id| fx.coords(id)).unzip();
    let miss_lats = vec![80.0; count];
    let miss_lngs: Vec<f64> = (0..count)
        .map(|i| i as f64 * 360.0 / count as f64 - 180.0)
        .collect();
    let mut g = c.benchmark_group("near_any");
    g.sample_size(20);
    g.throughput(Throughput::Elements(count as u64));
    for (name, lats, lngs) in [
        ("hit_100m", hit_lats, hit_lngs),
        ("miss_100m", miss_lats, miss_lngs),
    ] {
        g.bench_function(format!("{n}/{name}/{count}"), |b| {
            b.iter_batched(
                || (lats.clone(), lngs.clone()),
                |(lats, lngs)| black_box(app.near_any(lats, lngs, 100.0)),
                BatchSize::SmallInput,
            );
        });
    }
    g.finish();
}

fn autosave_serialize(c: &mut Criterion) {
    let n = n();
    let fx = bench::Fixture::new(n);
    let patch_count = n / 10;
    let updates = fx.heading_updates(patch_count);
    let adds = bench::locations(patch_count, 0x5A7E);
    let mut patched = fx.store();
    bench::update_locations(&mut patched, &updates, false);
    let mut mixed = fx.store();
    bench::update_locations(&mut mixed, &updates, false);
    bench::seed_adds(&mut mixed, adds);

    let mut g = c.benchmark_group("autosave_serialize");
    g.sample_size(10);
    for (name, rows, store) in [
        ("patches_10pct", patch_count, patched),
        ("patched_10pct_added_10pct", patch_count * 2, mixed),
    ] {
        g.throughput(Throughput::Elements(rows as u64));
        g.bench_function(format!("{n}/{name}"), |b| {
            b.iter(|| black_box(bench::serialize_overlay(&store).len()));
        });
    }
    g.finish();
}

fn removes(c: &mut Criterion) {
    let n = n();
    let fx = bench::Fixture::new(n);
    let tenth: Vec<u32> = (1..=(n as u32 / 10)).collect();
    let app = bench::BenchApp::new();

    let mut g = c.benchmark_group("remove_locations");
    g.sample_size(10);
    g.bench_function(format!("{n}/single"), |b| {
        b.iter_batched(
            || app.set_store(fx.store()),
            |()| black_box(app.remove_locations(vec![n as u32 / 2])),
            BatchSize::PerIteration,
        );
    });
    g.throughput(Throughput::Elements(tenth.len() as u64));
    g.bench_function(format!("{n}/bulk_10pct"), |b| {
        b.iter_batched(
            || app.set_store(fx.store()),
            |()| black_box(app.remove_locations(tenth.clone())),
            BatchSize::PerIteration,
        );
    });
    g.finish();

    // The undo-delete pair the e2e suite flagged: undo re-creates the rows,
    // redo re-tombstones them.
    let mut g2 = c.benchmark_group("undo_redo");
    g2.sample_size(10);
    g2.throughput(Throughput::Elements(tenth.len() as u64));
    g2.bench_function(format!("{n}/undo_delete_10pct"), |b| {
        b.iter_batched(
            || {
                app.set_store(fx.store());
                app.remove_locations(tenth.clone());
            },
            |()| black_box(app.undo()),
            BatchSize::PerIteration,
        );
    });
    g2.bench_function(format!("{n}/redo_delete_10pct"), |b| {
        b.iter_batched(
            || {
                app.set_store(fx.store());
                app.remove_locations(tenth.clone());
                app.undo();
            },
            |()| black_box(app.redo()),
            BatchSize::PerIteration,
        );
    });
    g2.finish();
}

fn undo_redo(c: &mut Criterion) {
    let n = n();
    let fx = bench::Fixture::new(n);
    let updates = fx.heading_updates(n);

    let app = bench::BenchApp::new();
    let mut g = c.benchmark_group("undo_redo");
    g.sample_size(10);
    g.throughput(Throughput::Elements(n as u64));
    // Setup builds the undo entry (an n-row update); the measured part is the
    // reverse replay plus the mutation it produces.
    g.bench_function(format!("{n}/undo"), |b| {
        b.iter_batched(
            || {
                let mut store = fx.store();
                bench::update_locations(&mut store, &updates, true);
                app.set_store(store);
            },
            |()| black_box(app.undo()),
            BatchSize::PerIteration,
        );
    });
    g.bench_function(format!("{n}/redo"), |b| {
        b.iter_batched(
            || {
                let mut store = fx.store();
                bench::update_locations(&mut store, &updates, true);
                app.set_store(store);
                app.undo();
            },
            |()| black_box(app.redo()),
            BatchSize::PerIteration,
        );
    });
    g.finish();
}

fn bake(c: &mut Criterion) {
    let n = n();
    let fx = bench::Fixture::new(n);
    let updates = fx.heading_updates(n / 10);
    let adds = bench::locations(n / 10, 0xBA6E);

    let mut g = c.benchmark_group("bake_overlay");
    g.sample_size(10);
    g.throughput(Throughput::Elements(n as u64));
    g.bench_function(format!("{n}/patched_10pct_added_10pct"), |b| {
        b.iter_batched_ref(
            || {
                let mut store = fx.store();
                bench::update_locations(&mut store, &updates, false);
                bench::seed_adds(&mut store, adds.clone());
                store
            },
            bench::bake_overlay,
            BatchSize::PerIteration,
        );
    });
    g.finish();
}

fn render(c: &mut Criterion) {
    let n = n();
    let fx = bench::Fixture::new(n);
    let delta_updates = fx.heading_updates(100);

    let app = bench::BenchApp::new();
    app.set_store(fx.store());
    let mut g = c.benchmark_group("render");
    g.sample_size(10);
    g.throughput(Throughput::Elements(n as u64));
    // The real command, temp-file write included -- the cost the app pays per full render.
    g.bench_function(format!("{n}/full_build"), |b| {
        b.iter(|| black_box(app.fill_render().len()));
    });
    // A 100-row edit on a rendered store: the delta path, which must not scale with n.
    g.bench_function(format!("{n}/delta_100"), |b| {
        b.iter_batched_ref(
            || fx.rendered_store(),
            |store| black_box(bench::update_locations(store, &delta_updates, false)),
            BatchSize::PerIteration,
        );
    });
    let all_updates = fx.heading_updates(n);
    g.bench_function(format!("{n}/delta_{n}"), |b| {
        b.iter_batched_ref(
            || fx.rendered_store(),
            |store| black_box(bench::update_locations(store, &all_updates, false)),
            BatchSize::PerIteration,
        );
    });
    g.finish();
}

fn map_open(c: &mut Criterion) {
    let n = n();
    let fx = bench::Fixture::new(n);
    let dir = env::temp_dir().join("mma_bench_open");
    fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join(format!("bench_{n}.arrow"));
    bench::write_arrow(&path, &fx.batch);

    let mut g = c.benchmark_group("map_open");
    g.sample_size(10);
    g.throughput(Throughput::Elements(n as u64));
    // Arrow mmap + the O(N) aggregate scan + tag membership index rebuild.
    g.bench_function(format!("{n}/arrow_mmap_and_index"), |b| {
        b.iter(|| black_box(bench::alive(&bench::open_from_arrow(&path, &fx.tags))));
    });
    g.bench_function(format!("{n}/scan_aggregates"), |b| {
        b.iter_batched_ref(
            || fx.store(),
            |store| black_box(bench::scan(store)),
            BatchSize::PerIteration,
        );
    });
    g.bench_function(format!("{n}/derived_state"), |b| {
        b.iter_batched_ref(
            || fx.store(),
            |store| black_box(bench::derived_state(store)),
            BatchSize::PerIteration,
        );
    });
    g.finish();
    fs::remove_file(&path).ok();
    fs::remove_dir(&dir).ok();
}

criterion_group!(
    benches,
    add_locations,
    update_locations,
    noop_updates,
    row_ops,
    selections,
    scope_traversal,
    spatial_queries,
    autosave_serialize,
    removes,
    undo_redo,
    bake,
    render,
    map_open
);
criterion_main!(benches);
