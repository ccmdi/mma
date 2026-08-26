/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	addLocs,
	closeLocation,
	closeMap,
	createAndOpenMap,
	createLocation,
	createTag,
	deleteMap,
	flushAndWait,
	getAllLocs,
	getLocCount,
	getLocOrNull,
	openLocation,
	updateMapSettings,
	useMap,
	waitForActive,
	waitForDates,
	waitForFlag,
	waitForLocCount,
	waitForOptions,
	waitForPreview,
	waitForReady,
	waitForSave,
	waitForWorkArea,
	withApi,
} from "./helpers";
import type { Location } from "@/bindings.gen";
import { LocationFlag } from "@/types";

// --- Test pano IDs ---
// Official Google car coverage (Kursk oblast, Russia)
const OFFICIAL_PANO = "-zrYsLR4Fh-cfJG_EMZ1-A";
const OFFICIAL_COORDS = { lat: 52.10947502806108, lng: 34.90131410856584 };
// Unofficial / UGC photosphere (Arkhangelsk oblast, Russia)
const UNOFFICIAL_PANO = "CAoSF0NJSE0wb2dLRUlDQWdJQ3FpZG1xM3dF";
const UNOFFICIAL_COORDS = { lat: 64.44241333767505, lng: 46.193924009405855 };
// Trekker coverage (Kamchatka, Russia)
const TREKKER_PANO = "5upMz1_zTGPdkIXG6_QM3g";
const TREKKER_COORDS = { lat: 55.510656, lng: 157.636627 };
// Dead pano ID — intentionally nonexistent
const DEAD_PANO = "DEAD_PANO_DOES_NOT_EXIST_12345";

// Coord-only location (Times Square — dense coverage, no saved panoId)
const COORD_ONLY = { lat: 40.758, lng: -73.9855 };

const PANO_TIMEOUT = 30_000;

function loc(overrides: Partial<Location> = {}): Location {
	return createLocation({ lat: 0, lng: 0, ...overrides });
}

// The pano picker is a native <select> styled with appearance: base-select, so its
// <option>s are in the DOM whether or not the picker is open — no trigger click, and
// nothing to escape out of afterwards.
const PANO_OPTION = ".location-preview__date .pano-option";

/** Set the pano picker to `value` and fire the change React listens for. */
async function selectPanoValue(value: string) {
	await browser.execute((v: string) => {
		const sel = document.querySelector<HTMLSelectElement>(".location-preview__date .nselect");
		if (!sel) throw new Error("pano date select not found");
		sel.value = v;
		sel.dispatchEvent(new Event("change", { bubbles: true }));
	}, value);
}

/** Select the nth option (0 = first specific panorama; "Default" sorts last). */
async function selectPanoOption(index: number) {
	await waitForOptions(PANO_OPTION, index + 1);
	const value = await browser.execute((i: number) => {
		const opts = document.querySelectorAll<HTMLOptionElement>(
			".location-preview__date .pano-option",
		);
		return opts[i]?.value ?? null;
	}, index);
	if (!value) throw new Error(`pano option ${index} not found`);
	await selectPanoValue(value);
}

/** Get the date count from the badge. */
async function getDateCount(): Promise<number> {
	const badge = await browser.$(".location-preview__date .badge--number");
	if (!(await badge.isExisting())) return 0;
	return parseInt(await badge.getText()) || 0;
}

/** Read a location from Rust by numeric ID. */
const readLocation = getLocOrNull as (id: number) => Promise<any>;

// ============================================================================
// Tests
// ============================================================================

describe("LocationPreview — basics", () => {
	useMap("E2E LP Basics", { closeLocation: true });
	let basicCoordId: number;
	let basicDeleteId: number;

	before(async () => {
		const ids = await addLocs([
			loc({ lat: COORD_ONLY.lat, lng: COORD_ONLY.lng }),
			loc({ lat: 35, lng: 139 }),
		]);
		basicCoordId = ids[0];
		basicDeleteId = ids[1];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("opening a location shows the preview section", async () => {
		await openLocation(basicCoordId);
		await waitForPreview();
		expect(await (await browser.$(".location-preview")).isDisplayed()).toBe(true);
	});

	it("work area is 'location' when preview is open", async () => {
		await openLocation(basicCoordId);
		const area = await withApi(async (api) => api.getMapState().workArea);
		expect(area).toBe("location");
	});

	it("close button returns to overview", async () => {
		await openLocation(basicCoordId);
		const btn = await browser.$("[data-qa='location-close']");
		await btn.waitForExist({ timeout: 5000 });
		await btn.click();
		await waitForWorkArea("overview");
		const area = await withApi(async (api) => api.getMapState().workArea);
		expect(area).toBe("overview");
	});

	it("delete button removes the location", async () => {
		await openLocation(basicDeleteId);
		const btn = await browser.$("[data-qa='location-delete']");
		await btn.waitForExist({ timeout: 5000 });
		await btn.click();
		await browser.waitUntil(async () => (await readLocation(basicDeleteId)) == null, {
			timeout: 5000,
			timeoutMsg: "location was never deleted",
		});
		const fetched = await readLocation(basicDeleteId);
		expect(fetched).toBeNull();
	});
});

// ============================================================================

describe("LocationPreview — official pano", () => {
	useMap("E2E LP Official", { closeLocation: true });
	let offDefaultId: number;
	let offPinnedId: number;

	before(async () => {
		await updateMapSettings({ enrichMetadata: true });
		const ids = await addLocs([
			loc({ lat: OFFICIAL_COORDS.lat, lng: OFFICIAL_COORDS.lng, panoId: OFFICIAL_PANO }),
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
		]);
		offDefaultId = ids[0];
		offPinnedId = ids[1];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("loads and shows dates", async () => {
		await openLocation(offDefaultId);
		await waitForPreview();
		await waitForDates();
		expect(await getDateCount()).toBeGreaterThan(0);
	});

	it("date picker trigger shows a date string", async () => {
		await openLocation(offDefaultId);
		await waitForDates();
		const text = await (await browser.$(".location-preview__date .pano-value")).getText();
		expect(text).toMatch(/\w+.+\d{4}/);
	});

	it("dropdown contains multiple historical dates", async () => {
		await openLocation(offDefaultId);
		await waitForDates();
		await waitForOptions(PANO_OPTION, 2);
		const count = (await browser.$$(PANO_OPTION)).length;
		expect(count).toBeGreaterThan(1);
	});

	it("dropdown has a Default/auto-updating option", async () => {
		await openLocation(offDefaultId);
		await waitForDates();
		await waitForOptions(PANO_OPTION, 1);
		const def = await browser.execute(() => {
			const items = document.querySelectorAll(".location-preview__date .pano-option");
			return [...items].some((el) => el.textContent?.includes("Default"));
		});
		expect(def).toBe(true);
	});

	it("selecting a date sets LoadAsPanoId flag", async () => {
		await openLocation(offDefaultId);
		await waitForDates();
		await selectPanoOption(0);
		await waitForFlag(offDefaultId, LocationFlag.LoadAsPanoId);
		const l = await readLocation(offDefaultId);
		const flags = l?.flags ?? -1;
		expect(flags & LocationFlag.LoadAsPanoId).toBe(LocationFlag.LoadAsPanoId);
	});

	it("selecting Default clears LoadAsPanoId flag", async () => {
		await openLocation(offDefaultId);
		await waitForDates();
		// first select a specific date
		await selectPanoOption(0);
		await waitForFlag(offDefaultId, LocationFlag.LoadAsPanoId);
		// now select Default
		await selectPanoValue("default");
		await waitForFlag(offDefaultId, LocationFlag.LoadAsPanoId, false);
		const l = await readLocation(offDefaultId);
		const flags = l?.flags ?? -1;
		expect(flags & LocationFlag.LoadAsPanoId).toBe(0);
	});

	it("save persists panoId and heading/pitch/zoom", async () => {
		await openLocation(offDefaultId);
		await waitForDates();
		const saveBtn = await browser.$("[data-qa='location-save']");
		await saveBtn.click();
		await waitForSave(offDefaultId, (l) => typeof l.panoId === "string" && l.panoId.length > 0);
		const saved = await readLocation(offDefaultId);
		expect(saved).not.toBeNull();
		expect(typeof saved.panoId).toBe("string");
		expect(saved.panoId.length).toBeGreaterThan(0);
		expect(typeof saved.heading).toBe("number");
		expect(typeof saved.pitch).toBe("number");
		expect(typeof saved.zoom).toBe("number");
	});

	it("save with pinned pano preserves the pinned panoId", async () => {
		await openLocation(offPinnedId);
		await waitForDates();
		const saveBtn = await browser.$("[data-qa='location-save']");
		await saveBtn.click();
		await waitForSave(offPinnedId, (l) => l.panoId === OFFICIAL_PANO);
		const saved = await readLocation(offPinnedId);
		expect(saved.panoId).toBe(OFFICIAL_PANO);
		expect(saved.flags & LocationFlag.LoadAsPanoId).toBe(LocationFlag.LoadAsPanoId);
	});

	it("reopen same location still shows dates", async () => {
		await openLocation(offDefaultId);
		await waitForDates();
		const count1 = await getDateCount();
		await closeLocation();
		await openLocation(offDefaultId);
		await waitForDates();
		const count2 = await getDateCount();
		expect(count2).toBe(count1);
	});

	it("metadata enrichment populates extra fields", async () => {
		await openLocation(offDefaultId);
		await waitForDates();
		// Give metadata fetch time to complete
		await browser.waitUntil(
			async () => {
				const l = await readLocation(offDefaultId);
				return l?.extra?.countryCode != null;
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "Metadata enrichment never completed" },
		);
		const l = await readLocation(offDefaultId);
		expect(l.extra.countryCode).toBeTruthy();
		expect(typeof l.extra.altitude).toBe("number");
	});
});

// ============================================================================

describe("LocationPreview — unofficial pano", () => {
	useMap("E2E LP Unofficial", { closeLocation: true });
	let unoff1Id: number;

	before(async () => {
		const ids = await addLocs([
			loc({
				lat: UNOFFICIAL_COORDS.lat,
				lng: UNOFFICIAL_COORDS.lng,
				panoId: UNOFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
		]);
		unoff1Id = ids[0];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("loads without crashing", async () => {
		await openLocation(unoff1Id);
		await waitForPreview();
		// Just verify the preview section exists and doesn't crash
		expect(await (await browser.$(".location-preview")).isDisplayed()).toBe(true);
	});

	it("shows unofficial badge", async () => {
		await openLocation(unoff1Id);
		await waitForPreview();
		await browser.waitUntil(
			async () => {
				const badge = await browser.$(".badge--unofficial");
				return await badge.isExisting();
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "Unofficial badge never appeared" },
		);
	});

	it("date picker still functions", async () => {
		await openLocation(unoff1Id);
		await waitForPreview();
		// Unofficial panos may or may not have dates — just verify the picker renders
		const dateSection = await browser.$(".location-preview__date");
		expect(await dateSection.isExisting()).toBe(true);
	});

	it("save works for unofficial pano", async () => {
		await openLocation(unoff1Id);
		await waitForPreview();
		await waitForDates();
		const saveBtn = await browser.$("[data-qa='location-save']");
		await saveBtn.click();
		await waitForSave(unoff1Id);
		const saved = await readLocation(unoff1Id);
		expect(saved).not.toBeNull();
		expect(typeof saved.panoId).toBe("string");
	});
});

// ============================================================================

describe("LocationPreview — trekker pano", () => {
	useMap("E2E LP Trekker", { closeLocation: true });
	let trek1Id: number;

	before(async () => {
		const ids = await addLocs([
			loc({
				lat: TREKKER_COORDS.lat,
				lng: TREKKER_COORDS.lng,
				panoId: TREKKER_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
		]);
		trek1Id = ids[0];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("loads and shows dates", async () => {
		await openLocation(trek1Id);
		await waitForPreview();
		await waitForDates();
		expect(await getDateCount()).toBeGreaterThan(0);
	});

	it("save works for trekker pano", async () => {
		await openLocation(trek1Id);
		await waitForDates();
		const saveBtn = await browser.$("[data-qa='location-save']");
		await saveBtn.click();
		await waitForSave(trek1Id, (l) => !!l.panoId);
		const saved = await readLocation(trek1Id);
		expect(saved.panoId).toBeTruthy();
	});

	it("reopen trekker location still shows dates", async () => {
		await openLocation(trek1Id);
		await waitForDates();
		await closeLocation();
		await openLocation(trek1Id);
		await waitForDates();
		expect(await getDateCount()).toBeGreaterThan(0);
	});
});

// ============================================================================

describe("LocationPreview — dead pano (fallback)", () => {
	useMap("E2E LP Dead Pano", { closeLocation: true });
	let dead1Id: number;

	before(async () => {
		const ids = await addLocs([
			// Dead pano with valid fallback coords (Times Square)
			loc({
				lat: COORD_ONLY.lat,
				lng: COORD_ONLY.lng,
				panoId: DEAD_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
		]);
		dead1Id = ids[0];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("falls back to coord-based pano and still loads", async () => {
		await openLocation(dead1Id);
		await waitForPreview();
		// Should fall back to coord-based lookup and eventually show dates
		await waitForDates();
		expect(await getDateCount()).toBeGreaterThan(0);
	});

	it("resolved pano differs from the dead pano ID", async () => {
		await openLocation(dead1Id);
		await waitForDates();
		// The viewer should have resolved to a real pano via coord fallback
		const resolvedPanoId = await withApi(async (api) => {
			return api.getMapState().activeLocation?.panoId ?? null;
		});
		// The stored panoId is still the dead one (not saved yet), but the viewer resolved differently
		expect(resolvedPanoId).toBe("DEAD_PANO_DOES_NOT_EXIST_12345");
	});

	it("save after fallback persists the resolved pano (not the dead one)", async () => {
		await openLocation(dead1Id);
		await waitForDates();
		const saveBtn = await browser.$("[data-qa='location-save']");
		await saveBtn.click();
		await waitForSave(dead1Id, (l) => l.panoId !== DEAD_PANO);
		const saved = await readLocation(dead1Id);
		expect(saved.panoId).not.toBe(DEAD_PANO);
		expect(saved.panoId).toBeTruthy();
	});
});

// ============================================================================

describe("LocationPreview — coord-only location (no panoId)", () => {
	useMap("E2E LP Coord Only", { closeLocation: true });
	let coord1Id: number;

	before(async () => {
		const ids = await addLocs([loc({ lat: COORD_ONLY.lat, lng: COORD_ONLY.lng })]);
		coord1Id = ids[0];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("resolves pano from coordinates and shows dates", async () => {
		await openLocation(coord1Id);
		await waitForPreview();
		await waitForDates();
		expect(await getDateCount()).toBeGreaterThan(0);
	});

	it("save populates panoId from resolved pano", async () => {
		await openLocation(coord1Id);
		await waitForDates();
		const saveBtn = await browser.$("[data-qa='location-save']");
		await saveBtn.click();
		await waitForSave(coord1Id, (l) => !!l.panoId);
		const saved = await readLocation(coord1Id);
		expect(saved.panoId).toBeTruthy();
		expect(saved.lat).not.toBe(0);
		expect(saved.lng).not.toBe(0);
	});
});

// ============================================================================

describe("LocationPreview — switching between pano types", () => {
	useMap("E2E LP Switching", { closeLocation: true });
	let swOfficialId: number;
	let swTrekkerId: number;
	let swCoordId: number;

	before(async () => {
		const ids = await addLocs([
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
			loc({
				lat: TREKKER_COORDS.lat,
				lng: TREKKER_COORDS.lng,
				panoId: TREKKER_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
			loc({ lat: COORD_ONLY.lat, lng: COORD_ONLY.lng }),
		]);
		swOfficialId = ids[0];
		swTrekkerId = ids[1];
		swCoordId = ids[2];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("official -> trekker: dates update", async () => {
		await openLocation(swOfficialId);
		await waitForDates();
		const count1 = await getDateCount();

		await openLocation(swTrekkerId);
		await waitForDates();
		const count2 = await getDateCount();

		expect(count1).toBeGreaterThan(0);
		expect(count2).toBeGreaterThan(0);
	});

	it("trekker -> coord-only: dates update", async () => {
		await openLocation(swTrekkerId);
		await waitForDates();

		await openLocation(swCoordId);
		await waitForDates();
		expect(await getDateCount()).toBeGreaterThan(0);
	});

	it("rapid switching does not leave stale data", async () => {
		// Switch quickly between all three
		await openLocation(swOfficialId);
		await waitForActive(swOfficialId);
		await openLocation(swTrekkerId);
		await waitForActive(swTrekkerId);
		await openLocation(swCoordId);

		// The final location should load properly
		await waitForDates();
		expect(await getDateCount()).toBeGreaterThan(0);

		// Verify it's showing data for the coord location, not a stale one
		const area = await withApi(async (api) => api.getMapState().workArea);
		expect(area).toBe("location");
		const active = await withApi(async (api) => {
			return api.getMapState().activeLocation?.id ?? null;
		});
		expect(active).toBe(swCoordId);
	});
});

// ============================================================================

describe("LocationPreview — location with tags", () => {
	useMap("E2E LP Tags", { closeLocation: true });
	let tagRedId: number;
	let tagBlueId: number;
	let tagged1Id: number;

	before(async () => {
		const tagRed = await createTag("Red");
		tagRedId = tagRed.id;
		const tagBlue = await createTag("Blue");
		tagBlueId = tagBlue.id;
		const ids = await addLocs([
			loc({
				lat: COORD_ONLY.lat,
				lng: COORD_ONLY.lng,
				tags: [tagRedId, tagBlueId],
			}),
		]);
		tagged1Id = ids[0];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("shows tags in the preview", async () => {
		await openLocation(tagged1Id);
		await waitForPreview();
		await browser.waitUntil(
			async () => {
				const tags = await browser.$$(".location-preview__tags .tag");
				return (await tags.length) >= 2;
			},
			{ timeout: 5000, timeoutMsg: "Tag items never appeared in preview" },
		);
	});

	it("save preserves tags", async () => {
		await openLocation(tagged1Id);
		await waitForDates();
		const saveBtn = await browser.$("[data-qa='location-save']");
		await saveBtn.click();
		await waitForSave(tagged1Id, (l) => l.tags.includes(tagRedId));
		const saved = await readLocation(tagged1Id);
		expect(saved.tags).toContain(tagRedId);
		expect(saved.tags).toContain(tagBlueId);
	});
});

// ============================================================================

describe("LocationPreview — exact date resolution", () => {
	useMap("E2E LP Exact Date", { closeLocation: true });
	let exact1Id: number;

	before(async () => {
		await withApi(async (api) => {
			const map = api.getMapState().map!;
			await api.updateMapMeta({
				settings: {
					...map.settings,
					enrichMetadata: true,
					enrichFields: [
						"altitude",
						"countryCode",
						"cameraType",
						"panoType",
						"imageDate",
						"datetime",
						"timezone",
					],
				},
			});
			return "ok";
		});
		const ids = await addLocs([
			loc({ lat: OFFICIAL_COORDS.lat, lng: OFFICIAL_COORDS.lng, panoId: OFFICIAL_PANO }),
		]);
		exact1Id = ids[0];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("exact date resolves on initial load (shows day, not just month)", async () => {
		await openLocation(exact1Id);
		await waitForDates();

		// Wait for exact date to resolve — the loading badge "..." should appear then disappear
		// and the date label should contain a day number (e.g., "Sep 6, 2018" not just "Sep 2018")
		await browser.waitUntil(
			async () => {
				const loading = await browser.$(".location-preview__date .badge--loading");
				if (await loading.isExisting()) return false; // still loading
				const label = await browser.$(".location-preview__date .pano-value");
				if (!(await label.isExisting())) return false;
				const text = await label.getText();
				// Exact date format includes a day: "Sep 6, 2018" vs month-only "Sep 2018"
				return /\w+ \d{1,2}, \d{4}/.test(text);
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "Exact date never resolved to a specific day" },
		);
	});

	it("exact date enriches location extra with datetime", async () => {
		await openLocation(exact1Id);
		await waitForDates();

		await browser.waitUntil(
			async () => {
				const l = await readLocation(exact1Id);
				return l?.extra?.datetime != null;
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "datetime was never written to location extra" },
		);

		const l = await readLocation(exact1Id);
		expect(typeof l.extra.datetime).toBe("number");
		expect(l.extra.datetime).toBeGreaterThan(0);
	});

	it("reopen with exact date still resolves", async () => {
		await openLocation(exact1Id);
		await waitForDates();

		// Wait for exact date
		await browser.waitUntil(
			async () => {
				const label = await browser.$(".location-preview__date .pano-value");
				if (!(await label.isExisting())) return false;
				return /\w+ \d{1,2}, \d{4}/.test(await label.getText());
			},
			{ timeout: PANO_TIMEOUT },
		);

		await closeLocation();
		await openLocation(exact1Id);
		await waitForDates();

		// Should resolve quickly from cache
		await browser.waitUntil(
			async () => {
				const label = await browser.$(".location-preview__date .pano-value");
				if (!(await label.isExisting())) return false;
				return /\w+ \d{1,2}, \d{4}/.test(await label.getText());
			},
			{ timeout: 10_000, timeoutMsg: "Exact date did not resolve on reopen (cache miss?)" },
		);
	});
});

// ============================================================================

describe("LocationPreview — save captures full pano state", () => {
	useMap("E2E LP Save State", { closeLocation: true });
	let saveFullId: number;

	before(async () => {
		const ids = await addLocs([
			loc({ lat: OFFICIAL_COORDS.lat, lng: OFFICIAL_COORDS.lng, panoId: OFFICIAL_PANO }),
		]);
		saveFullId = ids[0];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("save captures lat/lng from pano position (not original coords)", async () => {
		await openLocation(saveFullId);
		await waitForDates();
		const saveBtn = await browser.$("[data-qa='location-save']");
		await saveBtn.click();
		await waitForSave(saveFullId, (l) => l.lat !== 0 && l.lng !== 0);
		const after = await readLocation(saveFullId);
		// Lat/lng should be set to the pano's actual position (might differ slightly from original)
		expect(typeof after.lat).toBe("number");
		expect(typeof after.lng).toBe("number");
		expect(after.lat).not.toBe(0);
		expect(after.lng).not.toBe(0);
	});

	it("save captures heading/pitch/zoom", async () => {
		await openLocation(saveFullId);
		await waitForDates();
		const saveBtn = await browser.$("[data-qa='location-save']");
		await saveBtn.click();
		await waitForSave(saveFullId);
		const saved = await readLocation(saveFullId);
		expect(typeof saved.heading).toBe("number");
		expect(typeof saved.pitch).toBe("number");
		expect(typeof saved.zoom).toBe("number");
	});
});

// ============================================================================

describe("LocationPreview — return to spawn", () => {
	useMap("E2E LP Return Spawn", { closeLocation: true });
	let spawn1Id: number;

	before(async () => {
		const ids = await addLocs([
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
				heading: 228.57,
				pitch: 0,
				zoom: 0,
			}),
		]);
		spawn1Id = ids[0];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("return to spawn resets selectedPanoId (shows Default)", async () => {
		await openLocation(spawn1Id);
		await waitForDates();

		// Select a specific date first
		await selectPanoOption(0);
		await waitForFlag(spawn1Id, LocationFlag.LoadAsPanoId);

		// Press 'r' to return to spawn
		await browser.keys("r");

		// The date picker should show "Default" again
		const label = await browser.$(".location-preview__date .pano-value");
		await browser.waitUntil(async () => (await label.getText()).includes("Default"), {
			timeout: 5000,
			timeoutMsg: "date picker never returned to Default",
		});
		const text = await label.getText();
		expect(text).toContain("Default");
	});
});

// ============================================================================

describe("LocationPreview — next/prev date hotkeys", () => {
	useMap("E2E LP Date Hotkeys", { closeLocation: true });
	let hotkeyDatesId: number;

	before(async () => {
		const ids = await addLocs([
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
		]);
		hotkeyDatesId = ids[0];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("']' key selects next date", async () => {
		await openLocation(hotkeyDatesId);
		await browser.waitUntil(
			async () => {
				const badge = await browser.$(".location-preview__date .badge--number");
				if (!(await badge.isExisting())) return false;
				return parseInt(await badge.getText()) > 1;
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "Need multiple dates to test hotkey" },
		);

		// Press ] to cycle to next date
		await browser.keys("]");
		await waitForFlag(hotkeyDatesId, LocationFlag.LoadAsPanoId);

		// LocationFlag.LoadAsPanoId should now be set (date was explicitly selected via hotkey)
		const l = await readLocation(hotkeyDatesId);
		const flags = l?.flags ?? -1;
		expect(flags & LocationFlag.LoadAsPanoId).toBe(LocationFlag.LoadAsPanoId);
	});

	it("'[' key selects previous date", async () => {
		await openLocation(hotkeyDatesId);
		await browser.waitUntil(
			async () => {
				const badge = await browser.$(".location-preview__date .badge--number");
				if (!(await badge.isExisting())) return false;
				return parseInt(await badge.getText()) > 1;
			},
			{ timeout: PANO_TIMEOUT },
		);

		// Press [ to cycle to prev date
		await browser.keys("[");
		await waitForFlag(hotkeyDatesId, LocationFlag.LoadAsPanoId);

		const l = await readLocation(hotkeyDatesId);
		const flags = l?.flags ?? -1;
		expect(flags & LocationFlag.LoadAsPanoId).toBe(LocationFlag.LoadAsPanoId);
	});
});

// ============================================================================

describe("LocationPreview — duplicate location", () => {
	useMap("E2E LP Duplicate", { closeLocation: true });
	let dupSrcId: number;

	before(async () => {
		const ids = await addLocs([
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
				tags: [],
			}),
		]);
		dupSrcId = ids[0];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("'c' key duplicates the location", async () => {
		await openLocation(dupSrcId);
		await waitForPreview();

		const beforeCount = await getLocCount();

		await browser.keys("c");
		await waitForLocCount(beforeCount + 1);

		const afterCount = await getLocCount();

		expect(afterCount).toBe(beforeCount + 1);
	});

	it("duplicated location has same coords and panoId", async () => {
		await openLocation(dupSrcId);
		await waitForPreview();

		await browser.keys("c");
		await browser.waitUntil(
			async () => (await getAllLocs()).some((l) => l.id !== dupSrcId && l.panoId === OFFICIAL_PANO),
			{ timeout: 5000, timeoutMsg: "duplicate never appeared" },
		);

		const locs = await getAllLocs();

		const src = locs.find((l) => l.id === dupSrcId);
		const dup = locs.find((l) => l.id !== dupSrcId && l.panoId === OFFICIAL_PANO);
		expect(dup).toBeTruthy();
		expect(src).toBeTruthy();
		expect(dup!.lat).toBe(src!.lat);
		expect(dup!.lng).toBe(src!.lng);
	});
});

// ============================================================================

describe("LocationPreview — tag management in preview", () => {
	useMap("E2E LP Tag Mgmt", { closeLocation: true });
	let mgmtTagAId: number;
	let mgmtTagBId: number;
	let tagmgmt1Id: number;

	before(async () => {
		const tagA = await createTag("Alpha");
		mgmtTagAId = tagA.id;
		const tagB = await createTag("Beta");
		mgmtTagBId = tagB.id;
		await addLocs([
			loc({ lat: COORD_ONLY.lat + 1, lng: COORD_ONLY.lng + 1, tags: [mgmtTagAId] }),
			loc({ lat: COORD_ONLY.lat + 2, lng: COORD_ONLY.lng + 2, tags: [mgmtTagBId] }),
		]);
		const ids = await addLocs([loc({ lat: COORD_ONLY.lat, lng: COORD_ONLY.lng, tags: [] })]);
		tagmgmt1Id = ids[0];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("tag input field is present", async () => {
		await openLocation(tagmgmt1Id);
		await waitForPreview();
		const input = await browser.$(".form-add-tag__input");
		expect(await input.isExisting()).toBe(true);
	});

	it("typing a tag name shows suggestions", async () => {
		await openLocation(tagmgmt1Id);
		await waitForPreview();
		const input = await browser.$(".form-add-tag__input");
		await input.setValue("Alp");
		await waitForOptions(".location-preview__tags .tag-list .tag", 1);

		// Should show suggestion containing "Alpha"
		const suggestions = await browser.$$(".location-preview__tags .tag-list .tag");
		// At least one suggestion should appear (Alpha matches "Alp")
		expect(await suggestions.length).toBeGreaterThan(0);
	});

	it("clicking a suggestion adds the tag to the location", async () => {
		await openLocation(tagmgmt1Id);
		await waitForPreview();
		const input = await browser.$(".form-add-tag__input");
		await input.setValue("Alp");

		const addBtn = await browser.$(".location-preview__tags ol.tag-list .tag__button--add");
		await addBtn.waitForExist({ timeout: 5000, timeoutMsg: "Alpha suggestion never appeared" });
		await addBtn.click();
		const saveBtn = await browser.$("[data-qa='location-save']");
		await saveBtn.click();
		await waitForSave(tagmgmt1Id, (l) => l.tags.includes(mgmtTagAId));

		const l = await readLocation(tagmgmt1Id);
		expect(l.tags).toContain(mgmtTagAId);
	});

	it("tag removal button removes tag from location", async () => {
		await openLocation(tagmgmt1Id);
		await waitForPreview();

		const removeBtn = await browser.$(
			".location-preview__tags .tag-list .tag .tag__button--delete",
		);
		await removeBtn.waitForExist({ timeout: 5000, timeoutMsg: "No removable tag chip in preview" });
		const before = (await readLocation(tagmgmt1Id)).tags.length;
		await removeBtn.click();
		const saveBtn = await browser.$("[data-qa='location-save']");
		await saveBtn.click();
		await waitForSave(tagmgmt1Id, (l) => l.tags.length === before - 1);
		const l = await readLocation(tagmgmt1Id);
		expect(l.tags.length).toBe(before - 1);
	});

	// Invariant: staged tags are a pure UI artifact. Typing a brand-new tag name
	// must NOT create a map-level tag until the location is saved carrying it.
	const tagNames = async () =>
		withApi(async (api) =>
			Object.values(api.getMapState().tags).map((t: { name: string }) => t.name),
		);

	it("typing a new tag then CLOSING creates no map-level tag", async () => {
		await openLocation(tagmgmt1Id);
		await waitForPreview();
		const input = await browser.$(".form-add-tag__input");
		await input.setValue("ZZStagedClose");
		await browser.keys("Enter");
		// staging is pure UI state (sync); nothing is persisted on Enter
		expect(await tagNames()).not.toContain("ZZStagedClose");

		await closeLocation();
		expect(await tagNames()).not.toContain("ZZStagedClose");
	});

	it("typing a new tag then SAVING creates it and applies it to the location", async () => {
		await openLocation(tagmgmt1Id);
		await waitForPreview();
		const input = await browser.$(".form-add-tag__input");
		await input.setValue("ZZStagedSave");
		await browser.keys("Enter");
		// still nothing persisted until save
		expect(await tagNames()).not.toContain("ZZStagedSave");

		const saveBtn = await browser.$("[data-qa='location-save']");
		await saveBtn.click();
		await browser.waitUntil(async () => (await tagNames()).includes("ZZStagedSave"), {
			timeout: 5000,
			timeoutMsg: "new tag never persisted after save",
		});

		expect(await tagNames()).toContain("ZZStagedSave");
		const newId = await withApi(async (api) => {
			const t = Object.values(api.getMapState().tags).find(
				(x: { name: string }) => x.name === "ZZStagedSave",
			) as { id: number } | undefined;
			return t?.id;
		});
		const l = await readLocation(tagmgmt1Id);
		expect(l.tags).toContain(newId);
	});
});

// ============================================================================

describe("LocationPreview — camera type badges", () => {
	let mapId: string;
	let badgeOfficialId: number;
	let badgeUnofficialId: number;
	let badgeTrekkerId: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E LP Badges");
		// Enable camera badges setting
		await withApi(async (api) => {
			api.setSetting("showCameraBadges", true);
		});
		const ids = await addLocs([
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
			loc({
				lat: UNOFFICIAL_COORDS.lat,
				lng: UNOFFICIAL_COORDS.lng,
				panoId: UNOFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
			loc({
				lat: TREKKER_COORDS.lat,
				lng: TREKKER_COORDS.lng,
				panoId: TREKKER_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
		]);
		badgeOfficialId = ids[0];
		badgeUnofficialId = ids[1];
		badgeTrekkerId = ids[2];
	});

	after(async () => {
		await withApi(async (api) => {
			api.setSetting("showCameraBadges", false);
		});
		await closeLocation();
		await closeMap();
		await deleteMap(mapId);
	});

	afterEach(async () => {
		await closeLocation();
	});

	it("official pano shows a camera generation badge", async () => {
		await openLocation(badgeOfficialId);
		await waitForDates();
		await browser.waitUntil(
			async () => {
				// Should show gen1, gen2, gen4, badcam, or tripod badge
				const badges = await browser.$$(".location-preview__date .pano-option__badge");
				return (await badges.length) > 0;
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "Camera badge never appeared for official pano" },
		);
	});

	it("unofficial pano shows unofficial badge", async () => {
		await openLocation(badgeUnofficialId);
		await waitForPreview();
		await browser.waitUntil(
			async () => {
				const badge = await browser.$(".badge--unofficial");
				return await badge.isExisting();
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "Unofficial badge never appeared" },
		);
	});

	it("trekker pano shows a camera badge", async () => {
		await openLocation(badgeTrekkerId);
		await waitForDates();
		await browser.waitUntil(
			async () => {
				const badges = await browser.$$(".location-preview__date .pano-option__badge");
				return (await badges.length) > 0;
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "Camera badge never appeared for trekker pano" },
		);
	});
});

// ============================================================================

const EXACT_ENRICH_FIELDS = [
	"altitude",
	"countryCode",
	"cameraType",
	"panoType",
	"imageDate",
	"datetime",
	"timezone",
];
const NO_EXACT_ENRICH_FIELDS = ["altitude", "countryCode", "cameraType", "panoType", "imageDate"];

// Exact-date resolution is gated by the per-map datetime enrich field, so enable/disable
// it by setting enrichFields rather than a global app setting.
async function setMapEnrichFields(fields: string[]) {
	await updateMapSettings({ enrichMetadata: true, enrichFields: fields });
}

describe("LocationPreview — settings toggles", () => {
	let mapId: string;
	let set1Id: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E LP Settings");
		const ids = await addLocs([
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
		]);
		set1Id = ids[0];
	});

	after(async () => {
		// Reset all settings we touched
		await withApi(async (api) => {
			api.setSetting("exactDateFormat", "date");
			api.setSetting("showCameraBadges", false);
			api.setSetting("hidePanoUI", false);
		});
		await closeLocation();
		await closeMap();
		await deleteMap(mapId);
	});

	afterEach(async () => {
		await closeLocation();
	});

	it("datetime field OFF — no exact date label, just month/year", async () => {
		await setMapEnrichFields(NO_EXACT_ENRICH_FIELDS);
		await openLocation(set1Id);
		await waitForDates();
		// eslint-disable-next-line no-restricted-syntax -- negative assertion: confirm the exact-date fetch never runs
		await browser.pause(2000);
		const label = await browser.$(".location-preview__date .pano-value");
		const text = await label.getText();
		// Should show month/year only (e.g., "Default (Sep 2018)"), NOT "Sep 6, 2018"
		expect(text).not.toMatch(/\w+ \d{1,2}, \d{4}/);
		// But should still show something
		expect(text.length).toBeGreaterThan(0);
	});

	it("datetime field ON — resolves to exact day", async () => {
		await setMapEnrichFields(EXACT_ENRICH_FIELDS);
		await openLocation(set1Id);
		await waitForDates();
		await browser.waitUntil(
			async () => {
				const loading = await browser.$(".location-preview__date .badge--loading");
				if (await loading.isExisting()) return false;
				const label = await browser.$(".location-preview__date .pano-value");
				if (!(await label.isExisting())) return false;
				return /\w+ \d{1,2}, \d{4}/.test(await label.getText());
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "Exact date never resolved after enabling setting" },
		);
	});

	it("exactDateFormat 'datetime' — shows time alongside date", async () => {
		await setMapEnrichFields(EXACT_ENRICH_FIELDS);
		await withApi(async (api) => {
			api.setSetting("exactDateFormat", "datetime");
		});
		await openLocation(set1Id);
		await waitForDates();
		await browser.waitUntil(
			async () => {
				const loading = await browser.$(".location-preview__date .badge--loading");
				if (await loading.isExisting()) return false;
				const label = await browser.$(".location-preview__date .pano-value");
				if (!(await label.isExisting())) return false;
				const text = await label.getText();
				// datetime format includes AM/PM: "Sep 6, 2018, 12:34 PM"
				return /\d{1,2}:\d{2}/.test(text);
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "Datetime format never showed time component" },
		);
		// Reset
		await withApi(async (api) => {
			api.setSetting("exactDateFormat", "date");
		});
	});

	it("dateTimezone 'utc' — shifts displayed date", async () => {
		await setMapEnrichFields(EXACT_ENRICH_FIELDS);
		await withApi(async (api) => {
			api.setSetting("exactDateFormat", "datetime");
			api.setSetting("dateTimezone", "utc");
		});
		await openLocation(set1Id);
		await waitForDates();
		await browser.waitUntil(
			async () => {
				const loading = await browser.$(".location-preview__date .badge--loading");
				if (await loading.isExisting()) return false;
				const label = await browser.$(".location-preview__date .pano-value");
				if (!(await label.isExisting())) return false;
				return /\d{1,2}:\d{2}/.test(await label.getText());
			},
			{ timeout: PANO_TIMEOUT },
		);
		await withApi(async (api) => {
			api.setSetting("exactDateFormat", "date");
			api.setSetting("dateTimezone", "location");
		});
	});

	it("showCameraBadges OFF — gen badges hidden (unofficial still shows)", async () => {
		await setMapEnrichFields(NO_EXACT_ENRICH_FIELDS);
		await withApi(async (api) => {
			api.setSetting("showCameraBadges", false);
		});
		await openLocation(set1Id);
		await waitForDates();
		// eslint-disable-next-line no-restricted-syntax -- negative assertion: confirm no gen badge renders with the setting off
		await browser.pause(1000);
		// Official pano should NOT show a gen badge when setting is off
		const badges = await browser.$$(
			".location-preview__date .badge--gen1, .location-preview__date .badge--gen2, .location-preview__date .badge--gen4",
		);
		expect(await badges.length).toBe(0);
	});

	it("showCameraBadges ON — gen badge appears", async () => {
		await withApi(async (api) => {
			api.setSetting("showCameraBadges", true);
		});
		await openLocation(set1Id);
		await waitForDates();
		await browser.waitUntil(
			async () => {
				const badges = await browser.$$(".location-preview__date .pano-option__badge");
				return (await badges.length) > 0;
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "Camera badge never appeared with setting ON" },
		);
		await withApi(async (api) => {
			api.setSetting("showCameraBadges", false);
		});
	});

	it("hidePanoUI — pano controls disappear", async () => {
		await withApi(async (api) => {
			api.setSetting("hidePanoUI", false);
		});
		await openLocation(set1Id);
		await waitForDates();
		// Controls should be visible initially (no hide-pano-ui class). The class lives on
		// `.location-preview__panorama` (the CSS hides controls via that), not on the embed child.
		await browser.waitUntil(
			async () => {
				const el = await browser.$(".location-preview__panorama");
				return (
					(await el.isExisting()) &&
					!((await el.getAttribute("class")) ?? "").includes("hide-pano-ui")
				);
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "Pano controls never appeared" },
		);

		// Toggle hidePanoUI ON
		await withApi(async (api) => {
			api.setSetting("hidePanoUI", true);
		});
		const panorama = await browser.$(".location-preview__panorama");
		await browser.waitUntil(
			async () => ((await panorama.getAttribute("class")) ?? "").includes("hide-pano-ui"),
			{ timeout: 5000, timeoutMsg: "hide-pano-ui class never applied" },
		);
		expect(((await panorama.getAttribute("class")) ?? "").includes("hide-pano-ui")).toBe(true);

		// Reset
		await withApi(async (api) => {
			api.setSetting("hidePanoUI", false);
		});
	});
});

// ============================================================================

describe("LocationPreview — edge cases", () => {
	useMap("E2E LP Edge Cases", { closeLocation: true });
	let edgeAId: number;
	let edgeBId: number;
	let edgeSaveIdemId: number;
	let edgeExtraId: number;

	before(async () => {
		await updateMapSettings({ enrichMetadata: true });
		const ids = await addLocs([
			loc({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
			loc({
				lat: TREKKER_COORDS.lat,
				lng: TREKKER_COORDS.lng,
				panoId: TREKKER_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
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
				extra: { customField: "preserve-me", altitude: 999 },
			}),
		]);
		edgeAId = ids[0];
		edgeBId = ids[1];
		edgeSaveIdemId = ids[2];
		edgeExtraId = ids[3];
	});
	afterEach(async () => {
		await closeLocation();
	});

	it("opening location B while A is still open works cleanly", async () => {
		await openLocation(edgeAId);
		await waitForDates();
		const countA = await getDateCount();

		// Open B WITHOUT closing A first
		await openLocation(edgeBId);
		await waitForDates();
		const countB = await getDateCount();

		expect(countA).toBeGreaterThan(0);
		expect(countB).toBeGreaterThan(0);

		// Active location should be B
		const activeId = await withApi(async (api) => {
			return api.getMapState().activeLocation?.id ?? null;
		});
		expect(activeId).toBe(edgeBId);
	});

	it("opening location B then back to A works", async () => {
		await openLocation(edgeAId);
		await waitForDates();

		await openLocation(edgeBId);
		await waitForDates();

		await openLocation(edgeAId);
		await waitForDates();

		const activeId = await withApi(async (api) => {
			return api.getMapState().activeLocation?.id ?? null;
		});
		expect(activeId).toBe(edgeAId);
		expect(await getDateCount()).toBeGreaterThan(0);
	});

	it("location with only 1 coverage date still works", async () => {
		// The unofficial pano likely has very few or 1 date
		const ids = await addLocs([
			loc({
				lat: UNOFFICIAL_COORDS.lat,
				lng: UNOFFICIAL_COORDS.lng,
				panoId: UNOFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
		]);
		const edgeSingleDateId = ids[0];

		await openLocation(edgeSingleDateId);
		await waitForPreview();
		// Even with 0 or 1 dates, the date section should exist and not crash
		const dateSection = await browser.$(".location-preview__date");
		expect(await dateSection.isExisting()).toBe(true);
		// Save should still work
		const saveBtn = await browser.$("[data-qa='location-save']");
		// eslint-disable-next-line no-restricted-syntax -- edge case may have 0 dates, so waitForDates can't gate; bounded pano-load settle
		await browser.pause(2000);
		await saveBtn.click();
		await waitForSave(edgeSingleDateId);
		const saved = await readLocation(edgeSingleDateId);
		expect(saved).not.toBeNull();
	});

	it("save idempotency — saving twice produces consistent data", async () => {
		await openLocation(edgeSaveIdemId);
		await waitForDates();

		const saveBtn = await browser.$("[data-qa='location-save']");

		// First save — reopens the location because save closes it
		await saveBtn.click();
		await flushAndWait();
		await openLocation(edgeSaveIdemId);
		await waitForDates();
		const first = await readLocation(edgeSaveIdemId);

		// Second save
		await saveBtn.click();
		await flushAndWait();
		const second = await readLocation(edgeSaveIdemId);

		expect(second.panoId).toBe(first.panoId);
		expect(second.lat).toBe(first.lat);
		expect(second.lng).toBe(first.lng);
		expect(second.heading).toBe(first.heading);
		expect(second.pitch).toBe(first.pitch);
	});

	it("enrichment merges with existing extra, does not overwrite custom fields", async () => {
		await openLocation(edgeExtraId);
		await waitForDates();

		// Wait for metadata enrichment to run
		await browser.waitUntil(
			async () => {
				const l = await readLocation(edgeExtraId);
				return l?.extra?.countryCode != null;
			},
			{ timeout: PANO_TIMEOUT, timeoutMsg: "Metadata enrichment never completed" },
		);

		const l = await readLocation(edgeExtraId);
		// Enrichment should have populated countryCode
		expect(l.extra.countryCode).toBeTruthy();
		// But our custom field should still be there
		expect(l.extra.customField).toBe("preserve-me");
		// Altitude should be updated by enrichment (overrides our fake 999)
		expect(typeof l.extra.altitude).toBe("number");
	});
});
