// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, act } from "react";
import { mount } from "./fixtures/harness";
import { createLocation } from "@/types";
import type { Location } from "@/bindings.gen";
import type { GeoDisplay } from "@/lib/geo/reverseGeocode";
import { seenPanoChanged, seenUpdateGeo, seenFlush } from "@/lib/seen/seenRecorder";
import { useSeenFeed } from "@/components/editor/location/useSeenFeed";

vi.mock("@/lib/seen/seenRecorder", () => ({
	seenPanoChanged: vi.fn(),
	seenUpdateGeo: vi.fn(),
	seenFlush: vi.fn(),
}));
vi.mock("@/lib/hooks/usePano", () => {
	const viewer = { exists: () => true, captureView: () => ({ heading: 0, pitch: 0, zoom: 0 }) };
	return { usePano: () => viewer };
});
vi.mock("@/store/useMapStore", () => ({
	useMapState: (sel: (s: { open: { origin: string; row: Location | null } }) => unknown) =>
		sel({ open: { origin: scene.origin, row: scene.location } }),
}));
vi.mock("@/components/editor/location/PanoViewerContext", () => ({
	usePanoViewer: () => ({ draft: scene.draft, geo: scene.geo }),
}));

const scene: {
	location: Location | null;
	draft: Location | null;
	geo: GeoDisplay | null;
	origin: string;
} = {
	origin: "map",
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

const loc = (id: number, panoId: string | null) => ({
	...createLocation({ lat: 1, lng: 2, panoId }),
	id,
});

beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(scene, { location: null, draft: null, geo: null, origin: "map" });
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
			expect.anything(),
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
			expect.anything(),
		);
	});

	it("a preview stages with no locationId", () => {
		const preview = loc(3, "A");
		scene.origin = "seen";
		render({ location: preview, draft: preview });
		expect(seenPanoChanged).toHaveBeenLastCalledWith(
			expect.objectContaining({ locationId: null }),
			null,
			expect.anything(),
		);
	});

	it("flushes when the location closes", () => {
		const view = render({ location: loc(7, "A"), draft: loc(7, "A") });
		expect(seenFlush).not.toHaveBeenCalled();
		view.rerender({ location: null, draft: null });
		expect(seenFlush).toHaveBeenCalledTimes(1);
	});
});
