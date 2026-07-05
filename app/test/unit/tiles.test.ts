import { describe, it, expect, beforeAll } from "vitest";
import {
	buildStyledTileUrl,
	createLegacyTileConfig,
	createLabelsTileConfig,
	LEGACY_STYLE_MAP_ID,
} from "@/lib/geo/tiles";

beforeAll(() => {
	(globalThis as Record<string, unknown>).devicePixelRatio = 1;
});

describe("Legacy style tiles", () => {
	it("serializes to the no-labels pb shape the mapsresources endpoint accepts", () => {
		// Uses StyleType.NO_LABELS + map_id so labels can be stacked above SV coverage.
		const url = new URL(
			buildStyledTileUrl(createLegacyTileConfig(), LEGACY_STYLE_MAP_ID, 33, 22, 6),
		);
		expect(url.origin + url.pathname).toBe("https://mapsresources-pa.googleapis.com/v1/tiles");
		expect(url.searchParams.get("map_id")).toBe(LEGACY_STYLE_MAP_ID);
		expect(url.searchParams.get("pb")).toBe(
			"!1m5!1m4!1i6!2i33!3i22!4i256!2m2!1e0!2sm!3m12!2sen!3sUS!5e1105!12m1!1e3!12m1!1e2!12m4!1e26!2m2!1sstyles!2ss.t:1|s.e:g.s|p.v:off!5m1!5f1",
		);
	});

	it("composes extra stylers on the legacy base tile", () => {
		const cfg = createLegacyTileConfig([
			{
				featureType: "administrative.country",
				elementType: "geometry.stroke",
				stylers: [{ weight: 2 }],
			},
		]);
		const url = new URL(buildStyledTileUrl(cfg, LEGACY_STYLE_MAP_ID, 33, 22, 6));
		expect(url.searchParams.get("pb")).toBe(
			"!1m5!1m4!1i6!2i33!3i22!4i256!2m2!1e0!2sm!3m12!2sen!3sUS!5e1105!12m1!1e3!12m1!1e2!12m4!1e26!2m2!1sstyles!2ss.t:1|s.e:g.s|p.v:off,s.t:17|s.e:g.s|p.w:2!5m1!5f1",
		);
	});

	it("serializes a legacy labels overlay tile", () => {
		const url = new URL(
			buildStyledTileUrl(createLabelsTileConfig(), LEGACY_STYLE_MAP_ID, 33, 22, 6),
		);
		expect(url.searchParams.get("pb")).toBe(
			"!1m5!1m4!1i6!2i33!3i22!4i256!2m2!1e0!2sm!3m17!2sen!3sUS!5e1105!12m4!1e68!2m2!1sset!2sRoadmap!12m3!1e37!2m1!1ssmartmaps!12m4!1e26!2m2!1sstyles!2ss.e:g|p.v:off,s.t:1|s.e:g.s|p.v:on,s.e:l|p.v:on!5m1!5f1",
		);
	});

	it("composes border emphasis on the legacy labels overlay tile", () => {
		const url = new URL(
			buildStyledTileUrl(
				createLabelsTileConfig([
					{
						featureType: "administrative.country",
						elementType: "geometry.stroke",
						stylers: [{ weight: 2 }],
					},
					{
						featureType: "administrative.province",
						elementType: "geometry.stroke",
						stylers: [{ weight: 3 }],
					},
				]),
				LEGACY_STYLE_MAP_ID,
				33,
				22,
				6,
			),
		);
		expect(url.searchParams.get("pb")).toBe(
			"!1m5!1m4!1i6!2i33!3i22!4i256!2m2!1e0!2sm!3m17!2sen!3sUS!5e1105!12m4!1e68!2m2!1sset!2sRoadmap!12m3!1e37!2m1!1ssmartmaps!12m4!1e26!2m2!1sstyles!2ss.e:g|p.v:off,s.t:1|s.e:g.s|p.v:on,s.e:l|p.v:on,s.t:17|s.e:g.s|p.w:2,s.t:18|s.e:g.s|p.w:3!5m1!5f1",
		);
	});

	it("wraps x across the antimeridian", () => {
		const url = new URL(
			buildStyledTileUrl(createLegacyTileConfig(), LEGACY_STYLE_MAP_ID, -1, 0, 2),
		);
		expect(url.searchParams.get("pb")).toContain("!1i2!2i3!3i0");
	});
});
