// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pano } from "@/bindings.gen";
import { PanoType, type CameraType } from "@/bindings.consts";
import { StreetView } from "@/lib/sv/streetView";

vi.mock("@/lib/geo/photometa", () => ({ fetchPanoDotsWithIds: async () => [] }));

describe("StreetView.radiusAtZoom", () => {
	it("is unclamped at high zoom (the 25m floor now lives in the caller)", () => {
		expect(StreetView.radiusAtZoom(0, 20)).toBeLessThan(1);
	});

	it("larger at low zoom", () => {
		const lowZoom = StreetView.radiusAtZoom(0, 5);
		const highZoom = StreetView.radiusAtZoom(0, 15);
		expect(lowZoom).toBeGreaterThan(highZoom);
	});

	it("accounts for latitude (smaller radius at high latitudes)", () => {
		const equator = StreetView.radiusAtZoom(0, 10);
		const polar = StreetView.radiusAtZoom(80, 10);
		expect(equator).toBeGreaterThan(polar);
	});

	it("zoom 0 produces an absurdly large radius (the jump bug)", () => {
		const r = StreetView.radiusAtZoom(0, 0);
		expect(r).toBeGreaterThan(600_000);
	});

	it("zoom 15+ produces a radius suitable for local navigation", () => {
		const r = StreetView.radiusAtZoom(0, 15);
		expect(r).toBeLessThan(200);
	});
});

describe("StreetView.clickRadius (the cursor picker must equal the real click radius)", () => {
	it("equals the rounded zoom/lat extent when above the 50m floor", () => {
		expect(StreetView.clickRadius(0, 12)).toBe(Math.round(StreetView.radiusAtZoom(0, 12)));
	});

	it("floors at 50m when zoomed in past the default minimum", () => {
		expect(StreetView.clickRadius(0, 22)).toBe(50);
	});

	it("respects a custom minRadius floor", () => {
		expect(StreetView.clickRadius(0, 22, 120)).toBe(120);
	});

	it("ignores the minRadius floor when the extent is larger", () => {
		expect(StreetView.clickRadius(0, 5, 120)).toBe(Math.round(StreetView.radiusAtZoom(0, 5)));
	});
});

describe("StreetView.initialHeading", () => {
	function makeData(opts: { centerHeading?: number; links?: { heading: number }[] }): Pano {
		return {
			pov: { heading: opts.centerHeading ?? 0, tilt: 90, roll: 0 },
			centerHeading: opts.centerHeading ?? 0,
			links: opts.links ?? [],
		} as unknown as Pano;
	}

	it("returns 0 when pointAlongRoad is false", () => {
		expect(
			StreetView.initialHeading(makeData({ centerHeading: 90, links: [{ heading: 45 }] })),
		).toBe(0);
		expect(
			StreetView.initialHeading(makeData({ centerHeading: 90 }), { pointAlongRoad: false }),
		).toBe(0);
	});

	it("returns first link heading when no preferDirection", () => {
		const data = makeData({ links: [{ heading: 45 }, { heading: 135 }] });
		expect(StreetView.initialHeading(data, { pointAlongRoad: true })).toBe(45);
	});

	it("returns center heading for forwards", () => {
		const data = makeData({ centerHeading: 90 });
		expect(
			StreetView.initialHeading(data, { pointAlongRoad: true, preferDirection: "forwards" }),
		).toBe(90);
	});

	it("returns center - 180 for backwards", () => {
		const data = makeData({ centerHeading: 90 });
		expect(
			StreetView.initialHeading(data, { pointAlongRoad: true, preferDirection: "backwards" }),
		).toBe(-90);
	});

	it("picks closest link to cardinal direction", () => {
		const data = makeData({ links: [{ heading: 10 }, { heading: 170 }, { heading: 260 }] });
		expect(
			StreetView.initialHeading(data, { pointAlongRoad: true, preferDirection: "south" }),
		).toBe(170);
		expect(StreetView.initialHeading(data, { pointAlongRoad: true, preferDirection: "west" })).toBe(
			260,
		);
		expect(
			StreetView.initialHeading(data, { pointAlongRoad: true, preferDirection: "north" }),
		).toBe(10);
	});
});

describe("StreetView.thumbnailUrl", () => {
	it("includes pano ID and heading", () => {
		const url = StreetView.thumbnailUrl("ABC123", 90);
		expect(url).toContain("panoid=ABC123");
		expect(url).toContain("yaw=90");
	});

	it("uses default dimensions", () => {
		const url = StreetView.thumbnailUrl("ABC123", 0);
		expect(url).toContain("w=320");
		expect(url).toContain("h=180");
	});

	it("respects custom dimensions", () => {
		const url = StreetView.thumbnailUrl("ABC123", 0, 640, 360);
		expect(url).toContain("w=640");
		expect(url).toContain("h=360");
	});
});

describe("the pano a click lands on", () => {
	function cand(id: string, cameraType: CameraType | null, imageDate = "2020-01"): Pano {
		return { id, cameraType, imageDate, lat: 0, lng: 0, copyright: "© Google" } as unknown as Pano;
	}

	/** The official search answers the first candidate, whose timeline names them all. */
	async function landsOn(cands: Pano[], opts: Parameters<typeof StreetView.lookup>[3]) {
		const official = { ...cands[0], time: cands.map((c) => ({ panoId: c.id })) } as Pano;
		vi.spyOn(StreetView, "panosAt").mockImplementation(async (_points, search) => [
			search?.sources?.[0] === PanoType.Official ? official : null,
		]);
		vi.spyOn(StreetView, "metadata").mockImplementation(async (ids) =>
			ids.map((id) => cands.find((c) => c.id === id) ?? null),
		);
		return (await StreetView.lookup(0, 0, 18, opts))?.panoId;
	}

	afterEach(() => vi.restoreAllMocks());

	it("skips a camera type the rank table excludes", async () => {
		expect(
			await landsOn([cand("t", "trekker"), cand("g", "gen4")], { preferHigherQuality: true }),
		).toBe("g");
	});

	it("keeps an excluded type when quality is not preferred", async () => {
		expect(await landsOn([cand("t", "trekker"), cand("g", "gen4")], {})).toBe("t");
	});

	it("ranks by the rank table, not by capture date", async () => {
		expect(
			await landsOn(
				[
					cand("gen1", "gen1", "2024-01"),
					cand("tripod", "tripod", "2011-01"),
					cand("gen4", "gen4"),
				],
				{ preferHigherQuality: true },
			),
		).toBe("gen4");
	});

	it("prefers a known camera type over an unknown one", async () => {
		expect(
			await landsOn([cand("unknown", null), cand("gen1", "gen1")], { preferHigherQuality: true }),
		).toBe("gen1");
	});

	it("breaks a rank tie with the newer capture", async () => {
		expect(
			await landsOn([cand("old", "gen4", "2015-06"), cand("new", "gen4", "2023-02")], {
				preferOfficial: true,
				preferHigherQuality: true,
			}),
		).toBe("new");
	});
});
