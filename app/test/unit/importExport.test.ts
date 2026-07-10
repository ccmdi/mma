import { describe, it, expect } from "vitest";
import {
	parseMapsUrl,
	parseCoordinates,
	parseUrlList,
	parsedLocationsToImportJson,
} from "@/lib/data/importExport";
import { LocationFlag } from "@/types";

describe("parseMapsUrl", () => {
	it("returns null for non-URL strings", async () => {
		expect(await parseMapsUrl("not a url")).toBeNull();
		expect(await parseMapsUrl("")).toBeNull();
		expect(await parseMapsUrl("   ")).toBeNull();
	});

	it("returns null for URLs from unsupported domains", async () => {
		expect(await parseMapsUrl("https://example.com/maps")).toBeNull();
		expect(await parseMapsUrl("https://openstreetmap.org/#map=14/51.5074/-0.1278")).toBeNull();
	});

	it("parses Google Maps pano viewpoint URL", async () => {
		const url =
			"https://www.google.com/maps?map_action=pano&viewpoint=48.8566,2.3522&heading=90&pitch=-5&pano=CAoSK0FGtest&fov=90";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.lat).toBeCloseTo(48.8566, 4);
		expect(result!.lng).toBeCloseTo(2.3522, 4);
		expect(result!.heading).toBe(90);
		expect(result!.pitch).toBe(-5);
		expect(result!.panoId).toBe("CAoSK0FGtest");
		expect(result!.flags).toBe(LocationFlag.LoadAsPanoId);
	});

	it("sets LoadAsPanoId on /maps/@ URLs with a pano (historical date pastes)", async () => {
		const url =
			"https://www.google.com/maps/@58.6190505,49.7204709,3a,75y,265.69h,98.54t/data=!3m8!1e1!3m6!1sbUp3OlCW2UH3MA4lYMRirQ!2e0!5s20130901T000000!7i13312!8i6656";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.panoId).toBe("bUp3OlCW2UH3MA4lYMRirQ");
		expect(result!.flags).toBe(LocationFlag.LoadAsPanoId);
	});

	it("extra[loadMode]=latLng opts out of LoadAsPanoId", async () => {
		const url =
			"https://www.google.com/maps?map_action=pano&viewpoint=48.8566,2.3522&pano=CAoSK0FGtest&extra[loadMode]=latLng";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.panoId).toBe("CAoSK0FGtest");
		expect(result!.flags).toBe(LocationFlag.None);
	});

	it("parses Google Maps pano URL without panoId", async () => {
		const url = "https://www.google.com/maps?map_action=pano&viewpoint=40.7128,-74.006";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.lat).toBeCloseTo(40.7128, 4);
		expect(result!.lng).toBeCloseTo(-74.006, 3);
		expect(result!.panoId).toBeNull();
		expect(result!.flags).toBe(LocationFlag.None);
	});

	it("returns null for pano URL missing viewpoint", async () => {
		const url = "https://www.google.com/maps?map_action=pano&heading=90";
		const result = await parseMapsUrl(url);
		expect(result).toBeNull();
	});

	it("parses Google Maps cbll layer=c URL", async () => {
		const url = "https://www.google.com/maps?layer=c&cbll=51.5074,-0.1278";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.lat).toBeCloseTo(51.5074, 4);
		expect(result!.lng).toBeCloseTo(-0.1278, 4);
		expect(result!.heading).toBe(0);
		expect(result!.panoId).toBeNull();
	});

	it("parses Arts & Culture URL", async () => {
		const url =
			"https://artsandculture.google.com/streetview?sv_pid=PANO123&sv_lat=35.6762&sv_lng=139.6503&sv_h=180&s_p=10&sv_z=2";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.lat).toBeCloseTo(35.6762, 4);
		expect(result!.lng).toBeCloseTo(139.6503, 4);
		expect(result!.heading).toBe(180);
		expect(result!.pitch).toBe(10);
		expect(result!.panoId).toBe("PANO123");
		expect(result!.zoom).toBe(2);
	});

	it("extracts extra[tags] from query params", async () => {
		const url =
			"https://www.google.com/maps?map_action=pano&viewpoint=10,20&extra[tags]=Mountains&extra[tags]=Coastal";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.tags).toEqual(["Mountains", "Coastal"]);
	});

	it("extracts extra[tags] from hash params", async () => {
		const url = "https://www.google.com/maps?map_action=pano&viewpoint=10,20#extra[tags]=FromHash";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.tags).toEqual(["FromHash"]);
	});

	it("returns empty tags when none present", async () => {
		const url = "https://www.google.com/maps?map_action=pano&viewpoint=10,20";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.tags).toEqual([]);
	});

	it("trims whitespace from input", async () => {
		const url = "  https://www.google.com/maps?map_action=pano&viewpoint=10,20  ";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.lat).toBe(10);
	});

	it("defaults heading/pitch/zoom for pano URLs without them", async () => {
		const url = "https://www.google.com/maps?map_action=pano&viewpoint=10,20";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.heading).toBe(0);
		expect(result!.pitch).toBe(0);
	});
});

describe("parseUrlList", () => {
	it("parses multiple Google Maps URLs", async () => {
		const input = [
			"https://www.google.com/maps?map_action=pano&viewpoint=48.8566,2.3522",
			"https://www.google.com/maps?map_action=pano&viewpoint=40.7128,-74.006",
		].join("\n");
		const results = await parseUrlList(input);
		expect(results).toHaveLength(2);
		expect(results[0].lat).toBeCloseTo(48.8566, 4);
		expect(results[1].lat).toBeCloseTo(40.7128, 4);
	});

	it("skips blank lines and unparseable lines", async () => {
		const input = [
			"https://www.google.com/maps?map_action=pano&viewpoint=10,20",
			"",
			"https://example.com/not-a-maps-url",
			"https://www.google.com/maps?map_action=pano&viewpoint=30,40",
		].join("\n");
		const results = await parseUrlList(input);
		expect(results).toHaveLength(2);
		expect(results[0].lat).toBe(10);
		expect(results[1].lat).toBe(30);
	});

	it("returns empty array for non-URL text", async () => {
		expect(await parseUrlList("just some text\nwith newlines")).toEqual([]);
		expect(await parseUrlList("")).toEqual([]);
	});

	it("returns empty array for JSON input", async () => {
		expect(await parseUrlList('{"type": "FeatureCollection"}')).toEqual([]);
	});

	it("preserves input order beyond the concurrency window", async () => {
		const lats = Array.from({ length: 12 }, (_, i) => i + 1);
		const input = lats
			.map((la) => `https://www.google.com/maps?map_action=pano&viewpoint=${la},20`)
			.join("\n");
		const results = await parseUrlList(input);
		expect(results.map((r) => r.lat)).toEqual(lats);
	});
});

describe("parsedLocationsToImportJson", () => {
	const base = { lat: 1, lng: 2, heading: 3, pitch: 4, zoom: 5, tags: [] as string[] };

	it("produces a named import file in the standard shape", () => {
		const json = JSON.parse(
			parsedLocationsToImportJson(
				[{ ...base, panoId: null, flags: LocationFlag.None }],
				"Pasted URLs",
			),
		);
		expect(json.name).toBe("Pasted URLs");
		expect(json.customCoordinates).toEqual([{ lat: 1, lng: 2, heading: 3, pitch: 4, zoom: 5 }]);
	});

	it("emits top-level panoId only for LoadAsPanoId locations", () => {
		const json = JSON.parse(
			parsedLocationsToImportJson(
				[
					{ ...base, panoId: "abc", flags: LocationFlag.LoadAsPanoId },
					{ ...base, panoId: "def", flags: LocationFlag.None },
				],
				"x",
			),
		);
		expect(json.customCoordinates[0].panoId).toBe("abc");
		expect(json.customCoordinates[0].extra).toBeUndefined();
		expect(json.customCoordinates[1].panoId).toBeUndefined();
		expect(json.customCoordinates[1].extra).toEqual({ panoId: "def" });
	});

	it("carries tags through extra.tags", () => {
		const json = JSON.parse(
			parsedLocationsToImportJson([
				{ ...base, tags: ["red", "blue"], panoId: null, flags: LocationFlag.None },
			]),
		);
		expect(json.customCoordinates[0].extra).toEqual({ tags: ["red", "blue"] });
	});
});

describe("parseCoordinates", () => {
	const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;

	it("parses decimal pairs with various separators", () => {
		for (const s of ["41.17, 14.04", "41.17,14.04", "41.17 14.04", "  41.17 , 14.04  "]) {
			const r = parseCoordinates(s);
			expect(r, s).not.toBeNull();
			expect(near(r!.lat, 41.17) && near(r!.lng, 14.04), s).toBe(true);
		}
	});

	it("parses signed decimals", () => {
		const r = parseCoordinates("-33.8688, 151.2093");
		expect(near(r!.lat, -33.8688) && near(r!.lng, 151.2093)).toBe(true);
	});

	it("parses DMS with hemispheres", () => {
		const r = parseCoordinates(`40°26'46"N 79°58'56"W`);
		expect(near(r!.lat, 40.44611)).toBe(true);
		expect(near(r!.lng, -79.98222)).toBe(true);
	});

	it("parses degrees-decimal-minutes (DDM)", () => {
		const r = parseCoordinates(`40°26.767'N, 79°58.933'W`);
		expect(near(r!.lat, 40.44612)).toBe(true);
		expect(near(r!.lng, -79.98222)).toBe(true);
	});

	it("parses hemisphere-suffixed decimals and respects S/W", () => {
		const r = parseCoordinates("33.8688 S, 151.2093 W");
		expect(near(r!.lat, -33.8688) && near(r!.lng, -151.2093)).toBe(true);
	});

	it("flips order when hemispheres indicate lng-first", () => {
		const r = parseCoordinates("14.04 E, 41.17 N");
		expect(near(r!.lat, 41.17) && near(r!.lng, 14.04)).toBe(true);
	});

	it("returns null for out-of-range or non-coordinate text", () => {
		expect(parseCoordinates("91, 0")).toBeNull();
		expect(parseCoordinates("0, 181")).toBeNull();
		expect(parseCoordinates("hello world")).toBeNull();
		expect(parseCoordinates("12345")).toBeNull();
		expect(parseCoordinates("")).toBeNull();
	});
});
