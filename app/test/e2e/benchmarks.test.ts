/* eslint-disable no-console */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	flushAndWait,
	createTag,
	withApi,
} from "./helpers";
import type { Location } from "@/types";

const ITERATIONS = 3;

interface BenchResult {
	name: string;
	times: number[];
	avg: number;
	min: number;
	max: number;
	p95: number;
}

function computeStats(name: string, times: number[]): BenchResult {
	const sorted = [...times].sort((a, b) => a - b);
	const avg = times.reduce((a, b) => a + b, 0) / times.length;
	const p95Index = Math.ceil(sorted.length * 0.95) - 1;
	return {
		name,
		times: sorted,
		avg: Math.round(avg),
		min: Math.round(sorted[0]),
		max: Math.round(sorted[sorted.length - 1]),
		p95: Math.round(sorted[p95Index]),
	};
}

function report(result: BenchResult) {
	console.log(
		`  [BENCH] ${result.name}: avg=${result.avg}ms min=${result.min}ms max=${result.max}ms p95=${result.p95}ms (${result.times.length} runs)`,
	);
}

describe("Benchmarks - addLocations", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
	});

	afterEach(async () => {
		await closeMap();
		if (mapId) await deleteMap(mapId);
	});

	it("add 1K locations", async () => {
		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			mapId = await createAndOpenMap(`Bench Add 1K #${iter}`);
			const ms = await withApi(async (api) => {
				const locs: Location[] = [];
				for (let i = 0; i < 1000; i++) {
					locs.push(api.createLocation({
						lat: Math.random() * 170 - 85,
						lng: Math.random() * 360 - 180,
						heading: Math.random() * 360,
						zoom: 1,
					}));
				}
				const t0 = performance.now();
				await api.addLocations(locs);
				return performance.now() - t0;
			});
			times.push(ms);
			await closeMap();
			await deleteMap(mapId);
		}
		const stats = computeStats("addLocations(1K)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(500);
	});

	it("add 10K locations", async () => {
		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			mapId = await createAndOpenMap(`Bench Add 10K #${iter}`);
			const ms = await withApi(async (api) => {
				const locs: Location[] = [];
				for (let i = 0; i < 10000; i++) {
					locs.push(api.createLocation({
						lat: Math.random() * 170 - 85,
						lng: Math.random() * 360 - 180,
						heading: Math.random() * 360,
						zoom: 1,
					}));
				}
				const t0 = performance.now();
				await api.addLocations(locs);
				return performance.now() - t0;
			});
			times.push(ms);
			await closeMap();
			await deleteMap(mapId);
		}
		const stats = computeStats("addLocations(10K)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(2000);
	});

	it("add 100K locations", async () => {
		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			mapId = await createAndOpenMap(`Bench Add 100K #${iter}`);
			const ms = await withApi(async (api) => {
				const locs: Location[] = [];
				for (let i = 0; i < 100000; i++) {
					locs.push(api.createLocation({
						lat: Math.random() * 170 - 85,
						lng: Math.random() * 360 - 180,
						heading: Math.random() * 360,
						zoom: 1,
					}));
				}
				const t0 = performance.now();
				await api.addLocations(locs);
				return performance.now() - t0;
			});
			times.push(ms);
			await closeMap();
			await deleteMap(mapId);
		}
		const stats = computeStats("addLocations(100K)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(10000);
	});
});

describe("Benchmarks - save", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
	});

	afterEach(async () => {
		await closeMap();
		if (mapId) await deleteMap(mapId);
	});

	it("save 1K locations", async () => {
		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			mapId = await createAndOpenMap(`Bench Save 1K #${iter}`);
			await withApi(async (api) => {
				const locs: Location[] = [];
				for (let i = 0; i < 1000; i++) {
					locs.push(api.createLocation({
						lat: Math.random() * 170 - 85,
						lng: Math.random() * 360 - 180,
						zoom: 1,
					}));
				}
				await api.addLocations(locs);
				return "ok";
			});

			const ms = await withApi(async (api) => {
				const t0 = performance.now();
				await api.flushSave();
				return performance.now() - t0;
			});
			times.push(ms);
			await closeMap();
			await deleteMap(mapId);
		}
		const stats = computeStats("flushSave(1K)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(3000);
	});

	it("save 10K locations", async () => {
		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			mapId = await createAndOpenMap(`Bench Save 10K #${iter}`);
			await withApi(async (api) => {
				const locs: Location[] = [];
				for (let i = 0; i < 10000; i++) {
					locs.push(api.createLocation({
						lat: Math.random() * 170 - 85,
						lng: Math.random() * 360 - 180,
						zoom: 1,
					}));
				}
				await api.addLocations(locs);
				return "ok";
			});

			const ms = await withApi(async (api) => {
				const t0 = performance.now();
				await api.flushSave();
				return performance.now() - t0;
			});
			times.push(ms);
			await closeMap();
			await deleteMap(mapId);
		}
		const stats = computeStats("flushSave(10K)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(10000);
	});

	it("save 100K locations", async () => {
		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			mapId = await createAndOpenMap(`Bench Save 100K #${iter}`);
			await withApi(async (api) => {
				const locs: Location[] = [];
				for (let i = 0; i < 100000; i++) {
					locs.push(api.createLocation({
						lat: Math.random() * 170 - 85,
						lng: Math.random() * 360 - 180,
						zoom: 1,
					}));
				}
				await api.addLocations(locs);
				return "ok";
			});

			const ms = await withApi(async (api) => {
				const t0 = performance.now();
				await api.flushSave();
				return performance.now() - t0;
			});
			times.push(ms);
			await closeMap();
			await deleteMap(mapId);
		}
		const stats = computeStats("flushSave(100K)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(30000);
	});
});

describe("Benchmarks - map open", () => {
	before(async () => {
		await waitForReady();
	});

	it("open map with 1K locations", async () => {
		const mapId = await createAndOpenMap("Bench Open 1K");
		await withApi(async (api) => {
			const locs: Location[] = [];
			for (let i = 0; i < 1000; i++) {
				locs.push(api.createLocation({
					lat: Math.random() * 170 - 85,
					lng: Math.random() * 360 - 180,
					zoom: 1,
				}));
			}
			await api.addLocations(locs);
			return "ok";
		});
		await flushAndWait();
		await closeMap();

		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			const ms = await withApi(async (api, id) => {
				const t0 = performance.now();
				await api.openMap(id);
				return performance.now() - t0;
			}, mapId);
			times.push(ms);
			await closeMap();
		}

		const stats = computeStats("openMap(1K)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(2000);
		await deleteMap(mapId);
	});

	it("open map with 10K locations", async () => {
		const mapId = await createAndOpenMap("Bench Open 10K");
		await withApi(async (api) => {
			const locs: Location[] = [];
			for (let i = 0; i < 10000; i++) {
				locs.push(api.createLocation({
					lat: Math.random() * 170 - 85,
					lng: Math.random() * 360 - 180,
					zoom: 1,
				}));
			}
			await api.addLocations(locs);
			return "ok";
		});
		await flushAndWait();
		await closeMap();

		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			const ms = await withApi(async (api, id) => {
				const t0 = performance.now();
				await api.openMap(id);
				return performance.now() - t0;
			}, mapId);
			times.push(ms);
			await closeMap();
		}

		const stats = computeStats("openMap(10K)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(5000);
		await deleteMap(mapId);
	});

	it("open map with 100K locations", async () => {
		const mapId = await createAndOpenMap("Bench Open 100K");
		await withApi(async (api) => {
			const locs: Location[] = [];
			for (let i = 0; i < 100000; i++) {
				locs.push(api.createLocation({
					lat: Math.random() * 170 - 85,
					lng: Math.random() * 360 - 180,
					zoom: 1,
				}));
			}
			await api.addLocations(locs);
			return "ok";
		});
		await flushAndWait();
		await closeMap();

		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			const ms = await withApi(async (api, id) => {
				const t0 = performance.now();
				await api.openMap(id);
				return performance.now() - t0;
			}, mapId);
			times.push(ms);
			await closeMap();
		}

		const stats = computeStats("openMap(100K)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(15000);
		await deleteMap(mapId);
	});
});

describe("Benchmarks - selection refresh", () => {
	let mapId: string;
	let benchTagId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("Bench Selections");
		const tag = await createTag("bench-tag");
		benchTagId = tag.id;

		await withApi(async (api, tagId) => {
			const locs: Location[] = [];
			for (let i = 0; i < 50000; i++) {
				locs.push(api.createLocation({
					lat: Math.random() * 170 - 85,
					lng: Math.random() * 360 - 180,
					zoom: 1,
					panoId: i < 20000 ? `p${i}` : null,
					flags: i < 15000 ? 1 : 0,
					tags: i < 25000 ? [tagId] : [],
				}));
			}
			await api.addLocations(locs);
			return "ok";
		}, benchTagId);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	beforeEach(async () => {
		await withApi(async (api) => {
			await api.resetSelections();
			return "ok";
		});
	});

	it("selectEverything on 50K", async () => {
		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			const ms = await withApi(async (api) => {
				await api.resetSelections();
				const t0 = performance.now();
				await api.selectEverything();
				return performance.now() - t0;
			});
			times.push(ms);
		}
		const stats = computeStats("selectEverything(50K)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(500);
	});

	it("selectPanoIds on 50K", async () => {
		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			const ms = await withApi(async (api) => {
				await api.resetSelections();
				const t0 = performance.now();
				await api.selectPanoIds();
				return performance.now() - t0;
			});
			times.push(ms);
		}
		const stats = computeStats("selectPanoIds(50K)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(500);
	});

	it("selectTag on 50K", async () => {
		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			const ms = await withApi(async (api, tagId) => {
				await api.resetSelections();
				const t0 = performance.now();
				await api.selectTag(tagId);
				return performance.now() - t0;
			}, benchTagId);
			times.push(ms);
		}
		const stats = computeStats("selectTag(50K)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(500);
	});

	it("selectUntagged on 50K", async () => {
		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			const ms = await withApi(async (api) => {
				await api.resetSelections();
				const t0 = performance.now();
				await api.selectUntagged();
				return performance.now() - t0;
			});
			times.push(ms);
		}
		const stats = computeStats("selectUntagged(50K)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(500);
	});

	it("intersection of two selections on 50K", async () => {
		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			const ms = await withApi(async (api, tagId) => {
				await api.resetSelections();
				await api.selectPanoIds();
				await api.selectTag(tagId);
				const t0 = performance.now();
				await api.selectIntersection();
				return performance.now() - t0;
			}, benchTagId);
			times.push(ms);
		}
		const stats = computeStats("selectIntersection(50K, 2 sels)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(1000);
	});

	it("union of two selections on 50K", async () => {
		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			const ms = await withApi(async (api) => {
				await api.resetSelections();
				await api.selectPanoIds();
				await api.selectUntagged();
				const t0 = performance.now();
				await api.selectUnion();
				return performance.now() - t0;
			});
			times.push(ms);
		}
		const stats = computeStats("selectUnion(50K, 2 sels)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(1000);
	});

	it("invert selection on 50K", async () => {
		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			const ms = await withApi(async (api) => {
				await api.resetSelections();
				await api.selectPanoIds();
				const t0 = performance.now();
				await api.selectInverse();
				return performance.now() - t0;
			});
			times.push(ms);
		}
		const stats = computeStats("selectInverse(50K)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(500);
	});
});

describe("Benchmarks - undo/redo", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("Bench Undo");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("undo add of 10K locations", async () => {
		await withApi(async (api) => {
			const locs: Location[] = [];
			for (let i = 0; i < 10000; i++) {
				locs.push(api.createLocation({
					lat: Math.random() * 170 - 85,
					lng: Math.random() * 360 - 180,
					zoom: 1,
				}));
			}
			await api.addLocations(locs);
			return "ok";
		});

		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			if (iter > 0) {
				await withApi(async (api) => api.redo());
			}
			const ms = await withApi(async (api) => {
				const t0 = performance.now();
				api.undo();
				return performance.now() - t0;
			});
			times.push(ms);
		}
		const stats = computeStats("undo addLocations(10K)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(2000);
	});

	it("redo add of 10K locations", async () => {
		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			if (iter > 0) {
				await withApi(async (api) => api.undo());
			}
			const ms = await withApi(async (api) => {
				const t0 = performance.now();
				api.redo();
				return performance.now() - t0;
			});
			times.push(ms);
		}
		const stats = computeStats("redo addLocations(10K)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(2000);
	});
});

describe("Benchmarks - batch update", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("Bench Batch Update");
		await withApi(async (api) => {
			const locs: Location[] = [];
			for (let i = 0; i < 10000; i++) {
				locs.push(api.createLocation({
					lat: Math.random() * 170 - 85,
					lng: Math.random() * 360 - 180,
					zoom: 1,
				}));
			}
			await api.addLocations(locs);
			return "ok";
		});
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("batch update 1K locations", async () => {
		const times: number[] = [];
		for (let iter = 0; iter < ITERATIONS; iter++) {
			const ms = await withApi(async (api, iteration) => {
				const allLocs = await api.fetchAllLocations();
				const updates = [];
				for (let i = 0; i < 1000 && i < allLocs.length; i++) {
					updates.push({ id: allLocs[i].id, patch: { heading: iteration * 10 + i } });
				}
				const t0 = performance.now();
				api.batchUpdateLocations(updates);
				return performance.now() - t0;
			}, iter);
			times.push(ms);
		}
		const stats = computeStats("batchUpdate(1K of 10K)", times);
		report(stats);
		expect(stats.p95).toBeLessThan(3000);
	});
});
