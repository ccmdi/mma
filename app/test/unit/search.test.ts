import { describe, it, expect, vi } from "vitest";
import { score, matches, search } from "@/lib/search";

describe("score", () => {
	it("empty query matches everything at full score", () => {
		expect(score("", ["anything"])).toBe(1);
		expect(score("   ", ["anything"])).toBe(1);
	});

	it("ranks exact > prefix > word start > substring > subsequence", () => {
		const exact = score("undo", ["undo"]);
		const prefix = score("undo", ["undo last edit"]);
		const wordStart = score("undo", ["redo undo"]);
		const substring = score("undo", ["roundout"]);
		const subsequence = score("uno", ["u n o t"]);
		expect(exact).toBeGreaterThan(prefix);
		expect(prefix).toBeGreaterThan(wordStart);
		expect(wordStart).toBeGreaterThan(substring);
		expect(substring).toBeGreaterThan(subsequence);
		expect(subsequence).toBeGreaterThan(0);
	});

	it("is case- and accent-insensitive both ways", () => {
		expect(score("cote", ["Côte d'Ivoire"])).toBeGreaterThan(0);
		expect(score("CÔTE", ["cote d'ivoire"])).toBeGreaterThan(0);
	});

	it("requires every token to match", () => {
		expect(score("export map", ["Export map data"])).toBeGreaterThan(0);
		expect(score("export nope", ["Export map data"])).toBe(0);
	});

	it("lets tokens land in different texts", () => {
		expect(score("bulk delete", ["Delete locations", "bulk remove"])).toBeGreaterThan(0);
	});

	it("weights the primary text above later ones", () => {
		expect(score("undo", ["undo", "other"])).toBeGreaterThan(score("undo", ["other", "undo"]));
	});

	it("prefers a compact subsequence over a scattered one", () => {
		expect(score("tgm", ["tag manager"])).toBeGreaterThan(score("tgm", ["the great big mess"]));
	});

	it("skips null and undefined texts", () => {
		expect(score("a", [undefined, null, "abc"])).toBeGreaterThan(0);
	});
});

describe("matches", () => {
	it("never subsequence-matches: predicates have no ranking to bury weak hits", () => {
		expect(matches("tgm", "tag manager")).toBe(false);
		expect(matches("tag man", "tag manager")).toBe(true);
	});

	it("is a boolean view of score", () => {
		expect(matches("set", "Settings")).toBe(true);
		expect(matches("xyz", "Settings")).toBe(false);
		expect(matches("", "Settings")).toBe(true);
	});
});

describe("search", () => {
	const items = [
		{ name: "Redo" },
		{ name: "Undo" },
		{ name: "Round outline" },
		{ name: "Zoom in" },
	];

	it("returns ranked matches only", () => {
		expect(search(items, "undo", (i) => [i.name]).map((i) => i.name)).toEqual([
			"Undo",
			"Round outline",
		]);
	});

	it("keeps source order on empty query and on ties", () => {
		expect(search(items, "", (i) => [i.name])).toEqual(items);
		const tied = [{ name: "alpha one" }, { name: "alpha two" }];
		expect(search(tied, "alpha", (i) => [i.name])).toEqual(tied);
	});

	it("folds each items array once for its lifetime", () => {
		const fresh = items.slice();
		const texts = vi.fn((i: { name: string }) => [i.name]);
		search(fresh, "undo", texts);
		search(fresh, "zoom", texts);
		expect(texts).toHaveBeenCalledTimes(fresh.length);
		search(fresh.slice(), "undo", texts);
		expect(texts).toHaveBeenCalledTimes(fresh.length * 2);
	});
});
