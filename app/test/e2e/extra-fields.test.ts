import {
	closeMap,
	addLocs,
	createLocation,
	getLoc,
	flushAndWait,
	openMap,
	withApi,
	useMap,
} from "./helpers";

describe("Extra field definitions", () => {
	const map = useMap("E2E Extra Fields");

	it("registers field definitions that persist after reopen", async () => {
		await withApi(async (api) => {
			const cur = api.getMapState().map!.extra?.fields ?? {};
			await api.updateMapMeta({
				extra: {
					...api.getMapState().map!.extra,
					fields: {
						...cur,
						altitude: { label: "Altitude", type: "number" },
						country: { label: "Country", type: "string" },
					},
				},
			});
		});

		await flushAndWait();
		await closeMap();
		await openMap(map.id);

		const fields = await withApi(async (api) => api.getMapState().map!.extra?.fields);
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

	it("extra patches merge into existing fields", async () => {
		const ids = await addLocs([
			createLocation({
				lat: 30,
				lng: 40,
				extra: { altitude: 100 },
			}),
		]);

		const loc = await getLoc(ids[0]);
		await withApi(async (api, l) => {
			await api.updateLocations([{ id: l.id, patch: { extra: { country: "France" } } }], {
				undoable: false,
			});
		}, loc);

		const reloaded = await getLoc(ids[0]);
		expect(reloaded.extra.altitude).toBe(100);
		expect(reloaded.extra.country).toBe("France");
	});

	it("null values in the merge patch delete keys", async () => {
		const ids = await addLocs([
			createLocation({
				lat: 50,
				lng: 60,
				extra: { altitude: 200, country: "Italy" },
			}),
		]);

		const loc = await getLoc(ids[0]);
		await withApi(async (api, l) => {
			await api.updateLocations(
				[{ id: l.id, patch: { extra: { newField: "value", altitude: null } } }],
				{ undoable: false },
			);
		}, loc);

		const reloaded = await getLoc(ids[0]);
		expect(reloaded.extra.newField).toBe("value");
		expect(reloaded.extra.country).toBe("Italy");
		expect(reloaded.extra.altitude).toBeUndefined();
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
		await openMap(map.id);

		const loc = await getLoc(ids[0]);
		expect(loc.extra.altitude).toBe(8848);
		expect(loc.extra.country).toBe("Nepal");
		expect(loc.extra.custom).toBe(true);
	});
});

describe("Extra field auto-registration", () => {
	useMap("E2E Extra AutoReg");

	it("adding locations with new extra fields auto-registers definitions", async () => {
		await addLocs([
			createLocation({
				lat: 10,
				lng: 20,
				extra: { temperature: 25.5, humidity: 80 },
			}),
		]);

		// Auto-registered defs land in the live field-def registry (and SQLite), not the
		// in-memory meta.extra.fields, which is only the persisted seed loaded on open.
		const defs = await withApi(async (api) => api.getAllFieldDefs());
		expect("temperature" in defs).toBe(true);
		expect("humidity" in defs).toBe(true);
	});
});
