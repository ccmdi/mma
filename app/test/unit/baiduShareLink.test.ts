import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	buildBaiduShareUrl,
	clearBaiduShortLinkCache,
	shortenBaiduShareUrl,
} from "@/lib/sv/baidu/shareLink";

describe("baidu shareLink", () => {
	it("builds a Baidu Maps street share URL", () => {
		const url = new URL(buildBaiduShareUrl("09002200011603151006068579T", 90, -10));
		expect(url.hostname).toBe("map.baidu.com");
		expect(url.searchParams.get("panoid")).toBe("09002200011603151006068579T");
		expect(url.searchParams.get("pid")).toBe("09002200011603151006068579T");
		expect(url.searchParams.get("heading")).toBe("90");
		expect(url.searchParams.get("pitch")).toBe("-10");
		expect(url.searchParams.get("panotype")).toBe("street");
	});

	describe("shortenBaiduShareUrl", () => {
		const long = buildBaiduShareUrl("09002200011603151006068579T", 90, -10);
		const short = "https://j.map.baidu.com/abc123";

		beforeEach(() => {
			clearBaiduShortLinkCache();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					new Response(JSON.stringify({ url: short }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
				),
			);
		});

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("returns short url from j.map.baidu.com proxy response", async () => {
			const result = await shortenBaiduShareUrl(long);
			expect(result).toBe(short);
			expect(fetch).toHaveBeenCalled();
			const called = String(vi.mocked(fetch).mock.calls[0]![0]);
			expect(called).toContain("url=");
			expect(called).toContain("web=true");
		});

		it("caches by panoid", async () => {
			await shortenBaiduShareUrl(long);
			await shortenBaiduShareUrl(long);
			expect(fetch).toHaveBeenCalledTimes(1);
		});
	});
});
