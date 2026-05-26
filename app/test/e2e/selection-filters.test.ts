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
import type { Location } from "@/types";

describe("Selection filters — extra field operations", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Filter Extras");

		// Create locations with various extra fields
		const locs: Location[] = [];
		for (let i = 0; i < 20; i++) {
			locs.push(
				createLocation({
					lat: i,
					lng: i,
					extra: {
						altitude: i * 100,
						country: i < 10 ? "US" : "UK",
						imageDate: `2024-${String((i % 12) + 1).padStart(2, "0")}`,
					},
				}),
			);
		}
		await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("filter eq on string field", async () => {
		await withApi(async (api) => api.selectFilter("country", "eq", "US"));
		const ids = await refreshSelections();
		expect(ids.length).toBe(10);
	});

	it("filter neq on string field", async () => {
		await withApi(async (api) => api.selectFilter("country", "neq", "US"));
		const ids = await refreshSelections();
		expect(ids.length).toBe(10);
	});

	it("filter gt on numeric field", async () => {
		await withApi(async (api) => api.selectFilter("altitude", "gt", 1000));
		const ids = await refreshSelections();
		// altitude > 1000 means i > 10, so indices 11-19 = 9 locations
		expect(ids.length).toBe(9);
	});

	it("filter lt on numeric field", async () => {
		await withApi(async (api) => api.selectFilter("altitude", "lt", 500));
		const ids = await refreshSelections();
		// altitude < 500 means i < 5, so indices 0-4 = 5 locations
		expect(ids.length).toBe(5);
	});

	it("filter gte on numeric field", async () => {
		await withApi(async (api) => api.selectFilter("altitude", "gte", 1000));
		const ids = await refreshSelections();
		// altitude >= 1000 means i >= 10, so indices 10-19 = 10 locations
		expect(ids.length).toBe(10);
	});

	it("filter lte on numeric field", async () => {
		await withApi(async (api) => api.selectFilter("altitude", "lte", 500));
		const ids = await refreshSelections();
		// altitude <= 500 means i <= 5, so indices 0-5 = 6 locations
		expect(ids.length).toBe(6);
	});

	it("filter between on numeric field", async () => {
		await withApi(async (api) => api.selectFilter("altitude", "between", 500, 1500));
		const ids = await refreshSelections();
		// 500 <= altitude <= 1500 means 5 <= i <= 15, so 11 locations
		expect(ids.length).toBe(11);
	});

	it("filter has on field (field exists)", async () => {
		await withApi(async (api) => api.selectFilter("country", "has", ""));
		const ids = await refreshSelections();
		expect(ids.length).toBe(20);
	});

	it("filter nothas on field that does not exist", async () => {
		await withApi(async (api) => api.selectFilter("nonexistent", "nothas", ""));
		const ids = await refreshSelections();
		expect(ids.length).toBe(20);
	});

	it("filter returns empty for no matches", async () => {
		await withApi(async (api) => api.selectFilter("country", "eq", "JP"));
		const ids = await refreshSelections();
		expect(ids.length).toBe(0);
	});
});

describe("Selection filters — core field operations", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Filter Core");

		const locs: Location[] = [];
		for (let i = 0; i < 30; i++) {
			locs.push(
				createLocation({
					lat: i * 3,
					lng: i * 2,
					heading: i * 12,
					pitch: (i % 10) - 5,
					zoom: (i % 5) + 1,
					panoId: i < 15 ? `pano${i}` : null,
					flags: i < 10 ? 1 : 0,
				}),
			);
		}
		await addLocs(locs);
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	beforeEach(async () => {
		await withApi(async (api) => api.resetSelections());
	});

	it("filter on heading field", async () => {
		await withApi(async (api) => api.selectFilter("heading", "gt", 180));
		const ids = await refreshSelections();
		// heading > 180: i*12 > 180 → i > 15, so indices 16-29 = 14 locations
		expect(ids.length).toBe(14);
	});

	it("filter on lat field", async () => {
		await withApi(async (api) => api.selectFilter("lat", "between", 0, 30));
		const ids = await refreshSelections();
		// lat = i*3, 0 <= i*3 <= 30 → i = 0..10, so 11 locations
		expect(ids.length).toBe(11);
	});

	it("intersecting two filters narrows results", async () => {
		await withApi(async (api) => {
			await api.selectFilter("heading", "gt", 100);
			await api.selectFilter("heading", "lt", 200);
			await api.selectIntersection();
		});
		const ids = await refreshSelections();
		// heading > 100 AND heading < 200: i*12 > 100 AND i*12 < 200
		// i > 8.33 AND i < 16.67, so indices 9-16 = 8 locations
		expect(ids.length).toBe(8);
	});

	it("union of two filters combines results", async () => {
		await withApi(async (api) => {
			await api.selectFilter("heading", "lt", 36);
			await api.selectFilter("heading", "gt", 336);
			await api.selectUnion();
		});
		const ids = await refreshSelections();
		// heading < 36: i*12 < 36 → i < 3, indices 0-2 = 3
		// heading > 336: i*12 > 336 → i > 28, index 29 = 1
		// Union: 4
		expect(ids.length).toBe(4);
	});
});
