// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Plugin } from "@/plugins/registry";
import {
	registerPlugin,
	getPlugin,
	getPlugins,
	unregisterPlugin,
	isPluginEnabled,
	setPluginEnabled,
	getEnabledPlugins,
	activatePlugin,
	activatePlugins,
	deactivatePlugin,
	deactivatePlugins,
	setPendingManifest,
	isPluginCompatible,
	isBackgroundPlugin,
} from "@/plugins/registry";
import { subscribe } from "@/lib/events";
import {
	registerProvider,
	getProviders,
	registerEnrichFields,
	getEnrichFieldOptions,
} from "@/lib/data/fieldDefs";
import { getFieldDef } from "@/lib/data/fieldDefRegistry";

function makePlugin(id: string, name: string, activate: Plugin["activate"] = vi.fn()): Plugin {
	return { id, name, icon: "test", activate };
}

beforeEach(() => {
	for (const p of getPlugins()) {
		unregisterPlugin(p.id);
		setPluginEnabled(p.id, false);
	}
	deactivatePlugins();
	localStorage.clear();
	setPendingManifest(null);
});

describe("registerPlugin", () => {
	it("registers a plugin retrievable by getPlugin", () => {
		const p = makePlugin("alpha", "Alpha");
		registerPlugin(p);
		expect(getPlugin("alpha")).toBe(p);
	});

	it("merges pendingManifest fields over plugin", () => {
		setPendingManifest({
			id: "ext-1",
			name: "External Plugin",
			description: "From manifest",
			icon: "manifest-icon",
			main: "index.js",
			version: "1.0.0",
		});
		const activate = vi.fn();
		registerPlugin({ activate });
		const registered = getPlugin("ext-1");
		expect(registered).toBeDefined();
		expect(registered!.id).toBe("ext-1");
		expect(registered!.name).toBe("External Plugin");
		expect(registered!.description).toBe("From manifest");
		expect(registered!.icon).toBe("manifest-icon");
		expect(registered!.activate).toBe(activate);
	});

	it("clears pendingManifest after register", () => {
		setPendingManifest({
			id: "ext-1",
			name: "External",
			description: "",
			icon: "x",
			main: "index.js",
			version: "1.0.0",
		});
		registerPlugin({ activate: vi.fn() });

		const p = makePlugin("normal", "Normal");
		registerPlugin(p);
		expect(getPlugin("normal")).toBe(p);
		expect(getPlugin("normal")!.id).toBe("normal");
	});
});

describe("getPlugins", () => {
	it("returns plugins sorted by name", () => {
		registerPlugin(makePlugin("c", "Zebra"));
		registerPlugin(makePlugin("a", "Alpha"));
		registerPlugin(makePlugin("b", "Mid"));
		const names = getPlugins().map((p) => p.name);
		expect(names).toEqual(["Alpha", "Mid", "Zebra"]);
	});
});

describe("unregisterPlugin", () => {
	it("removes plugin from registry", () => {
		registerPlugin(makePlugin("rm", "Remove Me"));
		expect(getPlugin("rm")).toBeDefined();
		unregisterPlugin("rm");
		expect(getPlugin("rm")).toBeUndefined();
	});
});

describe("setPluginEnabled / isPluginEnabled", () => {
	it("enables a plugin", () => {
		registerPlugin(makePlugin("e", "E"));
		setPluginEnabled("e", true);
		expect(isPluginEnabled("e")).toBe(true);
	});

	it("disabling removes from enabled set", () => {
		registerPlugin(makePlugin("e", "E"));
		setPluginEnabled("e", true);
		setPluginEnabled("e", false);
		expect(isPluginEnabled("e")).toBe(false);
	});

	it("persists to localStorage", () => {
		registerPlugin(makePlugin("p", "Persist"));
		setPluginEnabled("p", true);
		const stored = JSON.parse(localStorage.getItem("mma_plugins_enabled") || "[]");
		expect(stored).toContain("p");
	});
});

describe("getEnabledPlugins", () => {
	it("returns only enabled and registered plugins", () => {
		const a = makePlugin("a", "A");
		const b = makePlugin("b", "B");
		const c = makePlugin("c", "C");
		registerPlugin(a);
		registerPlugin(b);
		registerPlugin(c);
		setPluginEnabled("a", true);
		setPluginEnabled("c", true);
		const enabled = getEnabledPlugins();
		const ids = enabled.map((p) => p.id);
		expect(ids).toContain("a");
		expect(ids).toContain("c");
		expect(ids).not.toContain("b");
	});
});

describe("activatePlugin", () => {
	it("calls activate and stores cleanup", () => {
		const cleanup = vi.fn();
		const activate = vi.fn(() => cleanup);
		registerPlugin(makePlugin("act", "Act", activate));
		activatePlugin("act");
		expect(activate).toHaveBeenCalledOnce();
		deactivatePlugin("act");
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it("is idempotent - second call does nothing", () => {
		const activate = vi.fn(() => vi.fn());
		registerPlugin(makePlugin("idem", "Idem", activate));
		activatePlugin("idem");
		activatePlugin("idem");
		expect(activate).toHaveBeenCalledOnce();
	});

	it("no-op for unregistered id", () => {
		expect(() => activatePlugin("nonexistent")).not.toThrow();
	});

	it("works when activate returns void", () => {
		const activate = vi.fn();
		registerPlugin(makePlugin("void", "Void", activate));
		activatePlugin("void");
		expect(activate).toHaveBeenCalledOnce();
		expect(() => deactivatePlugin("void")).not.toThrow();
	});
});

describe("deactivatePlugin", () => {
	it("calls cleanup function", () => {
		const cleanup = vi.fn();
		registerPlugin(makePlugin("d", "D", () => cleanup));
		activatePlugin("d");
		deactivatePlugin("d");
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it("no-op for non-active plugin", () => {
		registerPlugin(makePlugin("na", "NA"));
		expect(() => deactivatePlugin("na")).not.toThrow();
	});
});

describe("activatePlugins", () => {
	it("activates all enabled plugins", () => {
		const actA = vi.fn();
		const actB = vi.fn();
		const actC = vi.fn();
		registerPlugin(makePlugin("a", "A", actA));
		registerPlugin(makePlugin("b", "B", actB));
		registerPlugin(makePlugin("c", "C", actC));
		setPluginEnabled("a", true);
		setPluginEnabled("c", true);
		activatePlugins();
		expect(actA).toHaveBeenCalledOnce();
		expect(actB).not.toHaveBeenCalled();
		expect(actC).toHaveBeenCalledOnce();
	});
});

describe("deactivatePlugins", () => {
	it("calls all cleanups and clears", () => {
		const cleanupA = vi.fn();
		const cleanupB = vi.fn();
		registerPlugin(makePlugin("a", "A", () => cleanupA));
		registerPlugin(makePlugin("b", "B", () => cleanupB));
		activatePlugin("a");
		activatePlugin("b");
		deactivatePlugins();
		expect(cleanupA).toHaveBeenCalledOnce();
		expect(cleanupB).toHaveBeenCalledOnce();
		deactivatePlugin("a");
		expect(cleanupA).toHaveBeenCalledOnce();
	});
});

describe("plugins:changed event", () => {
	it("fires on register, unregister, and enable/disable", () => {
		let count = 0;
		const unsub = subscribe("plugins:changed", () => count++);

		registerPlugin(makePlugin("s", "S"));
		expect(count).toBe(1);

		unregisterPlugin("s");
		expect(count).toBe(2);

		registerPlugin(makePlugin("s2", "S2"));
		expect(count).toBe(3);

		setPluginEnabled("s2", true);
		expect(count).toBe(4);

		setPluginEnabled("s2", false);
		expect(count).toBe(5);

		unsub();
	});
});

describe("isPluginCompatible", () => {
	it("no declared minimum is always compatible", () => {
		expect(isPluginCompatible(undefined, "0.8.1")).toBe(true);
	});

	it("app at or above the minimum is compatible", () => {
		expect(isPluginCompatible("0.8.1", "0.8.1")).toBe(true);
		expect(isPluginCompatible("0.8.1", "0.9.0")).toBe(true);
		expect(isPluginCompatible("0.8.1", "1.0.0")).toBe(true);
	});

	it("app below the minimum is incompatible", () => {
		expect(isPluginCompatible("0.8.1", "0.8.0")).toBe(false);
		expect(isPluginCompatible("1.0.0", "0.9.9")).toBe(false);
	});

	it("missing components compare as zero", () => {
		expect(isPluginCompatible("0.8", "0.8.0")).toBe(true);
		expect(isPluginCompatible("0.8.0.1", "0.8.0")).toBe(false);
	});
});

describe("plugin deactivation tears down enrichment registrations", () => {
	it("removes provider, enrich field, and field def on deactivate (no plugin cleanup needed)", () => {
		const sfx = Math.random().toString(36).slice(2);
		const pid = "enrich-plugin-" + sfx;
		const provId = "prov-" + sfx;
		const fieldKey = "wx_" + sfx;

		// activate() returns nothing — teardown must still happen via the registry.
		registerPlugin(
			makePlugin(pid, "Enrich " + sfx, () => {
				registerEnrichFields([{ key: fieldKey, label: "WX", defaultOff: true }]);
				registerProvider({
					id: provId,
					procedure: { entry: "res://procedures/test.js", batch: { mode: "perRow" } },
					fieldDefs: { [fieldKey]: { type: "number" as const, label: "WX" } },
				});
			}),
		);
		setPluginEnabled(pid, true);
		activatePlugin(pid);

		expect(getProviders().some((p) => p.id === provId)).toBe(true);
		expect(getEnrichFieldOptions().some((o) => o.key === fieldKey)).toBe(true);
		expect(getFieldDef(fieldKey)).toBeDefined();

		deactivatePlugin(pid);

		expect(getProviders().some((p) => p.id === provId)).toBe(false);
		expect(getEnrichFieldOptions().some((o) => o.key === fieldKey)).toBe(false);
		expect(getFieldDef(fieldKey)).toBeUndefined();
	});
});

describe("isBackgroundPlugin", () => {
	it("is true only for a loaded plugin with no UI surface", () => {
		registerPlugin(makePlugin("bg", "Background"));
		registerPlugin({ ...makePlugin("side", "Sidebar"), sidebar: () => null });
		registerPlugin({ ...makePlugin("modal", "Modal"), modal: () => null });
		registerPlugin({ ...makePlugin("panel", "Panel"), locationPanel: () => null });

		expect(isBackgroundPlugin("bg")).toBe(true);
		expect(isBackgroundPlugin("side")).toBe(false);
		expect(isBackgroundPlugin("modal")).toBe(false);
		expect(isBackgroundPlugin("panel")).toBe(false);
		expect(isBackgroundPlugin("not-loaded")).toBe(false);
	});
});
