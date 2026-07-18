import { describe, it, expect } from "vitest";
import {
	wgs84ToGcj02,
	gcj02ToWgs84,
	gcj02ToBd09,
	bd09ToGcj02,
	wgs84ToBd09Mc,
	bd09McToWgs84,
	gcj02ToBd09Mc,
	bd09McToGcj02,
	isInChinaBbox,
} from "@/lib/geo/chinaCrs";

describe("chinaCrs", () => {
	it("leaves overseas coords unchanged for GCJ", () => {
		const p: [number, number] = [-73.9857, 40.7484];
		expect(wgs84ToGcj02(p)).toEqual(p);
		expect(gcj02ToWgs84(p)).toEqual(p);
	});

	it("isInChinaBbox gates mainland", () => {
		expect(isInChinaBbox(116.4, 39.9)).toBe(true);
		expect(isInChinaBbox(-0.12, 51.5)).toBe(false);
	});

	it("round-trips WGS84 ↔ GCJ02 near Beijing", () => {
		const wgs: [number, number] = [116.397428, 39.90923];
		const gcj = wgs84ToGcj02(wgs);
		expect(gcj[0]).not.toBeCloseTo(wgs[0], 5);
		const back = gcj02ToWgs84(gcj);
		expect(back[0]).toBeCloseTo(wgs[0], 5);
		expect(back[1]).toBeCloseTo(wgs[1], 5);
	});

	it("round-trips GCJ02 ↔ BD09", () => {
		const gcj: [number, number] = [116.404, 39.915];
		const bd = gcj02ToBd09(gcj);
		const back = bd09ToGcj02(bd);
		expect(back[0]).toBeCloseTo(gcj[0], 5);
		expect(back[1]).toBeCloseTo(gcj[1], 5);
	});

	it("round-trips WGS84 ↔ BD09MC", () => {
		const wgs: [number, number] = [116.397428, 39.90923];
		const mc = wgs84ToBd09Mc(wgs);
		expect(Math.abs(mc[0])).toBeGreaterThan(1e5);
		const back = bd09McToWgs84(mc);
		expect(back[0]).toBeCloseTo(wgs[0], 4);
		expect(back[1]).toBeCloseTo(wgs[1], 4);
	});

	it("round-trips GCJ02 ↔ BD09MC (Google CN ↔ Baidu boundary)", () => {
		const gcj: [number, number] = [116.404, 39.915];
		const mc = gcj02ToBd09Mc(gcj);
		expect(Math.abs(mc[0])).toBeGreaterThan(1e5);
		const back = bd09McToGcj02(mc);
		expect(back[0]).toBeCloseTo(gcj[0], 4);
		expect(back[1]).toBeCloseTo(gcj[1], 4);
	});
});
