import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	createLocation,
	flushAndWait,
	withApi,
} from "./helpers";

describe("Dirty tracking", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Dirty Tracking");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("starts with zero dirty count on new map", async () => {
		const count = await withApi(async (api) => api.getDirtyCount());
		expect(count).toBe(0);
	});

	it("dirty count increases after adding locations", async () => {
		await addLocs([createLocation({ lat: 10, lng: 20 })]);
		const count = await withApi(async (api) => api.getDirtyCount());
		expect(count).toBeGreaterThan(0);
	});

	it("dirty count decreases after flush", async () => {
		const before = await withApi(async (api) => api.getDirtyCount());
		await flushAndWait();
		const after = await withApi(async (api) => api.getDirtyCount());
		expect(after).toBeLessThanOrEqual(before);
	});

	it("dirty count increases after update", async () => {
		const ids = await addLocs([createLocation({ lat: 30, lng: 40 })]);
		await flushAndWait();

		await withApi(async (api, id) => {
			await api.updateLocation(id, { heading: 90 });
		}, ids[0]);

		const count = await withApi(async (api) => api.getDirtyCount());
		expect(count).toBeGreaterThan(0);
	});

	it("dirty count increases after remove", async () => {
		const ids = await addLocs([createLocation({ lat: 50, lng: 60 })]);
		await flushAndWait();

		await withApi(async (api, id) => {
			await api.removeLocations(new Set([id]));
		}, ids[0]);

		const count = await withApi(async (api) => api.getDirtyCount());
		expect(count).toBeGreaterThan(0);
	});

	it("multiple changes before flush accumulate", async () => {
		await flushAndWait();
		await addLocs([
			createLocation({ lat: 1, lng: 1 }),
			createLocation({ lat: 2, lng: 2 }),
			createLocation({ lat: 3, lng: 3 }),
		]);
		const count = await withApi(async (api) => api.getDirtyCount());
		expect(count).toBeGreaterThan(0);
	});
});

describe("Dirty tracking across undo/redo", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Dirty Undo");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("undo marks map as dirty", async () => {
		await addLocs([createLocation({ lat: 10, lng: 20 })]);
		await flushAndWait();

		await withApi(async (api) => api.undo());
		const afterUndo = await withApi(async (api) => api.getDirtyCount());
		expect(afterUndo).toBeGreaterThan(0);
	});

	it("redo after undo also marks dirty", async () => {
		await withApi(async (api) => api.redo());
		const count = await withApi(async (api) => api.getDirtyCount());
		expect(count).toBeGreaterThan(0);
	});
});
