import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	openMap,
	seedLocs,
	getLocCount,
	flushAndWait,
	withApi,
} from "./helpers";

describe("Duplicate map", () => {
	const ids: string[] = [];

	before(async () => {
		await waitForReady();
		const source = await createAndOpenMap("Dup Source");
		ids.push(source);
		await seedLocs(2, (i) => ({ lat: 10 + i, lng: 20 + i }));
		await withApi(async (api) => api.commitMap("two"));
		await seedLocs(1, () => ({ lat: 30, lng: 40 }));
		await withApi(async (api) => {
			await api.mapStorage("e2e").set("setup", { tag: "kept" });
			await api.edit.meta({ description: "about", labels: ["wip"] });
		});
	});

	after(async () => {
		await closeMap();
		for (const id of ids) await deleteMap(id);
	});

	it("copies what the open map holds, uncommitted edits included, and leaves the original pending", async () => {
		const copy = await withApi(async (api) => {
			const map = api.getMapState().map!;
			return api.duplicateMap(map.id, "Dup Copy");
		});
		ids.push(copy.id);

		expect(copy.name).toBe("Dup Copy");
		expect(copy.description).toBe("about");
		expect(copy.labels).toEqual(["wip"]);
		expect(copy.locationCount).toBe(3);
		expect(copy.pending).toEqual({ added: 0, removed: 0, modified: 0 });
		expect(copy.settings.pluginData).toEqual({ e2e: { setup: { tag: "kept" } } });
		expect(await withApi(async (api, id) => api.cmd.storeListCommits(id), copy.id)).toEqual([]);

		const source = await withApi(async (api) => api.getMapState().map!.id);
		expect(
			await withApi(async (api, id) => (await api.cmd.storeListCommits(id)).length, source),
		).toBe(1);
		expect(await getLocCount()).toBe(3);
		await flushAndWait();
		const pending = await withApi(
			async (api, id) => (await api.cmd.storeGetMap(id))?.pending,
			source,
		);
		expect(pending?.added).toBe(1);
	});

	it("opens as an independent map", async () => {
		const source = ids[0];
		const copy = ids[1];
		await closeMap();
		await openMap(copy);
		expect(await getLocCount()).toBe(3);
		await seedLocs(1, () => ({ lat: 50, lng: 60 }));
		await withApi(async (api) => api.mapStorage("e2e").set("setup", { tag: "changed" }));
		await closeMap();

		await openMap(source);
		expect(await getLocCount()).toBe(3);
		expect(await withApi(async (api) => api.mapStorage("e2e").get("setup"))).toEqual({
			tag: "kept",
		});
		const pending = await withApi(
			async (api, id) => (await api.cmd.storeGetMap(id))?.pending,
			source,
		);
		expect(pending?.added).toBe(1);
	});

	it("copies a closed map from what it saved", async () => {
		await closeMap();
		const copy = await withApi(async (api, id) => api.duplicateMap(id, "Dup Closed"), ids[0]);
		ids.push(copy.id);
		expect(copy.locationCount).toBe(3);
		await openMap(copy.id);
		expect(await getLocCount()).toBe(3);
	});
});
