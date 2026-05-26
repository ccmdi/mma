import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	getLocCount,
	withApi,
	createLocation,
	openLocation,
	closeLocation,
} from "./helpers";
import { LocationFlag } from "../../src/types";
import type { SeenEntry } from "../../src/lib/seen/seen.add";

const OFFICIAL_PANO = "-zrYsLR4Fh-cfJG_EMZ1-A";
const OFFICIAL_COORDS = { lat: 52.10947502806108, lng: 34.90131410856584 };

const TREKKER_PANO = "5upMz1_zTGPdkIXG6_QM3g";
const TREKKER_COORDS = { lat: 55.510656, lng: 157.636627 };

const PANO_TIMEOUT = 30_000;

async function waitForPreview() {
	const el = await browser.$(".location-preview");
	await el.waitForExist({ timeout: 5000 });
}

async function waitForPanoReady() {
	await browser.waitUntil(
		async () => {
			const badge = await browser.$(".location-preview__date .badge--number");
			if (!(await badge.isExisting())) return false;
			return parseInt(await badge.getText()) > 0;
		},
		{ timeout: PANO_TIMEOUT, timeoutMsg: "Pano never became ready (dates never populated)" },
	);
}

async function getSeenEntries(limit = 100) {
	return withApi(async (api, lim) => {
		return await api.getSeenEntries(lim);
	}, limit);
}

async function getSeenCount(): Promise<number> {
	return withApi(async (api) => {
		return await api.getSeenCount();
	});
}

async function clearSeen() {
	await withApi(async (api) => {
		await api.clearSeen();
		return "ok";
	});
}

// ============================================================================

describe("Seen -- recording consistency", () => {
	let mapId: string;
	let seenOffId: number;
	let seenTrekId: number;

	before(async () => {
		await waitForReady();
		await withApi((api) => {
			api.setSetting("enableSeen", true);
		});
		mapId = await createAndOpenMap("E2E Seen Recording");
		const ids = await addLocs([
			createLocation({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
			createLocation({
				lat: TREKKER_COORDS.lat,
				lng: TREKKER_COORDS.lng,
				panoId: TREKKER_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
		]);
		seenOffId = ids[0];
		seenTrekId = ids[1];
	});

	after(async () => {
		await closeLocation();
		await closeMap();
		await deleteMap(mapId);
	});

	afterEach(async () => {
		await closeLocation();
	});

	it("opening a location records a seen entry with correct pano_id", async () => {
		await openLocation(seenOffId);
		await waitForPreview();
		await waitForPanoReady();
		// Close to flush the staged entry
		await closeLocation();
		await browser.pause(500);

		const entries = await getSeenEntries(10);
		const recent = entries.find(e => e.panoId === OFFICIAL_PANO);
		expect(recent).toBeTruthy();
	});

	it("recorded lat/lng matches the pano's actual position (not stale)", async () => {
		await openLocation(seenOffId);
		await waitForPreview();
		await waitForPanoReady();
		await closeLocation();
		await browser.pause(500);

		const entries = await getSeenEntries(10);
		const recent = entries.find(e => e.panoId === OFFICIAL_PANO);
		expect(recent).toBeTruthy();
		// lat/lng should be near the official coords, not some stale previous location
		expect(Math.abs(recent!.lat - OFFICIAL_COORDS.lat)).toBeLessThan(1);
		expect(Math.abs(recent!.lng - OFFICIAL_COORDS.lng)).toBeLessThan(1);
	});

	it("switching locations records distinct entries with correct pano_ids", async () => {
		// Open trek first to ensure the singleton pano changes when we open off next
		await openLocation(seenTrekId);
		await waitForPreview();
		await waitForPanoReady();
		await browser.pause(400);

		await clearSeen();

		await openLocation(seenOffId);
		await waitForPreview();
		await waitForPanoReady();
		await browser.pause(400);

		await openLocation(seenTrekId);
		await waitForPreview();
		await waitForPanoReady();
		await browser.pause(400);

		await closeLocation();
		await browser.waitUntil(
			async () => {
				const entries = await getSeenEntries(20);
				return (
					entries.some(e => e.panoId === OFFICIAL_PANO) &&
					entries.some(e => e.panoId === TREKKER_PANO)
				);
			},
			{ timeout: 10000, timeoutMsg: "Expected seen entries for both panos" },
		);

		const count = await getSeenCount();
		expect(count).toBeGreaterThanOrEqual(2);

		const entries = await getSeenEntries(20);
		const offEntry = entries.find(e => e.panoId === OFFICIAL_PANO);
		const trekEntry = entries.find(e => e.panoId === TREKKER_PANO);

		expect(offEntry).toBeTruthy();
		expect(trekEntry).toBeTruthy();

		// Each entry's lat/lng should match its own pano, not the other's
		expect(Math.abs(offEntry!.lat - OFFICIAL_COORDS.lat)).toBeLessThan(1);
		expect(Math.abs(trekEntry!.lat - TREKKER_COORDS.lat)).toBeLessThan(1);
	});

	it("pano_id is never reused across entries with different coordinates", async () => {
		const entries = await getSeenEntries(50);
		const byPano = new Map<string, SeenEntry[]>();
		for (const e of entries) {
			if (!byPano.has(e.panoId)) byPano.set(e.panoId, []);
			byPano.get(e.panoId)!.push(e);
		}
		for (const [, group] of byPano) {
			if (group.length < 2) continue;
			// All entries with the same pano_id should have similar lat/lng
			for (let i = 1; i < group.length; i++) {
				const dist = Math.abs(group[0].lat - group[i].lat) + Math.abs(group[0].lng - group[i].lng);
				expect(dist).toBeLessThan(2);
			}
		}
	});
});

// ============================================================================

describe("Seen -- loadSeenPano opens location viewer", () => {
	let mapId: string;
	let seenLoad1Id: number;

	before(async () => {
		await waitForReady();
		await withApi((api) => {
			api.setSetting("enableSeen", true);
		});
		mapId = await createAndOpenMap("E2E Seen Load");
		const ids = await addLocs([
			createLocation({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
		]);
		seenLoad1Id = ids[0];
	});

	after(async () => {
		await closeLocation();
		await closeMap();
		await deleteMap(mapId);
	});

	afterEach(async () => {
		await closeLocation();
	});

	it("loadSeenPano opens location viewer when no location is active", async () => {
		// Ensure we're on the overview (no location open)
		await closeLocation();
		const areaBefore = await withApi((api) => api.getWorkArea());
		expect(areaBefore).toBe("overview");

		// Create a seen entry and load it
		await withApi(
			(api, pano, lat, lng, locId) => {
				api.loadSeenPano({
					id: 999,
					panoId: pano,
					lat,
					lng,
					heading: 90,
					pitch: 0,
					zoom: 0,
					enteredAt: Date.now(),
					mapId: null,
					locationId: locId,
					countryCode: null,
					address: null,
					thumbnail: null,
				});
			},
			OFFICIAL_PANO,
			OFFICIAL_COORDS.lat,
			OFFICIAL_COORDS.lng,
			seenLoad1Id,
		);

		await browser.pause(500);

		const areaAfter = await withApi((api) => api.getWorkArea());
		expect(areaAfter).toBe("location");
	});

	it("loadSeenPano with unknown location_id creates a new location and opens viewer", async () => {
		await closeLocation();

		const countBefore = await getLocCount();

		// Use a numeric ID that doesn't exist (seen table location_id for a nonexistent location)
		await withApi(
			(api, pano, lat, lng) => {
				api.loadSeenPano({
					id: 998,
					panoId: pano,
					lat,
					lng,
					heading: 45,
					pitch: 5,
					zoom: 1,
					enteredAt: Date.now(),
					mapId: null,
					locationId: 999999,
					countryCode: "RU",
					address: null,
					thumbnail: null,
				});
			},
			OFFICIAL_PANO,
			OFFICIAL_COORDS.lat,
			OFFICIAL_COORDS.lng,
		);

		await browser.waitUntil(
			async () => (await withApi((api) => api.getWorkArea())) === "location",
			{ timeout: 3000, timeoutMsg: "Work area did not switch to location" },
		);

		const countAfter = await getLocCount();
		expect(countAfter).toBe(countBefore + 1);
	});
});

// ============================================================================

describe("Seen -- enableSeen setting", () => {
	let mapId: string;
	let seenSetting1Id: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Seen Setting");
		const ids = await addLocs([
			createLocation({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
		]);
		seenSetting1Id = ids[0];
	});

	after(async () => {
		await withApi((api) => {
			api.setSetting("enableSeen", true);
		});
		await closeLocation();
		await closeMap();
		await deleteMap(mapId);
	});

	afterEach(async () => {
		await closeLocation();
	});

	it("does not record when enableSeen is false", async () => {
		await clearSeen();
		await withApi((api) => {
			api.setSetting("enableSeen", false);
		});

		await openLocation(seenSetting1Id);
		await waitForPreview();
		await waitForPanoReady();
		await closeLocation();
		await browser.pause(500);

		const count = await getSeenCount();
		expect(count).toBe(0);

		// Re-enable for other tests
		await withApi((api) => {
			api.setSetting("enableSeen", true);
		});
	});
});

// ============================================================================

describe("Seen -- clear", () => {
	let mapId: string;
	let seenClearWarmId: number;
	let seenClear1Id: number;

	before(async () => {
		await waitForReady();
		await withApi((api) => {
			api.setSetting("enableSeen", true);
		});
		mapId = await createAndOpenMap("E2E Seen Clear");
		const ids = await addLocs([
			createLocation({
				lat: TREKKER_COORDS.lat,
				lng: TREKKER_COORDS.lng,
				panoId: TREKKER_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
			createLocation({
				lat: OFFICIAL_COORDS.lat,
				lng: OFFICIAL_COORDS.lng,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
			}),
		]);
		seenClearWarmId = ids[0];
		seenClear1Id = ids[1];
	});

	after(async () => {
		await closeLocation();
		await closeMap();
		await deleteMap(mapId);
	});

	afterEach(async () => {
		await closeLocation();
	});

	it("clearSeen removes all entries", async () => {
		// Ensure seen is enabled
		await withApi((api) => {
			api.setSetting("enableSeen", true);
		});

		// Open a different pano first so seen-clear-1 triggers a fresh status_changed
		await openLocation(seenClearWarmId);
		await waitForPreview();
		await waitForPanoReady();
		await browser.pause(400);

		await openLocation(seenClear1Id);
		await waitForPreview();
		await waitForPanoReady();
		await browser.pause(400);
		await closeLocation();

		await browser.waitUntil(async () => (await getSeenCount()) > 0, {
			timeout: 10000,
			timeoutMsg: "Expected at least 1 seen entry after opening location",
		});

		const before = await getSeenCount();
		expect(before).toBeGreaterThan(0);

		await clearSeen();
		const after = await getSeenCount();
		expect(after).toBe(0);
	});
});
