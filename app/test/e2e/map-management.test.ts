import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	flushAndWait,
	openMap,
	addLocs,
	getLocCount,
	createLocation,
	withApi,
	seedLocs,
	selectCount,
} from "./helpers";
import type { MapMeta } from "@/bindings.gen";

describe("Map management", () => {
	const createdMapIds: string[] = [];

	before(async () => {
		await waitForReady();
	});

	afterEach(async () => {
		await closeMap();
	});

	after(async () => {
		for (const id of createdMapIds) {
			await deleteMap(id);
		}
	});

	it("create a map", async () => {
		const id = await createAndOpenMap("Test Map 1");
		createdMapIds.push(id);

		const name = await withApi(async (api) => api.getMapState().map?.meta.name);
		expect(name).toBe("Test Map 1");

		const count = await getLocCount();
		expect(count).toBe(0);

		await closeMap();
	});

	it("create multiple maps", async () => {
		for (let i = 2; i <= 5; i++) {
			const id = await withApi(async (api, name) => {
				const map = await api.cmd.storeCreateMap(name, null);
				return map.meta.id;
			}, `Test Map ${i}`);
			expect(id).not.toContain("ERROR");
			createdMapIds.push(id);
		}

		const maps = await withApi(async (api) => {
			return await api.cmd.storeListMaps();
		});
		// At least our 5 maps exist (might be more from other test suites running)
		const ourMaps = maps.filter((m: MapMeta) => m.name.startsWith("Test Map"));
		expect(ourMaps.length).toBeGreaterThanOrEqual(4);
	});

	it("list maps returns all created maps", async () => {
		const maps = await withApi(async (api) => {
			return await api.cmd.storeListMaps();
		});
		expect(Array.isArray(maps)).toBe(true);
		expect(maps.length).toBeGreaterThanOrEqual(4);
	});

	it("open and close a map", async () => {
		await openMap(createdMapIds[0]);

		const map = await withApi(async (api) => {
			const state = api.getMapState();
			return state.map ? { id: state.mapId, name: state.map.meta.name } : null;
		});
		expect(map).not.toBeNull();
		expect(map!.id).toBe(createdMapIds[0]);

		await closeMap();

		const closed = await withApi(async (api) => {
			return api.getMapState().map;
		});
		expect(closed).toBeNull();
	});

	it("delete a map removes it from list", async () => {
		const idToDelete = createdMapIds.pop()!;

		const beforeCount = await withApi(async (api) => {
			const maps = await api.cmd.storeListMaps();
			return maps.length;
		});

		await deleteMap(idToDelete);

		const afterCount = await withApi(async (api) => {
			const maps = await api.cmd.storeListMaps();
			return maps.length;
		});

		expect(afterCount).toBe(beforeCount - 1);
	});

	it("deleting the currently-open map closes the editor and removes it", async () => {
		const id = await createAndOpenMap("Delete While Open");
		await addLocs([createLocation({ lat: 1, lng: 1 })]);
		await flushAndWait();

		// Real delete path (store.deleteMap broadcasts map-deleted), unlike the raw
		// storeDeleteMap helper. The open window must drop the map in response.
		await withApi(async (api, mapId) => api._test.deleteMap(mapId), id);

		await browser.waitUntil(async () => withApi(async (api) => api.getMapState().map === null), {
			timeout: 5000,
			timeoutMsg: "open map was not closed after delete",
		});

		const exists = await withApi(
			async (api, mapId) => (await api.cmd.storeListMaps()).some((m) => m.id === mapId),
			id,
		);
		expect(exists).toBe(false);
	});

	it("open map with locations shows correct count", async () => {
		await openMap(createdMapIds[0]);

		await seedLocs(25, (i) => ({ lat: i, lng: i }));

		await flushAndWait();
		await closeMap();
		await openMap(createdMapIds[0]);

		const count = await getLocCount();
		expect(count).toBe(25);
	});
});

describe("Map metadata", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await withApi(async (api) => {
			const map = await api.cmd.storeCreateMap("Meta Test Map", null);
			return map.meta.id;
		});
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("map has correct initial metadata", async () => {
		await openMap(mapId);
		const meta = await withApi(async (api) => {
			return api.getMapState().map!.meta;
		});
		expect(meta.name).toBe("Meta Test Map");
		expect(meta.description).toBe("");
		expect(meta.folder).toBeNull();
		expect(typeof meta.createdAt).toBe("string");
		expect(typeof meta.updatedAt).toBe("string");
	});

	it("location count updates in meta after adding locations", async () => {
		await addLocs([createLocation({ lat: 10, lng: 20 })]);

		const count = await getLocCount();
		expect(count).toBe(1);
	});
});

describe("Empty map edge cases", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await withApi(async (api) => {
			const map = await api.cmd.storeCreateMap("Empty Map", null);
			return map.meta.id;
		});
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("open empty map has zero locations", async () => {
		await openMap(mapId);
		const count = await getLocCount();
		expect(count).toBe(0);
	});

	it("selectEverything on empty map selects nothing", async () => {
		const count = await selectCount({ type: "Everything" });
		expect(count).toBe(0);
	});

	it("undo on empty map is a no-op", async () => {
		await withApi(async (api) => api.undo());
		const count = await getLocCount();
		expect(count).toBe(0);
	});

	it("redo on empty map is a no-op", async () => {
		await withApi(async (api) => api.redo());
		const count = await getLocCount();
		expect(count).toBe(0);
	});

	it("remove from empty map is a no-op", async () => {
		await withApi(async (api) => {
			await api.removeLocations(new Set([999999]));
		});
		const count = await getLocCount();
		expect(count).toBe(0);
	});

	it("save empty map then reopen", async () => {
		await flushAndWait();
		await closeMap();
		await openMap(mapId);
		const count = await getLocCount();
		expect(count).toBe(0);
	});
});
