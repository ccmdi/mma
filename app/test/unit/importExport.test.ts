import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
	parseMapsUrl,
	parseCoordinates,
	parseUrlList,
	parsedLocationsToImportJson,
	type ParsedLocation,
} from "@/lib/data/importExport";
import { normalizeStoragePanoId } from "@/lib/sv/providers/panoIdStorage";
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

	it("parses lookmap open URLs with POV (closest may fail offline)", async () => {
		const url =
			"https://lookmap.skzk.dev/#c=5/41.367904/-8.392022&p=41.367904/-8.392022&a=121.11/-16.95";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.provider).toBe("apple");
		expect(result!.lat).toBeCloseTo(41.367904, 4);
		expect(result!.lng).toBeCloseTo(-8.392022, 4);
		expect(result!.heading).toBeCloseTo(121.11, 2);
		expect(result!.pitch).toBeCloseTo(-16.95, 2);
	});

	it("parses lookmap short share hashes", async () => {
		const { encodeShareLinkPayload, googlePovToLookmapRadians } = await import(
			"@/lib/sv/lookaround/shareLink"
		);
		const { yaw, pitch } = googlePovToLookmapRadians(90, -5);
		const payload = encodeShareLinkPayload(48.85, 2.35, yaw, pitch);
		const result = await parseMapsUrl(`https://lookmap.skzk.dev/#s=${payload}`);
		expect(result).not.toBeNull();
		expect(result!.provider).toBe("apple");
		expect(result!.lat).toBeCloseTo(48.85, 2);
		expect(result!.lng).toBeCloseTo(2.35, 2);
		expect(result!.heading).toBeCloseTo(90, 0);
		expect(result!.pitch).toBeCloseTo(-5, 0);
	});

	it("parses Baidu long Street View URLs from hash panoid + path meters", async () => {
		const url =
			"https://map.baidu.com/search/%E5%8F%B0%E5%B7%9E%E5%B8%82/@13517338.48,3312052.08,13z,87t,1.38h#panoid=09025100011602251440355768N&panotype=street&heading=173.43&pitch=-6.66&l=13&tn=B_NORMAL_MAP&sc=0&newmap=1&shareurl=1&pid=09025100011602251440355768N";
		const result = await parseMapsUrl(url);
		expect(result).not.toBeNull();
		expect(result!.provider).toBe("baidu");
		expect(result!.panoId).toBe("09025100011602251440355768N");
		expect(result!.heading).toBeCloseTo(173.43, 2);
		expect(result!.pitch).toBeCloseTo(-6.66, 2);
		expect(result!.flags).toBe(LocationFlag.LoadAsPanoId);
		// Path meters give a mainland China pin even if sdata is offline.
		expect(result!.lat).toBeGreaterThan(20);
		expect(result!.lng).toBeGreaterThan(100);
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
	const base = {
		lat: 1,
		lng: 2,
		heading: 3,
		pitch: 4,
		zoom: 5,
		tags: [] as string[],
		provider: "google" as const,
	};

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

	it("emits source (not provider) for alt-provider locations", () => {
		const json = JSON.parse(
			parsedLocationsToImportJson(
				[
					{
						...base,
						provider: "baidu",
						panoId: "0900020012230410091747271AU",
						flags: LocationFlag.LoadAsPanoId,
					},
					{
						...base,
						provider: "apple",
						panoId: "7966846247780953899",
						flags: LocationFlag.LoadAsPanoId,
					},
				],
				"alts",
			),
		);
		expect(json.customCoordinates[0].source).toBe("baidu_pano");
		expect(json.customCoordinates[0].provider).toBeUndefined();
		expect(json.customCoordinates[1].source).toBe("apple_pano");
		expect(json.customCoordinates[1].provider).toBeUndefined();
	});

	it("strips alt-provider prefixes from exported panoId", () => {
		const json = JSON.parse(
			parsedLocationsToImportJson(
				[
					{
						...base,
						provider: "tencent",
						panoId: "TENCENT:sv123",
						flags: LocationFlag.LoadAsPanoId,
					},
				],
				"x",
			),
		);
		expect(json.customCoordinates[0].panoId).toBe("sv123");
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

describe("parseCoordinates (property-based)", () => {
	it("never throws and always returns null or an in-range location", () => {
		fc.assert(
			fc.property(fc.oneof(fc.string(), fc.string({ unit: "grapheme" })), (s) => {
				let r: ParsedLocation | null = null;
				expect(() => {
					r = parseCoordinates(s);
				}).not.toThrow();
				if (r !== null) {
					expect(Math.abs((r as ParsedLocation).lat)).toBeLessThanOrEqual(90);
					expect(Math.abs((r as ParsedLocation).lng)).toBeLessThanOrEqual(180);
				}
			}),
		);
	});

	it("roundtrips decimal pairs within 1e-6 across supported separators", () => {
		fc.assert(
			fc.property(
				fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true }),
				fc.double({ min: -180, max: 180, noNaN: true, noDefaultInfinity: true }),
				fc.constantFrom(", ", ",", " "),
				(lat, lng, sep) => {
					const latStr = lat.toFixed(6);
					const lngStr = lng.toFixed(6);
					const r = parseCoordinates(`${latStr}${sep}${lngStr}`);
					expect(r).not.toBeNull();
					expect(Math.abs(r!.lat - lat)).toBeLessThan(1e-6);
					expect(Math.abs(r!.lng - lng)).toBeLessThan(1e-6);
				},
			),
		);
	});

	it("hemisphere-suffixed form matches the equivalent signed decimal form", () => {
		fc.assert(
			fc.property(
				fc.double({ min: 1e-6, max: 90, noNaN: true, noDefaultInfinity: true }),
				fc.double({ min: 1e-6, max: 180, noNaN: true, noDefaultInfinity: true }),
				(latAbs, lngAbs) => {
					const latStr = latAbs.toFixed(6);
					const lngStr = lngAbs.toFixed(6);
					const suffixed = parseCoordinates(`${latStr} S, ${lngStr} W`);
					const signed = parseCoordinates(`-${latStr}, -${lngStr}`);
					expect(suffixed).not.toBeNull();
					expect(signed).not.toBeNull();
					expect(suffixed!.lat).toBe(signed!.lat);
					expect(suffixed!.lng).toBe(signed!.lng);
				},
			),
		);
	});

	// At the origin the two forms disagree in zero's sign bit: the signed-decimal
	// path normalizes -0 to +0 while the hemisphere path keeps -0.
	it("origin: hemisphere form yields -0, signed form yields +0", () => {
		expect(Object.is(parseCoordinates("0.000000 S, 0.000000 W")!.lat, -0)).toBe(true);
		expect(Object.is(parseCoordinates("-0.000000, -0.000000")!.lat, 0)).toBe(true);
	});
});

describe("parsedLocationsToImportJson (property-based)", () => {
	const parsedLocationArb: fc.Arbitrary<ParsedLocation> = fc.record({
		lat: fc.double({ noNaN: true, noDefaultInfinity: true }),
		lng: fc.double({ noNaN: true, noDefaultInfinity: true }),
		heading: fc.double({ noNaN: true, noDefaultInfinity: true }),
		pitch: fc.double({ noNaN: true, noDefaultInfinity: true }),
		zoom: fc.double({ noNaN: true, noDefaultInfinity: true }),
		panoId: fc.option(fc.string(), { nil: null }),
		flags: fc.constantFrom(
			LocationFlag.None,
			LocationFlag.LoadAsPanoId,
			LocationFlag.Informational,
			LocationFlag.LoadAsPanoId | LocationFlag.Informational,
		),
		tags: fc.array(fc.string()),
	});

	it("always produces valid JSON with matching length and correct panoId placement", () => {
		fc.assert(
			fc.property(fc.array(parsedLocationArb), fc.string(), (locs, name) => {
				const raw = parsedLocationsToImportJson(locs, name);
				let json: { customCoordinates: Record<string, unknown>[] };
				expect(() => {
					json = JSON.parse(raw);
				}).not.toThrow();
				json = JSON.parse(raw);
				expect(json.customCoordinates).toHaveLength(locs.length);
				locs.forEach((l, i) => {
					const cc = json.customCoordinates[i] as {
						panoId?: string;
						extra?: { panoId?: string };
					};
					const storagePanoId = normalizeStoragePanoId(l.panoId);
					const loadAsPano =
						storagePanoId != null && (l.flags & LocationFlag.LoadAsPanoId) !== 0;
					if (loadAsPano) {
						expect(cc.panoId).toBe(storagePanoId);
						expect(cc.extra?.panoId).toBeUndefined();
					} else {
						expect(cc.panoId).toBeUndefined();
						if (storagePanoId != null) expect(cc.extra?.panoId).toBe(storagePanoId);
						else expect(cc.extra?.panoId).toBeUndefined();
					}
				});
			}),
		);
	});
});
