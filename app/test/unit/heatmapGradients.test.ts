import { describe, it, expect } from "vitest";
import {
	BUILTIN_GRADIENTS,
	DEFAULT_GRADIENT_ID,
	MIN_STOPS,
	addStopAt,
	colorAt,
	evenStops,
	gradientCss,
	gradientIdFromLegacyIndex,
	hexToRgb,
	isBuiltinGradient,
	moveStop,
	newCustomGradient,
	normalizeStops,
	removeStop,
	resolveGradient,
	reverseStops,
	rgbToHex,
	sampleColorRange,
	setStopColor,
	type GradientStop,
	type HeatmapGradient,
	type RGB,
} from "../../../plugins/heatmap/src/gradients";

const blackWhite: GradientStop[] = [
	{ color: [0, 0, 0], pos: 0 },
	{ color: [255, 255, 255], pos: 1 },
];

const custom: HeatmapGradient = { id: "custom-1", name: "Mine", stops: blackWhite };

describe("builtin gradients", () => {
	it("have unique ids", () => {
		const ids = BUILTIN_GRADIENTS.map((g) => g.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("are evenly spaced from 0 to 1", () => {
		for (const g of BUILTIN_GRADIENTS) {
			expect(g.stops[0].pos).toBe(0);
			expect(g.stops[g.stops.length - 1].pos).toBe(1);
		}
	});

	it("default id is the first builtin", () => {
		expect(DEFAULT_GRADIENT_ID).toBe(BUILTIN_GRADIENTS[0].id);
	});

	it("isBuiltinGradient only matches builtins", () => {
		expect(isBuiltinGradient("classic")).toBe(true);
		expect(isBuiltinGradient("custom-1")).toBe(false);
	});
});

describe("gradientIdFromLegacyIndex", () => {
	it("maps a stored index to the builtin at that position", () => {
		BUILTIN_GRADIENTS.forEach((g, i) => {
			expect(gradientIdFromLegacyIndex(i)).toBe(g.id);
		});
	});

	it("falls back to the default for out-of-range or missing indexes", () => {
		expect(gradientIdFromLegacyIndex(BUILTIN_GRADIENTS.length)).toBe(DEFAULT_GRADIENT_ID);
		expect(gradientIdFromLegacyIndex(-1)).toBe(DEFAULT_GRADIENT_ID);
		expect(gradientIdFromLegacyIndex(undefined)).toBe(DEFAULT_GRADIENT_ID);
	});
});

describe("normalizeStops", () => {
	it("spreads 1.1's bare colour list evenly", () => {
		const legacy: RGB[] = [
			[0, 0, 0],
			[10, 10, 10],
			[255, 255, 255],
		];
		expect(normalizeStops(legacy)).toEqual([
			{ color: [0, 0, 0], pos: 0 },
			{ color: [10, 10, 10], pos: 0.5 },
			{ color: [255, 255, 255], pos: 1 },
		]);
	});

	it("keeps positional stops, sorted and clamped", () => {
		const raw = [
			{ color: [1, 1, 1], pos: 2 },
			{ color: [2, 2, 2], pos: -1 },
		];
		expect(normalizeStops(raw)).toEqual([
			{ color: [2, 2, 2], pos: 0 },
			{ color: [1, 1, 1], pos: 1 },
		]);
	});

	it("survives junk", () => {
		expect(normalizeStops(undefined)).toEqual([]);
		expect(normalizeStops([])).toEqual([]);
	});
});

describe("resolveGradient", () => {
	it("resolves builtins and customs", () => {
		expect(resolveGradient("viridis", []).name).toBe("Viridis");
		expect(resolveGradient("custom-1", [custom])).toBe(custom);
	});

	it("falls back to the first builtin when the id is gone", () => {
		// A layer pointing at a deleted custom gradient still renders.
		expect(resolveGradient("custom-1", []).id).toBe(DEFAULT_GRADIENT_ID);
	});
});

describe("colorAt", () => {
	it("clamps outside the ramp", () => {
		expect(colorAt(blackWhite, -1)).toEqual([0, 0, 0]);
		expect(colorAt(blackWhite, 2)).toEqual([255, 255, 255]);
	});

	it("interpolates within a segment", () => {
		expect(colorAt(blackWhite, 0.5)).toEqual([128, 128, 128]);
	});

	it("respects stop positions rather than even spacing", () => {
		const skewed: GradientStop[] = [
			{ color: [0, 0, 0], pos: 0 },
			{ color: [255, 255, 255], pos: 0.25 },
		];
		expect(colorAt(skewed, 0.125)).toEqual([128, 128, 128]);
		expect(colorAt(skewed, 0.5)).toEqual([255, 255, 255]);
	});

	it("handles coincident stops as a hard edge", () => {
		const hard: GradientStop[] = [
			{ color: [0, 0, 0], pos: 0 },
			{ color: [0, 0, 0], pos: 0.5 },
			{ color: [255, 255, 255], pos: 0.5 },
			{ color: [255, 255, 255], pos: 1 },
		];
		expect(colorAt(hard, 0.49)).toEqual([0, 0, 0]);
		expect(colorAt(hard, 0.51)).toEqual([255, 255, 255]);
	});
});

describe("sampleColorRange", () => {
	it("returns n samples spanning the ramp", () => {
		const out = sampleColorRange(blackWhite, 3);
		expect(out).toEqual([
			[0, 0, 0],
			[128, 128, 128],
			[255, 255, 255],
		]);
	});

	it("is dense by default so clustered stops survive the even texture", () => {
		expect(sampleColorRange(blackWhite)).toHaveLength(32);
	});

	it("falls back to the default ramp when there are no stops", () => {
		expect(sampleColorRange([], 4)).toEqual(sampleColorRange(BUILTIN_GRADIENTS[0].stops, 4));
	});
});

describe("gradientCss", () => {
	it("places each stop at its own position", () => {
		expect(
			gradientCss([
				{ color: [0, 0, 0], pos: 0 },
				{ color: [255, 0, 0], pos: 0.25 },
			]),
		).toBe("linear-gradient(to right, rgb(0,0,0) 0%, rgb(255,0,0) 25%)");
	});

	it("renders a single stop flat and an empty ramp transparent", () => {
		expect(gradientCss([{ color: [1, 2, 3], pos: 0 }])).toBe("rgb(1,2,3)");
		expect(gradientCss([])).toBe("transparent");
	});
});

describe("moveStop", () => {
	it("clamps to the track and reports the new index after re-sorting", () => {
		const moved = moveStop(blackWhite, 0, 5);
		expect(moved.stops.map((s) => s.pos)).toEqual([1, 1]);
		expect(moved.stops[moved.index].color).toEqual([0, 0, 0]);
	});

	it("tracks a stop dragged past its neighbour", () => {
		const three = evenStops([
			[0, 0, 0],
			[10, 10, 10],
			[255, 255, 255],
		]);
		const moved = moveStop(three, 0, 0.9);
		expect(moved.index).toBe(1);
		expect(moved.stops[moved.index].color).toEqual([0, 0, 0]);
		expect(moved.stops.map((s) => s.pos)).toEqual([0.5, 0.9, 1]);
	});

	it("leaves the input untouched", () => {
		moveStop(blackWhite, 0, 0.5);
		expect(blackWhite[0].pos).toBe(0);
	});
});

describe("addStopAt", () => {
	it("inserts the colour already at that position, so the ramp does not jump", () => {
		const added = addStopAt(blackWhite, 0.5);
		expect(added.stops).toHaveLength(3);
		expect(added.index).toBe(1);
		expect(added.stops[1]).toEqual({ color: [128, 128, 128], pos: 0.5 });
		expect(sampleColorRange(added.stops, 3)).toEqual(sampleColorRange(blackWhite, 3));
	});
});

describe("removeStop", () => {
	it("removes by index", () => {
		const three = addStopAt(blackWhite, 0.5).stops;
		expect(removeStop(three, 1).map((s) => s.pos)).toEqual([0, 1]);
	});

	it("refuses to drop below the minimum", () => {
		expect(removeStop(blackWhite, 0)).toBe(blackWhite);
		expect(blackWhite).toHaveLength(MIN_STOPS);
	});
});

describe("setStopColor", () => {
	it("replaces one colour and keeps positions", () => {
		const out = setStopColor(blackWhite, 1, [1, 2, 3]);
		expect(out[1]).toEqual({ color: [1, 2, 3], pos: 1 });
		expect(out[0]).toEqual(blackWhite[0]);
	});
});

describe("reverseStops", () => {
	it("mirrors positions, not just order", () => {
		const skewed: GradientStop[] = [
			{ color: [0, 0, 0], pos: 0 },
			{ color: [255, 255, 255], pos: 0.25 },
		];
		expect(reverseStops(skewed)).toEqual([
			{ color: [255, 255, 255], pos: 0.75 },
			{ color: [0, 0, 0], pos: 1 },
		]);
	});
});

describe("hex conversion", () => {
	it("round-trips", () => {
		const colors: RGB[] = [
			[0, 0, 0],
			[255, 255, 255],
			[18, 52, 86],
		];
		for (const c of colors) expect(hexToRgb(rgbToHex(c))).toEqual(c);
	});

	it("pads, clamps, and expands shorthand", () => {
		expect(rgbToHex([1, 2, 3])).toBe("#010203");
		expect(rgbToHex([-5, 300, 128])).toBe("#00ff80");
		expect(hexToRgb("#abc")).toEqual([170, 187, 204]);
	});
});

describe("newCustomGradient", () => {
	it("deep-copies the source stops", () => {
		const copy = newCustomGradient(BUILTIN_GRADIENTS[1]);
		expect(copy.stops).toEqual(BUILTIN_GRADIENTS[1].stops);
		copy.stops[0].color[0] = 999;
		expect(BUILTIN_GRADIENTS[1].stops[0].color[0]).not.toBe(999);
	});

	it("gets a fresh id and a derived name", () => {
		const a = newCustomGradient(custom);
		const b = newCustomGradient(custom);
		expect(a.id).not.toBe(b.id);
		expect(isBuiltinGradient(a.id)).toBe(false);
		expect(a.name).toBe("Mine copy");
	});
});
