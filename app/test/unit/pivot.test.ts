import { describe, it, expect } from "vitest";
import type { Selector } from "@/bindings.gen";
import {
	buildPivot,
	crossCounts,
	stripNa,
	pivotCellValue,
	formatPct,
	resolveBucketCount,
	NA_KEY,
	BUCKET_MIN_DISTINCT,
	BUCKET_FORCE_DISTINCT,
	DEFAULT_BUCKETS,
	type PivotData,
	type PivotMember,
	type PivotRow,
	type ResolvedAxis,
} from "@/plugins/pivot/pivotMath";

function member(key: string): PivotMember {
	return {
		key,
		label: key,
		color: null,
		selector: { type: "Filter", field: "f", test: { op: "eq", value: key } },
		selectable: true,
	};
}

function row(key: string, counts: Record<string, number>): PivotRow {
	return {
		...member(key),
		counts: new Map(Object.entries(counts)),
		total: Object.values(counts).reduce((a, b) => a + b, 0),
	};
}

function pivot(rows: PivotRow[], columns: string[]): PivotData {
	return {
		rows,
		columns: columns.map(member),
		columnTotals: columns.map((c) => rows.reduce((s, r) => s + (r.counts.get(c) ?? 0), 0)),
		numericDistinct: {},
	};
}

describe("stripNa", () => {
	it("removes the N/A column and shrinks row totals", () => {
		const data = pivot([row("a", { x: 6, __na__: 4 }), row("b", { x: 2 })], ["x", NA_KEY]);
		const stripped = stripNa(data);
		expect(stripped.columns.map((c) => c.key)).toEqual(["x"]);
		expect(stripped.columnTotals).toEqual([8]);
		expect(stripped.rows[0].total).toBe(6);
		expect(stripped.rows[1].total).toBe(2);
	});

	it("removes the N/A row and shrinks column totals", () => {
		const data = pivot([row("a", { x: 6, y: 1 }), row(NA_KEY, { x: 2, y: 3 })], ["x", "y"]);
		const stripped = stripNa(data);
		expect(stripped.rows.map((r) => r.key)).toEqual(["a"]);
		expect(stripped.columnTotals).toEqual([6, 1]);
	});

	it("is a no-op without an N/A row or column", () => {
		const data = pivot([row("a", { x: 1 })], ["x"]);
		expect(stripNa(data)).toBe(data);
	});
});

/** A field axis over `values`, one entry per location (null = lacks the field), where a
 *  selector is the set of locations it names. */
function fieldAxis(values: (string | null)[], keys: string[]): ResolvedAxis {
	const tallyIds = (ids: number[]) => {
		const counts = new Map<string, number>();
		let withValue = 0;
		for (const id of ids) {
			const v = values[id];
			if (v == null) continue;
			withValue++;
			counts.set(v, (counts.get(v) ?? 0) + 1);
		}
		return { counts, withValue };
	};
	const members = keys.map((k) => ({
		...member(k),
		selector: {
			type: "Manual",
			locations: values.flatMap((v, id) => ((k === NA_KEY ? v == null : v === k) ? [id] : [])),
		} as Selector,
	}));
	return {
		members,
		sizes: members.map((m) => idsOf(m.selector).length),
		tally: async (s) => tallyIds(idsOf(s)),
		binned: false,
	};
}

function selectionAxis(sets: Record<string, number[]>): ResolvedAxis {
	const members = Object.entries(sets).map(([key, locations]) => ({
		...member(key),
		selector: { type: "Manual", locations } as Selector,
		selectable: false,
	}));
	return {
		members,
		sizes: members.map((m) => idsOf(m.selector).length),
		tally: null,
		binned: false,
	};
}

const idsOf = (s: Selector) => (s.type === "Manual" ? s.locations : []);
const countBoth = async (a: Selector, b: Selector) =>
	idsOf(a).filter((id) => idsOf(b).includes(id)).length;

async function cells(r: ResolvedAxis, c: ResolvedAxis) {
	const cell = await crossCounts(r, c, countBoth);
	return r.members.map((_, ri) => c.members.map((_, ci) => cell(ri, ci)));
}

describe("crossCounts", () => {
	const field = fieldAxis(["x", "y", "x", null, "y", "x"], ["x", "y", NA_KEY]);
	const sels = selectionAxis({ a: [0, 1, 3], b: [2, 3, 4, 5] });

	it("tallies a field column inside each selection row, deriving N/A", async () => {
		expect(await cells(sels, field)).toEqual([
			[1, 1, 1],
			[2, 1, 1],
		]);
	});

	it("a field row against selection columns is the transpose", async () => {
		expect(await cells(field, sels)).toEqual([
			[1, 2],
			[1, 1],
			[1, 1],
		]);
	});

	it("crosses two fields", async () => {
		const other = fieldAxis(["p", "p", "q", "q", null, "p"], ["p", "q", NA_KEY]);
		expect(await cells(field, other)).toEqual([
			[2, 1, 0],
			[1, 0, 1],
			[0, 1, 0],
		]);
	});

	it("intersects two selection axes pairwise", async () => {
		expect(await cells(sels, sels)).toEqual([
			[3, 1],
			[1, 4],
		]);
	});
});

describe("buildPivot", () => {
	it("drops field members with no count against the other axis", async () => {
		const field = fieldAxis(["x", "y", "z"], ["x", "y", "z"]);
		const sels = selectionAxis({ a: [0], b: [1] });
		const data = buildPivot(sels, field, await crossCounts(sels, field, countBoth));
		expect(data.columns.map((c) => c.key)).toEqual(["x", "y"]);
		expect(data.columnTotals).toEqual([1, 1]);
		const flipped = buildPivot(field, sels, await crossCounts(field, sels, countBoth));
		expect(flipped.rows.map((r) => r.key)).toEqual(["x", "y"]);
	});

	it("keeps empty numeric bins and empty selections", async () => {
		const bins = { ...fieldAxis(["x", "y", "z"], ["x", "y", "z"]), binned: true };
		const sels = selectionAxis({ a: [0], empty: [] });
		const data = buildPivot(sels, bins, await crossCounts(sels, bins, countBoth));
		expect(data.columns.map((c) => c.key)).toEqual(["x", "y", "z"]);
		expect(data.rows.map((r) => r.key)).toEqual(["a", "empty"]);
	});

	it("row totals are each row member's size", async () => {
		const field = fieldAxis(["x", "y", "x", null], ["x", "y", NA_KEY]);
		const sels = selectionAxis({ a: [0, 1, 2, 3] });
		const data = buildPivot(field, sels, await crossCounts(field, sels, countBoth));
		expect(data.rows.map((r) => r.total)).toEqual([2, 1, 1]);
	});
});

describe("pivotCellValue", () => {
	// Bucket A: 600 of 1000 in col x; Bucket B: 400 of 1000.
	const data = pivot([row("A", { x: 600, y: 400 }), row("B", { x: 400, y: 600 })], ["x", "y"]);

	it("count mode returns the raw count", () => {
		expect(pivotCellValue(data, data.rows[0], "x", "count")).toBe(600);
	});

	it("rowPct is relative to the row total", () => {
		expect(pivotCellValue(data, data.rows[0], "x", "rowPct")).toBeCloseTo(0.6);
		expect(pivotCellValue(data, data.rows[1], "x", "rowPct")).toBeCloseTo(0.4);
	});

	it("colPct is relative to the column total", () => {
		expect(pivotCellValue(data, data.rows[0], "x", "colPct")).toBeCloseTo(0.6);
		expect(pivotCellValue(data, data.rows[0], "y", "colPct")).toBeCloseTo(0.4);
	});

	it("zero denominators yield 0, not NaN", () => {
		const empty = pivot([row("A", {})], ["x"]);
		expect(pivotCellValue(empty, empty.rows[0], "x", "rowPct")).toBe(0);
		expect(pivotCellValue(empty, empty.rows[0], "x", "colPct")).toBe(0);
	});

	it("percentages recompute against shrunken totals after stripNa", () => {
		const withNa = pivot([row("A", { x: 3, __na__: 7 })], ["x", "__na__"]);
		expect(pivotCellValue(withNa, withNa.rows[0], "x", "rowPct")).toBeCloseTo(0.3);
		const stripped = stripNa(withNa);
		expect(pivotCellValue(stripped, stripped.rows[0], "x", "rowPct")).toBeCloseTo(1);
	});
});

describe("formatPct", () => {
	it("shows one decimal, trimming trailing .0", () => {
		expect(formatPct(0.6)).toBe("60%");
		expect(formatPct(0.123)).toBe("12.3%");
		expect(formatPct(0)).toBe("0%");
		expect(formatPct(1)).toBe("100%");
	});
});

describe("resolveBucketCount", () => {
	it("forces buckets off below the minimum cardinality", () => {
		expect(resolveBucketCount(BUCKET_MIN_DISTINCT - 1, 10)).toBeNull();
		expect(resolveBucketCount(3, null)).toBeNull();
	});

	it("respects the user's choice in the middle range", () => {
		expect(resolveBucketCount(BUCKET_MIN_DISTINCT, null)).toBeNull();
		expect(resolveBucketCount(50, 15)).toBe(15);
		expect(resolveBucketCount(BUCKET_FORCE_DISTINCT - 1, null)).toBeNull();
	});

	it("forces buckets on at high cardinality, defaulting when off was chosen", () => {
		expect(resolveBucketCount(BUCKET_FORCE_DISTINCT, null)).toBe(DEFAULT_BUCKETS);
		expect(resolveBucketCount(5000, 20)).toBe(20);
	});
});
