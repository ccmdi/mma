import { describe, it, expect, vi, afterEach } from "vitest";
import {
	fovToZoom,
	compareNatural,
	binNumeric,
	sortTagsByMode,
	tagChipStyle,
	appendTagName,
} from "@/lib/util/util";
import { colorForName } from "@/lib/util/color";
import { relativeTime } from "@/lib/util/format";
import type { Tag } from "@/bindings.gen";

describe("sortTagsByMode", () => {
	const tag = (id: number, name: string, order?: number): Tag => ({
		id,
		name,
		color: "#000",
		order,
	});
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

describe("tagChipStyle", () => {
	const tags: Tag[] = [{ id: 1, name: "Red", color: "#ff0000" }];

	it("uses an existing tag's stored color, matched case-insensitively", () => {
		expect(tagChipStyle("red", tags).backgroundColor).toBe("#ff0000");
	});

	it("falls back to the deterministic colorForName for an unknown name", () => {
		expect(tagChipStyle("Gamma", tags).backgroundColor).toBe(colorForName("Gamma"));
	});
});

describe("appendTagName", () => {
	const tags: Tag[] = [{ id: 1, name: "Urban", color: "#000" }];

	it("appends a brand-new name as typed", () => {
		expect(appendTagName([], "Coastal", tags)).toEqual(["Coastal"]);
	});

	it("normalizes to an existing tag's canonical casing", () => {
		expect(appendTagName([], "urban", tags)).toEqual(["Urban"]);
	});

	it("dedups case-insensitively, returning the original array unchanged", () => {
		const pending = ["Urban"];
		expect(appendTagName(pending, "urban", tags)).toBe(pending);
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

describe("binNumeric (count mode)", () => {
	it("splits a range into equal-width buckets", () => {
		const b = binNumeric([0, 25, 50, 75, 100], { by: "count", n: 5 })!;
		expect(b.count).toBe(5);
		expect(b.bounds[0]).toEqual([0, 20]);
		expect(b.bounds[4][1]).toBe(100);
	});

	it("assigns values to the right bucket and clamps the ends", () => {
		const b = binNumeric([0, 100], { by: "count", n: 10 })!;
		expect(b.bucketIndex(0)).toBe(0);
		expect(b.bucketIndex(100)).toBe(9);
		expect(b.bucketIndex(55)).toBe(5);
		expect(b.bucketIndex(-999)).toBe(0);
		expect(b.bucketIndex(999)).toBe(9);
	});

	it("ignores non-finite values", () => {
		const b = binNumeric([NaN, 0, Infinity, 10], { by: "count", n: 2 })!;
		expect(b.min).toBe(0);
		expect(b.max).toBe(10);
	});

	it("returns null when there is no spread", () => {
		expect(binNumeric([5, 5, 5], { by: "count", n: 4 })).toBeNull();
		expect(binNumeric([], { by: "count", n: 4 })).toBeNull();
		expect(binNumeric([1, 2, 3], { by: "count", n: 0 })).toBeNull();
	});
});

describe("binNumeric (width mode)", () => {
	it("anchors bins at multiples of the width and assigns values", () => {
		const b = binNumeric([84, 1237, 1300], { by: "width", w: 500 })!;
		expect(b.bounds[0]).toEqual([0, 500]);
		expect(b.labels).toContain("1000–1500");
		expect(b.bucketIndex(84)).toBe(0);
		expect(b.bucketIndex(1237)).toBe(b.labels.indexOf("1000–1500"));
	});

	it("handles negatives and a single value (one bin)", () => {
		expect(binNumeric([-10], { by: "width", w: 500 })!.bounds[0]).toEqual([-500, 0]);
		const one = binNumeric([42, 42], { by: "width", w: 100 })!;
		expect(one.count).toBe(1);
		expect(one.bounds[0]).toEqual([0, 100]);
	});

	it("returns null for no finite values or non-positive width", () => {
		expect(binNumeric([NaN, Infinity], { by: "width", w: 10 })).toBeNull();
		expect(binNumeric([1, 2], { by: "width", w: 0 })).toBeNull();
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
