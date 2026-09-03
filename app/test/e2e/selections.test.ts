import {
	addLocs,
	createLocation,
	createTag,
	getLoc,
	refreshSelections,
	withApi,
	useMap,
	seedLocs,
	selectCount,
} from "./helpers";

describe("Selections - basic types", () => {
	useMap("E2E Selections");
	let locIds: number[];
	let tagRedId: number;
	let tagBlueId: number;

	before(async () => {
		const tagRed = await createTag("tag-red");
		tagRedId = tagRed.id;
		const tagBlue = await createTag("tag-blue");
		tagBlueId = tagBlue.id;

		// Seed 200 locations with varied properties
		locIds = await seedLocs(200, (i) => ({
			lat: (i % 20) - 10,
			lng: (i % 36) * 10 - 180,
			heading: 0,
			panoId: i < 80 ? `pano_${i}` : null,
			flags: i < 50 ? 1 : 0,
			tags: i < 60 ? [tagRedId] : i < 120 ? [tagBlueId] : [],
		}));
	});
	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	// --- Everything ---

	it("selectEverything selects all locations", async () => {
		const result = await selectCount({ type: "Everything" });
		expect(result).toBe(200);
	});

	// --- PanoIds / NotPanoIds ---

	it("selectPanoIds selects locations with LoadAsPanoId flag", async () => {
		const result = await withApi(async (api) => {
			await api.addSelections([{ type: "PanoIds" }]);
			const sels = api.getActiveSelections();
			return { count: api.getMapState().selectedLocationIds.size, selCount: sels.length };
		});
		expect(result.count).toBe(50);
		expect(result.selCount).toBe(1);
	});

	it("selectNotPanoIds selects locations without LoadAsPanoId flag", async () => {
		const result = await selectCount({ type: "NotPanoIds" });
		expect(result).toBe(150);
	});

	it("PanoIds + NotPanoIds = Everything", async () => {
		const result = await withApi(async (api) => {
			await api.addSelections([{ type: "PanoIds" }]);
			await api.addSelections([{ type: "NotPanoIds" }]);
			return api.getMapState().selectedLocationIds.size;
		});
		expect(result).toBe(200);
	});

	// --- Untagged ---

	it("selectUntagged selects locations with no tags", async () => {
		const result = await selectCount({ type: "Untagged" });
		expect(result).toBe(80); // indices 120-199 have no tags
	});

	// --- Unpanned ---

	it("selectUnpanned selects locations with heading=0", async () => {
		const result = await selectCount({ type: "Unpanned" });
		// All 200 seeded locations have heading=0
		expect(result).toBe(200);
	});

	// --- Tag selection ---

	it("selectTag selects locations with specific tag", async () => {
		const result = await selectCount({ type: "Tag", tagId: tagRedId });
		expect(result).toBe(60);
	});

	it("selectTag for nonexistent tag selects none", async () => {
		const result = await selectCount({ type: "Tag", tagId: 999999 });
		expect(result).toBe(0);
	});

	// --- Manual selection ---

	it("toggleManualSelection adds/removes individual locations", async () => {
		const id0 = locIds[0];
		const id1 = locIds[1];
		const id2 = locIds[2];
		await withApi(
			async (api, i0: number, i1: number, i2: number) => {
				await api.toggleManualSelection(i0);
				await api.toggleManualSelection(i1);
				await api.toggleManualSelection(i2);
			},
			id0,
			id1,
			id2,
		);
		let ids = await refreshSelections();
		expect(ids.length).toBe(3);

		await withApi(async (api, i1: number) => {
			await api.toggleManualSelection(i1); // remove
		}, id1);
		ids = await refreshSelections();
		expect(ids.length).toBe(2);
		expect(ids).toContain(id0);
		expect(ids).toContain(id2);
		expect(ids).not.toContain(id1);
	});

	// --- Polygon selection ---

	it("selectPolygon selects locations within polygon", async () => {
		const result = await selectCount({
			type: "Polygon",
			polygon: {
				coordinates: [
					[
						[-180, -10],
						[-90, -10],
						[-90, 0],
						[-180, 0],
						[-180, -10],
					],
				],
				extraPolygons: null,
			},
		});
		expect(result).toBeGreaterThan(0);
	});

	// --- Duplicates ---

	it("selectDuplicates finds locations at same coordinates", async () => {
		await addLocs([
			createLocation({ lat: 55.0, lng: 37.0, heading: 0 }),
			createLocation({ lat: 55.0, lng: 37.0, heading: 90 }),
		]);

		const result = await withApi(async (api) => {
			await api.addSelections([{ type: "Duplicates", distance: 1 }]);
			const ids = api.getMapState().selectedLocationIds;
			return { count: ids.size };
		});
		expect(result.count).toBeGreaterThanOrEqual(1);
	});
});

describe("Selection operations", () => {
	useMap("E2E Selection Ops");
	let tagAId: number;

	before(async () => {
		const tagA = await createTag("tag-a");
		tagAId = tagA.id;

		await seedLocs(100, (i) => ({
			lat: i,
			lng: i,
			panoId: i < 40 ? `pano_${i}` : null,
			flags: i < 30 ? 1 : 0,
			tags: i < 50 ? [tagAId] : [],
		}));
	});
	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("intersection of two selections", async () => {
		const result = await withApi(async (api, tagId: number) => {
			await api.addSelections([{ type: "PanoIds" }]); // 30 (flags=1)
			await api.addSelections([{ type: "Tag", tagId: tagId }]); // 50 (indices 0-49)
			// PanoIds (0-29) intersect Tag-a (0-49) = 30
			await api.selectIntersection();
			const sels = api.getActiveSelections();
			return { count: api.getMapState().selectedLocationIds.size, selCount: sels.length };
		}, tagAId);
		expect(result.count).toBe(30);
	});

	it("union of two selections", async () => {
		const result = await withApi(async (api, tagId: number) => {
			await api.addSelections([{ type: "PanoIds" }]); // 30
			await api.addSelections([{ type: "Tag", tagId: tagId }]); // 50
			// Union: 0-29 + 0-49 = 0-49 = 50
			await api.selectUnion();
			return api.getMapState().selectedLocationIds.size;
		}, tagAId);
		expect(result).toBe(50);
	});

	it("invert selection", async () => {
		const result = await withApi(async (api) => {
			await api.addSelections([{ type: "PanoIds" }]); // 30
			await api.selectInverse(); // 100 - 30 = 70
			return api.getMapState().selectedLocationIds.size;
		});
		expect(result).toBe(70);
	});

	it("remove selection by key", async () => {
		const result = await withApi(async (api, tagId: number) => {
			await api.addSelections([{ type: "PanoIds" }]);
			await api.addSelections([{ type: "Tag", tagId: tagId }]);
			const before = api.getActiveSelections().length;
			const key = api.getActiveSelections()[0].key;
			await api.removeSelections([key]);
			const after = api.getActiveSelections().length;
			return { before, after };
		}, tagAId);
		expect(result.before).toBe(2);
		expect(result.after).toBe(1);
	});

	it("resetSelections clears all", async () => {
		await withApi(async (api, tagId: number) => {
			await api.addSelections([{ type: "PanoIds" }]);
			await api.addSelections([{ type: "Tag", tagId: tagId }]);
			await api.addSelections([{ type: "Untagged" }]);
		}, tagAId);

		const result = await withApi(async (api) => {
			const before = api.getActiveSelections().length;
			await api.resetSelections();
			const after = api.getActiveSelections().length;
			return { before, after };
		});
		expect(result.before).toBe(3);
		expect(result.after).toBe(0);
	});

	it("addSelection with custom props", async () => {
		const result = await withApi(async (api) => {
			await api.addSelections([{ type: "Everything" }]);
			const sels = api.getActiveSelections();
			return {
				count: sels.length,
				type: sels[0]?.selector?.type,
				locCount: sels[0] ? api.getMapState().selectionCounts[sels[0].key] : undefined,
			};
		});
		expect(result.count).toBe(1);
		expect(result.type).toBe("Everything");
		expect(result.locCount).toBe(100);
	});
});

describe("Selection correctness after mutations", () => {
	useMap("E2E Sel Mutations");
	let locIds: number[];

	it("PanoIds selection updates after flag change", async () => {
		locIds = await seedLocs(10, (i) => ({
			lat: i,
			lng: i,
			panoId: `pano_${i}`,
			flags: 0,
		}));

		const locsToFlag = [];
		for (let i = 0; i < 5; i++) locsToFlag.push(await getLoc(locIds[i]));
		const result = await withApi(async (api, locs) => {
			await api.addSelections([{ type: "PanoIds" }]);
			const before = api.getMapState().selectedLocationIds.size;
			for (const l of locs) {
				await api.updateLocations([{ id: l.id, patch: { flags: 1 } }]);
			}
			await new Promise((r) => setTimeout(r, 500));
			await api.resetSelections();
			await api.addSelections([{ type: "PanoIds" }]);
			const after = api.getMapState().selectedLocationIds.size;
			return { before, after };
		}, locsToFlag);
		expect(result.before).toBe(0);
		expect(result.after).toBe(5);
	});

	it("selection updates after adding locations", async () => {
		const result = await withApi(async (api) => {
			await api.resetSelections();
			await api.addSelections([{ type: "Everything" }]);
			const before = (await api._test.syncSelections()).ids.length;

			await api.addLocations([api.createLocation({ lat: 50, lng: 50 })]);

			await api.resetSelections();
			await api.addSelections([{ type: "Everything" }]);
			const after = (await api._test.syncSelections()).ids.length;
			return { before, after };
		});
		expect(result.after).toBe(result.before + 1);
	});

	it("selection updates after removing locations", async () => {
		const result = await withApi(async (api) => {
			await api.resetSelections();
			await api.addSelections([{ type: "Everything" }]);
			const before = (await api._test.syncSelections()).ids;
			const toRemove = before[before.length - 1];
			await api.removeLocations(new Set([toRemove]));
			await new Promise((r) => setTimeout(r, 300));
			const after = (await api._test.syncSelections()).ids;
			return { before: before.length, after: after.length };
		});
		expect(result.after).toBe(result.before - 1);
	});

	it("PanoIds selection correct after undo of flag change", async () => {
		const loc0 = await getLoc(locIds[0]);
		await withApi(async (api, loc) => {
			await api.resetSelections();
			await api.addSelections([{ type: "PanoIds" }]);
			await api.updateLocations([{ id: loc.id, patch: { flags: 0 } }]);
			await new Promise((r) => setTimeout(r, 300));
		}, loc0);

		const afterUnpin = await refreshSelections();
		expect(afterUnpin.length).toBe(4);

		await withApi(async (api) => {
			await api.undo();
			await new Promise((r) => setTimeout(r, 300));
		});

		const afterUndo = await refreshSelections();
		expect(afterUndo.length).toBe(5);
	});

	it("tag selection updates after tag added to locations", async () => {
		const testTag = await createTag("test-tag");
		const tagLoc0 = await getLoc(locIds[0]);
		const tagLoc1 = await getLoc(locIds[1]);
		await withApi(
			async (api, l0, l1, tagId: number) => {
				await api.resetSelections();
				await api.updateLocations([{ id: l0.id, patch: { tags: [tagId] } }]);
				await api.updateLocations([{ id: l1.id, patch: { tags: [tagId] } }]);
				await api.addSelections([{ type: "Tag", tagId: tagId }]);
			},
			tagLoc0,
			tagLoc1,
			testTag.id,
		);
		const selected = await refreshSelections();
		expect(selected.length).toBe(2);
	});
});

describe("Selection with Filter", () => {
	useMap("E2E Filter");

	before(async () => {
		await seedLocs(50, (i) => ({
			lat: i,
			lng: i,
			extra: { altitude: i * 10, country: i < 25 ? "US" : "GB" },
		}));
	});
	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("filter by string equality", async () => {
		const result = await selectCount({
			type: "Filter",
			field: "country",
			test: { op: "eq", value: "US" },
		});
		expect(result).toBe(25);
	});

	it("filter by string inequality", async () => {
		const result = await selectCount({
			type: "Filter",
			field: "country",
			test: { op: "neq", value: "US" },
		});
		expect(result).toBe(25);
	});

	it("filter by numeric greater than", async () => {
		const result = await selectCount({
			type: "Filter",
			field: "altitude",
			test: { op: "gt", value: 200 },
		});
		expect(result).toBe(29);
	});

	it("filter by numeric less than", async () => {
		const result = await selectCount({
			type: "Filter",
			field: "altitude",
			test: { op: "lt", value: 100 },
		});
		expect(result).toBe(10);
	});

	it("filter by between", async () => {
		const result = await selectCount({
			type: "Filter",
			field: "altitude",
			test: { op: "between", lo: 100, hi: 200 },
		});
		expect(result).toBe(11);
	});
});
