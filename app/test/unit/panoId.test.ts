import { describe, it, expect } from "vitest";
import {
	allUnofficial,
	isOfficialPano,
	isUnofficial,
	mergeTimelines,
	newestOfficialPano,
} from "@/lib/sv/panoId";
import type { Pano } from "@/bindings.gen";

describe("isOfficialPano", () => {
	it("recognizes F: prefix as unofficial", () => {
		expect(isOfficialPano("F:CAoSLEFGMVFpcE")).toBe(false);
		expect(isOfficialPano("F:abc")).toBe(false);
	});

	it("recognizes 22-char base64 ending in A as official", () => {
		expect(isOfficialPano("KQ2dSFpRKZZMxJEBc4FhcA")).toBe(true);
	});

	it("recognizes 22-char base64 ending in Q as official", () => {
		expect(isOfficialPano("KQ2dSFpRKZZMxJEBc4FhcQ")).toBe(true);
	});

	it("recognizes 22-char base64 ending in g as official", () => {
		expect(isOfficialPano("KQ2dSFpRKZZMxJEBc4Fhcg")).toBe(true);
	});

	it("recognizes 22-char base64 ending in w as official", () => {
		expect(isOfficialPano("KQ2dSFpRKZZMxJEBc4Fhcw")).toBe(true);
	});

	it("treats unknown format as unofficial", () => {
		expect(isOfficialPano("some-random-pano-id")).toBe(false);
	});

	it("handles empty string as unofficial", () => {
		expect(isOfficialPano("")).toBe(false);
	});
});

describe("newestOfficialPano", () => {
	const off1 = "KQ2dSFpRKZZMxJEBc4FhcA";
	const off2 = "KQ2dSFpRKZZMxJEBc4Fhcw";
	const ugc = "F:CAoSLEFGMVFpcE";

	it("returns null for an empty or all-unofficial timeline", () => {
		expect(newestOfficialPano([])).toBeNull();
		expect(newestOfficialPano([{ panoId: ugc }, { panoId: "junk" }])).toBeNull();
	});

	// Timelines arrive sorted ascending, so the newest official entry is the LAST one —
	// not the first match, and not the last entry when that entry is unofficial.
	it("takes the last official entry, skipping trailing unofficial ones", () => {
		expect(newestOfficialPano([{ panoId: off1 }, { panoId: off2 }])?.panoId).toBe(off2);
		expect(newestOfficialPano([{ panoId: off1 }, { panoId: off2 }, { panoId: ugc }])?.panoId).toBe(off2);
		expect(newestOfficialPano([{ panoId: ugc }, { panoId: off1 }])?.panoId).toBe(off1);
	});

	it("preserves the entry object, not just the id", () => {
		const entry = { panoId: off1, date: new Date(2019, 5) };
		expect(newestOfficialPano([entry])).toBe(entry);
	});
});

describe("isUnofficial", () => {
	const pano = (id: string, attribution: Partial<Pick<Pano, "shortDescription" | "copyright">> = {}) =>
		({ id, shortDescription: "", copyright: "", ...attribution }) as Pano;

	it("long pano ID is unofficial", () => {
		expect(isUnofficial(pano("A".repeat(30)))).toBe(true);
	});

	it("22-char pano ID is official", () => {
		expect(isUnofficial(pano("A".repeat(22)))).toBe(false);
	});

	it("no pano ID is not unofficial", () => {
		expect(isUnofficial(pano(""))).toBe(false);
	});

	it("attribution naming a photographer or a user upload is unofficial", () => {
		expect(isUnofficial(pano("A".repeat(22), { copyright: "Photo by John" }))).toBe(true);
		expect(isUnofficial(pano("A".repeat(22), { shortDescription: "User-uploaded image" }))).toBe(true);
	});

	it("a described user photo is still unofficial", () => {
		expect(
			isUnofficial(pano("A".repeat(22), { shortDescription: "Main Street", copyright: "Photo by John" })),
		).toBe(true);
	});
});

describe("mergeTimelines", () => {
	const pano = (over: Partial<Pano> = {}): Pano => ({ id: "p", time: [], ...over }) as Pano;

	// The date picker merges an all-unofficial stack with nearby official coverage,
	// which carries the multi-year history. Later sources win.
	it("merges timelines with later sources winning, ascending by date", () => {
		const a = pano({ time: [{ panoId: "x", date: "2011-01-01" }] });
		const b = pano({
			time: [
				{ panoId: "x", date: "2022-06-01" },
				{ panoId: "y", date: "2019-05-01" },
			],
		});
		expect(mergeTimelines([a, b])).toEqual([
			{ panoId: "y", date: "2019-05-01" },
			{ panoId: "x", date: "2022-06-01" },
		]);
	});

	it("skips absent sources rather than failing", () => {
		expect(mergeTimelines([null, null])).toEqual([]);
		expect(mergeTimelines([null, pano({ time: [{ panoId: "x", date: "2020-01-01" }] })])).toHaveLength(
			1,
		);
	});
});

describe("allUnofficial", () => {
	it("flags a timeline with no official coverage, which is what triggers the wider search", () => {
		expect(allUnofficial([{ panoId: "F:abc", date: "2020-01-01" }])).toBe(true);
		expect(allUnofficial([{ panoId: "-zrYsLR4Fh-cfJG_EMZ1-A", date: "2020-01-01" }])).toBe(false);
	});

	it("counts an empty stack as all-unofficial, since unofficial panos often carry none", () => {
		expect(allUnofficial([])).toBe(true);
	});
});
