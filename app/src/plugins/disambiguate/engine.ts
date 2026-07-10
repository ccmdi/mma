// Selection disambiguation engine: given N groups of locations, rank metadata
// fields by how strongly they *separate* the groups (not by modal frequency).
// Pure, store-free port of the Rust reference (disambiguate.rs); tested in engine.test.ts.

import type { Location, ExtraFieldDef, ComparisonType } from "@/bindings.gen";
import { getFieldDef, getWritableBuiltinKeys } from "@/lib/data/fieldDefRegistry";
import {
	kruskalEps2,
	circularEta2,
	circularSummary,
	cramersV,
	coverageV,
	quartiles,
} from "./stats";

/** A group must have at least this many present values for a field before its
 *  value score is trusted; below this the field is flagged low-confidence. */
const MIN_PRESENT = 8;
/** How many top categories to surface per group in a categorical summary. */
const TOP_N = 3;
/** Fields excluded from analysis: they encode the location/answer itself rather
 *  than an in-round visual tell, so flagging them as "divergent" is pointless. */
const EXCLUDED_FIELDS = new Set(["countryCode", "timezone"]);

export type ValueFormat = "number" | "month" | "dateTime";

export interface TopValue {
	label: string;
	freq: number;
}

export interface GroupSummary {
	n: number;
	present: number;
	median: number | null;
	p25: number | null;
	p75: number | null;
	meanDeg: number | null;
	concentration: number | null;
	top: TopValue[];
}

export interface FieldDivergence {
	key: string;
	label: string;
	comparison: ComparisonType;
	format: ValueFormat;
	/** How strongly the field's values separate the groups, [0,1]. `null` when
	 *  fewer than two groups have any present values. */
	valueScore: number | null;
	/** How strongly field *presence* (vs absence) separates the groups, [0,1]. */
	coverageScore: number;
	/** True when at least one group has too few present values to trust valueScore. */
	lowConfidence: boolean;
	groups: GroupSummary[];
}

export interface DisambiguateResult {
	fields: FieldDivergence[];
	groupSizes: number[];
}

/** A location tagged with the index of the single group it belongs to. */
export type Labeled = { group: number; loc: Location };

/** Which single group a row belongs to across per-group membership sets:
 *  the group index for exactly one, `null` for none, `"overlap"` for more than one. */
export function soleGroup(masks: Set<number>[], id: number): number | null | "overlap" {
	let found: number | null = null;
	for (let gi = 0; gi < masks.length; gi++) {
		if (masks[gi].has(id)) {
			if (found !== null) return "overlap";
			found = gi;
		}
	}
	return found;
}

function emptyGroup(n: number, present: number): GroupSummary {
	return {
		n,
		present,
		median: null,
		p25: null,
		p75: null,
		meanDeg: null,
		concentration: null,
		top: [],
	};
}

/** Resolve how a field is compared. An explicit `comparison` on the def wins;
 *  otherwise inferred from `type`. */
export function resolvedComparison(def: ExtraFieldDef | undefined): ComparisonType {
	if (def?.comparison) return def.comparison;
	switch (def?.type) {
		case "number":
		case "date":
		case "month":
			return { type: "linear" };
		default:
			return { type: "categorical" };
	}
}

/** Infer a field type from a sample value: numbers -> number, `YYYY-MM` -> month, else string. */
function inferFieldType(value: unknown): ExtraFieldDef["type"] {
	if (typeof value === "number") return "number";
	if (typeof value === "string" && /^\d{4}-\d{2}$/.test(value)) return "month";
	return "string";
}

/** Synthetic def for an undeclared key, from the first present value (so an
 *  undeclared numeric field isn't mistaken for categorical). */
function sampleDef(key: string, labeled: Labeled[]): ExtraFieldDef | undefined {
	for (const { loc } of labeled) {
		const v = loc.extra?.[key];
		if (v != null) return { type: inferFieldType(v) };
	}
	return undefined;
}

/** ISO datetime string -> unix seconds, or null. */
function isoToUnix(s: string): number | null {
	const ms = Date.parse(s);
	return Number.isNaN(ms) ? null : ms / 1000;
}

/** `YYYY-MM` -> month index (year*12 + month-1), or null. */
function parseYearMonth(s: string): number | null {
	if (!/^\d{4}-\d{2}$/.test(s)) return null;
	const year = Number(s.slice(0, 4));
	const month = Number(s.slice(5));
	return year * 12 + (month - 1);
}

/** Numeric value for a field on a location (built-in columns + extra). */
function numericValue(loc: Location, key: string): number | null {
	if (key === "heading") return loc.heading;
	if (key === "pitch") return loc.pitch;
	if (key === "zoom") return loc.zoom;
	const v = loc.extra?.[key];
	if (v == null) return null;
	if (typeof v === "number") return v;
	if (typeof v === "string") {
		const ts = isoToUnix(v);
		if (ts !== null) return ts;
		return parseYearMonth(v);
	}
	return null;
}

/** Canonical category string for an extra value (null/missing -> null). */
function categoryValue(loc: Location, key: string): string | null {
	const v = loc.extra?.[key];
	if (v == null) return null;
	if (typeof v === "string") return v;
	if (typeof v === "boolean" || typeof v === "number") return String(v);
	return JSON.stringify(v);
}

function fieldLabel(key: string, def: ExtraFieldDef | undefined): string {
	if (def?.label) return def.label;
	if (key === "heading") return "Heading";
	if (key === "pitch") return "Pitch";
	if (key === "zoom") return "Zoom";
	return key;
}

function isLowConfidence(present: number[]): boolean {
	return present.some((p) => p < MIN_PRESENT);
}

function numericField(
	key: string,
	labeled: Labeled[],
	numGroups: number,
	groupSizes: number[],
	comparison: ComparisonType,
	def: ExtraFieldDef | undefined,
): FieldDivergence {
	const perGroup: number[][] = Array.from({ length: numGroups }, () => []);
	for (const { group, loc } of labeled) {
		const v = numericValue(loc, key);
		if (v !== null) perGroup[group].push(v);
	}

	const present = perGroup.map((v) => v.length);
	const valueScore =
		comparison.type === "circular"
			? circularEta2(perGroup, comparison.period)
			: kruskalEps2(perGroup);
	const coverageScore = coverageV(groupSizes, present);
	const lowConfidence = isLowConfidence(present);

	const groups: GroupSummary[] = perGroup.map((vals, g) => {
		const s = emptyGroup(groupSizes[g], vals.length);
		if (vals.length > 0) {
			if (comparison.type === "circular") {
				const { mean, concentration } = circularSummary(vals, comparison.period);
				s.meanDeg = mean;
				s.concentration = concentration;
			} else {
				const [p25, median, p75] = quartiles(vals);
				s.p25 = p25;
				s.median = median;
				s.p75 = p75;
			}
		}
		return s;
	});

	const format: ValueFormat =
		def?.type === "month" ? "month" : def?.type === "date" ? "dateTime" : "number";
	return {
		key,
		label: fieldLabel(key, def),
		comparison,
		format,
		valueScore,
		coverageScore,
		lowConfidence,
		groups,
	};
}

function finishCategorical(
	key: string,
	label: string,
	perGroup: Map<string, number>[],
	groupSizes: number[],
	labels: Record<string, string> | null | undefined,
): FieldDivergence {
	const present = perGroup.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
	const valueScore = cramersV(perGroup);
	const coverageScore = coverageV(groupSizes, present);
	const lowConfidence = isLowConfidence(present);

	const groups: GroupSummary[] = perGroup.map((counts, g) => {
		const total = present[g];
		const s = emptyGroup(groupSizes[g], total);
		if (total > 0) {
			const pairs = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
			s.top = pairs.slice(0, TOP_N).map(([val, c]) => ({
				label: labels?.[val] ?? val,
				freq: c / total,
			}));
		}
		return s;
	});

	return {
		key,
		label,
		comparison: { type: "categorical" },
		format: "number",
		valueScore,
		coverageScore,
		lowConfidence,
		groups,
	};
}

function categoricalField(
	key: string,
	labeled: Labeled[],
	numGroups: number,
	groupSizes: number[],
	def: ExtraFieldDef | undefined,
): FieldDivergence {
	const perGroup: Map<string, number>[] = Array.from({ length: numGroups }, () => new Map());
	for (const { group, loc } of labeled) {
		const v = categoryValue(loc, key);
		if (v !== null) perGroup[group].set(v, (perGroup[group].get(v) ?? 0) + 1);
	}
	return finishCategorical(key, fieldLabel(key, def), perGroup, groupSizes, def?.labels);
}

function tagField(
	tid: number,
	labeled: Labeled[],
	numGroups: number,
	groupSizes: number[],
	tagNames: Record<number, string>,
): FieldDivergence {
	const perGroup: Map<string, number>[] = Array.from({ length: numGroups }, () => new Map());
	for (const { group, loc } of labeled) {
		const k = loc.tags.includes(tid) ? "yes" : "no";
		perGroup[group].set(k, (perGroup[group].get(k) ?? 0) + 1);
	}
	const label = tagNames[tid] ?? `Tag ${tid}`;
	return finishCategorical(`tag:${tid}`, label, perGroup, groupSizes, null);
}

function sortKey(f: FieldDivergence): number {
	if (f.valueScore !== null && !f.lowConfidence) return 1 + f.valueScore;
	return f.coverageScore;
}

/** Rank metadata fields by how strongly they separate `numGroups` labeled groups. */
export function computeDivergence(
	labeled: Labeled[],
	numGroups: number,
	fieldDefs: Record<string, ExtraFieldDef>,
	tagNames: Record<number, string>,
): DisambiguateResult {
	const groupSizes = new Array(numGroups).fill(0);
	for (const { group } of labeled) groupSizes[group]++;

	const fields: FieldDivergence[] = [];

	for (const key of getWritableBuiltinKeys()) {
		const def = getFieldDef(key);
		fields.push(numericField(key, labeled, numGroups, groupSizes, resolvedComparison(def), def));
	}

	// Extra fields: registered defs plus any key discovered on the locations.
	const extraKeys = new Set<string>(Object.keys(fieldDefs));
	for (const { loc } of labeled) {
		if (loc.extra) for (const k of Object.keys(loc.extra)) extraKeys.add(k);
	}
	const sortedKeys = [...extraKeys].filter((k) => !EXCLUDED_FIELDS.has(k)).sort();
	for (const key of sortedKeys) {
		const def = fieldDefs[key] ?? sampleDef(key, labeled);
		const comparison = resolvedComparison(def);
		if (comparison.type === "categorical") {
			fields.push(categoricalField(key, labeled, numGroups, groupSizes, def));
		} else {
			fields.push(numericField(key, labeled, numGroups, groupSizes, comparison, def));
		}
	}

	// Tags as boolean categorical fields (always 100% coverage).
	const tagIds = new Set<number>();
	for (const { loc } of labeled) for (const t of loc.tags) tagIds.add(t);
	for (const tid of [...tagIds].sort((a, b) => a - b)) {
		fields.push(tagField(tid, labeled, numGroups, groupSizes, tagNames));
	}

	// Rank: confident value scores first (desc), then low-confidence/none by coverage.
	fields.sort((a, b) => sortKey(b) - sortKey(a));

	return { fields, groupSizes };
}
