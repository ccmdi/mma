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
	randomLatLng,
	randomHeading,
	withApi,
} from "./helpers";

describe("Location CRUD", () => {
	let mapId: string;
	let singleLocId: number;
	let bulkLocIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Locations");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	// --- Add ---

	it("add single location", async () => {
		const ids = await addLocs([createLocation({ lat: 40.7, lng: -74.0, heading: 90, pitch: 5, zoom: 2 })]);
		singleLocId = ids[0];
		const count = await getLocCount();
		expect(count).toBe(1);
	});

	it("add bulk locations (500)", async () => {
		const locs = [];
		for (let i = 0; i < 500; i++) {
			locs.push(createLocation({ ...randomLatLng(), ...randomHeading() }));
		}
		bulkLocIds = await addLocs(locs);
		const count = await getLocCount();
		expect(count).toBe(501);
	});

	it("added locations have correct fields", async () => {
		const loc = await getLoc(singleLocId);
		expect(loc).not.toBeNull();
		expect(loc.lat).toBe(40.7);
		expect(loc.lng).toBe(-74.0);
		expect(loc.heading).toBe(90);
		expect(loc.pitch).toBe(5);
		expect(loc.zoom).toBe(2);
		expect(loc.flags).toBe(0);
		expect(loc.panoId).toBeNull();
	});

	// --- Update ---

	it("update location lat/lng", async () => {
		await withApi(async (api, id) => {
			api.updateLocation(id, { lat: 51.5, lng: -0.1 });
		}, singleLocId);
		const loc = await getLoc(singleLocId);
		expect(loc.lat).toBe(51.5);
		expect(loc.lng).toBe(-0.1);
	});

	it("update location heading/pitch/zoom", async () => {
		await withApi(async (api, id) => {
			api.updateLocation(id, { heading: 180, pitch: -10, zoom: 3 });
		}, singleLocId);
		const loc = await getLoc(singleLocId);
		expect(loc.heading).toBe(180);
		expect(loc.pitch).toBe(-10);
		expect(loc.zoom).toBe(3);
	});

	it("update location flags", async () => {
		await withApi(async (api, id) => {
			api.updateLocation(id, { flags: 1 });
		}, singleLocId);
		const loc = await getLoc(singleLocId);
		expect(loc.flags).toBe(1);
	});

	it("update location panoId", async () => {
		await withApi(async (api, id) => {
			api.updateLocation(id, { panoId: "CAoSK0FG" });
		}, singleLocId);
		const loc = await getLoc(singleLocId);
		expect(loc.panoId).toBe("CAoSK0FG");
	});

	it("update location tags", async () => {
		await withApi(async (api, id) => {
			api.updateLocation(id, { tags: [100, 200] });
		}, singleLocId);
		const loc = await getLoc(singleLocId);
		expect(loc.tags).toEqual([100, 200]);
	});

	// --- Batch update ---

	it("batch update multiple locations", async () => {
		const result = await withApi(async (api, ids) => {
			await api.batchUpdateLocations([
				{ id: ids[0], patch: { heading: 999 } },
				{ id: ids[1], patch: { heading: 888 } },
				{ id: ids[2], patch: { heading: 777 } },
			]);
			const locs = await Promise.all([
				api.fetchLocation(ids[0]),
				api.fetchLocation(ids[1]),
				api.fetchLocation(ids[2]),
			]);
			return locs.map((l) => l!.heading);
		}, bulkLocIds);
		expect(result).toEqual([999, 888, 777]);
	});

	// --- Extra fields ---

	it("patch location extra", async () => {
		await withApi(async (api, id) => {
			const loc = await api.fetchLocation(id);
			const merged = { ...(loc?.extra || {}), altitude: 150, country: "GB" };
			await api.updateLocationNoUndo(id, { extra: merged });
		}, singleLocId);
		const loc = await getLoc(singleLocId);
		expect(loc.extra.altitude).toBe(150);
		expect(loc.extra.country).toBe("GB");
	});

	it("patch extra merges with existing", async () => {
		await withApi(async (api, id) => {
			const loc = await api.fetchLocation(id);
			const merged = { ...(loc?.extra || {}), city: "London" };
			await api.updateLocationNoUndo(id, { extra: merged });
		}, singleLocId);
		const loc = await getLoc(singleLocId);
		expect(loc.extra.altitude).toBe(150);
		expect(loc.extra.city).toBe("London");
	});

	it("patch extra replace mode", async () => {
		await withApi(async (api, id) => {
			await api.updateLocationNoUndo(id, { extra: { only: "this" } });
		}, singleLocId);
		const loc = await getLoc(singleLocId);
		expect(loc.extra.only).toBe("this");
		expect(loc.extra.altitude).toBeUndefined();
	});

	// --- Duplicate ---

	it("duplicate location", async () => {
		const result = await withApi(async (api, id) => {
			const newId = await api.duplicateLocation(id);
			const original = await api.fetchLocation(id);
			const dup = await api.fetchLocation(newId!);
			const count = await api.cmd.storeLocationCount();
			return { newId, originalLat: original?.lat, dupLat: dup?.lat, count };
		}, singleLocId);
		expect(result.newId).not.toBeNull();
		expect(result.dupLat).toBe(result.originalLat);
		expect(result.count).toBe(502);
	});

	// --- Remove ---

	it("remove single location", async () => {
		await withApi(async (api, id) => {
			api.removeLocations(new Set([id]));
		}, singleLocId);
		const count = await getLocCount();
		expect(count).toBe(501);
	});

	it("remove bulk locations", async () => {
		const idsToRemove = bulkLocIds.slice(0, 100);
		await withApi(async (api, ids) => {
			api.removeLocations(new Set(ids));
		}, idsToRemove);
		const count = await getLocCount();
		expect(count).toBe(401);
	});

	it("remove nonexistent id is a no-op", async () => {
		await withApi(async (api) => {
			api.removeLocations(new Set([999999999]));
		});
		const count = await getLocCount();
		expect(count).toBe(401);
	});
});

describe("Location persistence", () => {
	let mapId: string;
	let persistLocIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Persist Locs");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("locations survive save/load cycle", async () => {
		const locs = [];
		for (let i = 0; i < 100; i++) {
			locs.push(
				createLocation({
					lat: i,
					lng: -i,
					heading: i * 3.6,
					pitch: 0,
					zoom: 1,
					panoId: i % 10 === 0 ? `pano_${i}` : null,
					flags: i % 4 === 0 ? 1 : 0,
				}),
			);
		}
		persistLocIds = await addLocs(locs);

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const result = await withApi(
			async (api, id0, id50) => {
				const count = await api.cmd.storeLocationCount();
				const loc0 = await api.fetchLocation(id0);
				const loc50 = await api.fetchLocation(id50);
				const allLocs = await api.fetchAllLocations();
				return {
					count,
					loc0Lat: loc0?.lat,
					loc0Flags: loc0?.flags,
					loc0Pano: loc0?.panoId,
					loc50Lat: loc50?.lat,
					loc50Heading: loc50?.heading,
					loc50Flags: loc50?.flags,
					panoCount: allLocs.filter((l) => l.panoId != null).length,
					flagCount: allLocs.filter((l) => (l.flags & 1) !== 0).length,
				};
			},
			persistLocIds[0],
			persistLocIds[50],
		);

		expect(result.count).toBe(100);
		expect(result.loc0Lat).toBe(0);
		expect(result.loc0Flags).toBe(1);
		expect(result.loc0Pano).toBe("pano_0");
		expect(result.loc50Lat).toBe(50);
		expect(result.loc50Heading).toBeCloseTo(180);
		expect(result.loc50Flags).toBe(0);
		expect(result.panoCount).toBe(10);
		expect(result.flagCount).toBe(25);
	});

	it("extras survive save/load", async () => {
		await withApi(async (api, id) => {
			api.patchLocationExtra(id, { altitude: 42, country: "US", note: "test" });
		}, persistLocIds[0]);

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const extra = await withApi(async (api, id) => {
			const loc = await api.fetchLocation(id);
			return loc?.extra ?? null;
		}, persistLocIds[0]);
		expect(extra).not.toBeNull();
		expect(extra.altitude).toBe(42);
		expect(extra.country).toBe("US");
		expect(extra.note).toBe("test");
	});

	it("tags on locations survive save/load", async () => {
		const tagIds = await withApi(async (api) => {
			const resolved = await api.createTags(["tag-x", "tag-y"]);
			return resolved.map((t) => t.id);
		});

		await withApi(
			async (api, locId, tIds) => {
				api.updateLocation(locId, { tags: tIds });
			},
			persistLocIds[1],
			tagIds,
		);

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const tags = await withApi(async (api, id) => {
			const loc = await api.fetchLocation(id);
			return loc?.tags ?? null;
		}, persistLocIds[1]);
		expect(tags).toEqual(tagIds);
	});

	it("panoId and flags survive pin/unpin/save cycle", async () => {
		await withApi(async (api, id) => {
			api.updateLocation(id, { panoId: "PINNED_PANO", flags: 1 });
		}, persistLocIds[5]);

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const loc = await getLoc(persistLocIds[5]);
		expect(loc.panoId).toBe("PINNED_PANO");
		expect(loc.flags).toBe(1);
	});
});
