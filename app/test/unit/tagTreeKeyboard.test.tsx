// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TagTreeView } from "@/components/editor/tags/TagTree";
import type { Tag } from "@/bindings.gen";
import type { TagSortMode } from "@/types";

const tags: Tag[] = [
	{ id: 1, name: "alpha", color: "#ff0000", visible: true },
	{ id: 2, name: "beta", color: "#00ff00", visible: true },
	{ id: 3, name: "gamma", color: "#0000ff", visible: true },
] as Tag[];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	// jsdom has no Web Animations API; the FLIP reorder animation calls it
	Element.prototype.getAnimations ??= () => [];
	Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as never;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

function render(onReorder: (ids: number[]) => void, sortMode: TagSortMode = "default") {
	act(() =>
		root.render(
			<TagTreeView
				tags={tags}
				split={true}
				selectedTagIds={new Set()}
				tagCounts={{ 1: 1, 2: 1, 3: 1 }}
				sortMode={sortMode}
				virtualTags={{}}
				aliases={{}}
				onEditTag={() => {}}
				onEditVirtual={() => {}}
				onRenameTag={() => {}}
				onAddAlias={() => {}}
				onRemoveAlias={() => {}}
				onReorder={onReorder}
				onMoveInto={() => {}}
				onNewFolder={() => {}}
				onDeleteFolder={() => {}}
				filterText=""
			/>,
		),
	);
}

describe("TagTreeView keyboard reorder", () => {
	it("alt+arrow on a focused tag commits a reorder", () => {
		const onReorder = vi.fn();
		render(onReorder);
		const els = [...container.querySelectorAll<HTMLElement>("[data-tag-id]")];
		expect(els.map((e) => e.dataset.tagId)).toEqual(["1", "2", "3"]);

		const first = els[0]!;
		expect(first.getAttribute("tabindex")).toBe("0");
		act(() => first.focus());
		expect(document.activeElement).toBe(first);

		act(() => {
			first.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }),
			);
		});
		expect(onReorder).toHaveBeenCalledWith([2, 1, 3]);
	});

	it("ignores an unmodified arrow", () => {
		const onReorder = vi.fn();
		render(onReorder);
		const first = container.querySelector<HTMLElement>("[data-tag-id]")!;
		act(() => first.focus());
		act(() => {
			first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		});
		expect(onReorder).not.toHaveBeenCalled();
	});

	// A derived sort has no order a reorder could rewrite; moving into a folder still does.
	it("ignores alt+arrow outside the default sort", () => {
		const onReorder = vi.fn();
		render(onReorder, "name");
		const first = container.querySelector<HTMLElement>("[data-tag-id]")!;
		act(() => first.focus());
		act(() => {
			first.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }),
			);
		});
		expect(onReorder).not.toHaveBeenCalled();
	});

	it("stops at the end of the list", () => {
		const onReorder = vi.fn();
		render(onReorder);
		const first = container.querySelector<HTMLElement>("[data-tag-id]")!;
		act(() => first.focus());
		act(() => {
			first.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }),
			);
		});
		expect(onReorder).not.toHaveBeenCalled();
	});
});
