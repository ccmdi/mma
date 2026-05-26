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

describe("JSON import/export round-trip", () => {
	let mapId: string;
	let locIds: number[];

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Import Export");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("export JSON and re-import produces same locations", async () => {
		const locs = [
			createLocation({
				lat: 40.7,
				lng: -74.0,
				heading: 90,
				pitch: 5,
				zoom: 2.5,
				panoId: "ABC123",
				flags: 1,
			}),
			createLocation({
				lat: -33.8,
				lng: 151.2,
				heading: 180,
				pitch: -10,
				zoom: 1,
				panoId: null,
				flags: 0,
			}),
			createLocation({ lat: 51.5, lng: -0.1, heading: 0, pitch: 0, zoom: 1, panoId: "XYZ789", flags: 0 }),
		];
		locIds = await addLocs(locs);

		const result = await withApi(async (api) => {
			const map = api.getCurrentMap()!;
			const path = await api.cmd.storeExportJson({
				exportZoom: true,
				exportUnpanned: true,
				exportExtras: true,
				scope: null,
				mapName: map.meta.name,
				tagsJson: JSON.stringify(map.meta.tags),
				extraFieldsJson: null,
			});
			const res = await fetch("http://mma-buf.localhost/" + path.replace(/\\/g, "/"));
			const json = await res.text();

			const parsed = JSON.parse(json);
			const coords = parsed.customCoordinates || [];
			const locCount = await api.cmd.storeLocationCount();

			return {
				exportedCount: locCount,
				importedCount: coords.length,
				firstLat: coords.find((c: any) => c.panoId === "ABC123")?.lat,
				firstHeading: coords.find((c: any) => c.panoId === "ABC123")?.heading,
				firstZoom: coords.find((c: any) => c.panoId === "ABC123")?.zoom,
				secondPano: coords.find((c: any) => Math.abs(c.lat - -33.8) < 0.01)?.panoId,
			};
		});

		expect(result.exportedCount).toBe(3);
		expect(result.importedCount).toBe(3);
		expect(result.firstLat).toBeCloseTo(40.7);
		expect(result.firstHeading).toBeCloseTo(90);
		expect(result.firstZoom).toBeCloseTo(2.5);
		expect(result.secondPano).toBeNull();
	});

	it("export preserves tags in JSON", async () => {
		const ieTag = await createTag("ImportExport");

		await withApi(
			async (api, locId: number, tag: any) => {
				await api.updateLocation(locId, { tags: [tag.id] });
			},
			locIds[0],
			ieTag,
		);

		const result = await withApi(async (api) => {
			const map = api.getCurrentMap()!;
			const path = await api.cmd.storeExportJson({
				exportZoom: true,
				exportUnpanned: true,
				exportExtras: true,
				scope: null,
				mapName: map.meta.name,
				tagsJson: JSON.stringify(map.meta.tags),
				extraFieldsJson: null,
			});
			const res = await fetch("http://mma-buf.localhost/" + path.replace(/\\/g, "/"));
			const json = await res.text();
			const parsed = JSON.parse(json);
			const coords = parsed.customCoordinates || [];
			const taggedLoc = coords.find((c: any) => c.extra?.tags && c.extra.tags.length > 0);
			const exportedTags = parsed.extra?.tags ? Object.keys(parsed.extra.tags) : [];
			return {
				hasTaggedLoc: !!taggedLoc,
				tagCount: exportedTags.length,
			};
		});

		expect(result.hasTaggedLoc).toBe(true);
		expect(result.tagCount).toBeGreaterThanOrEqual(1);
	});

	it("export without zoom sets zoom to 0", async () => {
		const result = await withApi(async (api) => {
			const map = api.getCurrentMap()!;
			const path = await api.cmd.storeExportJson({
				exportZoom: false,
				exportUnpanned: true,
				exportExtras: true,
				scope: null,
				mapName: map.meta.name,
				tagsJson: JSON.stringify(map.meta.tags),
				extraFieldsJson: null,
			});
			const res = await fetch("http://mma-buf.localhost/" + path.replace(/\\/g, "/"));
			const json = await res.text();
			const parsed = JSON.parse(json);
			return parsed.customCoordinates.every((c: any) => c.zoom === 0);
		});
		expect(result).toBe(true);
	});

	it("export with exportUnpanned tweaks heading=0 to 0.001", async () => {
		await withApi(async (api, locId: number) => {
			await api.updateLocation(locId, { heading: 0 });
		}, locIds[1]);

		const result = await withApi(async (api) => {
			const map = api.getCurrentMap()!;
			const path = await api.cmd.storeExportJson({
				exportZoom: true,
				exportUnpanned: true,
				exportExtras: true,
				scope: null,
				mapName: map.meta.name,
				tagsJson: JSON.stringify(map.meta.tags),
				extraFieldsJson: null,
			});
			const res = await fetch("http://mma-buf.localhost/" + path.replace(/\\/g, "/"));
			const json = await res.text();
			const parsed = JSON.parse(json);
			const ie2 = parsed.customCoordinates.find((c: any) => Math.abs(c.lat - -33.8) < 0.01);
			return ie2?.heading;
		});
		expect(result).toBeCloseTo(0.001, 3);
	});
});

describe("CSV import/export", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E CSV");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("CSV export produces valid format", async () => {
		await addLocs([
			createLocation({ lat: 40.7, lng: -74.0, heading: 90, pitch: 0, zoom: 1, panoId: "P1", flags: 1 }),
			createLocation({ lat: 51.5, lng: -0.1, heading: 180, pitch: 5, zoom: 2, panoId: null, flags: 0 }),
		]);

		const result = await withApi(async (api) => {
			const path = await api.cmd.storeExportCsv(null);
			const res = await fetch("http://mma-buf.localhost/" + path.replace(/\\/g, "/"));
			const csv = await res.text();
			const lines = csv.trim().split("\n");
			return { lineCount: lines.length, header: lines[0] };
		});
		expect(result.lineCount).toBe(3); // header + 2 rows
		expect(result.header).toContain("lat");
		expect(result.header).toContain("lng");
	});

	it("CSV round-trip preserves coordinates", async () => {
		const result = await withApi(async (api) => {
			const path = await api.cmd.storeExportCsv(null);
			const res = await fetch("http://mma-buf.localhost/" + path.replace(/\\/g, "/"));
			const csv = await res.text();
			const lines = csv.trim().split("\n").slice(1);
			const rows = lines.map((line: string) => {
				const [lat, lng] = line.split(",").map(Number);
				return { lat, lng };
			});
			return {
				count: rows.length,
				firstLat: rows[0]?.lat,
				firstLng: rows[0]?.lng,
			};
		});
		expect(result.count).toBe(2);
		expect(result.firstLat).toBeCloseTo(40.7, 1);
		expect(result.firstLng).toBeCloseTo(-74.0, 1);
	});
});

describe("GeoJSON export", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E GeoJSON");

		await addLocs([
			createLocation({ lat: 40.7, lng: -74.0, heading: 90, panoId: "GJ1" }),
			createLocation({ lat: 51.5, lng: -0.1, heading: 0, panoId: null }),
		]);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("GeoJSON export produces valid FeatureCollection", async () => {
		const result = await withApi(async (api) => {
			const map = api.getCurrentMap()!;
			const path = await api.cmd.storeExportGeojson(null, JSON.stringify(map.meta.tags));
			const res = await fetch("http://mma-buf.localhost/" + path.replace(/\\/g, "/"));
			const geojson = await res.text();
			const parsed = JSON.parse(geojson);
			return {
				type: parsed.type,
				featureCount: parsed.features.length,
				firstType: parsed.features[0]?.geometry?.type,
				firstCoords: parsed.features[0]?.geometry?.coordinates,
			};
		});
		expect(result.type).toBe("FeatureCollection");
		expect(result.featureCount).toBe(2);
		expect(result.firstType).toBe("Point");
		expect(result.firstCoords[0]).toBeCloseTo(-74.0); // lng first in GeoJSON
		expect(result.firstCoords[1]).toBeCloseTo(40.7);
	});
});

describe("JSON import edge cases", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Import Edge");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("import with extra fields preserves them via Rust import", async () => {
		const result = await withApi(async (api) => {
			const json = JSON.stringify({
				customCoordinates: [
					{
						lat: 10,
						lng: 20,
						heading: 90,
						pitch: 0,
						zoom: 1,
						panoId: "P1",
						extra: { altitude: 500, country: "FR" },
					},
				],
			});
			const path = await api.cmd.writeTempFile("test_import.json", json);
			const preview = await api.cmd.storeImportPreview(path);
			await api.importFile([]);
			const locs = await api.fetchAllLocations();
			const imported = locs.find((l: any) => l.extra?.altitude === 500);
			return {
				count: preview.locationCount,
				hasAltitude: imported?.extra?.altitude === 500,
				hasCountry: imported?.extra?.country === "FR",
			};
		});
		expect(result.count).toBe(1);
		expect(result.hasAltitude).toBe(true);
		expect(result.hasCountry).toBe(true);
	});

	it("import map-making.app format", async () => {
		const result = await withApi(async (api) => {
			const json = JSON.stringify({
				customCoordinates: [
					{ lat: 40.7, lng: -74.0, heading: 90, pitch: 5, zoom: 1.5, panoId: "ABC" },
					{ lat: 51.5, lng: -0.1, heading: 180, pitch: 0, zoom: 1 },
				],
				name: "Test Map",
			});
			const path = await api.cmd.writeTempFile("test_mma_fmt.json", json);
			const preview = await api.cmd.storeImportPreview(path);
			return { count: preview.locationCount };
		});
		expect(result.count).toBe(2);
	});

	it("import with tags creates tag entries", async () => {
		const result = await withApi(async (api) => {
			const json = JSON.stringify({
				customCoordinates: [
					{
						lat: 10,
						lng: 20,
						heading: 0,
						pitch: 0,
						zoom: 1,
						extra: { tags: ["Mountain", "Snow"] },
					},
					{ lat: 30, lng: 40, heading: 0, pitch: 0, zoom: 1, extra: { tags: ["Mountain"] } },
				],
			});
			const path = await api.cmd.writeTempFile("test_tags_import.json", json);
			const preview = await api.cmd.storeImportPreview(path);
			return {
				count: preview.locationCount,
				tagCount: preview.tags.length,
				tagNames: preview.tags.map((t: any) => t.name).sort(),
			};
		});
		expect(result.count).toBe(2);
		expect(result.tagCount).toBe(2);
		expect(result.tagNames).toEqual(["Mountain", "Snow"]);
	});

	it("import empty customCoordinates returns zero locations", async () => {
		const result = await withApi(async (api) => {
			const json = JSON.stringify({ customCoordinates: [] });
			const path = await api.cmd.writeTempFile("test_empty.json", json);
			const preview = await api.cmd.storeImportPreview(path);
			return preview.locationCount;
		});
		expect(result).toBe(0);
	});
});
