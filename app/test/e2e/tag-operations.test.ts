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
	flushAndWait,
	openMap,
	withApi,
} from "./helpers";
import type { Location } from "@/types";

// ============================================================================
// 1. Tag reordering
// ============================================================================

describe("Tag reordering", () => {
	let mapId: string;
	let tag1Id: number;
	let tag2Id: number;
	let tag3Id: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tag Reorder");

		const t1 = await createTag("Alpha");
		tag1Id = t1.id;
		const t2 = await createTag("Beta");
		tag2Id = t2.id;
		const t3 = await createTag("Gamma");
		tag3Id = t3.id;
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("reorderTags changes tag order field", async () => {
		const result = await withApi(
			async (api, id1, id2, id3) => {
				await api.reorderTags([id3, id1, id2]);
				const map = api.getCurrentMap();
				const tags = map!.meta.tags as any;
				return {
					order1: tags[String(id1)]?.order,
					order2: tags[String(id2)]?.order,
					order3: tags[String(id3)]?.order,
				};
			},
			tag1Id,
			tag2Id,
			tag3Id,
		);
		expect(result.order3).toBe(0);
		expect(result.order1).toBe(1);
		expect(result.order2).toBe(2);
	});

	it("reorder persists after save/close/reopen", async () => {
		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const result = await withApi(
			async (api, id1, id2, id3) => {
				const map = api.getCurrentMap();
				const tags = map!.meta.tags as any;
				return {
					order1: tags[String(id1)]?.order,
					order2: tags[String(id2)]?.order,
					order3: tags[String(id3)]?.order,
				};
			},
			tag1Id,
			tag2Id,
			tag3Id,
		);
		expect(result.order3).toBe(0);
		expect(result.order1).toBe(1);
		expect(result.order2).toBe(2);
	});
});

// ============================================================================
// 2. Tag visibility and selections
// ============================================================================

describe("Tag visibility affecting selections", () => {
	let mapId: string;
	let visTagId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tag Visibility");

		const vt = await createTag("Visible Tag");
		visTagId = vt.id;

		const locs: Location[] = [];
		for (let i = 0; i < 10; i++) {
			locs.push(
				createLocation({
					lat: i,
					lng: i,
					tags: i < 5 ? [visTagId] : [],
				}),
			);
		}
		await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("tag selection works for visible tag", async () => {
		await withApi(async (api, tagId) => api.selectTag(tagId), visTagId);
		const ids = await refreshSelections();
		expect(ids.length).toBe(5);
	});

	it("deleting tag clears its selection", async () => {
		await withApi(async (api, tagId) => api.selectTag(tagId), visTagId);
		const beforeIds = await refreshSelections();
		expect(beforeIds.length).toBe(5);

		await withApi(async (api, tagId) => api.deleteTags([tagId]), visTagId);

		const selCount = await withApi(async (api) => api.getSelections().length);
		expect(selCount).toBe(0);

		// Undo the delete to restore for subsequent tests
		await withApi(async (api) => api.undo());
	});
});

// ============================================================================
// 3. Bulk tag operations
// ============================================================================

describe("Bulk tag add", () => {
	let mapId: string;
	let bulkTagId: number;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Bulk Tag");

		const bt = await createTag("BulkTag");
		bulkTagId = bt.id;

		const locs: Location[] = [];
		for (let i = 0; i < 20; i++) {
			locs.push(createLocation({ lat: i, lng: i }));
		}
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("bulkAddTag adds tag to all selected locations", async () => {
		const result = await withApi(
			async (api, tagId) => {
				await api.selectEverything();
				await api.addTagToLocations(tagId, [...api.getSelectedLocationIds()]);
				const counts = await api.cmd.storeTagCounts();
				return (counts as any)[String(tagId)] ?? 0;
			},
			bulkTagId,
		);
		expect(result).toBe(20);
	});

	it("bulkAddTag is idempotent (no duplicates in tags array)", async () => {
		const result = await withApi(
			async (api, tagId, firstLocId) => {
				await api.selectEverything();
				await api.addTagToLocations(tagId, [...api.getSelectedLocationIds()]);
				const loc = await api.fetchLocation(firstLocId);
				return loc!.tags.filter((t: number) => t === tagId).length;
			},
			bulkTagId,
			locIds[0],
		);
		expect(result).toBe(1);
	});

	it("tag count updates correctly after bulk add", async () => {
		const count = await withApi(async (api, tagId) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tagId)] ?? 0;
		}, bulkTagId);
		expect(count).toBe(20);
	});

	it("undo reverses bulk tag add", async () => {
		// First add a new bulk tag so we can undo it cleanly
		const newTag = await createTag("UndoBulk");
		await withApi(
			async (api, tagId) => {
				await api.selectEverything();
				await api.addTagToLocations(tagId, [...api.getSelectedLocationIds()]);
			},
			newTag.id,
		);

		const beforeCount = await withApi(async (api, tagId) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tagId)] ?? 0;
		}, newTag.id);
		expect(beforeCount).toBe(20);

		await withApi(async (api) => api.undo());

		const afterCount = await withApi(async (api, tagId) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tagId)] ?? 0;
		}, newTag.id);
		expect(afterCount).toBe(0);
	});
});

// ============================================================================
// 4. Tag deletion cascading
// ============================================================================

describe("Tag deletion cascade", () => {
	let mapId: string;
	let delTagId: number;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tag Delete Cascade");

		const dt = await createTag("ToDelete");
		delTagId = dt.id;

		const locs: Location[] = [];
		for (let i = 0; i < 10; i++) {
			locs.push(
				createLocation({
					lat: i,
					lng: i,
					tags: [delTagId],
				}),
			);
		}
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("deleting a tag removes it from all locations", async () => {
		await withApi(async (api, tagId) => {
			await api.deleteTags([tagId]);
		}, delTagId);

		const result = await withApi(async (api, firstId) => {
			const loc = await api.fetchLocation(firstId);
			return loc!.tags;
		}, locIds[0]);
		expect(result).toEqual([]);
	});

	it("tag count is zero after deletion", async () => {
		const count = await withApi(async (api, tagId) => {
			const counts = await api.cmd.storeTagCounts();
			return (counts as any)[String(tagId)] ?? 0;
		}, delTagId);
		expect(count).toBe(0);
	});
});

// ============================================================================
// 5. Tag color updates
// ============================================================================

describe("Tag color update", () => {
	let mapId: string;
	let colorTagId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tag Color");

		const ct = await createTag("ColorTag");
		colorTagId = ct.id;
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("can update tag color", async () => {
		await withApi(async (api, tagId) => {
			await api.updateTags([{ id: tagId, patch: { color: "#ff0000" } }]);
		}, colorTagId);

		const color = await withApi(async (api, tagId) => {
			const map = api.getCurrentMap();
			return (map!.meta.tags as any)[String(tagId)]?.color;
		}, colorTagId);
		expect(color).toBe("#ff0000");
	});

	it("tag color persists after save/close/reopen", async () => {
		await withApi(async (api, tagId) => {
			await api.updateTags([{ id: tagId, patch: { color: "#00ff00" } }]);
		}, colorTagId);

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const color = await withApi(async (api, tagId) => {
			const map = api.getCurrentMap();
			return (map!.meta.tags as any)[String(tagId)]?.color;
		}, colorTagId);
		expect(color).toBe("#00ff00");
	});
});
