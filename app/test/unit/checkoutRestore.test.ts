import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Store } from "@/store/store";
import { SelectionList } from "@/store/selectionList";
import { listedState } from "./fixtures/patch";
import { Commit } from "@/store/commit";
import { Editor } from "@/store/editor";
import type { ListedSelection } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { subscribe } from "@/lib/events";

vi.mock("@/store/maps", () => ({
	Maps: { setList: vi.fn(), invalidate: vi.fn(async () => {}), reload: vi.fn(async () => {}) },
}));

vi.mock("@/lib/render/scene", () => ({
	Scene: { load: vi.fn(async () => {}), reached: vi.fn(async () => ({})) },
}));

vi.mock("@/lib/commands", () => ({
	cmd: {
		storeSaveDirty: vi.fn(async () => {}),
		storeCheckoutCommit: vi.fn(async () => null),
		storeCommit: vi.fn(async () => ({ id: "rev" })),
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
	Object.assign(s, listedState([fakeRow("tag:1")]));
});

afterEach(() => {
	const s = Store.get() as Record<string, unknown>;
	s.mapId = null;
	s.map = null;
	Object.assign(s, listedState([]));
	vi.clearAllMocks();
});

describe("checkoutCommit", () => {
	it("closes the open location the way closing does, so the pane and listeners follow", async () => {
		const s = Editor.get() as Record<string, unknown>;
		const close = vi.fn(async () => {});
		s.open = { id: 7, origin: "map", location: null, layer: { close } };
		s.workArea = "location";
		const closed: (number | null)[] = [];
		const unsub = subscribe("open:change", (id) => closed.push(id));
		await Commit.checkout("abc1234");
		unsub();
		expect(Editor.get().open).toBeNull();
		expect(close).toHaveBeenCalledOnce();
		expect(Editor.get().workArea).toBe("overview");
		expect(closed).toEqual([null]);
	});
});

describe("checkoutCommit failure", () => {
	it.each(["open elsewhere", "bad commit"])(
		"leaves the selection projection alone on %s",
		async (message) => {
			const before = SelectionList.listed();
			vi.mocked(cmd.storeCheckoutCommit).mockRejectedValueOnce(new Error(message));
			await expect(Commit.checkout("abc1234")).rejects.toThrow(message);
			expect(SelectionList.listed()).toBe(before);
		},
	);
});
