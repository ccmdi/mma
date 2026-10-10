// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@/store/commandDefs";
import { getCommand } from "@/store/commands";
import { getMapState, historyAvailable } from "@/store/useMapStore";
import { getBinding, getConflicts } from "@/lib/util/hotkeys";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

const state = getMapState();
const initial = { map: state.map, history: state.history };
afterEach(() => Object.assign(state, initial));

describe("selection history commands", () => {
	it("requires an open map and available selection history", () => {
		Object.assign(state, { map: null, history: { selections: { undo: true, redo: false } } });
		expect(getCommand("reselect")!.enabled!()).toBe(false);
		Object.assign(state, { map: { id: "test" }, history: {} });
		expect(getCommand("reselect")!.enabled!()).toBe(false);
		Object.assign(state, { history: { selections: { undo: true, redo: false } } });
		expect(getCommand("reselect")!.enabled!()).toBe(true);
	});

	it("has a default shortcut that leaves existing bindings available", () => {
		const binding = getBinding("reselect");
		expect(binding).toBe("Mod+Alt+d");
		expect(getConflicts("reselect", binding)).toEqual([]);
		expect(getBinding("deselectAll")).toBe("Mod+d");
		expect(getBinding("toggleStats")).toBe("Mod+Shift+d");
	});
});

describe("history availability", () => {
	it("keeps selection availability separate from atomic data undo", () => {
		const history = { selections: { undo: true, redo: false }, piles: { undo: false, redo: true } };
		expect(historyAvailable(history, "undo")).toBe(false);
		expect(historyAvailable(history, "redo")).toBe(true);
		expect(historyAvailable(history, "undo", "selections")).toBe(true);
		expect(historyAvailable(history, "redo", "selections")).toBe(false);
	});

	it("enables selection redo independently and binds it without conflicts", () => {
		Object.assign(state, {
			map: { id: "test" },
			history: { selections: { undo: false, redo: true } },
		});
		expect(getCommand("reselect")!.enabled!()).toBe(false);
		expect(getCommand("redo-selection")!.enabled!()).toBe(true);
		const binding = getBinding("redo-selection");
		expect(binding).toBe("Mod+Alt+Shift+d");
		expect(getConflicts("redo-selection", binding)).toEqual([]);
	});
});
