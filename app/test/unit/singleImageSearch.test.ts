import { describe, it, expect } from "vitest";
import { PanoType } from "@/types";
import {
	buildLocationSearchBody,
	SearchPreference,
	buildTimestampSearchBody,
	parseSearch,
} from "@/lib/sv/singleImageSearch";

/* The bodies are array-JSON: element position is the protobuf field number, so a shifted
 * or dropped `null` is a silently different request. Pinned literally. */

describe("SingleImageSearch bodies", () => {
	it("builds the capture-time coverage probe", () => {
		expect(buildTimestampSearchBody(47.3769, 8.5417, 50, 1719835200, 1722513600)).toBe(
			'[["apiv3"],[[null,null,47.3769,8.5417],50],[[null,null,null,null,null,null,null,null,null,null,[1719835200,1722513600]],null,null,null,null,null,null,null,[1],null,[[[2,true,2]]]],[[2,6]]]',
		);
	});

	it("builds the nearest-panorama search, every frontend by default", () => {
		expect(buildLocationSearchBody(47.3769, 8.5417, 50)).toBe(
			'[["apiv3"],[[null,null,47.3769,8.5417],50],[null,null,null,null,null,null,null,null,[2],null,[[[2,true,2],[3,true,2],[10,true,2]]]],[[1,2,3,4,8,6]]]',
		);
	});

	it("searches only the collections it is given", () => {
		expect(buildLocationSearchBody(47.3769, 8.5417, 50, { sources: [PanoType.Official] })).toBe(
			'[["apiv3"],[[null,null,47.3769,8.5417],50],[null,null,null,null,null,null,null,null,[2],null,[[[2,true,2]]]],[[1,2,3,4,8,6]]]',
		);
		expect(
			buildLocationSearchBody(47.3769, 8.5417, 50, {
				sources: [PanoType.Unknown, PanoType.UserUploaded],
			}),
		).toBe(
			'[["apiv3"],[[null,null,47.3769,8.5417],50],[null,null,null,null,null,null,null,null,[2],null,[[[3,true,2],[10,true,2]]]],[[1,2,3,4,8,6]]]',
		);
	});

	it("clamps the radius to half the Earth's circumference", () => {
		expect(buildLocationSearchBody(0, 0, -1)).toContain("[[null,null,0,0],0]");
		expect(buildLocationSearchBody(0, 0, 1e9)).toContain(`[[null,null,0,0],${6378137 * Math.PI}]`);
	});
});

describe("parseSearch", () => {
	/** A location-search response carrying one image: `[status, ImageMetadata]`. */
	const reply = (status: number, key: unknown[] | null) =>
		JSON.stringify([[0], [[status], key, null, null, null, [[[1], [[null, null, 1, 2]]]]]]);

	it("reads the whole pano out of an OK response", () => {
		const p = parseSearch(reply(1, [2, "20C-1_sANr4OMdhTDM2N-g"]))!;
		expect(p.pano).toBe("20C-1_sANr4OMdhTDM2N-g");
		expect(p.lat).toBe(1);
		expect(p.lng).toBe(2);
		expect(parseSearch(reply(3, [3, "abc"]))!.pano).toBe("F:abc");
		// A missing frontend reads as official, matching the Maps JS API's own default.
		expect(parseSearch(reply(1, [null, "20C-1_sANr4OMdhTDM2N-g"]))!.pano).toBe(
			"20C-1_sANr4OMdhTDM2N-g",
		);
	});

	it("answers null for anything but coverage", () => {
		expect(parseSearch("[[5],[[2]]]")).toBeNull(); // no coverage
		expect(parseSearch(reply(2, [2, "x"]))).toBeNull(); // ZERO_RESULTS
		expect(parseSearch(reply(1, null))).toBeNull(); // result with no id
		expect(parseSearch('[[0],[[1],[2,"x"]]]')).toBeNull(); // no image information
		expect(parseSearch("[[0]]")).toBeNull();
		expect(parseSearch("not json")).toBeNull();
		expect(parseSearch('{"a":1}')).toBeNull();
	});
});

describe("search preference", () => {
	// Field 9 of the options. opensv encodes it as `a.preference === "best" ? 1 : 2`
	// (streetview.js), so an omitted preference is nearest, not best -- which is what
	// `getPanorama({location, radius})` sends and what this builder has to match.
	const field9 = (body: string) => (JSON.parse(body)[2] as unknown[])[8];

	it("defaults to nearest, as an omitted preference does on the wire", () => {
		expect(field9(buildLocationSearchBody(0, 0, 50))).toEqual([SearchPreference.Nearest]);
		expect(SearchPreference.Nearest).toBe(2);
	});

	it("sends best when a caller asks for it", () => {
		expect(field9(buildLocationSearchBody(0, 0, 50, { preference: SearchPreference.Best }))).toEqual([
			SearchPreference.Best,
		]);
		expect(SearchPreference.Best).toBe(1);
	});
});
