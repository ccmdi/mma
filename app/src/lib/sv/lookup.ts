import { distMeters } from "@/lib/geo/geo";
import { fetchPanoDotsWithIds, latLngToWorldCoord } from "@/lib/geo/photometa";
import { google } from "@/lib/sv/opensv";
import { cameraTypeFromHeight, fetchSvMetadata } from "@/lib/sv/svMeta";
import { LocationFlag, hasLoadAsPanoId, createLocation } from "@/types";
import type { LatLng } from "@/types";
import type { Location } from "@/bindings.gen";
import { toast } from "@/lib/util/toast";
import { runConcurrent } from "@/lib/util/concurrent";

import { SV_SEARCH_RADIUS, SV_CONCURRENCY } from "@/lib/sv/constants";
import { type RequireNonNull } from "@/types/util";

/** A single historical panorama entry (pano ID + capture date). */
export interface PanoReference {
	pano: string;
	date: Date;
}

/** Normalize the various date formats opensv returns into a Date. */
export function parsePanoDate(d: Date | { year?: number; month?: number } | string | null): Date {
	if (d instanceof Date && !isNaN(d.getTime())) return d;
	if (d && typeof d === "object" && "year" in d) {
		return new Date(d.year ?? 0, (d.month ?? 1) - 1);
	}
	if (typeof d === "string" && d.includes("-")) {
		const [y, m] = d.split("-").map(Number);
		return new Date(y, (m ?? 1) - 1);
	}
	return new Date(0);
}

/** Fetch panorama data via StreetViewService. Returns null on failure or missing location. */
export async function fetchPanoData(
	request: google.maps.StreetViewPanoRequest | google.maps.StreetViewLocationRequest,
): Promise<google.maps.StreetViewResolvedPanoramaData | null> {
	try {
		const sv = new google.maps.StreetViewService();
		const result = await sv.getPanorama(request);
		const data = result?.data;
		if (data?.location?.latLng) return data as google.maps.StreetViewResolvedPanoramaData;
		return null;
	} catch {
		return null;
	}
}

export async function getPanoAtCoords(
	lat: number,
	lng: number,
	radius = SV_SEARCH_RADIUS,
): Promise<string | null> {
	const sv = new google.maps.StreetViewService();
	try {
		const result = await sv.getPanorama({ location: { lat, lng }, radius });
		return result.data.location?.pano ?? null;
	} catch {
		return null;
	}
}

export interface ResolvedPano {
	pano: google.maps.StreetViewResolvedPanoramaData | null;
	isFallback: boolean;
}

export async function resolvePano(loc: Location): Promise<ResolvedPano> {
	const pinned = hasLoadAsPanoId(loc);
	let resolved: google.maps.StreetViewResolvedPanoramaData | null = null;
	if (pinned && loc.panoId) {
		resolved = await fetchPanoData({ pano: loc.panoId });
	}
	resolved ??= await fetchPanoData({
		location: { lat: loc.lat, lng: loc.lng },
		radius: SV_SEARCH_RADIUS,
	});
	return {
		pano: resolved,
		isFallback: pinned && loc.panoId != null && resolved?.location?.pano !== loc.panoId,
	};
}

interface ResolvePanoResult {
	resolved: RequireNonNull<Pick<Location, "id" | "panoId">>[];
	failed: number[];
}

export async function resolvePanoIds(
	locations: Location[],
	opts: {
		concurrency?: number;
		batchSize?: number;
		signal?: AbortSignal;
		onProgress?: (done: number, total: number) => void;
	} = {},
): Promise<ResolvePanoResult> {
	const { concurrency = SV_CONCURRENCY, batchSize = 200, signal, onProgress } = opts;
	const result: ResolvePanoResult = { resolved: [], failed: [] };
	if (!google) return result;

	for (let i = 0; i < locations.length; i += batchSize) {
		signal?.throwIfAborted();
		const chunk = locations.slice(i, i + batchSize);
		await runConcurrent(
			chunk,
			async (loc) => {
				const pano = await getPanoAtCoords(loc.lat, loc.lng);
				if (pano) {
					result.resolved.push({ id: loc.id, panoId: pano });
				} else {
					result.failed.push(loc.id);
				}
			},
			{ concurrency, signal },
		);
		onProgress?.(Math.min(i + chunk.length, locations.length), locations.length);
	}

	return result;
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

/** Clamp heading to [-180, 180]. */
export function normalizeHeading(h: number): number {
	return h > 180 ? h - 360 : h < -180 ? h + 360 : h;
}

/** Heading among `headings` closest to `target` by shortest angular distance, or null if empty. */
export function nearestLinkHeading(headings: number[], target: number): number | null {
	let best: number | null = null;
	let bestDelta = Infinity;
	for (const h of headings) {
		const d = Math.abs(normalizeHeading(h - target));
		if (d < bestDelta) {
			bestDelta = d;
			best = h;
		}
	}
	return best;
}

/** Determine initial heading for a location based on road links and direction preference. */
export function calcHeading(
	data: google.maps.StreetViewResolvedPanoramaData,
	opts?: { pointAlongRoad?: boolean; preferDirection?: string | null },
): number {
	if (!opts?.pointAlongRoad) return 0;
	const center = data.tiles.centerHeading ?? data.tiles.originHeading ?? 0;
	const dir = opts.preferDirection;
	if (dir === "forwards" || !dir) {
		if (!dir && data.links && data.links.length > 0 && data.links[0].heading != null) {
			return data.links[0].heading;
		}
		return center;
	}
	if (dir === "backwards") return normalizeHeading(center - 180);
	if (data.links && data.links.length > 0) {
		let link = data.links[0];
		if (dir === "random") {
			link = data.links[Math.floor(Math.random() * data.links.length)];
		} else {
			const target: Record<string, number> = { north: 0, east: 90, south: 180, west: 270 };
			const t = target[dir];
			if (t != null) {
				link = data.links.reduce((best, cur) =>
					Math.abs(normalizeHeading((best.heading ?? 0) - t)) >
					Math.abs(normalizeHeading((cur.heading ?? 0) - t))
						? cur
						: best,
				);
			}
		}
		if (link.heading != null) return link.heading;
	}
	return center;
}

/** Extract plain {lat, lng} from a PanoData's LatLng object. */
export function panoLatLng(p: google.maps.StreetViewResolvedPanoramaData): LatLng {
	const ll = p.location.latLng;
	return { lat: ll.lat(), lng: ll.lng() };
}

/** True if both PanoData reference the same panorama ID. */
export function samePano(
	a: google.maps.StreetViewResolvedPanoramaData | null,
	b: google.maps.StreetViewResolvedPanoramaData | null,
): boolean {
	return !!(a?.location?.pano && b?.location?.pano && a.location.pano === b.location.pano);
}

/** Heuristic: true if the pano is user-uploaded (long ID or copyright attribution). */
export function isUnofficial(p: google.maps.StreetViewResolvedPanoramaData | null): boolean {
	const pano = p?.location?.pano;
	if (!pano) return false;
	if (pano.length > 22) return true;
	const src = p?.location?.shortDescription ?? p?.copyright ?? "";
	return /photo by|user[- ]uploaded/i.test(src);
}

/** Find nearest pano via photometa tile dots (bypasses StreetViewService for coverage discovery). */
export async function photometaSnap(
	click: LatLng,
	radius: number,
): Promise<google.maps.StreetViewResolvedPanoramaData | null> {
	try {
		const wc = latLngToWorldCoord(click.lat, click.lng);
		const tile = { x: Math.floor((wc.x * 2 ** 17) / 256), y: Math.floor((wc.y * 2 ** 17) / 256) };
		const dots = await fetchPanoDotsWithIds(tile);
		if (!dots.length) return null;
		let best: { panoId: string; dist: number } | null = null;
		for (const d of dots) {
			const dist = distMeters(click, { lat: d.lat, lng: d.lng });
			if (dist < radius && (!best || dist < best.dist)) best = { panoId: d.panoId, dist };
		}
		if (!best) return null;
		return fetchPanoData({ pano: best.panoId });
	} catch {
		return null;
	}
}

const CAMERA_PRIORITY = ["gen4", "gen2", "tripod", "badcam", "gen1"];

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

	const [iRes, aRes, oRes, sRes] = await Promise.all([
		fetchPanoData({ location: click, radius }),
		fetchPanoData({
			location: click,
			radius,
			sources: [google.maps.StreetViewSource.GOOGLE],
			preference: google.maps.StreetViewPreference.NEAREST,
		}),
		photometaSnap(click, radius),
		userUploaded === "allow"
			? fetchPanoData({
					location: click,
					radius,
					sources: ["unofficial" as unknown as google.maps.StreetViewSource],
					preference: google.maps.StreetViewPreference.NEAREST,
				})
			: null,
	]);

	const candidates: google.maps.StreetViewResolvedPanoramaData[] = [];
	const push = (e: google.maps.StreetViewResolvedPanoramaData | null) => {
		if (!e?.location?.pano) return;
		if (!candidates.some((c) => samePano(c, e))) candidates.push(e);
	};

	if (iRes && sRes) {
		const di = distMeters(click, panoLatLng(iRes));
		const ds = distMeters(click, panoLatLng(sRes));
		push(di > ds ? sRes : iRes);
	} else {
		push(iRes);
	}
	push(aRes);
	push(oRes);
	push(sRes);

	const official = candidates.find((c) => !isUnofficial(c));
	if (official?.time?.length) {
		const fetches = await Promise.allSettled(
			official.time.map((t) => fetchPanoData({ pano: t.pano })),
		);
		for (const r of fetches) {
			if (r.status === "fulfilled") push(r.value);
		}
	}

	let filtered = candidates;
	if (userUploaded === "ignore") filtered = filtered.filter((c) => !isUnofficial(c));

	if (opts.preferHigherQuality) {
		filtered = filtered.filter((c) => {
			const ct = cameraTypeFromHeight(c.tiles.worldSize.height);
			return ct == null || CAMERA_PRIORITY.includes(ct);
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
			const xc = cameraTypeFromHeight(x.tiles.worldSize.height);
			const yc = cameraTypeFromHeight(y.tiles.worldSize.height);
			if (xc != null && yc == null) return -1;
			if (xc == null && yc != null) return 1;
			if (xc != null && yc != null) {
				const xi = CAMERA_PRIORITY.indexOf(xc);
				const yi = CAMERA_PRIORITY.indexOf(yc);
				if (xi < yi) return -1;
				if (xi > yi) return 1;
			}
		}
		if (userUploaded === "allow") return 0;
		const xd = x.imageDate ?? "9999-99";
		const yd = y.imageDate ?? "9999-99";
		return -xd.localeCompare(yd);
	});

	const chosen = filtered[0];
	if (!chosen) return null;

	const verify = await fetchPanoData({ location: panoLatLng(chosen), radius: SV_SEARCH_RADIUS });
	const isDefault = verify !== null && samePano(chosen, verify);

	const pos = chosen.location.latLng;
	const heading = calcHeading(chosen, opts);
	return createLocation({
		lat: pos.lat(),
		lng: pos.lng(),
		heading,
		panoId: chosen.location.pano ?? null,
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
		const [data] = await fetchSvMetadata([currentPanoId]);
		const links = data?.links;
		if (!links || links.length === 0) break;

		let best: { pano: string; heading: number } | null = null;
		let bestDelta = Infinity;
		for (const link of links) {
			const pid = link.pano;
			const lh = link.heading ?? 0;
			if (!pid || visited.has(pid)) continue;
			const delta = Math.abs(normalizeHeading(lh - currentHeading));
			if (delta < bestDelta) {
				bestDelta = delta;
				best = { pano: pid, heading: lh };
			}
		}
		if (!best || bestDelta > 90) break;

		visited.add(best.pano);
		const [nextData] = await fetchSvMetadata([best.pano]);
		if (!nextData) break;

		const pos = nextData.location.latLng;
		results.push(
			createLocation({
				lat: pos.lat(),
				lng: pos.lng(),
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

// --- UI helpers ---

export function showToast(container: HTMLElement, message: string, timeout = 1500) {
	const el = document.createElement("div");
	el.textContent = message;
	el.style.cssText =
		"position:absolute;bottom:2rem;left:50%;transform:translateX(-50%);background:#222;color:#fff;padding:.5rem 1rem;border-radius:4px;font-size:.875rem;z-index:100;pointer-events:none;white-space:nowrap";
	container.appendChild(el);
	setTimeout(() => el.remove(), timeout);
}

/** Street View tiles are a fixed 512px pitch in `worldSize` space */
const SV_TILE = 512;

/** Number of tiles and the cropped content size for a pano at a given zoom.
 *  The tile grid rounds up to a power of two; the real image only spans
 *  `worldSize`. Scale the content down to the requested zoom and crop to it.
 *  Zoom is clamped to the pano's max (derived from its real width). Falls back
 *  to the full grid when metadata is unavailable. */
export function panoTileLayout(
	zoom: number,
	worldSize?: google.maps.Size,
): { zoom: number; cols: number; rows: number; width: number; height: number; tile: number } {
	let z = zoom;
	let width: number;
	let height: number;
	if (worldSize?.width && worldSize?.height) {
		const maxZoom = Math.ceil(Math.log2(worldSize.width / SV_TILE));
		z = Math.min(Math.max(zoom, 0), maxZoom);
		const scale = 2 ** (maxZoom - z);
		width = Math.round(worldSize.width / scale);
		height = Math.round(worldSize.height / scale);
	} else {
		width = 2 ** zoom * SV_TILE;
		height = 2 ** (zoom - 1) * SV_TILE;
	}
	return {
		zoom: z,
		cols: Math.ceil(width / SV_TILE),
		rows: Math.ceil(height / SV_TILE),
		width,
		height,
		tile: SV_TILE,
	};
}

async function fetchPanoTile(
	panoId: string,
	x: number,
	y: number,
	z: number,
): Promise<ImageBitmap | null> {
	const url = `https://geo0.ggpht.com/cbk?cb_client=apiv3&panoid=${panoId}&output=tile&zoom=${z}&x=${x}&y=${y}`;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const resp = await fetch(url);
			if (!resp.ok) continue;
			return await createImageBitmap(await resp.blob());
		} catch {
			// retry
		}
	}
	return null;
}

/** Download the full panorama as a single stitched JPEG at max quality. Toasts on success/failure. */
export async function downloadPano(panoId: string, zoom = 5): Promise<void> {
	try {
		const [meta] = await fetchSvMetadata([panoId]);
		const {
			zoom: z,
			cols,
			rows,
			width,
			height,
			tile,
		} = panoTileLayout(zoom, meta?.tiles?.worldSize);

		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d")!;

		let loaded = 0;
		const loads: Promise<void>[] = [];
		for (let y = 0; y < rows; y++) {
			for (let x = 0; x < cols; x++) {
				loads.push(
					(async () => {
						const bmp = await fetchPanoTile(panoId, x, y, z);
						if (!bmp) return;
						ctx.drawImage(bmp, x * tile, y * tile);
						bmp.close();
						loaded++;
					})(),
				);
			}
		}
		await Promise.all(loads);
		if (loaded === 0) throw new Error("no tiles loaded");

		const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.95));
		if (!blob) throw new Error("encode failed");

		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `${panoId}.jpg`;
		a.click();
		URL.revokeObjectURL(a.href);
		toast("Panorama downloaded");
	} catch {
		toast("Panorama download failed");
	}
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
