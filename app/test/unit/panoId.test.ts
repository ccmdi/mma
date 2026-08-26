import { describe, it, expect } from "vitest";
import { isOfficialPano, isUnofficial, newestOfficialPano, panoIdToImageKey, imageKeyToPanoId } from "@/lib/sv/panoId";
import type { Pano } from "@/types";

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
		expect(newestOfficialPano([{ pano: ugc }, { pano: "junk" }])).toBeNull();
	});

	// Timelines arrive sorted ascending, so the newest official entry is the LAST one —
	// not the first match, and not the last entry when that entry is unofficial.
	it("takes the last official entry, skipping trailing unofficial ones", () => {
		expect(newestOfficialPano([{ pano: off1 }, { pano: off2 }])?.pano).toBe(off2);
		expect(newestOfficialPano([{ pano: off1 }, { pano: off2 }, { pano: ugc }])?.pano).toBe(off2);
		expect(newestOfficialPano([{ pano: ugc }, { pano: off1 }])?.pano).toBe(off1);
	});

	it("preserves the entry object, not just the id", () => {
		const entry = { pano: off1, date: new Date(2019, 5) };
		expect(newestOfficialPano([entry])).toBe(entry);
	});
});

describe("isUnofficial", () => {
	const pano = (id: string, attribution: Partial<Pick<Pano, "shortDescription" | "copyright">> = {}) =>
		({ pano: id, shortDescription: "", copyright: "", ...attribution }) as Pano;

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

describe("ImageKey round-trip", () => {
	it("spells a user pano id the way the Maps JS API does, dot padding included", () => {
		// Captured live: the id opensv reports for a Times Square photosphere.
		const id = "CAoSFkNJSE0wb2dLRUlDQWdJREV5TV9hRFE.";
		const [frontend, key] = panoIdToImageKey(id);
		expect(frontend).toBe(10);
		expect(imageKeyToPanoId([frontend, key])).toBe(id);
	});
});
