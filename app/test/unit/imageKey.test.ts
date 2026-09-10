import { describe, it, expect } from "vitest";
import { imageKeyToPanoId } from "@/lib/sv/panoId";

// Reference vectors captured from the Maps JS API, which pads the base64 with ".".
const LONG_ID = "AF1QipMnotARealPhotoIdButRepresentative_0123456789";
const HUGE_ID = "x".repeat(200);
const VECTORS: [number, string, string][] = [
	[10, "abc", "CAoSA2FiYw.."],
	[10, LONG_ID, "CAoSMkFGMVFpcE1ub3RBUmVhbFBob3RvSWRCdXRSZXByZXNlbnRhdGl2ZV8wMTIzNDU2Nzg5"],
	[
		10,
		HUGE_ID,
		"CAoSyAF4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eA..",
	],
];

describe("imageKeyToPanoId", () => {
	it("spells a non-official key the way the Maps JS API does, dot padding included", () => {
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

	it("encodes an id far past the argument limit", () => {
		const id = "y".repeat(300_000);
		// 300_000 utf-8 bytes plus the two tags, the frontend and the 3-byte length varint.
		expect(imageKeyToPanoId([10, id])).toHaveLength(Math.ceil(300_006 / 3) * 4);
	});
});
