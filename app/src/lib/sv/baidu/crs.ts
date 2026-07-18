/**
 * Map ↔ Baidu meters.
 * Google Maps in mainland China exposes GCJ-02 (same as altproviders googleToBaidu).
 */
import { gcj02ToBd09Mc, bd09McToGcj02 } from "@/lib/geo/chinaCrs";

/** Map (GCJ-02 on Google CN) → Baidu meters for qsdata / coverage. */
export function mapToBaiduMeters(lng: number, lat: number): { x: number; y: number } {
	const [x, y] = gcj02ToBd09Mc([lng, lat]);
	return { x, y };
}

/**
 * Baidu sdata X/Y are centimeters of BD-09MC → map lng/lat (GCJ-02 on Google CN).
 */
export function baiduCmToMap(xCm: number, yCm: number): { lng: number; lat: number } {
	const [lng, lat] = bd09McToGcj02([xCm / 100, yCm / 100]);
	return { lng, lat };
}
