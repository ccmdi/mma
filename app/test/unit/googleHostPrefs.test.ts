// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/sv/opensv", async () => (await import("./fixtures/mocks")).googleMapsMock());

vi.mock("@/lib/geo/stackedMapType", async () =>
	(await import("./fixtures/mocks")).stackedMapTypeMock(),
);

import { createGoogleMapHost } from "@/lib/map/googleHost";
import type { TileLayer } from "@/lib/geo/stackedMapType";
import { BLOBBY_ZOOM_THRESHOLD } from "@/lib/sv/constants";
import { DEFAULT_PREFS } from "@/store/mapEmbedPrefs";

type Host = ReturnType<typeof createGoogleMapHost>;

const makeHost = (): Host =>
	createGoogleMapHost(document.createElement("div"), DEFAULT_PREFS, { customStyles: [] });

// The roadmap stack is [basemap, SV coverage, labels]; the coverage layer is the only one
// carrying an opacity ramp, and it is left out of the stack entirely when hidden.
const svLayer = (host: Host) =>
	(host.getHostInstance() as unknown as { stack: { layers: TileLayer[] } }).stack.layers.find(
		(l) => l.opacity,
	);

const svOpacity = (host: Host, zoom = 5) => svLayer(host)?.opacity?.(zoom);

describe("GoogleMapHost.applyPrefs", () => {
	it("installs a stack carrying the passed svOpacity", () => {
		const host = makeHost();
		expect(svOpacity(host)).toBeCloseTo(DEFAULT_PREFS.svOpacity);
		host.applyPrefs({ ...DEFAULT_PREFS, svOpacity: 0.9 }, { customStyles: [] });
		expect(svOpacity(host)).toBeCloseTo(0.9);
	});

	// The minimap toggles blue lines through applyPrefs alone: no other opacity path exists.
	it("drops the SV layer at zero opacity, and brings it back", () => {
		const host = makeHost();
		host.applyPrefs({ ...DEFAULT_PREFS, svOpacity: 0 }, { customStyles: [] });
		expect(svLayer(host)).toBeUndefined();
		host.applyPrefs({ ...DEFAULT_PREFS, svOpacity: 0.5 }, { customStyles: [] });
		expect(svOpacity(host)).toBeCloseTo(0.5);
	});

	it("dims single-coverage blobby tiles only up to the threshold zoom", () => {
		const host = makeHost();
		host.applyPrefs(
			{ ...DEFAULT_PREFS, svBlobby: true, svCoverageType: "official", svOpacity: 0.5 },
			{ customStyles: [] },
		);
		expect(svOpacity(host, BLOBBY_ZOOM_THRESHOLD)).toBeCloseTo(0.3);
		expect(svOpacity(host, BLOBBY_ZOOM_THRESHOLD + 1)).toBeCloseTo(0.5);
	});
});
