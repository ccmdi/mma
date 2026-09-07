import { createFieldDef } from "@/types";
import { SVMETA_FIELDS } from "@/lib/sv/getMetadata";
import { getMapState } from "@/store/useMapStore";
import {
	getAllEnrichKeys,
	getProviders,
	getDefaultEnrichKeys,
	knownFieldDefs,
	registerProvider,
	type Provider,
	type ProcedureSpec,
} from "@/lib/data/fieldDefs";
import {
	runProviders,
	procedureEntry,
	type ProcedureOutcome,
	type ProviderRun,
	type RunOpts,
} from "@/lib/data/procedures";
import {
	GET_METADATA_INFLIGHT,
	LOCATION_SEARCH_INFLIGHT,
	SV_SEARCH_RADIUS,
} from "@/lib/sv/constants";
import { cmd } from "@/lib/commands";
import { buildSelection } from "@/store/selections";
import { toast } from "@/lib/util/toast";
import type { Location, Selector } from "@/bindings.gen";
import { msg, t } from "@/lib/i18n";

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

/** Build the provider run list for enrichment, narrowed to `enrichFields`. Fields not
 *  offered in the enrichment settings are always included. */
export function enrichRuns(enrichFields: string[] | null, exclude: string[] = []): ProviderRun[] {
	const selectable = new Set(getAllEnrichKeys());
	const active = new Set(enrichFields ?? getDefaultEnrichKeys());
	return getProviders()
		.filter((p) => p.fieldDefs && !exclude.includes(p.id))
		.map((provider) => ({
			provider,
			fields: Object.keys(provider.fieldDefs ?? {}).filter(
				(k) => !selectable.has(k) || active.has(k),
			),
		}));
}

// --- Providers ---

/** Configuration for panorama resolution (search radius). */
export interface PanoResolveConfig {
	radius: number;
}

/** Resolve a pano id from coordinates. Rows that already have a pano id are skipped
 *  unless the run is forced. */
export const panoResolveSpec: ProcedureSpec<{ panoId: string }> = {
	entry: procedureEntry("panoResolve"),
	batch: { mode: "chunk", size: 200 },
	retry: { attempts: 3, on: [429, 500, 503] },
	inflight: LOCATION_SEARCH_INFLIGHT,
	config: { radius: SV_SEARCH_RADIUS } satisfies PanoResolveConfig,
};

/** Pano-resolve provider for enrichment. Writes the `panoId` field and runs before
 *  any provider that depends on it. */
export const panoResolveProvider: Provider = {
	id: "panoResolve",
	label: msg("Resolving panoramas"),
	provides: ["panoId"],
	procedure: panoResolveSpec,
};

/** Exact capture timestamp, narrowed from the `imageDate` month via binary search. */
export const exactDateProvider: Provider = {
	id: "exactDate",
	label: msg("Exact dates"),
	requires: ["imageDate"],
	fieldDefs: knownFieldDefs("datetime"),
	procedure: {
		entry: procedureEntry("exactDate"),
		batch: { mode: "chunk", size: 50 },
		retry: { attempts: 3, on: [429, 501, 503] },
		// A batch bisects every row's month in lockstep, four probes per row per round.
		inflight: 512,
	},
};

/** Timezone at the location's coordinates. Requires `datetime` to be present. */
export const timezoneProvider: Provider = {
	id: "timezone",
	label: msg("Timezone"),
	requires: ["datetime"],
	fieldDefs: knownFieldDefs("timezone"),
	procedure: {
		entry: procedureEntry("timezone"),
		batch: { mode: "chunk", size: 10000 },
	},
};

let adm1Ready: Promise<boolean> | null = null;
function ensureAdm1(): Promise<boolean> {
	adm1Ready ??= (async () => {
		if (await cmd.checkBorderFile("adm1")) return true;
		toast(t("Subdivision borders missing - downloading..."));
		try {
			await cmd.downloadBorderFile("adm1");
			return true;
		} catch {
			toast(t("Couldn't download subdivision borders - check your connection"));
			adm1Ready = null;
			return false;
		}
	})();
	return adm1Ready;
}

/** Subdivision (adm1) via offline point-in-polygon against the local border dataset.
 *  No Google dependency; downloads the adm1 archive on first use. */
export const subdivisionProvider: Provider = {
	id: "subdivision",
	label: msg("Subdivision"),
	requires: ["lat", "lng"],
	fieldDefs: {
		subdivision: createFieldDef("string", { label: msg("Subdivision") }),
	},
	procedure: {
		entry: procedureEntry("subdivision"),
		batch: { mode: "chunk", size: 2000 },
		prepare: ensureAdm1,
	},
};

/** Core panorama metadata via Google's GetMetadata RPC. */
export const svMetaProvider: Provider = {
	id: "svMeta",
	label: msg("Metadata"),
	requires: ["panoId"],
	fieldDefs: knownFieldDefs(...SVMETA_FIELDS),
	procedure: {
		entry: procedureEntry("svMeta"),
		batch: { mode: "chunk", size: 1000 },
		retry: { attempts: 3, on: [429, 500, 503] },
		inflight: GET_METADATA_INFLIGHT,
	},
};

registerProvider(panoResolveProvider);
registerProvider(svMetaProvider);
registerProvider(exactDateProvider);
registerProvider(timezoneProvider);
registerProvider(subdivisionProvider);

/** `selector` minus the rows holding every one of `fields`. */
function lackingAny(selector: Selector, fields: string[]): Selector {
	const missing: Selector = {
		type: "Union",
		selections: fields.map((field) =>
			buildSelection({ type: "Filter", field, test: { op: "nothas" } }),
		),
	};
	return { type: "Intersection", selections: [selector, missing].map(buildSelection) };
}

/** One summary row per pass that did work: the core metadata pass, then every
 *  provider that updated or failed at least one location. */
export interface EnrichOutcome extends ProcedureOutcome {
	id: string;
	label: string;
}
/** Bulk-enrich a selector: resolve missing pano ids, then run every field-producing
 *  provider (metadata, exact date, timezone, subdivision). */
export async function enrichAll(
	selector: Selector,
	opts: RunOpts = {},
): Promise<EnrichOutcome[]> {
	const map = getMapState().map;
	if (!map) return [];
	const enrichFields = map.settings.enrichFields ?? getDefaultEnrichKeys();

	// Resolving is a means to a row's metadata, not a goal: a row holding every wanted
	// field keeps its coordinates-only state. Force re-derives fields, never panos.
	const resolve = opts.force
		? panoResolveProvider
		: {
				...panoResolveProvider,
				procedure: { ...panoResolveSpec, select: lackingAny(selector, enrichFields) },
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
