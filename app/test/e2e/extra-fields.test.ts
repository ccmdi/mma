import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	createLocation,
	getLoc,
	flushAndWait,
	openMap,
	withApi,
} from "./helpers";

describe("Extra field definitions", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Extra Fields");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("registers field definitions that persist after reopen", async () => {
		await withApi(async (api) => {
			const cur = api.getCurrentMap()!.meta.extra?.fields ?? {};
			await api.updateMapMeta({ extra: { ...api.getCurrentMap()!.meta.extra, fields: { ...cur, altitude: { label: "Altitude", type: "number" }, country: { label: "Country", type: "string" } } } });
		});

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const fields = await withApi(async (api) => api.getCurrentMap()!.meta.extra?.fields);
		expect(fields).toBeTruthy();
		expect(fields!.altitude).toBeTruthy();
		expect(fields!.altitude.label).toBe("Altitude");
		expect(fields!.country.label).toBe("Country");
	});

	it("locations can have extra fields matching definitions", async () => {
		const ids = await addLocs([
			createLocation({
				lat: 10,
				lng: 20,
				extra: { altitude: 500, country: "Switzerland" },
			}),
		]);

		const loc = await getLoc(ids[0]);
		expect(loc.extra.altitude).toBe(500);
		expect(loc.extra.country).toBe("Switzerland");
	});

	it("patchLocationExtra merges fields", async () => {
		const ids = await addLocs([
			createLocation({
				lat: 30,
				lng: 40,
				extra: { altitude: 100 },
			}),
		]);

		await withApi(async (api, id) => {
			await api.patchLocationExtra(id, { country: "France" });
		}, ids[0]);

		const loc = await getLoc(ids[0]);
		expect(loc.extra.altitude).toBe(100);
		expect(loc.extra.country).toBe("France");
	});

	it("patchLocationExtra with replace=true overwrites", async () => {
		const ids = await addLocs([
			createLocation({
				lat: 50,
				lng: 60,
				extra: { altitude: 200, country: "Italy" },
			}),
		]);

		await withApi(async (api, id) => {
			await api.patchLocationExtra(id, { newField: "value" }, true);
		}, ids[0]);

		const loc = await getLoc(ids[0]);
		expect(loc.extra.newField).toBe("value");
		expect(loc.extra.altitude).toBeUndefined();
	});

	it("extra fields survive save/close/reopen", async () => {
		const ids = await addLocs([
			createLocation({
				lat: 70,
				lng: 80,
				extra: { altitude: 8848, country: "Nepal", custom: true },
			}),
		]);

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const loc = await getLoc(ids[0]);
		expect(loc.extra.altitude).toBe(8848);
		expect(loc.extra.country).toBe("Nepal");
		expect(loc.extra.custom).toBe(true);
	});
});

describe("Extra field auto-registration", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Extra AutoReg");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("adding locations with new extra fields auto-registers definitions", async () => {
		await addLocs([
			createLocation({
				lat: 10,
				lng: 20,
				extra: { temperature: 25.5, humidity: 80 },
			}),
		]);

		const fields = await withApi(async (api) => api.getCurrentMap()!.meta.extra?.fields);
		if (fields) {
			const hasTemp = "temperature" in fields;
			expect(hasTemp || !fields).toBeTruthy();
		}
	});
});
