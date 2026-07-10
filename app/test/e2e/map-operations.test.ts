import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	flushAndWait,
	openMap,
	addLocs,
	createLocation,
	withApi,
} from "./helpers";

describe("Map rename", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Original Name");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("rename open map updates in-memory name", async () => {
		await withApi(async (api, id) => {
			await api.renameMap(id, "Renamed Map");
		}, mapId);

		const name = await withApi(async (api) => api.getCurrentMap()?.meta.name);
		expect(name).toBe("Renamed Map");
	});

	it("rename persists after save/load", async () => {
		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const name = await withApi(async (api) => api.getCurrentMap()?.meta.name);
		expect(name).toBe("Renamed Map");
	});

	it("rename shows in map list", async () => {
		const maps = await withApi(async (api) => {
			return await api.cmd.storeListMaps();
		});
		const ourMap = maps.find((m) => m.id === mapId);
		expect(ourMap).toBeTruthy();
		expect(ourMap!.name).toBe("Renamed Map");
	});
});

describe("Folder operations", () => {
	const mapIds: string[] = [];

	before(async () => {
		await waitForReady();
	});

	afterEach(async () => {
		await closeMap();
	});

	after(async () => {
		for (const id of mapIds) await deleteMap(id);
	});

	it("move map to folder", async () => {
		const id = await createAndOpenMap("Folder Test 1");
		mapIds.push(id);

		await withApi(async (api, mapId) => {
			await api.moveMapToFolder(mapId, "MyFolder");
		}, id);

		const maps = await withApi(async (api) => {
			return await api.cmd.storeListMaps();
		});
		const ourMap = maps.find((m) => m.id === id);
		expect(ourMap!.folder).toBe("MyFolder");
	});

	it("move map to root (folder=null)", async () => {
		await withApi(async (api, mapId) => {
			await api.moveMapToFolder(mapId, null);
		}, mapIds[0]);

		const maps = await withApi(async (api) => {
			return await api.cmd.storeListMaps();
		});
		const ourMap = maps.find((m) => m.id === mapIds[0]);
		expect(ourMap!.folder).toBeNull();
	});

	it("rename folder updates all maps in it", async () => {
		// Create two maps in a folder
		const id1 = await createAndOpenMap("RF Map 1");
		mapIds.push(id1);
		await closeMap();
		const id2 = await createAndOpenMap("RF Map 2");
		mapIds.push(id2);

		await withApi(
			async (api, a, b) => {
				await api.moveMapToFolder(a, "OldFolder");
				await api.moveMapToFolder(b, "OldFolder");
				await api.renameFolder("OldFolder", "NewFolder");
			},
			id1,
			id2,
		);

		const maps = await withApi(async (api) => {
			return await api.cmd.storeListMaps();
		});
		const m1 = maps.find((m) => m.id === id1);
		const m2 = maps.find((m) => m.id === id2);
		expect(m1!.folder).toBe("NewFolder");
		expect(m2!.folder).toBe("NewFolder");
	});

	it("deleteFolder moves maps to root, does not delete them", async () => {
		await withApi(async (api) => {
			await api.deleteFolder("NewFolder");
		});

		const maps = await withApi(async (api) => {
			return await api.cmd.storeListMaps();
		});

		// Maps still exist but in root
		const m1 = maps.find((m) => m.id === mapIds[1]);
		const m2 = maps.find((m) => m.id === mapIds[2]);
		expect(m1).toBeTruthy();
		expect(m2).toBeTruthy();
		expect(m1!.folder).toBeNull();
		expect(m2!.folder).toBeNull();
	});
});

describe("Map metadata updates", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Meta Update");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("update description", async () => {
		await withApi(async (api) => {
			await api.updateMapMeta({ description: "Test map for E2E" });
		});

		const desc = await withApi(async (api) => api.getCurrentMap()?.meta.description);
		expect(desc).toBe("Test map for E2E");
	});

	it("update settings", async () => {
		await withApi(async (api) => {
			const cur = api.getCurrentMap()!.meta.settings;
			await api.updateMapMeta({ settings: { ...cur, enrichMetadata: true } });
		});

		const settings = await withApi(async (api) => api.getCurrentMap()!.meta.settings);
		expect(settings.enrichMetadata).toBe(true);
	});

	it("update scoreBounds", async () => {
		await withApi(async (api) => {
			await api.updateMapMeta({
				scoreBounds: [100, 200, 300, 400],
			});
		});

		const bounds = await withApi(async (api) => api.getCurrentMap()?.meta.scoreBounds);
		expect(bounds).toEqual([100, 200, 300, 400]);
	});

	it("meta updates persist after save/load", async () => {
		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const meta = await withApi(async (api) => api.getCurrentMap()!.meta);
		expect(meta.description).toBe("Test map for E2E");
		expect(meta.settings.enrichMetadata).toBe(true);
		expect(meta.scoreBounds).toEqual([100, 200, 300, 400]);
	});
});

describe("Active location and work area", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Active Loc");
		const locs = [
			createLocation({ lat: 10, lng: 20, heading: 90, pitch: 5, zoom: 2, panoId: "P1", flags: 1 }),
			createLocation({ lat: 30, lng: 40, heading: 180, pitch: 0, zoom: 1 }),
		];
		locIds = await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("setActiveLocation switches to location work area", async () => {
		const id = locIds[0];
		await withApi(async (api, locId) => {
			await api.setActiveLocation(locId);
		}, id);

		const result = await withApi(async (api) => {
			return {
				workArea: api.getWorkArea(),
				activeId: api.getActiveLocation()?.id,
				activeLat: api.getActiveLocation()?.lat,
			};
		});
		expect(result.workArea).toBe("location");
		expect(result.activeId).toBe(id);
		expect(result.activeLat).toBe(10);
	});

	it("setActiveLocation(null) returns to overview", async () => {
		await withApi(async (api) => {
			await api.setActiveLocation(null);
		});

		const result = await withApi(async (api) => ({
			workArea: api.getWorkArea(),
			active: api.getActiveLocation(),
		}));
		expect(result.workArea).toBe("overview");
		expect(result.active).toBeNull();
	});

	it("switching active location changes work area target", async () => {
		const id0 = locIds[0];
		const id1 = locIds[1];
		await withApi(
			async (api, a, b) => {
				await api.setActiveLocation(a);
				await api.setActiveLocation(b);
			},
			id0,
			id1,
		);

		const result = await withApi(async (api) => ({
			activeId: api.getActiveLocation()?.id,
			activeLat: api.getActiveLocation()?.lat,
		}));
		expect(result.activeId).toBe(id1);
		expect(result.activeLat).toBe(30);
	});
});

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

	it("set extra field definitions on map", async () => {
		await withApi(async (api) => {
			const cur = api.getCurrentMap()!.meta.extra?.fields ?? {};
			await api.updateMapMeta({
				extra: {
					...api.getCurrentMap()!.meta.extra,
					fields: {
						...cur,
						altitude: { type: "number", label: "Altitude (m)" },
						country: { type: "string", label: "Country" },
						region: { type: "enum", label: "Region", values: ["NA", "EU", "AS"] },
					},
				},
			});
		});

		const extra = await withApi(async (api) => api.getCurrentMap()?.meta.extra);
		expect(extra!.fields!.altitude.type).toBe("number");
		expect(extra!.fields!.country.type).toBe("string");
		expect(extra!.fields!.region.values).toEqual(["NA", "EU", "AS"]);
	});

	it("extra field definitions persist", async () => {
		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const extra = await withApi(async (api) => api.getCurrentMap()?.meta.extra);
		expect(extra!.fields!.altitude.type).toBe("number");
		expect(extra!.fields!.altitude.label).toBe("Altitude (m)");
	});

	it("auto-registers field defs when adding locations with extras", async () => {
		await withApi(async (api) => {
			await api.addLocations([
				api.createLocation({
					lat: 0,
					lng: 0,
					extra: { plumbus: 1, captured: "2024-03", note: "hello" },
				}),
			]);
		});

		const defs = await withApi(async (api) => ({
			plumbus: api.getFieldDef("plumbus"),
			captured: api.getFieldDef("captured"),
			note: api.getFieldDef("note"),
		}));
		expect(defs.plumbus?.type).toBe("number");
		expect(defs.captured?.type).toBe("month");
		expect(defs.note?.type).toBe("string");
	});

	it("known enrichment keys are auto-registered and resolve their known labels", async () => {
		await withApi(async (api) => {
			await api.addLocations([
				api.createLocation({ lat: 0, lng: 0, extra: { countryCode: "US", imageDate: "2023-05" } }),
			]);
		});

		const known = await withApi(async (api) => ({
			countryCode: api.getKnownFieldKeys().has("countryCode"),
			imageDate: api.getKnownFieldKeys().has("imageDate"),
		}));
		expect(known.countryCode).toBe(true);
		expect(known.imageDate).toBe(true);

		const defs = await withApi(async (api) => ({
			countryCode: api.getFieldDef("countryCode"),
			imageDate: api.getFieldDef("imageDate"),
		}));
		expect(defs.countryCode?.label).toBe("Country code");
		expect(defs.imageDate?.type).toBe("month");
		expect(defs.imageDate?.label).toBe("Image date");
	});

	it("auto-registered field defs persist across map close/reopen", async () => {
		await withApi(async (api) => {
			await api.addLocations([api.createLocation({ lat: 0, lng: 0, extra: { fleeb: 99 } })]);
		});

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const extra = await withApi(async (api) => api.getCurrentMap()?.meta.extra);
		expect(extra!.fields!.fleeb).toBeDefined();
		expect(extra!.fields!.fleeb.type).toBe("number");
	});

	it("auto-registered def is identical live and after reopen (single source of truth)", async () => {
		await withApi(async (api) => {
			await api.addLocations([
				api.createLocation({ lat: 0, lng: 0, extra: { roundtrip: "2024-07" } }),
			]);
		});

		// Live: the inferred def is in the registry immediately (YYYY-MM -> month).
		const live = await withApi(async (api) => api.getFieldDef("roundtrip"));
		expect(live?.type).toBe("month");

		// Persisted: reopen and re-resolve -- memory (live merge) and disk must agree.
		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const reloaded = await withApi(async (api) => api.getFieldDef("roundtrip"));
		expect(reloaded?.type).toBe(live?.type);
		expect(reloaded?.label ?? null).toBe(live?.label ?? null);
	});

	it("does not re-register already known keys", async () => {
		// Explicitly register with a custom label
		await withApi(async (api) => {
			const cur = api.getCurrentMap()!.meta.extra?.fields ?? {};
			await api.updateMapMeta({
				extra: {
					...api.getCurrentMap()!.meta.extra,
					fields: { ...cur, score: { type: "number", label: "My Score" } },
				},
			});
		});

		// Add a location with the same key — should not overwrite the custom def
		await withApi(async (api) => {
			await api.addLocations([api.createLocation({ lat: 0, lng: 0, extra: { score: 42 } })]);
		});

		const extra = await withApi(async (api) => api.getCurrentMap()?.meta.extra);
		expect(extra!.fields!.score.label).toBe("My Score");
	});
});
