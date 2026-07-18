/**
 * Geo helpers ported from lookaround-map `js/geo/geo.js` (MIT).
 * ENU conversion based on MapillaryJS GeoCoords (MIT).
 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
const WGS84A = 6378137.0;
const WGS84B = 6356752.31424518;
const TAU = 2 * Math.PI;

export function geodeticToEnu(
	lng: number,
	lat: number,
	alt: number,
	refLng: number,
	refLat: number,
	refAlt: number,
): [number, number, number] {
	const ecef = geodeticToEcef(lng, lat, alt);
	return ecefToEnu(ecef[0], ecef[1], ecef[2], refLng, refLat, refAlt);
}

function geodeticToEcef(lng: number, lat: number, alt: number): [number, number, number] {
	lng *= DEG2RAD;
	lat *= DEG2RAD;

	const cosLng = Math.cos(lng);
	const sinLng = Math.sin(lng);
	const cosLat = Math.cos(lat);
	const sinLat = Math.sin(lat);

	const a2 = WGS84A * WGS84A;
	const b2 = WGS84B * WGS84B;
	const L = 1.0 / Math.sqrt(a2 * cosLat * cosLat + b2 * sinLat * sinLat);
	const nhcl = (a2 * L + alt) * cosLat;

	return [nhcl * cosLng, nhcl * sinLng, (b2 * L + alt) * sinLat];
}

function ecefToEnu(
	X: number,
	Y: number,
	Z: number,
	refLng: number,
	refLat: number,
	refAlt: number,
): [number, number, number] {
	const refEcef = geodeticToEcef(refLng, refLat, refAlt);
	const V = [X - refEcef[0], Y - refEcef[1], Z - refEcef[2]];

	refLng *= DEG2RAD;
	refLat *= DEG2RAD;

	const cosLng = Math.cos(refLng);
	const sinLng = Math.sin(refLng);
	const cosLat = Math.cos(refLat);
	const sinLat = Math.sin(refLat);

	return [
		-sinLng * V[0] + cosLng * V[1],
		-sinLat * cosLng * V[0] - sinLat * sinLng * V[1] + cosLat * V[2],
		cosLat * cosLng * V[0] + cosLat * sinLng * V[1] + sinLat * V[2],
	];
}

export function enuToPhotoSphere(
	enu: [number, number, number],
	direction: number,
): { distance: number; pitch: number; yaw: number } {
	const distance = Math.sqrt(enu[0] * enu[0] + enu[1] * enu[1]);
	const pitch = Math.atan2(enu[2] * -1, distance) * -1;
	let yaw = Math.atan2(enu[0], enu[1]) - direction;
	yaw = wrap(yaw);
	return { distance, pitch, yaw };
}

export function distanceBetween(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
	R = 6371.0,
): number {
	lon1 *= DEG2RAD;
	lon2 *= DEG2RAD;
	lat1 *= DEG2RAD;
	lat2 *= DEG2RAD;
	const x = (lon1 - lon2) * Math.cos((lat1 + lat2) / 2.0);
	const y = lat1 - lat2;
	return Math.sqrt(x * x + y * y) * R;
}

export function wrap(angle: number): number {
	angle %= TAU;
	if (angle < 0) angle += TAU;
	return angle;
}
