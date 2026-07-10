import type { SelectionProps } from "@/bindings.gen";

export interface PivotRow {
	label: string;
	color: [number, number, number];
	counts: Map<string, number>;
	total: number;
}

export interface PivotData {
	rows: PivotRow[];
	columns: string[];
	columnLabels: string[];
	columnTotals: number[];
	/** Distinct raw values of the numeric field (absent for non-numeric fields). */
	numericDistinct?: number;
	/** Per-column selection props for header toggling (null = not expressible, e.g. N/A). */
	columnProps?: (SelectionProps | null)[];
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

/** Drop the N/A column and shrink row totals, so percentages are relative to
 *  locations that actually have the field. */
export function stripNa(data: PivotData): PivotData {
	const naIdx = data.columns.indexOf(NA_KEY);
	if (naIdx === -1) return data;
	return {
		...data,
		columns: data.columns.filter((_, i) => i !== naIdx),
		columnLabels: data.columnLabels.filter((_, i) => i !== naIdx),
		columnTotals: data.columnTotals.filter((_, i) => i !== naIdx),
		columnProps: data.columnProps?.filter((_, i) => i !== naIdx),
		rows: data.rows.map((r) => ({ ...r, total: r.total - (r.counts.get(NA_KEY) ?? 0) })),
	};
}

/** Displayed value for a cell in the given mode (count, or 0..1 fraction). */
export function pivotCellValue(data: PivotData, row: PivotRow, col: string, mode: ValueMode) {
	const v = row.counts.get(col) ?? 0;
	if (mode === "rowPct") return row.total ? v / row.total : 0;
	if (mode === "colPct") {
		const colTotal = data.columnTotals[data.columns.indexOf(col)];
		return colTotal ? v / colTotal : 0;
	}
	return v;
}

export function formatPct(x: number): string {
	return `${(x * 100).toFixed(1).replace(/\.0$/, "")}%`;
}
