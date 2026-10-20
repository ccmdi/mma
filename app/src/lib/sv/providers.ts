import { createFieldDef } from "@/types";
import type { CapturePick, PanoType } from "@/bindings.consts";
import {
	enabledEnrichKeys,
	getAllEnrichKeys,
	getDefaultEnrichKeys,
	knownFieldDefs,
} from "@/lib/data/fieldDefs";
import { Procedure } from "@/lib/data/procedure";
import { Provider, type ProviderRun } from "@/lib/data/provider";
import { SVMETA_FIELDS, SV_SEARCH_RADIUS } from "@/lib/sv/constants";
import { cmd } from "@/lib/commands";
import { toast } from "@/lib/util/toast";
import { msg, t } from "@/lib/i18n";

/** Build the provider run list for enrichment, narrowed to `enrichFields` and the fields they
 *  read. Fields not offered in the enrichment settings are always included. @api @unstable */
export function enrichRuns(enrichFields: string[] | null, exclude: string[] = []): ProviderRun[] {
	const selectable = new Set(getAllEnrichKeys());
	const chosen = new Set(enrichFields ?? getDefaultEnrichKeys());
	const active = new Set(enabledEnrichKeys(enrichFields));
	return Provider.list()
		.filter((p) => p.fieldDefs && !exclude.includes(p.id))
		.map((provider) => {
			const fields = Object.keys(provider.fieldDefs ?? {}).filter(
				(k) => !selectable.has(k) || active.has(k),
			);
			// A provider that runs only because a chosen field reads it fills gaps and never
			// overwrites, even in a forced run.
			const implied = fields.length > 0 && fields.every((k) => selectable.has(k) && !chosen.has(k));
			return implied ? { provider, fields, force: false } : { provider, fields };
		});
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
 *  run is forced. @api @unstable */
export const panoResolveProvider: Provider<{ panoId: string }, PanoResolveConfig> = {
	id: "panoResolve",
	label: msg("Resolving panoramas"),
	provides: ["panoId"],
	procedure: {
		entry: Procedure.entry("panoResolve"),
		batch: { mode: "chunk", size: 200 },
		config: { radius: SV_SEARCH_RADIUS },
	},
};

/** Exact capture timestamp, narrowed from the `imageDate` month via binary search. @api @unstable */
export const exactDateProvider: Provider = {
	id: "exactDate",
	label: msg("Exact dates"),
	requires: ["imageDate"],
	fieldDefs: knownFieldDefs("datetime"),
	procedure: {
		entry: Procedure.entry("exactDate"),
		batch: { mode: "chunk", size: 50 },
	},
};

/** Timezone at the location's coordinates. Requires `datetime` to be present. @api @unstable */
export const timezoneProvider: Provider = {
	id: "timezone",
	label: msg("Timezone"),
	requires: ["datetime"],
	fieldDefs: knownFieldDefs("timezone"),
	procedure: {
		entry: Procedure.entry("timezone"),
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
 *  No Google dependency; downloads the adm1 archive on first use. @api @unstable */
export const subdivisionProvider: Provider = {
	id: "subdivision",
	label: msg("Subdivision"),
	requires: ["lat", "lng"],
	fieldDefs: {
		subdivision: createFieldDef("string", { label: msg("Subdivision") }),
	},
	procedure: {
		entry: Procedure.entry("subdivision"),
		batch: { mode: "chunk", size: 2000 },
		prepare: ensureAdm1,
	},
};

/** Core panorama metadata via Google's GetMetadata RPC. @api @unstable */
export const svMetaProvider: Provider = {
	id: "svMeta",
	label: msg("Metadata"),
	requires: ["panoId"],
	fieldDefs: knownFieldDefs(...SVMETA_FIELDS),
	procedure: {
		entry: Procedure.entry("svMeta"),
		batch: { mode: "chunk", size: 1000 },
	},
};

export type RoadDirection = "forwards" | "backwards";

export interface HeadingRoadConfig {
	direction: RoadDirection;
}

/** Pan a location's heading along the road. The driving direction is the pano's
 *  `centerHeading`; "forwards" faces it, "backwards" faces the opposite. @api @unstable */
export const headingRoadProvider: Provider<unknown, HeadingRoadConfig> = {
	id: "headingRoad",
	label: msg("Pan heading along road"),
	requires: ["panoId"],
	procedure: {
		entry: Procedure.entry("headingRoad"),
		batch: { mode: "dedupeBy", key: "panoId" },
	},
};

/** The providers the app registers at startup. @api @unstable */
export const BUILTIN_PROVIDERS: readonly Provider[] = [
	panoResolveProvider,
	svMetaProvider,
	exactDateProvider,
	timezoneProvider,
	subdivisionProvider,
	headingRoadProvider,
];
