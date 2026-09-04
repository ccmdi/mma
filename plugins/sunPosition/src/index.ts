import type { ExtraFieldDef } from "mma-plugin-types";

const { registerPlugin, registerEnrichFields, registerProvider } = MMA;

const FIELDS: Record<string, ExtraFieldDef> = {
	sunAzimuth: {
		type: "number",
		label: "Sun azimuth",
		values: null,
		labels: null,
		comparison: { type: "circular", period: 360 },
	},
	sunAltitude: {
		type: "number",
		label: "Sun altitude",
		values: null,
		labels: null,
		comparison: null,
	},
};

registerPlugin({
	activate() {
		registerEnrichFields([
			{ key: "sunAzimuth", label: "Sun azimuth" },
			{ key: "sunAltitude", label: "Sun altitude" },
		]);
		registerProvider({
			id: "sunPosition",
			fieldDefs: FIELDS,
			requires: ["datetime"],
			procedure: {
				entry: "procedure.js",
				batch: { mode: "chunk", size: 10000 },
			},
		});
	},
});
