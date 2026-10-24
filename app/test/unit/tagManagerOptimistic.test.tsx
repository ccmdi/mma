// @vitest-environment jsdom
import { act, createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { Store } from "@/store/store";
import { setSetting } from "@/store/settings";
import { TagManager } from "@/components/editor/tags/TagManager";
import { mount } from "./fixtures/harness";

vi.mock("@tauri-apps/api/core", () => ({
	Channel: class {
		onmessage: (e: unknown) => void = () => {};
	},
}));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/lib/commands", async () => {
	const { cmdProxy } = await import("./fixtures/mocks");
	const unanswered = () => new Promise(() => {});
	return cmdProxy({ storeEdit: unanswered, storeUpdateMapMeta: unanswered });
});

const folderOrder = () =>
	[...document.querySelectorAll<HTMLElement>(".tag-tree__row")].map((el) => el.dataset.treePath);

describe("TagManager", () => {
	it("shows a folder move before the store has saved it", () => {
		setSetting("tagViewMode", "tree");
		Store.patch({
			mapId: "m",
			map: { id: "m", settings: { virtualTags: { E: { order: 1 }, G: { order: 2 } } } },
			fieldValues: { tags: { 1: { count: 1, record: { name: "a", order: 0 } } } },
		} as never);
		mount(createElement(TagManager));
		expect(folderOrder()).toEqual(["E", "G"]);

		const folder = document.querySelector<HTMLElement>('[data-tree-path="E"]')!;
		act(() => {
			folder.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }),
			);
		});
		expect(folderOrder()).toEqual(["G", "E"]);
	});
});
