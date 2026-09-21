import type { FieldDef } from "mma-plugin-types";

const { registerPlugin, registerProvider } = MMA;

const FIELD_DEFS: Record<string, FieldDef> = {
	// Year labels are identification categories, not distances: comparison stays
	// categorical (disambiguate) while type=number keeps numeric bucketing/ranges.
	copyrightYear: {
		type: "number",
		label: "Copyright year",
		values: null,
		comparison: { type: "categorical" },
	},
};

registerPlugin({
	activate() {
		registerProvider({
			id: "copyright",
			label: "Copyright year",
			requires: ["panoId"],
			fieldDefs: FIELD_DEFS,
			procedure: {
				entry: "procedure.js",
				// The resident sidecar answers each chunk with one reply, so pages stay
				// small enough to fit the transport budget and keep progress moving.
				batch: { mode: "chunk", size: 1000 },
				instances: 1,
			},
		});
	},
	comingSoon: true,
});
