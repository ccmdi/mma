// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { APP_SETTINGS, DEFAULTS, getSettings, resetSettings, setSetting } from "@/store/settings";
import { getLocal, reloadLocal } from "@/lib/hooks/useLocalStorage";
import type { MapKeyBinding } from "@/bindings.gen";

describe("resetSettings", () => {
	it("returns every setting to its default and persists that", () => {
		setSetting("showFps", !DEFAULTS.showFps);
		expect(getSettings().showFps).toBe(!DEFAULTS.showFps);
		resetSettings();
		expect(getSettings()).toEqual(DEFAULTS);
		expect(getLocal(APP_SETTINGS)).toEqual(DEFAULTS);
	});

	it("keeps the global copy-to-map bindings the dialog promises to keep", () => {
		const bindings: MapKeyBinding[] = [{ key: "q", action: { type: "applyTag", tagId: 1 } }];
		setSetting("globalCopyBindings", bindings);
		resetSettings();
		expect(getSettings()).toEqual({ ...DEFAULTS, globalCopyBindings: bindings });
		setSetting("globalCopyBindings", DEFAULTS.globalCopyBindings);
	});
});

describe("the welcome flag", () => {
	it("migrates out of app settings into its own key", () => {
		localStorage.setItem("appSettings", JSON.stringify({ ...DEFAULTS, hasSeenWelcome: true }));
		expect(reloadLocal(APP_SETTINGS)).not.toHaveProperty("hasSeenWelcome");
		expect(getLocal("welcomeSeen", false)).toBe(true);
		expect(JSON.parse(localStorage.getItem("appSettings")!)).not.toHaveProperty("hasSeenWelcome");
	});
});
