import { describe, expect, it } from "vitest";
import {
	normalizeLocationStorageFields,
	normalizeStoragePanoId,
	parsePrefixedStoragePanoId,
	viewerPanoId,
} from "@/lib/sv/providers/panoIdStorage";
import { createLocation } from "@/types";

describe("panoIdStorage", () => {
	it("strips known prefixes for storage", () => {
		expect(normalizeStoragePanoId("BAIDU:abc")).toBe("abc");
		expect(normalizeStoragePanoId("TENCENT:sv1")).toBe("sv1");
		expect(normalizeStoragePanoId("APPLE:7966")).toBe("7966");
		expect(normalizeStoragePanoId("YANDEX:xyz")).toBe("xyz");
		expect(normalizeStoragePanoId("CAoSLEF")).toBe("CAoSLEF");
	});

	it("infers provider from prefix when unset", () => {
		expect(parsePrefixedStoragePanoId("TENCENT:sv1")).toEqual({
			panoId: "sv1",
			inferredProvider: "tencent",
		});
		expect(
			normalizeLocationStorageFields({ panoId: "BAIDU:raw", provider: "google" }),
		).toEqual({ panoId: "raw", provider: "baidu" });
	});

	it("preserves explicit non-google provider", () => {
		expect(
			normalizeLocationStorageFields({
				panoId: "TENCENT:sv1",
				provider: "tencent",
			}),
		).toEqual({ panoId: "sv1", provider: "tencent" });
	});

	it("builds viewer ids from storage ids", () => {
		expect(viewerPanoId("baidu", "abc")).toBe("BAIDU:abc");
		expect(viewerPanoId("tencent", "sv1")).toBe("TENCENT:sv1");
		expect(viewerPanoId("google", "CAoSLEF")).toBe("CAoSLEF");
	});

	it("createLocation stores unprefixed pano ids", () => {
		const loc = createLocation({
			lat: 1,
			lng: 2,
			panoId: "TENCENT:sv1",
			provider: "google",
		});
		expect(loc.panoId).toBe("sv1");
		expect(loc.provider).toBe("tencent");
	});
});
