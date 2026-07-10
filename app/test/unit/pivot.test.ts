import { describe, it, expect } from "vitest";
import {
	stripNa,
	pivotCellValue,
	formatPct,
	resolveBucketCount,
	BUCKET_MIN_DISTINCT,
	BUCKET_FORCE_DISTINCT,
	DEFAULT_BUCKETS,
	type PivotData,
	type PivotRow,
} from "@/plugins/pivot/pivotMath";

function row(label: string, counts: Record<string, number>): PivotRow {
	return {
		label,
		color: [0, 0, 0],
		counts: new Map(Object.entries(counts)),
		total: Object.values(counts).reduce((a, b) => a + b, 0),
	};
}

function pivot(rows: PivotRow[], columns: string[]): PivotData {
	return {
		rows,
		columns,
		columnLabels: [...columns],
		columnTotals: columns.map((c) => rows.reduce((s, r) => s + (r.counts.get(c) ?? 0), 0)),
	};
}

describe("stripNa", () => {
	it("removes the N/A column and shrinks row totals", () => {
		const data = pivot([row("a", { x: 6, __na__: 4 }), row("b", { x: 2 })], ["x", "__na__"]);
		const stripped = stripNa(data);
		expect(stripped.columns).toEqual(["x"]);
		expect(stripped.columnTotals).toEqual([8]);
		expect(stripped.rows[0].total).toBe(6);
		expect(stripped.rows[1].total).toBe(2);
	});

	it("is a no-op without an N/A column", () => {
		const data = pivot([row("a", { x: 1 })], ["x"]);
		expect(stripNa(data)).toBe(data);
	});

	it("keeps columnProps aligned with the remaining columns", () => {
		const data: PivotData = {
			...pivot([row("a", { x: 1, __na__: 2 })], ["x", "__na__"]),
			columnProps: [{ type: "Filter", field: "f", op: "eq", value: "x", value2: null }, null],
		};
		const stripped = stripNa(data);
		expect(stripped.columnProps).toHaveLength(1);
		expect(stripped.columnProps![0]).toMatchObject({ op: "eq", value: "x" });
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
