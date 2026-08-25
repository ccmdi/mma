import type { ExtraFieldDef } from "mma-plugin-types";

const FIELDS: Record<string, ExtraFieldDef> = {
	sunAzimuth: { type: "number", label: "Sun azimuth", comparison: { type: "circular", period: 360 } },
	sunAltitude: { type: "number", label: "Sun altitude" },
};

MMA.registerPlugin({
	activate() {
		MMA.registerEnrichFields([
			{ key: "sunAzimuth", label: "Sun azimuth" },
			{ key: "sunAltitude", label: "Sun altitude" },
		]);
		MMA.registerEnrichmentProvider({
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
