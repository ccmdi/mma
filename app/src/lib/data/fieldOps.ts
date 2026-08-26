/**
 * Field helpers for the selection-reference rewrites that follow a field move, the
 * partition projections, and the date-window codecs. Every bulk field mutation (set,
 * expression, rename/merge, delete) runs in Rust (`store_apply_field_op`); nothing here
 * plans per-location patches. Side-effect-free.
 */

import type { Location, ExtraFieldType, Selection, Selector } from "@/bindings.gen";
import { buildSelection } from "@/store/selections";
import { isBuiltinField } from "@/lib/data/fieldDefRegistry";
import { msg } from "@/lib/i18n";

/** Read field `key` from a location: built-in keys read the top-level property,
 *  everything else reads from `extra`. */
export function fieldValue(loc: Location, key: string): unknown {
	return isBuiltinField(key) ? (loc as unknown as Record<string, unknown>)[key] : loc.extra?.[key];
}

/** Every `extra` key present on any of `locs`. */
export function extraKeysOf(locs: readonly Location[]): Set<string> {
	const keys = new Set<string>();
	for (const loc of locs) {
		if (loc.extra) for (const k of Object.keys(loc.extra)) keys.add(k);
	}
	return keys;
}

/**
 * Rewrite Filter `field` references in a selection tree: `from` → `to`, or drop the
 * Filter when `to` is null (field deleted). Composites collapse if emptied, or unwrap
 * to their sole survivor (matching the rest of the selection engine's semantics).
 */
function rewriteSelection(sel: Selection, from: string, to: string | null): Selection | null {
	const p = sel.selector;
	if (p.type === "Filter") {
		if (p.field !== from) return sel;
		return to === null ? null : buildSelection({ ...p, field: to });
	}
	if ("selections" in p) {
		const children = p.selections
			.map((c) => rewriteSelection(c, from, to))
			.filter((c): c is Selection => c !== null);
		if (children.length === 0) return null;
		if (children.length === 1 && p.type !== "Invert") return children[0];
		return buildSelection({ ...p, selections: children } as Selector);
	}
	return sel;
}

/** Calendar digits of a timestamp in a clock frame. */
interface DateParts {
	y: number;
	mo: number; // 0-based, as Date
	d: number;
	h: number;
	mi: number;
	s: number;
}

/** Read a Unix-seconds timestamp as calendar digits. `wallClock` = location-timezone
 *  mode, where the digits are encoded in a UTC frame so they survive unshifted by the
 *  viewer's timezone; otherwise the viewer's local frame. This pair is the ONLY place
 *  the frame fork (UTC vs local getters) may exist — never branch on getters elsewhere:
 *  one wrong getter shifts bounds silently and is invisible on UTC-running CI. */
export function dateParts(v: number, wallClock: boolean): DateParts {
	const dt = new Date(v * 1000);
	return wallClock
		? {
				y: dt.getUTCFullYear(),
				mo: dt.getUTCMonth(),
				d: dt.getUTCDate(),
				h: dt.getUTCHours(),
				mi: dt.getUTCMinutes(),
				s: dt.getUTCSeconds(),
			}
		: {
				y: dt.getFullYear(),
				mo: dt.getMonth(),
				d: dt.getDate(),
				h: dt.getHours(),
				mi: dt.getMinutes(),
				s: dt.getSeconds(),
			};
}

/** Encode calendar digits back to Unix seconds in the given frame. Out-of-range fields
 *  roll over calendar-aware (e.g. `d + 1` past month end), same as `Date`. */
export function partsToEpoch(
	p: { y: number; mo: number; d: number; h?: number; mi?: number; s?: number },
	wallClock: boolean,
): number {
	const { y, mo, d, h = 0, mi = 0, s = 0 } = p;
	const ms = wallClock ? Date.UTC(y, mo, d, h, mi, s) : new Date(y, mo, d, h, mi, s).getTime();
	return Math.floor(ms / 1000);
}

/** A date pick denotes a period, not an instant: a day in date-only mode, a minute in
 *  datetime mode (the picker can't express seconds). Used as an upper bound (or gt/lte
 *  operand) the pick means the period's END, computed calendar-aware (next period start
 *  - 1s) rather than by adding a constant: +86399 is wrong on DST-transition days, and
 *  flooring first makes the expansion idempotent so re-submitting an edited filter
 *  doesn't drift. */
export function pickPeriodEnd(
	v: number,
	granularity: "day" | "minute",
	wallClock: boolean,
): number {
	if (granularity === "minute") return v - (v % 60) + 59;
	const p = dateParts(v, wallClock);
	return partsToEpoch({ y: p.y, mo: p.mo, d: p.d + 1 }, wallClock) - 1;
}

/** True when the timestamp carries a time-of-day (is not exactly midnight). A midnight
 *  bound is a day-grain pick — the UI has always displayed midnight as a bare date, and
 *  the picker's cleared-time state encodes midnight — so period expansion treats
 *  midnight as "the day" and anything else as "the minute". */
export function hasTimeOfDay(v: number, wallClock: boolean): boolean {
	const p = dateParts(v, wallClock);
	return p.h !== 0 || p.mi !== 0 || p.s !== 0;
}

function addDays(v: number, days: number, wallClock: boolean): number {
	const p = dateParts(v, wallClock);
	return partsToEpoch({ y: p.y, mo: p.mo, d: p.d + days }, wallClock);
}

/** A between filter is a window; stepping translates the window by its own span
 *  (tiling — the next window starts where this one ends, no overlap). Returns the
 *  shifted bounds, or null when the filter isn't a bounded window (gt/has/enum eq,
 *  anyYear/anyTime shapes). Day windows are calendar-aware (DST-safe); month windows
 *  shift the "YYYY-MM" strings; numeric windows translate by span (shared edge). */
export function stepFilterWindow(
	fieldType: string | undefined,
	op: string,
	value: unknown,
	value2: unknown,
	dir: 1 | -1,
	wallClock = false,
): { value: number | string; value2?: number | string } | null {
	const MONTH = /^(\d{4})-(\d{2})$/;
	if (fieldType === "month" && typeof value === "string") {
		const lo = MONTH.exec(value);
		if (!lo) return null;
		const idx = (m: RegExpExecArray) => Number(m[1]) * 12 + (Number(m[2]) - 1);
		const fmt = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
		if (op === "eq") return { value: fmt(idx(lo) + dir) };
		if (op === "between" && typeof value2 === "string") {
			const hi = MONTH.exec(value2);
			if (!hi) return null;
			const span = idx(hi) - idx(lo) + 1;
			if (span < 1) return null;
			return { value: fmt(idx(lo) + dir * span), value2: fmt(idx(hi) + dir * span) };
		}
		return null;
	}
	if (fieldType === "date" && op === "between") {
		const lo = Number(value);
		const hi = Number(value2);
		if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null;
		if (!hasTimeOfDay(lo, wallClock) && !hasTimeOfDay(hi + 1, wallClock)) {
			// Day-grain window: [midnight, day-end]. Shift by its day count.
			const days = Math.round((hi + 1 - lo) / 86400);
			const newLo = addDays(lo, dir * days, wallClock);
			return {
				value: newLo,
				value2: pickPeriodEnd(addDays(newLo, days - 1, wallClock), "day", wallClock),
			};
		}
		const span = hi - lo + 1;
		return { value: lo + dir * span, value2: hi + dir * span };
	}
	if (fieldType === "number" && op === "between") {
		const lo = Number(value);
		const hi = Number(value2);
		if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
		const span = hi - lo;
		return { value: lo + dir * span, value2: hi + dir * span };
	}
	return null;
}

// --- Tag projections: the catalog of grouping keys --------------------------------
// id/label/applicability only — drives the dropdowns. Key derivation runs in Rust
// (`selections.rs` KeySpec); ids line up 1:1 with the Rust `DatePart` variants.

interface FieldProjection {
	id: string;
	label: string;
	appliesTo: ExtraFieldType[];
	/** Date projections read in the location's own timezone when set — surfaces a toggle. */
	needsTz?: boolean;
}

const TAG_PROJECTIONS: FieldProjection[] = [
	{ id: "value", label: msg("Value"), appliesTo: ["string", "enum", "number", "month"] },
	{ id: "year", label: msg("Year"), appliesTo: ["date", "month"], needsTz: true },
	{ id: "yearMonth", label: msg("Year-month"), appliesTo: ["date"], needsTz: true },
	{ id: "day", label: msg("Exact day"), appliesTo: ["date"], needsTz: true },
	{ id: "monthOfYear", label: msg("Month of year"), appliesTo: ["date", "month"], needsTz: true },
	{ id: "hourOfDay", label: msg("Hour of day"), appliesTo: ["date"], needsTz: true },
];

/** Projections valid for a field type, in display order (first = dialog default). */
export function projectionsForType(type: ExtraFieldType): FieldProjection[] {
	return TAG_PROJECTIONS.filter((p) => p.appliesTo.includes(type));
}

// --- Partition: grouping runs in Rust (`store_partition`); these are the JS-side glue. ---

/** The synthetic "Range" option: numeric binning, which isn't a stateless projection. */
export const RANGE_ID = "range";

/** Dropdown options for a partition: the projection catalog plus "Range" for numbers (and
 *  dates too when `rangeForDates`). */
export function partitionKeyOptions(
	type: ExtraFieldType,
	rangeForDates: boolean,
): { id: string; label: string }[] {
	const projs = projectionsForType(type).map((p) => ({ id: p.id, label: p.label }));
	const hasRange = type === "number" || (rangeForDates && type === "date");
	return hasRange ? [{ id: RANGE_ID, label: msg("Range") }, ...projs] : projs;
}

export function rewriteSelectionFields(
	selections: Selection[],
	from: string,
	to: string | null,
): Selection[] {
	return selections
		.map((s) => rewriteSelection(s, from, to))
		.filter((s): s is Selection => s !== null);
}
