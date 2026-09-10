// Read-only Street View queries.

import { procedureEntry, queryProcedure } from "@/lib/data/procedures";
import type { LatLng } from "@/types";
import type { Pano } from "@/bindings.gen";
import type { PanoType, RankingStrategy } from "@/bindings.consts";
import { SV_SEARCH_RADIUS } from "@/lib/sv/constants";

export interface SearchOpts {
	sources?: PanoType[];
	preference?: RankingStrategy;
}

const SVMETA_ENTRY = procedureEntry("svMeta");

/** Full pano metadata for one or more panos, aligned to `panoIds`. Duplicates are
 *  deduped and large batches are split automatically. */
export async function svMetadata(
	panoIds: string[],
	signal?: AbortSignal,
): Promise<(Pano | null)[]> {
	if (panoIds.length === 0) return [];
	const answers = await queryProcedure<(Pano | null)[]>(
		SVMETA_ENTRY,
		{ op: "metadata", panoIds },
		undefined,
		signal,
	);
	if (!Array.isArray(answers)) throw new Error(`svMeta query answered ${typeof answers}`);
	return panoIds.map((_, i) => answers[i] ?? null);
}

const PANORESOLVE_ENTRY = procedureEntry("panoResolve");

/** The nearest pano to each point, aligned to `points`, null where there is no coverage.
 *  `opts.sources` narrows which collections are searched and `opts.preference` picks
 *  nearest or best. */
export async function panosAt(
	points: LatLng[],
	radius = SV_SEARCH_RADIUS,
	opts?: SearchOpts,
	signal?: AbortSignal,
): Promise<(Pano | null)[]> {
	if (points.length === 0) return [];
	const answers = await queryProcedure<(Pano | null)[]>(
		PANORESOLVE_ENTRY,
		{ op: "at", points, radius, ...opts },
		undefined,
		signal,
	);
	if (!Array.isArray(answers)) throw new Error(`panoResolve query answered ${typeof answers}`);
	return points.map((_, i) => answers[i] ?? null);
}
