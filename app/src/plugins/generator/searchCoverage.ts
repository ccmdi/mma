// Visual-only "fog of war" of where the map generator has searched for coverage.
// Each generator probe is a getPanorama() call with a radius, i.e. a disc on the
// ground. We stamp those discs (opaque, same color) into one RGBA buffer, so the
// union of overlapping discs reads as a single uniformly-translucent region with no
// overlap darkening. This module is deck-free (so it stays unit-testable); the buffer
// is rendered by coverageOverlay.ts into the plugin's own GoogleMapsOverlay.

import { wrapDeg, lngSpan, unionBounds, M_PER_DEG } from "@/lib/geo/geo";
import type { Bounds } from "@/types";

/** deck.gl BitmapLayer bounds, `[left, bottom, right, top]`. Unwrapped, so `right` runs
 *  past 180 for a region crossing the antimeridian rather than doubling back west. */
export type BitmapBounds = [number, number, number, number];

const TARGET_DISC_PX = 6; // texels per probe radius at full resolution
const MIN_DISC_PX = 2.5; // floor so coarse (large-region) textures still draw round dots, not plus-signs
const MAX_DIM = 2048; // cap texture size (memory + upload bandwidth)
const COLOR: readonly [number, number, number] = [56, 189, 248];
const FLUSH_MS = 200; // coalesce probe bursts; each flush costs a full-texture GPU upload

let enabled = false;
let bounds: Bounds | null = null;
let texW = 0;
let texH = 0;
let radiusPx = 0;
let buffer: Uint8ClampedArray | null = null;
// Ping-pong pair reused across flushes: BitmapLayer re-uploads on reference change,
// so we alternate between two fixed ImageData instead of allocating ~16MB per flush.
let images: [ImageData, ImageData] | null = null;
let frontImage = 0;

let version = 0;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

export interface SearchCoverageImage {
	image: ImageData;
	bounds: BitmapBounds;
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

/** A crossing box must be unwrapped here or BitmapLayer renders nothing. */
export function bitmapBounds(b: Bounds): BitmapBounds {
	return [b.west, b.south, b.west + lngSpan(b), b.north];
}

/** Map a lng/lat to texel coordinates (origin top-left = NW corner). Longitude counts
 *  degrees east of `west`; points outside land off-texture and get clipped. */
export function lngLatToPixel(
	b: Bounds,
	w: number,
	h: number,
	lng: number,
	lat: number,
): [number, number] {
	const px = (wrapDeg(lng - b.west, 0) / lngSpan(b)) * w;
	const py = ((b.north - lat) / (b.north - b.south)) * h;
	return [px, py];
}

/** Start a fresh session over the given bounds. Sizes the texture so a probe
 *  radius is ~TARGET_DISC_PX texels, capped at MAX_DIM. Allocation is lazy. */
export function beginSession(b: Bounds, radiusMeters: number): void {
	const { south, north } = b;
	const midLat = (south + north) / 2;
	const mPerDegLng = M_PER_DEG * Math.cos((midLat * Math.PI) / 180);
	const widthMeters = lngSpan(b) * mPerDegLng;
	const heightMeters = (north - south) * M_PER_DEG;

	if (!(widthMeters > 0) || !(heightMeters > 0) || !(radiusMeters > 0)) {
		bounds = null;
		buffer = null;
		images = null;
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
	images = null; // dimensions changed
	version++;
	notify();
}

/** Widen the session to take in `b` as well, carrying over what is already drawn.
 *
 *  Regions can be added while a run is in flight. Without this the texture keeps the bounds
 *  of whatever was selected at the start and every probe outside them is clipped away. */
export function growSession(b: Bounds, radiusMeters: number): void {
	if (!bounds) {
		beginSession(b, radiusMeters);
		return;
	}
	const merged = unionBounds(bounds, b);
	if (
		merged.west === bounds.west &&
		merged.east === bounds.east &&
		merged.south === bounds.south &&
		merged.north === bounds.north
	) {
		return;
	}

	const prev = { bounds, buffer, texW, texH };
	beginSession(merged, radiusMeters);
	if (!prev.buffer || !bounds) return;

	// Resample the old texture through lng/lat rather than pixels: the new session may have
	// landed on a different metres-per-texel after the MAX_DIM clamp.
	const next = new Uint8ClampedArray(texW * texH * 4);
	const latSpan = bounds.north - bounds.south;
	const span = lngSpan(bounds);
	for (let y = 0; y < texH; y++) {
		const lat = bounds.north - ((y + 0.5) / texH) * latSpan;
		for (let x = 0; x < texW; x++) {
			const lng = bounds.west + ((x + 0.5) / texW) * span;
			const [sx, sy] = lngLatToPixel(prev.bounds, prev.texW, prev.texH, lng, lat);
			const ix = Math.floor(sx);
			const iy = Math.floor(sy);
			if (ix < 0 || iy < 0 || ix >= prev.texW || iy >= prev.texH) continue;
			const src = (iy * prev.texW + ix) * 4;
			if (prev.buffer[src + 3] === 0) continue;
			const dst = (y * texW + x) * 4;
			next[dst] = prev.buffer[src];
			next[dst + 1] = prev.buffer[src + 1];
			next[dst + 2] = prev.buffer[src + 2];
			next[dst + 3] = prev.buffer[src + 3];
		}
	}
	buffer = next;
	dirty = true;
	scheduleFlush();
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
	images = null;
	version++;
	notify();
}

export function setEnabled(value: boolean): void {
	if (enabled === value) return;
	enabled = value;
	if (!value) {
		buffer = null;
		images = null;
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
	// Alternate between two reused ImageData: BitmapLayer diffs `image` by reference,
	// so the flip forces a re-upload without a fresh multi-MB allocation per flush.
	if (!images) images = [new ImageData(texW, texH), new ImageData(texW, texH)];
	frontImage = 1 - frontImage;
	const image = images[frontImage];
	image.data.set(buffer);
	return { image, bounds: bitmapBounds(bounds) };
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
	growSession,
	addProbe,
	endSession,
	setEnabled,
	hasCoverage,
};
