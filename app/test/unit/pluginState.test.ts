// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { createElement, act } from "react";
import { mount as mountRoot } from "./fixtures/harness";
import { usePluginState, createPluginStorage } from "@/plugins/registry";

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
		mount("untouched", "k", "default");
		expect(createPluginStorage("untouched").keys()).not.toContain("k");
	});
});
