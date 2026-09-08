import { describe, it, expect } from "vitest";
import { searchManual } from "@/components/manual/search";
import { MANUAL_INDEX } from "@/components/manual/manual-index.gen";

// Ranking and folding are covered by search.test.ts; this pins the manual-specific parts.
describe("searchManual", () => {
	it("searches a generated index with real chapter text in it", () => {
		expect(MANUAL_INDEX.length).toBeGreaterThan(0);
		expect(MANUAL_INDEX.every((c) => c.id && c.title && c.text.length > 0)).toBe(true);
	});

	it("returns nothing for an empty query rather than every chapter", () => {
		expect(searchManual("")).toEqual([]);
		expect(searchManual("   ")).toEqual([]);
	});

	it("respects the result limit", () => {
		const query = MANUAL_INDEX[0].title;
		expect(searchManual(query, 2).length).toBeLessThanOrEqual(2);
	});

	it("finds a chapter by its own title and carries a snippet", () => {
		const target = MANUAL_INDEX[0];
		const hit = searchManual(target.title).find((h) => h.id === target.id);
		expect(hit).toBeDefined();
		expect(hit!.snippet.length).toBeGreaterThan(0);
	});
});
