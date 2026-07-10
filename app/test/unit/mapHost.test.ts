import { describe, it, expect } from "vitest";
import { latLngToWorld, worldToLatLng, boundsOfCoords, hostKindForMapType } from "@/lib/map/host";

describe("mercator world projection (Google 256px world)", () => {
	it("maps the origin to the world center", () => {
		expect(latLngToWorld({ lat: 0, lng: 0 })).toEqual({ x: 128, y: 128 });
	});

	it("maps the antimeridian to the world edges", () => {
		expect(latLngToWorld({ lat: 0, lng: -180 }).x).toBe(0);
		expect(latLngToWorld({ lat: 0, lng: 180 }).x).toBe(256);
	});

	it("round-trips arbitrary points", () => {
		for (const p of [
			{ lat: 48.8566, lng: 2.3522 },
			{ lat: -33.8688, lng: 151.2093 },
			{ lat: 64.1466, lng: -21.9426 },
			{ lat: -54.8019, lng: -68.303 },
		]) {
			const w = latLngToWorld(p);
			const back = worldToLatLng(w.x, w.y);
			expect(back.lat).toBeCloseTo(p.lat, 6);
			expect(back.lng).toBeCloseTo(p.lng, 6);
		}
	});
});

describe("boundsOfCoords", () => {
	it("returns the axis-aligned bounds", () => {
		expect(
			boundsOfCoords([
				{ lat: 1, lng: 2 },
				{ lat: -3, lng: 10 },
				{ lat: 5, lng: -4 },
			]),
		).toEqual({ west: -4, south: -3, east: 10, north: 5 });
	});

	it("returns null for no coords", () => {
		expect(boundsOfCoords([])).toBeNull();
	});
});

describe("hostKindForMapType", () => {
	it("routes vector to maplibre, everything else to google", () => {
		expect(hostKindForMapType("vector")).toBe("maplibre");
		expect(hostKindForMapType("map")).toBe("google");
		expect(hostKindForMapType("satellite")).toBe("google");
		expect(hostKindForMapType("osm")).toBe("google");
	});
});
