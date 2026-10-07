import type { Patch } from "@/types";
// Subdivision (adm1), Run shape. Each row is classified against the local adm1 border
// archive through the host; a point outside every feature is not a failure, just no patch.
//
// The adm1 archive download stays on the JS side: the provider declaration must call
// ensureAdm1() before starting the run.

import type { ProcedureConfig } from "@/bindings.gen";
import type { Location } from "@/bindings.gen";

const DATASET = "adm1";

export function run(rows: Location[], _cfg: ProcedureConfig<unknown>): Patch<Location>[] {
	const out: Patch<Location>[] = [];
	for (const row of rows) {
		if (mma.aborted()) break;
		const name = mma.classify(DATASET, row.lat, row.lng);
		if (name) out.push({ id: row.id, extra: { subdivision: name } });
		mma.progress(1);
	}
	return out;
}
