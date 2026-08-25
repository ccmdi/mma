// Subdivision (adm1), Run shape. Each row is classified against the local adm1 border
// archive through the host; a point outside every feature is not a failure, just no patch.
//
// The adm1 archive download stays on the JS side: the provider declaration must call
// ensureAdm1() before starting the run.

import type { Location, Update, LocationPatch_Deserialize as LocationPatch } from "@/bindings.gen";

const DATASET = "adm1";

export function run(rows: Location[]): Update<LocationPatch>[] {
	const out: Update<LocationPatch>[] = [];
	for (const row of rows) {
		if (mma.aborted()) break;
		const name = mma.classify(DATASET, row.lat, row.lng);
		if (name) out.push({ id: row.id, patch: { extra: { subdivision: name } } });
		mma.progress(1);
	}
	return out;
}
