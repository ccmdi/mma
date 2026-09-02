// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { APP_SETTINGS, DEFAULTS, getSettings, resetSettings, setSetting } from "@/store/settings";
import { getLocal } from "@/lib/hooks/useLocalStorage";

describe("resetSettings", () => {
	it("returns every setting to its default and persists that", () => {
		setSetting("showFps", !DEFAULTS.showFps);
		expect(getSettings().showFps).toBe(!DEFAULTS.showFps);
		resetSettings();
		expect(getSettings()).toEqual(DEFAULTS);
		expect(getLocal(APP_SETTINGS)).toEqual(DEFAULTS);
	});
});
