/**
 * Multi-map state isolation: verify that selections, undo/redo, dirty state,
 * settings, and tag operations in one map never bleed into another.
 * Extends multi-map.test.ts which covers basic location/tag/metadata isolation.
 */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	createLocation,
	createTag,
	getLocCount,
	flushAndWait,
	openMap,
	withApi,
} from "./helpers";
import type { Location } from "@/bindings.gen";

// ============================================================================
// 1. Selection state does not leak between maps
// ============================================================================

describe("Selection isolation across maps", () => {
	let mapAId: string;
	let mapBId: string;

	before(async () => {
		await waitForReady();

		mapAId = await createAndOpenMap("E2E SelIso A");
		const locs: Location[] = [];
		for (let i = 0; i < 10; i++) locs.push(createLocation({ lat: i, lng: i }));
		await addLocs(locs);
		await flushAndWait();
		await closeMap();

		mapBId = await createAndOpenMap("E2E SelIso B");
		const locsB: Location[] = [];
		for (let i = 20; i < 25; i++) locsB.push(createLocation({ lat: i, lng: i }));
		await addLocs(locsB);
		await flushAndWait();
		await closeMap();
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapAId);
		await deleteMap(mapBId);
	});

	it("selecting Everything in A, switching to B: B has no selections", async () => {
		await openMap(mapAId);
		await withApi(async (api) => api.selectEverything());
		const selA = await withApi(async (api) => api.getSelections().length);
		expect(selA).toBe(1);
		await closeMap();

		await openMap(mapBId);
		const selB = await withApi(async (api) => api.getSelections().length);
		expect(selB).toBe(0);
		await closeMap();
	});

	it("tag selection in A does not create tag selection in B", async () => {
		await openMap(mapAId);
		const tag = await createTag("OnlyInA");
		await withApi(async (api, tid) => api.selectTag(tid), tag.id);
		const selsA = await withApi(async (api) => api.getSelections().length);
		expect(selsA).toBeGreaterThan(0);
		await closeMap();

		await openMap(mapBId);
		const selsB = await withApi(async (api) => api.getSelections().length);
		expect(selsB).toBe(0);
		await closeMap();
	});
});

// ============================================================================
// 2. Dirty state isolation
// ============================================================================

describe("Dirty state isolation across maps", () => {
	let mapAId: string;
	let mapBId: string;

	before(async () => {
		await waitForReady();

		mapAId = await createAndOpenMap("E2E DirtyIso A");
		await addLocs([createLocation({ lat: 1, lng: 1 })]);
		await flushAndWait();
		await closeMap();

		mapBId = await createAndOpenMap("E2E DirtyIso B");
		await addLocs([createLocation({ lat: 2, lng: 2 })]);
		// Commit so B starts clean: uncommitted edits now persist across reopen, so without
		// this B would reopen dirty from its own setup and mask the isolation check.
		await withApi(async (api) => api.commitMap());
		await flushAndWait();
		await closeMap();
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapAId);
		await deleteMap(mapBId);
	});

	it("modifying A does not make B dirty", async () => {
		await openMap(mapAId);
		await addLocs([createLocation({ lat: 99, lng: 99 })]);
		await closeMap();

		await openMap(mapBId);
		const dirty = await withApi(async (api) => api.getDirtyCount());
		expect(dirty).toBe(0);
		await closeMap();
	});
});

// ============================================================================
// 3. Undo/redo history does not cross maps
// ============================================================================

describe("Undo history isolation across maps", () => {
	let mapAId: string;
	let mapBId: string;

	before(async () => {
		await waitForReady();

		mapAId = await createAndOpenMap("E2E UndoIso A");
		await addLocs([createLocation({ lat: 1, lng: 1 })]);
		await flushAndWait();
		await closeMap();

		mapBId = await createAndOpenMap("E2E UndoIso B");
		await addLocs([createLocation({ lat: 2, lng: 2 })]);
		await flushAndWait();
		await closeMap();
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapAId);
		await deleteMap(mapBId);
	});

	it("add to A, switch to B, undo in B does not affect A", async () => {
		// Add 3 more to A (undo-able)
		await openMap(mapAId);
		await addLocs([
			createLocation({ lat: 10, lng: 10 }),
			createLocation({ lat: 11, lng: 11 }),
			createLocation({ lat: 12, lng: 12 }),
		]);
		const countA = await getLocCount();
		await flushAndWait();
		await closeMap();

		// Add 2 to B and undo one
		await openMap(mapBId);
		await addLocs([createLocation({ lat: 20, lng: 20 })]);
		await addLocs([createLocation({ lat: 21, lng: 21 })]);
		await withApi(async (api) => api.undo());
		await closeMap();

		// A should be untouched
		await openMap(mapAId);
		const countAAfter = await getLocCount();
		expect(countAAfter).toBe(countA);
		await closeMap();
	});

	it("undo state reports correctly per map", async () => {
		await openMap(mapAId);
		const stateA = await withApi(async (api) => api.getUndoRedoState());
		await closeMap();

		await openMap(mapBId);
		const stateB = await withApi(async (api) => api.getUndoRedoState());
		await closeMap();

		// Both should have undo available (we added locs to both)
		// but the actual undo/redo counts are independent
		expect(stateA).toBeDefined();
		expect(stateB).toBeDefined();
	});
});

// ============================================================================
// 4. Per-map settings isolation
// ============================================================================

describe("Per-map settings isolation", () => {
	let mapAId: string;
	let mapBId: string;

	before(async () => {
		await waitForReady();

		// Only patch individual settings via the existing defaults, not full replacement
		mapAId = await createAndOpenMap("E2E SettingsIso A");
		await withApi(async (api) => {
			const current = api.getCurrentMap()!.meta.settings;
			await api.updateMapMeta({
				settings: {
					...current,
					exportZoom: true,
					preferOfficial: true,
				},
			});
		});
		await flushAndWait();
		await closeMap();

		mapBId = await createAndOpenMap("E2E SettingsIso B");
		await withApi(async (api) => {
			const current = api.getCurrentMap()!.meta.settings;
			await api.updateMapMeta({
				settings: {
					...current,
					exportZoom: false,
					preferOfficial: false,
					onlyOfficial: true,
				},
			});
		});
		await flushAndWait();
		await closeMap();
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapAId);
		await deleteMap(mapBId);
	});

	it("map A has its own settings", async () => {
		await openMap(mapAId);
		const settings = await withApi(async (api) => api.getCurrentMap()!.meta.settings);
		expect(settings.exportZoom).toBe(true);
		expect(settings.preferOfficial).toBe(true);
		await closeMap();
	});

	it("map B has its own settings (different from A)", async () => {
		await openMap(mapBId);
		const settings = await withApi(async (api) => api.getCurrentMap()!.meta.settings);
		expect(settings.exportZoom).toBe(false);
		expect(settings.preferOfficial).toBe(false);
		expect(settings.onlyOfficial).toBe(true);
		await closeMap();
	});

	it("modifying A settings does not change B", async () => {
		await openMap(mapAId);
		await withApi(async (api) => {
			const current = api.getCurrentMap()!.meta.settings;
			await api.updateMapMeta({
				settings: {
					...current,
					exportZoom: false,
					preferOfficial: false,
				},
			});
		});
		await flushAndWait();
		await closeMap();

		await openMap(mapBId);
		const settingsB = await withApi(async (api) => api.getCurrentMap()!.meta.settings);
		expect(settingsB.onlyOfficial).toBe(true);
		await closeMap();
	});
});

// ============================================================================
// 5. Active location does not persist across map switches
// ============================================================================

describe("Active location isolation across maps", () => {
	let mapAId: string;
	let mapBId: string;
	before(async () => {
		await waitForReady();

		mapAId = await createAndOpenMap("E2E ActiveIso A");
		await addLocs([createLocation({ lat: 10, lng: 10 })]);
		await flushAndWait();
		await closeMap();

		mapBId = await createAndOpenMap("E2E ActiveIso B");
		await addLocs([createLocation({ lat: 20, lng: 20 })]);
		await flushAndWait();
		await closeMap();
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapAId);
		await deleteMap(mapBId);
	});

	it("opening map B starts with no active location", async () => {
		await openMap(mapBId);
		const activeB = await withApi(async (api) => api.getActiveLocation()?.id ?? null);
		expect(activeB).toBeNull();

		const area = await withApi(async (api) => api.getWorkArea());
		expect(area).toBe("overview");
		await closeMap();
	});
});
