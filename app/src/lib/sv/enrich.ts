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
	type BulkOpts,
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

/** One location as enrichment leaves it: every field-producing provider, narrowed to
 *  the map's enabled keys, run over that row alone. A field the row already holds is
 *  not derived again unless `force`, which re-derives every field the providers own.
 *  Nothing is written; the caller holds the result. The row comes back untouched when
 *  the map's enrichment is off. */
export async function enrich(
	loc: Location,
	opts: Pick<RunOpts, "signal" | "force"> = {},
): Promise<Location> {
	const map = getMapState().map;
	if (!map || !map.settings.enrichMetadata) return loc;
	const runs = enrichRuns(map.settings.enrichFields ?? getDefaultEnrichKeys());
	const { rows } = await runProviders(runs, [loc], opts);
	return rows[0];
}

/** The field-producing providers as enrichment runs them, each narrowed to the keys the
 *  user picked. Keys the enrichment UI never offers are always produced. */
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
export const panoResolveProvider: Provider = {
	id: "panoResolve",
	label: msg("Resolving panoramas"),
	provides: ["panoId"],
	procedure: panoResolveSpec,
};

/** Exact capture timestamp: the procedure narrows the `imageDate` month against
 *  Google's SingleImageSearch per location. */
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

/** Timezone at the location, once a `datetime` exists to interpret. The tz-lookup
 *  quadtree ships inside the module. */
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

/** Core pano metadata via Google's GetMetadata RPC, decoded inside the module. */
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
export type EnrichResult = EnrichOutcome[];

/** Bulk enrich a selector: resolve missing pano ids, then run every field-producing
 *  provider (metadata, exact date, timezone, subdivision) through the Rust engine. */
export async function enrichAll(
	selector: Selector,
	opts: BulkOpts & Pick<RunOpts, "force"> = {},
): Promise<EnrichResult> {
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
