/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	createLocation,
	createTag,
	getLocCount,
	flushAndWait,
	openMap,
	withApi,
} from "./helpers";

describe("Multi-map isolation", () => {
	let mapAId: string;
	let mapBId: string;

	before(async () => {
		await waitForReady();
	});

	after(async () => {
		await closeMap();
		if (mapAId) await deleteMap(mapAId);
		if (mapBId) await deleteMap(mapBId);
	});

	it("create two maps with different data", async () => {
		mapAId = await createAndOpenMap("E2E Map A");
		await addLocs([
			createLocation({ lat: 10, lng: 10 }),
			createLocation({ lat: 20, lng: 20 }),
			createLocation({ lat: 30, lng: 30 }),
		]);
		await flushAndWait();
		await closeMap();

		mapBId = await createAndOpenMap("E2E Map B");
		await addLocs([
			createLocation({ lat: 40, lng: 40 }),
			createLocation({ lat: 50, lng: 50 }),
		]);
		await flushAndWait();
		await closeMap();
	});

	it("map A has 3 locations", async () => {
		await openMap(mapAId);
		const count = await getLocCount();
		expect(count).toBe(3);
		await closeMap();
	});

	it("map B has 2 locations", async () => {
		await openMap(mapBId);
		const count = await getLocCount();
		expect(count).toBe(2);
		await closeMap();
	});

	it("adding to map B does not affect map A", async () => {
		await openMap(mapBId);
		await addLocs([createLocation({ lat: 60, lng: 60 })]);
		await flushAndWait();
		await closeMap();

		await openMap(mapAId);
		const count = await getLocCount();
		expect(count).toBe(3);
		await closeMap();
	});

	it("tags are scoped to their map", async () => {
		await openMap(mapAId);
		await createTag("MapA-Only");
		await flushAndWait();
		await closeMap();

		await openMap(mapBId);
		const hasTags = await withApi(async (api) => {
			const map = api.getCurrentMap();
			const tagNames = Object.values(map!.meta.tags).map((t: any) => t.name);
			return tagNames.includes("MapA-Only");
		});
		expect(hasTags).toBe(false);
		await closeMap();
	});

	it("undo history is scoped to each map", async () => {
		await openMap(mapAId);
		await addLocs([createLocation({ lat: 70, lng: 70 })]);
		const countBefore = await getLocCount();
		await flushAndWait();
		await closeMap();

		// Open map B, check undo state
		await openMap(mapBId);
		await withApi(async (api) => api.getUndoRedoState());
		await closeMap();

		// Open map A, undo
		await openMap(mapAId);
		await withApi(async (api) => api.undo());
		const countAfter = await getLocCount();
		expect(countAfter).toBe(countBefore - 1);
		await closeMap();
	});

	it("selections are reset when switching maps", async () => {
		await openMap(mapAId);
		await withApi(async (api) => api.selectEverything());
		const selCountA = await withApi(async (api) => api.getSelections().length);
		expect(selCountA).toBeGreaterThan(0);
		await closeMap();

		await openMap(mapBId);
		const selCountB = await withApi(async (api) => api.getSelections().length);
		expect(selCountB).toBe(0);
		await closeMap();
	});
});

describe("Multi-map metadata isolation", () => {
	let map1Id: string;
	let map2Id: string;

	before(async () => {
		await waitForReady();
		map1Id = await createAndOpenMap("Meta Map 1");
		await withApi(async (api) => {
			await api.updateMapMeta({ description: "Description 1" });
		});
		await flushAndWait();
		await closeMap();

		map2Id = await createAndOpenMap("Meta Map 2");
		await withApi(async (api) => {
			await api.updateMapMeta({ description: "Description 2" });
		});
		await flushAndWait();
		await closeMap();
	});

	after(async () => {
		await closeMap();
		await deleteMap(map1Id);
		await deleteMap(map2Id);
	});

	it("each map retains its own description", async () => {
		await openMap(map1Id);
		const desc1 = await withApi(async (api) => api.getCurrentMap()!.meta.description);
		expect(desc1).toBe("Description 1");
		await closeMap();

		await openMap(map2Id);
		const desc2 = await withApi(async (api) => api.getCurrentMap()!.meta.description);
		expect(desc2).toBe("Description 2");
		await closeMap();
	});

	it("renaming one map does not affect the other", async () => {
		await withApi(async (api, id) => api.renameMap(id, "Renamed Map 1"), map1Id);

		const maps = await withApi(async (api) => api.cmd.storeListMaps());
		const m1 = maps.find((m: any) => m.id === map1Id);
		const m2 = maps.find((m: any) => m.id === map2Id);
		expect(m1!.name).toBe("Renamed Map 1");
		expect(m2!.name).toBe("Meta Map 2");
	});
});
