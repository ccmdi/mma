import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Store } from "@/store/store";
import { SelectionList } from "@/store/selectionList";
import { Edit } from "@/store/edit";
import { listedState } from "./fixtures/patch";
import type { ListedSelection } from "@/bindings.gen";

vi.mock("@/lib/commands", async () => {
	const { selectionsHeld } = await import("./fixtures/mocks");
	return {
		cmd: {
			storeEdit: vi.fn(async (edits: { selections: unknown }) => selectionsHeld(edits.selections)),
		},
	};
});

const fakeRow = (key: string): ListedSelection => ({
	selection: { key, color: [0, 0, 0], selector: { type: "Everything" } },
	ghosted: false,
});

beforeEach(() => {
	const s = Store.get() as Record<string, unknown>;
	s.map = { id: "test" };
	Object.assign(s, listedState([fakeRow("tag:1"), fakeRow("tag:2")]));
});

afterEach(() => {
	const s = Store.get() as Record<string, unknown>;
	s.map = null;
	s.selectionRows = {};
	s.selectionOrder = [];
});

describe("store snapshot invariants", () => {
	it("the listed selections are a new list on every change, never mutated in place", async () => {
		const before = SelectionList.listed();
		await Edit.selections({ kind: "ghost", index: 0 });
		const ghosted = SelectionList.listed();
		expect(ghosted).not.toBe(before);
		expect(ghosted[0].ghosted).toBe(true);
		expect(before[0].ghosted).toBe(false);

		await Edit.selections({ kind: "ghost", index: 0 });
		const unghosted = SelectionList.listed();
		expect(unghosted).not.toBe(ghosted);
		expect(unghosted[0].ghosted).toBe(false);
	});

	it("getActiveSelections returns a stable reference between mutations", async () => {
		expect(SelectionList.active()).toBe(SelectionList.active());
		await Edit.selections({ kind: "ghost", index: 1 });
		expect(SelectionList.active().map((s) => s.key)).toEqual(["tag:1"]);
		expect(SelectionList.active()).toBe(SelectionList.active());
	});
});
