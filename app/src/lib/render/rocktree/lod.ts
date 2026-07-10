// Visibility + LOD math for covering-set traversal. Pure functions in the
// ECEF sphere frame. Models deck's mercator MapView as a perspective camera
// with the same eye/target/fov; `slack` widens the frustum to absorb the
// mercator-vs-perspective mismatch (grows with pitch and latitude).

import { ecefToLatLng, latLngToEcef, PLANET_RADIUS, type Obb, type Vec3 } from "./decode";

// deck MapView defaults: 512px world at zoom 0, camera 1.5 screen heights
// from the target, fovy = 2*atan(0.5/1.5).
const WORLD_CIRCUMFERENCE = 40075016.686;
const TAN_HALF_FOVY = 1 / 3;
const CAMERA_ALTITUDE = 1.5;

export interface ViewParams {
	lat: number;
	lng: number;
	/** deck zoom (512px world), i.e. google zoom - 1 */
	zoom: number;
	pitch: number;
	bearing: number;
	width: number;
	height: number;
}

interface Plane {
	n: Vec3;
	/** inside: dot(n, p) + d >= 0 */
	d: number;
}

export interface FrustumView {
	eye: Vec3;
	planes: Plane[];
	/** meters per screen pixel at distance d from the eye = d * pixelFactor */
	pixelFactor: number;
	/**
	 * Flat-map mode (zoomed out): the mercator viewport shows regions a
	 * perspective camera cannot (past the horizon), so visibility is the
	 * viewport's lng/lat rect and LOD is a fixed meters-per-texel cutoff.
	 */
	flat?: {
		maxMetersPerTexel: number;
		west: number;
		south: number;
		east: number;
		north: number;
	};
}

const MERCATOR_WORLD_METERS = 40075016.686;

/**
 * View for a zoomed-out flat-map camera. `bounds` = viewport [w, s, e, n]
 * degrees (west/east may be unwrapped); the eye sits at the surface under the
 * camera so load priority still favors the center.
 */
export function makeFlatView(p: {
	lat: number;
	lng: number;
	/** deck zoom (512px world) */
	zoom: number;
	bounds: [number, number, number, number];
	/** max meters-per-texel as a multiple of meters-per-pixel at this zoom */
	texelBudget?: number;
}): FrustumView {
	const mpp = MERCATOR_WORLD_METERS / (512 * 2 ** p.zoom);
	return {
		eye: latLngToEcef(p.lat, p.lng),
		planes: [],
		pixelFactor: 0,
		flat: {
			maxMetersPerTexel: mpp * (p.texelBudget ?? 1),
			west: p.bounds[0],
			south: p.bounds[1],
			east: p.bounds[2],
			north: p.bounds[3],
		},
	};
}

/** Conservative OBB vs lng/lat rect test (lng-wrap safe, pole-inflated). */
function flatVisible(obb: Obb, f: NonNullable<FrustumView["flat"]>): boolean {
	const c = ecefToLatLng(obb.center[0], obb.center[1], obb.center[2]);
	const r = Math.hypot(obb.extents[0], obb.extents[1], obb.extents[2]);
	const angular = (r / PLANET_RADIUS) * (180 / Math.PI);
	if (c.lat + angular < f.south || c.lat - angular > f.north) return false;
	if (f.east - f.west >= 360) return true;
	const worstLat = Math.min(85, Math.abs(c.lat) + angular);
	const lngRadius = Math.min(180, angular / Math.max(0.05, Math.cos((worstLat * Math.PI) / 180)));
	const mid = (f.west + f.east) / 2;
	const halfSpan = (f.east - f.west) / 2;
	const delta = ((((c.lng - mid) % 360) + 540) % 360) - 180;
	return Math.abs(delta) <= halfSpan + lngRadius;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(a[0], a[1], a[2]));

export function makeView(p: ViewParams, slack = 1.25): FrustumView {
	const latRad = (p.lat * Math.PI) / 180;
	const mpp = (WORLD_CIRCUMFERENCE * Math.cos(latRad)) / (512 * 2 ** p.zoom);
	const camDist = CAMERA_ALTITUDE * p.height * mpp;

	const target = latLngToEcef(p.lat, p.lng);
	const up = normalize(target);
	const east: Vec3 = normalize([-target[1], target[0], 0]);
	const north = cross(up, east);

	const b = (p.bearing * Math.PI) / 180;
	const t = (p.pitch * Math.PI) / 180;
	const heading = add(scale(north, Math.cos(b)), scale(east, Math.sin(b)));
	const forward = add(scale(up, -Math.cos(t)), scale(heading, Math.sin(t)));
	const eye = sub(target, scale(forward, camDist));
	const camUp = add(scale(heading, Math.cos(t)), scale(up, Math.sin(t)));
	const right = cross(forward, camUp);

	const tanY = TAN_HALF_FOVY * slack;
	const tanX = TAN_HALF_FOVY * (p.width / p.height) * slack;
	const throughEye = (n: Vec3): Plane => ({ n, d: -dot(n, eye) });
	const planes: Plane[] = [
		throughEye(forward),
		throughEye(normalize(add(scale(forward, tanX), right))),
		throughEye(normalize(sub(scale(forward, tanX), right))),
		throughEye(normalize(add(scale(forward, tanY), camUp))),
		throughEye(normalize(sub(scale(forward, tanY), camUp))),
	];
	// Far plane at the horizon: surface beyond it is occluded by the globe.
	const h2 = dot(eye, eye) - PLANET_RADIUS * PLANET_RADIUS;
	const farDist = Math.max(h2 > 0 ? Math.sqrt(h2) * 1.1 : 0, camDist * 10);
	planes.push({ n: scale(forward, -1), d: dot(forward, eye) + farDist });

	return { eye, planes, pixelFactor: (2 * TAN_HALF_FOVY) / p.height };
}

/** Box axes are the COLUMNS of obb.orientation (verified on live geometry). */
const localAxis = (o: Obb, i: number): Vec3 => [
	o.orientation[i * 3],
	o.orientation[i * 3 + 1],
	o.orientation[i * 3 + 2],
];

export function obbVisible(obb: Obb, view: FrustumView): boolean {
	if (view.flat) return flatVisible(obb, view.flat);
	for (const { n, d } of view.planes) {
		const s = dot(n, obb.center) + d;
		let r = 0;
		for (let i = 0; i < 3; i++) r += obb.extents[i] * Math.abs(dot(n, localAxis(obb, i)));
		if (s < -r) return false;
	}
	return true;
}

/** Distance from a point to the closest point of the OBB (0 if inside). */
export function obbDistance(obb: Obb, p: Vec3): number {
	const d = sub(p, obb.center);
	let sum = 0;
	for (let i = 0; i < 3; i++) {
		const excess = Math.max(0, Math.abs(dot(d, localAxis(obb, i))) - obb.extents[i]);
		sum += excess * excess;
	}
	return Math.sqrt(sum);
}

/**
 * True when the node's texture already resolves the screen: at the node's
 * distance one texel covers at most `texelBudget` pixels. Descend while false.
 */
export function lodSufficient(
	obb: Obb,
	metersPerTexel: number,
	view: FrustumView,
	texelBudget = 1,
): boolean {
	// flat mode bakes its own budget into the cutoff (mercator scale, not distance)
	if (view.flat) return metersPerTexel <= view.flat.maxMetersPerTexel;
	return metersPerTexel <= obbDistance(obb, view.eye) * view.pixelFactor * texelBudget;
}
