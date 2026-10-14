// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const liveZoom = vi.hoisted(() => ({ value: 2.5 }));

vi.mock("@/lib/sv/opensv", () => {
	const pano = {
		getPosition: () => ({ lat: () => 12.5, lng: () => -3.25 }),
		getPov: () => ({ heading: 88.5, pitch: -4.5 }),
		getZoom: () => liveZoom.value,
		getPano: () => "live-pano",
		setPano: () => {},
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

import { Pano } from "@/lib/sv/pano";
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

describe("Pano.capture", () => {
	it("reads the live viewer", () => {
		Pano.jump("live-pano");
		expect(Pano.capture()).toEqual(live);
	});

	it("returns zoom in the stored domain, so a fully-out view reads as unset", () => {
		Pano.jump("live-pano");
		liveZoom.value = PANO_ZOOM.min;
		expect(Pano.capture()?.zoom).toBe(0);
		liveZoom.value = 2.5;
	});
});

describe("dropLocation", () => {
	it("takes the live camera, not the source's stored position", () => {
		const { location } = dropLocation(source, live, live.panoId, ["a"]);
		expect(location).toMatchObject(live);
		expect(location.id).toBe(0);
	});

	it("carries the source's flags and leaves the source as it was", () => {
		const before = structuredClone(source);
		const { location } = dropLocation(source, live, live.panoId, []);
		expect(location.flags).toBe(LocationFlag.LoadAsPanoId);
		expect(source).toEqual(before);
	});

	it("tags the drop by name through records, not with the source map's tag ids", () => {
		const { location, records } = dropLocation(source, live, live.panoId, ["Seen", "New"]);
		expect(location.tags.map((id) => records.tags[id]?.name)).toEqual(["Seen", "New"]);
		expect(Object.keys(records)).toEqual(["tags"]);
		expect(dropLocation(source, live, live.panoId, []).location.tags).toEqual([]);
	});

	it("drops extra once the drop leaves the source's pano", () => {
		expect(dropLocation(source, live, live.panoId, []).location.extra).toBeNull();
	});

	it("keeps extra for a drop that never left the source's pano", () => {
		const home = { ...live, panoId: source.panoId };
		expect(dropLocation(source, home, source.panoId, []).location.extra).toEqual(source.extra);
	});
});
