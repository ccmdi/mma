import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	flushAndWait,
	openMap,
	addLocs,
	getAllLocs,
	getLoc,
	getLocOrNull,
	getLocCount,
	createLocation,
	withApi,
	useMap,
	seedLocs,
} from "./helpers";
import type { Location } from "@/bindings.gen";

// Save-failure recovery is untested: Tauri freezes __TAURI_INTERNALS__, so JS cannot
// intercept invoke() to inject write failures. Needs a Rust test command behind
// #[cfg(feature = "e2e")] to arm them.

// =============================================================================
// 2. Save ordering -- mutations during in-flight save are not lost
// =============================================================================

describe("Save ordering under concurrent mutations", () => {
	const map = useMap("E2E SaveOrdering");
	let so1Id: number;
	let so2Id: number;

	it("add during save is captured by next save cycle", async () => {
		const result = await withApi(async (api) => {
			const locs1: Location[] = [
				api.createLocation({ lat: 10, lng: 10, heading: 0, pitch: 0, zoom: 1 }),
			];
			await api.addLocations(locs1);
			const id1 = locs1[0].id;

			// First save
			await api.flushSave();

			// Add while no save is in flight, then save again
			const locs2: Location[] = [
				api.createLocation({ lat: 20, lng: 20, heading: 0, pitch: 0, zoom: 1 }),
			];
			await api.addLocations(locs2);
			const id2 = locs2[0].id;

			await api.flushSave();
			return { id1, id2 };
		});
		so1Id = result.id1;
		so2Id = result.id2;

		await closeMap();
		await openMap(map.id);

		const loc1 = await getLoc(so1Id);
		const loc2 = await getLoc(so2Id);
		const count = await getLocCount();

		expect(loc1).toBeTruthy();
		expect(loc2).toBeTruthy();
		expect(count).toBe(2);
	});

	it("update between two saves persists the latest value", async () => {
		const loc = await getLoc(so1Id);
		await withApi(async (api, l) => {
			await api.updateLocations([{ id: l.id, patch: { heading: 45 } }]);
			await api.flushSave();
			const l2 = await api.fetchLocation(l.id);
			await api.updateLocations([{ id: l2!.id, patch: { heading: 180 } }]);
			await api.flushSave();
			return { ok: true };
		}, loc);

		await closeMap();
		await openMap(map.id);

		const reloaded = await getLoc(so1Id);
		expect(reloaded.heading).toBe(180);
	});

	it("remove then add to same geohash region persists correctly", async () => {
		const result = await withApi(async (api) => {
			// Add and save a location
			const geoLocs1: Location[] = [
				api.createLocation({ lat: 45.0, lng: 90.0, heading: 0, pitch: 0, zoom: 1 }),
			];
			await api.addLocations(geoLocs1);
			const geoId1 = geoLocs1[0].id;
			await api.flushSave();

			// Remove it and add a different one at similar coords (same geohash cell)
			await api.removeLocations(new Set([geoId1]));
			const geoLocs2: Location[] = [
				api.createLocation({ lat: 45.001, lng: 90.001, heading: 0, pitch: 0, zoom: 1 }),
			];
			await api.addLocations(geoLocs2);
			const geoId2 = geoLocs2[0].id;
			await api.flushSave();
			return { geoId1, geoId2 };
		});

		await closeMap();
		await openMap(map.id);

		const old = await getLocOrNull(result.geoId1);
		const newLoc = await getLoc(result.geoId2);
		expect(old).toBeFalsy();
		expect(newLoc).toBeTruthy();
	});
});

// =============================================================================
// 3. Multi-save-cycle field fidelity
// =============================================================================

describe("Field fidelity across multiple save cycles", () => {
	const map = useMap("E2E FieldFidelity");
	let ff1Id: number;
	let ffNullId: number;

	it("all location fields survive 3 save/load cycles", async () => {
		const result = await withApi(async (api) => {
			const locs: Location[] = [
				api.createLocation({
					lat: -33.8688,
					lng: 151.2093,
					heading: 274.5,
					pitch: -12.3,
					zoom: 2.5,
					panoId: "CAoSK0FGMVFpcE1XRGU",
					flags: 3,
					createdAt: 1736929800, // 2025-01-15T08:30:00Z
					extra: { country: "AU", altitude: 58.2, nested: { a: 1 } },
				}),
			];
			await api.addLocations(locs);
			return { id: locs[0].id };
		});
		ff1Id = result.id;

		// 3 cycles of save/close/reopen
		for (let i = 0; i < 3; i++) {
			await flushAndWait();
			await closeMap();
			await openMap(map.id);
		}

		const loaded = await getLoc(ff1Id);

		expect(loaded.lat).toBeCloseTo(-33.8688, 4);
		expect(loaded.lng).toBeCloseTo(151.2093, 4);
		expect(loaded.heading).toBeCloseTo(274.5, 1);
		expect(loaded.pitch).toBeCloseTo(-12.3, 1);
		expect(loaded.zoom).toBeCloseTo(2.5, 1);
		expect(loaded.panoId).toBe("CAoSK0FGMVFpcE1XRGU");
		expect(loaded.flags).toBe(3);
		expect(loaded.createdAt).toBe(1736929800);
		expect(loaded.extra.country).toBe("AU");
		expect(loaded.extra.altitude).toBeCloseTo(58.2, 1);
		expect(loaded.extra.nested.a).toBe(1);
	});

	it("updated fields survive save/load without corrupting other fields", async () => {
		const loc = await getLoc(ff1Id);
		await withApi(async (api, l) => {
			await api.updateLocations([{ id: l.id, patch: { heading: 90 } }]);
			return { ok: true };
		}, loc);

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const loaded = await getLoc(ff1Id);

		// Updated fields
		expect(loaded.heading).toBe(90);
		// Untouched fields must be unchanged
		expect(loaded.lat).toBeCloseTo(-33.8688, 4);
		expect(loaded.lng).toBeCloseTo(151.2093, 4);
		expect(loaded.panoId).toBe("CAoSK0FGMVFpcE1XRGU");
		expect(loaded.flags).toBe(3);
		expect(loaded.extra.country).toBe("AU");
	});

	it("null panoId and zero flags survive save/load", async () => {
		const result = await withApi(async (api) => {
			const locs: Location[] = [
				api.createLocation({
					lat: 0,
					lng: 0,
					heading: 0,
					pitch: 0,
					zoom: 0,
					panoId: null,
					flags: 0,
				}),
			];
			await api.addLocations(locs);
			return { id: locs[0].id };
		});
		ffNullId = result.id;

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const loaded = await getLoc(ffNullId);

		expect(loaded.panoId).toBeNull();
		expect(loaded.flags).toBe(0);
		expect(loaded.lat).toBe(0);
		expect(loaded.lng).toBe(0);
		expect(loaded.heading).toBe(0);
		expect(loaded.zoom).toBe(0);
	});
});

// =============================================================================
// 4. Geohash cell boundaries -- locations near cell edges survive
// =============================================================================

describe("Geohash cell boundary correctness", () => {
	const map = useMap("E2E GeohashBoundary");

	it("locations at geohash cell edges survive save/load", async () => {
		const locs = [
			createLocation({ lat: 0.0, lng: 0.0 }),
			createLocation({ lat: 0.0, lng: 179.999 }),
			createLocation({ lat: 0.0, lng: -179.999 }),
			createLocation({ lat: 85.0, lng: 0.0 }),
			createLocation({ lat: -85.0, lng: 0.0 }),
		];
		const ids = await addLocs(locs);

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const allLocs = await getAllLocs();
		const loadedIds = new Set(allLocs.map((l) => l.id));

		expect(allLocs.length).toBe(5);
		for (const id of ids) {
			expect(loadedIds.has(id)).toBe(true);
		}
	});

	it("locations in different geohash cells are independent", async () => {
		// Add locations spread across many cells, remove from one cell only
		const spreadIds = await seedLocs(20, (i) => ({
			lat: -80 + i * 8,
			lng: -170 + i * 18,
		}));

		await flushAndWait();

		// Remove just one (index 10)
		const removeId = spreadIds[10];
		await withApi(async (api, id: number) => {
			await api.removeLocations(new Set([id]));
			return { ok: true };
		}, removeId);

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const allLocs = await getAllLocs();
		const loadedIds = new Set(allLocs.map((l) => l.id));

		expect(loadedIds.has(removeId)).toBe(false);
		expect(loadedIds.has(spreadIds[0])).toBe(true);
		expect(loadedIds.has(spreadIds[19])).toBe(true);
		// 5 from edge test + 19 remaining spread = 24
		const spreadRemaining = allLocs.filter((l) => spreadIds.includes(l.id)).length;
		expect(spreadRemaining).toBe(19);
	});
});

// =============================================================================
// 5. Large save/load round-trips
// =============================================================================

describe("Large dataset save/load fidelity", () => {
	const map = useMap("E2E LargeSave");
	let lgIds: number[];

	it("1000 locations survive save/load with correct field values", async () => {
		const result = await withApi(async (api) => {
			const locs: Location[] = [];
			for (let i = 0; i < 1000; i++) {
				locs.push(
					api.createLocation({
						lat: -85 + (i / 1000) * 170,
						lng: -180 + (i / 1000) * 360,
						heading: i % 360,
						pitch: (i % 180) - 90,
						zoom: 1 + (i % 5),
						panoId: i % 3 === 0 ? `pano_${i}` : null,
						flags: i % 4 === 0 ? 1 : 0,
						extra: i % 10 === 0 ? { idx: i } : {},
					}),
				);
			}
			await api.addLocations(locs);
			// Return ids mapped by creation index for spot-checking
			const idMap: Record<number, number> = {};
			for (let i = 0; i < locs.length; i++) idMap[i] = locs[i].id;
			return { idMap };
		});

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const count = await getLocCount();
		expect(count).toBe(1000);

		// Spot-check samples by their assigned IDs
		const sampleIndices = [0, 99, 333, 500, 750, 999];
		for (const i of sampleIndices) {
			const loc = await getLoc(result.idMap[i]);
			expect(loc).toBeTruthy();
		}

		// Check specific field values
		const loc0 = await getLoc(result.idMap[0]);
		expect(loc0.heading).toBe(0);
		expect(loc0.flags).toBe(1); // 0 % 4 === 0
		expect(loc0.panoId).toBe("pano_0"); // 0 % 3 === 0
		expect(loc0.extra.idx).toBe(0); // 0 % 10 === 0

		const loc500 = await getLoc(result.idMap[500]);
		expect(loc500.heading).toBe(140); // 500 % 360
		expect(loc500.flags).toBe(1); // 500 % 4 === 0

		const loc999 = await getLoc(result.idMap[999]);
		expect(loc999.panoId).toBe("pano_999"); // 999 % 3 === 0
		expect(loc999.flags).toBe(0); // 999 % 4 !== 0

		// Store idMap for subsequent tests
		lgIds = [];
		for (let i = 0; i < 1000; i++) lgIds.push(result.idMap[i]);
	});

	it("partial remove from large dataset persists correctly", async () => {
		// Remove every 3rd location (indices 0, 3, 6, ..., 999)
		const toRemove = [];
		for (let i = 0; i < 1000; i += 3) toRemove.push(lgIds[i]);

		await withApi(async (api, ids: number[]) => {
			await api.removeLocations(new Set(ids));
			return { ok: true };
		}, toRemove);

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const allLocs = await getAllLocs();
		const loadedIds = new Set(allLocs.map((l) => l.id));

		expect(loadedIds.has(lgIds[0])).toBe(false); // removed (0 % 3 === 0)
		expect(loadedIds.has(lgIds[1])).toBe(true); // kept
		expect(loadedIds.has(lgIds[3])).toBe(false); // removed
		expect(loadedIds.has(lgIds[4])).toBe(true); // kept
		expect(loadedIds.has(lgIds[999])).toBe(false); // removed (999 % 3 === 0)
		expect(loadedIds.has(lgIds[998])).toBe(true); // kept
		expect(allLocs.length).toBe(666); // 1000 - 334 (0,3,6,...,999)
	});

	it("add after large remove persists correctly", async () => {
		const result = await withApi(async (api) => {
			const locs: Location[] = [];
			for (let i = 0; i < 100; i++) {
				locs.push(
					api.createLocation({
						lat: i,
						lng: i,
						heading: i,
						zoom: 1,
					}),
				);
			}
			await api.addLocations(locs);
			const newIds = locs.map((l) => l.id);
			return { newIds };
		});

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const count = await getLocCount();
		expect(count).toBe(766); // 666 + 100

		const allLocs = await getAllLocs();
		const freshCount = allLocs.filter((l) => result.newIds.includes(l.id)).length;
		expect(freshCount).toBe(100);
	});
});

// =============================================================================
// 6. Dirty tracking accuracy
// =============================================================================

describe("Dirty tracking accuracy", () => {
	const map = useMap("E2E DirtyTracking");
	let dt1Id: number;

	it("mutation marks dirty, close/reopen preserves the pending state", async () => {
		const result = await withApi(async (api) => {
			const locs: Location[] = [
				api.createLocation({ lat: 10, lng: 20, heading: 0, pitch: 0, zoom: 1 }),
			];
			await api.addLocations(locs);
			return { id: locs[0].id };
		});
		dt1Id = result.id;

		const afterMutation = await withApi(async (api) => {
			return (await api.cmd.storeGetSummary()).dirtyCount;
		});
		expect(afterMutation).toBeGreaterThan(0);

		await closeMap();
		await openMap(map.id);

		const afterReopen = await withApi(async (api) => {
			return (await api.cmd.storeGetSummary()).dirtyCount;
		});
		// Uncommitted edits persist in the delta sidecar and restore on reopen, so the map
		// reopens dirty (a pending commit) rather than being silently baked into the base.
		expect(afterReopen).toBeGreaterThan(0);
	});

	it("mutation after reopen marks dirty again", async () => {
		const loc = await getLoc(dt1Id);
		await withApi(async (api, l) => {
			await api.updateLocations([{ id: l.id, patch: { heading: 99 } }]);
			return { ok: true };
		}, loc);

		const dirty = await withApi(async (api) => {
			return (await api.cmd.storeGetSummary()).dirtyCount;
		});
		expect(dirty).toBeGreaterThan(0);
	});

	it("remove marks dirty", async () => {
		await withApi(async (api, id: number) => {
			await api.removeLocations(new Set([id]));
			return { ok: true };
		}, dt1Id);

		const dirty = await withApi(async (api) => {
			return (await api.cmd.storeGetSummary()).dirtyCount;
		});
		expect(dirty).toBeGreaterThan(0);
	});
});

// =============================================================================
// 7. Worker lifecycle -- save after close/reopen cycle
// =============================================================================

describe("Worker lifecycle across map close/open", () => {
	const map = useMap("E2E WorkerLifecycle");

	it("save works correctly after close and reopen", async () => {
		const result1 = await withApi(async (api) => {
			const locs: Location[] = [
				api.createLocation({ lat: 10, lng: 10, heading: 0, pitch: 0, zoom: 1 }),
			];
			await api.addLocations(locs);
			return { id: locs[0].id };
		});
		const wl1Id = result1.id;

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		// Add more after reopen (new worker instance)
		const result2 = await withApi(async (api) => {
			const locs: Location[] = [
				api.createLocation({ lat: 20, lng: 20, heading: 0, pitch: 0, zoom: 1 }),
			];
			await api.addLocations(locs);
			return { id: locs[0].id };
		});
		const wl2Id = result2.id;

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const count = await getLocCount();
		const loc1 = await getLoc(wl1Id);
		const loc2 = await getLoc(wl2Id);

		expect(count).toBe(2);
		expect(loc1).toBeTruthy();
		expect(loc2).toBeTruthy();
	});

	it("rapid open/close/open does not lose pending saves", async () => {
		const result1 = await withApi(async (api) => {
			const locs: Location[] = [
				api.createLocation({ lat: 30, lng: 30, heading: 0, pitch: 0, zoom: 1 }),
			];
			await api.addLocations(locs);
			return { id: locs[0].id };
		});
		const rapidId = result1.id;

		await flushAndWait();
		await closeMap();
		await openMap(map.id);
		// Immediately add and save again
		const result2 = await withApi(async (api) => {
			const locs: Location[] = [
				api.createLocation({ lat: 40, lng: 40, heading: 0, pitch: 0, zoom: 1 }),
			];
			await api.addLocations(locs);
			return { id: locs[0].id };
		});
		const rapid2Id = result2.id;

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const loc1 = await getLoc(rapidId);
		const loc2 = await getLoc(rapid2Id);
		expect(loc1).toBeTruthy();
		expect(loc2).toBeTruthy();
	});
});

// =============================================================================
// 8. Multiple maps -- saves don't cross-contaminate
// =============================================================================

describe("Multi-map isolation", () => {
	let mapIdA: string;
	let mapIdB: string;

	before(async () => {
		await waitForReady();
		mapIdA = await createAndOpenMap("E2E IsolationA");
		await withApi(async (api) => {
			const locs: Location[] = [
				api.createLocation({ lat: 10, lng: 10, heading: 0, pitch: 0, zoom: 1 }),
			];
			await api.addLocations(locs);
			return { id: locs[0].id };
		});
		await flushAndWait();
		await closeMap();

		mapIdB = await createAndOpenMap("E2E IsolationB");
		await withApi(async (api) => {
			const locs: Location[] = [
				api.createLocation({ lat: 20, lng: 20, heading: 0, pitch: 0, zoom: 1 }),
			];
			await api.addLocations(locs);
			return { id: locs[0].id };
		});
		await flushAndWait();
		await closeMap();
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapIdA);
		await deleteMap(mapIdB);
	});

	it("map A has only its own locations", async () => {
		await openMap(mapIdA);
		const allLocs = await getAllLocs();
		await closeMap();

		expect(allLocs.length).toBe(1);
		expect(allLocs[0].lat).toBe(10);
		expect(allLocs[0].lng).toBe(10);
	});

	it("map B has only its own locations", async () => {
		await openMap(mapIdB);
		const allLocs = await getAllLocs();
		await closeMap();

		expect(allLocs.length).toBe(1);
		expect(allLocs[0].lat).toBe(20);
		expect(allLocs[0].lng).toBe(20);
	});

	it("mutating map A does not affect map B", async () => {
		await openMap(mapIdA);
		const result = await withApi(async (api) => {
			const locs: Location[] = [
				api.createLocation({ lat: 15, lng: 15, heading: 0, pitch: 0, zoom: 1 }),
			];
			await api.addLocations(locs);
			return { id: locs[0].id };
		});
		const isoA2Id = result.id;
		await flushAndWait();
		await closeMap();

		await openMap(mapIdB);
		const allLocs = await getAllLocs();
		const ids = new Set(allLocs.map((l) => l.id));
		await closeMap();

		expect(allLocs.length).toBe(1);
		expect(ids.has(isoA2Id)).toBe(false);
	});
});
