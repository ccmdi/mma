// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/sv/opensv", async () => (await import("./fixtures/mocks")).googleMapsMock());

vi.mock("@/lib/geo/stackedMapType", async () =>
	(await import("./fixtures/mocks")).stackedMapTypeMock(),
);

import { buildMapStack } from "@/lib/geo/mapStack";
import type { TileLayer } from "@/lib/geo/stackedMapType";
import { BLOBBY_ZOOM_THRESHOLD } from "@/lib/sv/constants";
import { DEFAULT_PREFS, type MapEmbedPrefs } from "@/store/mapEmbedPrefs";

const base = DEFAULT_PREFS;

const layersOf = (prefs: MapEmbedPrefs) =>
	(buildMapStack(prefs, {}) as unknown as { layers: TileLayer[] }).layers;

/** The coverage layer is the only one carrying an opacity ramp. */
const svLayerOf = (prefs: MapEmbedPrefs) => layersOf(prefs).find((l) => l.opacity);

const svUrlAt = (prefs: MapEmbedPrefs, zoom: number) => svLayerOf(prefs)!.url(0, 0, zoom);

const svOpacityAt = (prefs: MapEmbedPrefs, zoom: number) => svLayerOf(prefs)!.opacity!(zoom);

beforeAll(() => {
	(globalThis as Record<string, unknown>).devicePixelRatio = 1;
});

describe("buildMapStack layer composition", () => {
	it("roadmap + labels => basemap + SV coverage + labels", () => {
		expect(layersOf(base)).toHaveLength(3);
		expect(svLayerOf(base)).toBeDefined();
	});

	it("drops the labels layer when labels are off", () => {
		expect(layersOf({ ...base, showLabels: false })).toHaveLength(2);
	});

	it("satellite + terrain + labels => basemap + terrain overlay + SV + labels", () => {
		expect(layersOf({ ...base, mapType: "satellite", showTerrain: true })).toHaveLength(4);
	});

	it("osm has no labels layer (labels baked into base tiles) and stops at zoom 19", () => {
		const layers = layersOf({ ...base, mapType: "osm" });
		expect(layers).toHaveLength(2);
		expect(layers[0].maxZoom).toBe(19);
	});

	it("legacy base map stacks a separate labels layer above SV coverage", () => {
		expect(layersOf({ ...base, mapStyleName: "legacy" })).toHaveLength(3);
	});

	it("legacy with labels off drops the labels layer", () => {
		expect(layersOf({ ...base, mapStyleName: "legacy", showLabels: false })).toHaveLength(2);
	});

	// A layer at zero alpha still costs a fetch and a draw on every tile in the viewport,
	// which is what made a fast zoom-out stall; hidden means absent, not transparent.
	it("leaves the coverage layer out entirely when it is hidden", () => {
		const layers = layersOf({ ...base, svVisible: false });
		expect(layers).toHaveLength(2);
		expect(layers.some((l) => l.opacity)).toBe(false);
	});

	it("leaves the coverage layer out when its opacity is zero", () => {
		expect(layersOf({ ...base, svOpacity: 0 })).toHaveLength(2);
	});
});

describe("SV coverage layer opacity and tiles", () => {
	it("carries svOpacity as the layer's blend alpha", () => {
		const prefs = { ...base, svOpacity: 0.8 };
		expect(svOpacityAt(prefs, 5)).toBeCloseTo(0.8);
		expect(svOpacityAt(prefs, 14)).toBeCloseTo(0.8);
	});

	it("dims single-coverage blobby tiles only up to the threshold zoom", () => {
		const prefs = {
			...base,
			svBlobby: true,
			svCoverageType: "official" as const,
			svOpacity: 0.5,
		};
		expect(svOpacityAt(prefs, BLOBBY_ZOOM_THRESHOLD)).toBeCloseTo(0.3);
		expect(svOpacityAt(prefs, BLOBBY_ZOOM_THRESHOLD + 1)).toBeCloseTo(0.5);
	});

	it("serves blobby tiles up to the threshold zoom and line tiles above it", () => {
		const on = { ...base, svBlobby: true };
		expect(svUrlAt(on, BLOBBY_ZOOM_THRESHOLD)).not.toBe(svUrlAt(base, BLOBBY_ZOOM_THRESHOLD));
		expect(svUrlAt(on, BLOBBY_ZOOM_THRESHOLD + 1)).toBe(svUrlAt(base, BLOBBY_ZOOM_THRESHOLD + 1));
	});
});
