// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { headingRoadResolver } from "@/lib/sv/headingRoad";
import { pinPanoResolver } from "@/lib/sv/pinPano";
import { createLocation, LocationFlag } from "@/types";
import type { Location } from "@/types";

function loc(over: Partial<Location> = {}): Location {
	return { ...createLocation({ lat: 1, lng: 2 }), ...over };
}
function svData(drivingDirection: number): any {
	return { extra: { drivingDirection } };
}

describe("headingRoadResolver", () => {
	it("forwards patches heading to the driving direction", () => {
		expect(headingRoadResolver.resolve!(loc(), svData(90), { config: "forwards" })).toEqual({
			heading: 90,
		});
	});

	it("backwards patches heading to the opposite direction", () => {
		expect(headingRoadResolver.resolve!(loc(), svData(90), { config: "backwards" })).toEqual({
			heading: -90,
		});
	});

	it("returns null without pano data", () => {
		expect(headingRoadResolver.resolve!(loc(), null, { config: "forwards" })).toBeNull();
	});

	it("needs pano resolution only when the location has no pano", () => {
		expect(headingRoadResolver.needsPanoResolve!(loc({ panoId: null }), false)).toBe(true);
		expect(headingRoadResolver.needsPanoResolve!(loc({ panoId: "X" }), false)).toBe(false);
	});
});

describe("pinPanoResolver", () => {
	it("flags only panos resolved this run", () => {
		const l = loc({ flags: 0 });
		expect(pinPanoResolver.resolve!(l, null, { config: undefined, resolvedPanoId: "ABC" })).toEqual(
			{
				flags: LocationFlag.LoadAsPanoId,
			},
		);
		expect(pinPanoResolver.resolve!(l, null, { config: undefined })).toBeNull();
	});

	it("is pending for unpinned locations", () => {
		expect(pinPanoResolver.pending(loc({ flags: 0 }), false)).toBe(true);
	});
});
