import { waitForReady, createAndOpenMap, closeMap, deleteMap, withApi } from "./helpers";

describe("Settings persistence", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Settings");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
		// Reset settings to defaults
		await withApi(async (api) => {
			api.setSetting("showPanoMetadata", false);
			api.setSetting("enableSeen", true);
			api.setSetting("showCameraBadges", true);
			api.setSetting("defaultMovementMode", "moving");
			api.setSetting("showFps", false);
			api.setSetting("tagViewMode", "flat");
		});
	});

	it("getSettings returns an object with known keys", async () => {
		const settings = await withApi(async (api) => api.getSettings());
		expect(typeof settings.showPanoMetadata).toBe("boolean");
		expect(typeof settings.showCameraBadges).toBe("boolean");
		expect(typeof settings.enableSeen).toBe("boolean");
		expect(typeof settings.defaultMovementMode).toBe("string");
		expect(typeof settings.mapPanSpeed).toBe("number");
	});

	it("setting a boolean value persists", async () => {
		await withApi(async (api) => {
			api.setSetting("showPanoMetadata", true);
		});
		const result = await withApi(async (api) => api.getSettings().showPanoMetadata);
		expect(result).toBe(true);
	});

	it("setting an enum value persists", async () => {
		await withApi(async (api) => {
			api.setSetting("defaultMovementMode", "nmpz");
		});
		const result = await withApi(async (api) => api.getSettings().defaultMovementMode);
		expect(result).toBe("nmpz");
	});

	it("multiple settings changes accumulate", async () => {
		await withApi(async (api) => {
			api.setSetting("showFps", true);
			api.setSetting("tagViewMode", "tree");
			api.setSetting("enableSeen", false);
		});
		const settings = await withApi(async (api) => ({
			showFps: api.getSettings().showFps,
			tagViewMode: api.getSettings().tagViewMode,
			enableSeen: api.getSettings().enableSeen,
		}));
		expect(settings.showFps).toBe(true);
		expect(settings.tagViewMode).toBe("tree");
		expect(settings.enableSeen).toBe(false);
	});

	it("settings survive page context (localStorage-backed)", async () => {
		await withApi(async (api) => {
			api.setSetting("showCameraBadges", false);
		});

		// Settings are stored in localStorage, so reading back should still work
		const result = await withApi(async (api) => api.getSettings().showCameraBadges);
		expect(result).toBe(false);
	});
});

describe("Saved selections", () => {
	const created: string[] = [];

	before(async () => {
		await waitForReady();
	});

	after(async () => {
		await withApi(async (api, ids) => {
			// eslint-disable-next-line local/no-ipc-in-loop -- at most one leftover rule
			for (const id of ids) await api.cmd.storeDeleteSavedSelection(id);
			return "ok";
		}, created);
	});

	it("stores a rule with its tag-name side table and reads it back", async () => {
		const saved = await withApi(async (api) =>
			api.cmd.storeSaveSelection(
				"E2E Preset",
				{ type: "Tag", tagId: 7 },
				{ 7: "Japan" },
				[255, 0, 0],
			),
		);
		created.push(saved.id);

		// The index carries identity only; the tree comes from a separate by-id read.
		const index = await withApi(async (api) => api.cmd.storeListSavedSelections());
		const listed = index.find((s) => s.id === saved.id);
		expect(listed).toBeTruthy();
		expect(listed!.name).toBe("E2E Preset");
		expect(listed!.color).toEqual([255, 0, 0]);
		expect(listed).not.toHaveProperty("selector");

		const [body] = await withApi(
			async (api, id) => api.cmd.storeGetSavedSelections([id]),
			saved.id,
		);
		expect(body.selector).toEqual({ type: "Tag", tagId: 7 });
		expect(body.tagNames).toEqual({ 7: "Japan" });
	});

	it("removes a rule", async () => {
		const id = created.pop()!;
		await withApi(async (api, saved) => api.cmd.storeDeleteSavedSelection(saved), id);
		const index = await withApi(async (api) => api.cmd.storeListSavedSelections());
		expect(index.find((s) => s.id === id)).toBeUndefined();
	});
});
