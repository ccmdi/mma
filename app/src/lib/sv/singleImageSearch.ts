/**
 * Google's SingleImageSearch RPC. The bodies are array-JSON ("json+protobuf"): a JSON
 * array whose element positions are the protobuf field numbers.
 *
 * `buildLocationSearchBody` mirrors what the Maps JS API sends for
 * `StreetViewService.getPanorama({location, radius})`: context.productId "apiv3"
 * (field 1), the LatLng + radius (field 2), and in the options (field 3) the search
 * preference (field 9) plus the source set (field 11: frontends 2, 3 and 10, each
 * enabled). Field 4 is the component mask. Locale and region are
 * omitted -- they only localize descriptions nothing here reads.
 *
 * Leaf module: `panoAtCoords`/`panosAtCoords` run against the procedure host (`mma`)
 * and only work inside a procedure. The body builders and the reader are pure.
 */

import { parseImageArray } from "@/lib/sv/getMetadata";
import type { Pano } from "@/types";
import { PanoType } from "@/types";
import type { ProcedureRequest } from "@/lib/data/procedureHost";

export const SINGLE_IMAGE_SEARCH_URL =
	"https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/SingleImageSearch";

export const SIS_NO_IMAGES = "Search returned no images.";

/** Half the Earth's circumference: the radius clamp the Maps JS API applies. */
const MAX_RADIUS = 6378137 * Math.PI;

function latLngRadius(lat: number, lng: number, radius: number) {
	return [[null, null, lat, lng], Math.min(Math.max(radius, 0), MAX_RADIUS)];
}

/** Coverage probe over the capture-time window (start, end], in Unix seconds. */
export function buildTimestampSearchBody(
	lat: number,
	lng: number,
	radius: number,
	start: number,
	end: number,
): string {
	return JSON.stringify([
		["apiv3"],
		latLngRadius(lat, lng, radius),
		[
			[null, null, null, null, null, null, null, null, null, null, [start, end]],
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			[1],
			null,
			[[[2, true, 2]]],
		],
		[[2, 6]],
	]);
}

/** Which pano a location search picks. An omitted preference goes on the wire as
 *  `Nearest`; the Maps JS API's encoder has no other default, whatever its docs say. */
export const enum SearchPreference {
	Best = 1,
	Nearest = 2,
}

export interface SearchOpts {
	sources?: PanoType[];
	preference?: SearchPreference;
}

/** What a search covers when the caller names no sources: every frontend, which is what the
 *  Maps JS API's `getPanorama({location})` searched. Verified live on six coordinates: the
 *  API's cold answer is this search's nearest pano each time, and the official frontend on
 *  its own misses user coverage entirely. (The API's answer drifts with its session -- it
 *  sends a session id this search does not -- so only cold calls compare.) */
export const ALL_SOURCES: PanoType[] = [PanoType.Official, PanoType.Unknown, PanoType.UserUploaded];

/** Nearest panorama within `radius` metres of the point, searching `sources`. */
export function buildLocationSearchBody(
	lat: number,
	lng: number,
	radius: number,
	opts: SearchOpts = {},
): string {
	const frontends = (opts.sources ?? ALL_SOURCES).map((f) => [f, true, 2]);
	const preference = opts.preference ?? SearchPreference.Nearest;

	return JSON.stringify([
		["apiv3"],
		latLngRadius(lat, lng, radius),
		[null, null, null, null, null, null, null, null, [preference], null, [frontends]],
		[[1, 2, 3, 4, 8, 6]],
	]);
}

/** The pano a location search found, or null for no coverage and for anything the Maps JS
 *  API would not have reported as OK. */
export function parseSearch(text: string): Pano | null {
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch {
		return null;
	}
	if (!Array.isArray(root)) return null;
	// response.status.code: 0 is OK, 5 (and a missing result) mean no coverage.
	const status: unknown = root[0];
	if (!Array.isArray(status) || status[0] !== 0) return null;
	const result: unknown = root[1];
	if (!Array.isArray(result)) return null;
	// result.status.code: 1 and 3 are OK, 2 is ZERO_RESULTS.
	const rstatus: unknown = result[0];
	if (!Array.isArray(rstatus)) return null;
	if (rstatus[0] !== 1 && rstatus[0] !== 3) return null;
	const pano = parseImageArray(result);
	return pano?.pano ? pano : null;
}

// --- lookup ---

function searchRequest(body: string): ProcedureRequest {
	return {
		method: "POST",
		url: SINGLE_IMAGE_SEARCH_URL,
		headers: { "content-type": "application/json+protobuf" },
		body,
	};
}

/** One coverage probe over (start, end], ready for `mma.fetchMany`. */
export function timestampSearchRequest(
	lat: number,
	lng: number,
	radius: number,
	start: number,
	end: number,
): ProcedureRequest {
	return searchRequest(buildTimestampSearchBody(lat, lng, radius, start, end));
}

const decoder = new TextDecoder();

/** `panoAtCoords` for many points at once, answered in input order. One host call, so
 *  how many run concurrently stays the host's decision rather than the procedure's. The
 *  response carries the pano's metadata, so nothing needs a second lookup. */
export function panosAtCoords(
	points: { lat: number; lng: number }[],
	radius: number,
	opts?: SearchOpts,
): (Pano | null)[] {
	const res = mma.fetchMany(
		points.map((p) => searchRequest(buildLocationSearchBody(p.lat, p.lng, radius, opts))),
	);
	return points.map((_, i) => {
		const r = res[i];
		return r && r.status >= 200 && r.status < 300 ? parseSearch(decoder.decode(r.body)) : null;
	});
}

/** The nearest pano within `radius` metres, or null when there is no coverage and when the
 *  request failed -- every caller treats the two the same. */
export function panoAtCoords(
	lat: number,
	lng: number,
	radius: number,
	opts?: SearchOpts,
): Pano | null {
	return panosAtCoords([{ lat, lng }], radius, opts)[0];
}
