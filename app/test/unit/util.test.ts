import { describe, it, expect, vi, afterEach } from "vitest";
import { isFiniteNumber, fovToZoom, compareNatural, bucketize, sortTagsByMode } from "@/lib/util/util";
import { relativeTime } from "@/lib/util/format";
import type { Tag } from "@/bindings.gen";

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

describe("sortTagsByMode", () => {
	const tag = (id: number, name: string, order?: number): Tag => ({ id, name, color: "#000", order });
	const tags = [tag(1, "bravo", 2), tag(2, "alpha", 1), tag(3, "charlie")];
	const counts = { 1: 5, 2: 1, 3: 9 };

	it("default sorts by order, name-tiebreak, without mutating input", () => {
		const input = [...tags];
		expect(sortTagsByMode(input, "default", counts).map((t) => t.id)).toEqual([3, 2, 1]);
		expect(input).toEqual(tags);
	});

	it("name sorts alphabetically", () => {
		expect(sortTagsByMode(tags, "name", counts).map((t) => t.id)).toEqual([2, 1, 3]);
	});

	it("amount sorts by count descending, missing counts last", () => {
		expect(sortTagsByMode(tags, "amount", {})).toEqual(tags);
		expect(sortTagsByMode(tags, "amount", counts).map((t) => t.id)).toEqual([3, 1, 2]);
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

describe("compareNatural", () => {
	it("orders numeric strings by value, not lexically", () => {
		expect(["300", "80", "1000", "9"].sort(compareNatural)).toEqual(["9", "80", "300", "1000"]);
	});

	it("orders embedded-number strings naturally", () => {
		expect(["80 m", "300 m", "9 m"].sort(compareNatural)).toEqual(["9 m", "80 m", "300 m"]);
	});

	it("orders plain strings lexically", () => {
		expect(["gen4", "gen2", "gen1"].sort(compareNatural)).toEqual(["gen1", "gen2", "gen4"]);
	});
});

describe("bucketize", () => {
	it("splits a range into equal-width buckets", () => {
		const b = bucketize([0, 25, 50, 75, 100], 5)!;
		expect(b.count).toBe(5);
		expect(b.bounds[0]).toEqual([0, 20]);
		expect(b.bounds[4][1]).toBe(100);
	});

	it("assigns values to the right bucket and clamps the ends", () => {
		const b = bucketize([0, 100], 10)!;
		expect(b.bucketIndex(0)).toBe(0);
		expect(b.bucketIndex(100)).toBe(9);
		expect(b.bucketIndex(55)).toBe(5);
		expect(b.bucketIndex(-999)).toBe(0);
		expect(b.bucketIndex(999)).toBe(9);
	});

	it("ignores non-finite values", () => {
		const b = bucketize([NaN, 0, Infinity, 10], 2)!;
		expect(b.min).toBe(0);
		expect(b.max).toBe(10);
	});

	it("returns null when there is no spread", () => {
		expect(bucketize([5, 5, 5], 4)).toBeNull();
		expect(bucketize([], 4)).toBeNull();
		expect(bucketize([1, 2, 3], 0)).toBeNull();
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
