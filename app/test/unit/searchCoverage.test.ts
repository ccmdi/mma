import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	stampDisc,
	lngLatToPixel,
	bitmapBounds,
	beginSession,
	growSession,
	addProbe,
	endSession,
	setEnabled,
	hasCoverage,
	getCoverageImage,
	getVersion,
	subscribe,
} from "@/plugins/generator/searchCoverage";

const px = (data: Uint8ClampedArray, w: number, x: number, y: number) => {
	const i = (y * w + x) * 4;
	return [data[i], data[i + 1], data[i + 2], data[i + 3]];
};

describe("stampDisc", () => {
	it("fills pixels inside the radius and leaves the rest transparent", () => {
		const w = 11;
		const h = 11;
		const data = new Uint8ClampedArray(w * h * 4);
		stampDisc(data, w, h, 5, 5, 3, [10, 20, 30]);
		expect(px(data, w, 5, 5)).toEqual([10, 20, 30, 255]); // center, fully covered
		expect(px(data, w, 5, 4)).toEqual([10, 20, 30, 255]); // 1px in, still solid
		expect(px(data, w, 5, 2)[3]).toBeGreaterThan(0); // ~3px out: soft anti-aliased edge
		expect(px(data, w, 5, 2)[3]).toBeLessThan(255);
		expect(px(data, w, 0, 0)).toEqual([0, 0, 0, 0]); // far corner, untouched
	});

	it("is a union, not an accumulation: overlapping stamps stay at alpha 255", () => {
		const w = 11;
		const h = 11;
		const data = new Uint8ClampedArray(w * h * 4);
		stampDisc(data, w, h, 4, 5, 3, [10, 20, 30]);
		stampDisc(data, w, h, 6, 5, 3, [10, 20, 30]); // overlaps the first
		expect(px(data, w, 5, 5)).toEqual([10, 20, 30, 255]); // no darkening / no >255
	});

	it("clips to the buffer and never throws on out-of-bounds centers", () => {
		const w = 8;
		const h = 8;
		const data = new Uint8ClampedArray(w * h * 4);
		expect(() => stampDisc(data, w, h, -2, -2, 4)).not.toThrow();
		expect(px(data, w, 0, 0)[3]).toBe(255); // corner inside the clipped disc
		expect(px(data, w, 7, 7)[3]).toBe(0); // opposite corner untouched
	});
});

describe("lngLatToPixel", () => {
	it("maps NW to the origin and SE to the far corner (y flipped)", () => {
		const b = { west: 0, south: 0, east: 10, north: 10 };
		expect(lngLatToPixel(b, 100, 100, 0, 10)).toEqual([0, 0]); // NW
		expect(lngLatToPixel(b, 100, 100, 10, 0)).toEqual([100, 100]); // SE
		expect(lngLatToPixel(b, 100, 100, 5, 5)).toEqual([50, 50]); // center
	});

	it("keeps counting east across the antimeridian", () => {
		// Session box runs 170 -> -170 (crossing form), 20 degrees wide.
		const b = { west: 170, south: 0, east: -170, north: 10 };
		expect(lngLatToPixel(b, 100, 100, 170, 10)).toEqual([0, 0]);
		expect(lngLatToPixel(b, 100, 100, 180, 5)).toEqual([50, 50]);
		expect(lngLatToPixel(b, 100, 100, -175, 5)[0]).toBe(75);
		expect(lngLatToPixel(b, 100, 100, 160, 5)[0]).toBeGreaterThan(100); // outside, clipped
	});
});

describe("bitmapBounds", () => {
	it("unwraps a seam-crossing box, which deck.gl needs to render anything", () => {
		// BitmapLayer takes [left, bottom, right, top]; the crossing form would put
		// `right` west of `left`.
		expect(bitmapBounds({ west: 170, south: 0, east: -170, north: 10 })).toEqual([170, 0, 190, 10]);
	});

	it("leaves a plain box alone", () => {
		expect(bitmapBounds({ west: 10, south: 0, east: 20, north: 5 })).toEqual([10, 0, 20, 5]);
	});
});

describe("searchCoverage session lifecycle", () => {
	// Fake timers throughout so the throttled flush is deterministic and never leaks
	// a pending timer (module-global) into the next test.
	beforeEach(() => {
		vi.useFakeTimers();
		setEnabled(false);
		endSession();
	});
	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
	});

	const probeCenter = () => addProbe(5, 5);

	it("records probes only while enabled and inside a session", () => {
		probeCenter();
		expect(hasCoverage()).toBe(false); // no session, disabled

		beginSession({ west: 0, south: 0, east: 10, north: 10 }, 500);
		probeCenter();
		expect(hasCoverage()).toBe(false); // session exists but still disabled

		setEnabled(true);
		probeCenter();
		expect(hasCoverage()).toBe(true);
	});

	it("clears on stop (endSession)", () => {
		setEnabled(true);
		beginSession({ west: 0, south: 0, east: 10, north: 10 }, 500);
		probeCenter();
		expect(hasCoverage()).toBe(true);

		endSession();
		expect(hasCoverage()).toBe(false);
		expect(getCoverageImage()).toBeNull();
	});

	it("clears immediately when the toggle is switched off", () => {
		setEnabled(true);
		beginSession({ west: 0, south: 0, east: 10, north: 10 }, 500);
		probeCenter();
		expect(hasCoverage()).toBe(true);

		setEnabled(false);
		expect(hasCoverage()).toBe(false);
	});

	it("ignores degenerate bounds (zero area)", () => {
		setEnabled(true);
		beginSession({ west: 5, south: 5, east: 5, north: 5 }, 500); // west === east
		probeCenter();
		expect(hasCoverage()).toBe(false);
	});

	it("bumps the version and notifies subscribers when probes flush", () => {
		setEnabled(true);
		beginSession({ west: 0, south: 0, east: 10, north: 10 }, 500);
		const before = getVersion();
		let hits = 0;
		const unsub = subscribe(() => hits++);
		probeCenter();
		vi.advanceTimersByTime(200);
		unsub();
		expect(getVersion()).toBeGreaterThan(before);
		expect(hits).toBeGreaterThan(0);
	});
});

// Regions can be added to a run in flight (#149). The texture is sized once at start, so
// without a grow every probe outside the original union is clipped and silently lost.
describe("searchCoverage growSession", () => {
	// The module builds its output through ImageData, which neither node nor jsdom provides.
	class StubImageData {
		data: Uint8ClampedArray;
		width: number;
		height: number;
		constructor(width: number, height: number) {
			this.width = width;
			this.height = height;
			this.data = new Uint8ClampedArray(width * height * 4);
		}
	}

	beforeEach(() => {
		vi.useFakeTimers();
		Object.assign(globalThis, { ImageData: StubImageData });
		setEnabled(false);
		endSession();
		setEnabled(true);
	});
	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		setEnabled(false);
		endSession();
		Reflect.deleteProperty(globalThis, "ImageData");
	});

	const painted = () => {
		const img = getCoverageImage();
		if (!img) return 0;
		let n = 0;
		for (let i = 3; i < img.image.data.length; i += 4) if (img.image.data[i] > 0) n++;
		return n;
	};

	const BOX = { west: 0, south: 0, east: 10, north: 10 };
	const EAST_BOX = { west: 20, south: 0, east: 30, north: 10 };

	it("records probes in ground added after the session began", () => {
		beginSession(BOX, 500);
		addProbe(5, 5);
		const before = painted();
		expect(before).toBeGreaterThan(0);

		addProbe(25, 5); // outside the original box: clipped away
		expect(painted()).toBe(before);

		growSession(EAST_BOX, 500);
		addProbe(25, 5);
		expect(painted()).toBeGreaterThan(before);
	});

	it("keeps what was already drawn", () => {
		beginSession(BOX, 500);
		addProbe(5, 5);
		expect(painted()).toBeGreaterThan(0);

		growSession(EAST_BOX, 500);
		expect(hasCoverage()).toBe(true);
		expect(painted()).toBeGreaterThan(0);
	});

	it("is a no-op when the new bounds are already covered", () => {
		beginSession(BOX, 500);
		addProbe(5, 5);
		const before = painted();

		growSession({ west: 2, south: 2, east: 8, north: 8 }, 500);
		expect(painted()).toBe(before);
	});

	it("starts a session when there is none", () => {
		expect(hasCoverage()).toBe(false);
		growSession(BOX, 500);
		addProbe(5, 5);
		expect(hasCoverage()).toBe(true);
	});
});
