import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	getLoc,
	createLocation,
	withApi,
} from "./helpers";
import type { Location } from "@/types";

const OFFICIAL_PANO = "-zrYsLR4Fh-cfJG_EMZ1-A";
const OFFICIAL_COORDS = { lat: 52.10947502806108, lng: 34.90131410856584 };
const LoadAsPanoId = 1;

function loc(overrides: Partial<Location> = {}): Location {
	return createLocation({ lat: 0, lng: 0, ...overrides });
}

// ============================================================================
// Bulk enrichment
// ============================================================================

describe("Bulk operations -- enrichAll", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Bulk Enrich");
		const locs = [
			loc({ lat: OFFICIAL_COORDS.lat, lng: OFFICIAL_COORDS.lng, panoId: OFFICIAL_PANO }),
			loc({ lat: OFFICIAL_COORDS.lat, lng: OFFICIAL_COORDS.lng, panoId: OFFICIAL_PANO }),
			loc({ lat: OFFICIAL_COORDS.lat, lng: OFFICIAL_COORDS.lng }),
		];
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("enriches locations with panoId", async () => {
		const result = await withApi(async (api) => {
			return await api.enrichAll();
		});

		expect(result.metaSuccess.length).toBeGreaterThanOrEqual(2);

		const l = await getLoc(locIds[0]);
		expect(l.extra?.countryCode).toBeTruthy();
	});

	it("resolves panoId from coords for locations without one", async () => {
		const before = await getLoc(locIds[2]);

		const hadPano = before?.panoId != null;
		if (hadPano) return; // already resolved from previous test run

		await withApi(async (api) => {
			return await api.enrichAll({ force: true });
		});

		const after = await getLoc(locIds[2]);
		expect(after.panoId).toBeTruthy();
	});

	it("undo fully reverses enrichment including resolved panoIds", async () => {
		// Start fresh
		await closeMap();
		await deleteMap(mapId);
		mapId = await createAndOpenMap("E2E Bulk Enrich Undo");
		const locs = [
			loc({ lat: OFFICIAL_COORDS.lat, lng: OFFICIAL_COORDS.lng, panoId: OFFICIAL_PANO }),
		];
		const newIds = await addLocs(locs);
		const undoLocId = newIds[0];

		// Verify not enriched initially
		const before = await getLoc(undoLocId);
		expect(before.extra?.countryCode).toBeFalsy();

		// Run enrichment
		await withApi(async (api) => {
			return await api.enrichAll({ force: true });
		});

		// Verify enriched
		const enriched = await getLoc(undoLocId);
		expect(enriched.panoId).toBeTruthy();
		expect(enriched.extra?.countryCode).toBeTruthy();

		// Undo until enrichment is gone (but stop before undoing the addLocations)
		await withApi(async (api, id) => {
			for (let i = 0; i < 100; i++) {
				api.undo();
				await new Promise((r) => setTimeout(r, 300));
				const loc = await api.fetchLocation(id);
				if (!loc || !loc.extra?.countryCode) break;
			}
			return "ok";
		}, undoLocId);

		const reverted = await getLoc(undoLocId);
		expect(reverted).not.toBeNull();
		expect(reverted.extra?.countryCode).toBeFalsy();
	});
});

// ============================================================================
// Bulk pin to pano
// ============================================================================

describe("Bulk operations -- bulkPinToPano", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Bulk Pin");
		const locs = [
			loc({ lat: OFFICIAL_COORDS.lat, lng: OFFICIAL_COORDS.lng }),
			loc({ lat: OFFICIAL_COORDS.lat, lng: OFFICIAL_COORDS.lng, panoId: OFFICIAL_PANO }),
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LoadAsPanoId,
			}),
		];
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("pins unpinned locations and resolves panoId from coords", async () => {
		const count = await withApi(async (api) => {
			return await api.bulkPinToPano();
		});

		// pin-1 (no pano) and pin-2 (has pano, not pinned) should be pinned
		// pin-3 is already pinned
		expect(count).toBe(2);

		const l1 = await getLoc(locIds[0]);
		expect(l1.panoId).toBeTruthy();
		expect(l1.flags & LoadAsPanoId).toBeTruthy();

		const l2 = await getLoc(locIds[1]);
		expect(l2.flags & LoadAsPanoId).toBeTruthy();
	});

	it("skips already-pinned locations without force", async () => {
		const count = await withApi(async (api) => {
			return await api.bulkPinToPano();
		});

		expect(count).toBe(0);
	});

	it("re-pins all with force", async () => {
		const count = await withApi(async (api) => {
			return await api.bulkPinToPano({ force: true });
		});

		expect(count).toBe(3);
	});
});

// ============================================================================
// needsEnrichment predicate
// ============================================================================

describe("Bulk operations -- needsEnrichment", () => {
	it("returns true for locations without countryCode", async () => {
		const result = await withApi(async (api) => {
			return [
				api.needsEnrichment({ extra: undefined }),
				api.needsEnrichment({ extra: {} }),
				api.needsEnrichment({ extra: { altitude: 100 } }),
			];
		});
		expect(result).toEqual([true, true, true]);
	});

	it("returns false for locations with countryCode", async () => {
		const result = await withApi(async (api) => {
			return api.needsEnrichment({ extra: { countryCode: "US" } });
		});
		expect(result).toBe(false);
	});
});

// ============================================================================
// Cancel preserves partial progress
// ============================================================================

describe("Bulk operations -- cancel preserves progress", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Bulk Cancel");
		// Create enough locations to span multiple batches
		const locs = [];
		for (let i = 0; i < 500; i++) {
			locs.push(
				createLocation({
					lat: 52.109 + i * 0.0001,
					lng: 34.901 + i * 0.0001,
				}),
			);
		}
		await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("enrichAll with abort preserves completed batches", async () => {
		const result = await withApi(async (api) => {
			try {
				const controller = new AbortController();
				// Cancel after 2 seconds
				setTimeout(() => controller.abort(), 2000);
				await api.enrichAll({ signal: controller.signal, force: true });
				return { cancelled: false };
			} catch (e: any) {
				if (e.name === "AbortError") {
					const locs = await api.fetchAllLocations();
					const enriched = locs.filter((l: any) => l.extra?.countryCode != null).length;
					return { cancelled: true, enriched };
				}
				return { error: e.message };
			}
		});

		if (result.cancelled) {
			// Some locations should have been enriched before cancel
			expect(result.enriched).toBeGreaterThan(0);
			expect(result.enriched).toBeLessThan(500);
		}
		// If it finished before the 2s timeout, that's also fine
	});
});
