// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/sv/opensv", () => {
	class Size {
		constructor(
			public w: number,
			public h: number,
		) {}
	}
	class ImageMapType {
		opacity = 1;
		constructor(public opts: unknown) {}
		setOpacity(o: number) {
			this.opacity = o;
		}
	}
	return { google: { maps: { Size, ImageMapType } } };
});

vi.mock("@/lib/geo/stackedMapType", () => ({
	createCompositeMapType: (layers: unknown[]) => ({ layers }),
}));

import { buildMapStack, type MapStackOpts } from "@/lib/geo/mapStack";

const base: MapStackOpts = {
	type: "map",
	labels: true,
	terrain: false,
	color: "cyan",
	coverageType: "official",
	thickness: "default",
	useBlobby: false,
	boldCountry: false,
	boldSubdivision: false,
	style: "default",
	svOpacity: 0.5,
};

const layersOf = (r: ReturnType<typeof buildMapStack>) =>
	(r.mapType as unknown as { layers: unknown[] }).layers;

beforeAll(() => {
	(globalThis as Record<string, unknown>).devicePixelRatio = 1;
});

describe("buildMapStack layer composition", () => {
	it("roadmap + labels => basemap + SV coverage + labels, SV layer included", () => {
		const r = buildMapStack(base);
		expect(layersOf(r)).toHaveLength(3);
		expect(layersOf(r)).toContain(r.svLayer);
	});

	it("drops the labels layer when labels are off", () => {
		expect(layersOf(buildMapStack({ ...base, labels: false }))).toHaveLength(2);
	});

	it("satellite + terrain + labels => basemap + terrain overlay + SV + labels", () => {
		expect(layersOf(buildMapStack({ ...base, type: "satellite", terrain: true }))).toHaveLength(4);
	});

	it("osm has no labels layer (labels baked into base tiles)", () => {
		expect(layersOf(buildMapStack({ ...base, type: "osm" }))).toHaveLength(2);
	});

	it("legacy base map stacks a separate labels layer above SV coverage", () => {
		expect(layersOf(buildMapStack({ ...base, style: "legacy" }))).toHaveLength(3);
	});

	it("legacy with labels off drops the labels layer", () => {
		expect(layersOf(buildMapStack({ ...base, style: "legacy", labels: false }))).toHaveLength(2);
	});

	it("carries svOpacity onto the SV layer", () => {
		const r = buildMapStack({ ...base, svOpacity: 0.8 });
		expect((r.svLayer as unknown as { opacity: number }).opacity).toBeCloseTo(0.8);
	});

	it("dims a single-coverage blobby layer to 0.6x", () => {
		const r = buildMapStack({ ...base, useBlobby: true, coverageType: "official", svOpacity: 0.5 });
		expect((r.svLayer as unknown as { opacity: number }).opacity).toBeCloseTo(0.3);
	});
});
