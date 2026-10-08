// Selection disambiguation engine: given N groups of locations, rank metadata
// fields by how strongly they *separate* the groups (not by modal frequency).
// Works on per-group value counts from the store; no location ever reaches JS.

import type { Selector } from "@/types";
import type { CountBy, FieldDef, ComparisonType } from "@/bindings.gen";
import { createFieldDef } from "@/types";
import {
	getFieldDef,
	fieldLabel,
	fieldValueLabel,
	isWritableField,
	isBuiltinField,
	getBuiltinKeys,
} from "@/lib/data/fieldDefRegistry";
import { all, any, not } from "@/store/selections";
import { ymOrdinal } from "@/lib/util/date";
import { t } from "@/lib/i18n";
import {
	kruskalEps2,
	circularEta2,
	circularSummary,
	cramersV,
	coverageV,
	quartiles,
	total,
	type Tally,
} from "./stats";

/** A group must have at least this many present values for a field before its
 *  value score is trusted; below this the field is flagged low-confidence. */
const MIN_PRESENT = 8;
/** How many top categories to surface per group in a categorical summary. */
const TOP_N = 3;
/** Fields excluded from analysis: they encode the location/answer itself rather
 *  than an in-round visual tell, so flagging them as "divergent" is pointless. */
const EXCLUDED_FIELDS = new Set(["countryCode", "timezone", "panoId"]);
/** The field carrying each location's tag ids. */
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

/** One group's size and, per analyzed field, its value counts (a list field counts each member). */
export interface GroupCounts {
	size: number;
	counts: Record<string, CountBy>;
}

/** Each group narrowed to the locations no other group holds. */
export function exclusiveGroups(selectors: Selector[]): Selector[] {
	return selectors.map((s, i) => all(s, not(any(...selectors.filter((_, j) => j !== i)))));
}

/** The fields an analysis needs: the writable built-ins, every declared field, every
 *  key present on the locations, and the tags. */
export function analysisColumns(
	fieldDefs: Record<string, FieldDef>,
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
export function resolvedComparison(def: FieldDef | undefined): ComparisonType {
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

const MONTH = /^\d{4}-\d{2}$/;

/** Infer a field type from a sample value: numbers -> number, `YYYY-MM` -> month, else string. */
function inferFieldType(value: string): FieldDef["type"] {
	if (MONTH.test(value)) return "month";
	if (Number.isFinite(Number(value))) return "number";
	return "string";
}

function valueCounts(group: GroupCounts, key: string): [string, number][] {
	return group.counts[key]?.counts ?? [];
}

/** Synthetic def for an undeclared key, from the first present value (so an
 *  undeclared numeric field isn't mistaken for categorical). */
function sampleDef(key: string, groups: GroupCounts[]): FieldDef | undefined {
	for (const g of groups) {
		const [first] = valueCounts(g, key);
		if (first) return createFieldDef(inferFieldType(first[0]));
	}
	return undefined;
}

/** Numeric reading of a counted value: months as ordinals, dates as unix seconds. */
function numericValue(value: string, def: FieldDef | undefined): number | null {
	if (def?.type === "month") return ymOrdinal(value);
	const n = Number(value);
	if (value !== "" && Number.isFinite(n)) return n;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms / 1000;
}

function isLowConfidence(present: number[]): boolean {
	return present.some((p) => p < MIN_PRESENT);
}

function numericField(
	key: string,
	groups: GroupCounts[],
	groupSizes: number[],
	comparison: ComparisonType,
	def: FieldDef | undefined,
): FieldDivergence {
	const perGroup: Tally[] = groups.map((g) =>
		valueCounts(g, key).flatMap(([value, count]): Tally => {
			const n = numericValue(value, def);
			return n === null ? [] : [[n, count]];
		}),
	);

	const present = perGroup.map(total);
	const valueScore =
		comparison.type === "circular"
			? circularEta2(perGroup, comparison.period)
			: kruskalEps2(perGroup);
	const coverageScore = coverageV(groupSizes, present);
	const lowConfidence = isLowConfidence(present);

	const summaries: GroupSummary[] = perGroup.map((tally, g) => {
		const s = emptyGroup(groupSizes[g], present[g]);
		if (present[g] > 0) {
			if (comparison.type === "circular") {
				const { mean, concentration } = circularSummary(tally, comparison.period);
				s.meanDeg = mean;
				s.concentration = concentration;
			} else {
				const [p25, median, p75] = quartiles(tally);
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
		label: fieldLabel(key),
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
	present: number[],
	groupSizes: number[],
	def: FieldDef | undefined,
): FieldDivergence {
	const valueScore = cramersV(perGroup);
	const coverageScore = coverageV(groupSizes, present);
	const lowConfidence = isLowConfidence(present);

	const groups: GroupSummary[] = perGroup.map((counts, g) => {
		const s = emptyGroup(groupSizes[g], present[g]);
		if (present[g] > 0) {
			const pairs = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
			s.top = pairs.slice(0, TOP_N).map(([val, c]) => ({
				label: fieldValueLabel(def, val),
				freq: c / present[g],
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
	groups: GroupCounts[],
	groupSizes: number[],
	def: FieldDef | undefined,
): FieldDivergence {
	const perGroup = groups.map((g) => new Map(valueCounts(g, key)));
	const present = groups.map((g) => g.counts[key]?.covered ?? 0);
	return finishCategorical(key, fieldLabel(key), perGroup, present, groupSizes, def);
}

function tagField(
	tid: string,
	groups: GroupCounts[],
	groupSizes: number[],
	tagNames: Record<number, string>,
): FieldDivergence {
	const perGroup = groups.map((g, i) => {
		const tagged = new Map(valueCounts(g, TAGS_COLUMN)).get(tid) ?? 0;
		return new Map([
			["yes", tagged],
			["no", groupSizes[i] - tagged],
		]);
	});
	const label = tagNames[Number(tid)] ?? t("Tag {id}", { id: tid });
	return finishCategorical(`tag:${tid}`, label, perGroup, groupSizes, groupSizes, undefined);
}

function sortKey(f: FieldDivergence): number {
	if (f.valueScore !== null && !f.lowConfidence) return 1 + f.valueScore;
	return f.coverageScore;
}

/** Rank the fields counted in `groups` by how strongly they separate the groups. */
export function computeDivergence(
	groups: GroupCounts[],
	fieldDefs: Record<string, FieldDef>,
	tagNames: Record<number, string>,
): DisambiguateResult {
	const groupSizes = groups.map((g) => g.size);
	const fields: FieldDivergence[] = [];

	const keys = new Set<string>();
	for (const g of groups) for (const k of Object.keys(g.counts)) keys.add(k);
	keys.delete(TAGS_COLUMN);
	for (const k of EXCLUDED_FIELDS) keys.delete(k);
	const builtins = getBuiltinKeys().filter((k) => keys.has(k));
	const extras = [...keys].filter((k) => !isBuiltinField(k)).sort();

	for (const key of [...builtins, ...extras]) {
		const def = fieldDefs[key] ?? getFieldDef(key) ?? sampleDef(key, groups);
		const comparison = resolvedComparison(def);
		if (comparison.type === "categorical") {
			fields.push(categoricalField(key, groups, groupSizes, def));
		} else {
			fields.push(numericField(key, groups, groupSizes, comparison, def));
		}
	}

	// Tags as boolean categorical fields (always 100% coverage).
	const tagIds = new Set<string>();
	for (const g of groups) for (const [tid] of valueCounts(g, TAGS_COLUMN)) tagIds.add(tid);
	for (const tid of [...tagIds].sort((a, b) => Number(a) - Number(b))) {
		fields.push(tagField(tid, groups, groupSizes, tagNames));
	}

	// Rank: confident value scores first (desc), then low-confidence/none by coverage.
	fields.sort((a, b) => sortKey(b) - sortKey(a));

	return { fields, groupSizes };
}
