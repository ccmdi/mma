import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Derived, ListedSelection } from "@/bindings.gen";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { Store } from "@/store/store";

const row = (key: string, ghosted = false): ListedSelection => ({
	selection: { key, color: [0, 0, 0], selector: { type: "Everything" } },
	ghosted,
});

const listChange = (order: string[], rows: ListedSelection[]): Derived => ({
	writingLayers: null,
	unsaved: null,
	locationCount: null,
	pending: null,
	meta: null,
	history: null,
	fieldValues: null,
	fieldDefs: null,
	selectionCounts: null,
	selectionList: { order, rows },
});

beforeEach(() => {
	Store.resetDerived();
	Store.merge(listChange(["a", "b", "c"], [row("a"), row("b"), row("c")]), 1);
});

describe("the listed selections", () => {
	it("follow the order a change sends, keeping the rows it did not resend", () => {
		const [a, , c] = Store.get().selectionList;
		Store.merge(listChange(["c", "a", "d"], [row("d")]), 2);
		const list = Store.get().selectionList;
		expect(list.map((r) => r.selection.key)).toEqual(["c", "a", "d"]);
		expect(list[0]).toBe(c);
		expect(list[1]).toBe(a);
	});

	it("take a resent row in place of the one held", () => {
		Store.merge(listChange(["a", "b", "c"], [row("b", true)]), 2);
		expect(Store.get().selectionList[1].ghosted).toBe(true);
	});

	it("stay the same list when a change moves nothing", () => {
		const before = Store.get().selectionList;
		Store.merge(listChange(["a", "b", "c"], []), 2);
		expect(Store.get().selectionList).toBe(before);
	});

	it("refuse a change naming a row never sent", () => {
		expect(() => Store.merge(listChange(["a", "x"], []), 2)).toThrow(/never sent/);
	});
});
