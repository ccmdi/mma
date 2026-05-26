import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	createLocation,
	flushAndWait,
	openMap,
	getLocCount,
	withApi,
} from "./helpers";

describe("SameLocation — duplicate picker", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E SameLocation");
		await browser.pause(500);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("findNearby returns co-located locations", async () => {
		await addLocs([
			createLocation({ lat: 10.0, lng: 20.0, heading: 0 }),
			createLocation({ lat: 10.0, lng: 20.0, heading: 90 }),
			createLocation({ lat: 10.0, lng: 20.0, heading: 180 }),
		]);

		const nearby = await withApi(async (api) => {
			return await api.cmd.storeFindNearby(10.0, 20.0, 2.0);
		});
		expect(nearby.length).toBe(3);
	});

	it("deleting one co-located location reduces count", async () => {
		const before = await getLocCount();
		const nearby = await withApi(async (api) => {
			return await api.cmd.storeFindNearby(10.0, 20.0, 2.0);
		});
		const toDelete = nearby[0].id;

		await withApi(async (api, id) => {
			api.removeLocations(new Set([id]));
			await new Promise((r) => setTimeout(r, 300));
		}, toDelete);

		const after = await getLocCount();
		expect(after).toBe(before - 1);

		const remaining = await withApi(async (api) => {
			return await api.cmd.storeFindNearby(10.0, 20.0, 2.0);
		});
		expect(remaining.length).toBe(2);
		expect(remaining.every((l: any) => l.id !== toDelete)).toBe(true);
	});
});

describe("Close map persistence", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E CloseMap");
		await browser.pause(500);
	});

	after(async () => {
		try { await closeMap(); } catch {}
		await deleteMap(mapId);
	});

	it("locations survive close/reopen", async () => {
		await addLocs([
			createLocation({ lat: 1, lng: 1, heading: 0 }),
			createLocation({ lat: 2, lng: 2, heading: 90 }),
			createLocation({ lat: 3, lng: 3, heading: 180 }),
		]);
		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const count = await getLocCount();
		expect(count).toBe(3);
	});

	it("undo history survives close/reopen", async () => {
		const before = await getLocCount();
		await addLocs([createLocation({ lat: 50, lng: 50 })]);
		expect(await getLocCount()).toBe(before + 1);

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const canUndo = await withApi(async (api) => {
			const state = await api.getUndoRedoState();
			return state.canUndo;
		});
		expect(canUndo).toBe(true);

		await withApi(async (api) => {
			api.undo();
			await new Promise((r) => setTimeout(r, 300));
		});
		const afterUndo = await getLocCount();
		expect(afterUndo).toBe(before);
	});

	it("dirty changes are saved before close", async () => {
		await addLocs([createLocation({ lat: 99, lng: 99 })]);
		// Don't flush — let closeMap handle it
		await closeMap();
		await openMap(mapId);

		const locs = await withApi(async (api) => api.fetchAllLocations());
		const found = locs.some((l: any) => l.lat === 99);
		expect(found).toBe(true);
	});
});
