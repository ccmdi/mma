/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	getLocCount,
	createTag,
	addLocs,
	createLocation,
	flushAndWait,
	withApi,
} from "./helpers";

// ============================================================================
// 1. Escaped quotes in extra fields
// ============================================================================

describe("Import — escaped quotes in extra fields", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Escaped Quotes");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("handles escaped quotes in string values", async () => {
		const result = await withApi(async (api) => {
			const json = JSON.stringify({
				customCoordinates: [
					{
						lat: 10,
						lng: 20,
						heading: 0,
						pitch: 0,
						zoom: 1,
						panoId: "pano_esc",
						extra: { description: 'He said "hello" to them' },
					},
				],
			});
			const path = await api.cmd.writeTempFile("escaped_quotes.json", json);
			await api.cmd.storeImportPreview(path);
			await api._test.importFile([]);
			const locs = await api.fetchAllLocations();
			const loc = locs.find((l: any) => l.panoId === "pano_esc");
			return {
				count: locs.length,
				description: loc?.extra?.description,
			};
		});

		expect(result.count).toBe(1);
		expect(result.description).toBe('He said "hello" to them');
	});

	it("handles backslash-escaped quotes in panoId-adjacent strings", async () => {
		const result = await withApi(async (api) => {
			const json = JSON.stringify({
				customCoordinates: [
					{
						lat: 30,
						lng: 40,
						heading: 90,
						pitch: 0,
						zoom: 1,
						panoId: "pano_bs",
						extra: { note: 'path\\with\\backslashes and "quotes"' },
					},
				],
			});
			const path = await api.cmd.writeTempFile("bs_quotes.json", json);
			await api.cmd.storeImportPreview(path);
			await api._test.importFile([]);
			const locs = await api.fetchAllLocations();
			const loc = locs.find((l: any) => l.panoId === "pano_bs");
			return {
				note: loc?.extra?.note,
			};
		});

		expect(result.note).toBe('path\\with\\backslashes and "quotes"');
	});
});

// ============================================================================
// 1b. panoId with special characters (Cow<str> zero-copy path)
// ============================================================================

describe("Import — panoId with special characters", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E PanoId Special");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("preserves panoId containing unicode", async () => {
		const result = await withApi(async (api) => {
			const json = JSON.stringify({
				customCoordinates: [{ lat: 10, lng: 20, panoId: "CAoSLEFGMVFpcE5éabc" }],
			});
			const path = await api.cmd.writeTempFile("pano_unicode.json", json);
			await api.cmd.storeImportPreview(path);
			await api._test.importFile([]);
			const locs = await api.fetchAllLocations();
			return { panoId: locs[0]?.panoId, flags: locs[0]?.flags };
		});

		expect(result.panoId).toBe("CAoSLEFGMVFpcE5éabc");
		expect(result.flags & 1).toBe(1);
	});

	it("top-level panoId wins over extra.panoId", async () => {
		const result = await withApi(async (api) => {
			const json = JSON.stringify({
				customCoordinates: [
					{ lat: 30, lng: 40, panoId: "TOP_PANO", extra: { panoId: "EXTRA_PANO" } },
				],
			});
			const path = await api.cmd.writeTempFile("pano_both.json", json);
			await api.cmd.storeImportPreview(path);
			await api._test.importFile([]);
			const locs = await api.fetchAllLocations();
			const loc = locs.find((l: any) => Math.abs(l.lat - 30) < 0.01);
			return { panoId: loc?.panoId, flags: loc?.flags };
		});

		expect(result.panoId).toBe("TOP_PANO");
		expect(result.flags! & 1).toBe(1);
	});

	it("extra.panoId used as fallback (no LOAD_AS_PANO_ID flag)", async () => {
		const result = await withApi(async (api) => {
			const json = JSON.stringify({
				customCoordinates: [{ lat: 50, lng: 60, extra: { panoId: "FALLBACK_PANO" } }],
			});
			const path = await api.cmd.writeTempFile("pano_fallback.json", json);
			await api.cmd.storeImportPreview(path);
			await api._test.importFile([]);
			const locs = await api.fetchAllLocations();
			const loc = locs.find((l: any) => Math.abs(l.lat - 50) < 0.01);
			return { panoId: loc?.panoId, flags: loc?.flags };
		});

		expect(result.panoId).toBe("FALLBACK_PANO");
		expect(result.flags! & 1).toBe(0);
	});

	it("field aliases work: latitude, longitude, pano", async () => {
		const result = await withApi(async (api) => {
			const json = JSON.stringify({
				customCoordinates: [{ latitude: 70, longitude: 80, pano: "ALIAS_PANO" }],
			});
			const path = await api.cmd.writeTempFile("pano_alias.json", json);
			await api.cmd.storeImportPreview(path);
			await api._test.importFile([]);
			const locs = await api.fetchAllLocations();
			const loc = locs.find((l: any) => Math.abs(l.lat - 70) < 0.01);
			return { lat: loc?.lat, lng: loc?.lng, panoId: loc?.panoId };
		});

		expect(result.lat).toBeCloseTo(70, 3);
		expect(result.lng).toBeCloseTo(80, 3);
		expect(result.panoId).toBe("ALIAS_PANO");
	});
});

// ============================================================================
// 2. Top-level countryCode/stateCode preservation
// ============================================================================

describe("Import — countryCode/stateCode at top level", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E CountryCode");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("captures countryCode from location root", async () => {
		const result = await withApi(async (api) => {
			const json = JSON.stringify({
				customCoordinates: [
					{
						lat: 48.856,
						lng: 2.352,
						heading: 0,
						pitch: 0,
						zoom: 1,
						countryCode: "FR",
						stateCode: "IDF",
					},
				],
			});
			const path = await api.cmd.writeTempFile("cc_root.json", json);
			await api.cmd.storeImportPreview(path);
			await api._test.importFile([]);
			const locs = await api.fetchAllLocations();
			return {
				count: locs.length,
				countryCode: locs[0]?.extra?.countryCode,
				stateCode: locs[0]?.extra?.stateCode,
			};
		});

		expect(result.count).toBe(1);
		expect(result.countryCode).toBe("FR");
		expect(result.stateCode).toBe("IDF");
	});

	it("does not overwrite extra.countryCode with top-level value", async () => {
		const result = await withApi(async (api) => {
			const json = JSON.stringify({
				customCoordinates: [
					{
						lat: 51.5,
						lng: -0.1,
						heading: 0,
						pitch: 0,
						zoom: 1,
						countryCode: "GB",
						extra: { countryCode: "UK" },
					},
				],
			});
			const path = await api.cmd.writeTempFile("cc_both.json", json);
			await api.cmd.storeImportPreview(path);
			await api._test.importFile([]);
			const locs = await api.fetchAllLocations();
			const loc = locs.find((l: any) => Math.abs(l.lat - 51.5) < 0.01);
			return { countryCode: loc?.extra?.countryCode };
		});

		expect(result.countryCode).toBe("UK");
	});
});

// ============================================================================
// 3. Nested objects in extra (boundary scanner depth tracking)
// ============================================================================

describe("Import — nested objects in extra", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Nested Extra");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("preserves deeply nested objects in extra", async () => {
		const result = await withApi(async (api) => {
			const json = JSON.stringify({
				customCoordinates: [
					{
						lat: 35.6,
						lng: 139.7,
						heading: 0,
						pitch: 0,
						zoom: 1,
						extra: {
							meta: {
								source: { name: "test", version: 2 },
								flags: [1, 2, 3],
							},
							label: "Tokyo",
						},
					},
				],
			});
			const path = await api.cmd.writeTempFile("nested_extra.json", json);
			await api.cmd.storeImportPreview(path);
			await api._test.importFile([]);
			const locs = await api.fetchAllLocations();
			return {
				count: locs.length,
				label: locs[0]?.extra?.label,
				sourceName: locs[0]?.extra?.meta?.source?.name,
				sourceVersion: locs[0]?.extra?.meta?.source?.version,
				flags: locs[0]?.extra?.meta?.flags,
			};
		});

		expect(result.count).toBe(1);
		expect(result.label).toBe("Tokyo");
		expect(result.sourceName).toBe("test");
		expect(result.sourceVersion).toBe(2);
		expect(result.flags).toEqual([1, 2, 3]);
	});

	it("handles multiple locations with varied nesting depths", async () => {
		const result = await withApi(async (api) => {
			const json = JSON.stringify({
				customCoordinates: [
					{
						lat: 1,
						lng: 1,
						heading: 0,
						pitch: 0,
						zoom: 1,
						extra: { simple: "flat" },
					},
					{
						lat: 2,
						lng: 2,
						heading: 0,
						pitch: 0,
						zoom: 1,
						extra: { deep: { a: { b: { c: "leaf" } } } },
					},
					{
						lat: 3,
						lng: 3,
						heading: 0,
						pitch: 0,
						zoom: 1,
					},
				],
			});
			const path = await api.cmd.writeTempFile("varied_depth.json", json);
			await api.cmd.storeImportPreview(path);
			await api._test.importFile([]);
			const locs = await api.fetchAllLocations();
			const flat = locs.find((l: any) => Math.abs(l.lat - 1) < 0.01);
			const deep = locs.find((l: any) => Math.abs(l.lat - 2) < 0.01);
			const none = locs.find((l: any) => Math.abs(l.lat - 3) < 0.01);
			return {
				flatVal: flat?.extra?.simple,
				deepVal: deep?.extra?.deep?.a?.b?.c,
				noneExtra: none?.extra,
				allFound: !!flat && !!deep && !!none,
			};
		});

		expect(result.allFound).toBe(true);
		expect(result.flatVal).toBe("flat");
		expect(result.deepVal).toBe("leaf");
		expect(result.noneExtra == null || Object.keys(result.noneExtra).length === 0).toBe(true);
	});
});

// ============================================================================
// 4. Empty customCoordinates array
// ============================================================================

describe("Import — empty customCoordinates", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Empty Coords");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("preview returns zero for empty array", async () => {
		const result = await withApi(async (api) => {
			const json = JSON.stringify({ customCoordinates: [] });
			const path = await api.cmd.writeTempFile("empty_coords.json", json);
			const preview = await api.cmd.storeImportPreview(path);
			return {
				locationCount: preview.locationCount,
				tagCount: preview.tags.length,
			};
		});

		expect(result.locationCount).toBe(0);
		expect(result.tagCount).toBe(0);
	});

	it("importing empty array does not affect existing locations", async () => {
		await addLocs([createLocation({ lat: 55, lng: 66 })]);
		const beforeCount = await getLocCount();

		await withApi(async (api) => {
			const json = JSON.stringify({ customCoordinates: [] });
			const path = await api.cmd.writeTempFile("empty_noop.json", json);
			await api.cmd.storeImportPreview(path);
			await api._test.importFile([]);
		});

		const afterCount = await getLocCount();
		expect(afterCount).toBe(beforeCount);
	});
});

// ============================================================================
// 5. Export+reimport round-trip with tag membership
// ============================================================================

describe("Import — export/reimport tag round-trip", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Tag Roundtrip");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("tags survive export and reimport into a new map", async () => {
		const tagA = await createTag("Alpine");
		const tagB = await createTag("Coastal");

		const locs = [
			createLocation({ lat: 46.5, lng: 7.5, heading: 0, panoId: "alp1", tags: [tagA.id] }),
			createLocation({ lat: 43.3, lng: 5.4, heading: 90, panoId: "coast1", tags: [tagB.id] }),
			createLocation({
				lat: 47.0,
				lng: 8.0,
				heading: 180,
				panoId: "both1",
				tags: [tagA.id, tagB.id],
			}),
		];
		await addLocs(locs);
		await flushAndWait();

		const exported = await withApi(async (api) => {
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
			const res = await fetch(api.mmaBufUrl(path));
			return res.text();
		});

		await closeMap();
		await deleteMap(mapId);

		mapId = await createAndOpenMap("E2E Tag Roundtrip Re");

		const result = await withApi(async (api, jsonStr) => {
			const path = await api.cmd.writeTempFile("tag_rt.json", jsonStr);
			const preview = await api.cmd.storeImportPreview(path);
			await api._test.importFile([]);
			const locs = await api.fetchAllLocations();
			const map = api.getCurrentMap()!;
			const tagNames = Object.values(map.meta.tags)
				.map((t: any) => t.name)
				.sort();
			const alp = locs.find((l: any) => l.panoId === "alp1");
			const coast = locs.find((l: any) => l.panoId === "coast1");
			const both = locs.find((l: any) => l.panoId === "both1");
			return {
				locCount: locs.length,
				previewTagCount: preview.tags.length,
				tagNames,
				alpTagCount: alp?.tags?.length ?? 0,
				coastTagCount: coast?.tags?.length ?? 0,
				bothTagCount: both?.tags?.length ?? 0,
			};
		}, exported);

		expect(result.locCount).toBe(3);
		expect(result.previewTagCount).toBe(2);
		expect(result.tagNames).toEqual(["Alpine", "Coastal"]);
		expect(result.alpTagCount).toBe(1);
		expect(result.coastTagCount).toBe(1);
		expect(result.bothTagCount).toBe(2);
	});
});
