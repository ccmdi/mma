import { describe, it, expect, vi, afterEach } from "vitest";
import { isFiniteNumber, fovToZoom } from "@/lib/util/util";
import { relativeTime } from "@/lib/util/format";

describe("isFiniteNumber", () => {
	it("returns true for normal numbers", () => {
		expect(isFiniteNumber(0)).toBe(true);
		expect(isFiniteNumber(42)).toBe(true);
		expect(isFiniteNumber(-3.14)).toBe(true);
	});

	it("returns false for Infinity", () => {
		expect(isFiniteNumber(Infinity)).toBe(false);
		expect(isFiniteNumber(-Infinity)).toBe(false);
	});

	it("returns false for NaN", () => {
		expect(isFiniteNumber(NaN)).toBe(false);
	});

	it("returns false for non-number types", () => {
		expect(isFiniteNumber("42")).toBe(false);
		expect(isFiniteNumber(null)).toBe(false);
		expect(isFiniteNumber(undefined)).toBe(false);
		expect(isFiniteNumber(true)).toBe(false);
		expect(isFiniteNumber({})).toBe(false);
	});
});

describe("fovToZoom", () => {
	it("returns ~1 for 90-degree FOV", () => {
		const z = fovToZoom(90);
		expect(z).toBeCloseTo(1, 0);
	});

	it("higher FOV = lower zoom", () => {
		expect(fovToZoom(120)).toBeLessThan(fovToZoom(90));
	});

	it("lower FOV = higher zoom", () => {
		expect(fovToZoom(45)).toBeGreaterThan(fovToZoom(90));
	});

	it("is monotonically decreasing", () => {
		const fovs = [30, 45, 60, 90, 120];
		const zooms = fovs.map(fovToZoom);
		for (let i = 1; i < zooms.length; i++) {
			expect(zooms[i]).toBeLessThan(zooms[i - 1]);
		}
	});
});

describe("relativeTime", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns 'just now' for timestamps less than a minute ago", () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const recent = new Date(now - 30_000).toISOString();
		expect(relativeTime(recent)).toBe("just now");
	});

	it("returns minutes ago for timestamps under an hour", () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const ago = new Date(now - 5 * 60_000).toISOString();
		expect(relativeTime(ago)).toBe("5m ago");
	});

	it("returns hours ago for timestamps under a day", () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const ago = new Date(now - 3 * 3_600_000).toISOString();
		expect(relativeTime(ago)).toBe("3h ago");
	});

	it("returns days ago for timestamps under 30 days", () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const ago = new Date(now - 7 * 86_400_000).toISOString();
		expect(relativeTime(ago)).toBe("7d ago");
	});

	it("returns formatted date for timestamps over 30 days", () => {
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);
		const old = new Date(now - 60 * 86_400_000).toISOString();
		const result = relativeTime(old);
		expect(result).not.toContain("ago");
		expect(result.length).toBeGreaterThan(3);
	});
});
