import type { Location } from "@/bindings.gen";
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	openMap,
	addLocs,
	createLocation,
	makeLocs,
	getAllLocs,
	getLocCount,
	flushAndWait,
	withApi,
} from "./helpers";

type Row = Pick<Location, "id" | "lat" | "lng" | "heading" | "tags">;

async function snapshot(): Promise<Row[]> {
	return (await getAllLocs())
		.map(({ id, lat, lng, heading, tags }) => ({ id, lat, lng, heading, tags }))
		.sort((a, b) => a.id - b.id);
}

async function history() {
	return withApi(async (api) => {
		const s = api.Store.get();
		return {
			canUndo: api.History.available(s.history, "undo", "edits"),
			canRedo: api.History.available(s.history, "redo", "edits"),
		};
	});
}

const undo = () => withApi(async (api) => api.History.step("undo", "edits"));
const redo = () => withApi(async (api) => api.History.step("redo", "edits"));

async function reopen(id: string) {
	await flushAndWait();
	await closeMap();
	await openMap(id);
}

describe("Undo history across close and reopen", () => {
	let mapId: string;
	const states: Row[][] = [];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Undo Reopen");
	});

	after(async () => {
		await closeMap();
		if (mapId) await deleteMap(mapId);
	});

	it("every step of a mixed history undoes and redoes the same after a reopen", async () => {
		states.push(await snapshot());
		const [a, b] = await addLocs([
			createLocation({ lat: 10, lng: 10 }),
			createLocation({ lat: 20, lng: 20 }),
			createLocation({ lat: 30, lng: 30 }),
		]);
		states.push(await snapshot());
		await withApi(async (api, id) => api.Location.update([{ id, heading: 90 }]), a);
		states.push(await snapshot());
		await withApi(async (api, id) => api.Location.remove(new Set([id])), b);
		states.push(await snapshot());
		await addLocs([createLocation({ lat: 40, lng: 40 }), createLocation({ lat: 50, lng: 50 })]);
		states.push(await snapshot());

		await reopen(mapId);
		expect(await snapshot()).toEqual(states[4]);
		expect(await history()).toEqual({ canUndo: true, canRedo: false });

		for (const step of [3, 2, 1, 0]) {
			await undo();
			expect(await snapshot()).toEqual(states[step]);
		}
		expect(await history()).toEqual({ canUndo: false, canRedo: true });

		for (const step of [1, 2, 3, 4]) {
			await redo();
			expect(await snapshot()).toEqual(states[step]);
		}
		expect(await history()).toEqual({ canUndo: true, canRedo: false });
	});

	it("a partly undone history keeps its order across reopens", async () => {
		await undo();
		await undo();
		await reopen(mapId);
		expect(await snapshot()).toEqual(states[2]);
		expect(await history()).toEqual({ canUndo: true, canRedo: true });

		await redo();
		expect(await snapshot()).toEqual(states[3]);
		await reopen(mapId);
		expect(await snapshot()).toEqual(states[3]);

		await redo();
		expect(await snapshot()).toEqual(states[4]);
		await undo();
		await reopen(mapId);
		expect(await snapshot()).toEqual(states[3]);
		await redo();
		expect(await snapshot()).toEqual(states[4]);
	});

	it("a new edit after a reopen drops the redo it inherited, for good", async () => {
		await undo();
		await reopen(mapId);
		expect((await history()).canRedo).toBe(true);

		await addLocs([createLocation({ lat: 60, lng: 60 })]);
		expect((await history()).canRedo).toBe(false);
		await reopen(mapId);
		expect((await history()).canRedo).toBe(false);

		await undo();
		expect(await snapshot()).toEqual(states[3]);
	});

	it("an undone delete brings its id back without colliding with ids added after a reopen", async () => {
		const [gone] = await addLocs([createLocation({ lat: 70, lng: 70 })]);
		await withApi(async (api, id) => api.Location.remove(new Set([id])), gone);
		await reopen(mapId);

		const [fresh] = await addLocs([createLocation({ lat: 80, lng: 80 })]);
		expect(fresh).not.toBe(gone);
		await undo();
		await undo();
		const ids = (await snapshot()).map((r) => r.id);
		expect(ids).toContain(gone);
		expect(ids).not.toContain(fresh);

		await redo();
		await redo();
		const after = (await snapshot()).map((r) => r.id);
		expect(after).toContain(fresh);
		expect(after).not.toContain(gone);
		expect(new Set(after).size).toBe(after.length);
	});

	it("one large edit reopens and undoes as a whole", async () => {
		const before = await getLocCount();
		await addLocs(makeLocs(5000, (i) => ({ lat: (i % 170) - 85, lng: (i % 350) - 175 })));
		await reopen(mapId);
		expect(await getLocCount()).toBe(before + 5000);

		await undo();
		expect(await getLocCount()).toBe(before);
		await reopen(mapId);
		await redo();
		expect(await getLocCount()).toBe(before + 5000);
	});

	it("a commit leaves no history to reopen", async () => {
		await withApi(async (api) => api.Commit.create("checkpoint"));
		await reopen(mapId);
		expect(await history()).toEqual({ canUndo: false, canRedo: false });
	});
});
