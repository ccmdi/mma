import type { Bounds, LatLng } from "@/types";
import type { PolygonGeometry } from "@/bindings.gen";

/** Shift `deg` by whole turns into `[min, min + 360)`. The one circular primitive: every
 *  heading and longitude wrap below is a window on it. */
export function wrapDeg(deg: number, min: number): number {
	return min + ((((deg - min) % 360) + 360) % 360);
}

/** Shortest signed longitude delta from `from` to `to`, in [-180, 180). */
function lngDelta(from: number, to: number): number {
	return wrapDeg(to - from, -180);
}

/** A heading in [-180, 180). */
export function normalizeHeading(h: number): number {
	return wrapDeg(h, -180);
}

/** The opposite bearing, in [-180, 180). */
export function reverseHeading(h: number): number {
	return wrapDeg(h + 180, -180);
}

/** Continue a path at `lng` in the frame of `prevLng`. */
export function unwrapLng(lng: number, prevLng: number): number {
	return prevLng + lngDelta(prevLng, lng);
}

/** Rewrite longitudes so each vertex sits within 180 degrees of its predecessor; the
 *  span may run outside [-180, 180]. Edges of 180 degrees or more fold the short way
 *  round - run `densifyRing` first. Mirrors `unwrap_ring` in selections.rs. */
export function unwrapRing<T extends number[]>(ring: T[]): T[] {
	if (ring.every((p, i) => i === 0 || Math.abs(p[0] - ring[i - 1][0]) <= 180)) return ring;
	let prev = ring[0][0];
	return ring.map((p, i) => {
		if (i === 0) return p;
		prev = unwrapLng(p[0], prev);
		const out = [...p] as unknown as T;
		out[0] = prev;
		return out;
	});
}

/** Split edges spanning 180 degrees or more of longitude, so a ring wider than half the
 *  globe survives a later `unwrapRing` pass instead of folding to its complement. */
export function densifyRing<T extends number[]>(ring: T[]): T[] {
	if (ring.every((p, i) => i === 0 || Math.abs(p[0] - ring[i - 1][0]) < 180)) return ring;
	const out: T[] = [];
	for (let i = 0; i < ring.length; i++) {
		out.push(ring[i]);
		const next = ring[i + 1];
		if (!next) break;
		const segments = Math.floor(Math.abs(next[0] - ring[i][0]) / 180) + 1;
		for (let s = 1; s < segments; s++) {
			const t = s / segments;
			out.push(ring[i].map((v, k) => v + (next[k] - v) * t) as unknown as T);
		}
	}
	return out;
}

/** Bbox over `rings`, each unwrapped then shifted by whole turns to sit nearest the box
 *  so far. Crossing form: `west > east` means the box crosses the antimeridian, so test
 *  with `inBbox`. `null` if no vertices. Mirrors `geometry_bbox` in selections.rs. */
export function ringsBbox(rings: number[][][]): Bounds | null {
	let w = Infinity;
	let s = Infinity;
	let e = -Infinity;
	let n = -Infinity;
	let seen = false;
	for (const raw of rings) {
		const ring = unwrapRing(raw);
		let lo = Infinity;
		let hi = -Infinity;
		for (const p of ring) {
			if (p[0] < lo) lo = p[0];
			if (p[0] > hi) hi = p[0];
		}
		if (lo > hi) continue;
		const shift = seen ? Math.round((w + e - lo - hi) / 720) * 360 : 0;
		for (const [lng, lat] of ring) {
			const x = lng + shift;
			if (x < w) w = x;
			if (x > e) e = x;
			if (lat < s) s = lat;
			if (lat > n) n = lat;
		}
		seen = true;
	}
	if (!seen) return null;
	// The crossing form can't tell a 360-degree span from a 0-degree one: folding both
	// edges of a full-globe box lands them on the same longitude.
	if (e - w >= 360) return { west: -180, south: s, east: 180, north: n };
	return { west: wrapDeg(w, -180), south: s, east: wrapDeg(e, -180), north: n };
}

/** Bbox over every part of a polygon geometry, the primary rings and the extra polygons alike. */
export function polygonBbox(geom: PolygonGeometry): Bounds | null {
	return ringsBbox([geom.coordinates, ...(geom.extraPolygons ?? [])].flat());
}

/** Width of a box in degrees of longitude; positive on a crossing box, where
 *  `east - west` is negative. */
export function lngSpan(b: Bounds): number {
	return b.east < b.west ? b.east + 360 - b.west : b.east - b.west;
}

/** A longitude at fraction `t` along the box, folded back into [-180, 180). */
export function lerpLng(b: Bounds, t: number): number {
	return wrapDeg(b.west + lngSpan(b) * t, -180);
}

/** Smallest box covering both, closing the smaller of the two gaps - plain min/max
 *  would always close the gap at the antimeridian. */
export function unionBounds(a: Bounds, b: Bounds): Bounds {
	const south = Math.min(a.south, b.south);
	const north = Math.max(a.north, b.north);
	// Each candidate anchors on one box and measures how far east the other one reaches.
	const reach = (from: Bounds, other: Bounds) =>
		Math.max(lngSpan(from), wrapDeg(other.west, from.west) - from.west + lngSpan(other));
	const spanA = reach(a, b);
	const spanB = reach(b, a);
	const [west, span] = spanA <= spanB ? [a.west, spanA] : [b.west, spanB];
	if (span >= 360) return { west: -180, south, east: 180, north };
	return { west, south, east: wrapDeg(west + span, -180), north };
}

/** Broad-phase reject against a `Bounds`, honouring the `west > east` crossing form.
 *  Mirrors `in_bbox` in selections.rs. */
export function inBbox(lng: number, lat: number, b: Bounds): boolean {
	if (lat < b.south || lat > b.north) return false;
	const x = lng < b.west ? lng + 360 : lng;
	return x <= (b.east < b.west ? b.east + 360 : b.east);
}

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
	if (ring.length === 0) return false;
	const unwrapped = unwrapRing(ring);
	let min = Infinity;
	for (const p of unwrapped) if (p[0] < min) min = p[0];
	const x = wrapDeg(lng, min);
	let inside = false;
	for (let i = 0, j = unwrapped.length - 1; i < unwrapped.length; j = i++) {
		const [xi, yi] = unwrapped[i];
		const [xj, yj] = unwrapped[j];
		const intersect = yi > lat !== yj > lat && x < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
		if (intersect) inside = !inside;
	}
	return inside;
}

export function pointInPolygon(lng: number, lat: number, coordinates: number[][][]): boolean {
	if (coordinates.length === 0) return false;
	if (!pointInRing(lng, lat, coordinates[0])) return false;
	for (let i = 1; i < coordinates.length; i++) {
		if (pointInRing(lng, lat, coordinates[i])) return false;
	}
	return true;
}

const EARTH_RADIUS_M = 6371000;

/** Meters per degree of latitude (and of longitude at the equator). Mirrors
 *  `M_PER_DEG` in the mma-geo crate. */
export const M_PER_DEG = (EARTH_RADIUS_M * Math.PI) / 180;

/** Great-circle (haversine) distance in meters. */
export function distMeters(a: LatLng, b: LatLng): number {
	const f1 = (a.lat * Math.PI) / 180;
	const f2 = (b.lat * Math.PI) / 180;
	const df = ((b.lat - a.lat) * Math.PI) / 180;
	const dl = ((b.lng - a.lng) * Math.PI) / 180;
	const x = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
