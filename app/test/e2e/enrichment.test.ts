/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	addLocs,
	closeLocation,
	createLocation,
	getLocOrNull,
	openLocation,
	refreshSelections,
	updateMapSettings,
	useMap,
	waitForPreview,
	withApi,
} from "./helpers";
import type { Location } from "@/bindings.gen";
import { LocationFlag } from "@/bindings.consts";

const OFFICIAL_PANO = "-zrYsLR4Fh-cfJG_EMZ1-A";
const OFFICIAL_COORDS = { lat: 52.10947502806108, lng: 34.90131410856584 };

const PANO_TIMEOUT = 10_000;

function loc(overrides: Partial<Location> = {}): Location {
	return createLocation({
		lat: 0,
		lng: 0,
		modifiedAt: Math.floor(Date.now() / 1000),
		...overrides,
	});
}

const readLocation = getLocOrNull as (id: number) => Promise<any>;

async function getMapMeta(): Promise<any> {
	return withApi(async (api) => {
		return api.getMapState().map ?? null;
	});
}

async function waitForEnrichment(locId: number, field = "countryCode") {
	await browser.waitUntil(
		async () => {
			const l = await readLocation(locId);
			return l?.extra?.[field] != null;
		},
		{
			timeout: PANO_TIMEOUT,
			timeoutMsg: `Enrichment field '${field}' never populated on ${locId}`,
		},
	);
}

// knownFieldKeys propagate asynchronously after an extra write lands; poll instead of
// asserting once, or the read races the registration under slow (SwiftShader) runs.
async function waitForFieldKeys(timeoutMs: number, ...wanted: string[]) {
	await browser.waitUntil(
		async () => {
			const keys = await withApi((api) => [...api.getKnownFieldKeys()]);
			return wanted.every((k) => keys.includes(k));
		},
		{
			timeout: timeoutMs,
			interval: 50,
			timeoutMsg: `field defs never registered: ${wanted.join(", ")}`,
		},
	);
}

// ============================================================================
// Single-location enrichment (LocationPreview path)
// ============================================================================

describe("Enrichment — single location via preview", () => {
	useMap("E2E Enrich Single", { closeLocation: true });
	let enrichBasicId: number;
	let enrichCustomExtraId: number;
	let enrichExistingMetaId: number;
	let enrichNoPanoId: number;

	before(async () => {
		await updateMapSettings({ enrichMetadata: true, enrichFields: undefined });
		const locs = [
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
				extra: { myCustomField: "keep-me", anotherField: 42 },
			}),
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
				extra: { countryCode: "XX", altitude: 999, datetime: 1600000000, timezone: "Europe/Fake" },
			}),
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
			}),
		];
		const ids = await addLocs(locs);
		enrichBasicId = ids[0];
		enrichCustomExtraId = ids[1];
		enrichExistingMetaId = ids[2];
		enrichNoPanoId = ids[3];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("populates all standard enrichment fields", async () => {
		await openLocation(enrichBasicId);
		await waitForPreview();
		await waitForEnrichment(enrichBasicId);

		const l = await readLocation(enrichBasicId);
		expect(l.extra.countryCode).toBeTruthy();
		expect(typeof l.extra.altitude).toBe("number");
		expect(l.extra.cameraType).toBeTruthy();
		expect(l.extra.panoType).toBeTruthy();
		expect(l.extra.imageDate).toBeTruthy();
	});

	it("preserves custom extra fields during enrichment", async () => {
		await openLocation(enrichCustomExtraId);
		await waitForPreview();
		await waitForEnrichment(enrichCustomExtraId);

		const l = await readLocation(enrichCustomExtraId);
		expect(l.extra.countryCode).toBeTruthy();
		expect(l.extra.myCustomField).toBe("keep-me");
		expect(l.extra.anotherField).toBe(42);
	});

	it("overwrites stale enrichment fields with fresh data", async () => {
		await openLocation(enrichExistingMetaId);
		await waitForPreview();
		// Wait for enrichment to overwrite the fake "XX"
		await browser.waitUntil(
			async () => {
				const l = await readLocation(enrichExistingMetaId);
				return l?.extra?.countryCode != null && l.extra.countryCode !== "XX";
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "countryCode was never overwritten from XX" },
		);

		const l = await readLocation(enrichExistingMetaId);
		expect(l.extra.countryCode).not.toBe("XX");
		expect(l.extra.altitude).not.toBe(999);
	});

	it("clears datetime/timezone when imageDate changes", async () => {
		// Default enrich set excludes datetime/timezone, so no live resolution interferes
		await updateMapSettings({ enrichFields: undefined });
		// Pre-seed with stale datetime
		const dtLoc = await readLocation(enrichExistingMetaId);
		await withApi(async (api, l) => {
			await api.updateLocations(
				[
					{
						id: l.id,
						patch: {
							extra: { imageDate: "2099-01", datetime: 9999999999, timezone: "Fake/Zone" },
						},
					},
				],
				{ undoable: false },
			);
			return "ok";
		}, dtLoc);

		const before = await readLocation(enrichExistingMetaId);
		expect(before.extra.datetime).toBe(9999999999);

		await openLocation(enrichExistingMetaId);
		await waitForPreview();
		await browser.waitUntil(
			async () => {
				const l = await readLocation(enrichExistingMetaId);
				return l?.extra?.imageDate != null && l.extra.imageDate !== "2099-01";
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "imageDate was never overwritten from 2099-01" },
		);

		const after = await readLocation(enrichExistingMetaId);
		expect(after.extra.imageDate).not.toBe("2099-01");
		expect(after.extra.datetime).toBeUndefined();
		expect(after.extra.timezone).toBeUndefined();
	});

	it("location without panoId resolves pano from coords and enriches", async () => {
		await openLocation(enrichNoPanoId);
		await waitForPreview();
		await waitForEnrichment(enrichNoPanoId);

		const l = await readLocation(enrichNoPanoId);
		expect(l.extra?.countryCode).toBeTruthy();
	});
});

// ============================================================================
// Enrichment field settings (per-field toggles)
// ============================================================================

describe("Enrichment — respects enrichFields setting", () => {
	useMap("E2E Enrich Fields", { closeLocation: true });
	let fieldsSelectiveId: number;

	before(async () => {
		const locs = [
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
		];
		const ids = await addLocs(locs);
		fieldsSelectiveId = ids[0];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("only enriches enabled fields", async () => {
		// Only enable countryCode and imageDate
		await updateMapSettings({ enrichMetadata: true, enrichFields: ["countryCode", "imageDate"] });

		await openLocation(fieldsSelectiveId);
		await waitForPreview();
		await waitForEnrichment(fieldsSelectiveId, "countryCode");
		// eslint-disable-next-line no-restricted-syntax -- negative assertion: give disabled fields a bounded window to (not) appear
		await browser.pause(2000);

		const l = await readLocation(fieldsSelectiveId);
		expect(l.extra.countryCode).toBeTruthy();
		expect(l.extra.imageDate).toBeTruthy();
		// These should NOT be set
		expect(l.extra.altitude).toBeFalsy();
		expect(l.extra.cameraType).toBeFalsy();
		expect(l.extra.panoType).toBeFalsy();
	});

	it("enrichMetadata=false disables all enrichment", async () => {
		await updateMapSettings({ enrichMetadata: false });

		// Clear existing extra
		const clearLoc = await readLocation(fieldsSelectiveId);
		await withApi(async (api, l) => {
			await api.updateLocations([{ id: l.id, patch: { extra: null } }], { undoable: false });
			return "ok";
		}, clearLoc);

		await openLocation(fieldsSelectiveId);
		await waitForPreview();
		// eslint-disable-next-line no-restricted-syntax -- negative assertion: confirm enrichment never populates with metadata disabled
		await browser.pause(5000);

		const l = await readLocation(fieldsSelectiveId);
		expect(l.extra?.countryCode).toBeFalsy();
		expect(l.extra?.altitude).toBeFalsy();
	});
});

// ============================================================================
// Field def auto-registration
// ============================================================================

describe("Enrichment — auto-registers field defs on map meta", () => {
	useMap("E2E Enrich FieldDefs", { closeLocation: true });
	let defsAutoId: number;

	before(async () => {
		await updateMapSettings({ enrichMetadata: true, enrichFields: undefined });
		const locs = [
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
		];
		const ids = await addLocs(locs);
		defsAutoId = ids[0];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("field defs appear after enrichment", async () => {
		await openLocation(defsAutoId);
		await waitForPreview();
		await waitForEnrichment(defsAutoId);
		// Poll getFieldDef rather than knownFieldKeys: concurrent enrichment mutations
		// can land out of order and transiently regress the keys set.
		const defsOk = async () => {
			const defs = await withApi((api) => ({
				countryCode: api.getFieldDef("countryCode"),
				altitude: api.getFieldDef("altitude"),
				imageDate: api.getFieldDef("imageDate"),
			}));
			return (
				defs.countryCode?.type === "string" &&
				defs.altitude?.type === "number" &&
				defs.imageDate?.type === "month"
			);
		};
		await browser.waitUntil(defsOk, {
			timeout: PANO_TIMEOUT,
			interval: 50,
			timeoutMsg: "enrichment field defs never registered",
		});
	});

	it("does not clobber user-customized field defs", async () => {
		// Manually set countryCode to a custom type
		await withApi(async (api) => {
			const cur = api.getMapState().map!.extra?.fields ?? {};
			await api.updateMapMeta({
				extra: {
					...api.getMapState().map!.extra,
					fields: {
						...cur,
						countryCode: { type: "enum", label: "My Custom Country", values: ["US", "RU"] },
					},
				},
			});
			return "ok";
		});

		// Clear extra and re-enrich
		const defLoc = await readLocation(defsAutoId);
		await withApi(async (api, l) => {
			await api.updateLocations([{ id: l.id, patch: { extra: null } }], { undoable: false });
			return "ok";
		}, defLoc);

		await openLocation(defsAutoId);
		await waitForPreview();
		await waitForEnrichment(defsAutoId);

		const meta = await getMapMeta();
		const fields = meta?.extra?.fields ?? {};
		// Should still be the user's custom type, not overwritten to "string"
		expect(fields.countryCode.type).toBe("enum");
		expect(fields.countryCode.label).toBe("My Custom Country");
	});

	it("extra patches auto-register known field keys", async () => {
		const patchLoc = await readLocation(defsAutoId);
		await withApi(async (api, l) => {
			await api.updateLocations([{ id: l.id, patch: { extra: { datetime: 1700000000 } } }], {
				undoable: false,
			});
			return "ok";
		}, patchLoc);

		await waitForFieldKeys(PANO_TIMEOUT, "datetime");
		const def = await withApi((api) => api.getFieldDef("datetime"));
		expect(def?.type).toBe("date");
	});

	it("addLocations auto-registers known field keys", async () => {
		// countryCode carries the custom enum def from the clobber test above, so probe a
		// known string field nothing in this map has touched.
		await addLocs([loc({ lat: 10, lng: 20, extra: { altitude: 100, uploaderName: "Google" } })]);

		await waitForFieldKeys(PANO_TIMEOUT, "altitude", "uploaderName");
		const defs = await withApi((api) => ({
			altitude: api.getFieldDef("altitude"),
			uploaderName: api.getFieldDef("uploaderName"),
		}));
		expect(defs.altitude?.type).toBe("number");
		expect(defs.uploaderName?.type).toBe("string");
	});

	it("unknown extra fields get auto-registered as known keys", async () => {
		const customLoc = await readLocation(defsAutoId);
		await withApi(async (api, l) => {
			await api.updateLocations([{ id: l.id, patch: { extra: { randomCustomThing: "hello" } } }], {
				undoable: false,
			});
			return "ok";
		}, customLoc);

		await waitForFieldKeys(PANO_TIMEOUT, "randomCustomThing");
	});
});

// ============================================================================
// Exact date enrichment via preview
// ============================================================================

describe("Enrichment — exact date via preview", () => {
	useMap("E2E Enrich ExactDate", { closeLocation: true });
	let exactEnrichId: number;

	before(async () => {
		await updateMapSettings({ enrichMetadata: true, enrichFields: undefined });
		const locs = [
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
		];
		const ids = await addLocs(locs);
		exactEnrichId = ids[0];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("datetime and timezone are written after exact date resolves", async () => {
		await updateMapSettings({
			enrichFields: [
				"altitude",
				"countryCode",
				"cameraType",
				"panoType",
				"imageDate",
				"datetime",
				"timezone",
			],
		});
		await withApi(async (api) => {
			api.setSetting("dateTimezone", "location");
		});
		await openLocation(exactEnrichId);
		await waitForPreview();

		await browser.waitUntil(
			async () => {
				const l = await readLocation(exactEnrichId);
				return l?.extra?.datetime != null;
			},
			{
				timeout: 60_000,
				timeoutMsg: "datetime never populated (exact date resolution can be slow)",
			},
		);

		const l = await readLocation(exactEnrichId);
		expect(typeof l.extra.datetime).toBe("number");
		expect(l.extra.datetime).toBeGreaterThan(0);
		expect(typeof l.extra.timezone).toBe("string");
		expect(l.extra.timezone.length).toBeGreaterThan(0);
	});

	it("datetime field def is available", async () => {
		// getFieldDef is monotonic; knownFieldKeys can regress when concurrent
		// enrichment mutations land out of order.
		await browser.waitUntil(
			async () => (await withApi((api) => api.getFieldDef("datetime")))?.type === "date",
			{ timeout: 60_000, interval: 50, timeoutMsg: "datetime field def never available" },
		);
	});
});

// ============================================================================
// Multiple providers merge without clobbering each other (single-pass enrichment)
// ============================================================================

// Wave ordering is not observable here: every provider's `requires` is satisfied by the
// seeded `datetime`, so nothing has to wait. The Rust engine tests own wave scheduling.
describe("Enrichment — multiple providers merge without clobbering", () => {
	useMap("E2E Enrich Merge", { closeLocation: true });
	let mergeIds: number[] = [];

	// The sunPosition plugin's procedure module, present in the e2e image at the repo root.
	// Pure compute over lat/lng + extra.datetime: deterministic and offline.
	const SUN_ENTRY = "/repo/plugins/sunPosition/procedure.js";

	before(async () => {
		// A provider whose fields are all deselected is skipped, so the sun keys must be enabled.
		// The seeded imageDate matches the mock pano's: a changed imageDate nulls datetime,
		// which would starve every provider that requires it.
		await updateMapSettings({
			enrichMetadata: true,
			enrichFields: ["countryCode", "timezone", "sunAzimuth", "sunAltitude"],
		});

		mergeIds = await addLocs([
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
				extra: { datetime: 1700000000, imageDate: "2021-09", keep: "a" },
			}),
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
				extra: { datetime: 1700003600, imageDate: "2021-09", keep: "b" },
			}),
		]);

		// Registration disposables are only tracked during a plugin's activation window, so
		// a provider registered from a test lives for the rest of the app session. Pinning
		// `select` to these ids is what keeps it off every other suite's locations.
		await withApi(
			async (api, ids, entry) => {
				api.registerProvider({
					id: "e2e-sun",
					requires: ["datetime"],
					fieldDefs: {
						sunAzimuth: { type: "number", label: "Sun azimuth" },
						sunAltitude: { type: "number", label: "Sun altitude" },
					},
					procedure: {
						entry,
						select: { type: "Locations", locations: ids, name: null },
						batch: { mode: "chunk", size: 1000 },
					},
				});
				return "ok";
			},
			mergeIds,
			SUN_ENTRY,
		);
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("single-location enrich keeps the plugin procedure's fields plus core metadata", async () => {
		await openLocation(mergeIds[0]);
		await waitForPreview();
		await waitForEnrichment(mergeIds[0]); // core countryCode, written in JS from the pano data
		await browser.waitUntil(
			async () => {
				const l = await readLocation(mergeIds[0]);
				return l?.extra?.sunAzimuth != null && l?.extra?.timezone != null;
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "plugin procedure fields never present" },
		);

		const l = await readLocation(mergeIds[0]);
		expect(typeof l.extra.sunAzimuth).toBe("number");
		expect(typeof l.extra.sunAltitude).toBe("number");
		expect(typeof l.extra.timezone).toBe("string");
		expect(l.extra.countryCode).toBeTruthy();
		expect(l.extra.keep).toBe("a");
		expect(l.extra.datetime).toBe(1700000000);
	});

	it("bulk enrichAll merges every provider into the pre-existing extra", async () => {
		// Only offline fields are selected, so the network-bound core providers (svMeta,
		// exactDate) sit the run out and every write below comes from an offline module.
		await updateMapSettings({ enrichFields: ["timezone", "sunAzimuth", "sunAltitude"] });
		await withApi(async (api) => {
			await api.enrichAll({ type: "Everything" }, { force: true });
			return "ok";
		});
		await browser.waitUntil(
			async () => {
				for (const id of mergeIds) {
					const l = await readLocation(id);
					if (l?.extra?.sunAzimuth == null || l?.extra?.timezone == null) return false;
				}
				return true;
			},
			{
				timeout: PANO_TIMEOUT,
				timeoutMsg: "plugin procedure fields never present on every location",
			},
		);

		const expected = [
			{ keep: "a", datetime: 1700000000 },
			{ keep: "b", datetime: 1700003600 },
		];
		for (let i = 0; i < mergeIds.length; i++) {
			const l = await readLocation(mergeIds[i]);
			expect(typeof l.extra.sunAzimuth).toBe("number");
			expect(typeof l.extra.sunAltitude).toBe("number");
			expect(typeof l.extra.timezone).toBe("string");
			expect(l.extra.timezone.length).toBeGreaterThan(0);
			expect(l.extra.keep).toBe(expected[i].keep);
			expect(l.extra.datetime).toBe(expected[i].datetime);
		}
	});
});

// ============================================================================
// Filter by metadata uses correct types
// ============================================================================

describe("Enrichment — metadata filter uses registered field types", () => {
	useMap("E2E Enrich Filter");
	let filterAId: number;
	let filterBId: number;
	let filterCId: number;

	before(async () => {
		const locs = [
			loc({
				lat: 10,
				lng: 20,
				extra: { altitude: 100, countryCode: "US", imageDate: "2023-06" },
			}),
			loc({
				lat: 30,
				lng: 40,
				extra: { altitude: 200, countryCode: "RU", imageDate: "2024-01" },
			}),
			loc({
				lat: 50,
				lng: 60,
				extra: { altitude: 50 },
			}),
		];
		const ids = await addLocs(locs);
		filterAId = ids[0];
		filterBId = ids[1];
		filterCId = ids[2];
		// Register field defs
		await withApi(async (api) => {
			const cur = api.getMapState().map!.extra?.fields ?? {};
			await api.updateMapMeta({
				extra: {
					...api.getMapState().map!.extra,
					fields: {
						...cur,
						altitude: { type: "number", label: "Altitude" },
						countryCode: { type: "string", label: "Country code" },
						imageDate: { type: "month", label: "Image date" },
					},
				},
			});
			return "ok";
		});
	});
	it("numeric filter (altitude > 75) selects correct locations", async () => {
		await withApi(async (api) => {
			await api.addSelections([
				{
					type: "Filter",
					field: "altitude",
					test: { op: "gt", value: 75 },
				},
			]);
			return "ok";
		});
		const ids = await refreshSelections();
		expect(ids).toContain(filterAId);
		expect(ids).toContain(filterBId);
		expect(ids).not.toContain(filterCId);
	});

	it("string equality filter (countryCode = US) selects correct location", async () => {
		await withApi(async (api) => {
			await api.resetSelections();
			await api.addSelections([
				{
					type: "Filter",
					field: "countryCode",
					test: { op: "eq", value: "US" },
				},
			]);
			return "ok";
		});
		const ids = await refreshSelections();
		expect(ids).toContain(filterAId);
		expect(ids).not.toContain(filterBId);
		expect(ids).not.toContain(filterCId);
	});

	it("between filter (altitude 60-150) selects correct location", async () => {
		await withApi(async (api) => {
			await api.resetSelections();
			await api.addSelections([
				{
					type: "Filter",
					field: "altitude",
					test: { op: "between", lo: 60, hi: 150 },
				},
			]);
			return "ok";
		});
		const ids = await refreshSelections();
		expect(ids).toContain(filterAId);
		expect(ids).not.toContain(filterBId);
		expect(ids).not.toContain(filterCId);
	});

	it("string inequality filter (countryCode != US)", async () => {
		await withApi(async (api) => {
			await api.resetSelections();
			await api.addSelections([
				{
					type: "Filter",
					field: "countryCode",
					test: { op: "neq", value: "US" },
				},
			]);
			return "ok";
		});
		const ids = await refreshSelections();
		expect(ids).toContain(filterBId);
		expect(ids).not.toContain(filterAId);
		// filter-c has no countryCode: an absent field matches only nothas
	});

	it("month comparison filter (imageDate >= 2024-01)", async () => {
		await withApi(async (api) => {
			await api.resetSelections();
			await api.addSelections([
				{
					type: "Filter",
					field: "imageDate",
					test: { op: "gte", value: "2024-01" },
				},
			]);
			return "ok";
		});
		const ids = await refreshSelections();
		expect(ids).toContain(filterBId);
		expect(ids).not.toContain(filterAId);
	});

	it("filter on missing field excludes locations without it", async () => {
		await withApi(async (api) => {
			await api.resetSelections();
			await api.addSelections([
				{
					type: "Filter",
					field: "imageDate",
					test: { op: "eq", value: "2023-06" },
				},
			]);
			return "ok";
		});
		const ids = await refreshSelections();
		expect(ids).toContain(filterAId);
		expect(ids).not.toContain(filterCId);
	});
});

describe("Enrichment — the read-only query surface", () => {
	useMap("query-surface");

	it("svMeta answers metadata for arbitrary panos without touching the store", async () => {
		const before = await withApi(async (api) => (await api.cmd.storeGetSummary()).locationCount);

		const answers = (await withApi(
			async (api, pano) =>
				JSON.parse(
					await api.cmd.procedureQuery(
						"res://procedures/svMeta.js",
						JSON.stringify({ op: "metadata", panoIds: [pano, "DEAD_PANO"] }),
						null,
						null,
					),
				),
			OFFICIAL_PANO,
		)) as any[];

		expect(answers).toHaveLength(2);
		expect(answers[1]).toBe(null);
		expect(answers[0].pano).toBe(OFFICIAL_PANO);
		expect(answers[0].lat).toBeCloseTo(OFFICIAL_COORDS.lat, 6);
		expect(answers[0].lng).toBeCloseTo(OFFICIAL_COORDS.lng, 6);
		expect(answers[0].countryCode).toBe("RU");
		expect(answers[0].worldSize).toEqual({ width: 16384, height: 8192 });
		expect(answers[0].tileSize).toEqual({ width: 512, height: 512 });

		expect(await withApi(async (api) => (await api.cmd.storeGetSummary()).locationCount)).toBe(
			before,
		);
	});

	it("the JS wrapper hands the module's answer over as plain data", async () => {
		const data = (await withApi(async (api, pano) => {
			const [d] = await api.svMetadata([pano]);
			if (!d) return null;
			return {
				pano: d.pano,
				lat: d.lat,
				worldHeight: d.worldSize.height,
				date: d.date,
				timePanos: d.time.map((t: any) => t.pano),
				timeDates: d.time.map((t: any) => t.date),
			};
		}, OFFICIAL_PANO)) as any;

		expect(data).not.toBe(null);
		expect(data.pano).toBe(OFFICIAL_PANO);
		// A number, not an accessor: nothing pretends to be a live opensv object.
		expect(data.lat).toBeCloseTo(OFFICIAL_COORDS.lat, 6);
		expect(data.worldHeight).toBe(8192);
		expect(data.date).toEqual({ year: 2021, month: 9, day: 1 });
		// The whole capture history, each entry its own pano: the fixture has three dates.
		expect(new Set(data.timePanos).size).toBe(3);
		expect(data.timePanos).toContain(OFFICIAL_PANO);
		expect(data.timeDates).toEqual(["2012-08-01", "2015-06-01", "2021-09-01"]);
	});

	it("a module without a query export fails loudly", async () => {
		const err = await withApi(async (api) => {
			try {
				await api.cmd.procedureQuery("res://procedures/timezone.js", "{}", null, null);
				return "no error";
			} catch (e: any) {
				return String(e?.message ?? e);
			}
		});
		expect(err).toContain("query");
	});
});
