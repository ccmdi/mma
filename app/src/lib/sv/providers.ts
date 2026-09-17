import { createFieldDef } from "@/types";
import type { CapturePick, PanoType } from "@/bindings.consts";
import {
	getAllEnrichKeys,
	getProviders,
	getDefaultEnrichKeys,
	knownFieldDefs,
	registerProvider,
	type Provider,
} from "@/lib/data/fieldDefs";
import { procedureEntry, type ProviderRun } from "@/lib/data/procedures";
import {
	GET_METADATA_INFLIGHT,
	LOCATION_SEARCH_INFLIGHT,
	SVMETA_FIELDS,
	SV_SEARCH_RADIUS,
} from "@/lib/sv/constants";
import { cmd } from "@/lib/commands";
import { toast } from "@/lib/util/toast";
import { msg, t } from "@/lib/i18n";

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

/** Where to search when resolving a pano from coordinates, and which capture of its
 *  timeline to settle on. */
export interface PanoResolveConfig {
	radius: number;
	sources?: PanoType[];
	capture?: CapturePick;
}

/** Pano-resolve provider for enrichment. Writes the `panoId` field and runs before any
 *  provider that depends on it. Rows that already have a pano id are skipped unless the
 *  run is forced. */
export const panoResolveProvider: Provider<{ panoId: string }, PanoResolveConfig> = {
	id: "panoResolve",
	label: msg("Resolving panoramas"),
	provides: ["panoId"],
	procedure: {
		entry: procedureEntry("panoResolve"),
		batch: { mode: "chunk", size: 200 },
		inflight: LOCATION_SEARCH_INFLIGHT,
		config: { radius: SV_SEARCH_RADIUS },
	},
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
		inflight: GET_METADATA_INFLIGHT,
	},
};

registerProvider(panoResolveProvider);
registerProvider(svMetaProvider);
registerProvider(exactDateProvider);
registerProvider(timezoneProvider);
registerProvider(subdivisionProvider);
