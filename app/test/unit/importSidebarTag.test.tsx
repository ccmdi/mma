// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act } from "react";
import { mount as mountRoot } from "./fixtures/harness";
import type { EditorImportPreview, Tag } from "@/bindings.gen";

// trace().end() logs through tauri-plugin-log, which needs a host.
Object.assign(window, { __TAURI_INTERNALS__: { invoke: async () => {} } });

const confirmImport = vi.fn(async (_dropped?: string[], _tagName?: string) => ({
	importedCount: 1,
}));
let staging: { preview: EditorImportPreview; source: "file" } | null = null;
let tags: Tag[] = [];

vi.mock("@/store/importStaging", () => ({
	getImportStaging: () => staging,
	confirmImport: (dropped: string[], tagName?: string) => confirmImport(dropped, tagName),
	cancelImport: () => {},
}));

vi.mock("@/store/useMapStore", () => ({
	useMapState: () => tags,
	getVisibleTags: () => tags,
}));

const { ImportSidebar } = await import("@/components/editor/ImportSidebar");

const preview: EditorImportPreview = {
	locationCount: 3,
	tags: [],
	fields: [],
	warnings: [],
	previewPositionsPath: "",
	bounds: null,
	willAutoCommit: false,
};

let container: HTMLDivElement;

function mount() {
	const mounted = mountRoot(<ImportSidebar />);
	container = mounted.container;
	return mounted.unmount;
}

function type(text: string) {
	const input = container.querySelector<HTMLInputElement>(".form-add-tag__input")!;
	act(() => {
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
		setter.call(input, text);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function clickImport() {
	const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Import")!;
	await act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function pills() {
	return [...container.querySelectorAll(".tag__text")].map((e) => e.textContent);
}

beforeEach(() => {
	confirmImport.mockClear();
	staging = { preview, source: "file" };
	tags = [];
	document.body.replaceChildren();
});

// #105: the typed tag is the tag. There is no commit step, so nothing can be
// silently dropped by skipping one.
describe("import bulk tag", () => {
	it("applies a typed tag without pressing enter", async () => {
		const unmount = mount();
		type("france");
		await clickImport();
		expect(confirmImport).toHaveBeenCalledWith([], "france");
		unmount();
	});

	it("previews the typed tag as a pill while typing", () => {
		const unmount = mount();
		expect(pills()).toEqual([]);
		type("france");
		expect(pills()).toEqual(["france"]);
		type("");
		expect(pills()).toEqual([]);
		unmount();
	});

	it("previews with an existing tag's color, not a placeholder", () => {
		tags = [{ id: 1, name: "France", color: "#123456" } as Tag];
		const unmount = mount();
		type("france");
		const pill = container.querySelector<HTMLElement>(".tag")!;
		expect(pill.style.backgroundColor).toBe("rgb(18, 52, 86)");
		unmount();
	});

	it("treats a whitespace-only tag as no tag", async () => {
		const unmount = mount();
		type("   ");
		expect(pills()).toEqual([]);
		await clickImport();
		expect(confirmImport).toHaveBeenCalledWith([], "");
		unmount();
	});

	it("trims the tag it imports with", async () => {
		const unmount = mount();
		type("  france  ");
		expect(pills()).toEqual(["france"]);
		await clickImport();
		expect(confirmImport).toHaveBeenCalledWith([], "france");
		unmount();
	});
});
