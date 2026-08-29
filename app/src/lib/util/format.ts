import { getLocale, msg, t } from "@/lib/i18n";
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

/** Units a stored distance can be held in. Every distance in the app is stored in one of these. */
export type MetricUnit = "m" | "km";
export type DistanceUnit = MetricUnit | "ft" | "mi";

/** The one table: what each unit is worth, what Intl calls it, and how it is labelled on a
 *  field. `decimals` is what a value in that unit reads to when nothing overrides it. */
const UNITS: Record<
	DistanceUnit,
	{ meters: number; intl: string; label: string; decimals: number }
> = {
	m: { meters: 1, intl: "meter", label: msg("m"), decimals: 0 },
	km: { meters: 1000, intl: "kilometer", label: msg("km"), decimals: 2 },
	ft: { meters: 0.3048, intl: "foot", label: msg("ft"), decimals: 0 },
	mi: { meters: 1609.344, intl: "mile", label: msg("mi"), decimals: 2 },
};

/** The imperial unit each metric one becomes, small and large. */
const IMPERIAL_OF: Record<MetricUnit, DistanceUnit> = { m: "ft", km: "mi" };

/** A unit switches to the larger one of its system at a thousand of itself: 1000 m, 1000 ft. */
const LARGE_AT = 1000;

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

/** The unit a stored `base` value is shown in: itself under metric, its imperial twin otherwise. */
function displayUnit(base: MetricUnit): DistanceUnit {
	return unitSystem() === "imperial" ? IMPERIAL_OF[base] : base;
}

const unitFmts = new Map<string, { locale: string; formatter: Intl.NumberFormat }>();

function unitFmt(unit: DistanceUnit, maximumFractionDigits: number): Intl.NumberFormat {
	const key = `${unit}:${maximumFractionDigits}`;
	const locale = getLocale();
	let cached = unitFmts.get(key);
	if (cached?.locale !== locale) {
		cached = {
			locale,
			formatter: new Intl.NumberFormat(locale, {
				style: "unit",
				unit: UNITS[unit].intl,
				maximumFractionDigits,
			}),
		};
		unitFmts.set(key, cached);
	}
	return cached.formatter;
}

/** Every distance the UI displays, in the user's unit system: metres/feet up to a thousand of
 *  them, kilometres/miles above. `maximumFractionDigits` overrides whichever unit the magnitude
 *  picks; left alone each unit uses its own default. */
export function formatDistance(meters: number, maximumFractionDigits?: number): string {
	const small = displayUnit("m");
	const unit = meters / UNITS[small].meters >= LARGE_AT ? displayUnit("km") : small;
	return unitFmt(unit, maximumFractionDigits ?? UNITS[unit].decimals).format(
		meters / UNITS[unit].meters,
	);
}

export interface DistanceField {
	unit: DistanceUnit;
	/** Localised short label for the field ("m", "km", "ft", "mi"). */
	label: string;
	/** Stored metric value -> the number the field shows. */
	toDisplay(value: number): number;
	/** A number typed into the field -> the metric value to store. */
	fromDisplay(value: number): number;
}

/** Fixed-unit conversion for a distance *input* whose stored value is in `base`. Unlike
 *  {@link formatDistance} the unit never changes with magnitude, so the field keeps one label.
 *  Only the displayed number is rounded -- the stored value keeps the exact conversion, so
 *  re-displaying it gives back the number that was typed. */
export function distanceUnit(base: MetricUnit): DistanceField {
	const unit = displayUnit(base);
	const perStored = UNITS[base].meters / UNITS[unit].meters;
	const scale = 10 ** UNITS[unit].decimals;
	return {
		unit,
		label: t(UNITS[unit].label),
		toDisplay: (v) => Math.round(v * perStored * scale) / scale,
		fromDisplay: (v) => v / perStored,
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
