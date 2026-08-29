import { getLocale, t } from "@/lib/i18n";
import { getSettings } from "@/store/settings";

/** Product name -- never translated. */
export const APP_NAME = "Map Making App";

/** Resolves against the active locale on first use rather than at import time, so these are
 *  correct however early a module reaches for them. */
export function localeFormat<V>(build: (locale: string) => { format: (value: V) => string }) {
	let cached: { locale: string; formatter: { format: (value: V) => string } } | null = null;
	return {
		format(value: V): string {
			const locale = getLocale();
			if (cached?.locale !== locale) cached = { locale, formatter: build(locale) };
			return cached.formatter.format(value);
		},
	};
}

export const fmt = localeFormat<number>((l) => new Intl.NumberFormat(l));
export const dateFmt = localeFormat<Date | number>(
	(l) => new Intl.DateTimeFormat(l, { year: "numeric", month: "short" }),
);
export const shortDateFmt = localeFormat<Date | number>(
	(l) => new Intl.DateTimeFormat(l, { month: "short", day: "numeric", year: "numeric" }),
);
export const dayMonthFmt = localeFormat<Date | number>(
	(l) => new Intl.DateTimeFormat(l, { month: "short", day: "numeric" }),
);
export const dateTimeFmt = localeFormat<Date | number>(
	(l) => new Intl.DateTimeFormat(l, { dateStyle: "medium", timeStyle: "short" }),
);

const regionFmt = localeFormat<string>((l) => {
	const names = new Intl.DisplayNames([l], { type: "region" });
	return {
		format: (code) => {
			try {
				return names.of(code) ?? code;
			} catch {
				return code;
			}
		},
	};
});

/** Localised country name for an ISO 3166-1 alpha-2 code; the code itself if unknown. */
export function countryName(code: string): string {
	return regionFmt.format(code);
}

// Fixed to UTC so the month index can't slip a boundary in a negative-offset zone.
const monthFmt = localeFormat<Date | number>(
	(l) => new Intl.DateTimeFormat(l, { month: "short", timeZone: "UTC" }),
);

/** Localised short month name for a 0-based index. Display only -- `MONTHS` in `util/date`
 *  stays English because it also backs date *parsing*. */
export function monthShort(index: number): string {
	return monthFmt.format(Date.UTC(2000, index, 1));
}

/** Location timestamps are Unix seconds; JS Date wants milliseconds. */
export function locDate(secs: number): Date {
	return new Date(secs * 1000);
}

/** Compact local-time "YYYY-MM-DD HH:MM" for a Unix-seconds instant. Matches the
 *  local-time interpretation the DatePicker uses, so filter chips agree with it. */
export function localDateTime(secs: number): string {
	const d = new Date(secs * 1000);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Compact "YYYY-MM-DD HH:MM" reading the instant in UTC. For wall-clock values
 *  that encode the picked numbers as a UTC epoch (DatePicker `wallClock` mode). */
export function utcDateTime(secs: number): string {
	return new Date(secs * 1000).toISOString().slice(0, 16).replace("T", " ");
}

// --- Distances ---

const FEET_PER_METER = 3.280839895;
const METERS_PER_MILE = 1609.344;
/** Regions that still measure road distance in miles (CLDR's `us`/`uk` measurement systems). */
const IMPERIAL_REGIONS = new Set(["US", "GB", "LR", "MM"]);

let inferredUnits: "metric" | "imperial" | null = null;

/** The `auto` setting reads the *system* locale, not the app language: the language code
 *  carries no region, and `maximize()` supplies CLDR's likely one for a bare tag. */
function localeUnits(): "metric" | "imperial" {
	try {
		const region = new Intl.Locale(navigator.language).maximize().region;
		return region && IMPERIAL_REGIONS.has(region) ? "imperial" : "metric";
	} catch {
		return "metric";
	}
}

export function unitSystem(): "metric" | "imperial" {
	const pref = getSettings().units;
	if (pref !== "auto") return pref;
	return (inferredUnits ??= localeUnits());
}

const unitFmts = new Map<string, { locale: string; formatter: Intl.NumberFormat }>();

function unitFmt(unit: string, maximumFractionDigits: number): Intl.NumberFormat {
	const key = `${unit}:${maximumFractionDigits}`;
	const locale = getLocale();
	let cached = unitFmts.get(key);
	if (cached?.locale !== locale) {
		cached = {
			locale,
			formatter: new Intl.NumberFormat(locale, { style: "unit", unit, maximumFractionDigits }),
		};
		unitFmts.set(key, cached);
	}
	return cached.formatter;
}

/** Every distance the UI displays, in the user's unit system. Small distances read in
 *  metres/feet, larger ones in kilometres/miles. Left alone, the large unit keeps two
 *  decimals and the small one is whole; `maximumFractionDigits` overrides whichever
 *  unit the magnitude picks. */
export function formatDistance(meters: number, maximumFractionDigits?: number): string {
	const large = maximumFractionDigits ?? 2;
	const small = maximumFractionDigits ?? 0;
	if (unitSystem() === "imperial") {
		const feet = meters * FEET_PER_METER;
		return feet < 1000
			? unitFmt("foot", small).format(feet)
			: unitFmt("mile", large).format(meters / METERS_PER_MILE);
	}
	return meters >= 1000
		? unitFmt("kilometer", large).format(meters / 1000)
		: unitFmt("meter", small).format(meters);
}

export interface DistanceUnit {
	/** Short label for the field ("m", "km", "ft", "mi"). */
	label: string;
	/** Stored metric value -> the number the field shows. */
	toDisplay(value: number): number;
	/** A number typed into the field -> the metric value to store. */
	fromDisplay(value: number): number;
}

const round = (value: number, digits: number) => {
	const scale = 10 ** digits;
	return Math.round(value * scale) / scale;
};

/** Fixed-unit conversion for a distance *input* whose stored value is in `base`. Unlike
 *  {@link formatDistance} the unit never changes with magnitude, so the field keeps one label. */
export function distanceUnit(base: "m" | "km"): DistanceUnit {
	const identity = (v: number) => v;
	if (unitSystem() === "metric") {
		return { label: base === "m" ? t("m") : t("km"), toDisplay: identity, fromDisplay: identity };
	}
	// Only the displayed number is rounded; the stored value keeps the exact conversion, so
	// re-displaying it gives back the number that was typed.
	return base === "m"
		? {
				label: t("ft"),
				toDisplay: (v) => Math.round(v * FEET_PER_METER),
				fromDisplay: (v) => v / FEET_PER_METER,
			}
		: {
				label: t("mi"),
				toDisplay: (v) => round((v * 1000) / METERS_PER_MILE, 2),
				fromDisplay: (v) => (v * METERS_PER_MILE) / 1000,
			};
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Human-readable byte count: KB below a mebibyte, MB below a gibibyte, GB above. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Fill `{name}` placeholders from `vars`; an unknown placeholder is left as written. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{(\w+)\}/g, (m, key: string) => vars[key] ?? m);
}

export function fileTimestamp(date: Date = new Date()): string {
	return date.toISOString().slice(0, 19).replace(/[T:]/g, "-");
}

export function relativeTime(time: string | number): string {
	const ms = typeof time === "number" ? time * 1000 : new Date(time).getTime();
	const delta = Date.now() - ms;
	if (delta < MINUTE) return t("just now");
	if (delta < HOUR) return t("{n}m ago", { n: Math.floor(delta / MINUTE) });
	if (delta < DAY) return t("{n}h ago", { n: Math.floor(delta / HOUR) });
	if (delta < 30 * DAY) return t("{n}d ago", { n: Math.floor(delta / DAY) });
	return shortDateFmt.format(new Date(ms));
}
