import { useState, useEffect, useCallback, useMemo } from "react";
import type { KeySpec, PartitionBucket, Selection, Selector } from "@/bindings.gen";
import { NSelect } from "@/components/primitives/NSelect";
import { Checkbox } from "@/components/primitives/Checkbox";
import { useDebouncedCallback } from "@/lib/hooks/useDebouncedCallback";
import { selectionDisplayName, buildSelection } from "@/store/selections";
import { savedToSelector, describeRule, type SavedSelection } from "@/store/savedSelections";
import { Sidebar, Field, EmptyState, SegmentedControl } from "@/components/primitives/Sidebar";
import type { ExtraFieldDef } from "@/bindings.gen";
import { getFieldDef } from "@/lib/data/fieldDefRegistry";
import { subscribeMany, LOCATION_DATA_EVENTS } from "@/lib/events";
import { useExtraFieldKeys } from "@/components/editor/map/FilterBuilder";
import { useMapState } from "@/store/useMapStore";
import { compareNatural } from "@/lib/util/util";
import { usePluginState } from "@/plugins/registry";
import {
	stripNa,
	pivotCellValue,
	formatPct,
	resolveBucketCount,
	NA_KEY,
	BUCKET_MIN_DISTINCT,
	BUCKET_FORCE_DISTINCT,
	DEFAULT_BUCKETS,
	type PivotRow,
	type PivotData,
	type ValueMode,
} from "./pivotMath";
import "./pivot.css";

type RowSource = "all" | "active" | string; // "all", "active", or saved selection id

const TAGS_FIELD_KEY = "__tags__";

import type { FieldEntry } from "@/components/editor/map/FilterBuilder";
import { msg, t } from "@/lib/i18n";

async function computePivot(
	rowSource: RowSource,
	fieldKey: string,
	fieldDef: ExtraFieldDef | undefined,
	bucketCount: number | null,
): Promise<PivotData | null> {
	const map = MMA.getMapState().map;
	if (!map) return null;

	// Determine rows + resolve ID sets
	let rowDefs: { label: string; color: [number, number, number] }[];
	let idSets: Set<number>[];

	if (rowSource === "all") {
		const allIds = new Set(await MMA.resolveIds({ type: "Everything" }));
		rowDefs = [{ label: t("All locations"), color: [140, 140, 140] }];
		idSets = [allIds];
	} else if (rowSource === "active") {
		const sels = MMA.getActiveSelections();
		if (sels.length === 0) return null;
		rowDefs = sels.map((s: Selection) => ({
			label: selectionDisplayName(s),
			color: s.color,
		}));
		idSets = await Promise.all(
			sels.map((s: Selection) =>
				MMA.resolveIds(s.selector).then((ids) => new Set(ids)),
			),
		);
	} else {
		const saved: SavedSelection[] = MMA.getSettings().savedSelections;
		const entry = saved.find((s: SavedSelection) => s.id === rowSource);
		if (!entry || entry.items.length === 0) return null;
		const resolvedRows: {
			label: string;
			color: [number, number, number];
			selector: Selector;
		}[] = [];
		for (const item of entry.items) {
			const selector = savedToSelector(item.props);
			if (!selector) continue;
			resolvedRows.push({ label: describeRule(item.props), color: item.color, selector });
		}
		if (resolvedRows.length === 0) return null;
		rowDefs = resolvedRows.map((r) => ({ label: r.label, color: r.color }));
		idSets = await Promise.all(
			parts.map((p) => MMA.resolveIds(p.selector).then((ids) => new Set(ids))),
		);
	}

	const isTags = fieldKey === TAGS_FIELD_KEY;
	const tagMap = MMA.getMapState().tags;
	const isNumeric = !isTags && (fieldDef?.type === "number" || fieldDef?.type === "date");

	// Field index (locId -> group key(s)) comes from the engine: tags from per-tag
	// selectors, everything else from one whole-map groupBy. Numeric fields bucket into
	// a histogram; resolveBucketCount arbitrates between the user's choice and the
	// field's cardinality.
	const fieldIndex = new Map<number, string[]>();
	let numericDistinct: number | undefined;
	let buckets: PartitionBucket[] | null = null;
	if (isTags) {
		await Promise.all(
			Object.keys(tagMap).map(async (tid) => {
				const ids = await MMA.resolveIds({ type: "Tag", tagId: Number(tid) });
				for (const id of ids) {
					const vals = fieldIndex.get(id);
					if (vals) vals.push(tid);
					else fieldIndex.set(id, [tid]);
				}
			}),
		);
	} else {
		if (isNumeric)
			numericDistinct = (await MMA.fieldValues({ type: "Everything" }, fieldKey)).length;
		const effectiveBuckets =
			numericDistinct != null ? resolveBucketCount(numericDistinct, bucketCount) : null;
		const key: KeySpec = effectiveBuckets
			? { kind: "numericBin", binning: { by: "count", n: effectiveBuckets } }
			: { kind: "value" };
		const groups = await MMA.partition(fieldKey, key, { type: "Everything" });
		for (const g of groups) for (const id of g.ids) fieldIndex.set(id, [g.key]);
		if (effectiveBuckets) buckets = groups;
	}

	// Discover columns
	let columns: string[];
	if (buckets) {
		columns = buckets.map((g) => g.key);
	} else if (!isTags && fieldDef?.values && fieldDef.values.length > 0) {
		columns = [...fieldDef.values];
	} else {
		const seen = new Set<string>();
		for (const idSet of idSets) {
			for (const id of idSet) {
				const vals = fieldIndex.get(id);
				if (vals) for (const v of vals) seen.add(v);
			}
		}
		columns = [...seen].sort(compareNatural);
	}

	let hasNa = false;

	const pivotRows: PivotRow[] = rowDefs.map((row, i) => {
		const counts = new Map<string, number>();
		let total = 0;
		let naCount = 0;
		for (const id of idSets[i]) {
			const vals = fieldIndex.get(id);
			if (vals) {
				for (const v of vals) {
					counts.set(v, (counts.get(v) ?? 0) + 1);
				}
				total++;
			} else {
				naCount++;
			}
		}
		if (naCount > 0) {
			counts.set(NA_KEY, naCount);
			hasNa = true;
			total += naCount;
		}
		return { label: row.label, color: row.color, counts, total };
	});

	if (hasNa) columns.push(NA_KEY);

	const columnTotals = columns.map((col) =>
		pivotRows.reduce((sum, r) => sum + (r.counts.get(col) ?? 0), 0),
	);

	const extraLabels = fieldDef?.labels ?? {};
	const columnLabels = columns.map((c) => {
		if (c === NA_KEY) return t("N/A");
		if (isTags) return tagMap[Number(c)]?.name ?? t("Tag {id}", { id: c });
		return extraLabels[c] ?? c;
	});

	// Selection props per column (same shapes gradient emits): tag columns map to Tag
	// selections, buckets to `between` filters, plain values to `eq` filters.
	const columnProps: (Selector | null)[] = columns.map((col, i) => {
		if (col === NA_KEY) return null;
		if (isTags) return { type: "Tag", tagId: Number(col) };
		if (buckets) {
			const bin = buckets[i]?.bin;
			if (!bin) return null;
			return { type: "Filter", field: fieldKey, op: "between", value: bin[0], value2: bin[1] };
		}
		return { type: "Filter", field: fieldKey, op: "eq", value: col, value2: null };
	});

	return { rows: pivotRows, columns, columnLabels, columnTotals, numericDistinct, columnProps };
}

const TAGS_FIELD: FieldEntry = { key: TAGS_FIELD_KEY, label: msg("Tags"), def: { type: "enum" } };

// Fields the map actually carries, with a known definition.
function pivotFields(all: FieldEntry[], knownKeys: ReadonlySet<string>): FieldEntry[] {
	return [TAGS_FIELD, ...all.filter((f) => knownKeys.has(f.key) && getFieldDef(f.key))];
}

function defaultPivotField(fields: FieldEntry[]): string {
	return (fields.find((f) => f.key === "cameraType") ?? fields[0])?.key ?? "";
}

export function PivotSidebar({ onClose }: { onClose: () => void }) {
	const [rowSourceRaw, setRowSource] = usePluginState<RowSource>("pivot", "rowSource", "active");
	// Empty resolves to nothing, so the effective field falls back to the default below.
	const [fieldKeyRaw, setFieldKey] = usePluginState<string>("pivot", "fieldKey", "");
	const [bucketCount, setBucketCount] = usePluginState<number | null>("pivot", "bucketCount", 10);
	const [valueMode, setValueMode] = usePluginState<ValueMode>("pivot", "valueMode", "count");
	const [includeNa, setIncludeNa] = usePluginState<boolean>("pivot", "includeNa", true);
	const [data, setData] = useState<PivotData | null>(null);
	const [loading, setLoading] = useState(false);

	const allFields = useExtraFieldKeys();
	const knownKeys = useMapState((s) => s.knownFieldKeys);
	const fields = useMemo(() => pivotFields(allFields, knownKeys), [allFields, knownKeys]);

	const savedSelections: SavedSelection[] = MMA.getSettings().savedSelections;

	// Persisted values are global; fall back when they don't resolve on this map.
	const rowSource: RowSource =
		rowSourceRaw === "all" ||
		rowSourceRaw === "active" ||
		savedSelections.some((s) => s.id === rowSourceRaw)
			? rowSourceRaw
			: "active";
	const fieldKey = fields.some((f) => f.key === fieldKeyRaw)
		? fieldKeyRaw
		: defaultPivotField(fields);

	const currentDef = fields.find((f) => f.key === fieldKey)?.def;
	const isNumericField = currentDef?.type === "number" || currentDef?.type === "date";

	const recompute = useCallback(async () => {
		if (!fieldKey) return;
		const fieldDef = fields.find((f) => f.key === fieldKey)?.def;
		setLoading(true);
		try {
			const result = await computePivot(rowSource, fieldKey, fieldDef, bucketCount);
			setData(result);
		} finally {
			setLoading(false);
		}
	}, [rowSource, fieldKey, fields, bucketCount]);

	const debouncedRecompute = useDebouncedCallback(() => void recompute(), 150);

	useEffect(() => {
		void recompute();
		const unsubLoc = subscribeMany(LOCATION_DATA_EVENTS, debouncedRecompute);
		const unsubSel = MMA.on("selection:change", debouncedRecompute);
		return () => {
			unsubLoc();
			unsubSel();
		};
	}, [recompute, debouncedRecompute]);

	const hasNa = data?.columns.includes(NA_KEY) ?? false;

	// Cardinality-aware bucketing (mirrors resolveBucketCount in computePivot):
	// few distinct values -> no bucket control at all; too many -> "Off" disabled.
	const distinct = isNumericField ? data?.numericDistinct : undefined;
	const bucketHidden = distinct != null && distinct < BUCKET_MIN_DISTINCT;
	const bucketForced = distinct != null && distinct >= BUCKET_FORCE_DISTINCT;

	const view = useMemo(() => (data && !includeNa ? stripNa(data) : data), [data, includeNa]);

	return (
		<Sidebar title={t("Pivot Table")} onBack={onClose} className="pivot-sidebar" flush>
			<div className="pivot-sidebar__controls">
				<Field label={t("Rows")}>
					<NSelect value={rowSource} onChange={(e) => setRowSource(e.target.value)}>
						<option value="all" className="pivot-sidebar__opt-builtin">
							{t("All locations")}
						</option>
						<option value="active" className="pivot-sidebar__opt-builtin">
							{t("Active selections")}
						</option>
						{savedSelections.map((s) => (
							<option key={s.id} value={s.id}>
								{s.name}
							</option>
						))}
					</NSelect>
				</Field>
				<Field label={t("Column field")}>
					<NSelect value={fieldKey} onChange={(e) => setFieldKey(e.target.value)}>
						{fields.map((f) => (
							<option key={f.key} value={f.key}>
								{t(f.label)}
							</option>
						))}
					</NSelect>
				</Field>
				{isNumericField && !bucketHidden && (
					<Field label={t("Bucket numeric values")}>
						<NSelect
							value={bucketForced ? (bucketCount ?? DEFAULT_BUCKETS) : (bucketCount ?? "off")}
							onChange={(e) =>
								setBucketCount(e.target.value === "off" ? null : Number(e.target.value))
							}
						>
							<option value="off" disabled={bucketForced}>
								{bucketForced ? t("Off (too many values)") : t("Off")}
							</option>
							<option value="5">{t("5 buckets")}</option>
							<option value="10">{t("10 buckets")}</option>
							<option value="15">{t("15 buckets")}</option>
							<option value="20">{t("20 buckets")}</option>
						</NSelect>
					</Field>
				)}
				<Field label={t("Values")}>
					<SegmentedControl<ValueMode>
						value={valueMode}
						onChange={setValueMode}
						options={[
							{ value: "count", label: t("Count") },
							{ value: "rowPct", label: t("Row %") },
							{ value: "colPct", label: t("Col %") },
						]}
					/>
				</Field>
				{hasNa && (
					<label className="pivot-sidebar__check">
						<Checkbox checked={includeNa} onChange={(e) => setIncludeNa(e.target.checked)} />

						{t("Include N/A")}
					</label>
				)}
			</div>

			<div className="pivot-sidebar__body">
				{fields.length === 0 && (
					<EmptyState>{t("No extra fields on this map. Enrich locations first.")}</EmptyState>
				)}
				{fields.length > 0 && !data && !loading && (
					<EmptyState>
						{rowSource === "active"
							? t("No active selections. Add selections to see pivot data.")
							: rowSource === "all"
								? t("No locations on this map.")
								: t("Saved selection could not be resolved.")}
					</EmptyState>
				)}
				{loading && !view && <EmptyState>{t("Computing...")}</EmptyState>}
				{view && <PivotTable data={view} mode={valueMode} stale={loading} />}
			</div>
		</Sidebar>
	);
}

type SortKey = "label" | "total" | string; // column key or "label" or "total"

function PivotTable({ data, mode, stale }: { data: PivotData; mode: ValueMode; stale?: boolean }) {
	const [sortKey, setSortKey] = useState<SortKey>("label");
	const [sortAsc, setSortAsc] = useState(true);

	// Deterministic selection key per column; parent recomputes on selection:change,
	// so live-state highlighting stays in sync through the data prop.
	const columnKeys = useMemo(
		() => data.columnProps?.map((p) => (p ? buildSelection(p).key : null)),
		[data],
	);
	const liveKeys = new Set(MMA.getActiveSelections().map((s) => s.key));

	const toggleColumnSelection = useCallback(
		(i: number) => {
			const props = data.columnProps?.[i];
			if (!props) return;
			const key = columnKeys?.[i];
			if (key && MMA.getActiveSelections().some((s) => s.key === key)) {
				void MMA.removeSelections([key]);
			} else {
				void MMA.addSelections([props]);
			}
		},
		[data, columnKeys],
	);

	const handleSort = useCallback((key: SortKey) => {
		setSortKey((prev) => {
			if (prev === key) {
				setSortAsc((a) => !a);
				return key;
			}
			setSortAsc(key === "label");
			return key;
		});
	}, []);

	// Displayed value per cell; also drives sorting and shading so all three agree.
	const cellValue = useCallback(
		(row: PivotRow, col: string) => pivotCellValue(data, row, col, mode),
		[mode, data],
	);

	const maxCellValue = useMemo(() => {
		let max = 0;
		for (const row of data.rows) {
			for (const col of data.columns) {
				const v = cellValue(row, col);
				if (v > max) max = v;
			}
		}
		return max;
	}, [data, cellValue]);

	const sortedIndices = useMemo(() => {
		const indices = data.rows.map((_, i) => i);
		indices.sort((a, b) => {
			let va: number | string, vb: number | string;
			if (sortKey === "label") {
				va = data.rows[a].label.toLowerCase();
				vb = data.rows[b].label.toLowerCase();
			} else if (sortKey === "total") {
				va = data.rows[a].total;
				vb = data.rows[b].total;
			} else {
				va = cellValue(data.rows[a], sortKey);
				vb = cellValue(data.rows[b], sortKey);
			}
			if (va < vb) return sortAsc ? -1 : 1;
			if (va > vb) return sortAsc ? 1 : -1;
			return 0;
		});
		return indices;
	}, [data, sortKey, sortAsc, cellValue]);

	const arrow = (key: SortKey) => (sortKey === key ? (sortAsc ? " ▴" : " ▾") : "");

	return (
		<div className={`pivot-sidebar__table-wrap${stale ? " pivot-sidebar__table-wrap--stale" : ""}`}>
			<table className="pivot-sidebar__table">
				<thead>
					<tr>
						<th
							className="pivot-sidebar__th-corner pivot-sidebar__th-sort"
							onClick={() => handleSort("label")}
						>
							{t("Selection")}
							{arrow("label")}
						</th>
						{data.columnLabels.map((label, i) => {
							const selectable = !!data.columnProps?.[i];
							const selected = !!columnKeys?.[i] && liveKeys.has(columnKeys[i]!);
							return (
								<th
									key={data.columns[i]}
									className={`pivot-sidebar__th-sort${selected ? " pivot-sidebar__th-selected" : ""}`}
									title={
										selectable
											? t("Click to sort. Ctrl+Click to select matching locations.")
											: undefined
									}
									onClick={(e) => {
										if ((e.ctrlKey || e.metaKey) && selectable) toggleColumnSelection(i);
										else handleSort(data.columns[i]);
									}}
								>
									{label}
									{arrow(data.columns[i])}
								</th>
							);
						})}
						<th className="pivot-sidebar__th-sort" onClick={() => handleSort("total")}>
							{t("Total")}
							{arrow("total")}
						</th>
					</tr>
				</thead>
				<tbody>
					{sortedIndices.map((idx) => {
						const row = data.rows[idx];
						return (
							<tr key={idx}>
								<td className="pivot-sidebar__row-label">
									<span
										className="pivot-sidebar__swatch"
										style={{
											background: `rgb(${row.color[0]},${row.color[1]},${row.color[2]})`,
										}}
									/>
									<span className="pivot-sidebar__row-name" title={row.label}>
										{row.label}
									</span>
								</td>
								{data.columns.map((col) => {
									const raw = row.counts.get(col) ?? 0;
									const v = cellValue(row, col);
									return (
										<td
											key={col}
											className={raw === 0 ? "pivot-sidebar__cell--zero" : ""}
											style={
												raw > 0 && maxCellValue > 0
													? { background: `rgba(255,255,255,${(0.11 * v) / maxCellValue})` }
													: undefined
											}
											title={mode === "count" ? undefined : `${raw}`}
										>
											{mode === "count" ? raw : formatPct(v)}
										</td>
									);
								})}
								<td className="pivot-sidebar__cell--total">{row.total}</td>
							</tr>
						);
					})}
				</tbody>
				<tfoot>
					<tr>
						<td className="pivot-sidebar__row-label">{t("Total")}</td>
						{data.columnTotals.map((t, i) => (
							<td key={data.columns[i]}>{t}</td>
						))}
						<td className="pivot-sidebar__cell--total">
							{data.columnTotals.reduce((a, b) => a + b, 0)}
						</td>
					</tr>
				</tfoot>
			</table>
		</div>
	);
}
