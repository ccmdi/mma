/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	openLocation,
	closeLocation,
	withApi,
	waitForActive,
	waitForWorkArea,
	createLocation,
} from "./helpers";
import type { Location } from "@/bindings.gen";

function loc(overrides: Partial<Location> = {}): Location {
	return createLocation({ lat: 40.758, lng: -73.9855, ...overrides });
}

async function waitForFullscreenMap(on: boolean) {
	await browser.waitUntil(
		async () => {
			const active = await withApi((api) => api.getSettings().fullscreenMap);
			if (active !== on) return false;
			const el = await browser.$(".page-map-editor.fullscreen-map");
			return on ? await el.isExisting() : !(await el.isExisting());
		},
		{ timeout: 5000, timeoutMsg: `fullscreenMap never became ${on}` },
	);
}

async function waitForPanoFullscreen(on: boolean) {
	await browser.waitUntil(
		async () => {
			const pano = await browser.$(".location-preview__panorama.is-fullscreen");
			return on ? await pano.isExisting() : !(await pano.isExisting());
		},
		{ timeout: 5000, timeoutMsg: `pano fullscreen never became ${on}` },
	);
}

describe("Fullscreen map mode", () => {
	let mapId: string;
	let locA: number;
	let locB: number;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Fullscreen Map");
		const ids = await addLocs([
			loc({ lat: 40.758, lng: -73.9855 }),
			loc({ lat: 40.761, lng: -73.978 }),
		]);
		locA = ids[0];
		locB = ids[1];
		await withApi(async (api) => {
			api.setSetting("fullscreenMap", false);
			api.setSetting("showFullscreenMiniLocationPreview", true);
		});
	});

	after(async () => {
		await closeLocation();
		await withApi(async (api) => {
			api.setSetting("fullscreenMap", false);
		});
		await closeMap();
		await deleteMap(mapId);
	});

	afterEach(async () => {
		await closeLocation();
		await withApi(async (api) => api.setSetting("fullscreenMap", false));
	});

	it("enabling fullscreenMap adds the layout class", async () => {
		await withApi(async (api) => api.setSetting("fullscreenMap", true));
		await waitForFullscreenMap(true);
	});

	it("shows mini location preview when a location is open", async () => {
		await withApi(async (api) => api.setSetting("fullscreenMap", true));
		await waitForFullscreenMap(true);
		await openLocation(locA);
		await waitForWorkArea("location");
		const mini = await browser.$(".fullscreen-mini-location");
		await mini.waitForExist({ timeout: 5000 });
	});

	it("pano fullscreen (f) suspends fullscreen map and can be restored after delete", async () => {
		await withApi(async (api) => api.setSetting("fullscreenMap", true));
		await waitForFullscreenMap(true);
		await openLocation(locA);
		await waitForWorkArea("location");

		await browser.$("body").click();
		await browser.keys("f");
		await waitForFullscreenMap(false);
		await waitForPanoFullscreen(true);

		await withApi(async (api, id) => api.removeLocations(new Set([id])), locA);
		await waitForActive(null);
		await waitForWorkArea("overview");
		await waitForFullscreenMap(true);
		await waitForPanoFullscreen(false);
	});

	it("switching locations while in pano fullscreen stays in pano fullscreen", async () => {
		const [locC] = await addLocs([loc({ lat: 40.762, lng: -73.977 })]);
		await openLocation(locB);
		await waitForWorkArea("location");

		await browser.$("body").click();
		await browser.keys("f");
		await waitForPanoFullscreen(true);

		await openLocation(locC);
		await waitForActive(locC);
		await waitForWorkArea("location");
		await waitForPanoFullscreen(true);
	});

	it("entering fullscreen map from pano fullscreen restores pano on exit", async () => {
		await openLocation(locB);
		await waitForWorkArea("location");

		await browser.$("body").click();
		await browser.keys("f");
		await waitForPanoFullscreen(true);

		// Use the map-fullscreen hotkey so pano fullscreen is suspended correctly.
		await browser.$("body").click();
		await browser.keys(["Control", "\\"]);
		await waitForFullscreenMap(true);
		await waitForPanoFullscreen(false);

		await browser.keys(["Control", "\\"]);
		await waitForFullscreenMap(false);
		await waitForPanoFullscreen(true);
	});
});
