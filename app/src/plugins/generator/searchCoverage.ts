// Visual-only "fog of war" of where the map generator has searched for coverage.
// Each generator probe is a getPanorama() call with a radius, i.e. a disc on the
// ground. We stamp those discs (opaque, same color) into one RGBA buffer, so the
// union of overlapping discs reads as a single uniformly-translucent region with no
// overlap darkening. This module is deck-free (so it stays unit-testable); the buffer
// is rendered by coverageOverlay.ts into the plugin's own GoogleMapsOverlay.

type Bounds = [number, number, number, number]; // [west, south, east, north]

const TARGET_DISC_PX = 6; // texels per probe radius at full resolution
const MIN_DISC_PX = 2.5; // floor so coarse (large-region) textures still draw round dots, not plus-signs
const MAX_DIM = 2048; // cap texture size (memory + upload bandwidth)
const COLOR: readonly [number, number, number] = [56, 189, 248];
const FLUSH_MS = 80; // coalesce probe bursts into ~12 redraws/sec

let enabled = false;
let bounds: Bounds | null = null;
let texW = 0;
let texH = 0;
let radiusPx = 0;
let buffer: Uint8ClampedArray | null = null;

let version = 0;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

export interface SearchCoverageImage {
	image: ImageData;
	bounds: Bounds;
}

function notify(): void {
	for (const l of listeners) l();
}

function scheduleFlush(): void {
	if (flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		if (!dirty) return;
		dirty = false;
		version++;
		notify();
	}, FLUSH_MS);
}

/** Paint a filled, anti-aliased disc into an RGBA buffer. Overlapping discs keep the
 *  strongest coverage (max alpha), so the union has no alpha buildup. Clips to bounds. */
export function stampDisc(
	data: Uint8ClampedArray,
	w: number,
	h: number,
	cx: number,
	cy: number,
	r: number,
	color: readonly [number, number, number] = COLOR,
): void {
	// 1px anti-aliased edge so small discs read as round dots, not blocky plus-signs.
	const x0 = Math.max(0, Math.floor(cx - r - 1));
	const x1 = Math.min(w - 1, Math.ceil(cx + r + 1));
	const y0 = Math.max(0, Math.floor(cy - r - 1));
	const y1 = Math.min(h - 1, Math.ceil(cy + r + 1));
	for (let y = y0; y <= y1; y++) {
		const dy = y - cy;
		const rowBase = y * w;
		for (let x = x0; x <= x1; x++) {
			const dx = x - cx;
			const edge = r - Math.sqrt(dx * dx + dy * dy) + 0.5;
			if (edge <= 0) continue;
			const alpha = edge >= 1 ? 255 : (edge * 255) | 0;
			const i = (rowBase + x) * 4;
			// Union by max coverage: overlapping discs never darken, edges merge cleanly.
			if (alpha <= data[i + 3]) continue;
			data[i] = color[0];
			data[i + 1] = color[1];
			data[i + 2] = color[2];
			data[i + 3] = alpha;
		}
	}
}

/** Map a lng/lat to texel coordinates (origin top-left = NW corner). */
export function lngLatToPixel(
	b: Bounds,
	w: number,
	h: number,
	lng: number,
	lat: number,
): [number, number] {
	const [west, south, east, north] = b;
	const px = ((lng - west) / (east - west)) * w;
	const py = ((north - lat) / (north - south)) * h;
	return [px, py];
}

/** Start a fresh session over the given bounds. Sizes the texture so a probe
 *  radius is ~TARGET_DISC_PX texels, capped at MAX_DIM. Allocation is lazy. */
export function beginSession(b: Bounds, radiusMeters: number): void {
	const [west, south, east, north] = b;
	const midLat = (south + north) / 2;
	const mPerDegLng = 111320 * Math.cos((midLat * Math.PI) / 180);
	const widthMeters = (east - west) * mPerDegLng;
	const heightMeters = (north - south) * 111320;

	if (!(widthMeters > 0) || !(heightMeters > 0) || !(radiusMeters > 0)) {
		bounds = null;
		buffer = null;
		version++;
		notify();
		return;
	}

	let mpp = radiusMeters / TARGET_DISC_PX;
	let w = Math.max(1, Math.round(widthMeters / mpp));
	let h = Math.max(1, Math.round(heightMeters / mpp));
	const maxDim = Math.max(w, h);
	if (maxDim > MAX_DIM) {
		const scale = MAX_DIM / maxDim;
		w = Math.max(1, Math.round(w * scale));
		h = Math.max(1, Math.round(h * scale));
		mpp /= scale;
	}

	bounds = b;
	texW = w;
	texH = h;
	radiusPx = Math.max(radiusMeters / mpp, MIN_DISC_PX);
	buffer = null; // allocated on first probe
	version++;
	notify();
}

export function addProbe(lng: number, lat: number): void {
	if (!enabled || !bounds) return;
	if (!buffer) buffer = new Uint8ClampedArray(texW * texH * 4);
	const [px, py] = lngLatToPixel(bounds, texW, texH, lng, lat);
	stampDisc(buffer, texW, texH, px, py, radiusPx);
	dirty = true;
	scheduleFlush();
}

/** Clear the drawing but keep the enabled preference (e.g. generation stopped). */
export function endSession(): void {
	bounds = null;
	buffer = null;
	version++;
	notify();
}

export function setEnabled(value: boolean): void {
	if (enabled === value) return;
	enabled = value;
	if (!value) {
		buffer = null;
		version++;
		notify();
	}
}

export function hasCoverage(): boolean {
	return buffer !== null;
}

export function getCoverageImage(): SearchCoverageImage | null {
	if (!buffer || !bounds) return null;
	if (typeof ImageData === "undefined") return null;
	// Fresh ImageData each call so a BitmapLayer (which diffs `image` by reference) re-uploads.
	const image = new ImageData(texW, texH);
	image.data.set(buffer);
	return { image, bounds };
}

export function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getVersion(): number {
	return version;
}

export const searchCoverage = {
	beginSession,
	addProbe,
	endSession,
	setEnabled,
	hasCoverage,
};
