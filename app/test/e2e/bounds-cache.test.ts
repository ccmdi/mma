import type { Location } from "@/bindings.gen";
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	createLocation,
	createTag,
	withApi,
} from "./helpers";

describe("Bounds cache - empty and basic", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Bounds Empty");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("empty map returns null", async () => {
		const bounds = await withApi(async (api) => api.cmd.storeBounds(false));
		expect(bounds).toBeNull();
	});

	it("selected-only on empty map returns null", async () => {
		const bounds = await withApi(async (api) => {
			await api.selectEverything();
			return api.cmd.storeBounds(true);
		});
		expect(bounds).toBeNull();
	});
});

describe("Bounds cache - add and remove", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Bounds AddRemove");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("bounds contain all added locations", async () => {
		await addLocs([
			createLocation({ lat: 10, lng: 20 }),
			createLocation({ lat: 40, lng: 80 }),
			createLocation({ lat: -5, lng: -30 }),
		]);

		const bounds = await withApi(async (api) => api.cmd.storeBounds(false));
		expect(bounds).not.toBeNull();
		const [west, south, east, north] = bounds!;
		expect(south).toBeCloseTo(-5, 3);
		expect(north).toBeCloseTo(40, 3);
		expect(west).toBeCloseTo(-30, 3);
		expect(east).toBeCloseTo(80, 3);
	});

	it("adding an interior point does not change bounds", async () => {
		await addLocs([createLocation({ lat: 15, lng: 10 })]);

		const bounds = await withApi(async (api) => api.cmd.storeBounds(false));
		const [west, south, east, north] = bounds!;
		expect(south).toBeCloseTo(-5, 3);
		expect(north).toBeCloseTo(40, 3);
		expect(west).toBeCloseTo(-30, 3);
		expect(east).toBeCloseTo(80, 3);
	});

	it("adding an extremal point expands bounds", async () => {
		await addLocs([createLocation({ lat: 60, lng: 100 })]);

		const bounds = await withApi(async (api) => api.cmd.storeBounds(false));
		const [west, south, east, north] = bounds!;
		expect(north).toBeCloseTo(60, 3);
		expect(east).toBeCloseTo(100, 3);
		expect(south).toBeCloseTo(-5, 3);
		expect(west).toBeCloseTo(-30, 3);
	});

	it("removing an edge location shrinks bounds", async () => {
		const result = await withApi(async (api) => {
			const all = await api.fetchAllLocations();
			const northernmost = all.reduce((a, b) => (a.lat > b.lat ? a : b));
			await api.removeLocations(new Set([northernmost.id]));
			return api.cmd.storeBounds(false);
		});

		const [west, south, east, north] = result!;
		expect(north).toBeCloseTo(40, 3);
		expect(east).toBeCloseTo(80, 3);
		expect(south).toBeCloseTo(-5, 3);
		expect(west).toBeCloseTo(-30, 3);
	});

	it("removing all locations returns null", async () => {
		const bounds = await withApi(async (api) => {
			const all = await api.fetchAllLocations();
			await api.removeLocations(new Set(all.map((l) => l.id)));
			return api.cmd.storeBounds(false);
		});
		expect(bounds).toBeNull();
	});
});

describe("Bounds cache - update edge invalidation", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Bounds Update");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("moving an edge location inward shrinks bounds", async () => {
		const ids = await addLocs([
			createLocation({ lat: 10, lng: 20 }),
			createLocation({ lat: 50, lng: 80 }),
		]);

		let bounds = await withApi(async (api) => api.cmd.storeBounds(false));
		expect(bounds![3]).toBeCloseTo(50, 3);

		await withApi(async (api, edgeId) => {
			const loc = await api.fetchLocation(edgeId);
			await api.updateLocations([{ id: loc!.id, patch: { lat: 30 } }]);
		}, ids[1]);

		bounds = await withApi(async (api) => api.cmd.storeBounds(false));
		expect(bounds![3]).toBeCloseTo(30, 3);
		expect(bounds![1]).toBeCloseTo(10, 3);
	});

	it("moving an interior location to a new extreme expands bounds", async () => {
		const result = await withApi(async (api) => {
			const all = await api.fetchAllLocations();
			const interior = all.find((l) => Math.abs(l.lat - 10) < 0.01)!;
			await api.updateLocations([{ id: interior.id, patch: { lat: 70 } }]);
			return api.cmd.storeBounds(false);
		});

		expect(result![3]).toBeCloseTo(70, 3);
	});
});

describe("Bounds cache - antimeridian", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Bounds Antimeridian");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("locations near 180/-180 produce a crossing box (west > east)", async () => {
		await addLocs([
			createLocation({ lat: -18, lng: 178 }),
			createLocation({ lat: -21, lng: -175 }),
		]);

		const bounds = await withApi(async (api) => api.cmd.storeBounds(false));
		expect(bounds).not.toBeNull();
		const [west, , east] = bounds!;
		expect(west).toBeGreaterThan(east);
	});

	it("wide-span locations stay non-crossing (west < east)", async () => {
		await withApi(async (api) => {
			const all = await api.fetchAllLocations();
			await api.removeLocations(new Set(all.map((l) => l.id)));
		});

		await addLocs([createLocation({ lat: 40, lng: -9 }), createLocation({ lat: 35, lng: 140 })]);

		const bounds = await withApi(async (api) => api.cmd.storeBounds(false));
		expect(bounds).not.toBeNull();
		const [west, , east] = bounds!;
		expect(west).toBeLessThan(east);
		expect(west).toBeCloseTo(-9, 3);
		expect(east).toBeCloseTo(140, 3);
	});
});

describe("Bounds cache - undo/redo consistency", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Bounds UndoRedo");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("undo add reverts bounds", async () => {
		await addLocs([createLocation({ lat: 10, lng: 20 })]);
		await addLocs([createLocation({ lat: 60, lng: 120 })]);

		let bounds = await withApi(async (api) => api.cmd.storeBounds(false));
		expect(bounds![3]).toBeCloseTo(60, 3);

		await withApi(async (api) => api.undo());

		bounds = await withApi(async (api) => api.cmd.storeBounds(false));
		expect(bounds![3]).toBeCloseTo(10, 3);
		expect(bounds![2]).toBeCloseTo(20, 3);
	});

	it("redo restores bounds", async () => {
		await withApi(async (api) => api.redo());

		const bounds = await withApi(async (api) => api.cmd.storeBounds(false));
		expect(bounds![3]).toBeCloseTo(60, 3);
		expect(bounds![2]).toBeCloseTo(120, 3);
	});

	it("undo remove restores bounds", async () => {
		await withApi(async (api) => {
			const all = await api.fetchAllLocations();
			const extreme = all.find((l) => Math.abs(l.lat - 60) < 0.01)!;
			await api.removeLocations(new Set([extreme.id]));
		});

		let bounds = await withApi(async (api) => api.cmd.storeBounds(false));
		expect(bounds![3]).toBeCloseTo(10, 3);

		await withApi(async (api) => api.undo());

		bounds = await withApi(async (api) => api.cmd.storeBounds(false));
		expect(bounds![3]).toBeCloseTo(60, 3);
	});

	it("undo to empty returns null", async () => {
		await withApi(async (api) => {
			await api.undo();
			await api.undo();
			await api.undo();
		});

		const bounds = await withApi(async (api) => api.cmd.storeBounds(false));
		expect(bounds).toBeNull();
	});
});

describe("Bounds cache - selected-only", () => {
	let mapId: string;
	let tagId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Bounds Selected");

		const tag = await createTag("bounds-tag");
		tagId = tag.id;

		const tagged: Location[] = [];
		for (let i = 0; i < 3; i++) {
			tagged.push(createLocation({ lat: 10 + i, lng: 20 + i, tags: [tagId] }));
		}
		const untagged: Location[] = [];
		for (let i = 0; i < 3; i++) {
			untagged.push(createLocation({ lat: 50 + i, lng: 80 + i, tags: [] }));
		}
		await addLocs([...tagged, ...untagged]);
	});

	after(async () => {
		await withApi(async (api) => api.resetSelections());
		await closeMap();
		await deleteMap(mapId);
	});

	it("full bounds include all locations", async () => {
		const bounds = await withApi(async (api) => api.cmd.storeBounds(false));
		expect(bounds![3]).toBeCloseTo(52, 3);
		expect(bounds![2]).toBeCloseTo(82, 3);
	});

	it("selected-only bounds are restricted to selection", async () => {
		const bounds = await withApi(async (api, tid) => {
			await api.selectTag(tid);
			return api.cmd.storeBounds(true);
		}, tagId);

		expect(bounds).not.toBeNull();
		expect(bounds![3]).toBeCloseTo(12, 3);
		expect(bounds![2]).toBeCloseTo(22, 3);
		expect(bounds![1]).toBeCloseTo(10, 3);
		expect(bounds![0]).toBeCloseTo(20, 3);
	});

	it("selected-only with no selection returns null", async () => {
		const bounds = await withApi(async (api) => {
			api.resetSelections();
			return api.cmd.storeBounds(true);
		});
		expect(bounds).toBeNull();
	});
});
