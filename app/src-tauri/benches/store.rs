//! Store benchmarks for comparing the same workload across revisions.
//!
//! ```sh
//! # Smoke run
//! cargo bench --features bench --bench store -- --quick
//!
//! # Save a baseline, then repeat on the changed revision with --baseline before
//! MMA_BENCH_SCALE=200000 cargo bench --features bench --bench store -- --save-baseline before
//! ```
//!
//! Keep scale, target directory, and compiler settings identical across comparisons.
//! Baselines live in `$CARGO_TARGET_DIR/criterion/`.
//! To shorten rebuilds, use these options for both runs:
//! `--config 'profile.bench.lto=false' --config 'profile.bench.codegen-units=16'`.

use app_lib::bench_api as bench;
use bench::{Change, Edit, Id, Location, Op, Patch, Selector};
use criterion::{criterion_group, criterion_main, BatchSize, BenchmarkId, Criterion, Throughput};
use std::env;
use std::fs;
use std::hint::black_box;

/// Rows in the fixture population. `MMA_BENCH_SCALE` overrides.
fn n() -> usize {
    bench::scale()
}

/// `count` fresh locations as add edits.
fn adds(count: usize, seed: u64) -> Vec<Edit<Location>> {
    bench::locations(count, seed)
        .into_iter()
        .map(Op::Add)
        .collect()
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
        let incoming = adds(batch_size, 0xADD5);
        g.throughput(Throughput::Elements(batch_size as u64));
        g.bench_function(BenchmarkId::from_parameter(batch_size), |b| {
            b.iter_batched(
                || {
                    app.set_store(fx.store());
                    incoming.clone()
                },
                |edits| black_box(app.edit(edits)),
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
    g.bench_function(n.to_string(), |b| {
        b.iter_batched_ref(
            || fx.store(),
            |store| black_box(bench::write(store, &updates)),
            BatchSize::PerIteration,
        );
    });
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
            |updates| black_box(app.edit(updates)),
            BatchSize::PerIteration,
        );
    });
    for count in [100, 101] {
        g.throughput(Throughput::Elements(count as u64));
        g.bench_function(format!("{n}/tag_selection/{count}"), |b| {
            b.iter_batched(
                || {
                    app.set_store(fx.rendered_store());
                    app.edit_selections(vec![Selector::tag(3)]);
                    fx.noop_heading_updates(count)
                },
                |updates| black_box(app.edit(updates)),
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
    let turn = Op::Put(Patch::<Location> {
        id: Id::new(1),
        heading: Some(123.0),
        ..Default::default()
    });
    bench::write(&mut patched, &[turn]);
    g.bench_function("get_loc_by_id/patched", |b| {
        b.iter(|| black_box(bench::get_loc_by_id(&patched, 1)));
    });

    // `put`, the step every write ends in, changing one row. The change is built in setup
    // so only the put itself is measured.
    let base_row = bench::get_loc_by_id(&store, 1).unwrap();
    let mut wstore = fx.store();
    let mut heading = 0.0f64;
    g.bench_function("put/row_change", |b| {
        b.iter_batched(
            || {
                heading = (heading + 1.0) % 360.0;
                let mut l = base_row.clone();
                l.heading = heading;
                Change {
                    updated: vec![(base_row.clone(), l)],
                    ..Change::default()
                }
            },
            |change| bench::put(&mut wstore, &change),
            BatchSize::SmallInput,
        );
    });
    g.finish();
}

fn overlay(c: &mut Criterion) {
    let mut group = c.benchmark_group("overlay");
    let mut sizes = vec![1, n().min(1_000), n()];
    sizes.sort_unstable();
    sizes.dedup();
    for size in sizes {
        let rows = bench::locations(size, 0xADD5);
        let mut store = bench::Fixture::new(0).store();
        bench::put(
            &mut store,
            &Change {
                added: rows,
                ..Change::default()
            },
        );
        let before = bench::get_loc_by_id(&store, 1).unwrap();
        let after = Location {
            heading: before.heading + 1.0,
            ..before.clone()
        };
        let mut change = Change {
            updated: vec![(before, after)],
            ..Change::default()
        };
        group.bench_function(BenchmarkId::new("update_added_row", size), |b| {
            b.iter(|| {
                bench::put(&mut store, black_box(&change));
                let (before, after) = &mut change.updated[0];
                std::mem::swap(before, after);
            });
        });

        let mut store = bench::Fixture::new(size).store();
        let before: Vec<_> = (1..=size as u32)
            .map(|id| bench::get_loc_by_id(&store, id).unwrap())
            .collect();
        bench::put(
            &mut store,
            &Change {
                updated: before
                    .into_iter()
                    .map(|row| {
                        let after = Location {
                            heading: row.heading + 1.0,
                            ..row.clone()
                        };
                        (row, after)
                    })
                    .collect(),
                ..Change::default()
            },
        );
        group.bench_function(BenchmarkId::new("pending_counts", size), |b| {
            b.iter(|| black_box(bench::pending(black_box(&store))));
        });
    }
    group.finish();
}

fn selections(c: &mut Criterion) {
    let n = n();
    let fx = bench::Fixture::new(n);
    let mut store = fx.rendered_store();
    let app = bench::BenchApp::new();
    app.set_store(fx.rendered_store());

    let tag_leaf = Selector::tag(3);
    let composite = Selector::all([Selector::tag(1), Selector::tag(2)]);
    // A page of ids narrowed by a field filter: the procedure engine's per-page gate.
    let page_and_has = Selector::all([
        Selector::Locations {
            locations: (1..=1000).map(Id::new).collect(),
            name: None,
        },
        Selector::has("panoId"),
    ]);

    let mut g = c.benchmark_group("selections");
    g.sample_size(20);
    g.throughput(Throughput::Elements(n as u64));
    g.bench_function(format!("{n}/resolve/tag"), |b| {
        b.iter(|| black_box(bench::resolve_selection(&mut store, &tag_leaf)));
    });
    g.bench_function(format!("{n}/resolve/intersection"), |b| {
        b.iter(|| black_box(bench::resolve_selection(&mut store, &composite)));
    });
    // The enrichment shape: a large uncommitted overlay must not tax an indexed resolve.
    let mut dirty = fx.rendered_store();
    bench::resolve_selection(&mut dirty, &tag_leaf);
    bench::write(&mut dirty, &fx.heading_updates(n / 2));
    g.bench_function(format!("{n}/resolve/tag_dirty_overlay"), |b| {
        b.iter(|| black_box(bench::resolve_selection(&mut dirty, &tag_leaf)));
    });
    g.bench_function(format!("{n}/resolve/page_and_has"), |b| {
        b.iter(|| black_box(bench::resolve_selection(&mut store, &page_and_has)));
    });

    for (name, selector) in [("tag", &tag_leaf), ("intersection", &composite)] {
        g.bench_function(format!("{n}/sync/{name}"), |b| {
            b.iter_batched(
                || app.edit_selections(Vec::new()),
                |_| black_box(app.edit_selections(vec![selector.clone()])),
                BatchSize::PerIteration,
            );
        });
    }
    g.finish();
}

fn scope_traversal(c: &mut Criterion) {
    let n = n();
    let fx = bench::Fixture::new(n);
    let store = fx.store();
    let sparse: Vec<u32> = (1..=100)
        .map(|i| ((i * n / 100).max(1).min(n)) as u32)
        .collect();
    let dense: Vec<u32> = (1..=n as u32).step_by(2).collect();

    let mut g = c.benchmark_group("scope_traversal");
    g.sample_size(20);
    for (name, ids) in [("sparse_100", sparse), ("dense_50pct", dense)] {
        g.throughput(Throughput::Elements(ids.len() as u64));
        let walk = bench::scope_walk(&store, ids);
        g.bench_function(format!("{n}/{name}"), |b| {
            b.iter(|| black_box(walk()));
        });
    }
    g.finish();
}

fn spatial_queries(c: &mut Criterion) {
    let n = n();
    let fx = bench::Fixture::new(n);
    let mut g = c.benchmark_group("spatial_build");
    g.sample_size(20);
    g.throughput(Throughput::Elements(n as u64));
    g.bench_function(n.to_string(), |b| {
        b.iter_batched(
            || fx.store(),
            |store| black_box(bench::build_spatial(&store)),
            BatchSize::SmallInput,
        );
    });
    g.finish();

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
    let added = adds(patch_count, 0x5A7E);
    let mut patched = fx.store();
    bench::write(&mut patched, &updates);
    let mut mixed = fx.store();
    bench::write(&mut mixed, &updates);
    bench::write(&mut mixed, &added);

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
    let tenth: Vec<Edit<Location>> = (1..=(n as u32 / 10))
        .map(|id| Op::Remove(Id::new(id)))
        .collect();
    let app = bench::BenchApp::new();

    let mut g = c.benchmark_group("remove_locations");
    g.sample_size(10);
    g.bench_function(format!("{n}/single"), |b| {
        b.iter_batched(
            || app.set_store(fx.store()),
            |()| black_box(app.edit(vec![Op::Remove(Id::new(n as u32 / 2))])),
            BatchSize::PerIteration,
        );
    });
    g.throughput(Throughput::Elements(tenth.len() as u64));
    g.bench_function(format!("{n}/bulk_10pct"), |b| {
        b.iter_batched(
            || app.set_store(fx.store()),
            |()| black_box(app.edit(tenth.clone())),
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
                app.edit(tenth.clone());
            },
            |()| black_box(app.undo()),
            BatchSize::PerIteration,
        );
    });
    g2.bench_function(format!("{n}/redo_delete_10pct"), |b| {
        b.iter_batched(
            || {
                app.set_store(fx.store());
                app.edit(tenth.clone());
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
                bench::write(&mut store, &updates);
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
                bench::write(&mut store, &updates);
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
    let added = adds(n / 10, 0xBA6E);

    let mut g = c.benchmark_group("bake_overlay");
    g.sample_size(10);
    g.throughput(Throughput::Elements(n as u64));
    g.bench_function(format!("{n}/patched_10pct_added_10pct"), |b| {
        b.iter_batched_ref(
            || {
                let mut store = fx.store();
                bench::write(&mut store, &updates);
                bench::write(&mut store, &added);
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
    // The real command, encode and send included -- the cost the app pays per scene load.
    g.bench_function(format!("{n}/full_build"), |b| {
        b.iter(|| black_box(app.subscribe_frames()));
    });
    // A 100-row edit on a rendered store: the frame path, which must not scale with n.
    g.bench_function(format!("{n}/delta_100"), |b| {
        b.iter_batched_ref(
            || fx.rendered_store(),
            |store| black_box(bench::write(store, &delta_updates)),
            BatchSize::PerIteration,
        );
    });
    let all_updates = fx.heading_updates(n);
    g.bench_function(format!("{n}/delta_{n}"), |b| {
        b.iter_batched_ref(
            || fx.rendered_store(),
            |store| black_box(bench::write(store, &all_updates)),
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
    // Arrow mmap + the O(N) aggregate scan.
    g.bench_function(format!("{n}/arrow_mmap_and_scan"), |b| {
        b.iter(|| black_box(bench::alive(&bench::open_from_arrow(&path, &fx))));
    });
    g.bench_function(format!("{n}/scan_aggregates"), |b| {
        b.iter_batched_ref(
            || fx.store(),
            |store| black_box(bench::scan(store)),
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
    overlay,
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
