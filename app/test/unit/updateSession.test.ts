// @vitest-environment jsdom
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
	getSettings: () => ({ restoreSession: h.restoreSession, prereleaseUpdates: false }),
}));
vi.mock("@/store/session", () => ({
	saveSession: (ids: string[]) => h.saved.push(ids),
}));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/lib/version", () => ({ appVersion: () => "0.0.1" }));
vi.mock("@/bindings.gen", () => ({
	events: { updateProgress: { listen: async () => () => {} } },
}));
vi.mock("@/lib/commands", () => ({
	cmd: {
		updateCheck: async () => ({ version: "9.9.9", currentVersion: "0.0.1", notes: "" }),
		updateInstall: async () => {
			h.savedAtDownload = h.saved.at(-1) ?? null;
		},
	},
}));

// One release, newer than the running build, so the check has something to offer.
vi.stubGlobal("fetch", async () => ({
	ok: true,
	json: async () => [
		{
			tag_name: "v9.9.9",
			body: "",
			draft: false,
			prerelease: false,
			published_at: "2026-01-01T00:00:00Z",
			assets: [{ name: "latest.json", browser_download_url: "https://example.invalid/l.json" }],
		},
	],
}));
vi.mock("@tauri-apps/plugin-process", () => ({
	relaunch: async () => {
		h.savedAtRelaunch = h.saved.at(-1) ?? null;
		h.relaunch();
	},
}));

import { act, createElement } from "react";
import { mount } from "./fixtures/harness";
import {
	checkForUpdate,
	dismissUpdate,
	installUpdate,
	relaunchApp,
	useUpdateState,
} from "@/lib/util/updateCheck";

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

describe("dismissing an update", () => {
	it("is remembered for that version across checks", async () => {
		let dismissed: boolean | null = null;
		function Probe() {
			dismissed = useUpdateState().dismissed;
			return null;
		}
		const m = mount(createElement(Probe));
		await act(() => checkForUpdate());
		expect(dismissed).toBe(false);
		act(() => dismissUpdate());
		expect(dismissed).toBe(true);
		await act(() => checkForUpdate());
		expect(dismissed).toBe(true);
		m.unmount();
	});
});
