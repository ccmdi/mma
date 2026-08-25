import { cmd } from "@/lib/commands";
import { waitForReady, closeMap, deleteMap, withApi } from "./helpers";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import type { ImportPreviewEntry, MapMeta, Tag } from "@/bindings.gen";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_ZIP = resolve(__dirname, "../fixtures/mma-export-sample.zip");

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

		const names = entries.map((e: ImportPreviewEntry) => e.name).sort();
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

		const denmark = entries.find((e: ImportPreviewEntry) => e.name === "Denmark Antennae")!;
		expect(denmark.locationCount).toBe(97);

		const gun = entries.find((e: ImportPreviewEntry) => e.name === "A Gun World")!;
		expect(gun.locationCount).toBe(88);

		const karelia = entries.find((e: ImportPreviewEntry) => e.name === "Karelia notes")!;
		expect(karelia.locationCount).toBe(2);
	});

	it("reports tag counts", async () => {
		const entries = await withApi(async (api, p) => {
			return await api.cmd.bulkImportPreview(p);
		}, FIXTURE_ZIP);

		const denmark = entries.find((e: ImportPreviewEntry) => e.name === "Denmark Antennae")!;
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

		const names = maps.map((m: MapMeta) => m.name);
		expect(names).toContain("Denmark Antennae");
		expect(names).toContain("A Gun World");
		expect(names).toContain("Karelia notes");
	});

	it("imported maps have correct location counts", async () => {
		const maps = await withApi(async (api) => {
			return await api.cmd.storeListMaps();
		});

		const denmark = maps.find((m: MapMeta) => m.name === "Denmark Antennae")!;
		expect(denmark.locationCount).toBe(97);

		const gun = maps.find((m: MapMeta) => m.name === "A Gun World")!;
		expect(gun.locationCount).toBe(88);
	});

	it("imported maps can be opened and locations loaded", async () => {
		const result = await withApi(async (api) => {
			const maps = await api.cmd.storeListMaps();
			const denmark = maps.find((m: MapMeta) => m.name === "Denmark Antennae")!;
			await api._test.openMap(denmark.id);
			const locCount = (await api.cmd.storeGetSummary()).locationCount;
			const locs = await api.fetchAllLocations();
			return {
				locationCount: locCount,
				tagCount: Object.keys(api.getMapState().tags).length,
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
			const tags = Object.values(api.getMapState().tags);
			return tags.map((t: Tag) => ({ name: t.name, color: t.color }));
		});

		const longTag = result.find((t) => t.name === "Long")!;
		expect(longTag).toBeDefined();
		expect(longTag.color).toBe("#ff0303");

		const whiteTag = result.find((t) => t.name === "Short Antenna")!;
		expect(whiteTag.color).toBe("#ffffff");
	});

	it("location tag references resolve to valid tags", async () => {
		const result = await withApi(async (api) => {
			const tagIds = new Set(Object.keys(api.getMapState().tags));
			const locs = await api.fetchAllLocations();
			const tagged = locs.filter((l) => l.tags.length > 0);
			const orphaned = tagged.filter((l) => l.tags.some((id) => !tagIds.has(String(id))));
			return { taggedCount: tagged.length, orphanedCount: orphaned.length };
		});

		expect(result.taggedCount).toBeGreaterThan(0);
		expect(result.orphanedCount).toBe(0);
	});

	it("imported locations survive save/load cycle", async () => {
		const result = await withApi(async (api) => {
			const id = api.getMapState().mapId!;
			const beforeCount = (await api.cmd.storeGetSummary()).locationCount;
			const beforeLocs = await api.fetchAllLocations();
			const beforeFirst = beforeLocs[0];

			await api.flushSave();
			await api._test.closeMap();
			await api._test.openMap(id);

			const afterCount = (await api.cmd.storeGetSummary()).locationCount;
			const afterLocs = await api.fetchAllLocations();
			return {
				beforeCount,
				afterCount,
				latMatch: afterLocs.some((l) => Math.abs(l.lat - beforeFirst.lat) < 0.0001),
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
