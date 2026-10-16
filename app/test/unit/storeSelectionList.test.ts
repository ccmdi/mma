import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ListedSelection } from "@/bindings.gen";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { Store } from "@/store/store";
import { SelectionList } from "@/store/selectionList";
import { add, remove, replace } from "./fixtures/patch";

const row = (key: string, ghosted = false): ListedSelection => ({
	selection: { key, color: [0, 0, 0], selector: { type: "Everything" } },
	ghosted,
});

beforeEach(() => {
	Store.resetDerived();
	Store.apply(
		[
			add("/selectionRows/a", row("a")),
			add("/selectionRows/b", row("b")),
			add("/selectionRows/c", row("c")),
			replace("/selectionOrder", ["a", "b", "c"]),
		],
		1,
	);
});

describe("the listed selections", () => {
	it("follow the order, keeping the rows a change did not touch", () => {
		const [a, , c] = SelectionList.listed();
		Store.apply(
			[
				add("/selectionRows/d", row("d")),
				remove("/selectionRows/b"),
				replace("/selectionOrder", ["c", "a", "d"]),
			],
			2,
		);
		const list = SelectionList.listed();
		expect(list.map((r) => r.selection.key)).toEqual(["c", "a", "d"]);
		expect(list[0]).toBe(c);
		expect(list[1]).toBe(a);
	});

	it("take a changed row in place of the one held", () => {
		Store.apply([add("/selectionRows/b", row("b", true))], 2);
		expect(SelectionList.listed()[1].ghosted).toBe(true);
	});

	it("stay the same list when a change touches neither rows nor order", () => {
		const before = SelectionList.listed();
		Store.apply([replace("/locationCount", 3)], 2);
		expect(SelectionList.listed()).toBe(before);
	});

	it("refuse an order naming a row never sent", () => {
		Store.apply([replace("/selectionOrder", ["a", "x"])], 2);
		expect(() => SelectionList.listed()).toThrow(/no row holds/);
	});
});
