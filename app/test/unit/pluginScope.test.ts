import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { runAsPlugin, trackDisposable, disposePlugin } from "@/plugins/scope";

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
