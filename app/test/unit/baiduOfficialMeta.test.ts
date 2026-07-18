import { describe, it, expect } from "vitest";
import type { BaiduPanoMeta } from "@/lib/sv/baidu/api";
import {
	baiduIdsFromGetMetadataRequest,
	buildBaiduImageMetadata,
	buildGetMetadataResponse,
	buildSingleImageSearchOk,
	buildTargetOverlay,
	latLngFromSingleImageSearchRequest,
} from "@/lib/sv/baidu/officialMeta";

const sample: BaiduPanoMeta = {
	id: "abc123",
	lng: 116.4,
	lat: 39.9,
	heading: 90,
	pitch: 0,
	roll: 0,
	date: "20240115",
	altitude: 12.5,
	roadName: "Test Rd",
	links: [
		{ pid: "link1", lng: 116.401, lat: 39.9, heading: 45 },
		{ pid: "link2", lng: 116.399, lat: 39.9, heading: 225 },
	],
	neighbors: [
		{ pid: "link1", lng: 116.401, lat: 39.9, heading: 45 },
		{ pid: "link2", lng: 116.399, lat: 39.9, heading: 225 },
		{ pid: "far1", lng: 116.405, lat: 39.902, heading: 60 },
	],
	timeline: [{ id: "hist1", year: 2020, month: 6, isCurrent: false }],
};

describe("baidu officialMeta", () => {
	it("builds official ImageMetadata with BAIDU: keys, neighbors, links, overlays", () => {
		const meta = buildBaiduImageMetadata(sample);
		expect(meta[0]).toEqual([1]);
		expect(meta[1]).toEqual([2, "BAIDU:abc123"]);
		const tiles = meta[2] as unknown[];
		expect(tiles[0]).toBe(2);
		expect(tiles[1]).toBe(2);
		expect(tiles[9]).toBe("BAIDU:abc123");
		const loc = (meta[5] as unknown[])[0] as unknown[];
		// Main location POV is heading-only (no pitch/roll — those tilt the sphere).
		const mainPov = (loc[1] as unknown[])[2] as unknown[];
		expect(mainPov).toEqual([90]);
		const panoramas = (loc[3] as unknown[])[0] as unknown[];
		// 3 neighbors + 1 timeline (links reuse neighbor slots)
		expect(panoramas.length).toBe(4);
		const links = loc[6] as unknown[];
		expect(links.length).toBe(2);
		expect((panoramas[0] as unknown[])[0]).toEqual([2, "BAIDU:link1"]);
		expect((panoramas[2] as unknown[])[0]).toEqual([2, "BAIDU:far1"]);

		const overlays = loc[5] as unknown[];
		expect(overlays).toBeTruthy();
		const targetFormat = overlays[2] as unknown[];
		expect(targetFormat[0]).toBe(1);
		const targetOverlay = overlays[3] as unknown[];
		expect(targetOverlay[1]).toBe(1);
		expect(typeof targetOverlay[2]).toBe("string");
		expect((targetOverlay[2] as string).length).toBeGreaterThan(0);
	});

	it("buildTargetOverlay maps distance bands to neighbor indices", () => {
		const overlays = buildTargetOverlay(sample.neighbors, {
			lat: sample.lat,
			lng: sample.lng,
			heading: sample.heading,
		});
		expect(overlays).toBeTruthy();
		const data = ((overlays as unknown[])[3] as unknown[])[2] as string;
		// Double-base64 (altproviders): atob once → single base64 of 32×16 bytes
		const inner = atob(data);
		const binary = atob(inner);
		expect(binary.length).toBe(32 * 16);
	});

	it("wraps GetMetadata / SIS responses", () => {
		expect(buildGetMetadataResponse([sample])[0]).toEqual([0]);
		expect(buildSingleImageSearchOk(sample)[0]).toEqual([0]);
	});

	it("parses GetMetadata request only when all ids are BAIDU:", () => {
		expect(
			baiduIdsFromGetMetadataRequest([
				[],
				[],
				[[[2, "BAIDU:a"]], [[2, "BAIDU:b"]]],
			]),
		).toEqual(["BAIDU:a", "BAIDU:b"]);
		expect(
			baiduIdsFromGetMetadataRequest([[], [], [[[2, "googlePano"]]]]),
		).toBeNull();
	});

	it("reads SingleImageSearch lat/lng/radius", () => {
		const center: unknown[] = [];
		center[2] = 39.9;
		center[3] = 116.4;
		expect(latLngFromSingleImageSearchRequest([[], [center, 50]])).toEqual({
			lat: 39.9,
			lng: 116.4,
			radius: 50,
		});
	});
});
