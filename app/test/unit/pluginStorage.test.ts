// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import type { Plugin } from "@/plugins/registry";
import { createPluginStorage, getPluginSetting, setPluginSetting } from "@/plugins/registry";

beforeEach(() => {
	localStorage.clear();
});

describe("createPluginStorage", () => {
	it("returns the fallback when a key is unset", () => {
		const s = createPluginStorage("p1");
		expect(s.get("k", 42)).toBe(42);
		expect(s.get("k")).toBeUndefined();
	});

	it("round-trips set -> get", () => {
		const s = createPluginStorage("p1");
		s.set("k", { a: 1 });
		expect(s.get("k")).toEqual({ a: 1 });
	});

	it("persists across separate instances of the same id", () => {
		createPluginStorage("p1").set("k", "v");
		expect(createPluginStorage("p1").get("k")).toBe("v");
	});

	it("namespaces by plugin id (no cross-talk)", () => {
		createPluginStorage("a").set("k", "from-a");
		createPluginStorage("b").set("k", "from-b");
		expect(createPluginStorage("a").get("k")).toBe("from-a");
		expect(createPluginStorage("b").get("k")).toBe("from-b");
	});

	it("remove deletes the key", () => {
		const s = createPluginStorage("p1");
		s.set("k", 1);
		s.remove("k");
		expect(s.get("k", "fb")).toBe("fb");
		expect(s.keys()).not.toContain("k");
	});

	it("keys lists the stored keys", () => {
		const s = createPluginStorage("p1");
		s.set("a", 1);
		s.set("b", 2);
		expect(s.keys().sort()).toEqual(["a", "b"]);
	});

	it("tolerates corrupt json, returning the fallback", () => {
		localStorage.setItem("mma_plugin:p1", "{not json");
		expect(createPluginStorage("p1").get("k", "fb")).toBe("fb");
	});
});

describe("plugin settings", () => {
	const plugin: Plugin = {
		id: "settings-plugin",
		name: "Settings Plugin",
		description: "settings",
		icon: "x",
		activate: () => {},
		settings: [
			{ key: "enabled", label: "Enabled", type: "boolean", default: true },
			{ key: "count", label: "Count", type: "number", default: 5 },
		],
	};

	it("falls back to the def default when unset", () => {
		expect(getPluginSetting(plugin, "enabled")).toBe(true);
		expect(getPluginSetting(plugin, "count")).toBe(5);
	});

	it("returns a stored value over the default (including falsy)", () => {
		setPluginSetting(plugin.id, "enabled", false);
		setPluginSetting(plugin.id, "count", 12);
		expect(getPluginSetting(plugin, "enabled")).toBe(false);
		expect(getPluginSetting(plugin, "count")).toBe(12);
	});

	it("returns undefined for an unknown key with no default", () => {
		expect(getPluginSetting(plugin, "nope")).toBeUndefined();
	});
});
