/**
 * Pure planning logic for bulk metadata-field operations (rename / merge / delete / set).
 * These compute the `extra` replacement blobs and selection-reference rewrites; the store
 * orchestrates IPC, definitions, and persistence. Kept side-effect-free for testability.
 */

import type {
	Location,
	ExtraFieldType,
	Selection,
	SelectionProps,
	Update,
	LocationPatch_Deserialize as LocationPatch,
} from "@/bindings.gen";
import { buildSelection } from "@/store/selections";
import { isWritableBuiltinField, isBuiltinField } from "@/lib/data/fieldDefRegistry";

/** When a move target already holds a value, which field's value survives. */
export type MergeWinner = "from" | "to";

/** Shape a single field assignment into a patch: built-in keys patch the top-level
 *  field, every other key nests under `extra`. The one place that knows the difference. */
export function fieldPatch(key: string, value: unknown): Partial<Location> {
	return (
		isWritableBuiltinField(key) ? { [key]: value } : { extra: { [key]: value } }
	) as Partial<Location>;
}

/**
 * Rename/merge field `from` into `to`. Rename and merge are the same operation —
 * "rename" is just the case where no location already has `to`. When a location has
 * both keys, `winner` decides which value survives under the `to` key.
 * Returns updates only for locations that actually change.
 */
export function planFieldMove(
	locations: Location[],
	from: string,
	to: string,
	winner: MergeWinner,
): Update<LocationPatch>[] {
	if (from === to || !to) return [];
	const updates: Update<LocationPatch>[] = [];
	for (const loc of locations) {
		const extra = loc.extra;
		if (!extra || !(from in extra)) continue;
		const next = { ...extra };
		const fromVal = next[from];
		const hasTo = to in next;
		delete next[from];
		if (!hasTo || winner === "from") next[to] = fromVal;
		// winner === "to" with existing target: keep `next[to]` untouched
		updates.push({ id: loc.id, patch: { extra: next } });
	}
	return updates;
}

/** Remove field `key` from every location that has it. */
export function planFieldDelete(locations: Location[], key: string): Update<LocationPatch>[] {
	const updates: Update<LocationPatch>[] = [];
	for (const loc of locations) {
		if (!loc.extra || !(key in loc.extra)) continue;
		const next = { ...loc.extra };
		delete next[key];
		updates.push({ id: loc.id, patch: { extra: next } });
	}
	return updates;
}

/**
 * Apply `patch` to every location, skipping those it wouldn't change. `extra` is
 * merged into each location's existing extra; all other keys overwrite directly.
 * The caller asserts intent by how it shapes `patch` (e.g. `{ heading }` vs
 * `{ extra: { foo } }`); this function holds no notion of which fields are which.
 */
export function planFieldSet(
	locations: Location[],
	patch: Partial<Location>,
): Update<LocationPatch>[] {
	const updates: Update<LocationPatch>[] = [];
	for (const loc of locations) {
		if (!changesLocation(loc, patch)) continue;
		const next = patch.extra
			? { ...patch, extra: { ...(loc.extra ?? {}), ...patch.extra } }
			: patch;
		updates.push({ id: loc.id, patch: next });
	}
	return updates;
}

/** True if applying `patch` would alter `loc`. Compares requested `extra` keys
 *  against the existing extra; all other keys against the top-level field. */
function changesLocation(loc: Location, patch: Partial<Location>): boolean {
	for (const [k, v] of Object.entries(patch)) {
		if (k === "extra") {
			for (const [ek, ev] of Object.entries(v as Record<string, unknown>)) {
				if ((loc.extra ?? {})[ek] !== ev) return true;
			}
		} else if ((loc as Record<string, unknown>)[k] !== v) {
			return true;
		}
	}
	return false;
}

// --- Field expressions ("set X = f(Y)" bulk op) -------------------------------
// A deliberately tiny numeric expression language: field references, arithmetic,
// parens, and a few functions. Scope (WHERE) belongs to selections and multiple
// assignments are repeat runs -- the language stays one expression wide.

type FieldExpr =
	| { kind: "num"; value: number }
	| { kind: "field"; name: string }
	| { kind: "neg"; arg: FieldExpr }
	| { kind: "bin"; op: "+" | "-" | "*" | "/" | "%"; left: FieldExpr; right: FieldExpr }
	| { kind: "call"; fn: string; args: FieldExpr[] };

const EXPR_FNS: Record<string, { arity: number; apply: (args: number[]) => number }> = {
	mod: { arity: 2, apply: ([x, n]) => ((x % n) + n) % n },
	clamp: { arity: 3, apply: ([x, lo, hi]) => Math.min(hi, Math.max(lo, x)) },
	abs: { arity: 1, apply: ([x]) => Math.abs(x) },
	min: { arity: 2, apply: ([a, b]) => Math.min(a, b) },
	max: { arity: 2, apply: ([a, b]) => Math.max(a, b) },
	round: { arity: 1, apply: ([x]) => Math.round(x) },
	floor: { arity: 1, apply: ([x]) => Math.floor(x) },
};

type Token = { t: "num"; v: number } | { t: "ident"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (/[0-9.]/.test(c)) {
			const m = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
			if (!m) throw new Error(`Invalid number at position ${i}`);
			tokens.push({ t: "num", v: Number(m[0]) });
			i += m[0].length;
			continue;
		}
		if (/[A-Za-z_]/.test(c)) {
			const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
			tokens.push({ t: "ident", v: m[0] });
			i += m[0].length;
			continue;
		}
		if ("+-*/%(),".includes(c)) {
			tokens.push({ t: "op", v: c });
			i++;
			continue;
		}
		throw new Error(`Unexpected character "${c}" at position ${i}`);
	}
	return tokens;
}

/** Parse a field expression, e.g. `mod(sunAzimuth + 180, 360)`. Throws on syntax errors. */
export function parseFieldExpr(src: string): FieldExpr {
	const tokens = tokenize(src);
	let pos = 0;
	const peek = () => tokens[pos];
	const isOp = (v: string) => peek()?.t === "op" && (peek() as { v: string }).v === v;
	const expectOp = (v: string) => {
		if (!isOp(v)) throw new Error(`Expected "${v}"`);
		pos++;
	};

	function parseAdditive(): FieldExpr {
		let left = parseMultiplicative();
		while (isOp("+") || isOp("-")) {
			const op = (tokens[pos++] as { v: "+" | "-" }).v;
			left = { kind: "bin", op, left, right: parseMultiplicative() };
		}
		return left;
	}
	function parseMultiplicative(): FieldExpr {
		let left = parseUnary();
		while (isOp("*") || isOp("/") || isOp("%")) {
			const op = (tokens[pos++] as { v: "*" | "/" | "%" }).v;
			left = { kind: "bin", op, left, right: parseUnary() };
		}
		return left;
	}
	function parseUnary(): FieldExpr {
		if (isOp("-")) {
			pos++;
			return { kind: "neg", arg: parseUnary() };
		}
		return parsePrimary();
	}
	function parsePrimary(): FieldExpr {
		const tok = peek();
		if (!tok) throw new Error("Unexpected end of expression");
		if (tok.t === "num") {
			pos++;
			return { kind: "num", value: tok.v };
		}
		if (tok.t === "ident") {
			pos++;
			if (isOp("(")) {
				const fn = EXPR_FNS[tok.v];
				if (!fn) throw new Error(`Unknown function "${tok.v}"`);
				pos++;
				const args: FieldExpr[] = [];
				if (!isOp(")")) {
					args.push(parseAdditive());
					while (isOp(",")) {
						pos++;
						args.push(parseAdditive());
					}
				}
				expectOp(")");
				if (args.length !== fn.arity)
					throw new Error(`${tok.v}() takes ${fn.arity} argument${fn.arity === 1 ? "" : "s"}`);
				return { kind: "call", fn: tok.v, args };
			}
			return { kind: "field", name: tok.v };
		}
		if (isOp("(")) {
			pos++;
			const inner = parseAdditive();
			expectOp(")");
			return inner;
		}
		throw new Error(`Unexpected "${(tok as { v: string }).v}"`);
	}

	const expr = parseAdditive();
	if (pos < tokens.length) {
		const tok = tokens[pos] as { v?: string };
		throw new Error(`Unexpected "${tok.v ?? "token"}" after expression`);
	}
	return expr;
}

/** Read field `key` from a location: built-in keys read the top-level property,
 *  everything else reads from `extra`. The read-side mirror of `fieldPatch`. */
export function fieldValue(loc: Location, key: string): unknown {
	return isBuiltinField(key) ? (loc as unknown as Record<string, unknown>)[key] : loc.extra?.[key];
}

/** Evaluate an expression against one location. Returns null when any referenced
 *  field is missing/non-numeric or the result is not finite (skip that location). */
export function evalFieldExpr(expr: FieldExpr, loc: Location): number | null {
	const v = evalNode(expr, loc);
	return v != null && Number.isFinite(v) ? v : null;
}

function evalNode(expr: FieldExpr, loc: Location): number | null {
	switch (expr.kind) {
		case "num":
			return expr.value;
		case "field": {
			const v = fieldValue(loc, expr.name);
			return typeof v === "number" ? v : null;
		}
		case "neg": {
			const v = evalNode(expr.arg, loc);
			return v == null ? null : -v;
		}
		case "bin": {
			const l = evalNode(expr.left, loc);
			const r = evalNode(expr.right, loc);
			if (l == null || r == null) return null;
			switch (expr.op) {
				case "+":
					return l + r;
				case "-":
					return l - r;
				case "*":
					return l * r;
				case "/":
					return l / r;
				case "%":
					return l % r;
			}
			break;
		}
		case "call": {
			const args = expr.args.map((a) => evalNode(a, loc));
			if (args.some((a) => a == null)) return null;
			return EXPR_FNS[expr.fn].apply(args as number[]);
		}
	}
	return null;
}

/** Plan per-location assignments `key = expr(loc)`. Locations whose expression
 *  can't evaluate are counted in `skipped`; unchanged locations are dropped. */
export function planFieldExpr(
	locations: Location[],
	key: string,
	expr: FieldExpr,
): { updates: Update<LocationPatch>[]; skipped: number } {
	const updates: Update<LocationPatch>[] = [];
	let skipped = 0;
	for (const loc of locations) {
		const v = evalFieldExpr(expr, loc);
		if (v == null) {
			skipped++;
			continue;
		}
		const planned = planFieldSet([loc], fieldPatch(key, v));
		if (planned.length > 0) updates.push(planned[0]);
	}
	return { updates, skipped };
}

/**
 * Rewrite Filter `field` references in a selection tree: `from` → `to`, or drop the
 * Filter when `to` is null (field deleted). Composites collapse if emptied, or unwrap
 * to their sole survivor (matching the rest of the selection engine's semantics).
 */
function rewriteSelection(sel: Selection, from: string, to: string | null): Selection | null {
	const p = sel.props;
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
		return buildSelection({ ...p, selections: children } as SelectionProps);
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
	{ id: "value", label: "Value", appliesTo: ["string", "enum", "number", "month"] },
	{ id: "year", label: "Year", appliesTo: ["date", "month"], needsTz: true },
	{ id: "yearMonth", label: "Year-month", appliesTo: ["date"], needsTz: true },
	{ id: "day", label: "Exact day", appliesTo: ["date"], needsTz: true },
	{ id: "monthOfYear", label: "Month of year", appliesTo: ["date", "month"], needsTz: true },
	{ id: "hourOfDay", label: "Hour of day", appliesTo: ["date"], needsTz: true },
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
	return hasRange ? [{ id: RANGE_ID, label: "Range" }, ...projs] : projs;
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
