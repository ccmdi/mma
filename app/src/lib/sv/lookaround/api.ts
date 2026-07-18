import { LOOKMAP_ORIGIN } from "./endpoints";
import { fixProjectionIfNecessary } from "./psv/misc";

export interface LookaroundPano {
	panoid: string;
	buildId: string;
	lat: number;
	lon: number;
	/** Capture time, ms since epoch (Apple / lookmap). */
	timestamp?: number;
	coverageType?: number;
	/** Apple heading, radians. */
	heading?: number;
	pitch?: number;
	roll?: number;
	/** Height above MSL (lookmap `elevation` when meta includes `ele`). */
	elevation?: number;
	altitude?: number;
	cameraMetadata?: Array<{
		fovH?: number;
		fovS?: number;
		cy?: number;
		yaw?: number;
		pitch?: number;
		roll?: number;
	}>;
	timezone?: string;
}

export interface CoverageTileResponse {
	panos: LookaroundPano[];
	lastModified?: number;
}

const COVERAGE_ZOOM = 17;
/** Match lookmap.skzk.dev / lookaround-map default closest radius. */
const CLOSEST_RADIUS = 100;

/**
 * Open / resolve — lookmap:
 * `/closest?limit=1&meta=cam,ele,ori,tz`
 */
export const META_OPEN = ["cam", "ele", "ori", "tz"] as const;
/**
 * Movement / alternate-dates — lookmap:
 * `/closest?radius=100&limit=1000&meta=cam,ele,tz`
 */
export const META_NEARBY = ["cam", "ele", "tz"] as const;

export const NEARBY_RADIUS_M = 100;
export const NEARBY_LIMIT = 1000;

export function getCoverageZoom(): number {
	return COVERAGE_ZOOM;
}

export function lngToTileX(lng: number, z: number): number {
	return Math.floor(((lng + 180) / 360) * (1 << z));
}

export function latToTileY(lat: number, z: number): number {
	const r = (lat * Math.PI) / 180;
	return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * (1 << z));
}

export function tileKey(x: number, y: number): string {
	return `${x}/${y}`;
}

/** lookmap may emit Infinity/NaN which is not valid JSON. */
function parseServerJson<T>(text: string): T {
	const sanitized = text
		.replace(/:\s*Infinity\b/g, ":null")
		.replace(/:\s*-Infinity\b/g, ":null")
		.replace(/:\s*NaN\b/g, ":null");
	return JSON.parse(sanitized) as T;
}

/**
 * HTTP client against lookmap.skzk.dev (CORS-enabled).
 * `getLookmapBaseUrl()` is what the local PSV adapter uses for `/pano/...`.
 */
export class LookaroundApi {
	constructor(
		private readonly metaBase: string = LOOKMAP_ORIGIN,
		private readonly tileBase: string = LOOKMAP_ORIGIN,
		private readonly panoBase: string = LOOKMAP_ORIGIN,
	) {}

	/** Base URL for local PSV (`/pano/...`, warm `/closest`). */
	getLookmapBaseUrl(): string {
		return this.panoBase;
	}

	getMetaBaseUrl(): string {
		return this.metaBase;
	}

	async fetchCoverageTile(x: number, y: number): Promise<CoverageTileResponse> {
		const res = await fetch(`${this.tileBase}/tiles/coverage/${x}/${y}/`, {
			signal: AbortSignal.timeout(30_000),
		});
		if (!res.ok) throw new Error(`Coverage tile HTTP ${res.status}`);
		return parseServerJson<CoverageTileResponse>(await res.text());
	}

	async getClosestPanos(
		lat: number,
		lon: number,
		radius = CLOSEST_RADIUS,
		limit = 1,
		meta: readonly string[] = META_OPEN,
	): Promise<LookaroundPano[]> {
		const metaKey = meta.join(",");
		const key = `${lat.toFixed(6)},${lon.toFixed(6)},${radius},${limit},${metaKey}`;
		const hit = closestCache.get(key);
		if (hit) return hit;
		const pending = closestInflight.get(key);
		if (pending) return pending;

		const task = (async () => {
			let url = `${this.metaBase}/closest?lat=${lat}&lon=${lon}&radius=${radius}&limit=${limit}`;
			if (meta.length) url += `&meta=${meta.join(",")}`;
			const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				throw new Error(
					`Closest pano HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`,
				);
			}
			const panos = parseServerJson<LookaroundPano[]>(await res.text()).map(
				fixProjectionIfNecessary,
			);
			closestCache.set(key, panos);
			while (closestCache.size > CLOSEST_CACHE_MAX) {
				const oldest = closestCache.keys().next().value!;
				closestCache.delete(oldest);
			}
			return panos;
		})().finally(() => {
			closestInflight.delete(key);
		});

		closestInflight.set(key, task);
		return task;
	}
}

const CLOSEST_CACHE_MAX = 64;
const closestCache = new Map<string, LookaroundPano[]>();
const closestInflight = new Map<string, Promise<LookaroundPano[]>>();

let sharedApi: LookaroundApi | null = null;

export function getApi(): LookaroundApi {
	if (!sharedApi) sharedApi = new LookaroundApi();
	return sharedApi;
}
