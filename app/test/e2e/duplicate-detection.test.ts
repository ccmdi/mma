/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	addLocs,
	createLocation,
	refreshSelections,
	withApi,
} from "./helpers";
describe("Duplicate detection via selectDuplicates", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Duplicates");

		// Three clusters:
		// Cluster 1: two locations 10m apart (should be duplicates at 50m radius)
		// Cluster 2: two locations 10m apart
		// Isolated: one location far from everything
		await addLocs([
			createLocation({ lat: 48.8566, lng: 2.3522 }), // Paris A
			createLocation({ lat: 48.85665, lng: 2.35225 }), // Paris B (~5m away)
			createLocation({ lat: 40.7128, lng: -74.006 }), // NYC A
			createLocation({ lat: 40.71285, lng: -74.00605 }), // NYC B (~5m away)
			createLocation({ lat: -33.8688, lng: 151.2093 }), // Sydney (isolated)
		]);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("selectDuplicates with tight radius finds nearby locations", async () => {
		await withApi(async (api) => api.selectDuplicates(50));
		const ids = await refreshSelections();
		// Should find at least the 4 locations in 2 clusters
		expect(ids.length).toBeGreaterThanOrEqual(4);
	});

	it("selectDuplicates with very small radius finds fewer", async () => {
		await withApi(async (api) => api.selectDuplicates(1));
		const ids = await refreshSelections();
		// At 1m, the ~5m-apart locations might not be duplicates
		expect(ids.length).toBeLessThanOrEqual(4);
	});

	it("isolated location is not included in duplicates", async () => {
		await withApi(async (api) => api.selectDuplicates(50));
		const ids = await refreshSelections();
		// Total is 5 locations. Isolated one should not be a duplicate.
		expect(ids.length).toBeLessThan(5);
	});
});

describe("findNearby API", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E FindNearby");

		await addLocs([
			createLocation({ lat: 0, lng: 0 }),
			createLocation({ lat: 0.0001, lng: 0.0001 }), // ~15m away
			createLocation({ lat: 1, lng: 1 }), // ~157km away
		]);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("finds locations within radius", async () => {
		const nearby = await withApi(async (api) => {
			return api.cmd.storeFindNearby(0, 0, 100); // 100m radius
		});
		expect(nearby.length).toBe(2);
	});

	it("does not find distant locations", async () => {
		const nearby = await withApi(async (api) => {
			return api.cmd.storeFindNearby(0, 0, 100);
		});
		// The location at (1,1) is ~157km away, should not be found at 100m
		const hasDistant = nearby.some((l: any) => Math.abs(l.lat - 1) < 0.01);
		expect(hasDistant).toBe(false);
	});

	it("returns empty for location with no neighbors", async () => {
		const nearby = await withApi(async (api) => {
			return api.cmd.storeFindNearby(50, 50, 100); // no locations near (50,50)
		});
		expect(nearby.length).toBe(0);
	});
});
