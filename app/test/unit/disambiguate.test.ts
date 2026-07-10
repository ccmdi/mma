// Ported 1:1 from the Rust reference (disambiguate.test.rs). Exercises the pure
// computeDivergence path and the statistical/labeling helpers — no store needed.

import { describe, it, expect } from "vitest";
import type { Location, ExtraFieldDef } from "@/types";
import {
	computeDivergence,
	soleGroup,
	type DisambiguateResult,
	type FieldDivergence,
	type Labeled,
} from "@/plugins/disambiguate/engine";
import { circularSummary } from "@/plugins/disambiguate/stats";

function loc(heading: number, extra: Record<string, unknown>, tags: number[]): Location {
	return {
		id: 0,
		lat: 0,
		lng: 0,
		heading,
		pitch: 0,
		zoom: 0,
		panoId: null,
		flags: 0,
		tags,
		extra: Object.keys(extra).length > 0 ? extra : null,
		createdAt: "",
		modifiedAt: null,
	} as unknown as Location;
}

function numberDef(): ExtraFieldDef {
	return { type: "number" };
}

function defs(pairs: [string, ExtraFieldDef][]): Record<string, ExtraFieldDef> {
	return Object.fromEntries(pairs);
}

function find(r: DisambiguateResult, key: string): FieldDivergence {
	const f = r.fields.find((x) => x.key === key);
	if (!f) throw new Error(`field ${key} not found`);
	return f;
}

/** Build labeled locations: groups[g] is the list of locations for group g. */
function labeled(groups: Location[][]): Labeled[] {
	const out: Labeled[] = [];
	groups.forEach((locs, group) => locs.forEach((l) => out.push({ group, loc: l })));
	return out;
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

// --- Numeric (linear) -------------------------------------------------------

describe("numeric (linear)", () => {
	it("separated numeric scores high", () => {
		const a = range(12).map((i) => loc(0, { alt: i }, []));
		const b = range(12).map((i) => loc(0, { alt: 1000 + i }, []));
		const r = computeDivergence(labeled([a, b]), 2, defs([["alt", numberDef()]]), {});
		const f = find(r, "alt");
		expect(f.comparison.type).toBe("linear");
		// Two-group epsilon-squared caps at H/(n-1); perfect 12v12 separation = ~0.75.
		expect(f.valueScore!).toBeGreaterThan(0.7);
		expect(f.lowConfidence).toBe(false);
	});

	it("overlapping numeric scores low", () => {
		const a = range(12).map((i) => loc(0, { alt: i % 10 }, []));
		const b = range(12).map((i) => loc(0, { alt: i % 10 }, []));
		const r = computeDivergence(labeled([a, b]), 2, defs([["alt", numberDef()]]), {});
		expect(find(r, "alt").valueScore!).toBeLessThan(0.15);
	});

	it("ranking puts most separating field first", () => {
		const a = range(12).map((i) => loc(0, { alt: i, noise: i % 3 }, []));
		const b = range(12).map((i) => loc(0, { alt: 1000 + i, noise: i % 3 }, []));
		const r = computeDivergence(
			labeled([a, b]),
			2,
			defs([
				["alt", numberDef()],
				["noise", numberDef()],
			]),
			{},
		);
		expect(r.fields[0].key).toBe("alt");
	});
});

// --- Categorical ------------------------------------------------------------

describe("categorical", () => {
	it("separated categorical scores high", () => {
		const a = range(12).map(() => loc(0, { cc: "US" }, []));
		const b = range(12).map(() => loc(0, { cc: "FR" }, []));
		const cc: ExtraFieldDef = { type: "string" };
		const r = computeDivergence(labeled([a, b]), 2, defs([["cc", cc]]), {});
		const f = find(r, "cc");
		expect(f.comparison.type).toBe("categorical");
		expect(f.valueScore!).toBeGreaterThan(0.8);
	});

	it("shared dominant value scores low", () => {
		const mk = () => loc(0, { cam: "gen2" }, []);
		const a = range(12).map(mk);
		const b = range(12).map(mk);
		const cam: ExtraFieldDef = { type: "enum" };
		const r = computeDivergence(labeled([a, b]), 2, defs([["cam", cam]]), {});
		expect(find(r, "cam").valueScore!).toBeLessThan(0.15);
	});
});

// --- Circular ---------------------------------------------------------------

describe("circular", () => {
	it("treats overlapping seam-straddling groups as close", () => {
		// Both groups span the 0/360 seam (~ -5deg..+5deg) and overlap heavily, so they
		// are circularly the same population. A naive linear metric is fooled by the seam
		// (values split into a ~0 cluster and a ~356 cluster) and sees structure.
		const av = [356, 358, 0, 2, 4, 357, 359, 1, 3, 5, 358, 0];
		const bv = [357, 359, 1, 3, 5, 356, 358, 0, 2, 4, 359, 1];
		const a = av.map((h) => loc(h, {}, []));
		const b = bv.map((h) => loc(h, {}, []));
		const r = computeDivergence(labeled([a, b]), 2, {}, {});
		const f = find(r, "heading");
		expect(f.comparison.type === "circular" && f.comparison.period === 360).toBe(true);
		expect(f.valueScore!).toBeLessThan(0.3);
	});

	it("circular summary recovers the true mean across the seam", () => {
		// A tight cluster straddling 0/360: circular mean ~0deg, high concentration.
		// A naive arithmetic mean would land near 144deg (fooled by the seam).
		const { mean, concentration } = circularSummary([358, 359, 0, 1, 2], 360);
		expect(Math.min(mean, 360 - mean)).toBeLessThan(1); // within 1deg of 0/360
		expect(concentration).toBeGreaterThan(0.99);
	});

	it("opposite directions score high", () => {
		const a = range(12).map((i) => loc(i % 5, {}, []));
		const b = range(12).map((i) => loc(178 + (i % 5), {}, []));
		const r = computeDivergence(labeled([a, b]), 2, {}, {});
		expect(find(r, "heading").valueScore!).toBeGreaterThan(0.8);
	});
});

// --- Coverage & missing data ------------------------------------------------

describe("coverage and missing data", () => {
	it("coverage asymmetry is flagged", () => {
		const a = range(12).map((i) => loc(0, { alt: i }, []));
		const b = range(12).map(() => loc(0, {}, []));
		const r = computeDivergence(labeled([a, b]), 2, defs([["alt", numberDef()]]), {});
		const f = find(r, "alt");
		expect(f.coverageScore).toBeGreaterThan(0.8);
		expect(f.valueScore).toBeNull();
	});

	it("missing values not treated as zero", () => {
		const a = range(12).map(() => loc(0, { alt: 5 }, []));
		const b = [
			...range(3).map(() => loc(0, { alt: 5 }, [])),
			...range(9).map(() => loc(0, {}, [])),
		];
		const r = computeDivergence(labeled([a, b]), 2, defs([["alt", numberDef()]]), {});
		const f = find(r, "alt");
		expect(f.valueScore!).toBeLessThan(0.15);
		expect(f.lowConfidence).toBe(true);
		expect(f.coverageScore).toBeGreaterThan(0.5);
	});
});

// --- Tags -------------------------------------------------------------------

describe("tags", () => {
	it("discriminating tag scores high", () => {
		const a = range(12).map(() => loc(0, {}, [7]));
		const b = range(12).map(() => loc(0, {}, []));
		const r = computeDivergence(labeled([a, b]), 2, {}, { 7: "Verified" });
		const f = find(r, "tag:7");
		expect(f.label).toBe("Verified");
		expect(f.valueScore!).toBeGreaterThan(0.8);
		expect(f.coverageScore).toBeLessThan(1e-9);
	});
});

// --- Excluded fields & labeling ---------------------------------------------

describe("excluded fields and labeling", () => {
	it("spatial and timestamp fields never analyzed", () => {
		const a = range(4).map(() => loc(0, {}, []));
		const b = range(4).map(() => loc(0, {}, []));
		const r = computeDivergence(labeled([a, b]), 2, {}, {});
		for (const bad of ["lat", "lng", "createdAt", "modifiedAt"]) {
			expect(r.fields.some((f) => f.key === bad)).toBe(false);
		}
	});

	it("group sizes reflect labels", () => {
		const a = range(5).map(() => loc(0, {}, []));
		const b = range(3).map(() => loc(0, {}, []));
		const r = computeDivergence(labeled([a, b]), 2, {}, {});
		expect(r.groupSizes).toEqual([5, 3]);
	});

	it("soleGroup detects overlap", () => {
		// id 0: only group 0; id 1: groups 0 and 1 (overlap); id 2: none.
		const masks = [new Set([0, 1]), new Set([1])];
		expect(soleGroup(masks, 0)).toBe(0);
		expect(soleGroup(masks, 1)).toBe("overlap");
		expect(soleGroup(masks, 2)).toBeNull();
	});
});

// --- Undeclared field inference ---------------------------------------------

describe("undeclared field inference", () => {
	it("undeclared numeric field treated as linear", () => {
		const a = range(12).map((i) => loc(0, { mystery: i }, []));
		const b = range(12).map((i) => loc(0, { mystery: 1000 + i }, []));
		const r = computeDivergence(labeled([a, b]), 2, {}, {});
		const f = find(r, "mystery");
		expect(f.comparison.type).toBe("linear");
		expect(f.valueScore!).toBeGreaterThan(0.7);
	});
});
