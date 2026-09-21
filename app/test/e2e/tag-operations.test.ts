/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	closeMap,
	createTag,
	refreshSelections,
	flushAndWait,
	openMap,
	withApi,
	useMap,
	seedLocs,
} from "./helpers";

// ============================================================================
// 1. Tag reordering
// ============================================================================

describe("Tag reordering", () => {
	const map = useMap("E2E Tag Reorder");
	let tag1Id: number;
	let tag2Id: number;
	let tag3Id: number;

	before(async () => {
		const t1 = await createTag("Alpha");
		tag1Id = t1.id;
		const t2 = await createTag("Beta");
		tag2Id = t2.id;
		const t3 = await createTag("Gamma");
		tag3Id = t3.id;
	});
	it("reorderTags changes tag order field", async () => {
		const result = await withApi(
			async (api, id1, id2, id3) => {
				await api.reorderTags([id3, id1, id2]);
				const tags = api.getTags() as any;
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
		await openMap(map.id);

		const result = await withApi(
			async (api, id1, id2, id3) => {
				const tags = api.getTags() as any;
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
	useMap("E2E Tag Visibility");
	let visTagId: number;

	before(async () => {
		const vt = await createTag("Visible Tag");
		visTagId = vt.id;

		await seedLocs(10, (i) => ({
			lat: i,
			lng: i,
			tags: i < 5 ? [visTagId] : [],
		}));
	});
	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("tag selection works for visible tag", async () => {
		await withApi(async (api, tagId) => api.addSelections([api.tagSelector(tagId)]), visTagId);
		const ids = await refreshSelections();
		expect(ids.length).toBe(5);
	});

	it("deleting tag clears its selection", async () => {
		await withApi(async (api, tagId) => api.addSelections([api.tagSelector(tagId)]), visTagId);
		const beforeIds = await refreshSelections();
		expect(beforeIds.length).toBe(5);

		await withApi(async (api, tagId) => api.deleteTags([tagId]), visTagId);

		const selCount = await withApi(async (api) => api.getActiveSelections().length);
		expect(selCount).toBe(0);

		// Undo the delete to restore for subsequent tests
		await withApi(async (api) => api.undo());
	});
});

// ============================================================================
// 3. Bulk tag operations
// ============================================================================

describe("Bulk tag add", () => {
	useMap("E2E Bulk Tag");
	let bulkTagId: number;
	let locIds: number[];

	before(async () => {
		const bt = await createTag("BulkTag");
		bulkTagId = bt.id;

		locIds = await seedLocs(20, (i) => ({ lat: i, lng: i }));
	});
	it("bulkAddTag adds tag to all selected locations", async () => {
		const result = await withApi(async (api, tagId) => {
			await api.addSelections([{ type: "Everything" }]);
			await api.addTagToLocations(tagId, [...api.getMapState().selectedLocationIds]);
			const counts = api.getTagCounts();
			return (counts as any)[String(tagId)] ?? 0;
		}, bulkTagId);
		expect(result).toBe(20);
	});

	it("bulkAddTag is idempotent (no duplicates in tags array)", async () => {
		const result = await withApi(
			async (api, tagId, firstLocId) => {
				await api.addSelections([{ type: "Everything" }]);
				await api.addTagToLocations(tagId, [...api.getMapState().selectedLocationIds]);
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
			const counts = api.getTagCounts();
			return (counts as any)[String(tagId)] ?? 0;
		}, bulkTagId);
		expect(count).toBe(20);
	});

	it("undo reverses bulk tag add", async () => {
		// First add a new bulk tag so we can undo it cleanly
		const newTag = await createTag("UndoBulk");
		await withApi(async (api, tagId) => {
			await api.addSelections([{ type: "Everything" }]);
			await api.addTagToLocations(tagId, [...api.getMapState().selectedLocationIds]);
		}, newTag.id);

		const beforeCount = await withApi(async (api, tagId) => {
			const counts = api.getTagCounts();
			return (counts as any)[String(tagId)] ?? 0;
		}, newTag.id);
		expect(beforeCount).toBe(20);

		await withApi(async (api) => api.undo());

		const afterCount = await withApi(async (api, tagId) => {
			const counts = api.getTagCounts();
			return (counts as any)[String(tagId)] ?? 0;
		}, newTag.id);
		expect(afterCount).toBe(0);
	});
});

// ============================================================================
// 4. Tag deletion cascading
// ============================================================================

describe("Tag deletion cascade", () => {
	useMap("E2E Tag Delete Cascade");
	let delTagId: number;
	let locIds: number[];

	before(async () => {
		const dt = await createTag("ToDelete");
		delTagId = dt.id;

		locIds = await seedLocs(10, (i) => ({
			lat: i,
			lng: i,
			tags: [delTagId],
		}));
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
			const counts = api.getTagCounts();
			return (counts as any)[String(tagId)] ?? 0;
		}, delTagId);
		expect(count).toBe(0);
	});
});

describe("Rename tags within a selection", () => {
	useMap("E2E Tag Rename In Selection");
	let fromId: number;
	let intoId: number;
	let locIds: number[];

	before(async () => {
		fromId = (await createTag("From")).id;
		intoId = (await createTag("Into")).id;
		locIds = await seedLocs(10, (i) => ({ lat: i, lng: i, tags: i < 8 ? [fromId] : [intoId] }));
	});

	const counts = () =>
		withApi(
			async (api, a, b) => {
				const c = api.getTagCounts() as any;
				return { from: c[String(a)] ?? 0, into: c[String(b)] ?? 0 };
			},
			fromId,
			intoId,
		);

	it("splits a tag, moving only the selected locations to a new name", async () => {
		const created = await withApi(
			async (api, a, ids) => {
				await api.renameTagsIn([a], "Split", { type: "Locations", locations: ids, name: null });
				const tag = Object.values(api.getTags()).find((t: any) => t.name === "Split") as any;
				return (api.getTagCounts() as any)[String(tag.id)] ?? 0;
			},
			fromId,
			locIds.slice(0, 3),
		);
		expect(created).toBe(3);
		expect(await counts()).toEqual({ from: 5, into: 2 });
	});

	it("merges the selected locations into a tag that already exists", async () => {
		await withApi(
			async (api, a, ids) => {
				await api.renameTagsIn([a], "Into", { type: "Locations", locations: ids, name: null });
			},
			fromId,
			locIds.slice(3, 5),
		);
		expect(await counts()).toEqual({ from: 3, into: 4 });
	});
});

// ============================================================================
// 5. Tag color updates
// ============================================================================

describe("Tag color update", () => {
	const map = useMap("E2E Tag Color");
	let colorTagId: number;

	before(async () => {
		const ct = await createTag("ColorTag");
		colorTagId = ct.id;
	});
	it("can update tag color", async () => {
		await withApi(async (api, tagId) => {
			await api.updateTags([{ id: tagId, patch: { color: "#ff0000" } }]);
		}, colorTagId);

		const color = await withApi(async (api, tagId) => {
			return (api.getTags() as any)[String(tagId)]?.color;
		}, colorTagId);
		expect(color).toBe("#ff0000");
	});

	it("tag color persists after save/close/reopen", async () => {
		await withApi(async (api, tagId) => {
			await api.updateTags([{ id: tagId, patch: { color: "#00ff00" } }]);
		}, colorTagId);

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const color = await withApi(async (api, tagId) => {
			return (api.getTags() as any)[String(tagId)]?.color;
		}, colorTagId);
		expect(color).toBe("#00ff00");
	});
});
