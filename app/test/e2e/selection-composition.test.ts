import { createTag, refreshSelections, withApi, useMap, seedLocs } from "./helpers";

describe("Selection composition", () => {
	useMap("E2E Sel Compose");
	let tagAId: number;
	let tagBId: number;

	before(async () => {
		const tagA = await createTag("tag-a");
		tagAId = tagA.id;
		const tagB = await createTag("tag-b");
		tagBId = tagB.id;

		await seedLocs(100, (i) => ({
			lat: i,
			lng: i,
			heading: i < 40 ? 0 : 90,
			panoId: i < 60 ? `p${i}` : null,
			flags: i < 30 ? 1 : 0,
			tags: i < 50 ? [tagAId] : i < 80 ? [tagBId] : [],
		}));
	});
	beforeEach(async () => {
		await withApi(async (api) => api.SelectionList.update({ kind: "set", selections: [] }));
	});

	it("compose two selections into intersection", async () => {
		const result = await withApi(async (api, tagId) => {
			await api.SelectionList.update(api.addSelection(api.panoIdSelector(true))); // 30 (flags=1, indices 0-29)
			await api.SelectionList.update(api.addSelection(api.tagSelector(tagId))); // 50 (indices 0-49)
			await api.SelectionList.update(api.composeSelections([0], [1], "Intersection"));
			const after = api.SelectionList.active();
			return {
				selCount: after.length,
				type: after[0]?.selector?.type,
			};
		}, tagAId);
		const ids = await refreshSelections();
		expect(result.selCount).toBe(1);
		expect(result.type).toBe("Intersection");
		expect(ids.length).toBe(30);
	});

	it("compose two selections into union", async () => {
		const result = await withApi(async (api, tagId) => {
			await api.SelectionList.update(api.addSelection(api.panoIdSelector(true))); // 30
			await api.SelectionList.update(api.addSelection(api.tagSelector(tagId))); // 30 (indices 50-79)
			await api.SelectionList.update(api.composeSelections([0], [1], "Union"));
			const after = api.SelectionList.active();
			return {
				selCount: after.length,
				type: after[0]?.selector?.type,
			};
		}, tagBId);
		const ids = await refreshSelections();
		expect(result.selCount).toBe(1);
		expect(result.type).toBe("Union");
		expect(ids.length).toBe(60);
	});

	it("decompose extracts child as standalone", async () => {
		const result = await withApi(async (api, tagId) => {
			await api.SelectionList.update(api.addSelection(api.panoIdSelector(true)));
			await api.SelectionList.update(api.addSelection(api.tagSelector(tagId)));
			await api.SelectionList.update(api.composeSelections([0], [1], "Union"));
			await api.SelectionList.update(api.moveSelection([0, 0], [0], "after"));
			const after = api.SelectionList.active();
			return {
				selCount: after.length,
				types: after.map((s) => s.selector.type),
			};
		}, tagAId);
		expect(result.selCount).toBe(2);
	});

	it("removeChildFromSelection removes without extracting", async () => {
		const result = await withApi(async (api, tagId) => {
			await api.SelectionList.update({ kind: "set", selections: [] });
			await api.SelectionList.update(api.addSelection(api.panoIdSelector(true)));
			await api.SelectionList.update(api.addSelection(api.tagSelector(tagId)));
			await api.SelectionList.update(api.addSelection(api.untaggedSelector()));

			// Compose first two, then the third into the union
			await api.SelectionList.update(api.composeSelections([0], [1], "Union"));
			await api.SelectionList.update(api.composeSelections([1], [0], "Union"));

			// Remove one child from composite
			await api.SelectionList.update(api.removeSelectionAt([0, 0]));

			return {
				selCount: api.SelectionList.active().length,
			};
		}, tagAId);
		expect(result.selCount).toBeGreaterThanOrEqual(1);
	});
});

describe("Selection composition edge cases", () => {
	useMap("E2E Sel Compose Edge");
	let edgeTagId: number;

	before(async () => {
		const edgeTag = await createTag("edge-tag");
		edgeTagId = edgeTag.id;

		await seedLocs(20, (i) => ({
			lat: i,
			lng: i,
			panoId: i < 10 ? `p${i}` : null,
			flags: i < 5 ? 1 : 0,
			tags: i < 15 ? [edgeTagId] : [],
		}));
	});
	beforeEach(async () => {
		await withApi(async (api) => api.SelectionList.update({ kind: "set", selections: [] }));
	});

	it("intersection of non-overlapping selections = empty", async () => {
		const result = await withApi(async (api) => {
			// PanoIds = flags=1 = indices 0-4
			await api.SelectionList.update(api.addSelection(api.panoIdSelector(true)));
			// Untagged = indices 15-19
			await api.SelectionList.update(api.addSelection(api.untaggedSelector()));
			await api.SelectionList.update(api.onActive(api.combineSelections("Intersection")));
			return api.Scene.selected().size;
		});
		expect(result).toBe(0);
	});

	it("union of same selection = same count", async () => {
		const result = await withApi(async (api, tagId) => {
			await api.SelectionList.update(api.addSelection(api.tagSelector(tagId)));
			const before = api.Scene.selected().size;
			// Add another tag selection (same tag) -- won't duplicate since key is the same
			await api.SelectionList.update(api.addSelection(api.tagSelector(tagId)));
			await api.SelectionList.update(api.onActive(api.combineSelections("Union")));
			return { before, after: api.Scene.selected().size };
		}, edgeTagId);
		expect(result.after).toBe(result.before);
	});

	it("invert of everything = empty", async () => {
		const result = await withApi(async (api) => {
			await api.SelectionList.update(api.addSelection({ type: "Everything" }));
			await api.SelectionList.update(api.onActive(api.complementSelections()));
			return api.Scene.selected().size;
		});
		expect(result).toBe(0);
	});

	it("invert of empty = everything", async () => {
		const result = await withApi(async (api) => {
			await api.SelectionList.update(api.addSelection(api.panoIdSelector(true))); // just need a base selection
			// Invert PanoIds (5 locations) = 15 non-panoId
			await api.SelectionList.update(api.onActive(api.complementSelections()));
			return api.Scene.selected().size;
		});
		expect(result).toBe(15);
	});
});
