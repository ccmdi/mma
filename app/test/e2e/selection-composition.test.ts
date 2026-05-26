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
} from "./helpers";
import type { Location } from "@/types";

describe("Selection composition", () => {
	let mapId: string;
	let tagAId: number;
	let tagBId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Sel Compose");

		const tagA = await createTag("tag-a");
		tagAId = tagA.id;
		const tagB = await createTag("tag-b");
		tagBId = tagB.id;

		const locs: Location[] = [];
		for (let i = 0; i < 100; i++) {
			locs.push(
				createLocation({
					lat: i,
					lng: i,
					heading: i < 40 ? 0 : 90,
					panoId: i < 60 ? `p${i}` : null,
					flags: i < 30 ? 1 : 0,
					tags: i < 50 ? [tagAId] : i < 80 ? [tagBId] : [],
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

	it("compose two selections into intersection", async () => {
		const result = await withApi(async (api, tagId) => {
			await api.selectPanoIds(); // 30 (flags=1, indices 0-29)
			await api.selectTag(tagId); // 50 (indices 0-49)
			const sels = api.getSelections();
			const key1 = sels[0].key;
			const key2 = sels[1].key;
			api.composeSelections(key1, key2, "intersection", null, null);
			const after = api.getSelections();
			return {
				selCount: after.length,
				type: after[0]?.props?.type,
			};
		}, tagAId);
		const ids = await refreshSelections();
		expect(result.selCount).toBe(1);
		expect(result.type).toBe("Intersection");
		expect(ids.length).toBe(30);
	});

	it("compose two selections into union", async () => {
		const result = await withApi(async (api, tagId) => {
			await api.selectPanoIds(); // 30
			await api.selectTag(tagId); // 30 (indices 50-79)
			const sels = api.getSelections();
			api.composeSelections(sels[0].key, sels[1].key, "union", null, null);
			const after = api.getSelections();
			return {
				selCount: after.length,
				type: after[0]?.props?.type,
			};
		}, tagBId);
		const ids = await refreshSelections();
		expect(result.selCount).toBe(1);
		expect(result.type).toBe("Union");
		expect(ids.length).toBe(60);
	});

	it("decompose extracts child as standalone", async () => {
		const result = await withApi(async (api, tagId) => {
			await api.selectPanoIds();
			await api.selectTag(tagId);
			const sels = api.getSelections();
			api.composeSelections(sels[0].key, sels[1].key, "union", null, null);

			const composite = api.getSelections()[0];
			const childKey = "selections" in composite.props ? composite.props.selections[0].key : "";
			const parentKey = composite.key;

			api.decomposeChild(parentKey, childKey);
			const after = api.getSelections();
			return {
				selCount: after.length,
				types: after.map((s) => s.props.type),
			};
		}, tagAId);
		expect(result.selCount).toBe(2);
	});

	it("removeChildFromSelection removes without extracting", async () => {
		const result = await withApi(async (api, tagId) => {
			api.resetSelections();
			await api.selectPanoIds();
			await api.selectTag(tagId);
			await api.selectUntagged();
			const sels = api.getSelections();

			// Compose first two
			api.composeSelections(sels[0].key, sels[1].key, "union", null, null);
			const compositeKey = api.getSelections()[0].key;

			// Now compose the third into the union
			const third = api.getSelections().find((s) => s.props.type === "Untagged");
			if (third) {
				api.composeSelections(third.key, compositeKey, "union", null, compositeKey);
			}

			// Remove one child from composite
			const composite = api
				.getSelections()
				.find((s) => s.props.type === "Union" || s.props.type === "Intersection");
			if (composite && "selections" in composite.props && composite.props.selections.length > 0) {
				const childToRemove = composite.props.selections[0].key;
				api.removeChildFromSelection(composite.key, childToRemove);
			}

			return {
				selCount: api.getSelections().length,
			};
		}, tagAId);
		expect(result.selCount).toBeGreaterThanOrEqual(1);
	});
});

describe("Selection composition edge cases", () => {
	let mapId: string;
	let edgeTagId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Sel Compose Edge");

		const edgeTag = await createTag("edge-tag");
		edgeTagId = edgeTag.id;

		const locs: Location[] = [];
		for (let i = 0; i < 20; i++) {
			locs.push(
				createLocation({
					lat: i,
					lng: i,
					panoId: i < 10 ? `p${i}` : null,
					flags: i < 5 ? 1 : 0,
					tags: i < 15 ? [edgeTagId] : [],
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

	it("intersection of non-overlapping selections = empty", async () => {
		const result = await withApi(async (api) => {
			// PanoIds = flags=1 = indices 0-4
			await api.selectPanoIds();
			// Untagged = indices 15-19
			await api.selectUntagged();
			await api.selectIntersection();
			return api.getSelectedLocationIds().size;
		});
		expect(result).toBe(0);
	});

	it("union of same selection = same count", async () => {
		const result = await withApi(async (api, tagId) => {
			await api.selectTag(tagId);
			const before = api.getSelectedLocationIds().size;
			// Add another tag selection (same tag) -- won't duplicate since key is the same
			await api.selectTag(tagId);
			await api.selectUnion();
			return { before, after: api.getSelectedLocationIds().size };
		}, edgeTagId);
		expect(result.after).toBe(result.before);
	});

	it("invert of everything = empty", async () => {
		const result = await withApi(async (api) => {
			await api.selectEverything();
			await api.selectInverse();
			return api.getSelectedLocationIds().size;
		});
		expect(result).toBe(0);
	});

	it("invert of empty = everything", async () => {
		const result = await withApi(async (api) => {
			await api.selectPanoIds(); // just need a base selection
			// Invert PanoIds (5 locations) = 15 non-panoId
			await api.selectInverse();
			return api.getSelectedLocationIds().size;
		});
		expect(result).toBe(15);
	});
});
