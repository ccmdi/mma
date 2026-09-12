// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { coverCrop, frameFingerprint } from "@/lib/sv/panoCapture";
import { getSettings } from "@/store/settings";

describe("pano capture", () => {
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

	it("distinguishes blank frames from stable rendered imagery", () => {
		const blank = new Uint8ClampedArray(16);
		const rendered = new Uint8ClampedArray([
			10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
		]);
		expect(frameFingerprint(blank)).toBeNull();
		expect(frameFingerprint(rendered)).toBe(frameFingerprint(rendered.slice()));
	});
});
