import {
	wrapDeg,
	inBbox,
	lerpLng,
	lngSpan,
	M_PER_DEG,
	pointInPolygon,
	ringsBbox,
} from "@/lib/geo/geo";
import type { Bounds, LatLng } from "@/types";

const DEG_TO_RAD = Math.PI / 180;

export { latLngToWorld, worldToTile as worldToTileAtZoom, pixelToLatLng } from "@/lib/geo/mercator";

export function randomPointInBounds(b: Bounds): LatLng {
	const sinS = Math.sin((b.south * Math.PI) / 180);
	const sinN = Math.sin((b.north * Math.PI) / 180);
	const lat = (Math.asin(Math.random() * (sinN - sinS) + sinS) * 180) / Math.PI;
	return { lat, lng: lerpLng(b, Math.random()) };
}

/** `null` for a feature with no coordinates. */
export function getBoundingBox(
	feature: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
): Bounds | null {
	const polys =
		feature.geometry.type === "Polygon"
			? [feature.geometry.coordinates]
			: feature.geometry.coordinates;
	return ringsBbox(polys.flat());
}

interface CompiledPart {
	bb: Bounds;
	rings: number[][][];
}
const compiledCache = new WeakMap<object, CompiledPart[]>();

function compileParts(geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): CompiledPart[] {
	const cached = compiledCache.get(geometry);
	if (cached) return cached;
	const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
	const parts: CompiledPart[] = [];
	for (const rings of polys) {
		// Outer ring only: holes can't widen the part's bounds.
		const bb = ringsBbox(rings.slice(0, 1));
		if (bb) parts.push({ bb, rings });
	}
	compiledCache.set(geometry, parts);
	return parts;
}

export function pointInGeoJsonGeometry(
	lng: number,
	lat: number,
	geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): boolean {
	for (const part of compileParts(geometry)) {
		if (!inBbox(lng, lat, part.bb)) continue;
		if (pointInPolygon(lng, lat, part.rings)) return true;
	}
	return false;
}

export function poissonDiskSample(
	feature: GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>,
	minDistance: number,
	k = 30,
): LatLng[] {
	const bounds = getBoundingBox(feature);
	if (!bounds) return [];
	const { west, south, north } = bounds;
	const midLat = (south + north) / 2;
	const mPerDegLng = M_PER_DEG * Math.cos(midLat * DEG_TO_RAD);

	// Metres run east from the western edge; a crossing box stays a plain interval here.
	const toMx = (lng: number) => wrapDeg(lng - west, 0) * mPerDegLng;
	const toMy = (lat: number) => (lat - south) * M_PER_DEG;
	const toLng = (mx: number) => wrapDeg(mx / mPerDegLng + west, -180);
	const toLat = (my: number) => my / M_PER_DEG + south;

	const widthM = lngSpan(bounds) * mPerDegLng;
	const heightM = toMy(north);
	const cellSize = minDistance / Math.SQRT2;
	const gridCols = Math.ceil(widthM / cellSize);
	const gridRows = Math.ceil(heightM / cellSize);
	const grid = new Int32Array(gridCols * gridRows).fill(-1);

	const pointsMx: number[] = [];
	const pointsMy: number[] = [];
	const active: number[] = [];
	const r2 = minDistance * minDistance;

	let seedMx: number, seedMy: number;
	for (;;) {
		const pt = randomPointInBounds(bounds);
		if (pointInGeoJsonGeometry(pt.lng, pt.lat, feature.geometry)) {
			seedMx = toMx(pt.lng);
			seedMy = toMy(pt.lat);
			break;
		}
	}

	const addPoint = (mx: number, my: number) => {
		const idx = pointsMx.length;
		pointsMx.push(mx);
		pointsMy.push(my);
		active.push(idx);
		const gx = (mx / cellSize) | 0;
		const gy = (my / cellSize) | 0;
		grid[gx + gy * gridCols] = idx;
		return idx;
	};

	addPoint(seedMx!, seedMy!);

	while (active.length > 0) {
		const aIdx = (Math.random() * active.length) | 0;
		const pIdx = active[aIdx];
		const px = pointsMx[pIdx];
		const py = pointsMy[pIdx];
		let accepted = false;

		for (let i = 0; i < k; i++) {
			const angle = Math.random() * 2 * Math.PI;
			const dist = minDistance + Math.random() * minDistance;
			const cx = px + dist * Math.cos(angle);
			const cy = py + dist * Math.sin(angle);

			if (cx < 0 || cx >= widthM || cy < 0 || cy >= heightM) continue;

			const gx = (cx / cellSize) | 0;
			const gy = (cy / cellSize) | 0;

			let tooClose = false;
			const gxMin = Math.max(0, gx - 2);
			const gxMax = Math.min(gridCols - 1, gx + 2);
			const gyMin = Math.max(0, gy - 2);
			const gyMax = Math.min(gridRows - 1, gy + 2);
			for (let ny = gyMin; ny <= gyMax && !tooClose; ny++) {
				for (let nx = gxMin; nx <= gxMax && !tooClose; nx++) {
					const nIdx = grid[nx + ny * gridCols];
					if (nIdx === -1) continue;
					const dx = cx - pointsMx[nIdx];
					const dy = cy - pointsMy[nIdx];
					if (dx * dx + dy * dy < r2) tooClose = true;
				}
			}
			if (tooClose) continue;

			if (!pointInGeoJsonGeometry(toLng(cx), toLat(cy), feature.geometry)) continue;

			addPoint(cx, cy);
			accepted = true;
		}

		if (!accepted) {
			active[aIdx] = active[active.length - 1];
			active.pop();
		}
	}

	const result: LatLng[] = new Array(pointsMx.length);
	for (let i = 0; i < pointsMx.length; i++) {
		result[i] = { lat: toLat(pointsMy[i]), lng: toLng(pointsMx[i]) };
	}
	for (let i = result.length - 1; i > 0; i--) {
		const j = (Math.random() * (i + 1)) | 0;
		const tmp = result[i];
		result[i] = result[j];
		result[j] = tmp;
	}
	return result;
}
