// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act, createElement } from "react";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { runAsPlugin, trackDisposable, disposePlugin } from "@/plugins/scope";
import { on, definePluginEvent, emitPluginEvent, usePluginEvent } from "@/plugins/pluginEvents";
import { mount } from "./fixtures/harness";

describe("plugin scope (ownership + disposables)", () => {
	it("disposes an owner's tracked callbacks in reverse order", () => {
		const order: number[] = [];
		runAsPlugin("p1", () => {
			trackDisposable(() => order.push(1));
			trackDisposable(() => order.push(2));
		});
		disposePlugin("p1");
		expect(order).toEqual([2, 1]);
	});

	it("scopes disposables per owner", () => {
		const a = vi.fn();
		const b = vi.fn();
		runAsPlugin("a", () => trackDisposable(a));
		runAsPlugin("b", () => trackDisposable(b));
		disposePlugin("a");
		expect(a).toHaveBeenCalledOnce();
		expect(b).not.toHaveBeenCalled();
	});

	it("ignores trackDisposable outside an activation window", () => {
		const fn = vi.fn();
		trackDisposable(fn);
		disposePlugin("nobody");
		expect(fn).not.toHaveBeenCalled();
	});

	it("disposePlugin is idempotent and clears the store", () => {
		const fn = vi.fn();
		runAsPlugin("x", () => trackDisposable(fn));
		disposePlugin("x");
		disposePlugin("x");
		expect(fn).toHaveBeenCalledOnce();
	});

	it("one failing teardown doesn't block the others", () => {
		const ok = vi.fn();
		runAsPlugin("e", () => {
			trackDisposable(() => {
				throw new Error("boom");
			});
			trackDisposable(ok);
		});
		expect(() => disposePlugin("e")).not.toThrow();
		expect(ok).toHaveBeenCalledOnce();
	});
});

describe("plugin events", () => {
	const changed = definePluginEvent("p", "changed");

	it("are named for the plugin that defines them", () => {
		expect(String(changed)).toBe("plugin:p:changed");
	});

	it("reach the plugin's own listeners until it deactivates", () => {
		const heard = vi.fn();
		runAsPlugin("p", () => on(changed, heard));

		emitPluginEvent(changed);
		emitPluginEvent(definePluginEvent("other", "changed"));
		expect(heard).toHaveBeenCalledOnce();

		disposePlugin("p");
		emitPluginEvent(changed);
		expect(heard).toHaveBeenCalledOnce();
	});

	it("hand their payload to listeners", () => {
		const counted = definePluginEvent<number>("p", "counted");
		const heard: number[] = [];
		const off = on(counted, (n) => {
			heard.push(n);
		});

		emitPluginEvent(counted, 7);
		off();
		expect(heard).toEqual([7]);
		// @ts-expect-error an event that carries a payload is raised with one
		emitPluginEvent(counted);
	});

	it("usePluginEvent reads again each time the event is raised", () => {
		let value = 1;
		function Probe() {
			return createElement(
				"output",
				null,
				usePluginEvent(changed, () => value),
			);
		}
		const m = mount(createElement(Probe));
		expect(m.container.textContent).toBe("1");

		value = 2;
		act(() => emitPluginEvent(changed));
		expect(m.container.textContent).toBe("2");
	});
});
