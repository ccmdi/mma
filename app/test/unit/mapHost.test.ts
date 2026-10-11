import { describe, it, expect } from "vitest";
import { boundsOfCoords } from "@/lib/geo/geo";
import { MapHost } from "@/lib/map/host";

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

describe("MapHost.kindForMapType", () => {
	it("routes vector to maplibre, everything else to google", () => {
		expect(MapHost.kindForMapType("vector")).toBe("maplibre");
		expect(MapHost.kindForMapType("map")).toBe("google");
		expect(MapHost.kindForMapType("satellite")).toBe("google");
		expect(MapHost.kindForMapType("osm")).toBe("google");
	});
});
