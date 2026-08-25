// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Pins the cross-window event bridge (issue #145): a bridged event broadcast by one
// window rehydrates and re-emits in every other window, without echoing back.

const h = vi.hoisted(() => ({
	tauriEmits: [] as { event: string; payload: unknown }[],
	listeners: new Map<string, (e: { payload: unknown }) => void>(),
	calls: [] as string[],
}));

vi.mock("@tauri-apps/api/event", () => ({
	emit: async (event: string, payload?: unknown) => {
		h.tauriEmits.push({ event, payload });
	},
	listen: async (event: string, cb: (e: { payload: unknown }) => void) => {
		h.listeners.set(event, cb);
		return () => {};
	},
}));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ label: "map-1" }),
}));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { emit, subscribe, bridgeAcrossWindows } from "@/lib/events";

bridgeAcrossWindows("settings:changed", () => h.calls.push("rehydrate"));

/** A foreign window's broadcast of `event`, delivered through the tauri listener. */
function receiveRemote(event: string, fromLabel: string) {
	h.listeners.get(`xwin:${event}`)!({ payload: fromLabel });
}

beforeEach(() => {
	h.tauriEmits.length = 0;
	h.calls.length = 0;
});

describe("bridgeAcrossWindows", () => {
	it("broadcasts local emits of a bridged event with the window label", () => {
		emit("settings:changed");
		expect(h.tauriEmits).toEqual([{ event: "xwin:settings:changed", payload: "map-1" }]);
	});

	it("does not broadcast unbridged events", () => {
		emit("toasts:changed");
		expect(h.tauriEmits).toEqual([]);
	});

	it("rehydrates before local handlers see a foreign broadcast", () => {
		const unsub = subscribe("settings:changed", () => h.calls.push("handler"));
		receiveRemote("settings:changed", "main");
		unsub();
		expect(h.calls).toEqual(["rehydrate", "handler"]);
	});

	it("a foreign broadcast does not echo back out", () => {
		receiveRemote("settings:changed", "main");
		expect(h.tauriEmits).toEqual([]);
	});

	it("ignores its own broadcast", () => {
		receiveRemote("settings:changed", "map-1");
		expect(h.calls).toEqual([]);
	});
});
