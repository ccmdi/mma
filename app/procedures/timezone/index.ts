import type { Patch } from "@/types";
// Timezone procedure, map shape: the zone lookup is the host's `mma.tz` (pure compute).

import type { ProcedureConfig } from "@/bindings.gen";
import type { Location } from "@/bindings.gen";

export function map(rows: Location[], _cfg: ProcedureConfig<unknown>): Patch<Location>[] {
	const out: Patch<Location>[] = [];
	for (const row of rows) {
		const timezone = mma.tz(row.lat, row.lng);
		// Out-of-range coordinates are a row failure, matching the JS provider's throw.
		if (timezone === null) {
			mma.fail(row.id);
			continue;
		}
		out.push({ id: row.id, extra: { timezone } });
	}
	return out;
}
