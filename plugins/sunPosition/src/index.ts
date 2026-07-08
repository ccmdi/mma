import SunCalc from "suncalc";
import type { Location, ExtraFieldDef } from "mma-plugin-types";

const DEG = 180 / Math.PI;

const FIELDS: Record<string, ExtraFieldDef> = {
	sunAzimuth: { type: "number", label: "Sun azimuth", comparison: { type: "circular", period: 360 } },
	sunAltitude: { type: "number", label: "Sun altitude" },
};

function computeSun(lat: number, lng: number, unixSeconds: number) {
	const pos = SunCalc.getPosition(new Date(unixSeconds * 1000), lat, lng);
	const azimuth = ((pos.azimuth * DEG + 180) % 360 + 360) % 360;
	const altitude = pos.altitude * DEG;
	return {
		azimuth: Math.round(azimuth * 100) / 100,
		altitude: Math.round(altitude * 100) / 100,
	};
}

async function enrich(
	locations: Location[],
	enrichFields: string[] | null,
): Promise<Map<number, Record<string, unknown>>> {
	const patches = new Map<number, Record<string, unknown>>();
	for (const loc of locations) {
		const dt = loc.extra?.datetime;
		if (typeof dt !== "number") continue;
		if (enrichFields && !enrichFields.some((k) => k === "sunAzimuth" || k === "sunAltitude")) continue;

		const sun = computeSun(loc.lat, loc.lng, dt);
		const patch: Record<string, unknown> = {};
		if (!enrichFields || enrichFields.includes("sunAzimuth")) patch.sunAzimuth = sun.azimuth;
		if (!enrichFields || enrichFields.includes("sunAltitude")) patch.sunAltitude = sun.altitude;
		patches.set(loc.id, patch);
	}
	return patches;
}

MMA.registerPlugin({
	activate() {
		MMA.registerEnrichFields([
			{ key: "sunAzimuth", label: "Sun azimuth" },
			{ key: "sunAltitude", label: "Sun altitude" },
		]);
		MMA.registerEnrichmentProvider({
			id: "sunPosition",
			enrich,
			fieldDefs: FIELDS,
			requires: ["datetime"],
		});
	},
});
