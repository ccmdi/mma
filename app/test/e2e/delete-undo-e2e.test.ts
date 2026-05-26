/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Delete + undo end-to-end: the #1 scenario where state gets out of sync.
 * Delete tagged/selected/active locations, undo, and verify everything
 * (tag counts, selections, active location, dirty state) is fully restored.
 */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	createLocation,
	createTag,
	getLoc,
	getLocOrNull,
	getLocCount,
	refreshSelections,
	withApi,
} from "./helpers";
import type { Location } from "@/types";

// ============================================================================
// 1. Delete tagged location + undo restores tag count
// ============================================================================

describe("Delete tagged location + undo", () => {
	let mapId: string;
	let tagId: number;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E DelUndo Tagged");
		const tag = await createTag("UndoTag");
		tagId = tag.id;

		const locs: Location[] = [];
		for (let i = 0; i < 5; i++) locs.push(createLocation({ lat: i, lng: i, tags: [tagId] }));
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("delete reduces tag count", async () => {
		await withApi(async (api, id) => {
			api.removeLocations(new Set([id]));
		}, locIds[0]);
		await browser.pause(300);

		const count = await withApi(async (api, tid) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(4);
	});

	it("undo restores tag count", async () => {
		await withApi(async (api) => api.undo());

		const count = await withApi(async (api, tid) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(5);
	});

	it("undone location still has its tag", async () => {
		const loc = await getLoc(locIds[0]);
		expect(loc.tags).toContain(tagId);
	});

	it("redo re-deletes and tag count drops again", async () => {
		await withApi(async (api) => api.redo());

		const count = await withApi(async (api, tid) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(4);
	});
});

// ============================================================================
// 2. Delete selected locations + undo restores selection
// ============================================================================

describe("Delete selected locations + undo restores selection", () => {
	let mapId: string;
	let tagId: number;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E DelUndo Selection");
		const tag = await createTag("SelTag");
		tagId = tag.id;

		const locs: Location[] = [];
		for (let i = 0; i < 8; i++) locs.push(createLocation({ lat: i, lng: i, tags: [tagId] }));
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("select tag, delete 2 selected locations, selection count drops", async () => {
		await withApi(async (api, tid) => api.selectTag(tid), tagId);
		const before = await refreshSelections();
		expect(before.length).toBe(8);

		await withApi(async (api, ids) => {
			api.removeLocations(new Set(ids));
		}, [locIds[0], locIds[1]]);
		await browser.pause(300);

		const after = await refreshSelections();
		expect(after.length).toBe(6);
	});

	it("undo restores selection count", async () => {
		await withApi(async (api) => api.undo());

		const ids = await refreshSelections();
		expect(ids.length).toBe(8);
	});

	it("undone locations are back in the selection", async () => {
		const ids = await refreshSelections();
		expect(ids).toContain(locIds[0]);
		expect(ids).toContain(locIds[1]);
	});
});

// ============================================================================
// 3. Delete active location + undo restores it
// ============================================================================

describe("Delete active location + undo", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E DelUndo Active");
		const locs: Location[] = [];
		for (let i = 0; i < 5; i++) locs.push(createLocation({ lat: i * 10, lng: i * 10 }));
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("delete active location clears active and work area", async () => {
		await withApi(async (api, lid) => api.setActiveLocation(lid, false), locIds[2]);
		await browser.pause(500);
		const activeBefore = await withApi(async (api) => api.getActiveLocation()?.id ?? null);
		expect(activeBefore).toBe(locIds[2]);

		await withApi(async (api, id) => {
			api.removeLocations(new Set([id]));
		}, locIds[2]);
		await browser.pause(300);

		const activeAfter = await withApi(async (api) => api.getActiveLocation()?.id ?? null);
		expect(activeAfter).toBeNull();

		const area = await withApi(async (api) => api.getWorkArea());
		expect(area).toBe("overview");
	});

	it("undo restores the deleted location", async () => {
		await withApi(async (api) => api.undo());

		const loc = await getLocOrNull(locIds[2]);
		expect(loc).not.toBeNull();
		expect(loc!.lat).toBeCloseTo(20, 2);
	});

	it("location count is restored after undo", async () => {
		const count = await getLocCount();
		expect(count).toBe(5);
	});
});

// ============================================================================
// 4. Batch delete + undo: all locations restored with correct data
// ============================================================================

describe("Batch delete + undo data fidelity", () => {
	let mapId: string;
	let tagId: number;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Batch DelUndo");
		const tag = await createTag("BatchTag");
		tagId = tag.id;

		const locs: Location[] = [];
		for (let i = 0; i < 10; i++) {
			locs.push(createLocation({
				lat: i * 5,
				lng: i * 10,
				heading: i * 36,
				tags: i < 5 ? [tagId] : [],
				panoId: i % 2 === 0 ? `pano_${i}` : null,
			}));
		}
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("batch delete 5 locations", async () => {
		const toDelete = locIds.slice(0, 5);
		await withApi(async (api, ids) => {
			api.removeLocations(new Set(ids));
		}, toDelete);
		await browser.pause(300);

		const count = await getLocCount();
		expect(count).toBe(5);
	});

	it("tag count correct after batch delete", async () => {
		const count = await withApi(async (api, tid) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(0);
	});

	it("undo restores all 5 with correct data", async () => {
		await withApi(async (api) => api.undo());

		const count = await getLocCount();
		expect(count).toBe(10);

		// Verify data fidelity on restored locations
		for (let i = 0; i < 5; i++) {
			const loc = await getLoc(locIds[i]);
			expect(loc.lat).toBeCloseTo(i * 5, 2);
			expect(loc.lng).toBeCloseTo(i * 10, 2);
			expect(loc.heading).toBeCloseTo(i * 36, 2);
			expect(loc.tags).toContain(tagId);
			if (i % 2 === 0) {
				expect(loc.panoId).toBe(`pano_${i}`);
			} else {
				expect(loc.panoId).toBeNull();
			}
		}
	});

	it("tag count restored after undo", async () => {
		const count = await withApi(async (api, tid) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(5);
	});
});

// NOTE: "Delete + undo persistence across save/load" is covered by undo-redo.test.ts
// (undo history survives save/load). The close/reopen cycle here triggers a known
// Rust panic-abort issue with the e2e binary, so we skip the redundant coverage.

// ============================================================================
// 6. Multiple delete-undo cycles don't corrupt state
// ============================================================================

describe("Multiple delete-undo cycles", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E DelUndo Cycles");
		const locs: Location[] = [];
		for (let i = 0; i < 10; i++) locs.push(createLocation({ lat: i, lng: i }));
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("5 cycles of delete-undo leave data intact", async () => {
		for (let cycle = 0; cycle < 5; cycle++) {
			const targetId = locIds[cycle % locIds.length];

			await withApi(async (api, id) => {
				api.removeLocations(new Set([id]));
			}, targetId);
			await browser.pause(200);

			const countAfterDelete = await getLocCount();
			expect(countAfterDelete).toBe(9);

			await withApi(async (api) => api.undo());

			const countAfterUndo = await getLocCount();
			expect(countAfterUndo).toBe(10);
		}
	});

	it("all locations still have correct coordinates after cycles", async () => {
		for (let i = 0; i < 10; i++) {
			const loc = await getLoc(locIds[i]);
			expect(loc.lat).toBeCloseTo(i, 2);
			expect(loc.lng).toBeCloseTo(i, 2);
		}
	});
});
