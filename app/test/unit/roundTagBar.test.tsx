// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "react";
import { mountAsync } from "./fixtures/harness";

const h = vi.hoisted(() => ({
	stored: ["a"],
	update: vi.fn<() => Promise<void>>(),
	shown: [] as string[],
	change: (_: string[]) => {},
	toast: vi.fn(),
}));
vi.mock("@/store/store", () => ({ Store: { use: () => [] } }));
vi.mock("@/store/query", () => ({ Query: { read: async () => [{ tags: [] }] } }));
vi.mock("@/store/tag", () => ({ Tag: { visible: () => [], names: () => h.stored } }));
vi.mock("@/store/edit", () => ({ Edit: { values: async () => ({ keys: [] }) } }));
vi.mock("@/store/location", () => ({ Location: { update: () => h.update() } }));
vi.mock("@/lib/util/toast", () => ({ toast: h.toast }));
vi.mock("@/components/editor/location/FullscreenTagBar", () => ({
	FullscreenTagBar: ({
		pendingTags,
		onChangeTags,
	}: {
		pendingTags: string[];
		onChangeTags: (tags: string[]) => void;
	}) => {
		h.shown = pendingTags;
		h.change = onChangeTags;
		return null;
	},
}));

const { RoundTagBar } = await import("@/plugins/localguessr/RoundTagBar");

beforeEach(() => {
	h.stored = ["a"];
	h.update.mockReset();
	h.toast.mockReset();
});

describe("round tag bar", () => {
	it("shows the tags the location holds after a change lands", async () => {
		h.update.mockImplementation(async () => {
			h.stored = ["a", "b"];
		});
		await mountAsync(<RoundTagBar locationId={1} />);
		expect(h.shown).toEqual(["a"]);
		await act(async () => h.change(["a", "b"]));
		expect(h.shown).toEqual(["a", "b"]);
	});

	it("puts the tags back and says so when the change fails", async () => {
		h.update.mockRejectedValue(new Error("locked"));
		await mountAsync(<RoundTagBar locationId={1} />);
		await act(async () => h.change(["a", "b"]));
		expect(h.shown).toEqual(["a"]);
		expect(h.toast).toHaveBeenCalledWith("locked");
	});
});
