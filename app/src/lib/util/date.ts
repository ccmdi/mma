/** Month names and hand-typed date parsing. Epoch encoding routes through the
 *  wall-clock codec in `fieldOps` (`dateParts`/`partsToEpoch`) — never encode here. */

import { partsToEpoch } from "@/lib/data/fieldOps";

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
