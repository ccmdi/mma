import { getMapState } from "@/store/useMapStore";
import { getProviders, getDefaultEnrichKeys } from "@/lib/data/fieldDefs";
import { runProviders, type ProcedureOutcome, type RunOpts } from "@/lib/data/procedures";
import { enrichRuns, panoResolveProvider } from "@/lib/sv/providers";
import { all, any, lacks } from "@/store/selections";
import type { Location, Selector } from "@/bindings.gen";

/** Enrich a single location with the map's enabled metadata fields. Existing fields are
 *  kept unless `force` re-derives all of them. Returns the enriched location without
 *  writing it. Returns the location unchanged when enrichment is disabled. */
export async function enrich(
	loc: Location,
	opts: Omit<RunOpts, "onProgress"> = {},
): Promise<Location> {
	const map = getMapState().map;
	if (!map || !map.settings.enrichMetadata) return loc;
	const runs = enrichRuns(map.settings.enrichFields ?? getDefaultEnrichKeys());
	const { rows } = await runProviders(runs, [loc], opts);
	return rows[0];
}

/** One summary row per pass that did work: the core metadata pass, then every
 *  provider that updated or failed at least one location. */
export interface EnrichOutcome extends ProcedureOutcome {
	id: string;
	label: string;
}
/** Bulk-enrich a selector: resolve missing pano ids, then run every field-producing
 *  provider (metadata, exact date, timezone, subdivision). */
export async function enrichAll(selector: Selector, opts: RunOpts = {}): Promise<EnrichOutcome[]> {
	const map = getMapState().map;
	if (!map) return [];
	const enrichFields = map.settings.enrichFields ?? getDefaultEnrichKeys();

	// Resolving is a means to a row's metadata, not a goal: a row holding every wanted
	// field keeps its coordinates-only state. Force re-derives fields, never panos.
	const resolve = opts.force
		? panoResolveProvider
		: {
				...panoResolveProvider,
				procedure: {
					...panoResolveProvider.procedure,
					select: all(selector, any(...enrichFields.map(lacks))),
				},
			};
	const run = await runProviders(
		[{ provider: resolve, force: false }, ...enrichRuns(enrichFields)],
		selector,
		opts,
	);
	const labelOf = (id: string) => getProviders().find((p) => p.id === id)?.label ?? id;
	return Object.entries(run)
		.filter(([, o]) => o.succeeded > 0 || o.failed.length > 0)
		.map(([id, o]) => ({ id, label: labelOf(id), ...o }));
}
