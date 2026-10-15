// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { createElement } from "react";
import { mount } from "./fixtures/harness";
import {
	registerMapKeyActionHandler,
	useMapKeyBindings,
	getTagBindingKey,
	withTagKeyBinding,
	getMapCopyBindingKey,
	withMapCopyBinding,
	mergedKeyBindings,
} from "@/lib/map/mapKeyBindings";
import type { MapKeyAction, MapKeyBinding } from "@/bindings.gen";

const applyTag = (tagId: number): MapKeyBinding["action"] => ({ type: "applyTag", tagId });

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()!();
});

function mountBindings(bindings: MapKeyBinding[]) {
	function Probe() {
		useMapKeyBindings(() => bindings);
		return null;
	}
	mount(createElement(Probe));
}

function handleApplyTag(result: boolean | void = undefined): MapKeyAction[] {
	const seen: MapKeyAction[] = [];
	cleanups.push(
		registerMapKeyActionHandler("applyTag", (a) => {
			seen.push(a);
			return result;
		}),
	);
	return seen;
}

function press(key: string, init: KeyboardEventInit = {}, target: Element = document.body) {
	const e = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...init });
	target.dispatchEvent(e);
	return e;
}

describe("matching a key to a binding", () => {
	const bindings: MapKeyBinding[] = [
		{ key: "m", action: applyTag(1) },
		{ key: "Mod+Shift+x", action: applyTag(2) },
		{ key: "", action: applyTag(3) },
	];

	it("matches a plain key", () => {
		const seen = handleApplyTag();
		mountBindings(bindings);
		press("m");
		expect(seen).toEqual([applyTag(1)]);
	});

	it("matches a modifier combo", () => {
		const seen = handleApplyTag();
		mountBindings(bindings);
		press("x", { ctrlKey: true, shiftKey: true });
		expect(seen).toEqual([applyTag(2)]);
	});

	it("does not match when modifiers differ", () => {
		const seen = handleApplyTag();
		mountBindings(bindings);
		press("m", { ctrlKey: true });
		press("x");
		expect(seen).toEqual([]);
	});

	it("ignores empty-key bindings", () => {
		const seen = handleApplyTag();
		mountBindings(bindings);
		press("");
		expect(seen).toEqual([]);
	});
});

describe("action handler registry", () => {
	const bindings: MapKeyBinding[] = [{ key: "m", action: applyTag(1) }];

	it("runs the registered handler and consumes the key", () => {
		const seen = handleApplyTag();
		mountBindings([{ key: "m", action: applyTag(7) }]);
		expect(press("m").defaultPrevented).toBe(true);
		expect(seen).toEqual([applyTag(7)]);
	});

	it("falls through when no handler is registered", () => {
		mountBindings(bindings);
		expect(press("m").defaultPrevented).toBe(false);
	});

	it("unregister removes the handler", () => {
		const unregister = registerMapKeyActionHandler("applyTag", () => {});
		unregister();
		mountBindings(bindings);
		expect(press("m").defaultPrevented).toBe(false);
	});

	it("a handler returning false declines the action (key falls through)", () => {
		const seen = handleApplyTag(false);
		mountBindings(bindings);
		expect(press("m").defaultPrevented).toBe(false);
		expect(seen).toEqual([applyTag(1)]);
	});
});

describe("tag binding helpers", () => {
	const base: MapKeyBinding[] = [
		{ key: "m", action: applyTag(1) },
		{ key: "x", action: applyTag(2) },
	];

	it("getTagBindingKey finds the tag's combo", () => {
		expect(getTagBindingKey(base, 1)).toBe("m");
		expect(getTagBindingKey(base, 99)).toBeUndefined();
	});

	it("assigns a new key", () => {
		const next = withTagKeyBinding(base, 3, "q");
		expect(getTagBindingKey(next, 3)).toBe("q");
		expect(next).toHaveLength(3);
	});

	it("a key is unique: assigning steals it from its previous holder", () => {
		const next = withTagKeyBinding(base, 3, "m");
		expect(getTagBindingKey(next, 3)).toBe("m");
		expect(getTagBindingKey(next, 1)).toBeUndefined();
	});

	it("a tag holds one key: reassigning drops its previous key", () => {
		const next = withTagKeyBinding(base, 1, "z");
		expect(getTagBindingKey(next, 1)).toBe("z");
		expect(next.filter((b) => b.action.type === "applyTag" && b.action.tagId === 1)).toHaveLength(
			1,
		);
	});

	it("empty key clears the tag's binding", () => {
		const next = withTagKeyBinding(base, 1, "");
		expect(getTagBindingKey(next, 1)).toBeUndefined();
		expect(next).toHaveLength(1);
		expect(withTagKeyBinding(base, 99, "")).toHaveLength(2);
	});
});

describe("map copy binding helpers", () => {
	it("assigns, reads back, and clears a copy binding", () => {
		let bindings = withMapCopyBinding([], "map-b", "m");
		expect(getMapCopyBindingKey(bindings, "map-b")).toBe("m");
		bindings = withMapCopyBinding(bindings, "map-b", "");
		expect(getMapCopyBindingKey(bindings, "map-b")).toBeUndefined();
		expect(bindings).toHaveLength(0);
	});

	it("key uniqueness spans action kinds: copy binding steals a tag's key", () => {
		const withTag = withTagKeyBinding([], 1, "m");
		const next = withMapCopyBinding(withTag, "map-b", "m");
		expect(getMapCopyBindingKey(next, "map-b")).toBe("m");
		expect(getTagBindingKey(next, 1)).toBeUndefined();
	});

	it("does not confuse targets across kinds", () => {
		const both = withMapCopyBinding(withTagKeyBinding([], 1, "a"), "map-b", "b");
		expect(getTagBindingKey(both, 1)).toBe("a");
		expect(getMapCopyBindingKey(both, "map-b")).toBe("b");
	});
});

describe("when the map layer stands aside", () => {
	const bindings: MapKeyBinding[] = [{ key: "m", action: applyTag(1) }];

	it("yields while a plugin overlay owns input", () => {
		const seen = handleApplyTag();
		mountBindings(bindings);
		const overlay = document.createElement("div");
		overlay.setAttribute("data-plugin-overlay", "");
		document.body.appendChild(overlay);
		cleanups.push(() => overlay.remove());
		expect(press("m").defaultPrevented).toBe(false);
		expect(seen).toEqual([]);
	});

	it("ignores repeats", () => {
		const seen = handleApplyTag();
		mountBindings(bindings);
		press("m", { repeat: true });
		expect(seen).toEqual([]);
	});

	it("ignores already-handled events", () => {
		const seen = handleApplyTag();
		const preventFirst = (e: KeyboardEvent) => e.preventDefault();
		window.addEventListener("keydown", preventFirst, true);
		cleanups.push(() => window.removeEventListener("keydown", preventFirst, true));
		mountBindings(bindings);
		press("m");
		expect(seen).toEqual([]);
	});

	it("ignores keys typed into editable elements", () => {
		const seen = handleApplyTag();
		mountBindings(bindings);
		const input = document.createElement("input");
		document.body.appendChild(input);
		cleanups.push(() => input.remove());
		press("m", {}, input);
		expect(seen).toEqual([]);
	});
});

// Invariant: per-map bindings (window capture) win over global hotkeys
// (document capture) regardless of listener registration order, because the
// capture phase propagates window -> document. Global handlers skip events
// that are already defaultPrevented.
describe("precedence over global hotkey layer", () => {
	it("window-capture map binding preempts a document-capture global handler", () => {
		const order: string[] = [];
		const globalHandler = (e: KeyboardEvent) => {
			if (e.defaultPrevented) return;
			order.push("global");
		};
		// Register the global (document, capture) handler FIRST to prove order independence.
		document.addEventListener("keydown", globalHandler, true);
		cleanups.push(() => document.removeEventListener("keydown", globalHandler, true));
		cleanups.push(
			registerMapKeyActionHandler("applyTag", () => {
				order.push("map");
			}),
		);
		mountBindings([{ key: "m", action: applyTag(1) }]);
		press("m");
		expect(order).toEqual(["map"]);
	});
});

describe("mergedKeyBindings", () => {
	const copyTo = (key: string, mapId: string): MapKeyBinding => ({
		key,
		action: { type: "copyToMap", mapId },
	});

	it("appends global copy bindings after the map's own", () => {
		const merged = mergedKeyBindings(
			[{ key: "q", action: applyTag(1) }],
			[copyTo("w", "other")],
			"current",
		);
		expect(merged.map((b) => b.key)).toEqual(["q", "w"]);
	});

	it("drops a global binding targeting the open map itself", () => {
		expect(mergedKeyBindings([], [copyTo("w", "current")], "current")).toEqual([]);
	});

	it("a map binding shadows a same-key global at match time", () => {
		const merged = mergedKeyBindings(
			[{ key: "w", action: applyTag(7) }],
			[copyTo("w", "other")],
			"current",
		);
		const seen = handleApplyTag();
		mountBindings(merged);
		press("w");
		expect(seen).toEqual([applyTag(7)]);
	});

	it("returns the map bindings untouched when no global applies", () => {
		const mapBindings = [{ key: "q", action: applyTag(1) }];
		expect(mergedKeyBindings(mapBindings, [copyTo("w", "current")], "current")).toBe(mapBindings);
	});
});
