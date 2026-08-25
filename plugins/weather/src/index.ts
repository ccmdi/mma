import type { ExtraFieldDef, EnrichFieldOption } from "mma-plugin-types";

interface WeatherField {
	key: string;
	label: string;
}

const WEATHER_FIELDS: WeatherField[] = [
	{ key: "weatherCode", label: "Weather code (WMO)" },
	{ key: "cloudCover", label: "Cloud cover (%)" },
	{ key: "precipitation", label: "Precipitation (mm)" },
	{ key: "snowDepth", label: "Snow depth (m)" },
	{ key: "snowfall", label: "Snowfall (cm)" },
	{ key: "temperature2m", label: "Temperature (\u00B0C)" },
	{ key: "sunshineDuration", label: "Sunshine duration (s)" },
	{ key: "windSpeed10m", label: "Wind speed (km/h)" },
];

const FIELD_DEFS: Record<string, ExtraFieldDef> = Object.fromEntries(
	WEATHER_FIELDS.map((f) => [f.key, { type: "number", label: f.label }]),
);

// defaultOff: weather is a metered network call, so it must be opt-in per field.
const ENRICH_OPTIONS: EnrichFieldOption[] = WEATHER_FIELDS.map((f) => ({
	key: f.key,
	label: f.label,
	defaultOff: true,
}));

MMA.registerPlugin({
	activate() {
		MMA.registerEnrichFields(ENRICH_OPTIONS);
		MMA.registerEnrichmentProvider({
			id: "weather",
			label: "Weather",
			fieldDefs: FIELD_DEFS,
			requires: ["datetime"],
			procedure: {
				entry: "procedure.js",
				// Open-Meteo takes 100 comma-joined coordinates with per-coordinate dates.
				batch: { mode: "chunk", size: 100 },
				// Free tier is 600 calls/min, and a multi-coordinate call bills per coordinate.
				rate: { units: 600, perMs: 60_000, cost: "row" },
				retry: { attempts: 3, on: [429] },
				inflight: 6,
			},
		});
	},
});
