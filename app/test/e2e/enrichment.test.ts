/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	addLocs,
	createLocation,
	openLocation,
	closeLocation,
	refreshSelections,
	withApi,
	useMap,
} from "./helpers";
import type { Location } from "@/bindings.gen";

const OFFICIAL_PANO = "-zrYsLR4Fh-cfJG_EMZ1-A";
const OFFICIAL_COORDS = { lat: 52.10947502806108, lng: 34.90131410856584 };

const LoadAsPanoId = 1;
const PANO_TIMEOUT = 10_000;

function loc(overrides: Partial<Location> = {}): Location {
	return createLocation({
		lat: 0,
		lng: 0,
		modifiedAt: Math.floor(Date.now() / 1000),
		...overrides,
	});
}

async function readLocation(id: number): Promise<any> {
	return withApi(async (api, locId) => {
		return await api.fetchLocation(locId);
	}, id);
}

async function getMapMeta(): Promise<any> {
	return withApi(async (api) => {
		return api.getMapState().map?.meta ?? null;
	});
}

async function updateMapSettings(patch: Record<string, any>) {
	await withApi(async (api, p) => {
		const map = api.getMapState().map!;
		await api.updateMapMeta({ settings: { ...map.meta.settings, ...p } });
		return "ok";
	}, patch);
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
			const keys = await withApi((api) => [...api.getMapState().knownFieldKeys]);
			return wanted.every((k) => keys.includes(k));
		},
		{
			timeout: timeoutMs,
			interval: 50,
			timeoutMsg: `field defs never registered: ${wanted.join(", ")}`,
		},
	);
}

async function waitForPreview() {
	const el = await browser.$(".location-preview");
	await el.waitForExist({ timeout: 5000 });
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
				flags: LoadAsPanoId,
			}),
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LoadAsPanoId,
				extra: { myCustomField: "keep-me", anotherField: 42 },
			}),
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LoadAsPanoId,
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
				flags: LoadAsPanoId,
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
				flags: LoadAsPanoId,
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
			const cur = api.getMapState().map!.meta.extra?.fields ?? {};
			await api.updateMapMeta({
				extra: {
					...api.getMapState().map!.meta.extra,
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
		await addLocs([loc({ lat: 10, lng: 20, extra: { altitude: 100, countryCode: "US" } })]);

		await waitForFieldKeys(PANO_TIMEOUT, "altitude", "countryCode");
		const defs = await withApi((api) => ({
			altitude: api.getFieldDef("altitude"),
			countryCode: api.getFieldDef("countryCode"),
		}));
		expect(defs.altitude?.type).toBe("number");
		expect(defs.countryCode?.type).toBe("string");
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
				flags: LoadAsPanoId,
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

describe("Enrichment — multiple providers merge without clobbering", () => {
	useMap("E2E Enrich Merge", { closeLocation: true });
	let singleId: number;
	let bulkAId: number;
	let bulkBId: number;
	let trigId: number;

	before(async () => {
		await updateMapSettings({ enrichMetadata: true, enrichFields: undefined });

		// Register four providers writing distinct keys. They gate on per-test sentinel
		// extra keys so they never touch other suites' locations — there is no unregister
		// API, so these persist for the rest of the app session.
		await withApi(async (api) => {
			const gated = (sentinel: string, key: string, value: number) => async (locs: any[]) =>
				new Map(locs.filter((l) => l.extra?.[sentinel]).map((l) => [l.id, { [key]: value }]));
			api.registerEnrichmentProvider({
				id: "e2e-clobber-a",
				fieldDefs: {},
				enrich: gated("__clobberTest", "clobberA", 1),
			});
			api.registerEnrichmentProvider({
				id: "e2e-clobber-b",
				fieldDefs: {},
				enrich: gated("__clobberTest", "clobberB", 2),
			});
			api.registerEnrichmentProvider({
				id: "e2e-trig-a",
				fieldDefs: {},
				requires: ["datetime"],
				enrich: gated("__trigTest", "trigA", 1),
			});
			api.registerEnrichmentProvider({
				id: "e2e-trig-b",
				fieldDefs: {},
				requires: ["datetime"],
				enrich: gated("__trigTest", "trigB", 2),
			});
			return "ok";
		});

		const ids = await addLocs([
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LoadAsPanoId,
				extra: { __clobberTest: true },
			}),
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LoadAsPanoId,
				extra: { __clobberTest: true },
			}),
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LoadAsPanoId,
				extra: { __clobberTest: true },
			}),
			loc({ lat: 12, lng: 34, extra: { __trigTest: true } }),
		]);
		singleId = ids[0];
		bulkAId = ids[1];
		bulkBId = ids[2];
		trigId = ids[3];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("single-location enrich keeps both providers' fields plus core metadata", async () => {
		await openLocation(singleId);
		await waitForPreview();
		await waitForEnrichment(singleId); // core countryCode
		await browser.waitUntil(
			async () => {
				const l = await readLocation(singleId);
				return l?.extra?.clobberA != null && l?.extra?.clobberB != null;
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "both provider fields never present" },
		);

		const l = await readLocation(singleId);
		expect(l.extra.clobberA).toBe(1);
		expect(l.extra.clobberB).toBe(2);
		expect(l.extra.countryCode).toBeTruthy();
	});

	it("bulk enrichAll keeps both providers' fields on every location", async () => {
		await withApi(async (api) => {
			await api.enrichAll(await api.fetchAllLocations());
			return "ok";
		});
		await browser.waitUntil(
			async () => {
				const a = await readLocation(bulkAId);
				const b = await readLocation(bulkBId);
				return (
					a?.extra?.clobberA != null &&
					a?.extra?.clobberB != null &&
					b?.extra?.clobberA != null &&
					b?.extra?.clobberB != null
				);
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "bulk provider fields never present on both locations" },
		);

		for (const id of [bulkAId, bulkBId]) {
			const l = await readLocation(id);
			expect(l.extra.clobberA).toBe(1);
			expect(l.extra.clobberB).toBe(2);
			expect(l.extra.countryCode).toBeTruthy();
		}
	});

	it("provider waves merge with pre-existing extra instead of clobbering it", async () => {
		const l0 = await readLocation(trigId);
		await withApi(async (api, loc0) => {
			await api.updateLocations([{ id: loc0.id, patch: { extra: { datetime: 1700000000 } } }], {
				undoable: false,
			});
			return "ok";
		}, l0);

		await withApi(async (api) => {
			await api.enrichAll(await api.fetchAllLocations());
			return "ok";
		});
		await browser.waitUntil(
			async () => {
				const l = await readLocation(trigId);
				return l?.extra?.trigA != null && l?.extra?.trigB != null;
			},
			{ timeout: 5000, timeoutMsg: "both wave-2 provider fields never present" },
		);

		const l = await readLocation(trigId);
		expect(l.extra.trigA).toBe(1);
		expect(l.extra.trigB).toBe(2);
		expect(l.extra.datetime).toBe(1700000000);
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
			const cur = api.getMapState().map!.meta.extra?.fields ?? {};
			await api.updateMapMeta({
				extra: {
					...api.getMapState().map!.meta.extra,
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
					op: "gt",
					value: 75,
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
			api.resetSelections();
			await api.addSelections([
				{
					type: "Filter",
					field: "countryCode",
					op: "eq",
					value: "US",
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
			api.resetSelections();
			await api.addSelections([
				{
					type: "Filter",
					field: "altitude",
					op: "between",
					value: 60,
					value2: 150,
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
			api.resetSelections();
			await api.addSelections([
				{
					type: "Filter",
					field: "countryCode",
					op: "neq",
					value: "US",
				},
			]);
			return "ok";
		});
		const ids = await refreshSelections();
		expect(ids).toContain(filterBId);
		expect(ids).not.toContain(filterAId);
		// filter-c has no countryCode, so it's excluded (null != "US" is truthy but field is missing)
	});

	it("month comparison filter (imageDate >= 2024-01)", async () => {
		await withApi(async (api) => {
			api.resetSelections();
			await api.addSelections([
				{
					type: "Filter",
					field: "imageDate",
					op: "gte",
					value: "2024-01",
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
			api.resetSelections();
			await api.addSelections([
				{
					type: "Filter",
					field: "imageDate",
					op: "eq",
					value: "2023-06",
				},
			]);
			return "ok";
		});
		const ids = await refreshSelections();
		expect(ids).toContain(filterAId);
		expect(ids).not.toContain(filterCId);
	});
});
