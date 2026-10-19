// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "react";
import { mountAsync } from "./fixtures/harness";
import type { PendingTags } from "@/lib/data/tags";

const h = vi.hoisted(() => ({
	stored: [1],
	update: vi.fn<() => Promise<void>>(),
	shown: null as PendingTags | null,
	change: (_: PendingTags) => {},
	toast: vi.fn(),
}));
vi.mock("@/store/store", () => ({ Store: { use: () => [] } }));
vi.mock("@/store/query", () => ({ Query: { read: async () => [{ tags: h.stored }] } }));
vi.mock("@/store/tag", () => ({ Tag: { visible: () => [], get: () => ({}) } }));
vi.mock("@/store/edit", () => ({ Edit: { values: async () => ({ keys: [] }) } }));
vi.mock("@/store/location", () => ({ Location: { update: () => h.update() } }));
vi.mock("@/lib/util/toast", () => ({ toast: h.toast }));
vi.mock("@/components/editor/location/FullscreenTagBar", () => ({
	FullscreenTagBar: ({
		pendingTags,
		onChangeTags,
	}: {
		pendingTags: PendingTags;
		onChangeTags: (tags: PendingTags) => void;
	}) => {
		h.shown = pendingTags;
		h.change = onChangeTags;
		return null;
	},
}));

const { RoundTagBar } = await import("@/plugins/localguessr/RoundTagBar");

beforeEach(() => {
	h.stored = [1];
	h.update.mockReset();
	h.toast.mockReset();
});

describe("round tag bar", () => {
	it("shows the tags the location holds after a change lands", async () => {
		h.update.mockImplementation(async () => {
			h.stored = [1, 2];
		});
		await mountAsync(<RoundTagBar locationId={1} />);
		expect(h.shown).toEqual({ ids: [1], names: [] });
		await act(async () => h.change({ ids: [1, 2], names: [] }));
		expect(h.shown).toEqual({ ids: [1, 2], names: [] });
	});

	it("puts the tags back and says so when the change fails", async () => {
		h.update.mockRejectedValue(new Error("locked"));
		await mountAsync(<RoundTagBar locationId={1} />);
		await act(async () => h.change({ ids: [1, 2], names: [] }));
		expect(h.shown).toEqual({ ids: [1], names: [] });
		expect(h.toast).toHaveBeenCalledWith("locked");
	});
});
