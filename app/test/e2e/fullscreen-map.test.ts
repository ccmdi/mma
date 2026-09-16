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
		{ timeoutMsg: `fullscreenMap never became ${on}` },
	);
}

async function waitForPanoFullscreen(on: boolean) {
	await browser.waitUntil(
		async () => {
			const pano = await browser.$(".location-preview__panorama.is-fullscreen");
			return on ? await pano.isExisting() : !(await pano.isExisting());
		},
		{ timeoutMsg: `pano fullscreen never became ${on}` },
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
		await mini.waitForExist();
	});

	// Hover-expand is a transform, not a size change: the SV canvas must keep its
	// drawing buffer (resizing it mid-transition is what stretched the imagery).
	it("expanding the mini preview scales it without resizing the pano canvas", async () => {
		await withApi(async (api) => api.setSetting("fullscreenMap", true));
		await waitForFullscreenMap(true);
		await openLocation(locA);
		await waitForWorkArea("location");

		const chip = await browser.$(".fullscreen-mini-location");
		await chip.waitForExist();

		// The pano widget mounts several canvases; only the scene canvas is the
		// WebGL surface whose drawing buffer must stay put.
		const read = () =>
			browser.execute(() => {
				const el = document.querySelector(".fullscreen-mini-location") as HTMLElement;
				const cv = el.querySelector(".widget-scene-canvas") as HTMLCanvasElement | null;
				return { shown: Math.round(el.getBoundingClientRect().width), buffer: cv?.width ?? 0 };
			});
		await browser.waitUntil(async () => (await read()).buffer > 1, {
			timeoutMsg: "scene canvas never sized",
		});

		const collapsed = await read();
		// Expansion is driven through the component's real onPointerEnter. The bridge
		// does not deliver synthesized mouse movement (clicks and keys work, hover does
		// not), and the event must originate on the chip's own chrome anyway - the pano
		// widget stops propagation, so events on the canvas never reach the handler.
		await browser.execute(() => {
			document
				.querySelector(".fullscreen-mini-location")!
				.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
		});
		await browser.waitUntil(async () => (await read()).shown > collapsed.shown + 20, {
			timeoutMsg: `chip never expanded on hover; collapsed=${JSON.stringify(collapsed)}`,
		});
		const expanded = await read();

		expect(expanded.buffer).toBe(collapsed.buffer);
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

		await withApi(async (api) => api.setSetting("fullscreenMap", true));
		await waitForFullscreenMap(true);
		await waitForPanoFullscreen(false);

		await withApi(async (api) => api.setSetting("fullscreenMap", false));
		await waitForFullscreenMap(false);
		await waitForPanoFullscreen(true);
	});
});
