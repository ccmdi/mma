// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const COLOR_KEYS = [
	"markerColor",
	"openLocationColor",
	"importPreviewColor",
	"panoDotColor",
	"polygonColor",
	"tagFolderColor",
] as const;

async function loadSettings(stored: Record<string, unknown>) {
	localStorage.setItem("appSettings", JSON.stringify(stored));
	vi.resetModules();
	return import("@/store/settings");
}

beforeEach(() => {
	localStorage.clear();
});

describe("settings color shape", () => {
	it("reads colors persisted as {r,g,b} as tuples", async () => {
		const { getSettings } = await loadSettings({
			markerColor: { r: 1, g: 2, b: 3 },
			polygonColor: { r: 4, g: 5, b: 6 },
		});
		expect(getSettings().markerColor).toEqual([1, 2, 3]);
		expect(getSettings().polygonColor).toEqual([4, 5, 6]);
	});

	it("leaves tuples alone", async () => {
		const { getSettings } = await loadSettings({ markerColor: [7, 8, 9] });
		expect(getSettings().markerColor).toEqual([7, 8, 9]);
	});

	it("defaults every color setting to a tuple", async () => {
		const { getSettings } = await loadSettings({});
		const s = getSettings();
		for (const key of COLOR_KEYS) expect(s[key]).toHaveLength(3);
	});

	it("reads a color stored under activeLocationColor as openLocationColor", async () => {
		const { getSettings } = await loadSettings({ activeLocationColor: { r: 1, g: 2, b: 3 } });
		expect(getSettings().openLocationColor).toEqual([1, 2, 3]);
		expect(getSettings()).not.toHaveProperty("activeLocationColor");
	});
});
