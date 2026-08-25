// Sun position, MapOnly: pure compute over lat/lng and `extra.datetime`.

import SunCalc from "suncalc";
import type { Location, Update, LocationPatch_Deserialize as LocationPatch } from "mma-plugin-types";

const DEG = 180 / Math.PI;
const MAX_TIME_MS = 8.64e15; // JS Date range; beyond it Date is invalid

/** The `extra` keys the run wants; null until configured, meaning no filtering. */
let fields: Set<string> | null = null;

export function configure(cfg: { fields?: string[] } | null): void {
	fields = Array.isArray(cfg?.fields) ? new Set(cfg.fields) : null;
}

const enabled = (key: string) => fields === null || fields.has(key);

const round2 = (v: number) => Math.round(v * 100) / 100;

export function map(rows: Location[]): Update<LocationPatch>[] {
	const wantAz = enabled("sunAzimuth");
	const wantAlt = enabled("sunAltitude");
	if (!wantAz && !wantAlt) return [];

	const out: Update<LocationPatch>[] = [];
	for (const row of rows) {
		const secs = row.extra?.datetime;
		if (typeof secs !== "number") continue;
		const ms = Math.trunc(secs * 1000); // `new Date(x)` truncates to integer ms
		if (!isFinite(ms) || Math.abs(ms) > MAX_TIME_MS) continue;

		const pos = SunCalc.getPosition(new Date(ms), row.lat, row.lng);
		const patch: Record<string, number> = {};
		// suncalc measures azimuth from south; the app's convention is north-clockwise.
		if (wantAz) patch.sunAzimuth = round2(((((pos.azimuth * DEG + 180) % 360) + 360) % 360));
		if (wantAlt) patch.sunAltitude = round2(pos.altitude * DEG);
		out.push({ id: row.id, patch: { extra: patch } });
	}
	return out;
}
