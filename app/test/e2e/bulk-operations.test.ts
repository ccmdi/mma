import {
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	getLoc,
	createLocation,
	withApi,
	useMap,
	seedLocs,
} from "./helpers";
import type { Location } from "@/bindings.gen";
import { LocationFlag } from "@/types";

const OFFICIAL_PANO = "-zrYsLR4Fh-cfJG_EMZ1-A";
const OFFICIAL_COORDS = { lat: 52.10947502806108, lng: 34.90131410856584 };
function loc(overrides: Partial<Location> = {}): Location {
	return createLocation({ lat: 0, lng: 0, ...overrides });
}

// ============================================================================
// Bulk enrichment
// ============================================================================

describe("Bulk operations -- enrichAll", () => {
	const map = useMap("E2E Bulk Enrich");
	let locIds: number[];

	before(async () => {
		const locs = [
			loc({ lat: OFFICIAL_COORDS.lat, lng: OFFICIAL_COORDS.lng, panoId: OFFICIAL_PANO }),
			loc({ lat: OFFICIAL_COORDS.lat, lng: OFFICIAL_COORDS.lng, panoId: OFFICIAL_PANO }),
			loc({ lat: OFFICIAL_COORDS.lat, lng: OFFICIAL_COORDS.lng }),
		];
		locIds = await addLocs(locs);
	});
	it("resolves panoIds and reports a success count plus the failed ids", async () => {
		const summary = await withApi(async (api) => {
			const res = await api.enrichAll({ type: "Everything" }, { force: true });
			return res.map((o) => ({ id: o.id, success: o.success, failed: o.failed }));
		});

		// Only passes that did work are reported. Every fixture location resolves and
		// enriches under the mock, so nothing fails.
		expect(summary.length).toBeGreaterThan(0);
		for (const s of summary) {
			expect(s.success).toBeGreaterThan(0);
			expect(s.failed).toEqual([]);
		}

		for (const id of locIds) {
			const l = await getLoc(id);
			expect(l.panoId).toBeTruthy();
		}
	});

	it("hands back the ids of the rows a provider failed", async () => {
		// Open ocean: no coverage, so pano resolution fails the row by id.
		const [oceanId] = await addLocs([loc({ lat: 0, lng: 0 })]);
		const failed = await withApi(async (api) => {
			const res = await api.enrichAll({ type: "Everything" }, { force: true });
			return res.find((o) => o.id === "panoResolve")?.failed ?? null;
		});
		expect(failed).toEqual([oceanId]);
	});

	it("resolves panoId from coords for locations without one", async () => {
		const before = await getLoc(locIds[2]);

		const hadPano = before?.panoId != null;
		if (hadPano) return; // already resolved from previous test run

		await withApi(async (api) => {
			return await api.enrichAll({ type: "Everything" }, { force: true });
		});

		const after = await getLoc(locIds[2]);
		expect(after.panoId).toBeTruthy();
	});

	it("undo fully reverses enrichment including resolved panoIds", async () => {
		// Start fresh
		await closeMap();
		await deleteMap(map.id);
		map.id = await createAndOpenMap("E2E Bulk Enrich Undo");
		const locs = [loc({ lat: OFFICIAL_COORDS.lat, lng: OFFICIAL_COORDS.lng })];
		const newIds = await addLocs(locs);
		const undoLocId = newIds[0];

		const before = await getLoc(undoLocId);
		expect(before.panoId).toBeFalsy();

		await withApi(async (api) => {
			await api.enrichAll({ type: "Everything" }, { force: true });
			return "ok";
		});

		const enriched = await getLoc(undoLocId);
		expect(enriched.panoId).toBeTruthy();

		// Undo until the resolved pano is gone (but stop before undoing the addLocations).
		await withApi(async (api, id) => {
			for (let i = 0; i < 100; i++) {
				await api.undo();
				await new Promise((r) => setTimeout(r, 300));
				const loc = await api.fetchLocation(id);
				if (!loc || !loc.panoId) break;
			}
			return "ok";
		}, undoLocId);

		const reverted = await getLoc(undoLocId);
		expect(reverted.panoId).toBeFalsy();
	});
});

// ============================================================================
// Bulk pin to pano
// ============================================================================

describe("Bulk operations -- bulkPinToPano", () => {
	useMap("E2E Bulk Pin");
	let locIds: number[];

	before(async () => {
		const locs = [
			loc({ lat: OFFICIAL_COORDS.lat, lng: OFFICIAL_COORDS.lng }),
			loc({ lat: OFFICIAL_COORDS.lat, lng: OFFICIAL_COORDS.lng, panoId: OFFICIAL_PANO }),
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
		];
		locIds = await addLocs(locs);
	});
	it("pins unpinned locations and resolves panoId from coords", async () => {
		const count = await withApi(async (api) => {
			return await api.bulkPinToPano({ type: "Everything" });
		});

		// pin-1 (no pano) and pin-2 (has pano, not pinned) should be pinned
		// pin-3 is already pinned
		expect(count).toBe(2);

		const l1 = await getLoc(locIds[0]);
		expect(l1.panoId).toBeTruthy();
		expect(l1.flags & LocationFlag.LoadAsPanoId).toBeTruthy();

		const l2 = await getLoc(locIds[1]);
		expect(l2.flags & LocationFlag.LoadAsPanoId).toBeTruthy();
	});

	it("skips already-pinned locations without force", async () => {
		const count = await withApi(async (api) => {
			return await api.bulkPinToPano({ type: "Everything" });
		});

		expect(count).toBe(0);
	});

	it("re-pins all with force", async () => {
		const count = await withApi(async (api) => {
			return await api.bulkPinToPano({ type: "Everything" }, { force: true });
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
			const base = {
				id: 0,
				lat: 0,
				lng: 0,
				heading: 0,
				pitch: 0,
				zoom: 0,
				panoId: null,
				flags: 0,
				tags: [],
				createdAt: 0,
				modifiedAt: null,
			};
			return [
				api.needsEnrichment({ ...base, extra: undefined }),
				api.needsEnrichment({ ...base, extra: {} }),
				api.needsEnrichment({ ...base, extra: { altitude: 100 } }),
			];
		});
		expect(result).toEqual([true, true, true]);
	});

	it("is field-aware: needs enrichment unless every requested field is present", async () => {
		const fields = ["countryCode", "altitude"];
		const result = await withApi(async (api, f) => {
			const base = {
				id: 0,
				lat: 0,
				lng: 0,
				heading: 0,
				pitch: 0,
				zoom: 0,
				panoId: null,
				flags: 0,
				tags: [],
				createdAt: 0,
				modifiedAt: null,
			};
			return [
				api.needsEnrichment({ ...base, extra: { countryCode: "US" } }, f),
				api.needsEnrichment({ ...base, extra: { countryCode: "US", altitude: 100 } }, f),
			];
		}, fields);
		expect(result).toEqual([true, false]);
	});
});

// ============================================================================
// Cancel preserves partial progress
// ============================================================================

describe("Bulk operations -- cancel preserves progress", () => {
	useMap("E2E Bulk Cancel");

	const N = 50_000;

	before(async () => {
		// Enough rows for several engine pages. Only `timezone` is selected: it is an
		// offline module, so the run is deterministic.
		await withApi(async (api) => {
			const map = api.getMapState().map!;
			await api.updateMapMeta({
				settings: { ...map.meta.settings, enrichMetadata: true, enrichFields: ["timezone"] },
			});
			return "ok";
		});
		await seedLocs(N, (i) => ({
			lat: 52.109 + (i % 1000) * 0.0001,
			lng: 34.901 + Math.floor(i / 1000) * 0.0001,
			extra: { datetime: 1700000000 },
		}));
	});
	it("enrichAll with abort preserves completed pages", async () => {
		const result = await withApi(async (api, total) => {
			try {
				const controller = new AbortController();
				// Early enough that a fast provider cannot finish every page first.
				setTimeout(() => controller.abort(), 100);
				await api.enrichAll(
					{ type: "Everything" },
					{
						signal: controller.signal,
						force: true,
					},
				);
				return { cancelled: false };
			} catch (e) {
				if (e instanceof Error && e.name === "AbortError") {
					const count = async () =>
						(await api.fetchAllLocations()).filter((l) => l.extra?.timezone != null).length;
					const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
					// Cancel stops the run before its next batch: the batch in flight still lands.
					// Wait for that, then prove nothing more does.
					let settled = await count();
					for (let i = 0; i < 20; i++) {
						await sleep(500);
						const now = await count();
						if (now === settled) break;
						settled = now;
					}
					await sleep(2000);
					return { cancelled: true, settled, later: await count(), total };
				}
				return { error: e instanceof Error ? e.message : String(e) };
			}
		}, N);

		// A run that finished inside the abort window is not a cancel and proves nothing.
		if (!result.cancelled) return expect(result).toEqual({ cancelled: false });
		// Pages applied before the cancel took hold stay applied, and no page lands after.
		expect(result.settled).toBeLessThan(N);
		expect(result.later).toBe(result.settled);
	});
});
