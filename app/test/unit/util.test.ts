import { describe, it, expect, vi, afterEach } from "vitest";
import {
	fovToZoom,
	compareNatural,
	sortTagsByMode,
	tagColorFor,
	appendTagName,
} from "@/lib/util/util";
import { colorForName } from "@/lib/util/color";
import { relativeTime } from "@/lib/util/format";
import { cycle } from "@/types/util";
import { MOVEMENT_CYCLE } from "@/store/settings";
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
		expect(sortTagsByMode(input, "default", counts).map((t) => t.id)).toEqual([2, 1, 3]);
		expect(input).toEqual(tags);
	});

	it("default sorts unordered tags last, alphabetically among themselves", () => {
		const mixed = [tag(1, "zeta"), tag(2, "beta", 5), tag(3, "alpha")];
		expect(sortTagsByMode(mixed, "default", {}).map((t) => t.id)).toEqual([2, 3, 1]);
	});

	it("name sorts alphabetically", () => {
		expect(sortTagsByMode(tags, "name", counts).map((t) => t.id)).toEqual([2, 1, 3]);
	});

	it("amount sorts by count descending, missing counts last", () => {
		expect(sortTagsByMode(tags, "amount", {})).toEqual(tags);
		expect(sortTagsByMode(tags, "amount", counts).map((t) => t.id)).toEqual([3, 1, 2]);
	});
});

describe("tagColorFor", () => {
	const tags: Tag[] = [{ id: 1, name: "Red", color: "#ff0000" }];

	it("uses an existing tag's stored color, matched case-insensitively", () => {
		expect(tagColorFor("red", tags)).toBe("#ff0000");
	});

	it("falls back to the deterministic colorForName for an unknown name", () => {
		expect(tagColorFor("Gamma", tags)).toBe(colorForName("Gamma"));
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

describe("cycle", () => {
	const items = ["a", "b", "c"];

	it("steps forward and wraps", () => {
		expect(cycle(items, "a")).toBe("b");
		expect(cycle(items, "c")).toBe("a");
	});

	it("steps backward and wraps", () => {
		expect(cycle(items, "b", -1)).toBe("a");
		expect(cycle(items, "a", -1)).toBe("c");
	});

	it("treats an unknown or missing current as sitting before the first item", () => {
		expect(cycle(items, "z")).toBe("a");
		expect(cycle(items, undefined)).toBe("a");
		expect(cycle(items, undefined, -1)).toBe("b");
	});

	it("holds on a single-item list", () => {
		expect(cycle(["only"], "only")).toBe("only");
		expect(cycle(["only"], "only", -1)).toBe("only");
	});

	it("visits every movement mode before repeating", () => {
		const seen = [MOVEMENT_CYCLE[0]];
		for (let i = 0; i < MOVEMENT_CYCLE.length; i++) seen.push(cycle(MOVEMENT_CYCLE, seen[i]));
		expect(seen).toEqual([...MOVEMENT_CYCLE, MOVEMENT_CYCLE[0]]);
	});
});
