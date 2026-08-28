import type { Selector } from "@/bindings.gen";
import { ValidationState } from "@/types";
import type { ProcedureSpec } from "@/lib/data/fieldDefs";
import { procedureEntry, runProcedure } from "@/lib/data/procedures";
import { SV_SEARCH_RADIUS } from "@/lib/sv/constants";
import { log } from "@/lib/util/log";
import { msg } from "@/lib/i18n";

export interface ValidateConfig {
	radius: number;
}

/** Street View coverage validation: per location, metadata for the stored pano, a
 *  coordinate lookup as fallback or comparison, then the unofficial, badcam and
 *  timeline checks. It answers with a `ValidationState` and writes nothing, so it
 *  declares the collect sink. Not an enrichment provider: nothing selects its fields
 *  and it never joins a run implicitly. */
export const validateSpec: ProcedureSpec<ValidationState> = {
	entry: procedureEntry("validate"),
	batch: { mode: "chunk", size: 200 },
	sink: "collect",
	retry: { attempts: 3, on: [429, 500, 503] },
	// Every row of a batch searches its coordinate in one round, one request each.
	inflight: 100,
	config: { radius: SV_SEARCH_RADIUS } satisfies ValidateConfig,
};

const STATES = new Set<number>(Object.values(ValidationState));

/** Check that each location's Street View coverage still exists; returns the location
 *  ids grouped by the state they validated to. */
export async function validateLocations(
	selector: Selector,
	opts: {
		signal?: AbortSignal;
		onProgress?: (done: number, total: number) => void;
	} = {},
): Promise<Map<ValidationState, number[]>> {
	const run = await runProcedure(validateSpec, selector, {
		id: "validate",
		label: msg("Validating"),
		signal: opts.signal,
		onProgress: (done, total) => opts.onProgress?.(done, total),
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
	return results;
}
