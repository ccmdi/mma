import type { Location } from "@/bindings.gen";
import {
	closeMap,
	flushAndWait,
	openMap,
	addLocs,
	getLoc,
	createLocation,
	withApi,
	useMap,
} from "./helpers";

describe("Data integrity - flags", () => {
	const map = useMap("E2E Integrity Flags");
	let fl0Id: number;

	it("flag=0 stays 0 through save/load", async () => {
		const ids = await addLocs([createLocation({ lat: 10, lng: 20, flags: 0 })]);
		fl0Id = ids[0];

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const loc = await getLoc(fl0Id);
		expect(loc.flags).toBe(0);
	});

	it("flag=1 (LoadAsPanoId) survives save/load", async () => {
		const loc = await getLoc(fl0Id);
		await withApi(async (api, l) => {
			await api.updateLocations([{ id: l.id, patch: { flags: 1 } }]);
		}, loc);

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const reloaded = await getLoc(fl0Id);
		expect(reloaded.flags).toBe(1);
	});

	it("flag=2 (Informational) survives save/load", async () => {
		const ids = await addLocs([createLocation({ lat: 30, lng: 40, flags: 2 })]);

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const loc = await getLoc(ids[0]);
		expect(loc.flags).toBe(2);
	});

	it("flag=3 (both bits) survives save/load", async () => {
		const ids = await addLocs([
			createLocation({ lat: 50, lng: 60, flags: 3, panoId: "BOTH_PANO" }),
		]);

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const loc = await getLoc(ids[0]);
		expect(loc.flags).toBe(3);
		expect(loc.panoId).toBe("BOTH_PANO");
	});
});

describe("Data integrity - panoId", () => {
	const map = useMap("E2E Integrity Pano");
	let pnNullId: number;
	let pnStrId: number;

	it("null panoId stays null", async () => {
		const ids = await addLocs([createLocation({ lat: 10, lng: 20, panoId: null })]);
		pnNullId = ids[0];

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const loc = await getLoc(pnNullId);
		expect(loc.panoId).toBeNull();
	});

	it("panoId string survives save/load", async () => {
		const ids = await addLocs([
			createLocation({
				lat: 30,
				lng: 40,
				panoId: "CAoSK0FGMVFpcE9YUV9QMWN6bUc1RG1RMHRES1",
			}),
		]);
		pnStrId = ids[0];

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const loc = await getLoc(pnStrId);
		expect(loc.panoId).toBe("CAoSK0FGMVFpcE9YUV9QMWN6bUc1RG1RMHRES1");
	});

	it("panoId set to null after being set", async () => {
		const loc = await getLoc(pnStrId);
		await withApi(async (api, l) => {
			await api.updateLocations([{ id: l.id, patch: { panoId: null } }]);
		}, loc);

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const reloaded = await getLoc(pnStrId);
		expect(reloaded.panoId).toBeNull();
	});
});

describe("Data integrity - coordinates", () => {
	const map = useMap("E2E Integrity Coords");

	it("extreme lat/lng values survive save/load", async () => {
		const ids = await addLocs([
			createLocation({ lat: 85.05, lng: 179.99, heading: 359.99, pitch: 89, zoom: 5 }),
			createLocation({ lat: -85.05, lng: -179.99, heading: 0.01, pitch: -89, zoom: 0.1 }),
			createLocation({ lat: 0, lng: 0, heading: 0, pitch: 0, zoom: 0 }),
		]);

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const max = await getLoc(ids[0]);
		const min = await getLoc(ids[1]);
		const zero = await getLoc(ids[2]);

		expect(max.lat).toBeCloseTo(85.05, 2);
		expect(max.lng).toBeCloseTo(179.99, 2);
		expect(max.heading).toBeCloseTo(359.99, 2);
		expect(max.pitch).toBeCloseTo(89, 0);
		expect(max.zoom).toBeCloseTo(5, 0);

		expect(min.lat).toBeCloseTo(-85.05, 2);
		expect(min.lng).toBeCloseTo(-179.99, 2);
		expect(min.pitch).toBeCloseTo(-89, 0);

		expect(zero.lat).toBe(0);
		expect(zero.lng).toBe(0);
	});

	it("high-precision coordinates survive", async () => {
		const ids = await addLocs([
			createLocation({
				lat: 40.7128123456789,
				lng: -74.0060987654321,
				heading: 123.456789,
				pitch: -12.345678,
				zoom: 2.718281828,
			}),
		]);

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const loc = await getLoc(ids[0]);
		expect(loc.lat).toBeCloseTo(40.7128123456789, 6);
		expect(loc.lng).toBeCloseTo(-74.0060987654321, 6);
		expect(loc.heading).toBeCloseTo(123.456789, 4);
	});
});

describe("Data integrity - extras", () => {
	const map = useMap("E2E Integrity Extras");

	it("string extra survives", async () => {
		const ids = await addLocs([
			createLocation({
				lat: 10,
				lng: 20,
				extra: { country: "United States of America" },
			}),
		]);

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const loc = await getLoc(ids[0]);
		expect(loc.extra.country).toBe("United States of America");
	});

	it("numeric extra survives", async () => {
		const ids = await addLocs([
			createLocation({
				lat: 20,
				lng: 30,
				extra: { altitude: 8848.86, population: 0, negative: -42 },
			}),
		]);

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const loc = await getLoc(ids[0]);
		expect(loc.extra.altitude).toBeCloseTo(8848.86, 2);
		expect(loc.extra.population).toBe(0);
		expect(loc.extra.negative).toBe(-42);
	});

	it("nested extra object survives", async () => {
		const ids = await addLocs([
			createLocation({
				lat: 30,
				lng: 40,
				extra: { meta: { source: "import", version: 2 }, arr: [1, 2, 3] },
			}),
		]);

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const loc = await getLoc(ids[0]);
		expect(loc.extra.meta.source).toBe("import");
		expect(loc.extra.meta.version).toBe(2);
		expect(loc.extra.arr).toEqual([1, 2, 3]);
	});

	it("empty extra object survives", async () => {
		const ids = await addLocs([
			createLocation({
				lat: 40,
				lng: 50,
				extra: {},
			}),
		]);

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const loc = await getLoc(ids[0]);
		// Empty extra may be omitted or kept as {} -- both are valid
		if (loc.extra && typeof loc.extra === "object") {
			expect(Object.keys(loc.extra).length).toBe(0);
		}
	});

	it("location without extra field survives", async () => {
		const ids = await addLocs([createLocation({ lat: 50, lng: 60 })]);

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const loc = await getLoc(ids[0]);
		expect(loc).toBeTruthy();
		expect(loc.lat).toBe(50);
	});
});

describe("Data integrity - createdAt", () => {
	const map = useMap("E2E Integrity Dates");

	it("createdAt timestamp survives save/load", async () => {
		const date = 1718461800; // 2024-06-15T14:30:00Z
		const ids = await addLocs([createLocation({ lat: 10, lng: 20, createdAt: date })]);

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const loc = await getLoc(ids[0]);
		expect(loc.createdAt).toBe(date);
	});
});

describe("Data integrity - concurrent operations", () => {
	const map = useMap("E2E Integrity Concurrent");

	it("rapid add/remove does not corrupt", async () => {
		const result = await withApi(async (api) => {
			// Add 100
			const locs: Location[] = [];
			for (let i = 0; i < 100; i++) {
				locs.push(api.createLocation({ lat: i, lng: i, zoom: 1 }));
			}
			await api.addLocations(locs);

			// Remove first 50
			const toRemove = locs.slice(0, 50).map((l) => l.id);
			await api.removeLocations(new Set(toRemove));

			// Add 50 more
			const moreLocs: Location[] = [];
			for (let i = 100; i < 150; i++) {
				moreLocs.push(api.createLocation({ lat: i, lng: i, zoom: 1 }));
			}
			await api.addLocations(moreLocs);

			const count = (await api.cmd.storeGetSummary()).locationCount;
			return { count };
		});
		expect(result.count).toBe(100); // 50 remaining from first batch + 50 new
	});

	it("rapid updates do not lose data", async () => {
		const result = await withApi(async (api) => {
			// Get all locations and pick one to update
			const allLocs = await api.fetchAllLocations();
			const targetId = allLocs[0].id;

			// Update same location 10 times rapidly
			for (let i = 0; i < 10; i++) {
				const loc = await api.fetchLocation(targetId);
				await api.updateLocations([{ id: loc!.id, patch: { heading: i * 36 } }]);
			}

			const loc = await api.fetchLocation(targetId);
			return { heading: loc!.heading };
		});
		expect(result.heading).toBe(324); // last update: 9 * 36
	});

	it("add during save does not lose locations", async () => {
		const result = await withApi(async (api) => {
			// Trigger add
			const triggerLocs = [api.createLocation({ lat: 0, lng: 0, zoom: 1 })];
			await api.addLocations(triggerLocs);
			const triggerId = triggerLocs[0].id;

			// Add more while save may be in progress
			const duringLocs = [api.createLocation({ lat: 1, lng: 1, zoom: 1 })];
			await api.addLocations(duringLocs);
			const duringId = duringLocs[0].id;

			return { triggerId, duringId };
		});

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const trigger = await getLoc(result.triggerId);
		const during = await getLoc(result.duringId);
		expect(trigger).toBeTruthy();
		expect(during).toBeTruthy();
	});
});
