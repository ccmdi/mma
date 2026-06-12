import { describe, it, expect, beforeAll } from "vitest";
import {
	buildStyledTileUrl,
	createLegacyTileConfig,
	LEGACY_STYLE_MAP_ID,
} from "@/lib/geo/tiles";

beforeAll(() => {
	(globalThis as Record<string, unknown>).devicePixelRatio = 1;
});

describe("Legacy style tiles", () => {
	it("serializes to the exact pb shape the mapsresources endpoint accepts", () => {
		// Verified live against mapsresources-pa (2026-06-11): this pb returns the
		// legacy-styled tile. Any drift here likely breaks the Legacy map style.
		const url = new URL(buildStyledTileUrl(createLegacyTileConfig(), LEGACY_STYLE_MAP_ID, 33, 22, 6));
		expect(url.origin + url.pathname).toBe("https://mapsresources-pa.googleapis.com/v1/tiles");
		expect(url.searchParams.get("map_id")).toBe(LEGACY_STYLE_MAP_ID);
		expect(url.searchParams.get("pb")).toBe(
			"!1m5!1m4!1i6!2i33!3i22!4i256!2m2!1e0!2sm!3m12!2sen!3sUS!5e18!12m4!1e68!2m2!1sset!2sRoadmap!12m3!1e37!2m1!1ssmartmaps!5m1!5f1",
		);
	});

	it("composes extra stylers (labels toggle rides the base tile)", () => {
		const cfg = createLegacyTileConfig([
			{ elementType: "labels", stylers: [{ visibility: "off" }] },
		]);
		const url = new URL(buildStyledTileUrl(cfg, LEGACY_STYLE_MAP_ID, 33, 22, 6));
		expect(url.searchParams.get("pb")).toBe(
			"!1m5!1m4!1i6!2i33!3i22!4i256!2m2!1e0!2sm!3m17!2sen!3sUS!5e18!12m4!1e68!2m2!1sset!2sRoadmap!12m3!1e37!2m1!1ssmartmaps!12m4!1e26!2m2!1sstyles!2ss.e:l|p.v:off!5m1!5f1",
		);
	});

	it("wraps x across the antimeridian", () => {
		const url = new URL(buildStyledTileUrl(createLegacyTileConfig(), LEGACY_STYLE_MAP_ID, -1, 0, 2));
		expect(url.searchParams.get("pb")).toContain("!1i2!2i3!3i0");
	});
});
