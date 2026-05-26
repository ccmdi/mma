import type { Location } from "@/types";
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	flushAndWait,
	openMap,
	addLocs,
	getLoc,
	getLocCount,
	createLocation,
	withApi,
} from "./helpers";

describe("Undo/Redo", () => {
	let mapId: string;
	let undo1Id: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Undo Redo");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("undo add locations", async () => {
		const ids = await addLocs([createLocation({ lat: 10, lng: 20, heading: 0 })]);
		undo1Id = ids[0];

		let count = await getLocCount();
		expect(count).toBe(1);

		await withApi(async (api) => {
			await api.undo();
		});

		count = await getLocCount();
		expect(count).toBe(0);
	});

	it("redo restores undone add", async () => {
		await withApi(async (api) => {
			await api.redo();
		});

		const count = await getLocCount();
		expect(count).toBe(1);
	});

	it("undo remove locations", async () => {
		await withApi(async (api, id) => {
			await api.removeLocations(new Set([id]));
		}, undo1Id);

		let count = await getLocCount();
		expect(count).toBe(0);

		await withApi(async (api) => {
			await api.undo();
		});

		count = await getLocCount();
		expect(count).toBe(1);
	});

	it("undo update restores original values", async () => {
		await withApi(async (api, id) => {
			await api.updateLocation(id, { lat: 99, heading: 270 });
		}, undo1Id);

		let loc = await getLoc(undo1Id);
		expect(loc.lat).toBe(99);
		expect(loc.heading).toBe(270);

		await withApi(async (api) => {
			await api.undo();
		});

		loc = await getLoc(undo1Id);
		expect(loc.lat).toBe(10);
		expect(loc.heading).toBe(0);
	});

	it("multiple undos in sequence", async () => {
		// Add three locations in separate calls (separate undo entries)
		await withApi(async (api) => {
			await api.addLocations([api.createLocation({ lat: 1, lng: 1, zoom: 1 })]);
			await api.addLocations([api.createLocation({ lat: 2, lng: 2, zoom: 1 })]);
			await api.addLocations([api.createLocation({ lat: 3, lng: 3, zoom: 1 })]);
		});

		let count = await getLocCount();
		expect(count).toBe(4); // undo-1 + seq-1,2,3

		await withApi(async (api) => {
			await api.undo(); // removes seq-3
			await api.undo(); // removes seq-2
			await api.undo(); // removes seq-1
		});

		count = await getLocCount();
		expect(count).toBe(1); // only undo-1 remains
	});

	it("redo after undo chain", async () => {
		await withApi(async (api) => {
			await api.redo();
			await api.redo();
		});

		const count = await getLocCount();
		expect(count).toBe(3); // undo-1 + seq-1 + seq-2
	});

	it("new edit clears redo stack", async () => {
		await withApi(async (api) => {
			await api.addLocations([api.createLocation({ lat: 0, lng: 0, zoom: 1 })]);
			await api.redo(); // should be no-op since new edit clears redo
		});

		const count = await getLocCount();
		expect(count).toBe(4); // undo-1 + seq-1 + seq-2 + new-edit
	});

	it("undo bulk operation", async () => {
		await withApi(async (api) => {
			const locs: Location[] = [];
			for (let i = 0; i < 200; i++) {
				locs.push(api.createLocation({ lat: i, lng: i, zoom: 1 }));
			}
			await api.addLocations(locs);
		});

		let count = await getLocCount();
		expect(count).toBe(204);

		await withApi(async (api) => {
			await api.undo();
		});

		count = await getLocCount();
		expect(count).toBe(4);
	});

	it("undo batch update restores all originals", async () => {
		// We need the IDs of undo-1 and seq-1 to batch update them.
		// undo-1's id is stored in undo1Id. seq-1 was added via executeAsync
		// so we need to find it by its lat value.
		const result = await withApi(async (api, u1Id) => {
			const allLocs = await api.fetchAllLocations();
			// seq-1 has lat=1
			const seq1 = allLocs.find((l) => l.lat === 1);
			if (!seq1) throw new Error("seq-1 not found");

			await api.batchUpdateLocations([
				{ id: u1Id, patch: { heading: 111 } },
				{ id: seq1.id, patch: { heading: 222 } },
			]);
			return { seq1Id: seq1.id };
		}, undo1Id);
		const seq1Id = result.seq1Id;

		let u1 = await getLoc(undo1Id);
		let s1 = await getLoc(seq1Id);
		expect(u1.heading).toBe(111);
		expect(s1.heading).toBe(222);

		await withApi(async (api) => {
			await api.undo();
		});

		u1 = await getLoc(undo1Id);
		s1 = await getLoc(seq1Id);
		expect(u1.heading).toBe(0); // undo-1 was created with heading: 0
		expect(s1.heading).toBe(0); // seq-1 was created with heading: 0
	});
});

describe("Undo/Redo persistence", () => {
	let mapId: string;
	let uh1Id: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Undo Persist");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("undo history survives save/load", async () => {
		const result = await withApi(async (api) => {
			const l1 = [api.createLocation({ lat: 10, lng: 10, zoom: 1 })];
			await api.addLocations(l1);
			const l2 = [api.createLocation({ lat: 20, lng: 20, zoom: 1 })];
			await api.addLocations(l2);
			return { id1: l1[0].id, id2: l2[0].id };
		});
		uh1Id = result.id1;

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		// Wait for edit history to load
		await browser.pause(1000);

		await withApi(async (api) => {
			await api.undo();
		});

		const count = await getLocCount();
		expect(count).toBe(1);
	});

	it("flags survive undo across save/load", async () => {
		await withApi(async (api, id) => {
			await api.updateLocation(id, { flags: 1, panoId: "PIN" });
		}, uh1Id);

		await flushAndWait();
		await closeMap();
		await openMap(mapId);
		await browser.pause(1000);

		const before = await getLoc(uh1Id);
		expect(before.flags).toBe(1);
		expect(before.panoId).toBe("PIN");

		await withApi(async (api) => {
			await api.undo();
		});

		const after = await getLoc(uh1Id);
		expect(after.flags).toBe(0);
		expect(after.panoId).toBeNull();
	});
});
