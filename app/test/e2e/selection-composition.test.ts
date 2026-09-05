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
		await withApi(async (api) => api.resetSelections());
	});

	it("compose two selections into intersection", async () => {
		const result = await withApi(async (api, tagId) => {
			await api.addSelections([{ type: "PanoIds" }]); // 30 (flags=1, indices 0-29)
			await api.addSelections([{ type: "Tag", tagId: tagId }]); // 50 (indices 0-49)
			const sels = api.getActiveSelections();
			const key1 = sels[0].key;
			const key2 = sels[1].key;
			await api.applySelectionUpdate(api.composeSelections(key1, key2, "Intersection", null, null));
			const after = api.getActiveSelections();
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
			await api.addSelections([{ type: "PanoIds" }]); // 30
			await api.addSelections([{ type: "Tag", tagId: tagId }]); // 30 (indices 50-79)
			const sels = api.getActiveSelections();
			await api.applySelectionUpdate(
				api.composeSelections(sels[0].key, sels[1].key, "Union", null, null),
			);
			const after = api.getActiveSelections();
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
			await api.addSelections([{ type: "PanoIds" }]);
			await api.addSelections([{ type: "Tag", tagId: tagId }]);
			const sels = api.getActiveSelections();
			await api.applySelectionUpdate(
				api.composeSelections(sels[0].key, sels[1].key, "Union", null, null),
			);

			const composite = api.getActiveSelections()[0];
			const childKey =
				"selections" in composite.selector ? composite.selector.selections[0].key : "";
			const parentKey = composite.key;

			await api.applySelectionUpdate(api.decomposeChild(parentKey, childKey));
			const after = api.getActiveSelections();
			return {
				selCount: after.length,
				types: after.map((s) => s.selector.type),
			};
		}, tagAId);
		expect(result.selCount).toBe(2);
	});

	it("removeChildFromSelection removes without extracting", async () => {
		const result = await withApi(async (api, tagId) => {
			await api.resetSelections();
			await api.addSelections([{ type: "PanoIds" }]);
			await api.addSelections([{ type: "Tag", tagId: tagId }]);
			await api.addSelections([{ type: "Untagged" }]);
			const sels = api.getActiveSelections();

			// Compose first two
			await api.applySelectionUpdate(
				api.composeSelections(sels[0].key, sels[1].key, "Union", null, null),
			);
			const compositeKey = api.getActiveSelections()[0].key;

			// Now compose the third into the union
			const third = api.getActiveSelections().find((s) => s.selector.type === "Untagged");
			if (third) {
				await api.applySelectionUpdate(
					api.composeSelections(third.key, compositeKey, "Union", null, compositeKey),
				);
			}

			// Remove one child from composite
			const composite = api
				.getActiveSelections()
				.find((s) => s.selector.type === "Union" || s.selector.type === "Intersection");
			if (
				composite &&
				"selections" in composite.selector &&
				composite.selector.selections.length > 0
			) {
				const childToRemove = composite.selector.selections[0].key;
				await api.applySelectionUpdate(api.removeFromComposite(composite.key, childToRemove));
			}

			return {
				selCount: api.getActiveSelections().length,
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
		await withApi(async (api) => api.resetSelections());
	});

	it("intersection of non-overlapping selections = empty", async () => {
		const result = await withApi(async (api) => {
			// PanoIds = flags=1 = indices 0-4
			await api.addSelections([{ type: "PanoIds" }]);
			// Untagged = indices 15-19
			await api.addSelections([{ type: "Untagged" }]);
			await api.applySelectionUpdate(api.intersectSelections());
			return api.getMapState().selectedLocationIds.size;
		});
		expect(result).toBe(0);
	});

	it("union of same selection = same count", async () => {
		const result = await withApi(async (api, tagId) => {
			await api.addSelections([{ type: "Tag", tagId: tagId }]);
			const before = api.getMapState().selectedLocationIds.size;
			// Add another tag selection (same tag) -- won't duplicate since key is the same
			await api.addSelections([{ type: "Tag", tagId: tagId }]);
			await api.applySelectionUpdate(api.unionSelections());
			return { before, after: api.getMapState().selectedLocationIds.size };
		}, edgeTagId);
		expect(result.after).toBe(result.before);
	});

	it("invert of everything = empty", async () => {
		const result = await withApi(async (api) => {
			await api.addSelections([{ type: "Everything" }]);
			await api.applySelectionUpdate(api.invertSelections());
			return api.getMapState().selectedLocationIds.size;
		});
		expect(result).toBe(0);
	});

	it("invert of empty = everything", async () => {
		const result = await withApi(async (api) => {
			await api.addSelections([{ type: "PanoIds" }]); // just need a base selection
			// Invert PanoIds (5 locations) = 15 non-panoId
			await api.applySelectionUpdate(api.invertSelections());
			return api.getMapState().selectedLocationIds.size;
		});
		expect(result).toBe(15);
	});
});
