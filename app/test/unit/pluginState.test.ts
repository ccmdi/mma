// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { createElement, act } from "react";
import { mount as mountRoot } from "./fixtures/harness";
import { pluginSetting, usePluginState, storage, reloadStorage } from "@/plugins/pluginStorage";

type AnyResult = readonly [unknown, (v: unknown) => void];

let result: AnyResult;
function Probe({ pid, k, init }: { pid: string; k: string; init: unknown }) {
	// eslint-disable-next-line react-hooks/globals -- renderHook-style probe
	result = usePluginState(pid, k, init);
	return null;
}

function mount(pid: string, k: string, init: unknown): AnyResult {
	mountRoot(createElement(Probe, { pid, k, init }), { attach: false });
	return result;
}

beforeEach(() => {
	localStorage.clear();
	reloadStorage("p1");
	reloadStorage("a");
	reloadStorage("b");
	reloadStorage("untouched");
});

describe("usePluginState", () => {
	it("returns the initial value when nothing is stored", () => {
		const [value] = mount("p1", "k", "default");
		expect(value).toBe("default");
	});

	it("uses the initializer when the persisted blob is corrupt", () => {
		localStorage.setItem("mma_plugin:p1", "{not json");
		reloadStorage("p1");
		const [value] = mount("p1", "k", () => 42);
		expect(value).toBe(42);
	});

	it("supports a lazy initializer", () => {
		const [value] = mount("p1", "k", () => 42);
		expect(value).toBe(42);
	});

	it("set updates state and persists", () => {
		mount("p1", "k", "a");
		act(() => result[1]("b"));
		expect(result[0]).toBe("b");
		expect(storage("p1").get("k")).toBe("b");
	});

	it("state survives unmount and remount", () => {
		const first = mountRoot(createElement(Probe, { pid: "p1", k: "k", init: "default" }), {
			attach: false,
		});
		act(() => result[1]("chosen"));
		first.unmount();

		const [value] = mount("p1", "k", "default");
		expect(value).toBe("chosen");
	});

	it("supports functional updates", () => {
		mount("p1", "n", 1);
		act(() => result[1]((prev: number) => prev + 1));
		expect(result[0]).toBe(2);
		expect(storage("p1").get("n")).toBe(2);
	});

	it("namespaces by plugin id and key", () => {
		mount("a", "k", "x");
		act(() => result[1]("from-a"));
		mount("b", "k", "x");
		expect(result[0]).toBe("x");
		expect(storage("a").get("k")).toBe("from-a");
	});

	it("shares the store with storage", () => {
		storage("p1").set("k", "pre-seeded");
		const [value] = mount("p1", "k", "default");
		expect(value).toBe("pre-seeded");
	});

	it("does not write to storage until set is called", () => {
		mount("untouched", "k", "default");
		expect(storage("untouched").keys()).not.toContain("k");
	});
});

describe("pluginSetting", () => {
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

	it("re-renders every reader on a write from anywhere", () => {
		mount("p1", "k", "a");
		act(() => pluginSetting("p1", "k", "a").set("b"));
		expect(result[0]).toBe("b");
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
