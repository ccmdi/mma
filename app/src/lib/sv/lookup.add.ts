import { distMeters } from "@/lib/geo/geo";
import { fetchPanoDotsWithIds } from "@/lib/geo/photometa";
import { google } from "@/lib/sv/opensv";
import { cameraTypeFromHeight, fetchSvMetadata } from "@/lib/sv/svMeta";
import { LocationFlag, hasLoadAsPanoId } from "@/types";
import type { Location } from "@/types";

export const SV_SEARCH_RADIUS = 50;

/** A single historical panorama entry (pano ID + capture date). */
export interface PanoTime {
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

export interface ResolvePanoResult {
	resolved: { id: number; panoId: string }[];
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
	const { concurrency = 500, batchSize = 200, signal, onProgress } = opts;
	const result: ResolvePanoResult = { resolved: [], failed: [] };
	if (!google) return result;
	const { runConcurrent } = await import("@/lib/util/concurrent");
	const { batchUpdateLocations } = await import("@/store/useMapStore");

	for (let i = 0; i < locations.length; i += batchSize) {
		signal?.throwIfAborted();
		const chunk = locations.slice(i, i + batchSize);
		const updates: { id: number; patch: { panoId: string } }[] = [];
		await runConcurrent(
			chunk,
			async (loc) => {
				const pano = await getPanoAtCoords(loc.lat, loc.lng);
				if (pano) {
					updates.push({ id: loc.id, patch: { panoId: pano } });
					result.resolved.push({ id: loc.id, panoId: pano });
				} else {
					result.failed.push(loc.id);
				}
			},
			{ concurrency, signal },
		);
		if (updates.length > 0) batchUpdateLocations(updates);
		onProgress?.(Math.min(i + chunk.length, locations.length), locations.length);
	}

	return result;
}

/** Compute SV search radius in meters based on map zoom and latitude. */
export function svSearchRadius(lat: number, zoom: number): number {
	return Math.max(25, (4 * (156543.03392 * Math.cos((lat * Math.PI) / 180))) / 2 ** zoom);
}

/** Clamp heading to [-180, 180]. */
export function normalizeHeading(h: number): number {
	return h > 180 ? h - 360 : h < -180 ? h + 360 : h;
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
export function panoLatLng(p: google.maps.StreetViewResolvedPanoramaData): {
	lat: number;
	lng: number;
} {
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
	click: { lat: number; lng: number },
	radius: number
): Promise<google.maps.StreetViewResolvedPanoramaData | null> {
	try {
		const wc = (() => {
			const n = Math.min(Math.max(Math.sin((click.lat * Math.PI) / 180), -0.9999), 0.9999);
			return {
				x: 256 * (0.5 + click.lng / 360),
				y: 256 * (0.5 - Math.log((1 + n) / (1 - n)) / (4 * Math.PI)),
			};
		})();
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
	},
): Promise<Location | null> {
	const radius = opts.radius ?? Math.max(50, Math.round(svSearchRadius(lat, zoom)));
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

	const verify = await fetchPanoData({ location: panoLatLng(chosen), radius: 50 });
	const isDefault = verify !== null && samePano(chosen, verify);

	const pos = chosen.location.latLng;
	const heading = calcHeading(chosen, opts);
	return {
		id: 0, // placeholder; Rust assigns the real ID
		lat: pos.lat(),
		lng: pos.lng(),
		heading,
		pitch: 0,
		zoom: 0,
		panoId: chosen.location.pano ?? null,
		flags: !isDefault || opts.defaultPanoId ? LocationFlag.LoadAsPanoId : LocationFlag.None,
		tags: [],
		createdAt: new Date().toISOString(),
		modifiedAt: new Date().toISOString(),
	};
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
		results.push({
			id: 0, // placeholder; Rust assigns the real ID
			lat: pos.lat(),
			lng: pos.lng(),
			heading: best.heading,
			pitch: 0,
			zoom: 0,
			panoId: best.pano,
			flags: LocationFlag.LoadAsPanoId,
			tags: [],
			createdAt: new Date().toISOString(),
			modifiedAt: new Date().toISOString(),
		});

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

export async function downloadPanoTile(panoId: string, zoom = 3): Promise<void> {
	const cols = 2 ** zoom;
	const rows = 2 ** (zoom - 1);
	const tileSize = 512;
	const canvas = document.createElement("canvas");
	canvas.width = cols * tileSize;
	canvas.height = rows * tileSize;
	const ctx = canvas.getContext("2d")!;

	const loads: Promise<void>[] = [];
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < cols; x++) {
			loads.push(
				(async () => {
					const url = `https://streetviewpixels-pa.googleapis.com/v1/tile?cb_client=maps_sv.tactile&panoid=${panoId}&x=${x}&y=${y}&zoom=${zoom}&nbt=1&fover=2`;
					const resp = await fetch(url);
					if (!resp.ok) return;
					const blob = await resp.blob();
					const bmp = await createImageBitmap(blob);
					ctx.drawImage(bmp, x * tileSize, y * tileSize);
					bmp.close();
				})(),
			);
		}
	}
	await Promise.all(loads);

	canvas.toBlob(
		(blob) => {
			if (!blob) return;
			const a = document.createElement("a");
			a.href = URL.createObjectURL(blob);
			a.download = `${panoId}.jpg`;
			a.click();
			URL.revokeObjectURL(a.href);
		},
		"image/jpeg",
		0.95,
	);
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
