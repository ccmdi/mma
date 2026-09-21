import { describe, it, expect, beforeAll } from "vitest";
import * as tiles from "@/lib/geo/tiles";
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

describe("tile factories", () => {
	const styles = [
		{ featureType: "water", elementType: "geometry", stylers: [{ color: "#123456" }] },
	];
	const cases: [string, () => tiles.TileConfig, string][] = [
		[
			"roadmap",
			() => tiles.createRoadmapTileConfig(),
			"!1m5!1m4!1i4!2i5!3i7!4i256!2m2!1e0!2sm!3m17!2sen!3sUS!5e1105!12m4!1e68!2m2!1sset!2sRoadmap!12m3!1e37!2m1!1ssmartmaps!12m4!1e26!2m2!1sstyles!2ss.e:l|p.v:off,s.t:1|s.e:g.s|p.v:off!5m1!5f1",
		],
		[
			"roadmap styled",
			() => tiles.createRoadmapTileConfig(styles),
			"!1m5!1m4!1i4!2i5!3i7!4i256!2m2!1e0!2sm!3m17!2sen!3sUS!5e1105!12m4!1e68!2m2!1sset!2sRoadmap!12m3!1e37!2m1!1ssmartmaps!12m4!1e26!2m2!1sstyles!2ss.e:l|p.v:off,s.t:1|s.e:g.s|p.v:off,s.t:6|s.e:g|p.c:#123456!5m1!5f1",
		],
		[
			"labels",
			() => tiles.createLabelsTileConfig(),
			"!1m5!1m4!1i4!2i5!3i7!4i256!2m2!1e0!2sm!3m17!2sen!3sUS!5e1105!12m4!1e68!2m2!1sset!2sRoadmap!12m3!1e37!2m1!1ssmartmaps!12m4!1e26!2m2!1sstyles!2ss.e:g|p.v:off,s.t:1|s.e:g.s|p.v:on,s.e:l|p.v:on!5m1!5f1",
		],
		[
			"labels styled",
			() => tiles.createLabelsTileConfig(styles),
			"!1m5!1m4!1i4!2i5!3i7!4i256!2m2!1e0!2sm!3m17!2sen!3sUS!5e1105!12m4!1e68!2m2!1sset!2sRoadmap!12m3!1e37!2m1!1ssmartmaps!12m4!1e26!2m2!1sstyles!2ss.e:g|p.v:off,s.t:1|s.e:g.s|p.v:on,s.e:l|p.v:on,s.t:6|s.e:g|p.c:#123456!5m1!5f1",
		],
		[
			"legacy",
			() => tiles.createLegacyTileConfig(),
			"!1m5!1m4!1i4!2i5!3i7!4i256!2m2!1e0!2sm!3m12!2sen!3sUS!5e1105!12m1!1e3!12m1!1e2!12m4!1e26!2m2!1sstyles!2ss.t:1|s.e:g.s|p.v:off!5m1!5f1",
		],
		[
			"legacy styled",
			() => tiles.createLegacyTileConfig(styles),
			"!1m5!1m4!1i4!2i5!3i7!4i256!2m2!1e0!2sm!3m12!2sen!3sUS!5e1105!12m1!1e3!12m1!1e2!12m4!1e26!2m2!1sstyles!2ss.t:1|s.e:g.s|p.v:off,s.t:6|s.e:g|p.c:#123456!5m1!5f1",
		],
		[
			"legacy terrain",
			() => tiles.createLegacyTerrainTileConfig(),
			"!1m5!1m4!1i4!2i5!3i7!4i256!2m3!1e4!2st!3i725!2m3!1e0!2sr!3i725483392!3m13!2sen!3sUS!5e18!12m4!1e3!2m2!1sset!2sTerrain!12m3!1e37!2m1!1ssmartmaps!4e0!5m2!1e3!5f1!23i56565656!26m2!1e2!1e3",
		],
		[
			"satellite labels",
			() => tiles.createSatelliteLabelsTileConfig(),
			"!1m5!1m4!1i4!2i5!3i7!4i256!2m2!1e0!2sm!3m8!2sen!3sUS!5e1105!12m1!1e4!12m1!1e2!4e0!5m1!5f1",
		],
		[
			"satellite labels styled",
			() => tiles.createSatelliteLabelsTileConfig(styles),
			"!1m5!1m4!1i4!2i5!3i7!4i256!2m2!1e0!2sm!3m13!2sen!3sUS!5e1105!12m1!1e4!12m1!1e2!12m4!1e26!2m2!1sstyles!2ss.e:g|p.v:off,s.t:1|s.e:g.s|p.v:on,s.e:l|p.v:on,s.t:6|s.e:g|p.c:#123456!4e0!5m1!5f1",
		],
		[
			"satellite",
			() => tiles.createSatelliteTileConfig(),
			"!1m5!1m4!1i4!2i5!3i7!4i256!2m2!1e1!2ss!3m11!2sen!3sUS!12m4!1e68!2m2!1sset!2sRoadmapSatellite!12m3!1e37!2m1!1ssmartmaps!5m1!5f1",
		],
		[
			"sv",
			() => tiles.createSvTileConfig({ color: "#00aaff", thickness: "default" }),
			"!1m5!1m4!1i4!2i5!3i7!4i256!2m8!1e2!2ssvv!4m2!1scc!2s*211m3*211e2*212b1*213e2*211m3*211e3*212b1*213e2*211m3*211e10*212b1*213e2*212b1*214b1!4m2!1ssvl!2s*212b1!3m16!2sen!3sUS!12m4!1e68!2m2!1sset!2sRoadmap!12m3!1e37!2m1!1ssmartmaps!12m4!1e26!2m2!1sstyles!2sp.c:#00aaff,s.e:g.f|p.c:#00aaff|p.w:1,s.e:g.s|p.c:#cceeff|p.w:3!5m1!5f1",
		],
		[
			"sv high official",
			() =>
				tiles.createSvTileConfig({
					color: "#00aaff",
					thickness: "high",
					showUnofficial: false,
					useDetailedLines: false,
				}),
			"!1m5!1m4!1i4!2i5!3i7!4i256!2m8!1e2!2ssvv!4m2!1scc!2s*211m3*211e2*212b1*213e2*212b1*214b1!4m2!1ssvl!2s*21!3m16!2sen!3sUS!12m4!1e68!2m2!1sset!2sRoadmap!12m3!1e37!2m1!1ssmartmaps!12m4!1e26!2m2!1sstyles!2sp.c:#00aaff,s.e:g.f|p.c:#00aaff|p.w:0.5,s.e:g.s|p.c:#cceeff|p.w:0.5!5m1!5f1",
		],
		[
			"sv blobby",
			() => tiles.createSvBlobbyTileConfig({ color: "#00aaff" }),
			"!1m5!1m4!1i4!2i5!3i7!4i256!2m8!1e2!2ssvv!4m2!1scc!2s*211m3*211e2*212b1*213e2*211m3*211e3*212b1*213e2*211m3*211e10*212b1*213e2*212b1*214b1!4m2!1ssvl!2s*21!3m16!2sen!3sUS!12m4!1e68!2m2!1sset!2sRoadmap!12m3!1e37!2m1!1ssmartmaps!12m4!1e26!2m2!1sstyles!2sp.c:#00aaff!5m1!5f1",
		],
		[
			"sv blobby unofficial",
			() => tiles.createSvBlobbyTileConfig({ color: "#00aaff", showOfficial: false }),
			"!1m5!1m4!1i4!2i5!3i7!4i256!2m8!1e2!2ssvv!4m2!1scc!2s*211m3*211e3*212b1*213e2*211m3*211e10*212b1*213e2*212b1*214b1!4m2!1ssvl!2s*212b1!3m16!2sen!3sUS!12m4!1e68!2m2!1sset!2sRoadmap!12m3!1e37!2m1!1ssmartmaps!12m4!1e26!2m2!1sstyles!2ss.e:g|p.c:#00aaff|p.w:10,s.e:g.s|p.v:off!5m1!5f1",
		],
		[
			"terrain basemap",
			() => tiles.createTerrainBasemapTileConfig(),
			"!1m5!1m4!1i4!2i5!3i7!4i256!2m2!1e0!2sm!2m2!1e5!2sshading!2m2!1e6!2scontours!3m15!2sen!3sUS!12m4!1e68!2m2!1sset!2sTerrain!12m3!1e37!2m1!1ssmartmaps!12m1!1e67!12m1!1e63!5m1!5f1",
		],
		[
			"terrain basemap styled",
			() => tiles.createTerrainBasemapTileConfig(styles),
			"!1m5!1m4!1i4!2i5!3i7!4i256!2m2!1e0!2sm!2m2!1e5!2sshading!2m2!1e6!2scontours!3m20!2sen!3sUS!12m4!1e68!2m2!1sset!2sTerrain!12m3!1e37!2m1!1ssmartmaps!12m1!1e67!12m1!1e63!12m4!1e26!2m2!1sstyles!2ss.t:6|s.e:g|p.c:#123456!5m1!5f1",
		],
		[
			"terrain overlay",
			() => tiles.createTerrainOverlayTileConfig(),
			"!1m5!1m4!1i4!2i5!3i7!4i256!2m2!1e4!2st!3m15!2sen!3sUS!12m4!1e68!2m2!1sset!2sTerrain!12m3!1e37!2m1!1ssmartmaps!12m1!1e67!12m1!1e63!5m1!5f1",
		],
	];

	it.each(cases)("%s serializes to its pinned pb", (_name, make, pb) => {
		const url = new URL(tiles.buildTileUrl(make(), 5, 7, 4));
		expect(url.searchParams.get("pb")).toBe(pb);
	});
});
