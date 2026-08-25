// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/sv/opensv", async () => (await import("./fixtures/mocks")).googleMapsMock());

vi.mock("@/lib/geo/stackedMapType", async () =>
	(await import("./fixtures/mocks")).stackedMapTypeMock(),
);

import { buildMapStack } from "@/lib/geo/mapStack";
import { BLOBBY_ZOOM_THRESHOLD } from "@/lib/sv/constants";
import { DEFAULT_PREFS } from "@/store/mapEmbedPrefs";

const base = DEFAULT_PREFS;

const layersOf = (r: ReturnType<typeof buildMapStack>) =>
	(r.mapType as unknown as { layers: unknown[] }).layers;

const svUrlAt = (r: ReturnType<typeof buildMapStack>, zoom: number) =>
	(
		r.svLayer as unknown as { opts: { getTileUrl(c: { x: number; y: number }, z: number): string } }
	).opts.getTileUrl({ x: 0, y: 0 }, zoom);

const svTileOpacityAt = (r: ReturnType<typeof buildMapStack>, zoom: number) =>
	Number((r.svLayer.getTile(null, zoom, document) as HTMLElement).style.opacity);

beforeAll(() => {
	(globalThis as Record<string, unknown>).devicePixelRatio = 1;
});

describe("buildMapStack layer composition", () => {
	it("roadmap + labels => basemap + SV coverage + labels, SV layer included", () => {
		const r = buildMapStack(base, {});
		expect(layersOf(r)).toHaveLength(3);
		expect(layersOf(r)).toContain(r.svLayer);
	});

	it("drops the labels layer when labels are off", () => {
		expect(layersOf(buildMapStack({ ...base, showLabels: false }, {}))).toHaveLength(2);
	});

	it("satellite + terrain + labels => basemap + terrain overlay + SV + labels", () => {
		expect(
			layersOf(buildMapStack({ ...base, mapType: "satellite", showTerrain: true }, {})),
		).toHaveLength(4);
	});

	it("osm has no labels layer (labels baked into base tiles)", () => {
		expect(layersOf(buildMapStack({ ...base, mapType: "osm" }, {}))).toHaveLength(2);
	});

	it("legacy base map stacks a separate labels layer above SV coverage", () => {
		expect(layersOf(buildMapStack({ ...base, mapStyleName: "legacy" }, {}))).toHaveLength(3);
	});

	it("legacy with labels off drops the labels layer", () => {
		expect(
			layersOf(buildMapStack({ ...base, mapStyleName: "legacy", showLabels: false }, {})),
		).toHaveLength(2);
	});
});

describe("SV coverage per-tile style and opacity", () => {
	it("carries svOpacity onto SV tiles", () => {
		const r = buildMapStack({ ...base, svOpacity: 0.8 }, {});
		expect(svTileOpacityAt(r, 5)).toBeCloseTo(0.8);
		expect(svTileOpacityAt(r, 14)).toBeCloseTo(0.8);
	});

	it("dims single-coverage blobby tiles only up to the threshold zoom", () => {
		const r = buildMapStack(
			{ ...base, svBlobby: true, svCoverageType: "official", svOpacity: 0.5 },
			{},
		);
		expect(svTileOpacityAt(r, BLOBBY_ZOOM_THRESHOLD)).toBeCloseTo(0.3);
		expect(svTileOpacityAt(r, BLOBBY_ZOOM_THRESHOLD + 1)).toBeCloseTo(0.5);
	});

	it("serves blobby tiles up to the threshold zoom and line tiles above it", () => {
		const on = buildMapStack({ ...base, svBlobby: true }, {});
		const off = buildMapStack(base, {});
		expect(svUrlAt(on, BLOBBY_ZOOM_THRESHOLD)).not.toBe(svUrlAt(off, BLOBBY_ZOOM_THRESHOLD));
		expect(svUrlAt(on, BLOBBY_ZOOM_THRESHOLD + 1)).toBe(svUrlAt(off, BLOBBY_ZOOM_THRESHOLD + 1));
	});
});
