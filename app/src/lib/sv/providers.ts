import { createFieldDef, type Selector } from "@/types";
import { PanoType, ValidationFlag, type CapturePick } from "@/bindings.consts";
import {
	enabledEnrichKeys,
	getAllEnrichKeys,
	getDefaultEnrichKeys,
	knownFieldDefs,
} from "@/lib/data/fieldDefs";
import {
	Procedure,
	type BatchOutcome,
	type BulkOpts,
	type ProcedureOutcomes,
	type ProcedureSpec,
	type RunOpts,
} from "@/lib/data/procedure";
import { Provider, type ProviderRun } from "@/lib/data/provider";
import { SVMETA_FIELDS, SV_SEARCH_RADIUS } from "@/lib/sv/rules";
import {
	STANDARD_VALIDATION_CATEGORIES,
	VALIDATION_CATEGORIES,
	type ValidationAnswer,
} from "@/lib/sv/validationCategories";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { toast } from "@/lib/util/toast";
import { msg, t } from "@/lib/i18n";
import { Store } from "@/store/store";
import { all, any, lacks } from "@/store/selections";

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

/** Enrich the locations in `selector` with every enrichment field the open map has on,
 *  resolving their panoramas first unless `resolve` is false. @api @unstable */
export async function enrich(
	selector: Selector,
	{ resolve = true, ...opts }: RunOpts & { resolve?: boolean } = {},
): Promise<ProcedureOutcomes> {
	const map = Store.get().map;
	if (!map) return {};
	const fields = enabledEnrichKeys(map.settings.enrichFields);
	const runs = enrichRuns(map.settings.enrichFields ?? null);
	if (resolve) {
		runs.unshift({
			provider: panoResolveProvider,
			select: opts.force ? undefined : all(selector, any(...fields.map(lacks))),
			force: false,
		});
	}
	return Provider.run(runs, selector, opts);
}

/** Configuration for Street View validation: the radius of the coordinate lookup. */
export interface ValidateConfig {
	radius: number;
}

/** What a validation run answered: the ids in each asked-for category that any location
 *  fell into, keyed by category in table order, over the outcome every run reports. */
export interface ValidationOutcome extends BatchOutcome {
	categories: Map<string, number[]>;
}

/** Street View coverage validation. Checks each location's stored pano, coordinate
 *  lookup, unofficial status, camera quality, and timeline. Answers with a
 *  `ValidationAnswer` per location without writing anything. */
const validateSpec: ProcedureSpec<ValidationAnswer, ValidateConfig> = {
	entry: Procedure.entry("validate"),
	batch: { mode: "chunk", size: 200 },
	sink: "collect",
	config: { radius: SV_SEARCH_RADIUS },
};

const KNOWN_BITS = Object.values(ValidationFlag).reduce<number>((all, f) => all | f, 0);

/** Check that each location's Street View coverage still exists, grouping the locations
 *  into `categories` (keys of `VALIDATION_CATEGORIES`; the standard ones when omitted). @api @unstable */
export async function validateLocations(
	selector: Selector,
	opts: BulkOpts & { config?: Partial<ValidateConfig>; categories?: readonly string[] } = {},
): Promise<ValidationOutcome> {
	const { categories: asked = STANDARD_VALIDATION_CATEGORIES, ...runOpts } = opts;
	const run = await Procedure.run(validateSpec, selector, {
		id: "validate",
		label: msg("Validating"),
		...runOpts,
	});

	const wanted = VALIDATION_CATEGORIES.filter((c) => asked.includes(c.key));
	const ids = wanted.map((): number[] => []);
	for (const { id, value: answer } of run.collected ?? []) {
		if ((answer.flags & ~KNOWN_BITS) !== 0) {
			log.warn(`[validate] location ${id}: unknown validation flags ${String(answer.flags)}`);
			continue;
		}
		wanted.forEach((c, i) => {
			if (c.test(answer)) ids[i].push(id);
		});
	}
	const categories = new Map(
		wanted.flatMap((c, i) => (ids[i].length > 0 ? [[c.key, ids[i]] as const] : [])),
	);
	return { succeeded: run.succeeded, failed: run.failed, categories };
}
