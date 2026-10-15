/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Import error paths: verify that malformed, empty, and edge-case inputs
 * produce graceful errors (not crashes or silent data loss).
 */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	createLocation,
	getLoc,
	getLocCount,
	getAllLocs,
	flushAndWait,
	withApi,
	useMap,
} from "./helpers";

// ============================================================================
// 1. Malformed JSON import
// ============================================================================

describe("Malformed JSON import", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Import Errors");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("completely invalid JSON previews as empty with a parser warning", async () => {
		const preview = await withApi(async (api) => {
			const path = await api.cmd.writeTempFile("bad.json", "this is not json at all {{{");
			return api.cmd.storeImportPreview({ path });
		});
		expect(preview.locationCount).toBe(0);
		expect(preview.warnings).toContain("CSV missing lat/lng columns");
		expect(await getLocCount()).toBe(0);
	});

	it("an object without a coordinate array previews empty with a warning", async () => {
		const preview = await withApi(async (api) => {
			const path = await api.cmd.writeTempFile("empty.json", "{}");
			return api.cmd.storeImportPreview({ path });
		});
		expect(preview.locationCount).toBe(0);
		expect(preview.warnings).toContain("No recognized coordinate array found");
		expect(await getLocCount()).toBe(0);
	});

	it("empty customCoordinates array imports zero locations", async () => {
		const result = await withApi(async (api) => {
			const json = JSON.stringify({ customCoordinates: [] });
			const path = await api.cmd.writeTempFile("empty-coords.json", json);
			const preview = await api.cmd.storeImportPreview({ path });
			return preview.locationCount;
		});
		expect(result).toBe(0);
	});

	it("a JSON array without location objects previews empty and changes no rows", async () => {
		const preview = await withApi(async (api) => {
			const path = await api.cmd.writeTempFile(
				"strings.json",
				JSON.stringify(["foo", "bar", "baz"]),
			);
			return api.cmd.storeImportPreview({ path });
		});
		expect(preview.locationCount).toBe(0);
		expect(preview.bounds).toBeNull();
		expect(await getLocCount()).toBe(0);
	});

	it("a location with non-numeric coordinates is excluded from preview", async () => {
		const preview = await withApi(async (api) => {
			const json = JSON.stringify({ customCoordinates: [{ lat: "not-a-number", lng: 20 }] });
			const path = await api.cmd.writeTempFile("nan.json", json);
			return api.cmd.storeImportPreview({ path });
		});
		expect(preview.locationCount).toBe(0);
		expect(preview.bounds).toBeNull();
		expect(await getLocCount()).toBe(0);
	});

	it("location count unchanged after failed imports", async () => {
		const count = await getLocCount();
		expect(count).toBe(0);
	});
});

// ============================================================================
// 2. Paste import edge cases
// ============================================================================

describe("Paste import edge cases", () => {
	useMap("E2E Paste Errors");

	it("empty paste leaves the map unchanged", async () => {
		await expect(withApi(async (api) => api._test.importPaste(""))).rejects.toThrow(
			"no locations found",
		);
		expect(await getLocCount()).toBe(0);
	});

	it("unrecognized paste text leaves the map unchanged", async () => {
		await expect(
			withApi(async (api) => api._test.importPaste("hello world this is not coordinates")),
		).rejects.toThrow("no locations found");
		expect(await getLocCount()).toBe(0);
	});

	it("paste with valid single coordinate works", async () => {
		await withApi(async (api) => {
			await api._test.importPaste("51.5074, -0.1278");
		});
		const count = await getLocCount();
		expect(count).toBe(1);

		const locs = await getAllLocs();
		const loc = locs[0];
		expect(loc.lat).toBeCloseTo(51.5074, 3);
		expect(loc.lng).toBeCloseTo(-0.1278, 3);
	});

	it("paste imports each valid coordinate and skips the invalid line", async () => {
		const countBefore = await getLocCount();
		await withApi(async (api) =>
			api._test.importPaste("40.7128, -74.0060\nnot a coord\n35.6762, 139.6503"),
		);
		expect(await getLocCount()).toBe(countBefore + 2);
		const added = (await getAllLocs()).slice(countBefore);
		expect(added.map(({ lat, lng }) => [lat, lng])).toEqual([
			[40.7128, -74.006],
			[35.6762, 139.6503],
		]);
	});
});

// ============================================================================
// 3. CSV edge cases
// ============================================================================

describe("CSV import edge cases", () => {
	useMap("E2E CSV Errors");

	it("CSV with headers only previews no locations", async () => {
		const preview = await withApi(async (api) => {
			const path = await api.cmd.writeTempFile("headers-only.csv", "lat,lng,heading,pitch,zoom\n");
			return api.cmd.storeImportPreview({ path });
		});
		expect(preview.locationCount).toBe(0);
		expect(preview.bounds).toBeNull();
		expect(await getLocCount()).toBe(0);
	});

	it("CSV headers select latitude and longitude independent of column order", async () => {
		const preview = await withApi(async (api) => {
			const path = await api.cmd.writeTempFile(
				"swapped.csv",
				"lng,lat,heading\n-0.1278,51.5074,0\n",
			);
			return api.cmd.storeImportPreview({ path });
		});
		expect(preview.locationCount).toBe(1);
		expect(preview.bounds).toEqual([-0.1278, 51.5074, -0.1278, 51.5074]);
		expect(await getLocCount()).toBe(0);
	});

	it("empty CSV reports an empty input and previews no locations", async () => {
		const preview = await withApi(async (api) => {
			const path = await api.cmd.writeTempFile("empty.csv", "");
			return api.cmd.storeImportPreview({ path });
		});
		expect(preview.locationCount).toBe(0);
		expect(preview.bounds).toBeNull();
		expect(preview.warnings).toContain("Empty CSV");
		expect(await getLocCount()).toBe(0);
	});
});

// ============================================================================
// 4. Import does not corrupt existing data
// ============================================================================

describe("Import does not corrupt existing data", () => {
	useMap("E2E Import Safety");
	let existingIds: number[];

	before(async () => {
		const locs = [
			createLocation({ lat: 10, lng: 20, heading: 90 }),
			createLocation({ lat: 30, lng: 40, heading: 180 }),
		];
		existingIds = await addLocs(locs);
		await flushAndWait();
	});
	it("a malformed import preview leaves existing locations intact", async () => {
		const preview = await withApi(async (api) => {
			const path = await api.cmd.writeTempFile("garbage.json", "not json!!!!");
			return api.cmd.storeImportPreview({ path });
		});
		expect(preview.locationCount).toBe(0);
		expect(preview.warnings).toContain("CSV missing lat/lng columns");
		expect(await getLocCount()).toBe(2);
		expect((await getAllLocs()).map(({ id }) => id)).toEqual(existingIds);
	});

	it("existing locations have correct data after failed import", async () => {
		const loc1 = await getLoc(existingIds[0]);
		expect(loc1.lat).toBeCloseTo(10, 2);
		expect(loc1.lng).toBeCloseTo(20, 2);
		expect(loc1.heading).toBeCloseTo(90, 2);

		const loc2 = await getLoc(existingIds[1]);
		expect(loc2.lat).toBeCloseTo(30, 2);
		expect(loc2.lng).toBeCloseTo(40, 2);
	});
});
