/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	createLocation,
	createTag,
	refreshSelections,
	withApi,
	useMap,
	seedLocs,
	select,
	tagSelector,
} from "./helpers";
import type { Location } from "@/bindings.gen";

// ============================================================================
// 1. Bulk add across multiple tags — bitmap/count agreement
// ============================================================================

describe("Bulk add 50 locations split across 3 tags", () => {
	useMap("E2E Tag Membership Bulk");
	let tagAId: number;
	let tagBId: number;
	let tagCId: number;

	before(async () => {
		const tA = await createTag("SplitA");
		tagAId = tA.id;
		const tB = await createTag("SplitB");
		tagBId = tB.id;
		const tC = await createTag("SplitC");
		tagCId = tC.id;

		await seedLocs(50, (i) => {
			const tags = i < 20 ? [tagAId] : i < 35 ? [tagBId] : [tagCId];
			return { lat: i * 0.01, lng: i * 0.01, tags };
		});
	});
	it("tagA count matches via getTagCounts", async () => {
		const count = await withApi(async (api, tid) => {
			const counts = api.getTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagAId);
		expect(count).toBe(20);
	});

	it("tagB count matches via getTagCounts", async () => {
		const count = await withApi(async (api, tid) => {
			const counts = api.getTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagBId);
		expect(count).toBe(15);
	});

	it("tagC count matches via getTagCounts", async () => {
		const count = await withApi(async (api, tid) => {
			const counts = api.getTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagCId);
		expect(count).toBe(15);
	});

	it("tagA selection returns exactly 20 ids", async () => {
		await select(tagSelector(tagAId));
		const ids = await refreshSelections();
		expect(ids.length).toBe(20);
		await withApi(async (api) => api.resetSelections());
	});

	it("tagB selection returns exactly 15 ids", async () => {
		await select(tagSelector(tagBId));
		const ids = await refreshSelections();
		expect(ids.length).toBe(15);
		await withApi(async (api) => api.resetSelections());
	});

	it("tagC selection returns exactly 15 ids", async () => {
		await select(tagSelector(tagCId));
		const ids = await refreshSelections();
		expect(ids.length).toBe(15);
		await withApi(async (api) => api.resetSelections());
	});
});

// ============================================================================
// 2. Remove tagged locations — selection shrinks
// ============================================================================

describe("Remove tagged locations shrinks tag selection", () => {
	useMap("E2E Tag Remove Shrink");
	let tagId: number;
	let locIds: number[];

	before(async () => {
		const tag = await createTag("Shrinkable");
		tagId = tag.id;

		locIds = await seedLocs(20, (i) => ({ lat: i * 0.01, lng: i * 0.01, tags: [tagId] }));
	});
	it("selection starts at 20", async () => {
		await select(tagSelector(tagId));
		const ids = await refreshSelections();
		expect(ids.length).toBe(20);
		await withApi(async (api) => api.resetSelections());
	});

	it("removing 5 locations drops selection to 15", async () => {
		const toRemove = locIds.slice(0, 5);
		await withApi(async (api, ids) => {
			await api.removeLocations(new Set(ids));
		}, toRemove);

		await select(tagSelector(tagId));
		const ids = await refreshSelections();
		expect(ids.length).toBe(15);
		await withApi(async (api) => api.resetSelections());
	});

	it("tag count agrees with selection after removal", async () => {
		const count = await withApi(async (api, tid) => {
			const counts = api.getTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(15);
	});
});

// ============================================================================
// 3. Undo bulk remove restores tag membership
// ============================================================================

describe("Undo bulk remove restores tag membership", () => {
	useMap("E2E Tag Undo Remove");
	let tagId: number;
	let locIds: number[];

	before(async () => {
		const tag = await createTag("UndoRemove");
		tagId = tag.id;

		locIds = await seedLocs(12, (i) => ({ lat: i * 0.01, lng: i * 0.01, tags: [tagId] }));
	});
	it("remove 6 locations then undo restores count to 12", async () => {
		const toRemove = locIds.slice(0, 6);
		await withApi(async (api, ids) => {
			await api.removeLocations(new Set(ids));
		}, toRemove);

		const afterRemove = await withApi(async (api, tid) => {
			const counts = api.getTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(afterRemove).toBe(6);

		await withApi(async (api) => api.undo());

		const afterUndo = await withApi(async (api, tid) => {
			const counts = api.getTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(afterUndo).toBe(12);
	});

	it("selection agrees with count after undo", async () => {
		await select(tagSelector(tagId));
		const ids = await refreshSelections();
		expect(ids.length).toBe(12);
		await withApi(async (api) => api.resetSelections());
	});

	it("redo re-applies the removal", async () => {
		await withApi(async (api) => api.redo());

		const count = await withApi(async (api, tid) => {
			const counts = api.getTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(6);

		await select(tagSelector(tagId));
		const ids = await refreshSelections();
		expect(ids.length).toBe(6);
		await withApi(async (api) => api.resetSelections());
	});
});

// ============================================================================
// 4. Add locations to existing tag — cumulative membership
// ============================================================================

describe("Add locations to existing tag accumulates membership", () => {
	useMap("E2E Tag Cumulative");
	let tagId: number;

	before(async () => {
		const tag = await createTag("Cumulative");
		tagId = tag.id;

		await seedLocs(10, (i) => ({ lat: i * 0.01, lng: i * 0.01, tags: [tagId] }));
	});
	it("initial batch: count is 10", async () => {
		const count = await withApi(async (api, tid) => {
			const counts = api.getTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(10);
	});

	it("adding 15 more grows count to 25", async () => {
		const batch2: Location[] = [];
		for (let i = 10; i < 25; i++) {
			batch2.push(createLocation({ lat: i * 0.01, lng: i * 0.01, tags: [tagId] }));
		}
		await addLocs(batch2);

		const count = await withApi(async (api, tid) => {
			const counts = api.getTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(25);
	});

	it("selection returns all 25", async () => {
		await select(tagSelector(tagId));
		const ids = await refreshSelections();
		expect(ids.length).toBe(25);
		await withApi(async (api) => api.resetSelections());
	});

	it("addTagToLocations on existing untagged locations grows count", async () => {
		const untagged: Location[] = [];
		for (let i = 25; i < 30; i++) {
			untagged.push(createLocation({ lat: i * 0.01, lng: i * 0.01 }));
		}
		const newIds = await addLocs(untagged);

		await withApi(
			async (api, tid, ids) => {
				await api.addTagToLocations(tid, ids);
			},
			tagId,
			newIds,
		);

		const count = await withApi(async (api, tid) => {
			const counts = api.getTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(30);

		await select(tagSelector(tagId));
		const ids = await refreshSelections();
		expect(ids.length).toBe(30);
		await withApi(async (api) => api.resetSelections());
	});
});

// ============================================================================
// 5. Multiple tags on same location — each tag includes it
// ============================================================================

describe("Multiple tags on same location", () => {
	useMap("E2E Tag Multi Membership");
	let tag1Id: number;
	let tag2Id: number;
	let tag3Id: number;
	let sharedIds: number[];

	before(async () => {
		const t1 = await createTag("Multi1");
		tag1Id = t1.id;
		const t2 = await createTag("Multi2");
		tag2Id = t2.id;
		const t3 = await createTag("Multi3");
		tag3Id = t3.id;

		sharedIds = await seedLocs(8, (i) => ({
			lat: i * 0.01,
			lng: i * 0.01,
			tags: [tag1Id, tag2Id, tag3Id],
		}));

		const exclusive: Location[] = [];
		for (let i = 8; i < 15; i++) {
			exclusive.push(createLocation({ lat: i * 0.01, lng: i * 0.01, tags: [tag1Id] }));
		}
		await addLocs(exclusive);
	});
	it("tag1 selection includes shared + exclusive = 15", async () => {
		await select(tagSelector(tag1Id));
		const ids = await refreshSelections();
		expect(ids.length).toBe(15);
		await withApi(async (api) => api.resetSelections());
	});

	it("tag2 selection includes only shared = 8", async () => {
		await select(tagSelector(tag2Id));
		const ids = await refreshSelections();
		expect(ids.length).toBe(8);
		await withApi(async (api) => api.resetSelections());
	});

	it("tag3 selection includes only shared = 8", async () => {
		await select(tagSelector(tag3Id));
		const ids = await refreshSelections();
		expect(ids.length).toBe(8);
		await withApi(async (api) => api.resetSelections());
	});

	it("removing tag2 from shared locations does not affect tag1 or tag3", async () => {
		await withApi(
			async (api, ids, tid) => {
				const locs = await Promise.all(ids.map((id: number) => api.fetchLocation(id)));
				const updates = locs.map((l: any) => ({
					id: l.id,
					patch: { tags: l.tags.filter((t: number) => t !== tid) },
				}));
				await api.updateLocations(updates);
			},
			sharedIds,
			tag2Id,
		);

		const tag2Count = await withApi(async (api, tid) => {
			const counts = api.getTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tag2Id);
		expect(tag2Count).toBe(0);

		await select(tagSelector(tag1Id));
		const tag1Ids = await refreshSelections();
		expect(tag1Ids.length).toBe(15);
		await withApi(async (api) => api.resetSelections());

		await select(tagSelector(tag3Id));
		const tag3Ids = await refreshSelections();
		expect(tag3Ids.length).toBe(8);
		await withApi(async (api) => api.resetSelections());
	});

	it("counts agree with selections after cross-tag mutation", async () => {
		const counts = (await withApi((api) => api.getTagCounts())) as any;
		expect(counts[String(tag1Id)]).toBe(15);
		expect(counts[String(tag2Id)] ?? 0).toBe(0);
		expect(counts[String(tag3Id)]).toBe(8);
	});
});

// ============================================================================
// 6. Full scene reset preserves selectedLocationIds (255ffb1)
// ============================================================================

describe("Full scene reset preserves selectedLocationIds", () => {
	let mapId: string;
	let tagId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E FullReset Selection");

		const tag = await createTag("ResetTag");
		tagId = tag.id;

		await seedLocs(150, (i) => ({ lat: i * 0.01, lng: i * 0.01, tags: [tagId] }));
	});

	after(async () => {
		await withApi(async (api) => api.resetSelections());
		await closeMap();
		await deleteMap(mapId);
	});

	it("undo of >100 add (full_reset) keeps selection count correct", async () => {
		await select(tagSelector(tagId));
		const beforeIds = await refreshSelections();
		expect(beforeIds.length).toBe(150);

		await withApi(async (api) => api.undo());

		const afterIds = await refreshSelections();
		expect(afterIds.length).toBe(0);
	});

	it("redo restores tag membership after full_reset", async () => {
		await withApi(async (api) => api.redo());

		const count = await withApi(async (api, tid) => {
			const counts = api.getTagCounts();
			return (counts as any)[String(tid)] ?? 0;
		}, tagId);
		expect(count).toBe(150);

		await select(tagSelector(tagId));
		const afterRedo = await refreshSelections();
		expect(afterRedo.length).toBe(150);
	});
});
