import { describe, it, expect, vi, beforeEach } from "vitest";

// Pin the #89 fix: updating/relaunching must snapshot the open-map session before
// the process can die, otherwise restore reopens the stale list from the last normal quit.

const h = vi.hoisted(() => ({
	openIds: ["map-a", "map-b"] as string[],
	restoreSession: true,
	savedAtDownload: null as string[] | null,
	savedAtRelaunch: null as string[] | null,
	saved: [] as string[][],
	relaunch: vi.fn(),
}));

vi.mock("@/lib/window", () => ({
	appWindow: { type: "list" },
	openWindows: async () => h.openIds.map((mapId) => ({ type: "editor", mapId })),
}));
vi.mock("@/store/settings", () => ({
	getSettings: () => ({ restoreSession: h.restoreSession }),
}));
vi.mock("@/store/session", () => ({
	saveSession: (ids: string[]) => h.saved.push(ids),
}));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@tauri-apps/plugin-updater", () => ({
	check: async () => ({
		version: "9.9.9",
		body: "",
		downloadAndInstall: async () => {
			h.savedAtDownload = h.saved.at(-1) ?? null;
		},
	}),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
	relaunch: async () => {
		h.savedAtRelaunch = h.saved.at(-1) ?? null;
		h.relaunch();
	},
}));

import { checkForUpdate, installUpdate, relaunchApp } from "@/lib/util/updateCheck";

beforeEach(() => {
	h.saved = [];
	h.savedAtDownload = null;
	h.savedAtRelaunch = null;
	h.restoreSession = true;
});

describe("update restarts snapshot the session", () => {
	it("installUpdate saves open maps before downloadAndInstall runs", async () => {
		await checkForUpdate();
		await installUpdate();
		expect(h.savedAtDownload).toEqual(["map-a", "map-b"]);
	});

	it("relaunchApp saves open maps before relaunching", async () => {
		await relaunchApp();
		expect(h.savedAtRelaunch).toEqual(["map-a", "map-b"]);
		expect(h.relaunch).toHaveBeenCalled();
	});

	it("respects the restoreSession setting being off", async () => {
		h.restoreSession = false;
		await relaunchApp();
		expect(h.saved).toEqual([]);
	});
});
