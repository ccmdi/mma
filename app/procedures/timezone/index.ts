// Timezone procedure. MapOnly: pure compute, no host calls but `fail`.

import type { Location, Update, LocationPatch_Deserialize as LocationPatch } from "@/bindings.gen";
import tzlookup from "@photostructure/tz-lookup";

const inRange = (lat: number, lng: number) => lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

export function map(rows: Location[]): Update<LocationPatch>[] {
	const out: Update<LocationPatch>[] = [];
	for (const row of rows) {
		if (typeof row.extra?.datetime !== "number") continue;
		// Out-of-range coordinates are a row failure, matching the JS provider's throw.
		if (!inRange(row.lat, row.lng)) {
			mma.fail(row.id);
			continue;
		}
		out.push({ id: row.id, patch: { extra: { timezone: tzlookup(row.lat, row.lng) } } });
	}
	return out;
}
