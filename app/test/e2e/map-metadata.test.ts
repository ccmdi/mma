/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	flushAndWait,
	openMap,
	withApi,
} from "./helpers";

describe("Map metadata persistence", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Map Meta");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
	});

	it("description updates and persists", async () => {
		await withApi(async (api) => {
			await api.updateMapMeta({ description: "A test map for e2e" });
		});

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const desc = await withApi(async (api) => api.getCurrentMap()!.meta.description);
		expect(desc).toBe("A test map for e2e");
	});

	it("map settings update and persist", async () => {
		await withApi(async (api) => {
			await api.updateMapMeta({
				settings: {
					pointAlongRoad: true,
					preferDirection: "north",
					preferOfficial: true,
					preferHigherQuality: false,
					onlyOfficial: false,
					cameraTypes: null,
					defaultPanoId: false,
					exportZoom: true,
					exportUnpanned: false,
					enrichMetadata: false,
					enrichFields: null,
				},
			});
		});

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const settings = await withApi(async (api) => api.getCurrentMap()!.meta.settings);
		expect(settings.pointAlongRoad).toBe(true);
		expect(settings.preferDirection).toBe("north");
		expect(settings.preferOfficial).toBe(true);
		expect(settings.exportZoom).toBe(true);
	});

	it("scoreBounds update and persist", async () => {
		await withApi(async (api) => {
			await api.updateMapMeta({
				scoreBounds: [-60, 70, -170, 170],
			});
		});

		await flushAndWait();
		await closeMap();
		await openMap(mapId);

		const bounds = await withApi(async (api) => api.getCurrentMap()!.meta.scoreBounds);
		expect(bounds).toEqual([-60, 70, -170, 170]);
	});
});

describe("Map folder operations", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Folder Test");
		await closeMap();
	});

	after(async () => {
		await deleteMap(mapId);
	});

	it("moves map to folder", async () => {
		await withApi(async (api, id) => {
			await api.moveMapToFolder(id, "TestFolder");
		}, mapId);

		const maps = await withApi(async (api) => api.cmd.storeListMaps());
		const map = maps.find((m: any) => m.id === mapId);
		expect(map!.folder).toBe("TestFolder");
	});

	it("renames folder", async () => {
		await withApi(async (api) => {
			await api.renameFolder("TestFolder", "RenamedFolder");
		});

		const maps = await withApi(async (api) => api.cmd.storeListMaps());
		const map = maps.find((m: any) => m.id === mapId);
		expect(map!.folder).toBe("RenamedFolder");
	});

	it("moves map back to root", async () => {
		await withApi(async (api, id) => {
			await api.moveMapToFolder(id, null);
		}, mapId);

		const maps = await withApi(async (api) => api.cmd.storeListMaps());
		const map = maps.find((m: any) => m.id === mapId);
		expect(map!.folder).toBeNull();
	});
});

describe("Map listing and sorting", () => {
	const mapIds: string[] = [];

	before(async () => {
		await waitForReady();
		for (const name of ["Map Alpha", "Map Beta", "Map Gamma"]) {
			const id = await createAndOpenMap(name);
			await closeMap();
			mapIds.push(id);
		}
	});

	after(async () => {
		for (const id of mapIds) {
			await deleteMap(id);
		}
	});

	it("lists all created maps", async () => {
		const maps = await withApi(async (api) => api.cmd.storeListMaps());
		for (const id of mapIds) {
			const found = maps.find((m: any) => m.id === id);
			expect(found).toBeTruthy();
		}
	});

	it("each map has correct name", async () => {
		const maps = await withApi(async (api) => api.cmd.storeListMaps());
		const names = mapIds.map((id) => maps.find((m: any) => m.id === id)!.name);
		expect(names).toContain("Map Alpha");
		expect(names).toContain("Map Beta");
		expect(names).toContain("Map Gamma");
	});

	it("deleting a map removes it from the list", async () => {
		const toDelete = mapIds.pop()!;
		await deleteMap(toDelete);

		const maps = await withApi(async (api) => api.cmd.storeListMaps());
		const found = maps.find((m: any) => m.id === toDelete);
		expect(found).toBeUndefined();
	});
});
