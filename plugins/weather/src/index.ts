import type { FieldDef } from "mma-plugin-types";

const { registerPlugin, registerProvider } = MMA;

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
	{ key: "temperature2m", label: "Temperature (°C)" },
	{ key: "sunshineDuration", label: "Sunshine duration (s)" },
	{ key: "windSpeed10m", label: "Wind speed (km/h)" },
];

const FIELD_DEFS: Record<string, FieldDef> = Object.fromEntries(
	WEATHER_FIELDS.map((f) => [
		f.key,
		{ type: "number", label: f.label, values: null, labels: null, comparison: null },
	]),
);

registerPlugin({
	activate() {
		registerProvider({
			id: "weather",
			label: "Weather",
			fieldDefs: FIELD_DEFS,
			// Weather is a metered network call, so its fields are opt-in.
			defaultOff: true,
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
