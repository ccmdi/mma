/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Delete side-effects: verify that removing locations propagates state correctly
 * beyond just "the location is gone." Covers dirty count, metadata, active location,
 * selection sync, and tag counts.
 */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	createLocation,
	createTag,
	getLocOrNull,
	getLocCount,
	refreshSelections,
	flushAndWait,
	openLocation,
	withApi,
} from "./helpers";
import type { Location } from "@/types";

// ============================================================================
// 1. Delete updates dirty count
// ============================================================================

describe("Delete marks store dirty", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Delete Dirty");
		const locs: Location[] = [];
		for (let i = 0; i < 5; i++) locs.push(createLocation({ lat: i, lng: i }));
		locIds = await addLocs(locs);
		await flushAndWait();
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("store is dirty after delete", async () => {
		await withApi(async (api, id) => {
			api.removeLocations(new Set([id]));
		}, locIds[0]);
		await browser.pause(500);

		// dirtyCount is 0-or-1 (boolean flag from Rust)
		const dirty = await withApi(async (api) => api.getDirtyCount());
		expect(dirty).toBe(1);
	});
});

// ============================================================================
// 2. Delete updates location count in metadata
// ============================================================================

describe("Delete updates location count", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Delete LocCount");
		const locs: Location[] = [];
		for (let i = 0; i < 10; i++) locs.push(createLocation({ lat: i, lng: i }));
		locIds = await addLocs(locs);
		await flushAndWait();
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("location count decreases by 1 after single delete", async () => {
		const before = await getLocCount();
		await withApi(async (api, id) => {
			api.removeLocations(new Set([id]));
		}, locIds[0]);
		await browser.pause(300);

		const after = await getLocCount();
		expect(after).toBe(before - 1);
	});

	it("location count decreases by N after batch delete", async () => {
		const before = await getLocCount();
		const toDelete = locIds.slice(1, 4);
		await withApi(async (api, ids) => {
			api.removeLocations(new Set(ids));
		}, toDelete);
		await browser.pause(300);

		const after = await getLocCount();
		expect(after).toBe(before - 3);
	});

	it("deleted locations are actually gone", async () => {
		const loc = await getLocOrNull(locIds[0]);
		expect(loc).toBeNull();
	});
});

// ============================================================================
// 3. Delete clears active location if it was the deleted one
// ============================================================================

describe("Delete clears active location", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Delete Active");
		const locs: Location[] = [];
		for (let i = 0; i < 5; i++) locs.push(createLocation({ lat: i * 10, lng: i * 10 }));
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("active location cleared when it is deleted", async () => {
		await openLocation(locIds[0]);
		const activeBefore = await withApi(async (api) => api.getActiveLocation()?.id ?? null);
		expect(activeBefore).toBe(locIds[0]);

		await withApi(async (api, id) => {
			api.removeLocations(new Set([id]));
		}, locIds[0]);
		await browser.pause(300);

		const activeAfter = await withApi(async (api) => api.getActiveLocation()?.id ?? null);
		expect(activeAfter).toBeNull();
	});

	it("work area returns to overview when active is deleted", async () => {
		await openLocation(locIds[1]);
		const areaBefore = await withApi(async (api) => api.getWorkArea());
		expect(areaBefore).toBe("location");

		await withApi(async (api, id) => {
			api.removeLocations(new Set([id]));
		}, locIds[1]);
		await browser.pause(300);

		const areaAfter = await withApi(async (api) => api.getWorkArea());
		expect(areaAfter).toBe("overview");
	});

	it("deleting a non-active location does NOT clear active", async () => {
		await openLocation(locIds[2]);

		await withApi(async (api, id) => {
			api.removeLocations(new Set([id]));
		}, locIds[3]);
		await browser.pause(300);

		const activeAfter = await withApi(async (api) => api.getActiveLocation()?.id ?? null);
		expect(activeAfter).toBe(locIds[2]);
	});
});

// ============================================================================
// 4. Delete syncs with active selections
// ============================================================================

describe("Delete syncs with selections", () => {
	let mapId: string;
	let tagId: number;
	let taggedIds: number[];
	let untaggedIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Delete Selections");
		const tag = await createTag("DelSelTag");
		tagId = tag.id;

		const tagged: Location[] = [];
		for (let i = 0; i < 5; i++) tagged.push(createLocation({ lat: i, lng: i, tags: [tagId] }));
		taggedIds = await addLocs(tagged);

		const untagged: Location[] = [];
		for (let i = 10; i < 15; i++) untagged.push(createLocation({ lat: i, lng: i }));
		untaggedIds = await addLocs(untagged);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("tag selection count decreases when tagged location is deleted", async () => {
		await withApi(async (api, tid) => api.selectTag(tid), tagId);
		const before = await refreshSelections();
		expect(before.length).toBe(5);

		await withApi(async (api, id) => {
			api.removeLocations(new Set([id]));
		}, taggedIds[0]);
		await browser.pause(300);

		const after = await refreshSelections();
		expect(after.length).toBe(4);
	});

	it("Everything selection count decreases on delete", async () => {
		await withApi(async (api) => api.selectEverything());
		const before = await refreshSelections();

		await withApi(async (api, id) => {
			api.removeLocations(new Set([id]));
		}, untaggedIds[0]);
		await browser.pause(300);

		const after = await refreshSelections();
		expect(after.length).toBe(before.length - 1);
	});
});

// ============================================================================
// 5. Delete updates tag counts
// ============================================================================

describe("Delete updates tag counts", () => {
	let mapId: string;
	let tagId: number;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Delete TagCounts");
		const tag = await createTag("CountTag");
		tagId = tag.id;

		const locs: Location[] = [];
		for (let i = 0; i < 8; i++) locs.push(createLocation({ lat: i, lng: i, tags: [tagId] }));
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("tag count starts correct", async () => {
		const count = await withApi(async (api, tid) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(8);
	});

	it("tag count decreases after deleting tagged location", async () => {
		await withApi(async (api, id) => {
			api.removeLocations(new Set([id]));
		}, locIds[0]);
		await browser.pause(300);

		const count = await withApi(async (api, tid) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(7);
	});

	it("tag count decreases correctly after batch delete", async () => {
		const toDelete = locIds.slice(1, 4);
		await withApi(async (api, ids) => {
			api.removeLocations(new Set(ids));
		}, toDelete);
		await browser.pause(300);

		const count = await withApi(async (api, tid) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(4);
	});
});
