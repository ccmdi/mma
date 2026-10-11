// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createLocation } from "@/types";
import type { PanoViewer } from "@/lib/sv/pano";

const active = { ...createLocation({ lat: 1, lng: 2, panoId: null }), id: 7 };

vi.mock("@/lib/commands", () => ({ cmd: {} }));
vi.mock("@/store/settings", () => ({ getSettings: () => ({}) }));
vi.mock("@/store/useMapStore", () => ({
	getMapState: () => ({ open: { location: active } }),
	read: async () => [active],
	addLocations: vi.fn(),
	openLocation: vi.fn(),
}));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { loadSeenPano } from "@/lib/seen/seenRecorder";

describe("loadSeenPano", () => {
	it("jumps the open location by position when it has no pano id", async () => {
		const jump = vi.fn();
		const viewer = { exists: () => true, jump } as unknown as PanoViewer;
		await loadSeenPano(
			{
				locationId: 7,
				panoId: null,
				lat: 1,
				lng: 2,
				heading: 90,
				pitch: 5,
				zoom: 1,
				countryCode: null,
			},
			viewer,
		);
		expect(jump).toHaveBeenCalledWith({ lat: 1, lng: 2 }, { heading: 90, pitch: 5, zoom: 1 });
	});
});
