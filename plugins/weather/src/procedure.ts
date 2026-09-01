// Historical weather, RequestMap shape.
//
// Open-Meteo accepts comma-joined coordinates with per-coordinate dates, so one batch of
// 100 covers 100 arbitrary days. `timezone=GMT` makes the hourly stamps UTC, which is the
// domain `extra.datetime` is already in.

import type {
	ProcedureRequest,
	ProcedureResponse,
	Location,
	Update,
	LocationPatch_Deserialize as LocationPatch,
} from "mma-plugin-types";

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const MAX_TIME_MS = 8.64e15; // JS Date range; beyond it the date is invalid

/** `extra` key -> hourly variable, in request order. A field the run turned off is
 *  neither requested nor written, so the URL shrinks with the selection. */
const HOURLY: [string, string][] = [
	["weatherCode", "weather_code"],
	["cloudCover", "cloud_cover"],
	["precipitation", "precipitation"],
	["snowDepth", "snow_depth"],
	["snowfall", "snowfall"],
	["temperature2m", "temperature_2m"],
	["sunshineDuration", "sunshine_duration"],
	["windSpeed10m", "wind_speed_10m"],
];

/** The `extra` keys the run wants; null until configured, meaning no filtering. */
let fields: Set<string> | null = null;

export function configure(cfg: { fields?: string[] } | null): void {
	fields = Array.isArray(cfg?.fields) ? new Set(cfg.fields) : null;
}

const enabled = (key: string) => fields === null || fields.has(key);

const pad2 = (n: number) => String(n).padStart(2, "0");

function utcParts(secs: number): { date: string; hourKey: string } {
	const d = new Date(Math.trunc(secs * 1000));
	const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
	return { date, hourKey: `${date}T${pad2(d.getUTCHours())}:00` };
}

/** A row is usable only with a numeric `extra.datetime` inside the JS Date range.
 *  Unusable rows are dropped from the request, so `request` and `map` must agree. */
function usableSeconds(row: Location): number | null {
	const secs = row.extra?.datetime;
	if (typeof secs !== "number") return null;
	const ms = secs * 1000;
	if (!isFinite(ms) || Math.abs(ms) > MAX_TIME_MS) return null;
	return secs;
}

export function request(rows: Location[]): ProcedureRequest {
	const lat: string[] = [];
	const lng: string[] = [];
	const dates: string[] = [];
	for (const row of rows) {
		const secs = usableSeconds(row);
		if (secs === null) continue;
		lat.push(String(row.lat));
		lng.push(String(row.lng));
		dates.push(utcParts(secs).date);
	}
	const hourly = HOURLY.filter(([key]) => enabled(key))
		.map(([, param]) => param)
		.join(",");
	const joined = dates.join(",");
	return {
		method: "GET",
		url:
			`${ARCHIVE_URL}?latitude=${lat.join(",")}&longitude=${lng.join(",")}` +
			`&start_date=${joined}&end_date=${joined}&hourly=${hourly}&timezone=GMT`,
	};
}

interface Hourly {
	time?: string[];
	[param: string]: unknown;
}

/** One result object per coordinate, or a bare object when a single coordinate was sent
 *  (Open-Meteo drops the array wrapper in that case). */
function parseResults(body: string): { hourly?: Hourly }[] {
	const parsed = JSON.parse(body);
	return Array.isArray(parsed) ? parsed : [parsed];
}

const decoder = new TextDecoder();

export function map(rows: Location[], response: ProcedureResponse): Update<LocationPatch>[] {
	if (response.status !== 200) {
		for (const row of rows) mma.fail(row.id);
		return [];
	}

	const results = parseResults(decoder.decode(response.body));
	const out: Update<LocationPatch>[] = [];
	let pos = 0;
	for (const row of rows) {
		const secs = usableSeconds(row);
		if (secs === null) {
			mma.fail(row.id);
			continue;
		}
		const hourly = results[pos++]?.hourly;
		if (!hourly || !Array.isArray(hourly.time)) {
			mma.fail(row.id);
			continue;
		}
		const idx = hourly.time.indexOf(utcParts(secs).hourKey);
		if (idx < 0) {
			mma.fail(row.id);
			continue;
		}

		const patch: Record<string, unknown> = {};
		for (const [key, param] of HOURLY) {
			if (!enabled(key)) continue;
			const series = hourly[param];
			if (!Array.isArray(series) || idx >= series.length) continue;
			const value = series[idx];
			if (value === null || value === undefined) continue;
			patch[key] = value;
		}
		if (Object.keys(patch).length > 0) out.push({ id: row.id, patch: { extra: patch } });
	}
	return out;
}
