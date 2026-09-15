// Read-only Street View queries.

import { queryProcedure } from "@/lib/data/procedures";
import { panoResolveProvider, svMetaProvider } from "@/lib/sv/enrich";
import type { LatLng } from "@/types";
import type { Pano } from "@/bindings.gen";
import type { PanoType, RankingStrategy } from "@/bindings.consts";
import { SV_SEARCH_RADIUS } from "@/lib/sv/constants";

export interface SearchOpts {
	sources?: PanoType[];
	preference?: RankingStrategy;
}

/** Full pano metadata for one or more panos, aligned to `panoIds`. Duplicates are
 *  deduped and large batches are split automatically. */
export async function svMetadata(
	panoIds: string[],
	signal?: AbortSignal,
): Promise<(Pano | null)[]> {
	if (panoIds.length === 0) return [];
	const answers = await queryProcedure<(Pano | null)[]>(
		svMetaProvider.procedure,
		{ op: "metadata", panoIds },
		signal,
	);
	if (!Array.isArray(answers)) throw new Error(`svMeta query answered ${typeof answers}`);
	return panoIds.map((_, i) => answers[i] ?? null);
}

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
		panoResolveProvider.procedure,
		{ op: "at", points, radius, ...opts },
		signal,
	);
	if (!Array.isArray(answers)) throw new Error(`panoResolve query answered ${typeof answers}`);
	return points.map((_, i) => answers[i] ?? null);
}
