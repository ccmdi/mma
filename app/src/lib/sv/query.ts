// The app's read-only Street View queries, each answered by a procedure. The wire formats
// live in `@/lib/sv/getMetadata` and `@/lib/sv/singleImageSearch`, which the app and those
// procedures both bundle.

import { procedureEntry, queryProcedure } from "@/lib/data/procedures";
import type { LatLng, Pano } from "@/types";
import type { SearchOpts } from "@/lib/sv/singleImageSearch";
import { SV_SEARCH_RADIUS } from "@/lib/sv/constants";

const SVMETA_ENTRY = procedureEntry("svMeta");

/** Full pano metadata for arbitrarily many panos, aligned to `panoIds`. The procedure
 *  dedupes and splits at GetMetadata's 200-per-request cap itself. */
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
 *  `opts.sources` narrows which collections are searched (`[PanoType.Official]` is what
 *  `sources: ["google"]` means to the Maps JS API) and `opts.preference` picks nearest or
 *  best. The procedure hands every point to the host at once, so how many run concurrently
 *  stays the engine's call. */
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
