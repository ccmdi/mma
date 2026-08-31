// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const liveZoom = vi.hoisted(() => ({ value: 2.5 }));

vi.mock("@/lib/sv/opensv", () => {
	const pano = {
		getPosition: () => ({ lat: () => 12.5, lng: () => -3.25 }),
		getPov: () => ({ heading: 88.5, pitch: -4.5 }),
		getZoom: () => liveZoom.value,
		getPano: () => "live-pano",
		addListener: () => ({}),
		setVisible: () => {},
	};
	return {
		google: {
			maps: {
				StreetViewPanorama: function () {
					return pano;
				},
			},
		},
	};
});
vi.mock("@/lib/sv/opensvPatch", () => ({ patchOpenSV: () => {}, setPanoHovered: () => {} }));

import { capturePano, getPanorama } from "@/lib/sv/panoSingleton";
import { createLocation, dropLocation, type PanoCapture } from "@/types";
import { LocationFlag } from "@/bindings.consts";
import { PANO_ZOOM } from "@/lib/sv/constants";

const source = createLocation({
	lat: 0,
	lng: 0,
	heading: 10,
	pitch: 20,
	zoom: 1,
	panoId: "spawn-pano",
	flags: LocationFlag.LoadAsPanoId,
	tags: [7],
	extra: { countryCode: "JP" },
});
const live: PanoCapture = {
	lat: 12.5,
	lng: -3.25,
	heading: 88.5,
	pitch: -4.5,
	zoom: 2.5,
	panoId: "live-pano",
};

describe("capturePano", () => {
	it("reads the live viewer", () => {
		getPanorama();
		expect(capturePano()).toEqual(live);
	});

	it("returns zoom in the stored domain, so a fully-out view reads as unset", () => {
		getPanorama();
		liveZoom.value = PANO_ZOOM.min;
		expect(capturePano()?.zoom).toBe(0);
		liveZoom.value = 2.5;
	});
});

describe("dropLocation", () => {
	it("takes the live camera, not the source's stored position", () => {
		const drop = dropLocation(source, live, live.panoId, [7]);
		expect(drop).toMatchObject(live);
		expect(drop.id).toBe(0);
	});

	it("carries the source's flags and the tags it is handed", () => {
		const drop = dropLocation(source, live, live.panoId, [1, 2]);
		expect(drop.flags).toBe(LocationFlag.LoadAsPanoId);
		expect(drop.tags).toEqual([1, 2]);
	});

	it("drops extra once the drop leaves the source's pano", () => {
		expect(dropLocation(source, live, live.panoId, []).extra).toBeNull();
	});

	it("keeps extra for a drop that never left the source's pano", () => {
		const home = { ...live, panoId: source.panoId };
		expect(dropLocation(source, home, source.panoId, []).extra).toEqual(source.extra);
	});
});
