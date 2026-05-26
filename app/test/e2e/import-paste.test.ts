/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	getLocCount,
	withApi,
} from "./helpers";

describe("Import from paste — JSON", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Import Paste JSON");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("imports a JSON array of locations", async () => {
		const json = JSON.stringify([
			{ lat: 48.8566, lng: 2.3522, heading: 90, pitch: 0, zoom: 1 },
			{ lat: 40.7128, lng: -74.006, heading: 180, pitch: 5, zoom: 2 },
		]);

		const result = await withApi(async (api, text) => {
			return api.importPaste(text);
		}, json);

		expect(result[0].importedCount).toBe(2);
	});

	it("imported locations are retrievable", async () => {
		const count = await getLocCount();
		expect(count).toBe(2);
	});

	it("imported locations have correct coordinates", async () => {
		const locs = await withApi(async (api) => api.fetchAllLocations());
		const paris = locs.find((l: any) => Math.abs(l.lat - 48.8566) < 0.01);
		expect(paris).toBeTruthy();
		expect(paris!.heading).toBe(90);
	});
});

describe("Import from paste — CSV-like", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Import Paste CSV");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("imports lat,lng pairs", async () => {
		const csv = "lat,lng\n51.5074,-0.1278\n35.6762,139.6503";

		const result = await withApi(async (api, text) => {
			return api.importPaste(text);
		}, csv);

		expect(result[0].importedCount).toBeGreaterThanOrEqual(2);
	});

	it("imported CSV locations have correct coordinates", async () => {
		const locs = await withApi(async (api) => api.fetchAllLocations());
		const london = locs.find((l: any) => Math.abs(l.lat - 51.5074) < 0.01);
		expect(london).toBeTruthy();
	});
});

describe("Import from paste — single coordinate", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Import Paste Single");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("imports a single lat,lng pair", async () => {
		const result = await withApi(async (api) => {
			return api.importPaste("55.7558, 37.6173");
		});

		expect(result[0].importedCount).toBe(1);
		const count = await getLocCount();
		expect(count).toBe(1);
	});
});

describe("Import from paste — undo", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Import Paste Undo");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("undo reverses a paste import", async () => {
		const json = JSON.stringify([
			{ lat: 10, lng: 10 },
			{ lat: 20, lng: 20 },
			{ lat: 30, lng: 30 },
		]);

		await withApi(async (api, text) => api.importPaste(text), json);
		const before = await getLocCount();
		expect(before).toBe(3);

		await withApi(async (api) => api.undo());
		const after = await getLocCount();
		expect(after).toBe(0);
	});
});
