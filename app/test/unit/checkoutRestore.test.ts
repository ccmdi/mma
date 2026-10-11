import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Store } from "@/store/store";
import { Commit } from "@/store/commit";
import type { ListedSelection } from "@/bindings.gen";
import { cmd } from "@/lib/commands";

vi.mock("@/store/maps", () => ({
	Maps: { setList: vi.fn(), invalidate: vi.fn(async () => {}), reload: vi.fn(async () => {}) },
}));

vi.mock("@/lib/commands", () => ({
	cmd: {
		storeSaveDirty: vi.fn(async () => {}),
		storeCheckoutCommit: vi.fn(async () => ({ mutation: { version: 0, keys: [] } })),
	},
}));

const fakeRow = (key: string): ListedSelection => ({
	selection: { key, color: [0, 0, 0], selector: { type: "Everything" } },
	ghosted: false,
});

beforeEach(() => {
	const s = Store.get() as Record<string, unknown>;
	s.mapId = "test";
	s.map = { id: "test" };
	s.selectionList = [fakeRow("tag:1")];
});

afterEach(() => {
	const s = Store.get() as Record<string, unknown>;
	s.mapId = null;
	s.map = null;
	s.selectionList = [];
	vi.clearAllMocks();
});

describe("checkoutCommit failure", () => {
	it.each(["open elsewhere", "bad commit"])(
		"leaves the selection projection alone on %s",
		async (message) => {
			const before = Store.get().selectionList;
			vi.mocked(cmd.storeCheckoutCommit).mockRejectedValueOnce(new Error(message));
			await expect(Commit.checkout("abc1234")).rejects.toThrow(message);
			expect(Store.get().selectionList).toBe(before);
		},
	);
});
