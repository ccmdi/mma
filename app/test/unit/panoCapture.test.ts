// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
	captureLivePano,
	coverCrop,
	frameFingerprint,
	getPanoCanvas,
	snapshotPanoView,
} from "@/lib/sv/panoCapture";
import { clearSingletonPano, singletonDiv } from "@/lib/sv/panoSingleton";
import { getSettings } from "@/store/settings";

function addSceneCanvas(): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.className = "mapsImagerySceneScene__canvas widget-scene-canvas";
	canvas.width = 640;
	canvas.height = 360;
	singletonDiv.appendChild(canvas);
	return canvas;
}

/** jsdom has no rasterizer: hand drawScaled a context whose readback we choose. */
function stubCanvas2d(fill: number | null): () => void {
	const original = HTMLCanvasElement.prototype.getContext;
	HTMLCanvasElement.prototype.getContext = function (type: string) {
		if (type !== "2d") return null;
		return {
			drawImage: () => {},
			getImageData: (_x: number, _y: number, w: number, h: number) => {
				const data = new Uint8ClampedArray(w * h * 4);
				if (fill !== null) for (let i = 0; i < data.length; i++) data[i] = (i * 7 + fill) % 256;
				return { data };
			},
		} as unknown as CanvasRenderingContext2D;
	} as typeof HTMLCanvasElement.prototype.getContext;
	return () => {
		HTMLCanvasElement.prototype.getContext = original;
	};
}

afterEach(() => singletonDiv.replaceChildren());

describe("pano capture", () => {
	it("copies click-time camera state instead of retaining the live POV object", () => {
		const pov = { heading: 123.5, pitch: -7.25 };
		const panorama = {
			getPano: () => "pano-id",
			getPov: () => pov,
			getZoom: () => 2.5,
		} as unknown as google.maps.StreetViewPanorama;

		const snapshot = snapshotPanoView(panorama);
		pov.heading = 250;

		expect(snapshot).toEqual({
			panoId: "pano-id",
			heading: 123.5,
			pitch: -7.25,
			zoom: 2.5,
		});
	});

	it("rejects a viewer without a ready pano or finite camera", () => {
		const panorama = {
			getPano: () => "",
			getPov: () => ({ heading: 0, pitch: 0 }),
			getZoom: () => Number.NaN,
		} as unknown as google.maps.StreetViewPanorama;
		expect(() => snapshotPanoView(panorama)).toThrow("Street View is not ready");
	});

	it("cover-crops to the target aspect, centered and within bounds", () => {
		// Wider than 16:9 source: crop the sides.
		expect(coverCrop(2560, 1080, 1920, 1080)).toEqual({ sx: 320, sy: 0, sw: 1920, sh: 1080 });
		// Taller than 16:9 source: crop top and bottom.
		expect(coverCrop(1920, 1440, 1920, 1080)).toEqual({ sx: 0, sy: 180, sw: 1920, sh: 1080 });
		// Same aspect: no crop, whole source.
		expect(coverCrop(960, 540, 1920, 1080)).toEqual({ sx: 0, sy: 0, sw: 960, sh: 540 });

		const { sx, sy, sw, sh } = coverCrop(1234, 777, 320, 180);
		expect(sw / sh).toBeCloseTo(320 / 180);
		expect(sx).toBeGreaterThanOrEqual(0);
		expect(sy).toBeGreaterThanOrEqual(0);
		expect(sx + sw).toBeLessThanOrEqual(1234);
		expect(sy + sh).toBeLessThanOrEqual(777);
	});

	it("shows the screenshot button by default", () => {
		expect(getSettings().showScreenshotButton).toBe(true);
	});

	it("reads the scene canvas, not whatever canvas happens to come first", () => {
		const foreign = document.createElement("canvas");
		foreign.width = 32;
		foreign.height = 32;
		singletonDiv.appendChild(foreign);
		const scene = addSceneCanvas();
		expect(getPanoCanvas()).toBe(scene);
	});

	it("leaves no dead viewer behind, so the next capture cannot read its canvas", () => {
		addSceneCanvas();
		clearSingletonPano();
		expect(singletonDiv.childElementCount).toBe(0);
		expect(getPanoCanvas()).toBeNull();
	});

	it("refuses a blank readback rather than handing back a black frame", () => {
		addSceneCanvas();
		const restore = stubCanvas2d(null);
		try {
			expect(captureLivePano(320, 180)).toBeNull();
		} finally {
			restore();
		}
	});

	it("returns the frame once the viewer holds imagery", () => {
		addSceneCanvas();
		const restore = stubCanvas2d(3);
		try {
			const out = captureLivePano(320, 180);
			expect(out?.width).toBe(320);
			expect(out?.height).toBe(180);
		} finally {
			restore();
		}
	});

	it("distinguishes blank frames from stable rendered imagery", () => {
		const blank = new Uint8ClampedArray(16);
		const rendered = new Uint8ClampedArray([
			10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
		]);
		expect(frameFingerprint(blank)).toBeNull();
		expect(frameFingerprint(rendered)).toBe(frameFingerprint(rendered.slice()));
	});
});
