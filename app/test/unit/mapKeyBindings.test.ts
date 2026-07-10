// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import {
	matchMapKeyBinding,
	executeMapKeyAction,
	registerMapKeyActionHandler,
	handleMapKeyEvent,
	getTagBindingKey,
	withTagKeyBinding,
	getMapCopyBindingKey,
	withMapCopyBinding,
} from "@/lib/map/mapKeyBindings";
import { isEditableElement } from "@/lib/hooks/useHotkey";
import type { MapKeyBinding } from "@/bindings.gen";

function keyEvent(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
	return new KeyboardEvent("keydown", { key, cancelable: true, ...init });
}

const applyTag = (tagId: number): MapKeyBinding["action"] => ({ type: "applyTag", tagId });

describe("matchMapKeyBinding", () => {
	const bindings: MapKeyBinding[] = [
		{ key: "m", action: applyTag(1) },
		{ key: "Mod+Shift+x", action: applyTag(2) },
		{ key: "", action: applyTag(3) },
	];

	it("matches a plain key", () => {
		expect(matchMapKeyBinding(keyEvent("m"), bindings)?.action).toEqual(applyTag(1));
	});

	it("matches a modifier combo", () => {
		const e = keyEvent("x", { ctrlKey: true, shiftKey: true });
		expect(matchMapKeyBinding(e, bindings)?.action).toEqual(applyTag(2));
	});

	it("does not match when modifiers differ", () => {
		expect(matchMapKeyBinding(keyEvent("m", { ctrlKey: true }), bindings)).toBeUndefined();
		expect(matchMapKeyBinding(keyEvent("x"), bindings)).toBeUndefined();
	});

	it("ignores empty-key bindings", () => {
		expect(matchMapKeyBinding(keyEvent(""), bindings)).toBeUndefined();
	});
});

describe("action handler registry", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()!();
	});

	it("executes a registered handler and reports consumption", () => {
		const seen: number[] = [];
		cleanups.push(registerMapKeyActionHandler("applyTag", (a) => seen.push(a.tagId)));
		expect(executeMapKeyAction(applyTag(7))).toBe(true);
		expect(seen).toEqual([7]);
	});

	it("returns false when no handler is registered", () => {
		expect(executeMapKeyAction(applyTag(7))).toBe(false);
	});

	it("unregister removes the handler", () => {
		const unregister = registerMapKeyActionHandler("applyTag", () => {});
		unregister();
		expect(executeMapKeyAction(applyTag(1))).toBe(false);
	});

	it("a handler returning false declines the action (key falls through)", () => {
		cleanups.push(registerMapKeyActionHandler("applyTag", () => false));
		expect(executeMapKeyAction(applyTag(1))).toBe(false);
		const e = keyEvent("m");
		expect(handleMapKeyEvent(e, [{ key: "m", action: applyTag(1) }])).toBe(false);
		expect(e.defaultPrevented).toBe(false);
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
		expect(next.filter((b) => b.action.tagId === 1)).toHaveLength(1);
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

describe("handleMapKeyEvent", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()!();
	});
	const bindings: MapKeyBinding[] = [{ key: "m", action: applyTag(1) }];

	it("consumes the event when a handler exists", () => {
		cleanups.push(registerMapKeyActionHandler("applyTag", () => {}));
		const e = keyEvent("m");
		expect(handleMapKeyEvent(e, bindings)).toBe(true);
		expect(e.defaultPrevented).toBe(true);
	});

	it("falls through (no preventDefault) when no handler is registered", () => {
		const e = keyEvent("m");
		expect(handleMapKeyEvent(e, bindings)).toBe(false);
		expect(e.defaultPrevented).toBe(false);
	});

	it("ignores repeats and already-handled events", () => {
		cleanups.push(registerMapKeyActionHandler("applyTag", () => {}));
		expect(handleMapKeyEvent(keyEvent("m", { repeat: true }), bindings)).toBe(false);
		const handled = keyEvent("m");
		handled.preventDefault();
		expect(handleMapKeyEvent(handled, bindings)).toBe(false);
	});

	it("ignores keys typed into editable elements", () => {
		cleanups.push(registerMapKeyActionHandler("applyTag", () => {}));
		const input = document.createElement("input");
		document.body.appendChild(input);
		expect(isEditableElement(input)).toBe(true);
		const e = keyEvent("m");
		Object.defineProperty(e, "target", { value: input });
		expect(handleMapKeyEvent(e, bindings)).toBe(false);
		input.remove();
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
		const unregister = registerMapKeyActionHandler("applyTag", () => order.push("map"));
		const mapHandler = (e: KeyboardEvent) => {
			handleMapKeyEvent(e, [{ key: "m", action: applyTag(1) }]);
		};
		window.addEventListener("keydown", mapHandler, true);

		document.body.dispatchEvent(
			new KeyboardEvent("keydown", { key: "m", cancelable: true, bubbles: true }),
		);

		document.removeEventListener("keydown", globalHandler, true);
		window.removeEventListener("keydown", mapHandler, true);
		unregister();
		expect(order).toEqual(["map"]);
	});
});
