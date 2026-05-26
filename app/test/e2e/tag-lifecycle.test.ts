/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tag lifecycle: rename, delete cascade, verify no orphaned references,
 * tag count consistency, and tag operations through save/load cycles.
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
	getAllLocs,
	refreshSelections,
	flushAndWait,
	openMap,
	withApi,
} from "./helpers";
import type { Location } from "@/types";

// ============================================================================
// 1. Tag rename propagation
// ============================================================================

describe("Tag rename propagation", () => {
	let mapId: string;
	let tagId: number;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tag Rename");
		const tag = await createTag("OriginalName");
		tagId = tag.id;

		const locs: Location[] = [];
		for (let i = 0; i < 10; i++) locs.push(createLocation({ lat: i, lng: i, tags: [tagId] }));
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("renaming a tag updates metadata", async () => {
		await withApi(async (api, tid) => {
			await api.updateTags([{ id: tid, patch: { name: "RenamedTag" } }]);
		}, tagId);

		const name = await withApi(async (api, tid) => {
			const map = api.getCurrentMap();
			return (map!.meta.tags as any)[String(tid)]?.name;
		}, tagId);
		expect(name).toBe("RenamedTag");
	});

	it("locations still reference the same tag ID after rename", async () => {
		const loc = await getLoc(locIds[0]);
		expect(loc.tags).toContain(tagId);
	});

	it("tag count unchanged after rename", async () => {
		const count = await withApi(async (api, tid) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(10);
	});

	it("rename persists after save/close/reopen", async () => {
		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const name = await withApi(async (api, tid) => {
			const map = api.getCurrentMap();
			return (map!.meta.tags as any)[String(tid)]?.name;
		}, tagId);
		expect(name).toBe("RenamedTag");

		const loc = await getLoc(locIds[5]);
		expect(loc.tags).toContain(tagId);
	});

	it("tag selection still works after rename", async () => {
		await withApi(async (api, tid) => api.selectTag(tid), tagId);
		const ids = await refreshSelections();
		expect(ids.length).toBe(10);
		await withApi(async (api) => api.resetSelections());
	});
});

// ============================================================================
// 2. Tag delete removes references from all locations
// ============================================================================

describe("Tag delete cascade — no orphans", () => {
	let mapId: string;
	let tagAId: number;
	let tagBId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tag Cascade");
		const tagA = await createTag("TagA");
		tagAId = tagA.id;
		const tagB = await createTag("TagB");
		tagBId = tagB.id;

		const locs: Location[] = [];
		for (let i = 0; i < 10; i++) {
			const tags = i < 5 ? [tagAId, tagBId] : [tagAId];
			locs.push(createLocation({ lat: i, lng: i, tags }));
		}
		await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("before delete: all 10 locations have tagA", async () => {
		const count = await withApi(async (api, tid) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagAId);
		expect(count).toBe(10);
	});

	it("deleting tagA removes it from all locations", async () => {
		await withApi(async (api, tid) => api.deleteTags([tid]), tagAId);

		const allLocs = await getAllLocs();
		for (const loc of allLocs) {
			expect(loc.tags).not.toContain(tagAId);
		}
	});

	it("tagA count is 0 after delete", async () => {
		const count = await withApi(async (api, tid) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagAId);
		expect(count).toBe(0);
	});

	it("tagB still intact on the 5 locations that had it", async () => {
		const count = await withApi(async (api, tid) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagBId);
		expect(count).toBe(5);
	});

	it("tagA is hidden in metadata (visible=false)", async () => {
		// deleteTags keeps the tag entry but marks it invisible (for undo support)
		const visible = await withApi(async (api, tid) => {
			const map = api.getCurrentMap();
			const tag = (map!.meta.tags as any)[String(tid)];
			return tag?.visible ?? true;
		}, tagAId);
		expect(visible).toBe(false);
	});

	it("no orphans after save/close/reopen", async () => {
		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const allLocs = await getAllLocs();
		for (const loc of allLocs) {
			expect(loc.tags).not.toContain(tagAId);
		}

		const tagBCount = await withApi(async (api, tid) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagBId);
		expect(tagBCount).toBe(5);
	});
});

// ============================================================================
// 3. Tag delete + undo restores everything
// ============================================================================

describe("Tag delete + undo restores all references", () => {
	let mapId: string;
	let tagId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tag Delete Undo");
		const tag = await createTag("UndoMe");
		tagId = tag.id;

		const locs: Location[] = [];
		for (let i = 0; i < 8; i++) locs.push(createLocation({ lat: i, lng: i, tags: [tagId] }));
		await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("delete tag then undo restores tag visibility", async () => {
		await withApi(async (api, tid) => api.deleteTags([tid]), tagId);

		// Tag stays in metadata but is invisible after delete
		const afterDelete = await withApi(async (api, tid) => {
			const map = api.getCurrentMap();
			const tag = (map!.meta.tags as any)[String(tid)];
			return { visible: tag?.visible ?? true, name: tag?.name ?? null };
		}, tagId);
		expect(afterDelete.visible).toBe(false);

		await withApi(async (api) => api.undo());

		// After undo, tag should be visible again
		const afterUndo = await withApi(async (api, tid) => {
			const map = api.getCurrentMap();
			const tag = (map!.meta.tags as any)[String(tid)];
			return { visible: tag?.visible ?? false, name: tag?.name ?? null };
		}, tagId);
		expect(afterUndo.visible).toBe(true);
		expect(afterUndo.name).toBe("UndoMe");
	});

	it("undo restores tag references on all locations", async () => {
		const allLocs = await getAllLocs();
		for (const loc of allLocs) {
			expect(loc.tags).toContain(tagId);
		}
	});

	it("tag count restored after undo", async () => {
		const count = await withApi(async (api, tid) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(8);
	});

	it("tag selection works after undo", async () => {
		await withApi(async (api, tid) => api.selectTag(tid), tagId);
		const ids = await refreshSelections();
		expect(ids.length).toBe(8);
		await withApi(async (api) => api.resetSelections());
	});
});

// ============================================================================
// 4. Multiple tags: delete one, verify others unaffected
// ============================================================================

describe("Multi-tag delete isolation", () => {
	let mapId: string;
	let tag1Id: number;
	let tag2Id: number;
	let tag3Id: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Multi Tag");
		const t1 = await createTag("Keep1");
		tag1Id = t1.id;
		const t2 = await createTag("DeleteMe");
		tag2Id = t2.id;
		const t3 = await createTag("Keep2");
		tag3Id = t3.id;

		const locs: Location[] = [];
		for (let i = 0; i < 6; i++) {
			locs.push(createLocation({ lat: i, lng: i, tags: [tag1Id, tag2Id, tag3Id] }));
		}
		await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("deleting one tag leaves the other two intact", async () => {
		await withApi(async (api, tid) => api.deleteTags([tid]), tag2Id);

		const allLocs = await getAllLocs();
		for (const loc of allLocs) {
			expect(loc.tags).toContain(tag1Id);
			expect(loc.tags).toContain(tag3Id);
			expect(loc.tags).not.toContain(tag2Id);
			expect(loc.tags.length).toBe(2);
		}
	});

	it("surviving tag counts are correct", async () => {
		const counts = await withApi(async (api) => api.cmd.storeTagCounts()) as any;
		expect(counts[String(tag1Id)]).toBe(6);
		expect(counts[String(tag3Id)]).toBe(6);
		expect(counts[String(tag2Id)] ?? 0).toBe(0);
	});
});
