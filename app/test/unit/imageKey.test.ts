import { describe, it, expect } from "vitest";
import { imageKeyToPanoId, panoIdToImageKey } from "@/lib/sv/panoId";

// Reference vectors computed from the pre-pbf hand-rolled encoder
const LONG_ID = "AF1QipMnotARealPhotoIdButRepresentative_0123456789";
const HUGE_ID = "x".repeat(200);
const VECTORS: [number, string, string][] = [
	[10, "abc", "CAoSA2FiYw"],
	[10, LONG_ID, "CAoSMkFGMVFpcE1ub3RBUmVhbFBob3RvSWRCdXRSZXByZXNlbnRhdGl2ZV8wMTIzNDU2Nzg5"],
	[
		10,
		HUGE_ID,
		"CAoSyAF4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eA",
	],
];

describe("imageKey codec", () => {
	it("encodes non-official keys to the same bytes as the legacy encoder", () => {
		for (const [type, id, expected] of VECTORS) {
			expect(imageKeyToPanoId([type, id])).toBe(expected);
		}
	});

	it("passes official and F: keys through without encoding", () => {
		expect(imageKeyToPanoId([2, "0123456789abcdefghijkl"])).toBe("0123456789abcdefghijkl");
		expect(imageKeyToPanoId([0, "0123456789abcdefghijkl"])).toBe("0123456789abcdefghijkl");
		expect(imageKeyToPanoId([3, "fifeId"])).toBe("F:fifeId");
		expect(imageKeyToPanoId([2, ""])).toBe("");
	});

	it("round-trips encoded pano IDs back to [type, id]", () => {
		for (const [type, id] of VECTORS) {
			const panoId = imageKeyToPanoId([type, id]);
			expect(panoIdToImageKey(panoId)).toEqual([type, id]);
		}
	});

	it("round-trips F: and official IDs", () => {
		expect(panoIdToImageKey("F:fifeId")).toEqual([3, "fifeId"]);
		expect(panoIdToImageKey("0123456789abcdefghijkl")).toEqual([2, "0123456789abcdefghijkl"]);
	});

	it("falls back to [2, panoId] for undecodable input", () => {
		expect(panoIdToImageKey("!!!not-base64!!!")).toEqual([2, "!!!not-base64!!!"]);
	});

	it("encodes an id far past the argument limit", () => {
		const id = "y".repeat(300_000);
		expect(panoIdToImageKey(imageKeyToPanoId([10, id]))).toEqual([10, id]);
	});
});
