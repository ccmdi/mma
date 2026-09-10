import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import type { ParsedLocation } from "@/bindings.gen";
import { LocationFlag } from "@/bindings.consts";

// The URL grammar itself lives in Rust (`io/maps_url.rs`, tested there); the list
// parser only needs a host that answers viewpoint URLs and rejects everything else.
vi.mock("@/lib/commands", () => ({
	cmd: {
		parseMapsUrl: async (input: string): Promise<ParsedLocation | null> => {
			const vp = /^https:\/\/www\.google\.com\/maps\?map_action=pano&viewpoint=([-\d.]+),([-\d.]+)$/.exec(
				input,
			);
			if (!vp) return null;
			return {
				lat: parseFloat(vp[1]),
				lng: parseFloat(vp[2]),
				heading: 0,
				pitch: 0,
				zoom: 0,
				panoId: null,
				flags: LocationFlag.None,
				tags: [],
			};
		},
	},
}));

import { parseCoordinates, parseUrlList, parsedLocationsToImportJson } from "@/lib/data/importExport";

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
			parsedLocationsToImportJson(
				[{ ...base, tags: ["red", "blue"], panoId: null, flags: LocationFlag.None }],
				"x",
			),
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
					const loadAsPano = l.panoId != null && (l.flags & LocationFlag.LoadAsPanoId) !== 0;
					if (loadAsPano) {
						expect(cc.panoId).toBe(l.panoId);
						expect(cc.extra?.panoId).toBeUndefined();
					} else {
						expect(cc.panoId).toBeUndefined();
						if (l.panoId != null) expect(cc.extra?.panoId).toBe(l.panoId);
						else expect(cc.extra?.panoId).toBeUndefined();
					}
				});
			}),
		);
	});
});
