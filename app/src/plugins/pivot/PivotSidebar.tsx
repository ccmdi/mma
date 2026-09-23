import { useState, useEffect, useCallback, useMemo } from "react";
import { createFieldDef } from "@/types";
import { tagSelector, untaggedSelector } from "@/store/selections";
import type { PartitionBucket, Selection, Selector } from "@/bindings.gen";
import { NSelect } from "@/components/primitives/NSelect";
import { SwitchRow } from "@/components/primitives/SwitchRow";
import { useDebouncedCallback } from "@/lib/hooks/useDebouncedCallback";
import {
	addSelection,
	all,
	batch,
	removeSelection,
	selectionDisplayName,
	buildSelection,
} from "@/store/selections";
import {
	applySelectionUpdate,
	getActiveSelections,
	getMapState,
	getTags,
	query,
} from "@/store/useMapStore";
import { subscribe } from "@/lib/events";
import { Sidebar, Field, SegmentedControl } from "@/components/primitives/Sidebar";
import { EmptyState } from "@/components/primitives/EmptyState";
import type { FieldDef } from "@/bindings.gen";
import { getFieldDef, getKnownFieldKeys } from "@/lib/data/fieldDefRegistry";
import { subscribeMany, LOCATION_DATA_EVENTS } from "@/lib/events";
import { useExtraFieldKeys } from "@/components/editor/map/FilterBuilder";
import { compareNatural } from "@/lib/util/util";
import { usePluginState } from "@/plugins/pluginStorage";
import { SelectorPicker } from "@/components/primitives/SelectorPicker";
import { useSelectorPick } from "@/store/selectorPick";
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
	type PivotMember,
	type PivotRow,
	type PivotData,
	type ResolvedAxis,
	type Tally,
	type ValueMode,
} from "./pivotMath";
import "./pivot.css";

type Axis =
	{ kind: "all" } | { kind: "active" } | { kind: "field"; key: string; buckets: number | null };

const TAGS_FIELD_KEY = "__tags__";
const FIELD_PREFIX = "field:";

import type { FieldEntry } from "@/components/editor/map/FilterBuilder";
import { msg, t } from "@/lib/i18n";
import { Swatch } from "@/components/primitives/Swatch";

async function selectionAxis(kind: "all" | "active", scope: Selector): Promise<ResolvedAxis> {
	const members: PivotMember[] =
		kind === "all"
			? [
					{
						key: "__all__",
						label: t("All locations"),
						color: [140, 140, 140],
						selector: scope,
						selectable: false,
					},
				]
			: getActiveSelections().map((s: Selection) => ({
					key: s.key,
					label: selectionDisplayName(s),
					color: s.color,
					selector: all(scope, s.selector),
					selectable: false,
				}));
	const sizes = await Promise.all(members.map((m) => query(m.selector).count()));
	return { members, sizes, tally: null, binned: false };
}

/** Tag histogram inside a selector: one tag column read, tallied over that selector alone. */
async function tagCounts(selector: Selector): Promise<Tally> {
	const [column] = await query(selector).columns(["tags"]);
	const counts = new Map<string, number>();
	let withValue = 0;
	for (const cell of column) {
		const ids = cell as number[] | null;
		if (!ids || ids.length === 0) continue;
		withValue++;
		for (const tid of ids) {
			const key = String(tid);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return { counts, withValue };
}

/** Counts over a shared set of numeric bins, which only a scope-wide partition can pin
 *  down (bin edges follow the scoped data's range). */
function binCounts(ids: number[], binOf: Map<number, string>): Tally {
	const counts = new Map<string, number>();
	let withValue = 0;
	for (const id of ids) {
		const key = binOf.get(id);
		if (key == null) continue;
		withValue++;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return { counts, withValue };
}

async function fieldAxis(
	fieldKey: string,
	fieldDef: FieldDef | undefined,
	bucketCount: number | null,
	scope: Selector,
): Promise<ResolvedAxis> {
	const isTags = fieldKey === TAGS_FIELD_KEY;
	const isNumeric = !isTags && (fieldDef?.type === "number" || fieldDef?.type === "date");

	// Numeric fields bucket into a histogram; resolveBucketCount arbitrates between the
	// user's choice and the field's cardinality.
	const numericDistinct = isNumeric ? (await query(scope).values(fieldKey)).length : undefined;
	const effectiveBuckets =
		numericDistinct != null ? resolveBucketCount(numericDistinct, bucketCount) : null;

	let buckets: PartitionBucket[] | null = null;
	let tally: (selector: Selector) => Promise<Tally>;
	let whole: Tally;
	if (isTags) {
		tally = tagCounts;
		whole = await tally(scope);
	} else if (effectiveBuckets) {
		const groups = await query(scope).partition(fieldKey, {
			kind: "numericBin",
			binning: { by: "count", n: effectiveBuckets },
		});
		const binOf = new Map<number, string>();
		for (const g of groups) for (const id of g.ids) binOf.set(id, g.key);
		buckets = groups;
		tally = async (selector) => binCounts(await query(selector).ids(), binOf);
		whole = {
			counts: new Map(groups.map((g) => [g.key, g.ids.length])),
			withValue: binOf.size,
		};
	} else {
		tally = async (selector) => {
			const grouped = await query(selector).countBy(fieldKey, { kind: "value" });
			return { counts: new Map(grouped.counts), withValue: grouped.covered };
		};
		whole = await tally(scope);
	}

	let keys: string[];
	if (buckets) {
		keys = buckets.map((g) => g.key);
	} else {
		const declared = isTags ? [] : (fieldDef?.values ?? []).map((v) => v.value);
		const declaredSet = new Set(declared);
		const seen = [...whole.counts.keys()].filter((k) => !declaredSet.has(k)).sort(compareNatural);
		keys = [...declared, ...seen];
	}

	const tagMap = getTags();
	const extraLabels = Object.fromEntries(
		(fieldDef?.values ?? []).flatMap((v) => (v.label ? [[v.value, v.label]] : [])),
	);
	// Selectors match the shapes gradient emits: tags are Tag selections, buckets `between`
	// filters, plain values `eq` filters.
	const member = (key: string, i: number): PivotMember => {
		const bin = buckets?.[i]?.bin;
		return {
			key,
			label: isTags
				? (tagMap[Number(key)]?.name ?? t("Tag {id}", { id: key }))
				: (extraLabels[key] ?? key),
			color: null,
			selector: all(
				scope,
				isTags
					? tagSelector(Number(key))
					: bin
						? { type: "Filter", field: fieldKey, test: { op: "between", lo: bin[0], hi: bin[1] } }
						: { type: "Filter", field: fieldKey, test: { op: "eq", value: key } },
			),
			selectable: true,
		};
	};
	const members = keys.map(member);
	const sizes = keys.map((k) => whole.counts.get(k) ?? 0);

	const naCount = (await query(scope).count()) - whole.withValue;
	if (naCount > 0) {
		members.push({
			key: NA_KEY,
			label: t("N/A"),
			color: null,
			selector: all(
				scope,
				isTags ? untaggedSelector() : { type: "Filter", field: fieldKey, test: { op: "nothas" } },
			),
			selectable: true,
		});
		sizes.push(naCount);
	}

	return { members, sizes, tally, binned: buckets != null, numericDistinct };
}

function resolveAxis(axis: Axis, scope: Selector, defOf: (key: string) => FieldDef | undefined) {
	return axis.kind === "field"
		? fieldAxis(axis.key, defOf(axis.key), axis.buckets, scope)
		: selectionAxis(axis.kind, scope);
}

const countBoth = (a: Selector, b: Selector) =>
	query({ type: "Intersection", selections: [buildSelection(a), buildSelection(b)] }).count();

async function computePivot(
	rows: Axis,
	cols: Axis,
	scope: Selector,
	defOf: (key: string) => FieldDef | undefined,
): Promise<PivotData | null> {
	if (!getMapState().map) return null;
	const [rowAxis, colAxis] = await Promise.all([
		resolveAxis(rows, scope, defOf),
		resolveAxis(cols, scope, defOf),
	]);
	if (rowAxis.members.length === 0 || colAxis.members.length === 0) return null;
	return buildPivot(rowAxis, colAxis, await crossCounts(rowAxis, colAxis, countBoth));
}

const TAGS_FIELD: FieldEntry = {
	key: TAGS_FIELD_KEY,
	label: msg("Tags"),
	def: createFieldDef("enum"),
};

// Fields the map actually carries, with a known definition.
function pivotFields(all: FieldEntry[], knownKeys: ReadonlySet<string>): FieldEntry[] {
	return [TAGS_FIELD, ...all.filter((f) => knownKeys.has(f.key) && getFieldDef(f.key))];
}

function defaultPivotField(fields: FieldEntry[]): string {
	return (fields.find((f) => f.key === "cameraType") ?? fields[0])?.key ?? "";
}

// Persisted axes are global; a field this map lacks falls back to the default field.
function axisOnMap(axis: Axis, fields: FieldEntry[]): Axis {
	if (axis.kind !== "field" || fields.some((f) => f.key === axis.key)) return axis;
	return { ...axis, key: defaultPivotField(fields) };
}

const axisValue = (axis: Axis) => (axis.kind === "field" ? FIELD_PREFIX + axis.key : axis.kind);

function parseAxis(value: string, prev: Axis): Axis {
	if (value === "all" || value === "active") return { kind: value };
	const buckets = prev.kind === "field" ? prev.buckets : DEFAULT_BUCKETS;
	return { kind: "field", key: value.slice(FIELD_PREFIX.length), buckets };
}

function AxisControls({
	label,
	axis,
	onChange,
	fields,
	distinct,
}: {
	label: string;
	axis: Axis;
	onChange: (axis: Axis) => void;
	fields: FieldEntry[];
	distinct: number | undefined;
}) {
	const def = axis.kind === "field" ? fields.find((f) => f.key === axis.key)?.def : undefined;
	const isNumericField = def?.type === "number" || def?.type === "date";
	// Cardinality-aware bucketing (mirrors resolveBucketCount in fieldAxis):
	// few distinct values -> no bucket control at all; too many -> "Off" disabled.
	const bucketHidden = distinct != null && distinct < BUCKET_MIN_DISTINCT;
	const bucketForced = distinct != null && distinct >= BUCKET_FORCE_DISTINCT;
	return (
		<>
			<Field label={label}>
				<NSelect
					value={axisValue(axis)}
					onChange={(e) => onChange(parseAxis(e.target.value, axis))}
				>
					<option value="all" className="pivot-sidebar__opt-builtin">
						{t("All locations")}
					</option>
					<option value="active" className="pivot-sidebar__opt-builtin">
						{t("Active selections")}
					</option>
					{fields.map((f) => (
						<option key={f.key} value={FIELD_PREFIX + f.key}>
							{f.label}
						</option>
					))}
				</NSelect>
			</Field>
			{axis.kind === "field" && isNumericField && !bucketHidden && (
				<Field label={t("Bucket numeric values")}>
					<NSelect
						value={bucketForced ? (axis.buckets ?? DEFAULT_BUCKETS) : (axis.buckets ?? "off")}
						onChange={(e) =>
							onChange({
								...axis,
								buckets: e.target.value === "off" ? null : Number(e.target.value),
							})
						}
					>
						<option value="off" disabled={bucketForced}>
							{bucketForced ? t("Off (too many values)") : t("Off")}
						</option>
						{[5, 10, 15, 20].map((n) => (
							<option key={n} value={n}>
								{t({ one: "{n} bucket", other: "{n} buckets" }, { n })}
							</option>
						))}
					</NSelect>
				</Field>
			)}
		</>
	);
}

export function PivotSidebar({ onClose }: { onClose: () => void }) {
	const [rowsRaw, setRows] = usePluginState<Axis>("pivot", "rows", { kind: "active" });
	// Empty resolves to nothing, so the effective field falls back to the default.
	const [colsRaw, setCols] = usePluginState<Axis>("pivot", "cols", {
		kind: "field",
		key: "",
		buckets: DEFAULT_BUCKETS,
	});
	const scope = useSelectorPick({ pick: "all" });
	const [valueMode, setValueMode] = usePluginState<ValueMode>("pivot", "valueMode", "count");
	const [includeNa, setIncludeNa] = usePluginState<boolean>("pivot", "includeNa", true);
	const [data, setData] = useState<PivotData | null>(null);
	const [loading, setLoading] = useState(false);

	const allFields = useExtraFieldKeys();
	const knownKeys = getKnownFieldKeys();
	const fields = useMemo(() => pivotFields(allFields, knownKeys), [allFields, knownKeys]);

	const rows = useMemo(() => axisOnMap(rowsRaw, fields), [rowsRaw, fields]);
	const cols = useMemo(() => axisOnMap(colsRaw, fields), [colsRaw, fields]);

	const recompute = useCallback(async () => {
		setLoading(true);
		try {
			setData(
				await computePivot(
					rows,
					cols,
					scope.selector,
					(key) => fields.find((f) => f.key === key)?.def,
				),
			);
		} finally {
			setLoading(false);
		}
	}, [rows, cols, scope.selector, fields]);

	const debouncedRecompute = useDebouncedCallback(() => void recompute(), 150);

	useEffect(() => {
		void recompute();
		const unsubLoc = subscribeMany(LOCATION_DATA_EVENTS, debouncedRecompute);
		const unsubSel = subscribe("selection:change", debouncedRecompute);
		return () => {
			unsubLoc();
			unsubSel();
		};
	}, [recompute, debouncedRecompute]);

	const hasNa =
		!!data &&
		(data.columns.some((c) => c.key === NA_KEY) || data.rows.some((r) => r.key === NA_KEY));

	const view = useMemo(() => (data && !includeNa ? stripNa(data) : data), [data, includeNa]);

	const rowLabel =
		rows.kind === "field"
			? (fields.find((f) => f.key === rows.key)?.label ?? rows.key)
			: t("Selection");

	return (
		<Sidebar title={t("Pivot Table")} onBack={onClose} className="pivot-sidebar" flush>
			<div className="pivot-sidebar__controls">
				<AxisControls
					label={t("Rows")}
					axis={rows}
					onChange={setRows}
					fields={fields}
					distinct={data?.numericDistinct.rows}
				/>
				<AxisControls
					label={t("Columns")}
					axis={cols}
					onChange={setCols}
					fields={fields}
					distinct={data?.numericDistinct.cols}
				/>
				<Field label={t("Within")}>
					<SelectorPicker ctl={scope} />
				</Field>
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
					<SwitchRow checked={includeNa} onChange={setIncludeNa} label={t("Include N/A")} />
				)}
			</div>

			<div className="pivot-sidebar__body">
				{!data && !loading && (
					<EmptyState>
						{rows.kind === "active" || cols.kind === "active" || scope.choice.pick === "selection"
							? t("No active selections. Add selections to see pivot data.")
							: t("No locations on this map.")}
					</EmptyState>
				)}
				{loading && !view && <EmptyState>{t("Computing...")}</EmptyState>}
				{view && <PivotTable data={view} mode={valueMode} stale={loading} rowLabel={rowLabel} />}
			</div>
		</Sidebar>
	);
}

type SortKey = "label" | "total" | string; // column key or "label" or "total"

function PivotTable({
	data,
	mode,
	stale,
	rowLabel,
}: {
	data: PivotData;
	mode: ValueMode;
	stale?: boolean;
	rowLabel: string;
}) {
	const [sortKey, setSortKey] = useState<SortKey>("label");
	const [sortAsc, setSortAsc] = useState(true);

	// Deterministic selection key per selectable member; parent recomputes on
	// selection:change, so live-state highlighting stays in sync through the data prop.
	const selectionKeys = useMemo(
		() =>
			new Map<PivotMember, string>(
				[...data.columns, ...data.rows]
					.filter((m) => m.selectable)
					.map((m) => [m, buildSelection(m.selector).key]),
			),
		[data],
	);
	const liveKeys = new Set(getActiveSelections().map((s) => s.key));
	const isSelected = (m: PivotMember) => liveKeys.has(selectionKeys.get(m) ?? "");

	const toggleSelection = useCallback(
		(m: PivotMember) => {
			const key = selectionKeys.get(m);
			if (!key) return;
			if (getActiveSelections().some((s) => s.key === key)) {
				void applySelectionUpdate(batch(removeSelection)([key]));
			} else {
				void applySelectionUpdate(batch(addSelection)([m.selector]));
			}
		},
		[selectionKeys],
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
				const v = cellValue(row, col.key);
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
							{rowLabel}
							{arrow("label")}
						</th>
						{data.columns.map((col) => (
							<th
								key={col.key}
								className={`pivot-sidebar__th-sort${isSelected(col) ? " pivot-sidebar__th-selected" : ""}`}
								title={
									col.selectable
										? t("Click to sort. Ctrl+Click to select matching locations.")
										: undefined
								}
								onClick={(e) => {
									if ((e.ctrlKey || e.metaKey) && col.selectable) toggleSelection(col);
									else handleSort(col.key);
								}}
							>
								{col.color && <Swatch color={col.color} size="sm" />}
								{col.label}
								{arrow(col.key)}
							</th>
						))}
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
							<tr key={row.key}>
								<td
									className={`pivot-sidebar__row-label${isSelected(row) ? " pivot-sidebar__row-label--selected" : ""}`}
									onClick={(e) => {
										if ((e.ctrlKey || e.metaKey) && row.selectable) toggleSelection(row);
									}}
								>
									{row.color && <Swatch color={row.color} size="sm" />}
									<span className="pivot-sidebar__row-name" title={row.label}>
										{row.label}
									</span>
								</td>
								{data.columns.map((col) => {
									const raw = row.counts.get(col.key) ?? 0;
									const v = cellValue(row, col.key);
									return (
										<td
											key={col.key}
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
							<td key={data.columns[i].key}>{t}</td>
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
