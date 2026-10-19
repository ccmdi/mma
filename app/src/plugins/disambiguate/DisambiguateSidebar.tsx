import type { ReactNode } from "react";
import { useAsync } from "@/lib/hooks/useAsync";
import { useEvent, SELECTION_EVENTS } from "@/lib/events";
import { Sidebar } from "@/components/primitives/Sidebar";
import { EmptyState } from "@/components/primitives/EmptyState";
import { Bar } from "@/components/primitives/Bar";
import { Notice } from "@/components/primitives/Hint";
import { Pill } from "@/components/primitives/Pill";
import { Spinner } from "@/components/primitives/Spinner";
import type { FieldDef, RGB, Selection } from "@/bindings.gen";

import { analysisColumns, computeDivergence, exclusiveGroups } from "./engine";
import type { DisambiguateResult, FieldDivergence, GroupSummary, ValueFormat } from "./engine";
import "./disambiguate.css";
import { t } from "@/lib/i18n";
import { Swatch } from "@/components/primitives/Swatch";

function badgeText(field: FieldDivergence): string {
	if (field.format === "month") return t("Month");
	if (field.format === "dateTime") return t("Date");
	const c = field.comparison;
	if (c.type === "circular") return t("Circular {period}", { period: Math.round(c.period) });
	if (c.type === "linear") return t("Numeric");
	return t("Categorical");
}

function fmtNum(n: number | null): string {
	if (n === null || n === undefined || Number.isNaN(n)) return "-";
	return Math.abs(n) >= 1000 || Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2);
}

/** Format a numeric summary value back into a readable form for its field type. */
function fmtVal(n: number | null, format: ValueFormat): string {
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

function GroupCell({ field, g, color }: { field: FieldDivergence; g: GroupSummary; color: RGB }) {
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
				<span className="disambig__muted">{t("no data")}</span>
			);
	} else if (field.comparison.type === "categorical") {
		body =
			g.top.length > 0 ? (
				<span>{g.top.map((t) => `${t.label} ${Math.round(t.freq * 100)}%`).join(", ")}</span>
			) : (
				<span className="disambig__muted">{t("no data")}</span>
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
				<span className="disambig__muted">{t("no data")}</span>
			);
	}
	return (
		<div className="disambig__group">
			<Swatch color={color} size="sm" />
			<div className="disambig__group-body">
				{body}
				<div className="disambig__muted disambig__coverage">
					{g.present}/{g.n} ({coverage}%)
				</div>
			</div>
		</div>
	);
}

function FieldRow({ field, colors }: { field: FieldDivergence; colors: RGB[] }) {
	const score = field.valueScore;
	return (
		<div className={`disambig__row${field.lowConfidence ? " disambig__row--weak" : ""}`}>
			<div className="disambig__head">
				<span className="disambig__label">{field.label}</span>
				<Pill>{badgeText(field)}</Pill>
				{field.lowConfidence && <Pill tone="warning">{t("low data")}</Pill>}
				<span className="disambig__score mono">{score !== null ? score.toFixed(2) : "-"}</span>
			</div>
			<Bar value={score ?? 0} size="md" className="disambig__bar" />
			{field.coverageScore > 0.01 && (
				<div className="disambig__muted">
					{t("presence differs across groups (coverage {score})", {
						score: field.coverageScore.toFixed(2),
					})}
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
	colors: RGB[];
	excludedOverlap: number;
}

/** Resolve the active selections to labeled groups (dropping multi-group overlap)
 *  and compute field divergence. */
async function analyze(): Promise<Analysis> {
	const map = MMA.Store.get().map;
	if (!map) throw new Error(t("No map open"));
	const sels: Selection[] = MMA.SelectionList.active();
	if (sels.length < 2) throw new Error(t("Select at least 2 groups to disambiguate."));

	const colors = sels.map((s) => s.color);
	const selectors = sels.map((s) => s.selector);
	const union = MMA.any(...selectors);

	const fieldDefs: Record<string, FieldDef> = MMA.getAllFieldDefs();
	const tagNames: Record<number, string> = {};
	for (const [id, t] of Object.entries(MMA.Tag.all()))
		tagNames[Number(id)] = (t as { name: string }).name;

	const [unionSize, present] = await Promise.all([
		MMA.Query.read(union, { kind: "count" }),
		MMA.Query.read(union, { kind: "coverage" }),
	]);
	const fields = analysisColumns(
		fieldDefs,
		present.map(([k]) => k),
	);
	const groups = await Promise.all(
		exclusiveGroups(selectors).map(async (selector) => {
			const [size, counts] = await Promise.all([
				MMA.Query.read(selector, { kind: "count" }),
				MMA.Query.read(selector, { kind: "countBy", fields, key: { kind: "value" } }),
			]);
			return { size, counts: Object.fromEntries(fields.map((f, i) => [f, counts[i]])) };
		}),
	);

	const result = computeDivergence(groups, fieldDefs, tagNames);
	const excludedOverlap = unionSize - result.groupSizes.reduce((a, b) => a + b, 0);
	return { result, colors, excludedOverlap };
}

export function DisambiguateSidebar({ onClose }: { onClose: () => void }) {
	const version = useEvent(SELECTION_EVENTS);
	const selCount = MMA.SelectionList.active().length;
	// Synchronous null short-circuit: no loading flash while under two groups.
	const analyzed = useAsync(() => (selCount < 2 ? null : analyze()), [version]);
	const analysis = analyzed.ok();

	if (selCount < 2) {
		return (
			<Sidebar title={t("Disambiguate selections")} onBack={onClose} className="disambig">
				<EmptyState>
					{t("Select at least two groups to compare - tags, polygons, or filters.")}
				</EmptyState>
			</Sidebar>
		);
	}

	return (
		<Sidebar title={t("Disambiguate selections")} onBack={onClose} className="disambig">
			{analyzed.status === "error" && <Notice tone="error">{analyzed.error.message}</Notice>}
			{analyzed.status === "loading" && (
				<div className="disambig__loading">
					<Spinner />
					<span className="disambig__muted">{t("Analyzing...")}</span>
				</div>
			)}
			{analysis && (
				<>
					<div className="disambig__summary disambig__muted">
						{analysis.result.groupSizes.map((n, i) => (
							<span key={i} className="disambig__group">
								<Swatch color={analysis.colors[i] ?? [128, 128, 128]} size="sm" />
								{n}
							</span>
						))}
						{analysis.excludedOverlap > 0 && (
							<span>
								&middot; {t("{n} excluded (in multiple groups)", { n: analysis.excludedOverlap })}
							</span>
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
