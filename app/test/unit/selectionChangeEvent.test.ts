import { beforeEach, describe, it, expect } from "vitest";
import { Store } from "@/store/store";
import { SelectionList } from "@/store/selectionList";
import { subscribe } from "@/lib/events";
import { listedState } from "./fixtures/patch";
import type { ListedSelection, Selection } from "@/bindings.gen";

const row = (key: string, ghosted = false): ListedSelection => ({
	selection: { key, color: [0, 0, 0], selector: { type: "Everything" } },
	ghosted,
});

let heard: Selection[][] = [];
subscribe("selection:change", (active) => heard.push(active));

beforeEach(() => {
	Store.patch(listedState([]));
	heard = [];
});

describe("selection:change", () => {
	it("fires once whenever the listed selections change, whatever changed them", () => {
		Store.patch(listedState([row("a"), row("b", true)]));
		expect(heard.map((active) => active.map((s) => s.key))).toEqual([["a"]]);
		expect(SelectionList.listed().map((r) => r.selection.key)).toEqual(["a", "b"]);
	});

	it("stays quiet when the store changes but the listed selections do not", () => {
		Store.patch(listedState([row("a")]));
		heard = [];
		Store.patch({ version: 7 });
		expect(heard).toEqual([]);
	});
});
