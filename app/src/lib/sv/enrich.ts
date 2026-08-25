import { svMetadata } from "@/lib/sv/query";
import type { Pano } from "@/types";
import { metadataPatch, SVMETA_FIELDS } from "@/lib/sv/getMetadata";
import { getMapState, updateLocations } from "@/store/useMapStore";
import {
	getEnrichmentProviders,
	getDefaultEnrichKeys,
	knownFieldDefs,
	registerEnrichmentProvider,
	type EnrichmentProvider,
	type ProcedureSpec,
} from "@/lib/data/fieldDefs";
import {
	enrichFieldProviders,
	runProviders,
	runProvidersForIds,
	outcomeDidWork,
	procedureEntry,
	type ResolverOutcome,
} from "@/lib/data/procedures";
import {
	GET_METADATA_INFLIGHT,
	LOCATION_SEARCH_INFLIGHT,
	SV_SEARCH_RADIUS,
} from "@/lib/sv/constants";
import { cmd } from "@/lib/commands";
import { toast } from "@/lib/util/toast";
import type { Location, Selector } from "@/bindings.gen";
import { msg, t } from "@/lib/i18n";

/** True when the location is missing any of the given enrich fields (default: the enabled set). */
export function needsEnrichment(loc: Location, enrichFields?: string[]): boolean {
	const fields = enrichFields ?? getDefaultEnrichKeys();
	return fields.some((key) => loc.extra?.[key] == null);
}

/** Enrich a single location (used on pano load). `data` is the answer the caller
 *  already has from the `metadata` query; without one this fetches it. The patch is the
 *  same one the svMeta procedure writes in a run. */
export async function enrich(loc: Location, data?: Pano | null): Promise<boolean> {
	if (!data) {
		if (!loc.panoId) return false;
		[data] = await svMetadata([loc.panoId]);
		if (!data) return false;
	}
	const map = getMapState().map;
	if (!map || !map.meta.settings.enrichMetadata) return false;
	const enrichFields = map.meta.settings.enrichFields ?? getDefaultEnrichKeys();

	const patch = metadataPatch(data, loc.extra, new Set(enrichFields));
	if (Object.keys(patch).length > 0) {
		await updateLocations([{ id: loc.id, patch: { extra: patch } }], { undoable: false });
	}

	// svMeta is excluded: its fields are the answer this was handed.
	await runProvidersForIds([loc.id], { enrichFields, excludeIds: ["svMeta"] });
	return true;
}

// --- Providers ---

export interface PanoResolveConfig {
	radius: number;
}

/** Pano id from coordinates, via the location search `StreetViewService.getPanorama`
 *  sends. A row that already has a pano id is left alone unless the run is forced:
 *  `force` re-resolves, which is what pinning asks for. Under `collect` it answers the
 *  patch it would have written. */
export const panoResolveSpec: ProcedureSpec<{ panoId: string }> = {
	entry: procedureEntry("panoResolve"),
	batch: { mode: "chunk", size: 200 },
	retry: { attempts: 3, on: [429, 500, 503] },
	inflight: LOCATION_SEARCH_INFLIGHT,
	config: { radius: SV_SEARCH_RADIUS } satisfies PanoResolveConfig,
};

/** `panoResolveSpec` as enrichment schedules it: it writes the `panoId` column, so every
 *  provider that reads a panorama requires it and the engine puts it in the first wave. */
export const panoResolveProvider: EnrichmentProvider = {
	id: "panoResolve",
	label: msg("Resolving panoramas"),
	provides: ["panoId"],
	procedure: panoResolveSpec,
};

/** Exact capture timestamp: the procedure narrows the `imageDate` month against
 *  Google's SingleImageSearch per location. */
export const exactDateProvider: EnrichmentProvider = {
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

/** Timezone at the location, once a `datetime` exists to interpret. The tz-lookup
 *  quadtree ships inside the module. */
export const timezoneProvider: EnrichmentProvider = {
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
export const subdivisionProvider: EnrichmentProvider = {
	id: "subdivision",
	label: msg("Subdivision"),
	fieldDefs: {
		subdivision: { type: "string", label: msg("Subdivision") },
	},
	procedure: {
		entry: procedureEntry("subdivision"),
		batch: { mode: "chunk", size: 2000 },
		prepare: ensureAdm1,
	},
};

/** Core pano metadata via Google's GetMetadata RPC, decoded inside the module. */
export const svMetaProvider: EnrichmentProvider = {
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

registerEnrichmentProvider(panoResolveProvider);
registerEnrichmentProvider(svMetaProvider);
registerEnrichmentProvider(exactDateProvider);
registerEnrichmentProvider(timezoneProvider);
registerEnrichmentProvider(subdivisionProvider);

/** One summary row per pass that did work: the core metadata pass, then every
 *  provider that updated or failed at least one location. */
export interface EnrichOutcome extends ResolverOutcome {
	id: string;
	label: string;
}
export type EnrichResult = EnrichOutcome[];

/** Bulk enrich a selector: resolve missing pano ids, then run every field-producing
 *  provider (metadata, exact date, timezone, subdivision) through the Rust engine. */
export async function enrichAll(
	selector: Selector,
	opts: {
		signal?: AbortSignal;
		force?: boolean;
		onProgress?: (done: number, total: number, label?: string) => void;
	} = {},
): Promise<EnrichResult> {
	const map = getMapState().map;
	if (!map) return [];
	const enrichFields = map.meta.settings.enrichFields ?? getDefaultEnrichKeys();

	const run = await runProviders(
		[panoResolveProvider, ...enrichFieldProviders()].map((provider) => ({ provider })),
		selector,
		{ ...opts, enrichFields },
	);
	const labelOf = (id: string) => getEnrichmentProviders().find((p) => p.id === id)?.label ?? id;
	return Object.entries(run)
		.filter(([, o]) => outcomeDidWork(o))
		.map(([id, o]) => ({ id, label: labelOf(id), ...o }));
}
