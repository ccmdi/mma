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
import { LocationFlag } from "@/bindings.consts";

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
			return res.map((o) => ({ id: o.id, succeeded: o.succeeded, failed: o.failed }));
		});

		// Only passes that did work are reported. Every fixture location resolves and
		// enriches under the mock, so nothing fails.
		expect(summary.length).toBeGreaterThan(0);
		for (const s of summary) {
			expect(s.succeeded).toBeGreaterThan(0);
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
		const outcome = await withApi(async (api) => {
			return await api.bulkPinToPano({ type: "Everything" });
		});

		// pin-1 (no pano) and pin-2 (has pano, not pinned) should be pinned
		// pin-3 is already pinned
		expect(outcome).toEqual({ succeeded: 2, failed: [] });

		const l1 = await getLoc(locIds[0]);
		expect(l1.panoId).toBeTruthy();
		expect(l1.flags & LocationFlag.LoadAsPanoId).toBeTruthy();

		const l2 = await getLoc(locIds[1]);
		expect(l2.flags & LocationFlag.LoadAsPanoId).toBeTruthy();
	});

	it("skips already-pinned locations without force", async () => {
		const outcome = await withApi(async (api) => {
			return await api.bulkPinToPano({ type: "Everything" });
		});

		expect(outcome).toEqual({ succeeded: 0, failed: [] });
	});

	it("re-pins all with force", async () => {
		const outcome = await withApi(async (api) => {
			return await api.bulkPinToPano({ type: "Everything" }, { force: true });
		});

		expect(outcome).toEqual({ succeeded: 3, failed: [] });
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
				api.needsEnrichment({ ...base, extra: undefined } as unknown as Location),
				api.needsEnrichment({ ...base, extra: {} } as unknown as Location),
				api.needsEnrichment({ ...base, extra: { altitude: 100 } } as unknown as Location),
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
		// Enough rows for several engine pages, each with the datetime timezone needs.
		await seedLocs(N, (i) => ({
			lat: 52.109 + (i % 1000) * 0.0001,
			lng: 34.901 + Math.floor(i / 1000) * 0.0001,
			extra: { datetime: 1700000000 },
		}));
	});
	it("a cancelled run keeps the pages it applied and lands no more", async () => {
		const result = await withApi(async (api, total) => {
			// The timezone procedure on its own, one instance, so pages apply one at a time
			// and a cancel after the first progress report leaves a partial run. enrichAll
			// cannot be used here: it schedules panoResolve in the same wave, and timezone
			// finishes every page while panoResolve is still searching.
			const controller = new AbortController();
			try {
				await api._test.runProcedure(
					{
						entry: api._test.procedureEntry("timezone"),
						batch: { mode: "chunk", size: 10000 },
						instances: 1,
						// Paced, so the run outlasts the round trip of its first progress report.
						rate: { units: 10000, perMs: 500, cost: "row" },
					},
					{ type: "Everything" },
					{
						id: "timezone",
						signal: controller.signal,
						onProgress: (done) => {
							if (done > 0) controller.abort();
						},
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

		expect(result.cancelled).toBe(true);
		// The page that reported progress stays applied, and no page lands after the cancel.
		expect(result.settled).toBeGreaterThan(0);
		expect(result.settled).toBeLessThan(N);
		expect(result.later).toBe(result.settled);
	});
});

// ============================================================================
// Field ops: set / expression / clear run in Rust over a selector, one undo entry each
// ============================================================================

describe("Bulk operations -- field ops", () => {
	useMap("E2E Bulk Field Ops");
	let ids: number[];

	before(async () => {
		ids = await addLocs([
			loc({ extra: { a: 10 } }),
			loc({ extra: { a: -10 } }),
			loc({ extra: { b: 1 } }),
		]);
	});

	it("an expression writes per row, names the rows it cannot evaluate, and undoes as one entry", async () => {
		const r = await withApi(
			(api, ids) =>
				api.applyFieldOp(
					{ type: "Locations", locations: ids, name: null },
					{ kind: "expr", key: "h", expr: "mod(a + 180, 360)" },
					true,
				),
			ids,
		);
		expect(r.changed).toBe(2);
		expect(r.failed).toEqual([ids[2]]);
		expect((await getLoc(ids[0])).extra?.h).toBe(190);
		expect((await getLoc(ids[1])).extra?.h).toBe(170);
		expect((await getLoc(ids[2])).extra?.h).toBeUndefined();

		await withApi(async (api) => {
			await api.undo();
			return "ok";
		});
		expect((await getLoc(ids[0])).extra?.h).toBeUndefined();
		expect((await getLoc(ids[1])).extra?.h).toBeUndefined();
	});

	it("a constant set patches a writable built-in column and a clear drops extra keys", async () => {
		const set = await withApi(
			(api, ids) =>
				api.applyFieldOp(
					{ type: "Locations", locations: ids, name: null },
					{ kind: "set", key: "heading", value: 90 },
					true,
				),
			ids,
		);
		expect(set.changed).toBe(3);
		expect((await getLoc(ids[2])).heading).toBe(90);

		const cleared = await withApi(
			(api, ids) =>
				api.applyFieldOp(
					{ type: "Locations", locations: ids, name: null },
					{ kind: "delete", keys: ["a"] },
					true,
				),
			ids,
		);
		expect(cleared.changed).toBe(2);
		expect((await getLoc(ids[0])).extra?.a).toBeUndefined();
		expect((await getLoc(ids[2])).extra?.b).toBe(1);
	});
});
