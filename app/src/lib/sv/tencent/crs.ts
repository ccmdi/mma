/** Tencent scene coords → GCJ-02 lat/lng (altproviders tencentToGcj02). */

const A = 114.59155902616465;
const SCALE = 111319.49077777778;

function deg2rad(deg: number): number {
	return (deg * Math.PI) / 180;
}

export function tencentToGcj02(x: number, y: number): { lng: number; lat: number } {
	return {
		lng: x / SCALE,
		lat: A * Math.atan(Math.exp(deg2rad(y / SCALE))) - 90,
	};
}
