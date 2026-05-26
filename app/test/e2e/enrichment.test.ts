/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	createLocation,
	openLocation,
	closeLocation,
	refreshSelections,
	withApi,
} from "./helpers";
import type { Location } from "@/types";

const OFFICIAL_PANO = "-zrYsLR4Fh-cfJG_EMZ1-A";
const OFFICIAL_COORDS = { lat: 52.10947502806108, lng: 34.90131410856584 };

const LoadAsPanoId = 1;
const PANO_TIMEOUT = 10_000;

function loc(overrides: Partial<Location> = {}): Location {
	return createLocation({ lat: 0, lng: 0, modifiedAt: new Date().toISOString(), ...overrides });
}

async function readLocation(id: number): Promise<any> {
	return withApi(async (api, locId) => {
		return await api.fetchLocation(locId);
	}, id);
}

async function getMapMeta(): Promise<any> {
	return withApi(async (api) => {
		return api.getCurrentMap()?.meta ?? null;
	});
}

async function updateMapSettings(patch: Record<string, any>) {
	await withApi(async (api, p) => {
		const map = api.getCurrentMap()!;
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

async function waitForPreview() {
	const el = await browser.$(".location-preview");
	await el.waitForExist({ timeout: 5000 });
}

// ============================================================================
// Single-location enrichment (LocationPreview path)
// ============================================================================

describe("Enrichment — single location via preview", () => {
	let mapId: string;
	let enrichBasicId: number;
	let enrichCustomExtraId: number;
	let enrichExistingMetaId: number;
	let enrichNoPanoId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Enrich Single");
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

	after(async () => {
		await closeLocation();
		await closeMap();
		await deleteMap(mapId);
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
		await withApi(async (api) => {
			api.setSetting("showExactDate", false);
		});
		// Pre-seed with stale datetime
		await withApi(async (api, id) => {
			api.patchLocationExtra(id, {
				imageDate: "2099-01",
				datetime: 9999999999,
				timezone: "Fake/Zone",
			});
			return "ok";
		}, enrichExistingMetaId);

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
		expect(after.extra.datetime).toBeNull();
		expect(after.extra.timezone).toBeNull();
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
	let mapId: string;
	let fieldsSelectiveId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Enrich Fields");
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

	after(async () => {
		await closeLocation();
		await closeMap();
		await deleteMap(mapId);
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
		await withApi(async (api, id) => {
			api.patchLocationExtra(id, {}, true);
			return "ok";
		}, fieldsSelectiveId);

		await openLocation(fieldsSelectiveId);
		await waitForPreview();
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
	let mapId: string;
	let defsAutoId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Enrich FieldDefs");
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

	after(async () => {
		await closeLocation();
		await closeMap();
		await deleteMap(mapId);
	});

	afterEach(async () => {
		await closeLocation();
	});

	it("field defs appear on map meta after enrichment", async () => {
		await openLocation(defsAutoId);
		await waitForPreview();
		await waitForEnrichment(defsAutoId);

		const meta = await getMapMeta();
		const fields = meta?.extra?.fields ?? {};
		expect(fields.countryCode).toBeTruthy();
		expect(fields.countryCode.type).toBe("string");
		expect(fields.altitude).toBeTruthy();
		expect(fields.altitude.type).toBe("number");
		expect(fields.imageDate).toBeTruthy();
		expect(fields.imageDate.type).toBe("month");
	});

	it("does not clobber user-customized field defs", async () => {
		// Manually set countryCode to a custom type
		await withApi(async (api) => {
			const cur = api.getCurrentMap()!.meta.extra?.fields ?? {};
			await api.updateMapMeta({ extra: { ...api.getCurrentMap()!.meta.extra, fields: { ...cur, countryCode: { type: "enum", label: "My Custom Country", values: ["US", "RU"] } } } });
			return "ok";
		});

		// Clear extra and re-enrich
		await withApi(async (api, id) => {
			api.patchLocationExtra(id, {}, true);
			return "ok";
		}, defsAutoId);

		await openLocation(defsAutoId);
		await waitForPreview();
		await waitForEnrichment(defsAutoId);

		const meta = await getMapMeta();
		const fields = meta?.extra?.fields ?? {};
		// Should still be the user's custom type, not overwritten to "string"
		expect(fields.countryCode.type).toBe("enum");
		expect(fields.countryCode.label).toBe("My Custom Country");
	});

	it("patchLocationExtra auto-registers known field defs", async () => {
		// Wipe field defs
		await withApi(async (api) => {
			const map = api.getCurrentMap()!;
			await api.updateMapMeta({ extra: { ...map.meta.extra, fields: {} } });
			return "ok";
		});

		// Patch a location with a known enrichment field
		await withApi(async (api, id) => {
			api.patchLocationExtra(id, { datetime: 1700000000 });
			return "ok";
		}, defsAutoId);

		await new Promise((r) => setTimeout(r, 500));
		const meta = await getMapMeta();
		const fields = meta?.extra?.fields ?? {};
		expect(fields.datetime).toBeTruthy();
		expect(fields.datetime.type).toBe("date");
	});

	it("addLocations auto-registers known field defs", async () => {
		// Wipe field defs
		await withApi(async (api) => {
			const map = api.getCurrentMap()!;
			await api.updateMapMeta({ extra: { ...map.meta.extra, fields: {} } });
			return "ok";
		});

		await addLocs([loc({ lat: 10, lng: 20, extra: { altitude: 100, countryCode: "US" } })]);

		const meta = await getMapMeta();
		const fields = meta?.extra?.fields ?? {};
		expect(fields.altitude).toBeTruthy();
		expect(fields.altitude.type).toBe("number");
		expect(fields.countryCode).toBeTruthy();
		expect(fields.countryCode.type).toBe("string");
	});

	it("unknown extra fields do not get auto-registered", async () => {
		await withApi(async (api, id) => {
			api.patchLocationExtra(id, { randomCustomThing: "hello" });
			return "ok";
		}, defsAutoId);

		const meta = await getMapMeta();
		const fields = meta?.extra?.fields ?? {};
		expect(fields.randomCustomThing).toBeFalsy();
	});
});

// ============================================================================
// Exact date enrichment via preview
// ============================================================================

describe("Enrichment — exact date via preview", () => {
	let mapId: string;
	let exactEnrichId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Enrich ExactDate");
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

	after(async () => {
		await closeLocation();
		await closeMap();
		await deleteMap(mapId);
	});

	afterEach(async () => {
		await closeLocation();
	});

	it("datetime and timezone are written after exact date resolves", async () => {
		await withApi(async (api) => {
			api.setSetting("showExactDate", true);
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

	it("datetime field def is registered on map", async () => {
		const meta = await getMapMeta();
		const fields = meta?.extra?.fields ?? {};
		expect(fields.datetime).toBeTruthy();
		expect(fields.datetime.type).toBe("date");
	});
});

// ============================================================================
// Filter by metadata uses correct types
// ============================================================================

describe("Enrichment — metadata filter uses registered field types", () => {
	let mapId: string;
	let filterAId: number;
	let filterBId: number;
	let filterCId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Enrich Filter");
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
			const cur = api.getCurrentMap()!.meta.extra?.fields ?? {};
			await api.updateMapMeta({ extra: { ...api.getCurrentMap()!.meta.extra, fields: { ...cur, altitude: { type: "number", label: "Altitude" }, countryCode: { type: "string", label: "Country code" }, imageDate: { type: "month", label: "Image date" } } } });
			return "ok";
		});
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("numeric filter (altitude > 75) selects correct locations", async () => {
		await withApi(async (api) => {
			await api.selectFilter("altitude", "gt", 75);
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
			await api.selectFilter("countryCode", "eq", "US");
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
			await api.selectFilter("altitude", "between", 60, 150);
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
			await api.selectFilter("countryCode", "neq", "US");
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
			await api.selectFilter("imageDate", "gte", "2024-01");
			return "ok";
		});
		const ids = await refreshSelections();
		expect(ids).toContain(filterBId);
		expect(ids).not.toContain(filterAId);
	});

	it("filter on missing field excludes locations without it", async () => {
		await withApi(async (api) => {
			api.resetSelections();
			await api.selectFilter("imageDate", "eq", "2023-06");
			return "ok";
		});
		const ids = await refreshSelections();
		expect(ids).toContain(filterAId);
		expect(ids).not.toContain(filterCId);
	});
});
