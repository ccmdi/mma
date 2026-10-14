import { describe, expect, it, vi } from "vitest";
import type { Derived } from "@/bindings.gen";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/lib/commands", () => ({
	cmd: new Proxy(
		{},
		{
			get: (_, name) => () => {
				throw new Error(`no command expected, got ${String(name)}`);
			},
		},
	),
}));

const { Store } = await import("@/store/store");
const { CommitDiff } = await import("@/store/commitDiff");

const derived = (pending: Derived["pending"]): Derived => ({
	writingLayers: null,
	unsaved: null,
	locationCount: null,
	pending,
	meta: null,
	history: null,
	fieldValues: null,
	fieldDefs: null,
	selectionCounts: null,
	selectionList: null,
});

describe("pending counts", () => {
	it("follow the store's announcements without asking for them", () => {
		expect(CommitDiff.has()).toBe(false);
		Store.merge(derived({ added: 1, removed: 0, updated: 2 }), 1);
		expect(CommitDiff.has()).toBe(true);
		expect(Store.get().pending).toEqual({ added: 1, removed: 0, updated: 2 });
		Store.merge(derived(null), 2);
		expect(CommitDiff.has()).toBe(true);
		Store.merge(derived({ added: 0, removed: 0, updated: 0 }), 3);
		expect(CommitDiff.has()).toBe(false);
	});
});
