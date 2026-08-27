// Selection disambiguation engine: given N groups of locations, rank metadata
// fields by how strongly they *separate* the groups (not by modal frequency).
// Works on per-group columns (one value per row per field) fetched from the store;
// no location ever reaches JS. Pure; tested in disambiguate.test.ts.

import type { ExtraFieldDef, ComparisonType } from "@/bindings.gen";
import {
	getFieldDef,
	fieldValueLabel,
	isWritableField,
	isBuiltinField,
	getBuiltinKeys,
} from "@/lib/data/fieldDefRegistry";
import { ymOrdinal } from "@/lib/util/date";
import { t, msg } from "@/lib/i18n";
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
/** The column carrying each row's tag ids. */
export const TAGS_COLUMN = "tags";

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

/** One group's rows as columns: `columns[key][i]` is row i's value (null when absent),
 *  and `columns[TAGS_COLUMN][i]` its tag ids. */
export interface GroupColumns {
	size: number;
	columns: Record<string, unknown[]>;
}

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

/** The columns an analysis needs: the writable built-ins, every declared field, every
 *  key present on the rows, and the tags. */
export function analysisColumns(
	fieldDefs: Record<string, ExtraFieldDef>,
	presentKeys: Iterable<string>,
): string[] {
	const keys = new Set<string>(getBuiltinKeys().filter(isWritableField));
	for (const k of Object.keys(fieldDefs)) keys.add(k);
	for (const k of presentKeys) keys.add(k);
	for (const k of EXCLUDED_FIELDS) keys.delete(k);
	keys.delete(TAGS_COLUMN);
	return [...keys, TAGS_COLUMN];
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

function column(group: GroupColumns, key: string): unknown[] {
	return group.columns[key] ?? [];
}

/** Synthetic def for an undeclared key, from the first present value (so an
 *  undeclared numeric field isn't mistaken for categorical). */
function sampleDef(key: string, groups: GroupColumns[]): ExtraFieldDef | undefined {
	for (const g of groups) {
		const v = column(g, key).find((x) => x != null);
		if (v != null) return { type: inferFieldType(v) };
	}
	return undefined;
}

/** ISO datetime string -> unix seconds, or null. */
function isoToUnix(s: string): number | null {
	const ms = Date.parse(s);
	return Number.isNaN(ms) ? null : ms / 1000;
}

/** Numeric reading of a field value (dates and months as ordinals). */
function numericValue(v: unknown): number | null {
	if (v == null) return null;
	if (typeof v === "number") return v;
	if (typeof v === "string") {
		const ts = isoToUnix(v);
		if (ts !== null) return ts;
		return ymOrdinal(v);
	}
	return null;
}

/** Canonical category string for a field value (null/missing -> null). */
function categoryValue(v: unknown): string | null {
	if (v == null) return null;
	if (typeof v === "string") return v;
	if (typeof v === "boolean" || typeof v === "number") return String(v);
	return JSON.stringify(v);
}

function fieldLabel(key: string, def: ExtraFieldDef | undefined): string {
	if (def?.label) return def.label;
	if (key === "heading") return msg("Heading");
	if (key === "pitch") return msg("Pitch");
	if (key === "zoom") return msg("Zoom");
	return key;
}

function isLowConfidence(present: number[]): boolean {
	return present.some((p) => p < MIN_PRESENT);
}

function numericField(
	key: string,
	groups: GroupColumns[],
	groupSizes: number[],
	comparison: ComparisonType,
	def: ExtraFieldDef | undefined,
): FieldDivergence {
	const perGroup: number[][] = groups.map((g) =>
		column(g, key)
			.map(numericValue)
			.filter((v): v is number => v !== null),
	);

	const present = perGroup.map((v) => v.length);
	const valueScore =
		comparison.type === "circular"
			? circularEta2(perGroup, comparison.period)
			: kruskalEps2(perGroup);
	const coverageScore = coverageV(groupSizes, present);
	const lowConfidence = isLowConfidence(present);

	const summaries: GroupSummary[] = perGroup.map((vals, g) => {
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
		groups: summaries,
	};
}

function finishCategorical(
	key: string,
	label: string,
	perGroup: Map<string, number>[],
	groupSizes: number[],
	def: ExtraFieldDef | undefined,
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
				label: fieldValueLabel(def, val),
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

function countValues(values: (string | null)[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const v of values) if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
	return counts;
}

function categoricalField(
	key: string,
	groups: GroupColumns[],
	groupSizes: number[],
	def: ExtraFieldDef | undefined,
): FieldDivergence {
	const perGroup = groups.map((g) => countValues(column(g, key).map(categoryValue)));
	return finishCategorical(key, fieldLabel(key, def), perGroup, groupSizes, def);
}

function tagIdsOf(group: GroupColumns): number[][] {
	return column(group, TAGS_COLUMN).map((v) => (Array.isArray(v) ? (v as number[]) : []));
}

function tagField(
	tid: number,
	groups: GroupColumns[],
	groupSizes: number[],
	tagNames: Record<number, string>,
): FieldDivergence {
	const perGroup = groups.map((g) =>
		countValues(tagIdsOf(g).map((tags) => (tags.includes(tid) ? "yes" : "no"))),
	);
	const label = tagNames[tid] ?? t("Tag {id}", { id: tid });
	return finishCategorical(`tag:${tid}`, label, perGroup, groupSizes, undefined);
}

function sortKey(f: FieldDivergence): number {
	if (f.valueScore !== null && !f.lowConfidence) return 1 + f.valueScore;
	return f.coverageScore;
}

/** Rank the fields present in `groups` by how strongly they separate the groups. */
export function computeDivergence(
	groups: GroupColumns[],
	fieldDefs: Record<string, ExtraFieldDef>,
	tagNames: Record<number, string>,
): DisambiguateResult {
	const groupSizes = groups.map((g) => g.size);
	const fields: FieldDivergence[] = [];

	const keys = new Set<string>();
	for (const g of groups) for (const k of Object.keys(g.columns)) keys.add(k);
	for (const k of Object.keys(fieldDefs)) keys.add(k);

	for (const key of getBuiltinKeys().filter(isWritableField)) {
		const def = getFieldDef(key);
		fields.push(numericField(key, groups, groupSizes, resolvedComparison(def), def));
	}

	const extraKeys = [...keys]
		.filter((k) => k !== TAGS_COLUMN && !isBuiltinField(k) && !EXCLUDED_FIELDS.has(k))
		.sort();
	for (const key of extraKeys) {
		const def = fieldDefs[key] ?? sampleDef(key, groups);
		const comparison = resolvedComparison(def);
		if (comparison.type === "categorical") {
			fields.push(categoricalField(key, groups, groupSizes, def));
		} else {
			fields.push(numericField(key, groups, groupSizes, comparison, def));
		}
	}

	// Tags as boolean categorical fields (always 100% coverage).
	const tagIds = new Set<number>();
	for (const g of groups) for (const tags of tagIdsOf(g)) for (const tid of tags) tagIds.add(tid);
	for (const tid of [...tagIds].sort((a, b) => a - b)) {
		fields.push(tagField(tid, groups, groupSizes, tagNames));
	}

	// Rank: confident value scores first (desc), then low-confidence/none by coverage.
	fields.sort((a, b) => sortKey(b) - sortKey(a));

	return { fields, groupSizes };
}
