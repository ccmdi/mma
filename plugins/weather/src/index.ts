import type { Location, ExtraFieldDef, EnrichFieldOption, EnrichCtx } from "mma-plugin-types";

interface WeatherField {
	key: string;
	param: string;
	label: string;
}

const WEATHER_FIELDS: WeatherField[] = [
	{ key: "weatherCode", param: "weather_code", label: "Weather code (WMO)" },
	{ key: "cloudCover", param: "cloud_cover", label: "Cloud cover (%)" },
	{ key: "precipitation", param: "precipitation", label: "Precipitation (mm)" },
	{ key: "snowDepth", param: "snow_depth", label: "Snow depth (m)" },
	{ key: "snowfall", param: "snowfall", label: "Snowfall (cm)" },
	{ key: "temperature2m", param: "temperature_2m", label: "Temperature (°C)" },
	{ key: "sunshineDuration", param: "sunshine_duration", label: "Sunshine duration (s)" },
	{ key: "windSpeed10m", param: "wind_speed_10m", label: "Wind speed (km/h)" },
];

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const COORDS_PER_REQUEST = 100; // Open-Meteo accepts comma-separated coords (and per-coordinate dates).
const MAX_CONCURRENT = 6; // bounds open sockets; the rate limiter governs actual throughput.
const MAX_RETRIES = 3;
// Free tier: 600 calls/min. A multi-location request is billed per location, so we
// throttle by location count, not request count.
const CALLS_PER_MIN = 600;

const FIELD_DEFS: Record<string, ExtraFieldDef> = Object.fromEntries(
	WEATHER_FIELDS.map((f) => [f.key, { type: "number", label: f.label }]),
);

// defaultOff: weather is a metered network call, so it must be opt-in per field.
const ENRICH_OPTIONS: EnrichFieldOption[] = WEATHER_FIELDS.map((f) => ({
	key: f.key,
	label: f.label,
	defaultOff: true,
}));

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

// datetime is a UTC unix-seconds timestamp. timezone=GMT makes Open-Meteo return
// hourly stamps as "YYYY-MM-DDTHH:00" in UTC, so we match against the UTC hour.
function utcDateAndHour(unixSeconds: number): { date: string; hourKey: string } {
	const d = new Date(unixSeconds * 1000);
	const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
	const hourKey = `${date}T${pad(d.getUTCHours())}:00`;
	return { date, hourKey };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Continuous-refill token bucket. Each request consumes `cost` tokens (= its location
// count, since Open-Meteo bills multi-location requests per location), capping throughput
// at `capacity` calls per `windowMs`. The synchronous refill+consume path is atomic
// between awaits, so concurrent acquirers are safe.
class RateLimiter {
	private tokens: number;
	private last: number;
	constructor(
		private readonly capacity: number,
		private readonly windowMs: number,
	) {
		this.tokens = capacity;
		this.last = Date.now();
	}

	async acquire(cost: number): Promise<void> {
		const want = Math.min(cost, this.capacity);
		for (;;) {
			const now = Date.now();
			this.tokens = Math.min(
				this.capacity,
				this.tokens + ((now - this.last) * this.capacity) / this.windowMs,
			);
			this.last = now;
			if (this.tokens >= want) {
				this.tokens -= want;
				return;
			}
			await sleep(((want - this.tokens) * this.windowMs) / this.capacity);
		}
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchWithRetry(url: string): Promise<any | null> {
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const resp = await fetch(url);
		if (resp.ok) return resp.json();
		// 429 = minute/hour/day quota hit. Back off and retry; other errors are fatal for this chunk.
		if (resp.status !== 429) return null;
		await sleep(2000 * (attempt + 1));
	}
	return null;
}

async function runTask(
	locs: Location[],
	vars: string,
	requested: WeatherField[],
	limiter: RateLimiter,
	patches: Map<number, Record<string, unknown>>,
): Promise<void> {
	const lat = locs.map((l) => l.lat).join(",");
	const lng = locs.map((l) => l.lng).join(",");
	// Per-coordinate dates: one request covers locations on arbitrary, differing days.
	const dates = locs.map((l) => utcDateAndHour(l.extra!.datetime as number).date).join(",");
	const url =
		`${ARCHIVE_URL}?latitude=${lat}&longitude=${lng}` +
		`&start_date=${dates}&end_date=${dates}` +
		`&hourly=${vars}&timezone=GMT`;

	await limiter.acquire(locs.length);
	const json = await fetchWithRetry(url);
	if (!json) return;
	const results = Array.isArray(json) ? json : [json];

	for (let i = 0; i < locs.length; i++) {
		const loc = locs[i];
		const hourly = results[i]?.hourly;
		if (!hourly?.time) continue;
		const { hourKey } = utcDateAndHour(loc.extra!.datetime as number);
		const idx = hourly.time.indexOf(hourKey);
		if (idx < 0) continue;

		const patch: Record<string, unknown> = {};
		for (const f of requested) {
			const v = hourly[f.param]?.[idx];
			if (v != null) patch[f.key] = v;
		}
		if (Object.keys(patch).length > 0) patches.set(loc.id, patch);
	}
}

function requestedFields(enrichFields: string[] | null): WeatherField[] {
	return WEATHER_FIELDS.filter((f) => !enrichFields || enrichFields.includes(f.key));
}

// Strictly datetime-dependent, and skips anything already holding every requested field
// (re-runs cost nothing; only missing fields trigger a fetch).
function usableLocations(
	locations: Location[],
	enrichFields: string[] | null,
): Location[] {
	const requested = requestedFields(enrichFields);
	if (requested.length === 0) return [];
	return locations.filter(
		(l) =>
			typeof l.extra?.datetime === "number" &&
			requested.some((f) => l.extra?.[f.key] == null),
	);
}

async function enrich(
	locations: Location[],
	enrichFields: string[] | null,
	ctx?: EnrichCtx,
): Promise<Map<number, Record<string, unknown>>> {
	const patches = new Map<number, Record<string, unknown>>();

	const requested = requestedFields(enrichFields);
	const usable = usableLocations(locations, enrichFields);
	if (usable.length === 0) return patches;

	// Chunk all pending locations; per-coordinate dates let one request span arbitrary days.
	const chunks: Location[][] = [];
	for (let i = 0; i < usable.length; i += COORDS_PER_REQUEST) {
		chunks.push(usable.slice(i, i + COORDS_PER_REQUEST));
	}

	const vars = requested.map((f) => f.param).join(",");
	const limiter = new RateLimiter(CALLS_PER_MIN, 60_000);
	let cursor = 0;
	async function worker(): Promise<void> {
		while (cursor < chunks.length && !ctx?.signal?.aborted) {
			const chunk = chunks[cursor++];
			await runTask(chunk, vars, requested, limiter, patches);
			// One unit per location attempted, so the bar fills to the unit count above.
			for (let i = 0; i < chunk.length; i++) ctx?.onUnit?.();
		}
	}
	await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, chunks.length) }, worker));

	return patches;
}

MMA.registerPlugin({
	activate() {
		MMA.registerEnrichFields(ENRICH_OPTIONS);
		MMA.registerEnrichmentProvider({
			id: "weather",
			label: "Weather",
			enrich,
			fieldDefs: FIELD_DEFS,
			requires: ["datetime"],
			units: (locations, enrichFields) => usableLocations(locations, enrichFields).length,
		});
	},
});
