// The whole-app performance suite. Every case is one user-meaningful operation at a
// stated scale, drawn from the hot/cold path list in CLAUDE.md, sampled through the
// benchmark harness and written to test/perf/results as versioned JSON. Nothing here
// asserts a time budget: benches report, `compare.ts` decides what moved.
//
// Excluded from the default e2e suite. Run it with:
//   bash scripts/e2e.sh --bench
//   MMA_BENCH_SCALES=2000 MMA_BENCH_SAMPLES=1 bash scripts/e2e.sh --bench   # smoke
//
// Knobs: MMA_BENCH_SCALES, MMA_BENCH_SAMPLES, MMA_BENCH_WARMUPS, MMA_BENCH_ROUTES,
// MMA_BENCH_GPU, MMA_BENCH_SEED, MMA_BENCH_REVISION, MMA_BENCH_LABEL.
//
// Docker absolute-number caveat: ops whose awaited path rebuilds render state
// (the remove/undo-delete family) pay ~1s of llvmpipe CPU rasterization in the
// container vs ~10-40ms native at the same scale. Docker numbers are valid for
// A/B between builds (both sides pay the tax), never as absolute latency
// claims; measure absolutes with a native run of the same routes.

import type { ExportOpts } from "@/bindings.gen";
import {
	collectEnvironment,
	runBenchmark,
	writeBenchmarkReport,
	writeFixture,
	type BenchmarkCase,
	type BenchmarkReport,
	type RunBenchmarkOptions,
} from "../perf/benchmarkHarness.ts";
import { waitForReady, withApi } from "./helpers";

/** Every case route, mapped to the category half of its stable id. */
const ROUTES: Record<string, string> = {
	"app-idle": "idle",
	"map-idle": "idle",
	import: "import",
	"open-map": "navigation",
	"close-map": "navigation",
	"activate-location": "interaction",
	"add-location": "mutation",
	"bulk-add": "mutation",
	"update-location": "mutation",
	"bulk-update": "mutation",
	"remove-location": "mutation",
	"delete-tagged": "mutation",
	"remove-all": "mutation",
	autosave: "persistence",
	commit: "persistence",
	"select-all": "selection",
	"select-tag": "selection",
	"select-untagged": "selection",
	"select-panoids": "selection",
	"select-notpanoids": "selection",
	"select-unpanned": "selection",
	"select-duplicates": "selection",
	"select-intersection": "selection",
	"select-union": "selection",
	"select-invert": "selection",
	"edit-while-selected": "selection",
	"undo-delete": "history",
	"redo-delete": "history",
	"render-fill": "render",
	"export-json": "export",
	// Frame-rate scenarios: only meaningful on a real GPU, so opt in with MMA_BENCH_GPU=1.
	"render-idle": "render",
	"render-pan-dense": "render",
	"render-pan-wide": "render",
	"render-zoom-sweep": "render",
};

const GPU_ROUTES = ["render-idle", "render-pan-dense", "render-pan-wide", "render-zoom-sweep"];

/** Marker configurations the GPU scenarios sweep; used as the `scale` half of the id. */
const GPU_MATRIX: { style: "pin" | "circle"; size: number }[] = [
	{ style: "pin", size: 1 },
	{ style: "pin", size: 2 },
	{ style: "circle", size: 1 },
	{ style: "circle", size: 2 },
];
const GPU_SCALE = 1_000_000;
const GPU_CLUSTER = { lat: 47, lng: 2, latSpan: 1.2, lngSpan: 1.8 };

const IDLE_WINDOW_MS = 1_000;
const SCENE_TIMEOUT_MS = 180_000;
const SCALE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** A measured block runs entirely in-page, and an import at scale takes far longer than
 *  the suite's default 20s WebDriver request budget. Raised for this spec only. */
const SCRIPT_TIMEOUT_MS = 30 * 60 * 1000;

function parseInteger(name: string, fallback: number, minimum: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`${name} must be an integer >= ${minimum}, got ${raw}`);
	}
	return value;
}

function parseScales(): number[] {
	const raw = process.env.MMA_BENCH_SCALES ?? "1000,200000";
	const scales = [...new Set(raw.split(",").map((part) => Number(part.trim())))];
	if (scales.length === 0 || scales.some((s) => !Number.isSafeInteger(s) || s <= 0)) {
		throw new Error(`MMA_BENCH_SCALES must be positive integers, got ${raw}`);
	}
	return scales;
}

function parseRouteFilter(): Set<string> | null {
	const raw = process.env.MMA_BENCH_ROUTES;
	if (!raw?.trim()) return null;
	const requested = raw
		.split(",")
		.map((route) => route.trim())
		.filter(Boolean);
	const unknown = requested.filter((route) => !(route in ROUTES));
	if (unknown.length > 0) throw new Error(`Unknown MMA_BENCH_ROUTES: ${unknown.join(", ")}`);
	return new Set(requested);
}

const SCALES = parseScales();
const ITERATIONS = parseInteger("MMA_BENCH_SAMPLES", 5, 1);
const WARMUPS = parseInteger("MMA_BENCH_WARMUPS", 1, 0);
const ROUTE_FILTER = parseRouteFilter();
const GPU_ENABLED = process.env.MMA_BENCH_GPU === "1";

function enabled(route: string): boolean {
	if (GPU_ROUTES.includes(route) && !GPU_ENABLED) return false;
	return ROUTE_FILTER === null || ROUTE_FILTER.has(route);
}

const cases: BenchmarkCase[] = [];
const failures: string[] = [];
// A mocha timeout aborts a test without running its catch, leaving `failures`
// empty; the report is complete only if every started block also finished.
let startedBlocks = 0;
let finishedBlocks = 0;
const ownedMapIds = new Set<string>();

// --- Map lifecycle (node side) ---

/** Poll from the node side: each in-page call is short, so a scene that never settles
 *  surfaces as a readable failure instead of a WebDriver request timeout. */
async function waitForScene(minimumMarkers: number): Promise<number> {
	let last = -1;
	try {
		await browser.waitUntil(
			async () => {
				last = await withApi(async () => {
					const perf = window.__mmaPerf;
					if (!perf) return -1;
					await Promise.race([
						perf.settled(),
						new Promise<void>((resolve) => setTimeout(resolve, 1000)),
					]);
					if (!document.querySelector(".page-map-editor")) return -2;
					return perf.render()?.totalMarkers ?? -3;
				});
				return last >= minimumMarkers;
			},
			{ timeout: SCENE_TIMEOUT_MS, interval: 200 },
		);
	} catch {
		throw new Error(`scene never reached ${minimumMarkers} markers (last reading ${last})`);
	}
	return last;
}

async function createOpenMap(name: string): Promise<string> {
	const id = await withApi(async (api, mapName) => {
		const map = await api.cmd.storeCreateMap(mapName, null);
		await api._test.openMap(map.id);
		return map.id;
	}, name);
	ownedMapIds.add(id);
	await waitForScene(0);
	return id;
}

async function ensureOpen(mapId: string, minimumMarkers: number): Promise<void> {
	await withApi(async (api, id) => {
		if (api.getMapState().mapId !== id) await api._test.openMap(id);
	}, mapId);
	await waitForScene(minimumMarkers);
}

async function closeIfOpen(): Promise<void> {
	await withApi(async (api) => {
		if (api.getMapState().mapId != null) await api._test.closeMap();
	});
}

async function deleteOwnedMap(mapId: string): Promise<void> {
	await withApi(async (api, id) => {
		if (api.getMapState().mapId === id) await api._test.closeMap();
		await api.cmd.storeDeleteMap(id);
	}, mapId);
	ownedMapIds.delete(mapId);
}

async function cleanupMaps(ids: Iterable<string>): Promise<void> {
	for (const id of [...ids]) {
		try {
			await deleteOwnedMap(id);
		} catch (error) {
			failures.push(`cleanup ${id}: ${(error as Error).message}`);
		}
	}
}

/** Rewind every uncommitted edit this case made, back to the committed baseline.
 *  Every mutating case starts from a committed map, so `canUndo` is the exact
 *  "we changed something" flag and unwinding it restores the fixture. */
async function unwind(mapId: string, minimumMarkers: number): Promise<void> {
	// Open with no marker floor: a previous sample may have emptied the map, and the
	// rows only come back once the undos below have replayed.
	await ensureOpen(mapId, 0);
	await withApi(async (api) => {
		await api.setActiveLocation(null);
		for (let guard = 0; guard < 16 && api.getMapState().canUndo; guard += 1) await api.undo();
		api.cancelAutosave();
		if (api.getMapState().canUndo) throw new Error("unwind did not reach the committed baseline");
	});
	await waitForScene(minimumMarkers);
}

/** Commit anything outstanding so the next case's `unwind` has a clean floor. */
async function settleBaseline(message: string): Promise<void> {
	await withApi(async (api, msg) => {
		api.cancelAutosave();
		await api.waitForInflightPersist();
		if ((await api.cmd.storeGetSummary()).dirtyCount > 0) await api.commitMap(msg);
	}, message);
}

// --- Case runner ---

type CaseOptions = Omit<RunBenchmarkOptions, "route" | "category" | "scale">;

async function bench(
	route: string,
	scale: string | number,
	options: Omit<CaseOptions, "iterations" | "warmupIterations">,
	iterations = ITERATIONS,
	warmupIterations = WARMUPS,
): Promise<void> {
	if (!enabled(route)) return;
	const result = await runBenchmark({
		route,
		category: ROUTES[route],
		scale,
		iterations,
		warmupIterations,
		...options,
	});
	cases.push(result);
	const operation = result.operation ? `${result.operation.median.toFixed(1)}ms` : "n/a";
	const pss = result.telemetry.peakPssBytes.median;
	process.stdout.write(
		`[bench] ${result.id}: op=${operation} settled=${result.duration.median.toFixed(1)}ms ` +
			`mad=${result.duration.mad.toFixed(1)}ms pss=${pss == null ? "n/a" : `${(pss / 1048576).toFixed(0)}MiB`}\n`,
	);
}

// --- Suite ---

describe("Performance benchmarks", () => {
	before(async function () {
		this.timeout(120_000);
		await browser.setTimeout({ script: SCRIPT_TIMEOUT_MS });
		await waitForReady();
	});

	after(async function () {
		this.timeout(600_000);
		await cleanupMaps(ownedMapIds).catch(() => {});
		if (cases.length === 0) return;
		const report: BenchmarkReport = {
			schemaVersion: 2,
			generatedAt: new Date().toISOString(),
			complete: failures.length === 0 && startedBlocks === finishedBlocks,
			failures,
			environment: collectEnvironment(SCALES, ITERATIONS, WARMUPS),
			cases,
		};
		await writeBenchmarkReport(report);
	});

	it("app-idle", async function () {
		this.timeout(300_000);
		await bench("app-idle", 0, {
			setup: closeIfOpen,
			run: () =>
				withApi(async (api, idleMs) => {
					if (api.getMapState().mapId != null) throw new Error("map list is not idle");
					const start = performance.now();
					while (performance.now() - start < idleMs) {
						await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
					}
					return performance.now() - start;
				}, IDLE_WINDOW_MS),
		});
	});

	for (const scale of SCALES) {
		it(`scale ${scale}`, async function () {
			this.timeout(SCALE_TIMEOUT_MS);
			const scaleMaps = new Set<string>();
			startedBlocks += 1;
			try {
				await runScale(scale, scaleMaps);
				finishedBlocks += 1;
			} catch (error) {
				failures.push(`scale ${scale}: ${(error as Error).message}`);
				throw error;
			} finally {
				await cleanupMaps(scaleMaps);
			}
		});
	}

	if (GPU_ENABLED) {
		it("gpu render scenarios", async function () {
			this.timeout(SCALE_TIMEOUT_MS);
			const gpuMaps = new Set<string>();
			startedBlocks += 1;
			try {
				await runGpuScenarios(gpuMaps);
				finishedBlocks += 1;
			} catch (error) {
				failures.push(`gpu: ${(error as Error).message}`);
				throw error;
			} finally {
				await cleanupMaps(gpuMaps);
			}
		});
	}
});

// --- Scale block ---

async function runScale(scale: number, scaleMaps: Set<string>): Promise<void> {
	// Own fixture and own map: the enrichment rows carry a datetime and no panoId.
	if (!Object.keys(ROUTES).some((r) => r !== "app-idle" && enabled(r))) return;

	const fixture = await writeFixture(scale);

	// import: fresh map per sample, so each one measures a cold import.
	let importMapId: string | null = null;
	await bench("import", scale, {
		setup: async () => {
			if (importMapId) {
				await deleteOwnedMap(importMapId);
				scaleMaps.delete(importMapId);
			}
			importMapId = await createOpenMap(`Bench import ${scale} ${Date.now()}`);
			scaleMaps.add(importMapId);
		},
		run: () =>
			withApi(
				async (api, path, target) => {
					const perf = window.__mmaPerf!;
					const start = performance.now();
					await api.beginImportFromPath(path);
					const result = await api.confirmImport([], undefined);
					if (!result) throw new Error("import returned no result");
					await api.waitForInflightPersist();
					await perf.settled();
					const operationMs = performance.now() - start;
					await new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					);
					if (result.importedCount !== target) {
						throw new Error(`imported ${result.importedCount}, expected ${target}`);
					}
					return { durationMs: performance.now() - start, operationMs };
				},
				fixture,
				scale,
			),
	});
	if (importMapId) {
		await deleteOwnedMap(importMapId);
		scaleMaps.delete(importMapId);
	}

	const remaining = Object.keys(ROUTES).filter((r) => r !== "app-idle" && r !== "import");
	if (!remaining.some(enabled)) return;

	// Shared fixture map for every other case at this scale.
	const mapId = await createOpenMap(`Bench fixture ${scale} ${Date.now()}`);
	scaleMaps.add(mapId);
	const fixtureInfo = await withApi(
		async (api, path, target) => {
			await api.beginImportFromPath(path);
			const result = await api.confirmImport([], undefined);
			if (!result || result.importedCount !== target) {
				throw new Error(
					`fixture import produced ${result?.importedCount ?? 0}, expected ${target}`,
				);
			}
			await api.waitForInflightPersist();
			// Two off-fixture helper rows the single-row mutation cases operate on.
			const helpers = [
				api.createLocation({ lat: 84.75, lng: 179.75, heading: 10, panoId: null }),
				api.createLocation({ lat: -84.75, lng: -179.75, heading: 20, panoId: null }),
			];
			await api.addLocations(helpers);
			if (helpers.some((h) => h.id <= 0)) throw new Error("helper rows got no ids");
			await api.commitMap(`Bench fixture ${target}`);
			await api.waitForInflightPersist();
			const tag = Object.values(api.getMapState().tags).find((t) => t.name === "benchmark-tag");
			if (!tag) throw new Error("fixture is missing the benchmark-tag");
			return { tagId: tag.id, helperIds: helpers.map((h) => h.id) };
		},
		fixture,
		scale,
	);
	const { tagId } = fixtureInfo;
	const [helperA, helperB] = fixtureInfo.helperIds;
	const baseline = scale + fixtureInfo.helperIds.length;
	// Scene readiness is a floor, not an equality: the renderer bins by cell, so the two
	// off-fixture helper rows need not show up in `totalMarkers`.
	const sceneFloor = scale;
	await waitForScene(sceneFloor);

	const bulkAddCount = Math.min(scale, 50_000);

	// --- navigation ---

	await bench("open-map", scale, {
		setup: closeIfOpen,
		run: () =>
			withApi(
				async (api, id, target, timeoutMs) => {
					const perf = window.__mmaPerf!;
					const start = performance.now();
					await api._test.openMap(id);
					const operationMs = performance.now() - start;
					const deadline = performance.now() + timeoutMs;
					for (;;) {
						await perf.settled();
						const total = perf.render()?.totalMarkers ?? 0;
						if (document.querySelector(".page-map-editor") && total >= target) break;
						if (performance.now() >= deadline) throw new Error(`open never rendered ${target}`);
						await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
					}
					await new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					);
					return { durationMs: performance.now() - start, operationMs };
				},
				mapId,
				sceneFloor,
				SCENE_TIMEOUT_MS,
			),
	});

	await bench("close-map", scale, {
		setup: () => ensureOpen(mapId, sceneFloor),
		run: () =>
			withApi(async (api) => {
				const start = performance.now();
				await api._test.closeMap();
				const operationMs = performance.now() - start;
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				);
				if (api.getMapState().mapId != null) throw new Error("map did not close");
				return { durationMs: performance.now() - start, operationMs };
			}),
	});

	await bench("map-idle", scale, {
		setup: () => ensureOpen(mapId, sceneFloor),
		run: () =>
			withApi(async (_api, idleMs) => {
				await window.__mmaPerf!.settled();
				const start = performance.now();
				while (performance.now() - start < idleMs) {
					await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
				}
				return performance.now() - start;
			}, IDLE_WINDOW_MS),
	});

	// --- interaction ---

	await bench("activate-location", scale, {
		setup: async () => {
			await ensureOpen(mapId, sceneFloor);
			await withApi(async (api, id) => api.setActiveLocation(id, false), helperA);
		},
		run: () =>
			withApi(async (api, id) => {
				const start = performance.now();
				await api.setActiveLocation(id, false);
				const operationMs = performance.now() - start;
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				);
				if (api.getMapState().activeLocation?.id !== id) throw new Error(`not active: ${id}`);
				return { durationMs: performance.now() - start, operationMs };
			}, helperB),
	});

	// --- render pipeline ---

	await bench("render-fill", scale, {
		setup: () => ensureOpen(mapId, sceneFloor),
		run: () =>
			withApi(async (api) => {
				const start = performance.now();
				const path = await api.cmd.storeFillRenderFile({
					west: -180,
					south: -90,
					east: 180,
					north: 90,
					markerStyle: "pin",
				});
				const filled = performance.now();
				const bytes = (await (await fetch(api.mmaBufUrl(path))).arrayBuffer()).byteLength;
				const done = performance.now();
				return {
					durationMs: done - start,
					operationMs: filled - start,
					metrics: { fetchMs: done - filled, bytes },
				};
			}),
	});

	// --- selection ---

	const selectionCase = (
		route: string,
		selector: Record<string, unknown>,
		minimumSelected: number,
	) =>
		bench(route, scale, {
			setup: async () => {
				await ensureOpen(mapId, sceneFloor);
				await withApi(async (api) => api.resetSelections());
			},
			run: () =>
				withApi(
					async (api, selectionProps, minimum) => {
						const start = performance.now();
						// eslint-disable-next-line @typescript-eslint/no-explicit-any -- props are passed as plain JSON across the bridge
						await api.addSelections([selectionProps as any]);
						const operationMs = performance.now() - start;
						await new Promise<void>((resolve) =>
							requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
						);
						const selected = api.getMapState().selectedLocationIds.size;
						if (selected < minimum) throw new Error(`selected ${selected}, expected >= ${minimum}`);
						return {
							durationMs: performance.now() - start,
							operationMs,
							metrics: { selected },
						};
					},
					selector,
					minimumSelected,
				),
		});

	await selectionCase("select-all", { type: "Everything" }, baseline);
	await selectionCase("select-tag", { type: "Tag", tagId }, 1);
	await selectionCase("select-untagged", { type: "Untagged" }, 1);
	await selectionCase("select-panoids", { type: "PanoIds" }, 1);
	await selectionCase("select-notpanoids", { type: "NotPanoIds" }, 1);
	await selectionCase("select-unpanned", { type: "Unpanned" }, 1);
	await selectionCase("select-duplicates", { type: "Duplicates", distance: 1 }, 0);

	// Composites: two resolved leaves combined by a native set operation.
	const compositeCase = (route: string, operation: "intersection" | "union" | "invert") =>
		bench(route, scale, {
			setup: async () => {
				await ensureOpen(mapId, sceneFloor);
				await withApi(
					async (api, id, op) => {
						await api.resetSelections();
						await api.addSelections([{ type: "PanoIds" }]);
						if (op !== "invert") await api.addSelections([{ type: "Tag", tagId: id }]);
					},
					tagId,
					operation,
				);
			},
			run: () =>
				withApi(async (api, op) => {
					const start = performance.now();
					if (op === "intersection") await api.applySelectionUpdate(api.intersectSelections());
					else if (op === "union") await api.applySelectionUpdate(api.unionSelections());
					else await api.applySelectionUpdate(api.invertSelections());
					const operationMs = performance.now() - start;
					await new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					);
					return { durationMs: performance.now() - start, operationMs };
				}, operation),
		});

	await compositeCase("select-intersection", "intersection");
	await compositeCase("select-union", "union");
	await compositeCase("select-invert", "invert");

	// The "edit while a large selection is active" path: one add re-syncs the
	// affected cell but scans the whole selection overlay.
	await bench("edit-while-selected", scale, {
		setup: async () => {
			await unwind(mapId, sceneFloor);
			await withApi(async (api) => {
				await api.resetSelections();
				await api.addSelections([{ type: "Everything" }]);
			});
		},
		run: () =>
			withApi(async (api) => {
				const location = api.createLocation({ lat: 12.3456, lng: 65.4321, heading: 5 });
				const start = performance.now();
				await api.addLocations([location]);
				const operationMs = performance.now() - start;
				api.cancelAutosave();
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				);
				return { durationMs: performance.now() - start, operationMs };
			}),
	});
	await unwind(mapId, sceneFloor);
	await withApi(async (api) => api.resetSelections());

	// --- mutation ---

	await bench("add-location", scale, {
		setup: () => unwind(mapId, sceneFloor),
		run: () =>
			withApi(async (api, target) => {
				const location = api.createLocation({ lat: 83.5, lng: 178.5, heading: 30 });
				const start = performance.now();
				await api.addLocations([location]);
				const operationMs = performance.now() - start;
				api.cancelAutosave();
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				);
				const count = (await api.cmd.storeGetSummary()).locationCount;
				if (location.id <= 0 || count !== target + 1) {
					throw new Error(`add gave id=${location.id} count=${count}, expected ${target + 1}`);
				}
				return { durationMs: performance.now() - start, operationMs };
			}, baseline),
	});

	await bench("bulk-add", bulkAddCount, {
		setup: () => unwind(mapId, sceneFloor),
		run: () =>
			withApi(
				async (api, count, target) => {
					const locations = Array.from({ length: count }, (_, i) =>
						api.createLocation({ lat: -60 + (i % 100) * 0.01, lng: 120 + (i % 97) * 0.01 }),
					);
					const start = performance.now();
					await api.addLocations(locations);
					const operationMs = performance.now() - start;
					api.cancelAutosave();
					await new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					);
					const total = (await api.cmd.storeGetSummary()).locationCount;
					if (total !== target + count)
						throw new Error(`bulk add left ${total}, expected ${target + count}`);
					return { durationMs: performance.now() - start, operationMs };
				},
				bulkAddCount,
				baseline,
			),
	});

	await bench("update-location", scale, {
		setup: () => unwind(mapId, sceneFloor),
		run: () =>
			withApi(async (api, id) => {
				const start = performance.now();
				await api.updateLocations([{ id, patch: { heading: 11 } }]);
				const operationMs = performance.now() - start;
				api.cancelAutosave();
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				);
				const [loc] = await api.fetchLocations({ type: "Locations", locations: [id], name: null });
				if (loc?.heading !== 11) throw new Error(`location ${id} was not updated`);
				return { durationMs: performance.now() - start, operationMs };
			}, helperA),
	});

	await bench("bulk-update", scale, {
		setup: () => unwind(mapId, sceneFloor),
		run: () =>
			withApi(async (api) => {
				const ids = await api.resolveIds({ type: "Everything" });
				const updates = ids.map((id) => ({ id, patch: { pitch: 0.25 } }));
				const start = performance.now();
				await api.updateLocations(updates);
				const operationMs = performance.now() - start;
				api.cancelAutosave();
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				);
				return {
					durationMs: performance.now() - start,
					operationMs,
					metrics: { rows: ids.length },
				};
			}),
	});

	await bench("remove-location", scale, {
		setup: () => unwind(mapId, sceneFloor),
		run: () =>
			withApi(
				async (api, id, target) => {
					const start = performance.now();
					await api.removeLocations(new Set([id]));
					const operationMs = performance.now() - start;
					api.cancelAutosave();
					await new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
					);
					const count = (await api.cmd.storeGetSummary()).locationCount;
					if (count !== target - 1) throw new Error(`remove left ${count}, expected ${target - 1}`);
					return { durationMs: performance.now() - start, operationMs };
				},
				helperB,
				baseline,
			),
	});

	await bench("delete-tagged", scale, {
		setup: async () => {
			await unwind(mapId, sceneFloor);
			await withApi(async (api, id) => {
				await api.resetSelections();
				await api.addSelections([{ type: "Tag", tagId: id }]);
				if (api.getMapState().selectedLocationIds.size === 0) {
					throw new Error("delete setup selected nothing");
				}
			}, tagId);
		},
		run: () =>
			withApi(async (api, target) => {
				const ids = api.getMapState().selectedLocationIds;
				const removed = ids.size;
				const start = performance.now();
				await api.removeLocations(ids);
				const operationMs = performance.now() - start;
				api.cancelAutosave();
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				);
				const count = (await api.cmd.storeGetSummary()).locationCount;
				if (count !== target - removed) {
					throw new Error(`delete left ${count}, expected ${target - removed}`);
				}
				return { durationMs: performance.now() - start, operationMs, metrics: { removed } };
			}, baseline),
	});

	await bench("remove-all", scale, {
		setup: () => unwind(mapId, sceneFloor),
		run: () =>
			withApi(async (api) => {
				const ids = new Set(await api.resolveIds({ type: "Everything" }));
				const start = performance.now();
				await api.removeLocations(ids);
				const operationMs = performance.now() - start;
				api.cancelAutosave();
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				);
				const count = (await api.cmd.storeGetSummary()).locationCount;
				if (count !== 0) throw new Error(`remove-all left ${count} locations`);
				return { durationMs: performance.now() - start, operationMs, metrics: { rows: ids.size } };
			}),
	});

	// --- history ---

	await bench("undo-delete", scale, {
		setup: async () => {
			await unwind(mapId, sceneFloor);
			await withApi(async (api, id) => {
				await api.resetSelections();
				await api.addSelections([{ type: "Tag", tagId: id }]);
				await api.removeLocations(api.getMapState().selectedLocationIds);
				api.cancelAutosave();
				if (!api.getMapState().canUndo) throw new Error("bulk delete is not undoable");
			}, tagId);
		},
		run: () =>
			withApi(async (api, target) => {
				const start = performance.now();
				await api.undo();
				const operationMs = performance.now() - start;
				api.cancelAutosave();
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				);
				const count = (await api.cmd.storeGetSummary()).locationCount;
				if (count !== target) throw new Error(`undo restored ${count}, expected ${target}`);
				return { durationMs: performance.now() - start, operationMs };
			}, baseline),
	});

	await bench("redo-delete", scale, {
		setup: async () => {
			await unwind(mapId, sceneFloor);
			await withApi(async (api, id) => {
				await api.resetSelections();
				await api.addSelections([{ type: "Tag", tagId: id }]);
				await api.removeLocations(api.getMapState().selectedLocationIds);
				await api.undo();
				api.cancelAutosave();
				if (!api.getMapState().canRedo) throw new Error("bulk delete is not redoable");
			}, tagId);
		},
		run: () =>
			withApi(async (api, target) => {
				const start = performance.now();
				await api.redo();
				const operationMs = performance.now() - start;
				api.cancelAutosave();
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				);
				const count = (await api.cmd.storeGetSummary()).locationCount;
				if (count >= target) throw new Error(`redo left ${count} of ${target}`);
				return { durationMs: performance.now() - start, operationMs };
			}, baseline),
	});
	await unwind(mapId, sceneFloor);
	await withApi(async (api) => api.resetSelections());

	// --- persistence ---

	await bench("autosave", scale, {
		setup: async () => {
			await ensureOpen(mapId, sceneFloor);
			await withApi(async (api, id) => {
				const [loc] = await api.fetchLocations({ type: "Locations", locations: [id], name: null });
				if (!loc) throw new Error(`autosave helper ${id} is missing`);
				await api.updateLocations([{ id, patch: { heading: (loc.heading + 1) % 360 } }]);
				api.cancelAutosave();
			}, helperA);
		},
		run: () =>
			withApi(async (api) => {
				const start = performance.now();
				await api.flushSave();
				await api.waitForInflightPersist();
				const durationMs = performance.now() - start;
				return { durationMs, operationMs: durationMs };
			}),
	});

	await bench("commit", scale, {
		setup: async () => {
			await ensureOpen(mapId, sceneFloor);
			await withApi(async (api, id) => {
				api.cancelAutosave();
				await api.waitForInflightPersist();
				if ((await api.cmd.storeGetSummary()).dirtyCount > 0) await api.commitMap("Bench setup");
				const [loc] = await api.fetchLocations({ type: "Locations", locations: [id], name: null });
				if (!loc) throw new Error(`commit helper ${id} is missing`);
				await api.updateLocations([{ id, patch: { pitch: (loc.pitch ?? 0) + 0.25 } }]);
				api.cancelAutosave();
			}, helperB);
		},
		run: () =>
			withApi(async (api) => {
				const start = performance.now();
				const commitId = await api.commitMap("Bench one-row update");
				const durationMs = performance.now() - start;
				const summary = await api.cmd.storeGetSummary();
				if (!commitId || summary.dirtyCount !== 0) {
					throw new Error(`commit failed: id=${commitId} dirty=${summary.dirtyCount}`);
				}
				return { durationMs, operationMs: durationMs };
			}),
	});

	await settleBaseline("Bench post-persistence");

	// --- export ---

	await bench("export-json", scale, {
		setup: () => ensureOpen(mapId, sceneFloor),
		run: () =>
			withApi(async (api) => {
				const map = api.getMapState().map;
				if (!map) throw new Error("no map open for export");
				const options: ExportOpts = {
					exportZoom: true,
					exportUnpanned: true,
					exportExtras: true,
					selector: { type: "Everything" },
					mapName: map.name,
					tagsJson: JSON.stringify(api.getMapState().tags),
					extraFieldsJson: map.extra?.fields ? JSON.stringify(map.extra.fields) : null,
				};
				const start = performance.now();
				const path = await api.cmd.storeExportJson(options);
				const durationMs = performance.now() - start;
				if (!path) throw new Error("export returned no path");
				return { durationMs, operationMs: durationMs, cleanupPath: path };
			}),
	});
}

// --- Enrichment (opt-in, build-agnostic) ---

/** Sun-position enrichment over the whole map: pure compute, no network. */
// --- GPU frame-rate scenarios (opt-in, local GPU only) ---

async function runGpuScenarios(gpuMaps: Set<string>): Promise<void> {
	const fixture = await writeFixture(GPU_SCALE, GPU_CLUSTER);
	const mapId = await createOpenMap(`Bench render ${Date.now()}`);
	gpuMaps.add(mapId);
	await withApi(
		async (api, path, target) => {
			await api.beginImportFromPath(path);
			const result = await api.confirmImport([], undefined);
			if (!result || result.importedCount !== target) {
				throw new Error(`render fixture imported ${result?.importedCount ?? 0}`);
			}
			await api.waitForInflightPersist();
		},
		fixture,
		GPU_SCALE,
	);
	await waitForScene(GPU_SCALE);

	for (const { style, size } of GPU_MATRIX) {
		const variant = `${style}-x${size}`;
		await withApi(
			async (_api, markerStyle, markerSize) => {
				const perf = window.__mmaPerf!;
				perf.setMarkerStyle(markerStyle);
				perf.setMarkerSize(markerSize);
				// The style change reloads the scene through a React effect; let it start.
				await new Promise<void>((resolve) => setTimeout(resolve, 300));
				await perf.settled();
			},
			style,
			size,
		);
		await waitForScene(GPU_SCALE);

		for (const kind of GPU_ROUTES) {
			await bench(kind, variant, {
				run: () =>
					withApi(async (_api, scenario) => {
						const perf = window.__mmaPerf!;
						const host = perf.host();
						if (!host) throw new Error("no map host");
						const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
						if (scenario === "render-zoom-sweep") {
							host.moveCamera({ center: { lat: 47.6, lng: 2.9 }, zoom: 13 });
						} else if (scenario === "render-pan-dense") {
							host.moveCamera({ center: { lat: 47.2, lng: 2.2 }, zoom: 11 });
						} else if (scenario === "render-pan-wide") {
							host.moveCamera({ center: { lat: 47.5, lng: 2.7 }, zoom: 8 });
						} else {
							host.moveCamera({ center: { lat: 47.6, lng: 2.9 }, zoom: 10 });
						}
						await sleep(800);

						// gl.finish() per frame: without it the rAF deltas stay near vsync
						// while the GPU queues frames deep, and the numbers lie.
						perf.probe(true);
						perf.start();
						perf.reset();
						const start = performance.now();
						if (scenario === "render-idle") {
							await sleep(2000);
						} else if (scenario === "render-pan-dense") {
							for (let i = 0; i < 100; i++) {
								host.moveCamera({ center: { lat: 47.2 + i * 0.008, lng: 2.2 + i * 0.014 } });
								await sleep(33);
							}
						} else if (scenario === "render-pan-wide") {
							for (let i = 0; i < 100; i++) {
								host.moveCamera({
									center: { lat: 47.5 + Math.sin(i / 12) * 0.15, lng: 2.7 + i * 0.004 },
								});
								await sleep(33);
							}
						} else {
							for (let z = 13; z >= 5; z -= 0.5) {
								host.moveCamera({ zoom: z });
								await sleep(200);
							}
						}
						const durationMs = performance.now() - start;
						const frames = perf.frames();
						const deck = perf.deck();
						const render = perf.render();
						perf.probe(false);
						perf.stop();
						if (frames.frames <= 0) throw new Error(`${scenario} metered no frames`);
						return {
							durationMs,
							metrics: {
								fps: frames.fps,
								frameP50: frames.p50,
								frameP95: frames.p95,
								frameWorst: frames.worst,
								longTasks: frames.longTasks,
								...(deck ? { cpuPerFrame: deck.cpuTimePerFrame } : {}),
								...(render ? { overdraw: render.overdraw, onScreen: render.onScreenMarkers } : {}),
							},
						};
					}, kind),
			});
		}
	}
}
