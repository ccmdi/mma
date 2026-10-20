// Read-only Street View queries.

import { Procedure } from "@/lib/data/procedure";
import { panoResolveProvider, svMetaProvider } from "@/lib/sv/providers";
import type { LatLng } from "@/types";
import type { Pano, PanoAnswer } from "@/bindings.gen";
import type { PanoType, RankingStrategy } from "@/bindings.consts";
import { SV_SEARCH_RADIUS } from "@/lib/sv/constants";

export interface SearchOpts {
	sources?: PanoType[];
	preference?: RankingStrategy;
}

/** Full pano metadata for one or more panos, aligned to `panoIds`, null where a pano does
 *  not exist. Rejects when a lookup fails, so a failure is never taken for a missing pano.
 *  Duplicates are deduped and large batches are split automatically. @api */
export async function svMetadata(
	panoIds: string[],
	signal?: AbortSignal,
): Promise<(Pano | null)[]> {
	if (panoIds.length === 0) return [];
	const answers = await Procedure.query<PanoAnswer[]>(
		svMetaProvider.procedure,
		{ op: "metadata", panoIds },
		{ signal },
	);
	if (!Array.isArray(answers)) throw new Error(`svMeta query answered ${typeof answers}`);
	if (answers.some((a) => a.state === "failed")) throw new Error("Street View lookup failed");
	return panoIds.map((_, i) => {
		const answer = answers[i];
		return answer?.state === "found" ? answer.pano : null;
	});
}

/** The nearest pano to each point, aligned to `points`, null where there is no coverage.
 *  `opts.sources` narrows which collections are searched and `opts.preference` picks
 *  nearest or best. `onPano` sees each point's answer the moment its search resolves,
 *  ahead of the full array. @api */
export async function panosAt(
	points: LatLng[],
	radius = SV_SEARCH_RADIUS,
	opts?: SearchOpts,
	signal?: AbortSignal,
	onPano?: (index: number, pano: Pano | null) => void,
): Promise<(Pano | null)[]> {
	if (points.length === 0) return [];
	const answers = await Procedure.query<(Pano | null)[], PanoAnswer>(
		panoResolveProvider.procedure,
		{ op: "at", points, radius, ...opts },
		{
			signal,
			onPartial:
				onPano &&
				((entries) => {
					for (const e of entries) onPano(e.id, e.value.state === "found" ? e.value.pano : null);
				}),
		},
	);
	if (!Array.isArray(answers)) throw new Error(`panoResolve query answered ${typeof answers}`);
	return points.map((_, i) => answers[i] ?? null);
}
