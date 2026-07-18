import { describe, it, expect } from "vitest";
import { isBaiduPanoId, prefixBaidu, stripBaidu, BAIDU_PANO_PREFIX } from "@/lib/sv/baidu/prefix";

describe("baidu prefix", () => {
	it("prefixes and strips idempotently", () => {
		expect(prefixBaidu("abc")).toBe(`${BAIDU_PANO_PREFIX}abc`);
		expect(prefixBaidu(`${BAIDU_PANO_PREFIX}abc`)).toBe(`${BAIDU_PANO_PREFIX}abc`);
		expect(stripBaidu(`${BAIDU_PANO_PREFIX}abc`)).toBe("abc");
		expect(stripBaidu("abc")).toBe("abc");
	});

	it("detects BAIDU: ids", () => {
		expect(isBaiduPanoId("BAIDU:x")).toBe(true);
		expect(isBaiduPanoId("x")).toBe(false);
		expect(isBaiduPanoId(null)).toBe(false);
	});
});
