// Timezone procedure. MapOnly: the zone lookup is the host's `mma.tz` (pure compute).

import type { Location, Update, LocationPatch_Deserialize as LocationPatch } from "@/bindings.gen";

export function map(rows: Location[]): Update<LocationPatch>[] {
	const out: Update<LocationPatch>[] = [];
	for (const row of rows) {
		const timezone = mma.tz(row.lat, row.lng);
		// Out-of-range coordinates are a row failure, matching the JS provider's throw.
		if (timezone === null) {
			mma.fail(row.id);
			continue;
		}
		out.push({ id: row.id, patch: { extra: { timezone } } });
	}
	return out;
}
