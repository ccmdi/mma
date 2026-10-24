// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { mount as mountRoot } from "./fixtures/harness";
import { Store } from "@/store/store";
import { Autosave } from "@/store/autosave";
import type { MapMeta } from "@/bindings.gen";
import { pluginSetting, storage, reloadStorage, type PluginSetting } from "@/plugins/pluginStorage";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/store/maps", () => ({
	Maps: { setList: vi.fn(), invalidate: vi.fn(async () => {}), reload: vi.fn(async () => {}) },
}));
vi.mock("@/lib/commands", () => ({
	cmd: {
		storeUpdateMapMeta: vi.fn(async (patch: unknown) =>
			(await import("./fixtures/mocks")).metadataWritten(patch),
		),
		storeSaveDirty: vi.fn(async () => null),
	},
}));

let result: readonly [unknown, (v: unknown) => void];
function Probe({ setting }: { setting: PluginSetting<unknown> }) {
	// eslint-disable-next-line react-hooks/globals -- renderHook-style probe
	result = setting.use();
	return null;
}

function mount<T>(setting: PluginSetting<T>) {
	const probed = setting as unknown as PluginSetting<unknown>;
	return mountRoot(createElement(Probe, { setting: probed }), { attach: false });
}

function openMap(id: string, settings: MapMeta["settings"] = {}) {
	Store.patch({ mapId: id, map: { id, settings } as MapMeta });
}

beforeEach(() => {
	localStorage.clear();
	for (const id of ["p1", "a", "b", "untouched"]) reloadStorage(id);
});

afterEach(async () => {
	await Autosave.flush();
	Store.patch({ mapId: null, map: null });
});

describe("pluginSetting", () => {
	it("reads its fallback while nothing is stored", () => {
		mount(pluginSetting("p1", "k", "default"));
		expect(result[0]).toBe("default");
	});

	it("reads its fallback when the persisted blob is corrupt", () => {
		localStorage.setItem("mma_plugin:p1", "{not json");
		reloadStorage("p1");
		expect(pluginSetting("p1", "k", 42).get()).toBe(42);
	});

	it("reads a stored value of another type than its fallback as the fallback", () => {
		storage("p1").set("n", "seven");
		storage("p1").set("list", { 0: 1 });
		expect(pluginSetting("p1", "n", 3).get()).toBe(3);
		expect(pluginSetting("p1", "list", [1, 2]).get()).toEqual([1, 2]);
	});

	it("takes any stored value when its fallback is null", () => {
		storage("p1").set("k", { pick: "all" });
		expect(pluginSetting<{ pick: string } | null>("p1", "k", null).get()).toEqual({ pick: "all" });
	});

	it("reads a value written through the plugin's storage", () => {
		storage("p1").set("k", "pre-seeded");
		mount(pluginSetting("p1", "k", "default"));
		expect(result[0]).toBe("pre-seeded");
	});

	it("persists a write and re-renders every reader on a write from anywhere", () => {
		mount(pluginSetting("p1", "k", "a"));
		act(() => result[1]("b"));
		expect(result[0]).toBe("b");
		act(() => pluginSetting("p1", "k", "a").set("c"));
		expect(result[0]).toBe("c");
		expect(storage("p1").get("k")).toBe("c");
	});

	it("keeps its value across unmount and remount", () => {
		const first = mount(pluginSetting("p1", "k", "default"));
		act(() => result[1]("chosen"));
		first.unmount();
		mount(pluginSetting("p1", "k", "default"));
		expect(result[0]).toBe("chosen");
	});

	it("namespaces by plugin id and key, and writes nothing until set", () => {
		pluginSetting("a", "k", "x").set("from-a");
		expect(pluginSetting("b", "k", "x").get()).toBe("x");
		mount(pluginSetting("untouched", "k", "default"));
		expect(storage("untouched").keys()).not.toContain("k");
	});

	it("tells a listener about its own key's changes only", () => {
		const seen: number[] = [];
		const off = pluginSetting("p1", "n", 0).on((v) => seen.push(v));
		storage("p1").set("other", "x");
		pluginSetting("p1", "n", 0).set(4);
		off();
		pluginSetting("p1", "n", 0).set(5);
		expect(seen).toEqual([4]);
	});
});

describe("pluginSetting per map", () => {
	const ownData = () => Store.get().map?.settings.pluginData?.p1;

	it("reads the shared value until the map saves its own", () => {
		storage("p1").set("k", "shared");
		openMap("a");
		expect(pluginSetting("p1", "k", "fallback").perMap().get()).toBe("shared");
		expect(pluginSetting("p1", "other", "fallback").perMap().get()).toBe("fallback");
	});

	it("reads a value the map already saved under the plugin's map storage", () => {
		storage("p1").set("k", "shared");
		openMap("a", { pluginData: { p1: { k: "mine" } } });
		expect(pluginSetting("p1", "k", "fallback").perMap().get()).toBe("mine");
	});

	it("saves with the map and leaves the shared value alone", async () => {
		storage("p1").set("k", "shared");
		openMap("a");
		const setting = pluginSetting("p1", "k", "fallback").perMap();
		mount(setting);
		setting.set("mine");
		await vi.waitFor(() => expect(ownData()).toEqual({ k: "mine" }));
		expect(result[0]).toBe("mine");
		expect(storage("p1").get("k")).toBe("shared");
	});

	it("follows the open map", () => {
		openMap("a", { pluginData: { p1: { k: "a's" } } });
		const seen: string[] = [];
		const off = pluginSetting("p1", "k", "fallback")
			.perMap()
			.on((v) => seen.push(v));
		openMap("b", { pluginData: { p1: { k: "b's" } } });
		openMap("c");
		off();
		expect(seen).toEqual(["b's", "fallback"]);
	});
});
