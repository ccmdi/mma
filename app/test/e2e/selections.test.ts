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

describe("Selections - basic types", () => {
	let mapId: string;
	let locIds: number[];
	let tagRedId: number;
	let tagBlueId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Selections");
		await browser.pause(500);

		const tagRed = await createTag("tag-red");
		tagRedId = tagRed.id;
		const tagBlue = await createTag("tag-blue");
		tagBlueId = tagBlue.id;

		// Seed 200 locations with varied properties
		const locs: Location[] = [];
		for (let i = 0; i < 200; i++) {
			locs.push(
				createLocation({
					lat: (i % 20) - 10,
					lng: (i % 36) * 10 - 180,
					heading: 0,
					panoId: i < 80 ? `pano_${i}` : null,
					flags: i < 50 ? 1 : 0,
					tags: i < 60 ? [tagRedId] : i < 120 ? [tagBlueId] : [],
				}),
			);
		}
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	// --- Everything ---

	it("selectEverything selects all locations", async () => {
		const result = await withApi(async (api) => {
			await api.selectEverything();
			return api.getSelectedLocationIds().size;
		});
		expect(result).toBe(200);
	});

	// --- PanoIds / NotPanoIds ---

	it("selectPanoIds selects locations with LoadAsPanoId flag", async () => {
		const result = await withApi(async (api) => {
			await api.selectPanoIds();
			const sels = api.getSelections();
			return { count: api.getSelectedLocationIds().size, selCount: sels.length };
		});
		expect(result.count).toBe(50);
		expect(result.selCount).toBe(1);
	});

	it("selectNotPanoIds selects locations without LoadAsPanoId flag", async () => {
		const result = await withApi(async (api) => {
			await api.selectNotPanoIds();
			return api.getSelectedLocationIds().size;
		});
		expect(result).toBe(150);
	});

	it("PanoIds + NotPanoIds = Everything", async () => {
		const result = await withApi(async (api) => {
			await api.selectPanoIds();
			await api.selectNotPanoIds();
			return api.getSelectedLocationIds().size;
		});
		expect(result).toBe(200);
	});

	// --- Untagged ---

	it("selectUntagged selects locations with no tags", async () => {
		const result = await withApi(async (api) => {
			await api.selectUntagged();
			return api.getSelectedLocationIds().size;
		});
		expect(result).toBe(80); // indices 120-199 have no tags
	});

	// --- Unpanned ---

	it("selectUnpanned selects locations with heading=0", async () => {
		const result = await withApi(async (api) => {
			await api.selectUnpanned();
			return api.getSelectedLocationIds().size;
		});
		// All 200 seeded locations have heading=0
		expect(result).toBe(200);
	});

	// --- Tag selection ---

	it("selectTag selects locations with specific tag", async () => {
		const result = await withApi(async (api, tagId: number) => {
			await api.selectTag(tagId);
			return api.getSelectedLocationIds().size;
		}, tagRedId);
		expect(result).toBe(60);
	});

	it("selectTag for nonexistent tag selects none", async () => {
		const result = await withApi(async (api) => {
			await api.selectTag(999999);
			return api.getSelectedLocationIds().size;
		});
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
		const result = await withApi(async (api) => {
			await api.selectPolygon({
				coordinates: [
					[
						[-180, -10],
						[-90, -10],
						[-90, 0],
						[-180, 0],
						[-180, -10],
					],
				],
			});
			return api.getSelectedLocationIds().size;
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
			await api.selectDuplicates(1);
			const ids = api.getSelectedLocationIds();
			return { count: ids.size };
		});
		expect(result.count).toBeGreaterThanOrEqual(1);
	});
});

describe("Selection operations", () => {
	let mapId: string;
	let tagAId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Selection Ops");

		const tagA = await createTag("tag-a");
		tagAId = tagA.id;

		const locs: Location[] = [];
		for (let i = 0; i < 100; i++) {
			locs.push(
				createLocation({
					lat: i,
					lng: i,
					panoId: i < 40 ? `pano_${i}` : null,
					flags: i < 30 ? 1 : 0,
					tags: i < 50 ? [tagAId] : [],
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

	it("intersection of two selections", async () => {
		const result = await withApi(async (api, tagId: number) => {
			await api.selectPanoIds(); // 30 (flags=1)
			await api.selectTag(tagId); // 50 (indices 0-49)
			// PanoIds (0-29) intersect Tag-a (0-49) = 30
			await api.selectIntersection();
			const sels = api.getSelections();
			return { count: api.getSelectedLocationIds().size, selCount: sels.length };
		}, tagAId);
		expect(result.count).toBe(30);
	});

	it("union of two selections", async () => {
		const result = await withApi(async (api, tagId: number) => {
			await api.selectPanoIds(); // 30
			await api.selectTag(tagId); // 50
			// Union: 0-29 + 0-49 = 0-49 = 50
			await api.selectUnion();
			return api.getSelectedLocationIds().size;
		}, tagAId);
		expect(result).toBe(50);
	});

	it("invert selection", async () => {
		const result = await withApi(async (api) => {
			await api.selectPanoIds(); // 30
			await api.selectInverse(); // 100 - 30 = 70
			return api.getSelectedLocationIds().size;
		});
		expect(result).toBe(70);
	});

	it("remove selection by key", async () => {
		const result = await withApi(async (api, tagId: number) => {
			await api.selectPanoIds();
			await api.selectTag(tagId);
			const before = api.getSelections().length;
			const key = api.getSelections()[0].key;
			api.removeSelection(key);
			const after = api.getSelections().length;
			return { before, after };
		}, tagAId);
		expect(result.before).toBe(2);
		expect(result.after).toBe(1);
	});

	it("resetSelections clears all", async () => {
		await withApi(async (api, tagId: number) => {
			await api.selectPanoIds();
			await api.selectTag(tagId);
			await api.selectUntagged();
		}, tagAId);

		const result = await withApi(async (api) => {
			const before = api.getSelections().length;
			api.resetSelections();
			const after = api.getSelections().length;
			return { before, after };
		});
		expect(result.before).toBe(3);
		expect(result.after).toBe(0);
	});

	it("addSelection with custom props", async () => {
		const result = await withApi(async (api) => {
			await api.addSelection({ type: "Everything" });
			const sels = api.getSelections();
			return {
				count: sels.length,
				type: sels[0]?.props?.type,
				locCount: sels[0]?.count,
			};
		});
		expect(result.count).toBe(1);
		expect(result.type).toBe("Everything");
		expect(result.locCount).toBe(100);
	});
});

describe("Selection correctness after mutations", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Sel Mutations");
		await browser.pause(500);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("PanoIds selection updates after flag change", async () => {
		const locs: Location[] = [];
		for (let i = 0; i < 10; i++) {
			locs.push(
				createLocation({
					lat: i,
					lng: i,
					panoId: `pano_${i}`,
					flags: 0,
				}),
			);
		}
		locIds = await addLocs(locs);

		const result = await withApi(async (api, ids: number[]) => {
			await api.selectPanoIds();
			const before = api.getSelectedLocationIds().size;
			for (let i = 0; i < 5; i++) {
				api.updateLocation(ids[i], { flags: 1 });
			}
			await new Promise((r) => setTimeout(r, 500));
			api.resetSelections();
			await api.selectPanoIds();
			const after = api.getSelectedLocationIds().size;
			return { before, after };
		}, locIds);
		expect(result.before).toBe(0);
		expect(result.after).toBe(5);
	});

	it("selection updates after adding locations", async () => {
		const result = await withApi(async (api) => {
			await api.resetSelections();
			await api.selectEverything();
			const before = (await api.syncSelections()).ids.length;

			await api.addLocations([api.createLocation({ lat: 50, lng: 50 })]);

			await api.resetSelections();
			await api.selectEverything();
			const after = (await api.syncSelections()).ids.length;
			return { before, after };
		});
		expect(result.after).toBe(result.before + 1);
	});

	it("selection updates after removing locations", async () => {
		const result = await withApi(async (api) => {
			await api.resetSelections();
			await api.selectEverything();
			const before = (await api.syncSelections()).ids;
			const toRemove = before[before.length - 1];
			api.removeLocations(new Set([toRemove]));
			await new Promise((r) => setTimeout(r, 300));
			const after = (await api.syncSelections()).ids;
			return { before: before.length, after: after.length };
		});
		expect(result.after).toBe(result.before - 1);
	});

	it("PanoIds selection correct after undo of flag change", async () => {
		await withApi(async (api, id: number) => {
			api.resetSelections();
			await api.selectPanoIds();
			api.updateLocation(id, { flags: 0 });
			await new Promise((r) => setTimeout(r, 300));
		}, locIds[0]);

		const afterUnpin = await refreshSelections();
		expect(afterUnpin.length).toBe(4);

		await withApi(async (api) => {
			api.undo();
			await new Promise((r) => setTimeout(r, 300));
		});

		const afterUndo = await refreshSelections();
		expect(afterUndo.length).toBe(5);
	});

	it("tag selection updates after tag added to locations", async () => {
		const testTag = await createTag("test-tag");
		await withApi(
			async (api, ids: number[], tagId: number) => {
				api.resetSelections();
				await api.updateLocation(ids[0], { tags: [tagId] });
				await api.updateLocation(ids[1], { tags: [tagId] });
				await api.selectTag(tagId);
			},
			locIds,
			testTag.id,
		);
		const selected = await refreshSelections();
		expect(selected.length).toBe(2);
	});
});

describe("Selection with Filter", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Filter");
		await browser.pause(500);

		const locs: Location[] = [];
		for (let i = 0; i < 50; i++) {
			locs.push(
				createLocation({
					lat: i,
					lng: i,
					extra: { altitude: i * 10, country: i < 25 ? "US" : "GB" },
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

	it("filter by string equality", async () => {
		const result = await withApi(async (api) => {
			await api.selectFilter("country", "eq", "US");
			return api.getSelectedLocationIds().size;
		});
		expect(result).toBe(25);
	});

	it("filter by string inequality", async () => {
		const result = await withApi(async (api) => {
			await api.selectFilter("country", "neq", "US");
			return api.getSelectedLocationIds().size;
		});
		expect(result).toBe(25);
	});

	it("filter by numeric greater than", async () => {
		const result = await withApi(async (api) => {
			await api.selectFilter("altitude", "gt", 200);
			return api.getSelectedLocationIds().size;
		});
		expect(result).toBe(29);
	});

	it("filter by numeric less than", async () => {
		const result = await withApi(async (api) => {
			await api.selectFilter("altitude", "lt", 100);
			return api.getSelectedLocationIds().size;
		});
		expect(result).toBe(10);
	});

	it("filter by between", async () => {
		const result = await withApi(async (api) => {
			await api.selectFilter("altitude", "between", 100, 200);
			return api.getSelectedLocationIds().size;
		});
		expect(result).toBe(11);
	});
});
