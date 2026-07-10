// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePluginState, createPluginStorage } from "@/plugins/registry";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type AnyResult = readonly [unknown, (v: unknown) => void];

let result: AnyResult;
function Probe({ pid, k, init }: { pid: string; k: string; init: unknown }) {
	// eslint-disable-next-line react-hooks/globals -- renderHook-style probe
	result = usePluginState(pid, k, init);
	return null;
}

const roots: Root[] = [];
function mount(pid: string, k: string, init: unknown): AnyResult {
	const root = createRoot(document.createElement("div"));
	act(() => root.render(createElement(Probe, { pid, k, init })));
	roots.push(root);
	return result;
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount());
});

describe("usePluginState", () => {
	it("returns the initial value when nothing is stored", () => {
		const [value] = mount("p1", "k", "default");
		expect(value).toBe("default");
	});

	it("supports a lazy initializer", () => {
		const [value] = mount("p1", "k", () => 42);
		expect(value).toBe(42);
	});

	it("set updates state and persists", () => {
		mount("p1", "k", "a");
		act(() => result[1]("b"));
		expect(result[0]).toBe("b");
		expect(createPluginStorage("p1").get("k")).toBe("b");
	});

	it("state survives unmount and remount", () => {
		const root = createRoot(document.createElement("div"));
		act(() => root.render(createElement(Probe, { pid: "p1", k: "k", init: "default" })));
		act(() => result[1]("chosen"));
		act(() => root.unmount());

		const [value] = mount("p1", "k", "default");
		expect(value).toBe("chosen");
	});

	it("supports functional updates", () => {
		mount("p1", "n", 1);
		act(() => result[1]((prev: number) => prev + 1));
		expect(result[0]).toBe(2);
		expect(createPluginStorage("p1").get("n")).toBe(2);
	});

	it("namespaces by plugin id and key", () => {
		mount("a", "k", "x");
		act(() => result[1]("from-a"));
		mount("b", "k", "x");
		expect(result[0]).toBe("x");
		expect(createPluginStorage("a").get("k")).toBe("from-a");
	});

	it("shares the store with createPluginStorage", () => {
		createPluginStorage("p1").set("k", "pre-seeded");
		const [value] = mount("p1", "k", "default");
		expect(value).toBe("pre-seeded");
	});

	it("does not write to storage until set is called", () => {
		mount("p1", "k", "default");
		expect(createPluginStorage("p1").keys()).not.toContain("k");
	});
});
