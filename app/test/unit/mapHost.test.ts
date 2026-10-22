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

describe("MapHost.each", () => {
	const host = (id: string) => ({ id }) as unknown as MapHost;

	it("binds the host now and every host after it, undoing each binding as its host goes", () => {
		const log: string[] = [];
		const name = (h: MapHost) => (h as unknown as { id: string }).id;
		MapHost.set(host("a"));
		const stop = MapHost.each((h) => {
			log.push(`on ${name(h)}`);
			return () => log.push(`off ${name(h)}`);
		});
		MapHost.set(null);
		MapHost.set(host("b"));
		stop();
		MapHost.set(host("c"));
		MapHost.set(null);
		expect(log).toEqual(["on a", "off a", "on b", "off b"]);
	});
});
