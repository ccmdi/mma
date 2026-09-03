// The app's read-only Street View queries, each answered by a procedure. The wire formats
// live in `@/lib/sv/getMetadata` and `@/lib/sv/singleImageSearch`, which the app and those
// procedures both bundle.

import { procedureEntry, queryProcedure } from "@/lib/data/procedures";
import type { LatLng, Pano } from "@/types";
import { allUnofficial, mergeTimelines } from "@/lib/sv/getMetadata";
import { SV_SEARCH_RADIUS } from "@/lib/sv/constants";
import { PanoType } from "@/bindings.consts";
import type { SearchOpts } from "@/lib/sv/singleImageSearch";

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

/** Everything known about the spot a pano stands on: its metadata, and the timeline of
 *  every pano within reach of its coordinate. A partly-official stack picks up the rest
 *  of its history from the neighbour; an all-unofficial one asks for the official stack
 *  outright, last so its entries win. Null when the pano has no metadata. */
export interface PanoSpot {
	meta: Pano;
	timeline: Pano["time"];
}
export async function panoSpot(pano: string, signal?: AbortSignal): Promise<PanoSpot | null> {
	const [meta] = await svMetadata([pano], signal);
	if (!meta) return null;
	const here = [{ lat: meta.lat, lng: meta.lng }];
	const [atCoord] = await panosAt(here, SV_SEARCH_RADIUS, undefined, signal);
	let timeline = mergeTimelines([atCoord, meta]);
	if (allUnofficial(timeline)) {
		const [official] = await panosAt(here, 25, { sources: [PanoType.Official] }, signal);
		timeline = mergeTimelines([atCoord, meta, official]);
	}
	return { meta, timeline };
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
