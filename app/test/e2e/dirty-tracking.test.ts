import { addLocs, getLoc, createLocation, flushAndWait, withApi, useMap } from "./helpers";

describe("Dirty tracking", () => {
	useMap("E2E Dirty Tracking");

	it("starts with zero dirty count on new map", async () => {
		const count = await withApi(async (api) => (await api.cmd.storeGetSummary()).dirtyCount);
		expect(count).toBe(0);
	});

	it("dirty count increases after adding locations", async () => {
		await addLocs([createLocation({ lat: 10, lng: 20 })]);
		const count = await withApi(async (api) => (await api.cmd.storeGetSummary()).dirtyCount);
		expect(count).toBeGreaterThan(0);
	});

	it("dirty count decreases after flush", async () => {
		const before = await withApi(async (api) => (await api.cmd.storeGetSummary()).dirtyCount);
		await flushAndWait();
		const after = await withApi(async (api) => (await api.cmd.storeGetSummary()).dirtyCount);
		expect(after).toBeLessThanOrEqual(before);
	});

	it("dirty count increases after update", async () => {
		const ids = await addLocs([createLocation({ lat: 30, lng: 40 })]);
		await flushAndWait();

		const loc = await getLoc(ids[0]);
		await withApi(async (api, l) => {
			await api.updateLocations([{ id: l.id, patch: { heading: 90 } }]);
		}, loc);

		const count = await withApi(async (api) => (await api.cmd.storeGetSummary()).dirtyCount);
		expect(count).toBeGreaterThan(0);
	});

	it("dirty count increases after remove", async () => {
		const ids = await addLocs([createLocation({ lat: 50, lng: 60 })]);
		await flushAndWait();

		await withApi(async (api, id) => {
			await api.removeLocations(new Set([id]));
		}, ids[0]);

		const count = await withApi(async (api) => (await api.cmd.storeGetSummary()).dirtyCount);
		expect(count).toBeGreaterThan(0);
	});

	it("multiple changes before flush accumulate", async () => {
		await flushAndWait();
		await addLocs([
			createLocation({ lat: 1, lng: 1 }),
			createLocation({ lat: 2, lng: 2 }),
			createLocation({ lat: 3, lng: 3 }),
		]);
		const count = await withApi(async (api) => (await api.cmd.storeGetSummary()).dirtyCount);
		expect(count).toBeGreaterThan(0);
	});
});

describe("Dirty tracking across undo/redo", () => {
	useMap("E2E Dirty Undo");

	it("undo marks map as dirty", async () => {
		await addLocs([createLocation({ lat: 10, lng: 20 })]);
		await flushAndWait();

		await withApi(async (api) => api.undo());
		const afterUndo = await withApi(async (api) => (await api.cmd.storeGetSummary()).dirtyCount);
		expect(afterUndo).toBeGreaterThan(0);
	});

	it("redo after undo also marks dirty", async () => {
		await withApi(async (api) => api.redo());
		const count = await withApi(async (api) => (await api.cmd.storeGetSummary()).dirtyCount);
		expect(count).toBeGreaterThan(0);
	});
});
