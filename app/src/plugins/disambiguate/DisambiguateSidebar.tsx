import type { ReactNode } from "react";
import { useAsync } from "@/lib/hooks/useAsync";
import { useEventVersion } from "@/lib/hooks/useEditorEvents";
import { SELECTION_EVENTS } from "@/lib/events";
import { Sidebar, EmptyState } from "@/components/primitives/Sidebar";
import type { Selection, ExtraFieldDef, Location } from "@/bindings.gen";
import { computeDivergence, soleGroup } from "./engine";
import type {
	DisambiguateResult,
	FieldDivergence,
	GroupSummary,
	ValueFormat,
	Labeled,
} from "./engine";
import "./disambiguate.css";

function rgb(c: [number, number, number]) {
	return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

function badgeText(field: FieldDivergence): string {
	if (field.format === "month") return "Month";
	if (field.format === "dateTime") return "Date";
	const c = field.comparison;
	if (c.type === "circular") return `Circular ${Math.round(c.period)}`;
	if (c.type === "linear") return "Numeric";
	return "Categorical";
}

function fmtNum(n: number | null | undefined): string {
	if (n === null || n === undefined || Number.isNaN(n)) return "-";
	return Math.abs(n) >= 1000 || Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2);
}

/** Format a numeric summary value back into a readable form for its field type. */
function fmtVal(n: number | null | undefined, format: ValueFormat): string {
	if (n === null || n === undefined || Number.isNaN(n)) return "-";
	if (format === "month") {
		const idx = Math.round(n);
		const year = Math.floor(idx / 12);
		const month = idx - year * 12 + 1;
		return `${year}-${String(month).padStart(2, "0")}`;
	}
	if (format === "dateTime") {
		return new Date(n * 1000).toISOString().slice(0, 10);
	}
	return fmtNum(n);
}

function GroupCell({
	field,
	g,
	color,
}: {
	field: FieldDivergence;
	g: GroupSummary;
	color: [number, number, number];
}) {
	const coverage = g.n > 0 ? Math.round((g.present / g.n) * 100) : 0;
	let body: ReactNode;
	if (field.comparison.type === "circular") {
		body =
			g.present > 0 ? (
				<span>
					{fmtNum(g.meanDeg)}&deg;{" "}
					<span className="disambig__muted">(conc {g.concentration?.toFixed(2)})</span>
				</span>
			) : (
				<span className="disambig__muted">no data</span>
			);
	} else if (field.comparison.type === "categorical") {
		body =
			g.top.length > 0 ? (
				<span>{g.top.map((t) => `${t.label} ${Math.round(t.freq * 100)}%`).join(", ")}</span>
			) : (
				<span className="disambig__muted">no data</span>
			);
	} else {
		body =
			g.present > 0 ? (
				<span>
					{fmtVal(g.median, field.format)}{" "}
					<span className="disambig__muted">
						[{fmtVal(g.p25, field.format)}&ndash;{fmtVal(g.p75, field.format)}]
					</span>
				</span>
			) : (
				<span className="disambig__muted">no data</span>
			);
	}
	return (
		<div className="disambig__group">
			<span className="disambig__swatch" style={{ background: rgb(color) }} />
			<div className="disambig__group-body">
				{body}
				<div className="disambig__muted disambig__coverage">
					{g.present}/{g.n} ({coverage}%)
				</div>
			</div>
		</div>
	);
}

function FieldRow({
	field,
	colors,
}: {
	field: FieldDivergence;
	colors: [number, number, number][];
}) {
	const score = field.valueScore;
	return (
		<div className={`disambig__row${field.lowConfidence ? " disambig__row--weak" : ""}`}>
			<div className="disambig__head">
				<span className="disambig__label">{field.label}</span>
				<span className="disambig__badge">{badgeText(field)}</span>
				{field.lowConfidence && (
					<span className="disambig__badge disambig__badge--warn">low data</span>
				)}
				<span className="disambig__score">{score !== null ? score.toFixed(2) : "-"}</span>
			</div>
			<div className="disambig__bar">
				<div className="disambig__bar-fill" style={{ width: `${(score ?? 0) * 100}%` }} />
			</div>
			{field.coverageScore > 0.01 && (
				<div className="disambig__muted">
					presence differs across groups (coverage {field.coverageScore.toFixed(2)})
				</div>
			)}
			<div className="disambig__groups">
				{field.groups.map((g, i) => (
					<GroupCell key={i} field={field} g={g} color={colors[i] ?? [128, 128, 128]} />
				))}
			</div>
		</div>
	);
}

interface Analysis {
	result: DisambiguateResult;
	colors: [number, number, number][];
	excludedOverlap: number;
}

/** Resolve the active selections to labeled groups (dropping multi-group overlap)
 *  and compute field divergence. Mirrors the Rust `store_disambiguate` orchestration. */
async function analyze(): Promise<Analysis> {
	const map = MMA.getCurrentMap();
	if (!map) throw new Error("No map open");
	const sels: Selection[] = MMA.getSelections();
	if (sels.length < 2) throw new Error("Select at least 2 groups to disambiguate.");

	const colors = sels.map((s) => s.color);
	const idSets = await Promise.all(
		sels.map((s) => MMA.cmd.storeResolveSelection(s.props).then((ids: number[]) => new Set(ids))),
	);

	const locStore = await MMA.createLocationStore();
	try {
		const labeled: Labeled[] = [];
		let excludedOverlap = 0;
		for (const loc of locStore.locations.values()) {
			const g = soleGroup(idSets, loc.id);
			if (g === "overlap") excludedOverlap++;
			else if (g !== null) labeled.push({ group: g, loc: loc as Location });
		}

		const fieldDefs: Record<string, ExtraFieldDef> = MMA.getAllFieldDefs();
		const tagNames: Record<number, string> = {};
		for (const [id, t] of Object.entries(map.meta.tags))
			tagNames[Number(id)] = (t as { name: string }).name;

		const result = computeDivergence(labeled, sels.length, fieldDefs, tagNames);
		return { result, colors, excludedOverlap };
	} finally {
		locStore.destroy();
	}
}

export function DisambiguateSidebar({ onClose }: { onClose: () => void }) {
	const version = useEventVersion(SELECTION_EVENTS);
	const selCount = MMA.getSelections().length;
	// Synchronous null short-circuit: no loading flash while under two groups.
	const {
		data: analysis,
		loading,
		error,
	} = useAsync(() => (selCount < 2 ? null : analyze()), [version]);

	if (selCount < 2) {
		return (
			<Sidebar title="Disambiguate selections" onBack={onClose} className="disambig">
				<EmptyState>Select at least two groups to compare - tags, polygons, or filters.</EmptyState>
			</Sidebar>
		);
	}

	return (
		<Sidebar title="Disambiguate selections" onBack={onClose} className="disambig">
			{error && <div className="disambig__error">{error.message}</div>}
			{!error && loading && <div className="disambig__muted">Analyzing&hellip;</div>}
			{!error && analysis && (
				<>
					<div className="disambig__summary disambig__muted">
						{analysis.result.groupSizes.map((n, i) => (
							<span key={i} className="disambig__group">
								<span
									className="disambig__swatch"
									style={{ background: rgb(analysis.colors[i] ?? [128, 128, 128]) }}
								/>
								{n}
							</span>
						))}
						{analysis.excludedOverlap > 0 && (
							<span>&middot; {analysis.excludedOverlap} excluded (in multiple groups)</span>
						)}
					</div>
					<div className="disambig__list">
						{analysis.result.fields.map((f) => (
							<FieldRow key={f.key} field={f} colors={analysis.colors} />
						))}
					</div>
				</>
			)}
		</Sidebar>
	);
}
