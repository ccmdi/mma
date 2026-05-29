import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { cmd } from "@/lib/commands";
import { getSelectionInputs, useSelections } from "@/store/useMapStore";
import { getAllFieldDefs } from "@/lib/data/fieldDefRegistry";
import { log } from "@/lib/util/log";
import type { DisambiguateResult, FieldDivergence, GroupSummary, ValueFormat, ExtraFieldDef } from "@/bindings.gen";

interface Props {
	onClose: () => void;
}

const GROUP_PALETTE = "abcdefghijklmnop";

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

function GroupCell({ field, g, color }: { field: FieldDivergence; g: GroupSummary; color: [number, number, number] }) {
	const coverage = g.n > 0 ? Math.round((g.present / g.n) * 100) : 0;
	let body: ReactNode;
	if (field.comparison.type === "circular") {
		body = g.present > 0
			? <span>{fmtNum(g.meanDeg)}&deg; <span className="disambig__muted">(conc {g.concentration?.toFixed(2)})</span></span>
			: <span className="disambig__muted">no data</span>;
	} else if (field.comparison.type === "categorical") {
		body = g.top.length > 0
			? <span>{g.top.map((t) => `${t.label} ${Math.round(t.freq * 100)}%`).join(", ")}</span>
			: <span className="disambig__muted">no data</span>;
	} else {
		body = g.present > 0
			? <span>{fmtVal(g.median, field.format)} <span className="disambig__muted">[{fmtVal(g.p25, field.format)}&ndash;{fmtVal(g.p75, field.format)}]</span></span>
			: <span className="disambig__muted">no data</span>;
	}
	return (
		<div className="disambig__group">
			<span className="disambig__swatch" style={{ background: rgb(color) }} />
			<div className="disambig__group-body">
				{body}
				<div className="disambig__muted disambig__coverage">{g.present}/{g.n} ({coverage}%)</div>
			</div>
		</div>
	);
}

function FieldRow({ field, colors }: { field: FieldDivergence; colors: [number, number, number][] }) {
	const score = field.valueScore;
	return (
		<div className={`disambig__row${field.lowConfidence ? " disambig__row--weak" : ""}`}>
			<div className="disambig__head">
				<span className="disambig__label">{field.label}</span>
				<span className="disambig__badge">{badgeText(field)}</span>
				{field.lowConfidence && <span className="disambig__badge disambig__badge--warn">low data</span>}
				<span className="disambig__score">{score !== null ? score.toFixed(2) : "-"}</span>
			</div>
			<div className="disambig__bar">
				<div className="disambig__bar-fill" style={{ width: `${(score ?? 0) * 100}%` }} />
			</div>
			{field.coverageScore > 0.01 && (
				<div className="disambig__muted">presence differs across groups (coverage {field.coverageScore.toFixed(2)})</div>
			)}
			<div className="disambig__groups">
				{field.groups.map((g, i) => (
					<GroupCell key={i} field={field} g={g} color={colors[i] ?? [128, 128, 128]} />
				))}
			</div>
		</div>
	);
}

export function DisambiguateDialog({ onClose }: Props) {
	const selections = useSelections();
	const [result, setResult] = useState<DisambiguateResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	const colors = getSelectionInputs().map((s) => s.color);

	useEffect(() => {
		const groups = getSelectionInputs();
		if (groups.length < 2) {
			setError("Select at least 2 groups to disambiguate.");
			return;
		}
		const fieldDefs: Record<string, ExtraFieldDef> = getAllFieldDefs();
		setError(null);
		cmd.storeDisambiguate(groups, fieldDefs)
			.then(setResult)
			.catch((e) => {
				log.error("[disambiguate] failed:", e);
				setError(String(e));
			});
	}, [selections]);

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent title="Disambiguate selections" className="disambig-modal">
				{error && <div className="disambig__error">{error}</div>}
				{!error && !result && <div className="disambig__muted">Analyzing&hellip;</div>}
				{result && (
					<>
						<div className="disambig__summary disambig__muted">
							{result.groupSizes.map((n, i) => (
								<span key={i} className="disambig__group">
									<span className="disambig__swatch" style={{ background: rgb(colors[i] ?? [128, 128, 128]) }} />
									{n}
								</span>
							))}
							{result.excludedOverlap > 0 && <span>&middot; {result.excludedOverlap} excluded (in multiple groups)</span>}
						</div>
						<div className="disambig__list">
							{result.fields.map((f) => (
								<FieldRow key={f.key} field={f} colors={colors} />
							))}
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
