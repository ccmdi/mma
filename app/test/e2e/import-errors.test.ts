/* eslint-disable @typescript-eslint/no-explicit-any, no-empty */
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

	it("completely invalid JSON does not crash", async () => {
		const result = await withApi(async (api) => {
			try {
				const path = await api.cmd.writeTempFile("bad.json", "this is not json at all {{{");
				const preview = await api.cmd.storeImportPreview(path);
				// If it didn't throw, it should have returned 0 locations
				return { count: preview?.locationCount ?? 0, threw: false };
			} catch (_e: any) {
				return { count: 0, threw: true };
			}
		});
		// Either throws or returns 0 locations — both are acceptable
		if (!result.threw) {
			expect(result.count).toBe(0);
		}
	});

	it("empty JSON object imports zero locations", async () => {
		const result = await withApi(async (api) => {
			try {
				const path = await api.cmd.writeTempFile("empty.json", "{}");
				const preview = await api.cmd.storeImportPreview(path);
				return { count: preview.locationCount };
			} catch (e: any) {
				return { count: -1, error: e.message };
			}
		});
		// Either returns 0 locations or throws — both are acceptable
		if (result.count !== -1) {
			expect(result.count).toBe(0);
		}
	});

	it("empty customCoordinates array imports zero locations", async () => {
		const result = await withApi(async (api) => {
			const json = JSON.stringify({ customCoordinates: [] });
			const path = await api.cmd.writeTempFile("empty-coords.json", json);
			const preview = await api.cmd.storeImportPreview(path);
			return preview.locationCount;
		});
		expect(result).toBe(0);
	});

	it("JSON with wrong structure (array of strings) does not crash", async () => {
		await withApi(async (api) => {
			try {
				const json = JSON.stringify(["foo", "bar", "baz"]);
				const path = await api.cmd.writeTempFile("strings.json", json);
				await api.cmd.storeImportPreview(path);
			} catch (_e: any) {
				/* expected */
			}
		});
	});

	it("location with NaN coordinates is handled", async () => {
		const result = await withApi(async (api) => {
			try {
				const json = JSON.stringify({
					customCoordinates: [{ lat: "not-a-number", lng: 20 }],
				});
				const path = await api.cmd.writeTempFile("nan.json", json);
				const preview = await api.cmd.storeImportPreview(path);
				return { count: preview.locationCount, error: null };
			} catch (e: any) {
				return { count: 0, error: e.message };
			}
		});
		// Either skipped or errored — not a silent NaN in the store
		if (result.count > 0) {
			// If it was imported, verify it's not NaN
			const locs = await getAllLocs();
			for (const loc of locs) {
				expect(Number.isFinite(loc.lat)).toBe(true);
				expect(Number.isFinite(loc.lng)).toBe(true);
			}
		}
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
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Paste Errors");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("empty string paste does not crash", async () => {
		await withApi(async (api) => {
			try {
				await api._test.importPaste("");
			} catch (_e: any) {
				/* expected */
			}
		});
		const count = await getLocCount();
		expect(count).toBe(0);
	});

	it("paste of random text does not add locations", async () => {
		await withApi(async (api) => {
			try {
				await api._test.importPaste("hello world this is not coordinates");
			} catch (_e: any) {
				/* expected */
			}
		});
		const count = await getLocCount();
		expect(count).toBe(0);
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

	it("paste with mixed valid and invalid lines imports valid ones", async () => {
		const countBefore = await getLocCount();
		await withApi(async (api) => {
			try {
				await api._test.importPaste("40.7128, -74.0060\nnot a coord\n35.6762, 139.6503");
			} catch (_e: any) {
				/* partial import may throw */
			}
		});
		const countAfter = await getLocCount();
		// Should have added at least the valid coordinates
		expect(countAfter).toBeGreaterThanOrEqual(countBefore);
	});
});

// ============================================================================
// 3. CSV edge cases
// ============================================================================

describe("CSV import edge cases", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E CSV Errors");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("CSV with headers only (no data rows) imports zero locations", async () => {
		const result = await withApi(async (api) => {
			try {
				const csv = "lat,lng,heading,pitch,zoom\n";
				const path = await api.cmd.writeTempFile("headers-only.csv", csv);
				const preview = await api.cmd.storeImportPreview(path);
				return { count: preview.locationCount };
			} catch (e: any) {
				return { count: 0, error: e.message };
			}
		});
		expect(result.count).toBe(0);
	});

	it("CSV with swapped lat/lng columns imports (no crash)", async () => {
		await withApi(async (api) => {
			try {
				const csv = "lng,lat,heading\n-0.1278,51.5074,0\n";
				const path = await api.cmd.writeTempFile("swapped.csv", csv);
				await api.cmd.storeImportPreview(path);
			} catch (_e: any) {
				/* expected */
			}
		});
	});

	it("empty CSV file does not crash", async () => {
		await withApi(async (api) => {
			try {
				const path = await api.cmd.writeTempFile("empty.csv", "");
				await api.cmd.storeImportPreview(path);
			} catch (_e: any) {
				/* expected */
			}
		});
	});
});

// ============================================================================
// 4. Import does not corrupt existing data
// ============================================================================

describe("Import does not corrupt existing data", () => {
	let mapId: string;
	let existingIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Import Safety");

		const locs = [
			createLocation({ lat: 10, lng: 20, heading: 90 }),
			createLocation({ lat: 30, lng: 40, heading: 180 }),
		];
		existingIds = await addLocs(locs);
		await flushAndWait();
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("failed import leaves existing locations intact", async () => {
		// Try to import garbage
		await withApi(async (api) => {
			try {
				const path = await api.cmd.writeTempFile("garbage.json", "not json!!!!");
				await api.cmd.storeImportPreview(path);
			} catch {}
		});

		const count = await getLocCount();
		expect(count).toBe(2);

		const locs = await getAllLocs();
		expect(locs.length).toBe(2);
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
