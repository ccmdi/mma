/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Delete side-effects: verify that removing locations propagates state correctly
 * beyond just "the location is gone." Covers dirty count, metadata, active location,
 * selection sync, and tag counts.
 */
import {
	addLocs,
	createLocation,
	createTag,
	getLocOrNull,
	getLocCount,
	refreshSelections,
	flushAndWait,
	openLocation,
	withApi,
	useMap,
	seedLocs,
	select,
} from "./helpers";
import type { Location } from "@/bindings.gen";

// ============================================================================
// 1. Delete updates dirty count
// ============================================================================

describe("Delete marks store dirty", () => {
	useMap("E2E Delete Dirty");
	let locIds: number[];

	before(async () => {
		locIds = await seedLocs(5, (i) => ({ lat: i, lng: i }));
		await flushAndWait();
	});
	it("store is dirty after delete", async () => {
		await withApi(async (api, id) => {
			await api.removeLocations(new Set([id]));
		}, locIds[0]);

		// dirtyCount is 0-or-1 (boolean flag from Rust)
		const dirty = await withApi(async (api) => (await api.cmd.storeGetSummary()).dirtyCount);
		expect(dirty).toBe(1);
	});
});

// ============================================================================
// 2. Delete updates location count in metadata
// ============================================================================

describe("Delete updates location count", () => {
	useMap("E2E Delete LocCount");
	let locIds: number[];

	before(async () => {
		locIds = await seedLocs(10, (i) => ({ lat: i, lng: i }));
		await flushAndWait();
	});
	it("location count decreases by 1 after single delete", async () => {
		const before = await getLocCount();
		await withApi(async (api, id) => {
			await api.removeLocations(new Set([id]));
		}, locIds[0]);

		const after = await getLocCount();
		expect(after).toBe(before - 1);
	});

	it("location count decreases by N after batch delete", async () => {
		const before = await getLocCount();
		const toDelete = locIds.slice(1, 4);
		await withApi(async (api, ids) => {
			await api.removeLocations(new Set(ids));
		}, toDelete);

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
	useMap("E2E Delete Active");
	let locIds: number[];

	before(async () => {
		locIds = await seedLocs(5, (i) => ({ lat: i * 10, lng: i * 10 }));
	});
	it("active location cleared when it is deleted", async () => {
		await openLocation(locIds[0]);
		const activeBefore = await withApi(async (api) => api.getMapState().activeLocation?.id ?? null);
		expect(activeBefore).toBe(locIds[0]);

		await withApi(async (api, id) => {
			await api.removeLocations(new Set([id]));
		}, locIds[0]);

		const activeAfter = await withApi(async (api) => api.getMapState().activeLocation?.id ?? null);
		expect(activeAfter).toBeNull();
	});

	it("work area returns to overview when active is deleted", async () => {
		await openLocation(locIds[1]);
		const areaBefore = await withApi(async (api) => api.getMapState().workArea);
		expect(areaBefore).toBe("location");

		await withApi(async (api, id) => {
			await api.removeLocations(new Set([id]));
		}, locIds[1]);

		const areaAfter = await withApi(async (api) => api.getMapState().workArea);
		expect(areaAfter).toBe("overview");
	});

	it("deleting a non-active location does NOT clear active", async () => {
		await openLocation(locIds[2]);

		await withApi(async (api, id) => {
			await api.removeLocations(new Set([id]));
		}, locIds[3]);

		const activeAfter = await withApi(async (api) => api.getMapState().activeLocation?.id ?? null);
		expect(activeAfter).toBe(locIds[2]);
	});
});

// ============================================================================
// 4. Delete syncs with active selections
// ============================================================================

describe("Delete syncs with selections", () => {
	useMap("E2E Delete Selections");
	let tagId: number;
	let taggedIds: number[];
	let untaggedIds: number[];

	before(async () => {
		const tag = await createTag("DelSelTag");
		tagId = tag.id;

		taggedIds = await seedLocs(5, (i) => ({ lat: i, lng: i, tags: [tagId] }));

		const untagged: Location[] = [];
		for (let i = 10; i < 15; i++) untagged.push(createLocation({ lat: i, lng: i }));
		untaggedIds = await addLocs(untagged);
	});
	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("tag selection count decreases when tagged location is deleted", async () => {
		await select({ type: "Tag", tagId });
		const before = await refreshSelections();
		expect(before.length).toBe(5);

		await withApi(async (api, id) => {
			await api.removeLocations(new Set([id]));
		}, taggedIds[0]);

		const after = await refreshSelections();
		expect(after.length).toBe(4);
	});

	it("Everything selection count decreases on delete", async () => {
		await select({ type: "Everything" });
		const before = await refreshSelections();

		await withApi(async (api, id) => {
			await api.removeLocations(new Set([id]));
		}, untaggedIds[0]);

		const after = await refreshSelections();
		expect(after.length).toBe(before.length - 1);
	});
});

// ============================================================================
// 5. Delete updates tag counts
// ============================================================================

describe("Delete updates tag counts", () => {
	useMap("E2E Delete TagCounts");
	let tagId: number;
	let locIds: number[];

	before(async () => {
		const tag = await createTag("CountTag");
		tagId = tag.id;

		locIds = await seedLocs(8, (i) => ({ lat: i, lng: i, tags: [tagId] }));
	});
	it("tag count starts correct", async () => {
		const count = await withApi(async (api, tid) => {
			const counts = api.getMapState().tagCounts;
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(8);
	});

	it("tag count decreases after deleting tagged location", async () => {
		await withApi(async (api, id) => {
			await api.removeLocations(new Set([id]));
		}, locIds[0]);

		const count = await withApi(async (api, tid) => {
			const counts = api.getMapState().tagCounts;
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(7);
	});

	it("tag count decreases correctly after batch delete", async () => {
		const toDelete = locIds.slice(1, 4);
		await withApi(async (api, ids) => {
			await api.removeLocations(new Set(ids));
		}, toDelete);

		const count = await withApi(async (api, tid) => {
			const counts = api.getMapState().tagCounts;
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(4);
	});
});
