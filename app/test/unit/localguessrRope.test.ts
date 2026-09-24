import { describe, expect, it } from "vitest";
import { ropeEase, ropeTension } from "@/plugins/localguessr/gameMap";

describe("result line rope", () => {
	it("stretches with the map up to one zoom level", () => {
		expect(ropeTension(5, 5.8)).toBe(5);
		expect(ropeTension(5, 4.2)).toBe(5);
	});

	it("is dragged along past one zoom level", () => {
		expect(ropeTension(5, 7.5)).toBe(6.5);
		expect(ropeTension(5, 2)).toBe(3);
	});

	it("springs from where it was to exactly where it rests", () => {
		expect(ropeEase(0)).toBeCloseTo(0);
		expect(ropeEase(1)).toBe(1);
		expect(Math.max(...Array.from({ length: 50 }, (_, i) => ropeEase(i / 49)))).toBeGreaterThan(1);
	});
});
