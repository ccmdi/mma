import {
	waitForReady,
	closeMap,
	deleteMap,
	withApi,
} from "./helpers";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_ZIP = resolve(__dirname, "../fixtures/mma-export-sample.zip").replace(/\//g, "\\");

// ============================================================================
// Rust bulk import — preview
// ============================================================================

describe("Rust bulk import — preview", () => {
	before(async () => {
		await waitForReady();
	});

	it("returns preview entries for the fixture zip", async () => {
		const entries = await withApi(async (api, p) => {
			return await api.cmd.bulkImportPreview(p);
		}, FIXTURE_ZIP);

		expect(entries.length).toBe(6);

		const names = entries.map((e: any) => e.name).sort();
		expect(names).toContain("A Gun World");
		expect(names).toContain("Denmark Antennae");
		expect(names).toContain("Karelia notes");
		expect(names).toContain("Russian Flowers");
		expect(names).toContain("Russian Foliage");
	});

	it("reports correct location counts", async () => {
		const entries = await withApi(async (api, p) => {
			return await api.cmd.bulkImportPreview(p);
		}, FIXTURE_ZIP);

		const denmark = entries.find((e: any) => e.name === "Denmark Antennae")!;
		expect(denmark.locationCount).toBe(97);

		const gun = entries.find((e: any) => e.name === "A Gun World")!;
		expect(gun.locationCount).toBe(88);

		const karelia = entries.find((e: any) => e.name === "Karelia notes")!;
		expect(karelia.locationCount).toBe(2);
	});

	it("reports tag counts", async () => {
		const entries = await withApi(async (api, p) => {
			return await api.cmd.bulkImportPreview(p);
		}, FIXTURE_ZIP);

		const denmark = entries.find((e: any) => e.name === "Denmark Antennae")!;
		expect(denmark.tagCount).toBe(3);
	});
});

// ============================================================================
// Rust bulk import — confirm + verify DB state
// ============================================================================

describe("Rust bulk import — confirm and verify", () => {
	before(async () => {
		await waitForReady();
	});

	it("imports selected maps into DB", async () => {
		const result = await withApi(async (api, p) => {
			await api.cmd.bulkImportPreview(p);
			const imported = await api.cmd.bulkImportConfirm(p, [0, 1, 2, 3, 4, 5]);
			await api.invalidateMapList();
			return imported;
		}, FIXTURE_ZIP);

		expect(result.length).toBe(6);
	});

	it("imported maps appear in map list", async () => {
		const maps = await withApi(async (api) => {
			return await api.cmd.storeListMaps();
		});

		const names = maps.map((m: any) => m.name);
		expect(names).toContain("Denmark Antennae");
		expect(names).toContain("A Gun World");
		expect(names).toContain("Karelia notes");
	});

	it("imported maps have correct location counts", async () => {
		const maps = await withApi(async (api) => {
			return await api.cmd.storeListMaps();
		});

		const denmark = maps.find((m: any) => m.name === "Denmark Antennae")!;
		expect(denmark.locationCount).toBe(97);

		const gun = maps.find((m: any) => m.name === "A Gun World")!;
		expect(gun.locationCount).toBe(88);
	});

	it("imported maps can be opened and locations loaded", async () => {
		const result = await withApi(async (api) => {
			const maps = await api.cmd.storeListMaps();
			const denmark = maps.find((m: any) => m.name === "Denmark Antennae")!;
			await api.openMap(denmark.id);
			const locCount = await api.cmd.storeLocationCount();
			const map = api.getCurrentMap()!;
			const locs = await api.fetchAllLocations();
			return {
				locationCount: locCount,
				tagCount: Object.keys(map.meta.tags).length,
				firstLat: locs[0]?.lat,
			};
		});

		expect(result.locationCount).toBe(97);
		expect(result.tagCount).toBe(3);
		expect(result.firstLat).toBeDefined();
		expect(typeof result.firstLat).toBe("number");
	});

	it("imported tags have correct colors", async () => {
		const result = await withApi(async (api) => {
			const map = api.getCurrentMap()!;
			const tags = Object.values(map.meta.tags) as any[];
			return tags.map((t: any) => ({ name: t.name, color: t.color }));
		});

		const longTag = result.find((t: any) => t.name === "Long")!;
		expect(longTag).toBeDefined();
		expect(longTag.color).toBe("#ff0303");

		const whiteTag = result.find((t: any) => t.name === "Short Antenna")!;
		expect(whiteTag.color).toBe("#ffffff");
	});

	it("location tag references resolve to valid tags", async () => {
		const result = await withApi(async (api) => {
			const map = api.getCurrentMap()!;
			const tagIds = new Set(Object.keys(map.meta.tags));
			const locs = await api.fetchAllLocations();
			const tagged = locs.filter((l: any) => l.tags.length > 0);
			const orphaned = tagged.filter((l: any) => l.tags.some((id: any) => !tagIds.has(String(id))));
			return { taggedCount: tagged.length, orphanedCount: orphaned.length };
		});

		expect(result.taggedCount).toBeGreaterThan(0);
		expect(result.orphanedCount).toBe(0);
	});

	it("imported locations survive save/load cycle", async () => {
		const result = await withApi(async (api) => {
			const map = api.getCurrentMap()!;
			const id = map.meta.id;
			const beforeCount = await api.cmd.storeLocationCount();
			const beforeLocs = await api.fetchAllLocations();
			const beforeFirst = beforeLocs[0];

			await api.flushSave();
			await api.closeMap();
			await api.openMap(id);

			const afterCount = await api.cmd.storeLocationCount();
			const afterLocs = await api.fetchAllLocations();
			return {
				beforeCount,
				afterCount,
				latMatch: afterLocs.some((l: any) => Math.abs(l.lat - beforeFirst.lat) < 0.0001),
			};
		});

		expect(result.afterCount).toBe(result.beforeCount);
		expect(result.latMatch).toBe(true);
	});

	after(async () => {
		await closeMap();
		const maps = await withApi(async (api) => {
			return await api.cmd.storeListMaps();
		});
		for (const m of maps) {
			await deleteMap(m.id);
		}
	});
});

// ============================================================================
// Selective import (simulates "New only")
// ============================================================================

describe("Rust bulk import — selective import", () => {
	before(async () => {
		await waitForReady();
	});

	it("imports only selected indices", async () => {
		const result = await withApi(async (api, p) => {
			await api.cmd.bulkImportPreview(p);
			const imported = await api.cmd.bulkImportConfirm(p, [0, 2]);
			await api.invalidateMapList();
			const maps = await api.cmd.storeListMaps();
			return { importedCount: imported.length, mapCount: maps.length };
		}, FIXTURE_ZIP);

		expect(result.importedCount).toBe(2);
		expect(result.mapCount).toBe(2);
	});

	after(async () => {
		const maps = await withApi(async (api) => {
			return await api.cmd.storeListMaps();
		});
		for (const m of maps) await deleteMap(m.id);
	});
});

// ============================================================================
// Benchmarks — selection resolution at scale
// ============================================================================

describe("Benchmarks — selection at scale", () => {
	let mapId: string;
	let benchTagId: number;

	before(async () => {
		await waitForReady();
		mapId = await withApi(async (api) => {
			const map = await api.cmd.storeCreateMap("Bench Selections 100K", null);
			await api.openMap(map.meta.id);
			const resolved = await api.createTags(["BenchTag"]);
			const tagId = resolved[0].id;
			const locs = [];
			for (let i = 0; i < 100000; i++) {
				locs.push({
					lat: Math.random() * 170 - 85,
					lng: Math.random() * 360 - 180,
					heading: i % 10 === 0 ? 0 : Math.random() * 360,
					pitch: 0,
					zoom: 1,
					panoId: null, id: 0,
					flags: i % 5 === 0 ? 1 : 0,
					tags: i % 3 === 0 ? [tagId] : [],
					createdAt: new Date().toISOString(),
				});
			}
			await api.addLocations(locs);
			return JSON.stringify({ mapId: map.meta.id, tagId });
		});
		if (mapId.startsWith("ERROR")) throw new Error(mapId);
		const parsed = JSON.parse(mapId);
		mapId = parsed.mapId;
		benchTagId = parsed.tagId;
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("selectEverything on 100K", async () => {
		const ms = await withApi(async (api) => {
			const t0 = performance.now();
			await api.selectEverything();
			const elapsed = performance.now() - t0;
			api.resetSelections();
			return elapsed;
		});
		console.log(`  [BENCH] selectEverything(100K): ${Math.round(ms)}ms`);
		expect(ms).toBeLessThan(500);
	});

	it("selectTag on 100K (33% match)", async () => {
		const ms = await withApi(async (api, tagId) => {
			const t0 = performance.now();
			await api.selectTag(tagId);
			const elapsed = performance.now() - t0;
			const count = api.getSelectedLocationIds().size;
			api.resetSelections();
			return { ms: elapsed, count };
		}, benchTagId);
		console.log(`  [BENCH] selectTag(100K, 33%): ${Math.round(ms.ms)}ms (${ms.count} matched)`);
		expect(ms.ms).toBeLessThan(500);
	});

	it("selectUnpanned on 100K (10% match)", async () => {
		const ms = await withApi(async (api) => {
			const t0 = performance.now();
			await api.selectUnpanned();
			const elapsed = performance.now() - t0;
			const count = api.getSelectedLocationIds().size;
			api.resetSelections();
			return { ms: elapsed, count };
		});
		console.log(
			`  [BENCH] selectUnpanned(100K, 10%): ${Math.round(ms.ms)}ms (${ms.count} matched)`,
		);
		expect(ms.ms).toBeLessThan(500);
	});

	it("selectPanoIds on 100K (20% match)", async () => {
		const ms = await withApi(async (api) => {
			const t0 = performance.now();
			await api.selectPanoIds();
			const elapsed = performance.now() - t0;
			const count = api.getSelectedLocationIds().size;
			api.resetSelections();
			return { ms: elapsed, count };
		});
		console.log(`  [BENCH] selectPanoIds(100K, 20%): ${Math.round(ms.ms)}ms (${ms.count} matched)`);
		expect(ms.ms).toBeLessThan(500);
	});

	it("selectInverse on 100K", async () => {
		const ms = await withApi(async (api, tagId) => {
			await api.selectTag(tagId);
			const t0 = performance.now();
			await api.selectInverse();
			const elapsed = performance.now() - t0;
			api.resetSelections();
			return elapsed;
		}, benchTagId);
		console.log(`  [BENCH] selectInverse(100K): ${Math.round(ms)}ms`);
		expect(ms).toBeLessThan(1000);
	});

	it("selectDuplicates on 100K (dist=1)", async () => {
		const ms = await withApi(async (api) => {
			const t0 = performance.now();
			await api.selectDuplicates(1);
			const elapsed = performance.now() - t0;
			api.resetSelections();
			return elapsed;
		});
		console.log(`  [BENCH] selectDuplicates(100K, dist=1): ${Math.round(ms)}ms`);
		expect(ms).toBeLessThan(5000);
	});
});

// ============================================================================
// Benchmarks — undo at scale
// ============================================================================

describe("Benchmarks — undo at scale", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await withApi(async (api) => {
			const map = await api.cmd.storeCreateMap("Bench Undo 100K", null);
			await api.openMap(map.meta.id);
			const locs = [];
			for (let i = 0; i < 100000; i++) {
				locs.push({
					lat: Math.random() * 170 - 85,
					lng: Math.random() * 360 - 180,
					heading: 0,
					pitch: 0,
					zoom: 1,
					panoId: null, id: 0,
					flags: 0,
					tags: [],
					createdAt: new Date().toISOString(),
				});
			}
			await api.addLocations(locs);
			return map.meta.id;
		});
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("undo 100K location add", async () => {
		const result = await withApi(async (api) => {
			const before = await api.cmd.storeLocationCount();
			const t0 = performance.now();
			await api.undo();
			const elapsed = performance.now() - t0;
			const after = await api.cmd.storeLocationCount();
			await api.redo();
			return { ms: elapsed, before, after };
		});
		console.log(
			`  [BENCH] undo(100K add): ${Math.round(result.ms)}ms (${result.before} -> ${result.after})`,
		);
		expect(result.after).toBe(0);
		//TODO not that slow
		expect(result.ms).toBeLessThan(20000);
	});
});
