import {
	addLocs,
	getLoc,
	createLocation,
	flushAndWait,
	withApi,
	useMap,
	getSummary,
	waitUntilSaved,
} from "./helpers";

describe("Dirty tracking", () => {
	useMap("E2E Dirty Tracking");

	it("starts with nothing unsaved on a new map", async () => {
		const unsaved = await getSummary().then((s) => s.unsaved);
		expect(unsaved).toBe(false);
	});

	it("is unsaved after adding locations", async () => {
		await addLocs([createLocation({ lat: 10, lng: 20 })]);
		const unsaved = await getSummary().then((s) => s.unsaved);
		expect(unsaved).toBe(true);
	});

	it("is saved after flush", async () => {
		await flushAndWait();
		await waitUntilSaved();
	});

	it("is unsaved after update", async () => {
		const ids = await addLocs([createLocation({ lat: 30, lng: 40 })]);
		await flushAndWait();

		const loc = await getLoc(ids[0]);
		await withApi(async (api, l) => {
			await api.Location.update([{ id: l.id, heading: 90 }]);
		}, loc);

		const unsaved = await getSummary().then((s) => s.unsaved);
		expect(unsaved).toBe(true);
	});

	it("is unsaved after remove", async () => {
		const ids = await addLocs([createLocation({ lat: 50, lng: 60 })]);
		await flushAndWait();

		await withApi(async (api, id) => {
			await api.Location.remove(new Set([id]));
		}, ids[0]);

		const unsaved = await getSummary().then((s) => s.unsaved);
		expect(unsaved).toBe(true);
	});

	it("multiple changes before flush accumulate", async () => {
		await flushAndWait();
		await addLocs([
			createLocation({ lat: 1, lng: 1 }),
			createLocation({ lat: 2, lng: 2 }),
			createLocation({ lat: 3, lng: 3 }),
		]);
		const unsaved = await getSummary().then((s) => s.unsaved);
		expect(unsaved).toBe(true);
	});
});

describe("Dirty tracking across undo/redo", () => {
	useMap("E2E Dirty Undo");

	it("undo leaves the map unsaved", async () => {
		await addLocs([createLocation({ lat: 10, lng: 20 })]);
		await flushAndWait();

		await withApi(async (api) => api.History.step("undo", "edits"));
		const afterUndo = await getSummary().then((s) => s.unsaved);
		expect(afterUndo).toBe(true);
	});

	it("redo after undo is unsaved too", async () => {
		await withApi(async (api) => api.History.step("redo", "edits"));
		const unsaved = await getSummary().then((s) => s.unsaved);
		expect(unsaved).toBe(true);
	});
});
