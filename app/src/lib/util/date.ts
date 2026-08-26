/** Month names and hand-typed date parsing. Epoch encoding routes through the
 *  wall-clock codec in `fieldOps` (`dateParts`/`partsToEpoch`) — never encode here. */


export const MONTHS = {
	short: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
	full: [
		"January",
		"February",
		"March",
		"April",
		"May",
		"June",
		"July",
		"August",
		"September",
		"October",
		"November",
		"December",
	],
} as const;

// Calendar order for full month-name keys (e.g. month-of-year partition groups)
export function compareMonthOrder(a: string, b: string): number {
	const order: readonly string[] = MONTHS.full;
	return order.indexOf(a) - order.indexOf(b);
}

/** 1-based month from a name ("Jun", "june") or number token ("6", "06"). */
function monthToken(tok: string): number | null {
	if (/^\d{1,2}$/.test(tok)) {
		const n = Number(tok);
		return n >= 1 && n <= 12 ? n : null;
	}
	const lower = tok.toLowerCase();
	if (lower.length < 3) return null;
	const idx = MONTHS.full.findIndex((m) => m.toLowerCase().startsWith(lower));
	return idx === -1 ? null : idx + 1;
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

export function ymParse(s: string): { y: number; m: number } | null {
	const m = /^(\d{4})-(\d{2})$/.exec(s);
	if (!m) return null;
	const mo = Number(m[2]);
	return mo >= 1 && mo <= 12 ? { y: Number(m[1]), m: mo } : null;
}

export function ymFormat(y: number, m: number): string {
	return `${String(y).padStart(4, "0")}-${pad2(m)}`;
}

export function ymFromDate(d: Date): string {
	return ymFormat(d.getFullYear(), d.getMonth() + 1);
}

/** First of the month, local frame. */
export function ymToDate(s: string): Date | null {
	const p = ymParse(s);
	return p ? new Date(p.y, p.m - 1) : null;
}

/** A civil `YYYY-MM-DD` as the first of its month, local frame. Pano capture dates are
 *  month-precision, and every reader of one displays or compares it by month. */
export function civilToDate(s: string): Date | null {
	return ymToDate(s.slice(0, 7));
}

/** Comparable month ordinal (`y*12 + m-1`). */
export function ymOrdinal(s: string): number | null {
	const p = ymParse(s);
	return p ? p.y * 12 + (p.m - 1) : null;
}

export function ymFromOrdinal(i: number): string {
	return ymFormat(Math.floor(i / 12), (i % 12) + 1);
}

export interface TypedDateOpts {
	mode: "date" | "month";
	anyYear?: boolean;
	anyTime?: boolean;
	/** Accept a trailing "HH:MM" on full dates (datetime filters). */
	withTime?: boolean;
	wallClock?: boolean;
}

/** Parse a hand-typed date into the DatePicker wire format for the given mode:
 *  "HH:MM" (anyTime), "MM" (month+anyYear), "YYYY-MM" (month), "MM-DD" (date+anyYear),
 *  or a Unix-seconds epoch string (date, encoded via `partsToEpoch`). Liberal input:
 *  ISO ("2019-06-03"), US ("6/3/2019"), month names ("Jun 3 2019", "3 Jun 2019").
 *  Ambiguous all-numeric dates read month-first, matching the en-US display.
 *  Returns null when the text doesn't parse — callers keep the previous value. */
export function parseTypedDate(text: string, opts: TypedDateOpts): string | null {
	const t = text.trim().replace(/,/g, " ").replace(/\s+/g, " ");
	if (!t) return null;

	if (opts.anyTime) {
		const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(t);
		if (!m) return null;
		const h = Number(m[1]);
		const mi = Number(m[2] ?? 0);
		return h <= 23 && mi <= 59 ? `${pad2(h)}:${pad2(mi)}` : null;
	}

	if (opts.mode === "month") {
		if (opts.anyYear) {
			const mo = monthToken(t);
			return mo == null ? null : pad2(mo);
		}
		let m = /^(\d{4})[-/. ]([A-Za-z]+|\d{1,2})$/.exec(t); // 2019-06, 2019 Jun
		if (m) {
			const mo = monthToken(m[2]);
			return mo == null ? null : `${m[1]}-${pad2(mo)}`;
		}
		m = /^([A-Za-z]+|\d{1,2})[-/. ](\d{4})$/.exec(t); // Jun 2019, 06/2019
		if (m) {
			const mo = monthToken(m[1]);
			return mo == null ? null : `${m[2]}-${pad2(mo)}`;
		}
		return null;
	}

	// mode === "date"
	if (opts.anyYear) {
		let mo: number | null = null;
		let d = NaN;
		let m = /^(\d{1,2})[-/. ](\d{1,2})$/.exec(t); // 06-03 — month first, matching display
		if (m) {
			mo = monthToken(m[1]);
			d = Number(m[2]);
		} else if ((m = /^([A-Za-z]+) (\d{1,2})$/.exec(t))) {
			mo = monthToken(m[1]);
			d = Number(m[2]);
		} else if ((m = /^(\d{1,2}) ([A-Za-z]+)$/.exec(t))) {
			mo = monthToken(m[2]);
			d = Number(m[1]);
		}
		return mo != null && d >= 1 && d <= 31 ? `${pad2(mo)}-${pad2(d)}` : null;
	}

	let rest = t;
	let h = 0;
	let mi = 0;
	const timeMatch = /\s(\d{1,2}):(\d{2})$/.exec(rest);
	if (timeMatch) {
		if (!opts.withTime) return null;
		h = Number(timeMatch[1]);
		mi = Number(timeMatch[2]);
		if (h > 23 || mi > 59) return null;
		rest = rest.slice(0, timeMatch.index).trim();
	}

	let y = NaN;
	let mo: number | null = null;
	let d = NaN;
	let m = /^(\d{4})[-/. ](\d{1,2})[-/. ](\d{1,2})$/.exec(rest); // 2019-06-03
	if (m) {
		y = Number(m[1]);
		mo = monthToken(m[2]);
		d = Number(m[3]);
	} else if ((m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4})$/.exec(rest))) {
		// 6/3/2019
		y = Number(m[3]);
		mo = monthToken(m[1]);
		d = Number(m[2]);
	} else if ((m = /^([A-Za-z]+) (\d{1,2}) (\d{4})$/.exec(rest))) {
		// Jun 3 2019
		y = Number(m[3]);
		mo = monthToken(m[1]);
		d = Number(m[2]);
	} else if ((m = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(rest))) {
		// 3 Jun 2019
		y = Number(m[3]);
		mo = monthToken(m[2]);
		d = Number(m[1]);
	}
	if (mo == null || !(d >= 1 && d <= 31) || isNaN(y) || y < 1900 || y > 2200) return null;
	return String(partsToEpoch({ y, mo: mo - 1, d, h, mi }, opts.wallClock ?? false));
}

// --- Filter date windows: the wall-clock vs local frame codec and window stepping. ---

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
