import type { Selector } from "@/bindings.gen";
import type { RGB } from "@/lib/util/color";
import { localeFormat } from "@/lib/util/format";

/** One row or column: a selection, or one value of a field. */
export interface PivotMember {
	key: string;
	label: string;
	color: RGB | null;
	selector: Selector;
	/** Whether Ctrl+Click adds `selector` as a selection. */
	selectable: boolean;
}

export interface PivotRow extends PivotMember {
	counts: Map<string, number>;
	total: number;
}

export type AxisSide = "rows" | "cols";

export interface PivotData {
	rows: PivotRow[];
	columns: PivotMember[];
	columnTotals: number[];
	/** Distinct raw values of each numeric field axis. */
	numericDistinct: Partial<Record<AxisSide, number>>;
}

export type ValueMode = "count" | "rowPct" | "colPct";

export const NA_KEY = "__na__";

export const BUCKET_MIN_DISTINCT = 10;
export const BUCKET_FORCE_DISTINCT = 100;
export const DEFAULT_BUCKETS = 10;

/** Bucketing policy for numeric fields: few distinct values need no buckets,
 *  too many force them; in between the user's choice (null = off) wins. */
export function resolveBucketCount(distinct: number, chosen: number | null): number | null {
	if (distinct < BUCKET_MIN_DISTINCT) return null;
	if (distinct >= BUCKET_FORCE_DISTINCT) return chosen ?? DEFAULT_BUCKETS;
	return chosen;
}

export interface Tally {
	counts: Map<string, number>;
	withValue: number;
}

/** An axis resolved against the map: its members, each member's location count, and for
 *  a field axis how to count its values inside any selector. */
export interface ResolvedAxis {
	members: PivotMember[];
	sizes: number[];
	tally: ((selector: Selector) => Promise<Tally>) | null;
	binned: boolean;
	numericDistinct?: number;
}

/** Cell counts: a field axis is tallied inside each member of the other axis, and two
 *  selection axes intersect pairwise. */
export async function crossCounts(
	rows: ResolvedAxis,
	cols: ResolvedAxis,
	countBoth: (a: Selector, b: Selector) => Promise<number>,
): Promise<(row: number, col: number) => number> {
	const within = (t: Tally, key: string, size: number) =>
		key === NA_KEY ? size - t.withValue : (t.counts.get(key) ?? 0);
	const colTally = cols.tally;
	if (colTally) {
		const tallies = await Promise.all(rows.members.map((m) => colTally(m.selector)));
		return (ri, ci) => within(tallies[ri], cols.members[ci].key, rows.sizes[ri]);
	}
	const rowTally = rows.tally;
	if (rowTally) {
		const tallies = await Promise.all(cols.members.map((m) => rowTally(m.selector)));
		return (ri, ci) => within(tallies[ci], rows.members[ri].key, cols.sizes[ci]);
	}
	const grid = await Promise.all(
		rows.members.map((r) =>
			Promise.all(cols.members.map((c) => countBoth(r.selector, c.selector))),
		),
	);
	return (ri, ci) => grid[ri][ci];
}

/** A field value no location in the other axis carries is dropped; a numeric bin is
 *  kept so the histogram shows its gaps. */
const prunes = (axis: ResolvedAxis) => axis.tally !== null && !axis.binned;

export function buildPivot(
	rowAxis: ResolvedAxis,
	colAxis: ResolvedAxis,
	cell: (row: number, col: number) => number,
): PivotData {
	let rows: PivotRow[] = rowAxis.members.map((m, ri) => ({
		...m,
		counts: new Map(colAxis.members.map((c, ci) => [c.key, cell(ri, ci)])),
		total: rowAxis.sizes[ri],
	}));
	if (prunes(rowAxis)) rows = rows.filter((r) => [...r.counts.values()].some((v) => v > 0));
	const totalOf = (key: string) => rows.reduce((sum, r) => sum + (r.counts.get(key) ?? 0), 0);
	const columns = prunes(colAxis)
		? colAxis.members.filter((c) => totalOf(c.key) > 0)
		: colAxis.members;
	return {
		rows,
		columns,
		columnTotals: columns.map((c) => totalOf(c.key)),
		numericDistinct: { rows: rowAxis.numericDistinct, cols: colAxis.numericDistinct },
	};
}

/** Drop the N/A row and column, shrinking the totals they fed, so percentages are
 *  relative to locations that actually have the field. */
export function stripNa(data: PivotData): PivotData {
	const naRow = data.rows.find((r) => r.key === NA_KEY);
	const hasNaCol = data.columns.some((c) => c.key === NA_KEY);
	if (!naRow && !hasNaCol) return data;
	const kept = data.columns.flatMap((c, i) => (c.key === NA_KEY ? [] : [i]));
	return {
		...data,
		columns: kept.map((i) => data.columns[i]),
		columnTotals: kept.map(
			(i) => data.columnTotals[i] - (naRow?.counts.get(data.columns[i].key) ?? 0),
		),
		rows: data.rows
			.filter((r) => r !== naRow)
			.map((r) => ({ ...r, total: r.total - (r.counts.get(NA_KEY) ?? 0) })),
	};
}

/** Displayed value for a cell in the given mode (count, or 0..1 fraction). */
export function pivotCellValue(data: PivotData, row: PivotRow, col: string, mode: ValueMode) {
	const v = row.counts.get(col) ?? 0;
	if (mode === "rowPct") return row.total ? v / row.total : 0;
	if (mode === "colPct") {
		const colTotal = data.columnTotals[data.columns.findIndex((c) => c.key === col)];
		return colTotal ? v / colTotal : 0;
	}
	return v;
}

const pctFmt = localeFormat<number>(
	(l) => new Intl.NumberFormat(l, { style: "percent", maximumFractionDigits: 1 }),
);

export function formatPct(x: number): string {
	return pctFmt.format(x);
}
