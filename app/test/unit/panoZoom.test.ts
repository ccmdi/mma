// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { Pano } from "@/lib/sv/pano";

const zoom = Pano.zoomScale;

describe("pano zoom stored/display mapping", () => {
	it("renders unset (0) as fully zoomed out", () => {
		expect(zoom.display(0)).toBe(zoom.range.min);
	});

	it("passes explicit zooms through to display", () => {
		expect(zoom.display(2.5)).toBe(2.5);
		expect(zoom.display(-0.5)).toBe(-0.5);
	});

	it("normalizes the floor back to unset on save", () => {
		expect(zoom.stored(zoom.range.min)).toBe(0);
		expect(zoom.stored(zoom.range.min - 1)).toBe(0);
	});

	it("persists partial negative zooms", () => {
		expect(zoom.stored(-0.5)).toBe(-0.5);
		expect(zoom.stored(1.25)).toBe(1.25);
	});

	it("steps out down the grid to 0, then fully out, never past the floor", () => {
		expect(zoom.out(2)).toBe(1);
		expect(zoom.out(1)).toBe(0);
		expect(zoom.out(0)).toBe(zoom.range.min);
		expect(zoom.out(-1.5)).toBe(zoom.range.min);
		expect(zoom.out(zoom.range.min)).toBe(zoom.range.min);
	});

	it("steps in from fully-out back to 0, then up the grid to the max", () => {
		expect(zoom.in(zoom.range.min)).toBe(0);
		expect(zoom.in(-0.5)).toBe(0);
		expect(zoom.in(0)).toBe(1);
		expect(zoom.in(zoom.range.max)).toBe(zoom.range.max);
	});

	it("round-trips: save(display(stored)) is stable", () => {
		for (const stored of [0, -0.5, 1, 4, zoom.range.min]) {
			const normalized = zoom.stored(zoom.display(stored));
			expect(zoom.stored(zoom.display(normalized))).toBe(normalized);
		}
		expect(zoom.stored(zoom.display(0))).toBe(0);
	});
});
