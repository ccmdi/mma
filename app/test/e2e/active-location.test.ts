import { addLocs, getLoc, createLocation, withApi, useMap } from "./helpers";

describe("Active location and work area", () => {
	useMap("E2E Active Location");
	let locIds: number[];

	before(async () => {
		locIds = await addLocs([
			createLocation({ lat: 10, lng: 10, heading: 90 }),
			createLocation({ lat: 20, lng: 20, heading: 180 }),
			createLocation({ lat: 30, lng: 30, heading: 270 }),
		]);
	});
	it("starts with no active location", async () => {
		const active = await withApi(async (api) => api.getMapState().open?.row ?? null);
		expect(active).toBeNull();
	});

	it("starts in overview work area", async () => {
		const area = await withApi(async (api) => api.getMapState().workArea);
		expect(area).toBe("overview");
	});

	it("setting active location changes work area to 'location'", async () => {
		await withApi(async (api, id) => api.setActiveLocation(id), locIds[0]);
		const area = await withApi(async (api) => api.getMapState().workArea);
		expect(area).toBe("location");
	});

	it("active location returns the correct location data", async () => {
		const active = await withApi(async (api) => {
			const loc = api.getMapState().open?.row ?? null;
			return loc ? { id: loc.id, lat: loc.lat } : null;
		});
		expect(active).not.toBeNull();
		expect(active!.id).toBe(locIds[0]);
		expect(active!.lat).toBe(10);
	});

	it("switching active location updates the data", async () => {
		await withApi(async (api, id) => api.setActiveLocation(id), locIds[1]);
		const active = await withApi(async (api) => {
			const loc = api.getMapState().open?.row ?? null;
			return loc ? { id: loc.id, lat: loc.lat } : null;
		});
		expect(active!.id).toBe(locIds[1]);
		expect(active!.lat).toBe(20);
	});

	it("clearing active location returns to overview", async () => {
		await withApi(async (api) => api.setActiveLocation(null));
		const area = await withApi(async (api) => api.getMapState().workArea);
		expect(area).toBe("overview");

		const active = await withApi(async (api) => api.getMapState().open?.row ?? null);
		expect(active).toBeNull();
	});

	it("deleting the active location clears it", async () => {
		await withApi(async (api, id) => api.setActiveLocation(id), locIds[2]);
		const areaBefore = await withApi(async (api) => api.getMapState().workArea);
		expect(areaBefore).toBe("location");

		await withApi(async (api, id) => {
			await api.removeLocations(new Set([id]));
		}, locIds[2]);

		const active = await withApi(async (api) => api.getMapState().open?.row ?? null);
		expect(active).toBeNull();
	});
});

describe("Active location with undo/redo", () => {
	useMap("E2E Active Undo");
	let locIds: number[];

	before(async () => {
		locIds = await addLocs([
			createLocation({ lat: 10, lng: 10 }),
			createLocation({ lat: 20, lng: 20 }),
		]);
	});
	it("updating active location field is persisted in store", async () => {
		await withApi(async (api, id) => api.setActiveLocation(id), locIds[0]);

		const loc = await getLoc(locIds[0]);
		await withApi(async (api, l) => {
			await api.updateLocations([{ id: l.id, heading: 123 }]);
		}, loc);

		const heading = await withApi(async (api, id) => {
			const loc = await api.fetchLocation(id);
			return loc?.heading;
		}, locIds[0]);
		expect(heading).toBe(123);
	});

	it("undo of active location update reverts the field in store", async () => {
		await withApi(async (api) => api.undo());

		const heading = await withApi(async (api, id) => {
			const loc = await api.fetchLocation(id);
			return loc?.heading;
		}, locIds[0]);
		expect(heading).toBe(0);
	});
});
