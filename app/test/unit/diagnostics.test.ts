// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

const settings = vi.hoisted(() => ({
	current: {} as Record<string, unknown>,
	defaults: {} as Record<string, unknown>,
	privateKeys: new Set<string>(),
}));

vi.mock("@/store/settings", () => ({
	get DEFAULTS() {
		return settings.defaults;
	},
	PRIVATE_SETTINGS: settings.privateKeys,
	getSettings: () => settings.current,
}));
vi.mock("@/lib/commands", () => ({
	cmd: {
		storeDbStats: vi.fn(async () => ({})),
		appReady: vi.fn(async () => ({ startupMs: 0, uptimeSecs: 0 })),
		listUserPlugins: vi.fn(async () => []),
	},
}));
vi.mock("@/plugins/pluginHost", () => ({ getEnabledPlugins: () => [] }));
vi.mock("@/store/store", () => ({ Store: { get: () => ({ map: null }) } }));
vi.mock("@/store/tag", () => ({ Tag: { all: () => ({}) } }));
vi.mock("@/lib/data/procedure", () => ({ Procedure: {} }));
vi.mock("@/lib/sv/opensv", () => ({ google: undefined }));

import { collectDiagnostics } from "@/lib/diagnostics";

async function changedSettings(
	current: Record<string, unknown>,
	defaults: Record<string, unknown>,
	privateKeys: string[] = [],
): Promise<Record<string, unknown>> {
	settings.current = current;
	settings.defaults = defaults;
	settings.privateKeys.clear();
	for (const k of privateKeys) settings.privateKeys.add(k);
	return (await collectDiagnostics()).changedSettings;
}

describe("settings diff", () => {
	it("keeps only the keys that differ from the defaults", async () => {
		const defaults = { a: 1, b: "two", c: false, d: [1, 2] };
		const current = { a: 1, b: "changed", c: true, d: [1, 2] };
		expect(await changedSettings(current, defaults)).toEqual({ b: "changed", c: true });
	});

	it("compares structurally rather than by reference", async () => {
		expect(await changedSettings({ a: [1, 2] }, { a: [1, 2] })).toEqual({});
		expect(await changedSettings({ a: [1, 3] }, { a: [1, 2] })).toEqual({ a: [1, 3] });
	});

	it("summarizes oversized values instead of carrying them", async () => {
		const css = await changedSettings({ customCss: "z".repeat(50_000) }, { customCss: "" });
		expect(css.customCss).toMatch(/^<omitted: 50000 chars, [\d.]+ KB>$/);

		const selections = await changedSettings(
			{ saved: Array.from({ length: 300 }, (_, i) => ({ poly: [i, i, i, i, i] })) },
			{ saved: [] },
		);
		expect(selections.saved).toMatch(/^<omitted: 300 items, [\d.]+ KB>$/);
	});

	it("leaves values under the threshold intact", async () => {
		expect(await changedSettings({ a: "short" }, { a: "" })).toEqual({ a: "short" });
	});

	it("never emits the value of a private setting", async () => {
		// remoteApiKey and nominatimApiKey are credentials; a report that carries them hands
		// them to whoever reads the issue.
		const got = await changedSettings(
			{ remoteApiKey: "super-secret-value", tagGap: 4 },
			{ remoteApiKey: "", tagGap: 2 },
			["remoteApiKey"],
		);
		expect(JSON.stringify(got)).not.toContain("super-secret-value");
		expect(got.remoteApiKey).toBe("<set, redacted>");
		// Redacted, not dropped: knowing one is configured is useful, its value never is.
		expect(got.tagGap).toBe(4);
	});

	it("says nothing about a private setting left at its default", async () => {
		expect(
			await changedSettings({ remoteApiKey: "" }, { remoteApiKey: "" }, ["remoteApiKey"]),
		).toEqual({});
	});
});
