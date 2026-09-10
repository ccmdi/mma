import type { Selector } from "@/bindings.gen";
import { ValidationState } from "@/bindings.consts";
import type { ProcedureSpec } from "@/lib/data/fieldDefs";
import {
	procedureEntry,
	runProcedure,
	type BatchOutcome,
	type BulkOpts,
} from "@/lib/data/procedures";
import { LOCATION_SEARCH_INFLIGHT, SV_SEARCH_RADIUS } from "@/lib/sv/constants";
import { log } from "@/lib/util/log";
import { msg } from "@/lib/i18n";

/** Configuration for Street View validation (search radius). */
export interface ValidateConfig {
	radius: number;
}

/** Street View coverage validation. Checks each location's stored pano, coordinate
 *  lookup, unofficial status, camera quality, and timeline. Answers with a
 *  `ValidationState` per location without writing anything. */
export const validateSpec: ProcedureSpec<ValidationState> = {
	entry: procedureEntry("validate"),
	batch: { mode: "chunk", size: 200 },
	sink: "collect",
	// Every row of a batch searches its coordinate in one round, one request each.
	inflight: LOCATION_SEARCH_INFLIGHT,
	config: { radius: SV_SEARCH_RADIUS } satisfies ValidateConfig,
};

const STATES = new Set<number>(Object.values(ValidationState));

/** What a validation run answered: the ids grouped by the state they validated to, over
 *  the outcome every run reports. */
export interface ValidationOutcome extends BatchOutcome {
	states: Map<ValidationState, number[]>;
}

/** Check that each location's Street View coverage still exists. */
export async function validateLocations(
	selector: Selector,
	opts: BulkOpts = {},
): Promise<ValidationOutcome> {
	const run = await runProcedure(validateSpec, selector, {
		id: "validate",
		label: msg("Validating"),
		...opts,
	});

	const results = new Map<ValidationState, number[]>();
	for (const { id, value: state } of run.collected ?? []) {
		if (typeof state !== "number" || !STATES.has(state)) {
			log.warn(`[validate] location ${id}: unknown validation state ${String(state)}`);
			continue;
		}
		const list = results.get(state);
		if (list) list.push(id);
		else results.set(state, [id]);
	}
	return { succeeded: run.succeeded, failed: run.failed, states: results };
}
