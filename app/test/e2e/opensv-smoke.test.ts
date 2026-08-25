/**
 * opensv smoke test - exercises all major google.maps code paths, asserts no
 * uncaught errors hit the console, and asserts every pano type actually renders
 * imagery into the viewer canvas (a failed tile fetch is silent: no JS error,
 * just a blank pano). Regression gate for stripping or patching the opensv bundle.
 *
 * Requires real Street View (NOT --mock):
 *   npx wdio run wdio.conf.ts --spec test/e2e/opensv-smoke.test.ts
 *
 * Via Docker (no --mock flag):
 *   bash scripts/e2e.sh test/e2e/opensv-smoke.test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	openLocation,
	closeLocation,
	createLocation,
} from "./helpers";
import type { Location } from "@/bindings.gen";
import { LocationFlag } from "@/types";

const OFFICIAL_PANO = "-zrYsLR4Fh-cfJG_EMZ1-A";
const OFFICIAL_COORDS = { lat: 52.10947502806108, lng: 34.90131410856584 };
const UNOFFICIAL_PANO = "CAoSF0NJSE0wb2dLRUlDQWdJQ3FpZG1xM3dF";
const UNOFFICIAL_COORDS = { lat: 64.44241333767505, lng: 46.193924009405855 };
// Same photosphere family, raw (unwrapped) ID form. Tiles come from lh3 via svtile.
const UNOFFICIAL_RAW_PANO = "CIHM0ogKEICAgIDO6dWW5wE";
const UNOFFICIAL_RAW_COORDS = { lat: 25.12008481574843, lng: 47.64373429747238 };
const TREKKER_PANO = "5upMz1_zTGPdkIXG6_QM3g";
const TREKKER_COORDS = { lat: 55.510656, lng: 157.636627 };
const TIMES_SQUARE = { lat: 40.758, lng: -73.9855 };

const PANO_RENDER_TIMEOUT = 30_000;

function loc(overrides: Partial<Location> = {}): Location {
	return createLocation({ lat: 0, lng: 0, ...overrides });
}

type ConsoleError = { message: string; source: string };

async function installErrorCapture() {
	await browser.execute(() => {
		const w = window as unknown as {
			__opensvErrors: ConsoleError[];
			__opensvCapInstalled?: boolean;
		};
		if (w.__opensvCapInstalled) return;
		w.__opensvCapInstalled = true;
		w.__opensvErrors = [];
		window.addEventListener("error", (e) => {
			w.__opensvErrors.push({
				message: e.message || String(e),
				source: e.filename || "unknown",
			});
		});
		window.addEventListener("unhandledrejection", (e) => {
			const msg = e.reason?.message || e.reason?.toString?.() || String(e.reason);
			w.__opensvErrors.push({ message: msg, source: "unhandledrejection" });
		});
	});
}

async function drainErrors(): Promise<ConsoleError[]> {
	return browser.execute(() => {
		const w = window as unknown as { __opensvErrors: ConsoleError[] };
		const errs = w.__opensvErrors || [];
		w.__opensvErrors = [];
		return errs;
	});
}

function isOpensvError(e: ConsoleError): boolean {
	if (e.source.includes("blob:")) return true;
	if (e.message.includes("opensv")) return true;
	if (/\.substr|\.A\(\)|google\.maps/.test(e.message)) return true;
	return false;
}

/** Hash of the live viewer canvas, or null while it is blank or a solid fill. */
async function panoFingerprint(): Promise<number | null> {
	return browser.execute(() => {
		const canvas = document.querySelector<HTMLCanvasElement>(
			".location-preview canvas.widget-scene-canvas",
		);
		if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
		const sample = document.createElement("canvas");
		sample.width = 64;
		sample.height = 36;
		const ctx = sample.getContext("2d", { willReadFrequently: true });
		if (!ctx) return null;
		ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
		const px = ctx.getImageData(0, 0, sample.width, sample.height).data;
		let hash = 2166136261;
		let min = 255;
		let max = 0;
		let visible = 0;
		for (let i = 0; i < px.length; i += 4) {
			if (px[i + 3] > 0) visible++;
			min = Math.min(min, px[i], px[i + 1], px[i + 2]);
			max = Math.max(max, px[i], px[i + 1], px[i + 2]);
			hash = Math.imul(hash ^ px[i], 16777619);
			hash = Math.imul(hash ^ px[i + 1], 16777619);
			hash = Math.imul(hash ^ px[i + 2], 16777619);
		}
		return visible > px.length / 8 && max - min > 4 ? hash >>> 0 : null;
	});
}

let lastFingerprint: number | null = null;

/** Wait until the live viewer shows real imagery that differs from the last pano
 *  this helper accepted, so a frame left over from the previous pano never passes. */
async function waitForPanoRender(label: string) {
	await browser.waitUntil(
		async () => {
			const fp = await panoFingerprint();
			if (fp === null || fp === lastFingerprint) return false;
			lastFingerprint = fp;
			return true;
		},
		{
			timeout: PANO_RENDER_TIMEOUT,
			timeoutMsg: `${label}: pano canvas never rendered new imagery`,
		},
	);
}

/** Nudge the map camera and resolve once its tiles have loaded. */
async function moveMapAndWaitForTiles(fn: (map: any) => void): Promise<boolean> {
	return browser.executeAsync((fnSrc: string, done: (r: boolean) => void) => {
		const map = (window as any).MMA.getGoogleMap();
		if (!map) return done(false);
		(window as any).google.maps.event.addListenerOnce(map, "tilesloaded", () => done(true));
		new Function("map", `(${fnSrc})(map)`)(map);
		setTimeout(() => done(false), 8000);
	}, fn.toString());
}

describe("opensv smoke", function () {
	if (process.env.MMA_TEST_MOCK_SV) {
		it("skipped (requires real SV, not --mock)", () => {});
		return;
	}
	let mapId: string;

	before(async () => {
		await waitForReady();
		await installErrorCapture();
		mapId = await createAndOpenMap("opensv-smoke");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	afterEach(async () => {
		const errors = await drainErrors();
		const opensvErrors = errors.filter(isOpensvError);
		if (opensvErrors.length > 0) {
			const summary = opensvErrors.map((e) => `  ${e.message} [${e.source}]`).join("\n");
			throw new Error(`opensv errors detected:\n${summary}`);
		}
	});

	it("should load an official pano by ID", async () => {
		const ids = await addLocs([
			loc({
				...OFFICIAL_COORDS,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
				heading: 90,
				pitch: 0,
				zoom: 0,
			}),
		]);
		await openLocation(ids[0]);
		await waitForPanoRender("official");
		await closeLocation();
	});

	it("should load an unofficial pano by ID", async () => {
		const ids = await addLocs([
			loc({
				...UNOFFICIAL_COORDS,
				panoId: UNOFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
				heading: 0,
				pitch: 0,
				zoom: 0,
			}),
		]);
		await openLocation(ids[0]);
		await waitForPanoRender("unofficial");
		await closeLocation();
	});

	it("should load an unofficial pano by raw ID", async () => {
		const ids = await addLocs([
			loc({
				...UNOFFICIAL_RAW_COORDS,
				panoId: UNOFFICIAL_RAW_PANO,
				flags: LocationFlag.LoadAsPanoId,
				heading: 0,
				pitch: 0,
				zoom: 0,
			}),
		]);
		await openLocation(ids[0]);
		await waitForPanoRender("unofficial raw");
		await closeLocation();
	});

	it("should load a trekker pano by ID", async () => {
		const ids = await addLocs([
			loc({
				...TREKKER_COORDS,
				panoId: TREKKER_PANO,
				flags: LocationFlag.LoadAsPanoId,
				heading: 180,
				pitch: 0,
				zoom: 0,
			}),
		]);
		await openLocation(ids[0]);
		await waitForPanoRender("trekker");
		await closeLocation();
	});

	it("should resolve a coord-only location via SV service", async () => {
		const ids = await addLocs([loc({ ...TIMES_SQUARE, heading: 0, pitch: 0, zoom: 0 })]);
		await openLocation(ids[0]);
		await waitForPanoRender("coord-only");
		await closeLocation();
	});

	it("should survive rapid pano switching", async () => {
		const locs = [
			loc({ ...OFFICIAL_COORDS, panoId: OFFICIAL_PANO, flags: LocationFlag.LoadAsPanoId, heading: 90 }),
			loc({ ...TREKKER_COORDS, panoId: TREKKER_PANO, flags: LocationFlag.LoadAsPanoId, heading: 180 }),
			loc({ ...OFFICIAL_COORDS, panoId: OFFICIAL_PANO, flags: LocationFlag.LoadAsPanoId, heading: 270 }),
		];
		const ids = await addLocs(locs);
		for (const id of ids) await openLocation(id);
		await waitForPanoRender("rapid switch");
		await closeLocation();
	});

	it("should survive switching between official and unofficial", async () => {
		const locs = [
			loc({ ...OFFICIAL_COORDS, panoId: OFFICIAL_PANO, flags: LocationFlag.LoadAsPanoId, heading: 0 }),
			loc({ ...UNOFFICIAL_COORDS, panoId: UNOFFICIAL_PANO, flags: LocationFlag.LoadAsPanoId, heading: 0 }),
			loc({ ...OFFICIAL_COORDS, panoId: OFFICIAL_PANO, flags: LocationFlag.LoadAsPanoId, heading: 180 }),
		];
		const ids = await addLocs(locs);
		await openLocation(ids[0]);
		await waitForPanoRender("switch official");
		await openLocation(ids[1]);
		await waitForPanoRender("switch unofficial");
		await openLocation(ids[2]);
		await waitForPanoRender("switch official again");
		await closeLocation();
	});

	it("should handle map zoom and pan without errors", async () => {
		await closeLocation();
		expect(
			await moveMapAndWaitForTiles((map) => {
				map.setZoom(5);
				map.panTo({ lat: 48, lng: 2 });
			}),
		).toBe(true);
		expect(await moveMapAndWaitForTiles((map) => map.setZoom(15))).toBe(true);
	});

	it("should fire tilesloaded on the map", async () => {
		expect(await moveMapAndWaitForTiles((map) => map.setZoom((map.getZoom() || 10) + 1))).toBe(
			true,
		);
	});

	it("should handle StreetViewService.getPanorama lookups", async () => {
		const result = await browser.executeAsync((done: (r: string) => void) => {
			const gm = (window as any).google.maps;
			const svc = new gm.StreetViewService();
			svc.getPanorama(
				{ location: { lat: 48.8566, lng: 2.3522 }, radius: 100 },
				(_data: unknown, status: string) => done(status),
			);
		});
		expect(result).toBe("OK");
	});

	it("should handle negative zoom (wide aspect ratio support)", async () => {
		const ids = await addLocs([
			loc({
				...OFFICIAL_COORDS,
				panoId: OFFICIAL_PANO,
				flags: LocationFlag.LoadAsPanoId,
				heading: 90,
				pitch: 0,
				zoom: -2,
			}),
		]);
		await openLocation(ids[0]);
		await waitForPanoRender("negative zoom");
		await closeLocation();
	});
});
