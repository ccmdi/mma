import { angularDelta, distMeters } from "@/lib/geo/geo";
import { fetchPanoDotsWithIds } from "@/lib/geo/photometa";
import { latLngToWorld, worldToTile } from "@/lib/geo/mercator";
import { cameraTypeFromHeight, centerHeading, imageDateOf } from "@/lib/sv/getMetadata";
import { isUnofficial } from "@/lib/sv/panoId";
import { panosAt, svMetadata } from "@/lib/sv/query";
import { isPinned, createLocation } from "@/types";
import { LocationFlag, PanoType } from "@/bindings.consts";
import type { LatLng, Pano } from "@/types";
import type { CameraType, Location } from "@/bindings.gen";

import { SV_SEARCH_RADIUS } from "@/lib/sv/constants";
import { reverseHeading } from "@/lib/geo/geo";
import { bestBy } from "@/lib/util/util";

/** The pano a location should display: the one it is pinned to when that still resolves,
 *  otherwise whatever sits at its coordinates. */
export async function resolvePano(loc: Location): Promise<Pano | null> {
	if (isPinned(loc)) {
		const [pinned] = await svMetadata([loc.panoId]);
		if (pinned) return pinned;
	}
	const [here] = await panosAt([{ lat: loc.lat, lng: loc.lng }]);
	return here;
}

/** True when the location names a pano that no longer resolves, so `resolvePano` fell back
 *  to its coordinates. */
export function isPanoFallback(loc: Location, resolved: Pano | null): boolean {
	return isPinned(loc) && resolved?.pano !== loc.panoId;
}

/** Compute SV search radius in meters based on map zoom and latitude. */
export function svSearchRadius(lat: number, zoom: number): number {
	return (4 * (156543.03392 * Math.cos((lat * Math.PI) / 180))) / 2 ** zoom;
}

/** The radius (m) a map click searches for SV coverage: the zoom/lat extent, floored
 *  by `minRadius` (the per-map searchRadius) or the 50m default. Single source of truth
 *  for both the click path and the cursor picker overlay. */
export function clickSearchRadius(lat: number, zoom: number, minRadius?: number): number {
	return Math.max(minRadius ?? SV_SEARCH_RADIUS, Math.round(svSearchRadius(lat, zoom)));
}

/** Heading among `headings` closest to `target` by shortest angular distance, or null if empty. */
export function nearestLinkHeading(headings: number[], target: number): number | null {
	return bestBy(headings, (a, b) => angularDelta(a, target) < angularDelta(b, target));
}

/** Determine initial heading for a location based on road links and direction preference. */
export function calcHeading(
	data: Pano,
	opts?: { pointAlongRoad?: boolean; preferDirection?: string | null },
): number {
	if (!opts?.pointAlongRoad) return 0;
	const center = centerHeading(data);
	const dir = opts.preferDirection;
	if (dir === "forwards" || !dir) {
		if (!dir && data.links && data.links.length > 0 && data.links[0].heading != null) {
			return data.links[0].heading;
		}
		return center;
	}
	if (dir === "backwards") return reverseHeading(center);
	if (data.links && data.links.length > 0) {
		let link = data.links[0];
		if (dir === "random") {
			link = data.links[Math.floor(Math.random() * data.links.length)];
		} else {
			const target: Record<string, number> = { north: 0, east: 90, south: 180, west: 270 };
			const t = target[dir];
			if (t != null) {
				link =
					bestBy(
						data.links,
						(a, b) => angularDelta(a.heading ?? 0, t) < angularDelta(b.heading ?? 0, t),
					) ?? link;
			}
		}
		if (link.heading != null) return link.heading;
	}
	return center;
}

/** Nearest pano via photometa tile dots, a coverage source neither RPC exposes. */
export async function photometaSnap(click: LatLng, radius: number): Promise<Pano | null> {
	try {
		const wc = latLngToWorld(click);
		const tile = worldToTile(wc.x, wc.y, 17);
		const dots = await fetchPanoDotsWithIds(tile);
		if (!dots.length) return null;
		const scored = dots
			.map((d) => ({ panoId: d.panoId, dist: distMeters(click, { lat: d.lat, lng: d.lng }) }))
			.filter((d) => d.dist < radius);
		const best = bestBy(scored, (a, b) => a.dist < b.dist);
		if (!best) return null;
		const [pano] = await svMetadata([best.panoId]);
		return pano;
	} catch {
		return null;
	}
}

/** Preference order under `preferHigherQuality`, lower first. `null` means the type is not a candidate at that setting. */
const CAMERA_RANK: Record<CameraType, number | null> = {
	gen4: 0,
	gen2: 1,
	tripod: 2,
	badcam: 3,
	gen1: 4,
	trekker: null,
};

/**
 * Full Street View lookup for map click: finds best panorama near the click point,
 * resolves heading, and determines LoadAsPanoId flag by comparing to default coverage.
 */
export async function lookupStreetView(
	lat: number,
	lng: number,
	zoom: number,
	opts: {
		preferOfficial?: boolean;
		onlyOfficial?: boolean;
		pointAlongRoad?: boolean;
		preferDirection?: string | null;
		defaultPanoId?: boolean;
		preferHigherQuality?: boolean;
		radius?: number;
		minRadius?: number;
	},
): Promise<Location | null> {
	const radius = opts.radius ?? clickSearchRadius(lat, zoom, opts.minRadius);
	const click = { lat, lng };
	const userUploaded: "ignore" | "avoid" | "allow" = opts.onlyOfficial
		? "ignore"
		: opts.preferOfficial
			? "avoid"
			: "allow";

	// Each probe is one request, and answers the pano's metadata with it. All three are
	// nearest searches; only the collections differ.
	const [[iRes], [aRes], oRes, sRes] = await Promise.all([
		panosAt([click], radius),
		panosAt([click], radius, { sources: [PanoType.Official] }),
		photometaSnap(click, radius),
		userUploaded === "allow"
			? panosAt([click], radius, {
					sources: [PanoType.Unknown, PanoType.UserUploaded],
				}).then(([p]) => p)
			: null,
	]);

	const candidates: Pano[] = [];
	const push = (e: Pano | null) => {
		if (!e?.pano) return;
		if (!candidates.some((c) => c.pano === e.pano)) candidates.push(e);
	};

	if (iRes && sRes) {
		const di = distMeters(click, { lat: iRes.lat, lng: iRes.lng });
		const ds = distMeters(click, { lat: sRes.lat, lng: sRes.lng });
		push(di > ds ? sRes : iRes);
	} else {
		push(iRes);
	}
	push(aRes);
	push(oRes);
	push(sRes);

	const official = candidates.find((c) => !isUnofficial(c));
	if (official?.time.length) {
		// The whole historical stack, in one request.
		for (const p of await svMetadata(official.time.map((t) => t.pano))) push(p);
	}

	let filtered = candidates;
	if (userUploaded === "ignore") filtered = filtered.filter((c) => !isUnofficial(c));

	if (opts.preferHigherQuality) {
		filtered = filtered.filter((c) => {
			const ct = cameraTypeFromHeight(c.worldSize.height);
			return ct == null || CAMERA_RANK[ct] !== null;
		});
	}

	filtered.sort((x, y) => {
		if (userUploaded === "avoid") {
			const xu = isUnofficial(x);
			const yu = isUnofficial(y);
			if (xu && !yu) return 1;
			if (!xu && yu) return -1;
		}
		if (opts.preferHigherQuality) {
			const xc = cameraTypeFromHeight(x.worldSize.height);
			const yc = cameraTypeFromHeight(y.worldSize.height);
			if (xc != null && yc == null) return -1;
			if (xc == null && yc != null) return 1;
			if (xc != null && yc != null) {
				const xi = CAMERA_RANK[xc] ?? Infinity;
				const yi = CAMERA_RANK[yc] ?? Infinity;
				if (xi < yi) return -1;
				if (xi > yi) return 1;
			}
		}
		if (userUploaded === "allow") return 0;
		const xd = imageDateOf(x) || "9999-99";
		const yd = imageDateOf(y) || "9999-99";
		return -xd.localeCompare(yd);
	});

	const chosen = filtered[0];
	if (!chosen) return null;

	const [verify] = await panosAt([{ lat: chosen.lat, lng: chosen.lng }], SV_SEARCH_RADIUS);
	const isDefault = verify !== null && verify.pano === chosen.pano;

	const heading = calcHeading(chosen, opts);
	return createLocation({
		lat: chosen.lat,
		lng: chosen.lng,
		heading,
		panoId: chosen.pano || null,
		flags: !isDefault || opts.defaultPanoId ? LocationFlag.LoadAsPanoId : LocationFlag.None,
	});
}

/**
 * Walk linked panoramas from a starting pano in the given heading direction.
 * Returns an array of locations along the road, up to `maxSteps`.
 */
export async function followLinkedPanos(
	startPanoId: string,
	heading: number,
	maxSteps = 50,
): Promise<Location[]> {
	const visited = new Set<string>([startPanoId]);
	const results: Location[] = [];
	let currentPanoId = startPanoId;
	let currentHeading = heading;

	for (let i = 0; i < maxSteps; i++) {
		const [data] = await svMetadata([currentPanoId]);
		const links = data?.links;
		if (!links || links.length === 0) break;

		const usable = links
			.filter((l) => l.pano && !visited.has(l.pano))
			.map((l) => ({ pano: l.pano, heading: l.heading ?? 0 }));
		const best = bestBy(
			usable,
			(a, b) => angularDelta(a.heading, currentHeading) < angularDelta(b.heading, currentHeading),
		);
		if (!best || angularDelta(best.heading, currentHeading) > 90) break;

		visited.add(best.pano);
		const [nextData] = await svMetadata([best.pano]);
		if (!nextData) break;

		const pos = { lat: nextData.lat, lng: nextData.lng };
		results.push(
			createLocation({
				lat: pos.lat,
				lng: pos.lng,
				heading: best.heading,
				panoId: best.pano,
				flags: LocationFlag.LoadAsPanoId,
			}),
		);

		currentPanoId = best.pano;
		currentHeading = best.heading;
	}
	return results;
}

export function svThumbnailUrl(panoId: string, heading: number, width = 320, height = 180): string {
	const url = new URL("https://streetviewpixels-pa.googleapis.com/v1/thumbnail?w=320&h=180");
	url.searchParams.set("panoid", panoId);
	url.searchParams.set("cb_client", "maps_sv.share");
	url.searchParams.set("w", String(width));
	url.searchParams.set("h", String(height));
	url.searchParams.set("yaw", String(heading));
	url.searchParams.set("pitch", "0");
	url.searchParams.set("thumbfov", "90");
	return url.toString();
}
