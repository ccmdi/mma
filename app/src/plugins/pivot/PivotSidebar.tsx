import { useState, useEffect, useCallback, useMemo } from "react";
import type { Selection, SelectionProps } from "@/bindings.gen";
import { NSelect } from "@/components/primitives/NSelect";
import { useDebouncedCallback } from "@/lib/hooks/useDebouncedCallback";
import { selectionDisplayName } from "@/store/selections";
import { savedToSelectionProps, describeRule, type SavedSelection } from "@/store/savedSelections";
import { Sidebar, Field, EmptyState } from "@/components/primitives/Sidebar";
import type { ExtraFieldDef } from "@/bindings.gen";
import { getFieldDef, fieldLabel } from "@/lib/data/fieldDefRegistry";
import { binNumeric, compareNatural } from "@/lib/util/util";
import type { LocationStore } from "@/api";
import "./pivot.css";

let locStore: LocationStore | null = null;

interface PivotRow {
	label: string;
	color: [number, number, number];
	counts: Map<string, number>;
	total: number;
}

interface PivotData {
	rows: PivotRow[];
	columns: string[];
	columnLabels: string[];
	columnTotals: number[];
}

type RowSource = "all" | "active" | string; // "all", "active", or saved selection id

const TAGS_FIELD_KEY = "__tags__";

interface FieldOption {
	key: string;
	label: string;
	def: ExtraFieldDef | undefined;
}

async function computePivot(
	rowSource: RowSource,
	fieldKey: string,
	fieldDef: ExtraFieldDef | undefined,
	bucketCount: number | null,
): Promise<PivotData | null> {
	const map = MMA.getCurrentMap();
	if (!map) return null;

	if (!locStore) locStore = await MMA.createLocationStore();
	const allLocs = [...locStore.locations.values()];

	// Determine rows + resolve ID sets
	let rowDefs: { label: string; color: [number, number, number] }[];
	let idSets: Set<number>[];

	if (rowSource === "all") {
		const allIds = new Set(allLocs.map((l) => l.id));
		rowDefs = [{ label: "All locations", color: [140, 140, 140] }];
		idSets = [allIds];
	} else if (rowSource === "active") {
		const sels = MMA.getSelections();
		if (sels.length === 0) return null;
		rowDefs = sels.map((s: Selection) => ({
			label: selectionDisplayName(s),
			color: s.color,
		}));
		idSets = await Promise.all(
			sels.map((s: Selection) =>
				MMA.cmd.storeResolveSelection(s.props).then((ids: number[]) => new Set(ids)),
			),
		);
	} else {
		const saved: SavedSelection[] = MMA.getSettings().savedSelections;
		const entry = saved.find((s: SavedSelection) => s.id === rowSource);
		if (!entry || entry.items.length === 0) return null;
		const resolvedRows: {
			label: string;
			color: [number, number, number];
			props: SelectionProps;
		}[] = [];
		for (const item of entry.items) {
			const props = savedToSelectionProps(item.props);
			if (!props) continue;
			resolvedRows.push({ label: describeRule(item.props), color: item.color, props });
		}
		if (resolvedRows.length === 0) return null;
		rowDefs = resolvedRows.map((r) => ({ label: r.label, color: r.color }));
		idSets = await Promise.all(
			resolvedRows.map((r) =>
				MMA.cmd.storeResolveSelection(r.props).then((ids: number[]) => new Set(ids)),
			),
		);
	}

	const isTags = fieldKey === TAGS_FIELD_KEY;
	const tagMap = map.meta.tags;
	const isNumeric = !isTags && (fieldDef?.type === "number" || fieldDef?.type === "date");

	// Numeric fields explode into one column per distinct value; bucket them into a
	// fixed histogram of ranges when a bucket count is given.
	const buckets =
		isNumeric && bucketCount
			? binNumeric(
					allLocs.flatMap((loc) => {
						const v = loc.extra?.[fieldKey];
						const n = v == null ? NaN : Number(v);
						return Number.isFinite(n) ? [n] : [];
					}),
					{ by: "count", n: bucketCount },
				)
			: null;

	// Build field index: locId -> field value(s). Tags are multi-valued.
	const fieldIndex = new Map<number, string[]>();
	for (const loc of allLocs) {
		if (isTags) {
			if (loc.tags.length > 0) {
				fieldIndex.set(
					loc.id,
					loc.tags.map((t) => String(t)),
				);
			}
		} else {
			const val = loc.extra?.[fieldKey];
			if (val == null) continue;
			if (buckets) {
				const n = Number(val);
				if (Number.isFinite(n)) fieldIndex.set(loc.id, [buckets.labels[buckets.bucketIndex(n)]]);
			} else {
				fieldIndex.set(loc.id, [String(val)]);
			}
		}
	}

	// Discover columns
	let columns: string[];
	if (buckets) {
		columns = [...buckets.labels];
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
			counts.set("__na__", naCount);
			hasNa = true;
			total += naCount;
		}
		return { label: row.label, color: row.color, counts, total };
	});

	if (hasNa) columns.push("__na__");

	const columnTotals = columns.map((col) =>
		pivotRows.reduce((sum, r) => sum + (r.counts.get(col) ?? 0), 0),
	);

	const extraLabels = fieldDef?.labels ?? {};
	const columnLabels = columns.map((c) => {
		if (c === "__na__") return "N/A";
		if (isTags) return tagMap[c]?.name ?? `Tag ${c}`;
		return extraLabels[c] ?? c;
	});

	return { rows: pivotRows, columns, columnLabels, columnTotals };
}

function buildPivotFields(knownKeys: ReadonlySet<string>): FieldOption[] {
	const result: FieldOption[] = [{ key: TAGS_FIELD_KEY, label: "Tags", def: undefined }];
	for (const key of knownKeys) {
		const def = getFieldDef(key);
		result.push({ key, label: fieldLabel(key), def });
	}
	return result;
}

function defaultPivotField(fields: FieldOption[]): string {
	return (fields.find((f) => f.key === "cameraType") ?? fields[0])?.key ?? "";
}

export function PivotSidebar({ onClose }: { onClose: () => void }) {
	const [rowSource, setRowSource] = useState<RowSource>("active");
	const [fieldKey, setFieldKey] = useState(() =>
		defaultPivotField(buildPivotFields(MMA.getKnownFieldKeys())),
	);
	const [bucketCount, setBucketCount] = useState<number | null>(10);
	const [data, setData] = useState<PivotData | null>(null);
	const [loading, setLoading] = useState(false);

	const knownKeys = MMA.getKnownFieldKeys();
	const fields = useMemo(() => buildPivotFields(knownKeys), [knownKeys]);

	const savedSelections: SavedSelection[] = MMA.getSettings().savedSelections;

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

	const debouncedRecompute = useDebouncedCallback(recompute, 150);

	useEffect(() => {
		recompute();
		const unsubStore = locStore?.onChange(debouncedRecompute);
		const unsubSel = MMA.on("selection:change", debouncedRecompute);
		return () => {
			unsubStore?.();
			unsubSel();
			locStore?.destroy();
			locStore = null;
		};
	}, [recompute, debouncedRecompute]);

	return (
		<Sidebar title="Pivot Table" onBack={onClose} className="pivot-sidebar" flush>
			<div className="pivot-sidebar__controls">
				<Field label="Rows">
					<NSelect value={rowSource} onChange={(e) => setRowSource(e.target.value)}>
						<option value="all">All Locations</option>
						<option value="active">Active Selections</option>
						{savedSelections.map((s) => (
							<option key={s.id} value={s.id}>
								{s.name}
							</option>
						))}
					</NSelect>
				</Field>
				<Field label="Column field">
					<NSelect value={fieldKey} onChange={(e) => setFieldKey(e.target.value)}>
						{fields.map((f) => (
							<option key={f.key} value={f.key}>
								{f.label}
							</option>
						))}
					</NSelect>
				</Field>
				{isNumericField && (
					<Field label="Bucket numeric values">
						<NSelect
							value={bucketCount ?? "off"}
							onChange={(e) =>
								setBucketCount(e.target.value === "off" ? null : Number(e.target.value))
							}
						>
							<option value="off">Off</option>
							<option value="5">5 buckets</option>
							<option value="10">10 buckets</option>
							<option value="15">15 buckets</option>
							<option value="20">20 buckets</option>
						</NSelect>
					</Field>
				)}
			</div>

			<div className="pivot-sidebar__body">
				{fields.length === 0 && (
					<EmptyState>No extra fields on this map. Enrich locations first.</EmptyState>
				)}
				{fields.length > 0 && !data && !loading && (
					<EmptyState>
						{rowSource === "active"
							? "No active selections. Add selections to see pivot data."
							: rowSource === "all"
								? "No locations on this map."
								: "Saved selection could not be resolved."}
					</EmptyState>
				)}
				{loading && <EmptyState>Computing...</EmptyState>}
				{data && <PivotTable data={data} />}
			</div>
		</Sidebar>
	);
}

type SortKey = "label" | "total" | string; // column key or "label" or "total"

function PivotTable({ data }: { data: PivotData }) {
	const [sortKey, setSortKey] = useState<SortKey>("label");
	const [sortAsc, setSortAsc] = useState(true);

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
				va = data.rows[a].counts.get(sortKey) ?? 0;
				vb = data.rows[b].counts.get(sortKey) ?? 0;
			}
			if (va < vb) return sortAsc ? -1 : 1;
			if (va > vb) return sortAsc ? 1 : -1;
			return 0;
		});
		return indices;
	}, [data, sortKey, sortAsc]);

	const arrow = (key: SortKey) => (sortKey === key ? (sortAsc ? " ▴" : " ▾") : "");

	return (
		<div className="pivot-sidebar__table-wrap">
			<table className="pivot-sidebar__table">
				<thead>
					<tr>
						<th
							className="pivot-sidebar__th-corner pivot-sidebar__th-sort"
							onClick={() => handleSort("label")}
						>
							Selection{arrow("label")}
						</th>
						{data.columnLabels.map((label, i) => (
							<th
								key={data.columns[i]}
								className="pivot-sidebar__th-sort"
								onClick={() => handleSort(data.columns[i])}
							>
								{label}
								{arrow(data.columns[i])}
							</th>
						))}
						<th className="pivot-sidebar__th-sort" onClick={() => handleSort("total")}>
							Total{arrow("total")}
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
									const v = row.counts.get(col) ?? 0;
									return (
										<td key={col} className={v === 0 ? "pivot-sidebar__cell--zero" : ""}>
											{v}
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
						<td className="pivot-sidebar__row-label">Total</td>
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
