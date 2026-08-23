/**
 * Map-click location creation: triggerClickAt drives the real pipeline
 * (Maps click event -> deck.gl pick -> handleMapClick -> lookupStreetView ->
 * addLocations). Under --mock the whole lookup (StreetViewService, photometa,
 * GetMetadata) is served by svMock; unmocked it hits real Street View.
 */
import { useMap, withApi, getLocCount, getAllLocs } from "./helpers";

// Matches an svMock fixture pano; also has real coverage for unmocked runs.
const COVERED = { lat: 52.10947502806108, lng: 34.90131410856584 };
const OCEAN = { lat: 0, lng: 0 };

async function clickAt(lat: number, lng: number) {
	await withApi(
		async (api, la, ln) => {
			const host = api.getMapHost();
			if (!host) throw new Error("no map host");
			host.triggerClickAt({ lat: la, lng: ln });
		},
		lat,
		lng,
	);
}

describe("Map click", () => {
	useMap("E2E MapClick", { closeLocation: true });

	it("clicking empty map creates a location snapped to SV coverage", async () => {
		const before = await getLocCount();
		// The deck overlay drops clicks until its first render completes (slow under
		// software WebGL), so retry until the click actually lands.
		await browser.waitUntil(
			async () => {
				await clickAt(COVERED.lat, COVERED.lng);
				return (await getLocCount()) > before;
			},
			{ timeout: 15000, interval: 1000, timeoutMsg: "covered click never created a location" },
		);

		const locs = await getAllLocs();
		const loc = locs[locs.length - 1];
		expect(loc.panoId).toBeTruthy();
		expect(Math.abs(loc.lat - COVERED.lat)).toBeLessThan(0.01);
		expect(Math.abs(loc.lng - COVERED.lng)).toBeLessThan(0.01);
	});

	it("clicking where no coverage exists creates nothing and toasts", async () => {
		const before = await getLocCount();
		await clickAt(OCEAN.lat, OCEAN.lng);
		await browser.waitUntil(
			async () =>
				browser.execute(() => document.body.textContent?.includes("No coverage found") === true),
			{ timeout: 15000, timeoutMsg: "no-coverage toast never appeared" },
		);
		expect(await getLocCount()).toBe(before);
	});
});
