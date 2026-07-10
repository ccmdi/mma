// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { parseHotkey, matchesKey, buildComboString } from "@/lib/hooks/useHotkey";
import {
	getAltSlowConflict,
	getConflicts,
	getBinding,
	setBinding,
	reassignBinding,
	resetAllBindings,
} from "@/lib/util/hotkeys";

describe("parseHotkey", () => {
	it("parses single key", () => {
		const result = parseHotkey("a");
		expect(result).toHaveLength(1);
		expect(result[0]).toHaveLength(1);
		expect(result[0][0].key).toBe("a");
		expect(result[0][0].ctrl).toBe(false);
	});

	it("parses modifier+key", () => {
		const result = parseHotkey("Ctrl+s");
		expect(result[0][0].ctrl).toBe(true);
		expect(result[0][0].key).toBe("s");
	});

	it("parses shift+key", () => {
		const result = parseHotkey("Shift+ArrowUp");
		expect(result[0][0].shift).toBe(true);
		expect(result[0][0].key).toBe("arrowup");
	});

	it("parses alt+key", () => {
		const result = parseHotkey("Alt+f");
		expect(result[0][0].alt).toBe(true);
		expect(result[0][0].key).toBe("f");
	});

	it("parses comma-separated alternatives", () => {
		const result = parseHotkey("a, b");
		expect(result).toHaveLength(2);
		expect(result[0][0].key).toBe("a");
		expect(result[1][0].key).toBe("b");
	});

	it("parses chord (space-separated)", () => {
		const result = parseHotkey("Ctrl+k Ctrl+s");
		expect(result).toHaveLength(1);
		expect(result[0]).toHaveLength(2);
		expect(result[0][0].key).toBe("k");
		expect(result[0][1].key).toBe("s");
	});

	it("parses plus key literally", () => {
		const result = parseHotkey("+");
		expect(result[0][0].key).toBe("+");
		expect(result[0][0].ctrl).toBe(false);
	});

	it("parses 'plus' as + key", () => {
		const result = parseHotkey("Ctrl+plus");
		expect(result[0][0].ctrl).toBe(true);
		expect(result[0][0].key).toBe("+");
	});
});

describe("matchesKey", () => {
	function mockEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
		return {
			key: "a",
			ctrlKey: false,
			altKey: false,
			metaKey: false,
			shiftKey: false,
			...overrides,
		} as KeyboardEvent;
	}

	it("matches simple key", () => {
		const [combo] = parseHotkey("a")[0];
		expect(matchesKey(mockEvent({ key: "a" }), combo)).toBe(true);
		expect(matchesKey(mockEvent({ key: "b" }), combo)).toBe(false);
	});

	it("matches with ctrl modifier", () => {
		const [combo] = parseHotkey("Ctrl+s")[0];
		expect(matchesKey(mockEvent({ key: "s", ctrlKey: true }), combo)).toBe(true);
		expect(matchesKey(mockEvent({ key: "s", ctrlKey: false }), combo)).toBe(false);
	});

	it("rejects extra modifiers", () => {
		const [combo] = parseHotkey("a")[0];
		expect(matchesKey(mockEvent({ key: "a", ctrlKey: true }), combo)).toBe(false);
	});

	it("case insensitive on key", () => {
		const [combo] = parseHotkey("a")[0];
		expect(matchesKey(mockEvent({ key: "A" }), combo)).toBe(true);
	});

	it("space key as 'space'", () => {
		const [combo] = parseHotkey("space")[0];
		expect(matchesKey(mockEvent({ key: " " }), combo)).toBe(true);
	});

	it("shifted chars imply shift", () => {
		const [combo] = parseHotkey("?")[0];
		expect(matchesKey(mockEvent({ key: "?", shiftKey: true }), combo)).toBe(true);
	});

	// Shift+digit swaps e.key to a symbol (Shift+0 -> ")"); matching keys off e.code.
	it("matches Shift+<digit> via e.code despite the symbol key", () => {
		const [combo] = parseHotkey("Shift+0")[0];
		expect(matchesKey(mockEvent({ key: ")", code: "Digit0", shiftKey: true }), combo)).toBe(true);
		expect(matchesKey(mockEvent({ key: "0", code: "Digit0", shiftKey: false }), combo)).toBe(false);
	});

	it("does not let Shift+<digit> match a bare digit binding", () => {
		const [combo] = parseHotkey("1")[0];
		expect(matchesKey(mockEvent({ key: "!", code: "Digit1", shiftKey: true }), combo)).toBe(false);
		expect(matchesKey(mockEvent({ key: "1", code: "Digit1", shiftKey: false }), combo)).toBe(true);
	});
});

describe("buildComboString", () => {
	function mockEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
		return {
			key: "a",
			code: "KeyA",
			ctrlKey: false,
			altKey: false,
			metaKey: false,
			shiftKey: false,
			...overrides,
		} as KeyboardEvent;
	}

	it("records Shift+<digit> in base-digit form, not the shifted symbol", () => {
		expect(buildComboString(mockEvent({ key: ")", code: "Digit0", shiftKey: true }))).toBe(
			"Shift+0",
		);
	});

	it("records a plain digit as itself", () => {
		expect(buildComboString(mockEvent({ key: "0", code: "Digit0" }))).toBe("0");
	});
});

describe("getAltSlowConflict", () => {
	it("returns conflict for 'Alt+a' (panLeft)", () => {
		const result = getAltSlowConflict("Alt+a");
		expect(result).toBeDefined();
		expect(result!.action).toBe("panLeft");
	});

	it("returns conflict for 'Alt+d' (panRight)", () => {
		const result = getAltSlowConflict("Alt+d");
		expect(result).toBeDefined();
		expect(result!.action).toBe("panRight");
	});

	it("distinguishes 'Alt+w' (panUp) from 'Alt+Shift+w' (mapZoomIn)", () => {
		expect(getAltSlowConflict("Alt+w")!.action).toBe("panUp");
		expect(getAltSlowConflict("Alt+Shift+w")!.action).toBe("mapZoomIn");
	});

	it("returns conflict for 'Alt+ArrowLeft' (panoLookLeft)", () => {
		const result = getAltSlowConflict("Alt+ArrowLeft");
		expect(result).toBeDefined();
		expect(result!.action).toBe("panoLookLeft");
	});

	it("distinguishes 'Alt+ArrowDown' (panoLookDown) from 'Alt+Shift+ArrowDown' (panoMoveBackward)", () => {
		expect(getAltSlowConflict("Alt+ArrowDown")!.action).toBe("panoLookDown");
		expect(getAltSlowConflict("Alt+Shift+ArrowDown")!.action).toBe("panoMoveBackward");
	});

	it("returns undefined without an Alt token (no slow-modifier shadowing)", () => {
		expect(getAltSlowConflict("w")).toBeUndefined();
		expect(getAltSlowConflict("Shift+w")).toBeUndefined();
	});

	it("returns undefined for 'Alt+f' (not an altSlow binding)", () => {
		expect(getAltSlowConflict("Alt+f")).toBeUndefined();
	});

	it("returns undefined for 'Alt+q' (has binding but no altSlow)", () => {
		expect(getAltSlowConflict("Alt+q")).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(getAltSlowConflict("")).toBeUndefined();
	});

	it("returned def has altSlow: true", () => {
		const result = getAltSlowConflict("Alt+a");
		expect(result).toBeDefined();
		expect(result!.altSlow).toBe(true);
	});
});

describe("getConflicts", () => {
	it("returns empty array for empty binding", () => {
		expect(getConflicts("panLeft", "")).toEqual([]);
	});

	it("returns empty array for unique binding", () => {
		const binding = getBinding("toggleFullscreen");
		const conflicts = getConflicts("toggleFullscreen", binding);
		expect(conflicts).toEqual([]);
	});

	it("returns conflicting defs for duplicate binding", () => {
		const binding = getBinding("panLeft");
		const conflicts = getConflicts("someOtherAction", binding);
		const actions = conflicts.map((c) => c.action);
		expect(actions).toContain("panLeft");
	});

	it("excludes the action itself", () => {
		const binding = getBinding("panLeft");
		const conflicts = getConflicts("panLeft", binding);
		const actions = conflicts.map((c) => c.action);
		expect(actions).not.toContain("panLeft");
	});
});

describe("reassignBinding", () => {
	afterEach(() => resetAllBindings());

	it("assigns the binding and clears it from the prior holder", () => {
		const target = getBinding("toggleFullscreen"); // "f"
		const cleared = reassignBinding("returnToSpawn", target);

		expect(getBinding("returnToSpawn")).toBe(target);
		expect(getBinding("toggleFullscreen")).toBe("");
		expect(cleared).toContain("toggleFullscreen");
		expect(getConflicts("returnToSpawn", target)).toEqual([]);
	});

	it("clears every conflicting holder", () => {
		setBinding("returnToSpawn", "z");
		setBinding("pointNorth", "z");
		const cleared = reassignBinding("centerRoad", "z");

		expect(getBinding("centerRoad")).toBe("z");
		expect(getBinding("returnToSpawn")).toBe("");
		expect(getBinding("pointNorth")).toBe("");
		expect(cleared.sort()).toEqual(["pointNorth", "returnToSpawn"]);
	});
});
