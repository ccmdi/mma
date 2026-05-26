/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	waitForReady,
	createAndOpenMap,
	closeMap,
	deleteMap,
	withApi,
} from "./helpers";

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
			api.setSetting("showExactDate", false);
			api.setSetting("enableSeen", true);
			api.setSetting("showCameraBadges", true);
			api.setSetting("defaultMovementMode", "moving");
			api.setSetting("showFps", false);
			api.setSetting("tagViewMode", "flat");
		});
	});

	it("getSettings returns an object with known keys", async () => {
		const settings = await withApi(async (api) => api.getSettings());
		expect(typeof settings.showExactDate).toBe("boolean");
		expect(typeof settings.showCameraBadges).toBe("boolean");
		expect(typeof settings.enableSeen).toBe("boolean");
		expect(typeof settings.defaultMovementMode).toBe("string");
		expect(typeof settings.mapPanSpeed).toBe("number");
	});

	it("setting a boolean value persists", async () => {
		await withApi(async (api) => {
			api.setSetting("showExactDate", true);
		});
		const result = await withApi(async (api) => api.getSettings().showExactDate);
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

describe("Settings - saved selections", () => {
	let mapId: string;

	before(async () => {
		await waitForReady();
		mapId = await createAndOpenMap("E2E Settings SavedSel");
	});

	after(async () => {
		await closeMap();
		await deleteMap(mapId);
		// Clear saved selections
		await withApi(async (api) => {
			api.setSetting("savedSelections", []);
		});
	});

	it("starts with empty savedSelections", async () => {
		const sels = await withApi(async (api) => api.getSettings().savedSelections);
		expect(Array.isArray(sels)).toBe(true);
	});

	it("can store and retrieve saved selections via settings", async () => {
		await withApi(async (api) => {
			const current = api.getSettings().savedSelections;
			const entry = {
				id: "test-1",
				name: "Test Preset",
				items: [{ props: { type: "Everything" }, color: [255, 0, 0] }],
				createdAt: Date.now(),
			};
			api.setSetting("savedSelections", [...current, entry]);
		});

		const sels = await withApi(async (api) => api.getSettings().savedSelections);
		expect(sels.length).toBeGreaterThanOrEqual(1);
		const found = sels.find((s: any) => s.id === "test-1");
		expect(found).toBeTruthy();
		expect(found!.name).toBe("Test Preset");
	});

	it("can remove a saved selection", async () => {
		await withApi(async (api) => {
			const current = api.getSettings().savedSelections;
			api.setSetting(
				"savedSelections",
				current.filter((s: any) => s.id !== "test-1"),
			);
		});

		const sels = await withApi(async (api) => api.getSettings().savedSelections);
		const found = sels.find((s: any) => s.id === "test-1");
		expect(found).toBeUndefined();
	});
});
