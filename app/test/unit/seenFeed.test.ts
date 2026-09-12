// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, act } from "react";
import { mount } from "./fixtures/harness";
import { createLocation } from "@/types";
import type { Location } from "@/bindings.gen";
import type { GeoDisplay } from "@/lib/geo/reverseGeocode";
import { seenPanoChanged, seenUpdateGeo, seenFlush } from "@/lib/seen/seen";
import { useSeenFeed } from "@/components/editor/location/useSeenFeed";

vi.mock("@/lib/seen/seen", () => ({
	seenPanoChanged: vi.fn(),
	seenUpdateGeo: vi.fn(),
	seenFlush: vi.fn(),
}));
vi.mock("@/lib/sv/panoSingleton", () => ({
	singletonPano: {},
	capturePov: () => ({ heading: 0, pitch: 0, zoom: 0 }),
}));
vi.mock("@/store/useMapStore", () => ({
	useMapState: (sel: (s: { activeLocation: Location | null }) => unknown) =>
		sel({ activeLocation: scene.location }),
}));
vi.mock("@/components/editor/location/PanoViewerContext", () => ({
	usePanoViewer: () => ({ draft: scene.draft, geo: scene.geo }),
}));

const scene: { location: Location | null; draft: Location | null; geo: GeoDisplay | null } = {
	location: null,
	draft: null,
	geo: null,
};

function Probe() {
	useSeenFeed();
	return null;
}

function render(patch: Partial<typeof scene>) {
	Object.assign(scene, patch);
	const mounted = mount(createElement(Probe), { attach: false });
	return {
		rerender(next: Partial<typeof scene>) {
			Object.assign(scene, next);
			act(() => mounted.root.render(createElement(Probe)));
		},
		unmount: mounted.unmount,
	};
}

const loc = (id: number, panoId: string | null) =>
	createLocation({ id, lat: 1, lng: 2, panoId });

beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(scene, { location: null, draft: null, geo: null });
});

describe("useSeenFeed", () => {
	it("stages exactly once per walked pano", () => {
		const view = render({ location: loc(7, "A"), draft: loc(7, "A") });
		expect(seenPanoChanged).toHaveBeenCalledTimes(1);

		view.rerender({ draft: { ...loc(7, "B"), lat: 3, lng: 4 } });
		expect(seenPanoChanged).toHaveBeenCalledTimes(2);
		expect(seenPanoChanged).toHaveBeenLastCalledWith(
			{ locationId: 7, panoId: "B", lat: 3, lng: 4 },
			null,
			expect.any(Function),
		);
	});

	it("does not stage again for anything short of a pano change", () => {
		const view = render({ location: loc(7, "A"), draft: loc(7, "A") });
		view.rerender({ draft: loc(7, "A") });
		view.rerender({ geo: { address: "Somewhere", countryCode: "FR" } });
		expect(seenPanoChanged).toHaveBeenCalledTimes(1);
		expect(seenUpdateGeo).toHaveBeenCalledWith({ address: "Somewhere", countryCode: "FR" });
	});

	it("the location's stored countryCode outranks the geocoder's", () => {
		render({
			location: { ...loc(7, "A"), extra: { countryCode: "JP" } },
			draft: loc(7, "A"),
			geo: { address: "Somewhere", countryCode: "FR" },
		});
		expect(seenPanoChanged).toHaveBeenLastCalledWith(
			expect.anything(),
			{ address: "Somewhere", countryCode: "JP" },
			expect.any(Function),
		);
	});

	it("a virtual location stages with no locationId", () => {
		render({ location: loc(-3, "A"), draft: loc(-3, "A") });
		expect(seenPanoChanged).toHaveBeenLastCalledWith(
			expect.objectContaining({ locationId: null }),
			null,
			expect.any(Function),
		);
	});

	it("flushes when the location closes", () => {
		const view = render({ location: loc(7, "A"), draft: loc(7, "A") });
		expect(seenFlush).not.toHaveBeenCalled();
		view.rerender({ location: null, draft: null });
		expect(seenFlush).toHaveBeenCalledTimes(1);
	});
});
