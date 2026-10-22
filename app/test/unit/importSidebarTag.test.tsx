// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Tag } from "@/types";
import { act } from "react";
import { mount as mountRoot, typeInto } from "./fixtures/harness";
import type { EditorImportPreview } from "@/bindings.gen";
import { emit } from "@/lib/events";
// trace().end() logs through tauri-plugin-log, which needs a host.
Object.assign(window, { __TAURI_INTERNALS__: { invoke: async () => {} } });

const confirmImport = vi.fn(
	async (_dropped?: string[], _tagNames?: string[], _droppedTags?: string[]) => ({
		importedCount: 1,
	}),
);
let staging: { preview: EditorImportPreview; source: "file" } | null = null;
let tags: Tag[] = [];

vi.mock("@/store/import", () => ({
	Import: {
		staging: () => staging,
		confirm: (dropped: string[], tagNames?: string[], droppedTags?: string[]) =>
			confirmImport(dropped, tagNames, droppedTags),
		cancel: () => {},
	},
}));

vi.mock("@/store/store", () => ({
	Store: {
		use: () => tags,
	},
}));
vi.mock("@/store/tag", () => ({
	Tag: {
		visible: () => tags,
	},
}));

const { ImportSidebar } = await import("@/components/editor/ImportSidebar");

const preview: EditorImportPreview = {
	locationCount: 3,
	tags: [],
	fields: [],
	warnings: [],
	previewPositionsPath: "",
	bounds: null,
	target: { kind: "pending", name: "import:test" },
	keys: { first: 1, len: 3 },
	settings: {},
	willAutoCommit: false,
};

let container: HTMLDivElement;

function mount() {
	const mounted = mountRoot(<ImportSidebar />);
	container = mounted.container;
	return mounted.unmount;
}

function type(text: string) {
	typeInto(container.querySelector<HTMLInputElement>(".form-add-tag__input")!, text);
}

function submitTag() {
	const form = container.querySelector<HTMLFormElement>(".form-add-tag")!;
	act(() => {
		form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
}

function removeTag(name: string) {
	const pill = [...container.querySelectorAll(".tag")].find(
		(e) => e.querySelector(".tag__text")?.textContent === name,
	)!;
	act(() => {
		pill.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
		expect(confirmImport).toHaveBeenCalledWith([], ["france"], []);
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
		expect(confirmImport).toHaveBeenCalledWith([], [], []);
		unmount();
	});

	it("trims the tag it imports with", async () => {
		const unmount = mount();
		type("  france  ");
		expect(pills()).toEqual(["france"]);
		await clickImport();
		expect(confirmImport).toHaveBeenCalledWith([], ["france"], []);
		unmount();
	});
});

// #231: several tags, each added with Enter or +.
describe("import bulk tags", () => {
	it("adds the typed tag as a chip and clears the input", () => {
		const unmount = mount();
		type("france");
		submitTag();
		expect(pills()).toEqual(["france"]);
		expect(container.querySelector<HTMLInputElement>(".form-add-tag__input")!.value).toBe("");
		unmount();
	});

	it("imports with every added tag plus the one still typed", async () => {
		const unmount = mount();
		type("france");
		submitTag();
		type("urban");
		submitTag();
		type("2024");
		expect(pills()).toEqual(["france", "urban", "2024"]);
		await clickImport();
		expect(confirmImport).toHaveBeenCalledWith([], ["france", "urban", "2024"], []);
		unmount();
	});

	it("collapses repeats case-insensitively", async () => {
		const unmount = mount();
		type("france");
		submitTag();
		type("France");
		submitTag();
		type("FRANCE");
		expect(pills()).toEqual(["france"]);
		await clickImport();
		expect(confirmImport).toHaveBeenCalledWith([], ["france"], []);
		unmount();
	});

	it("drops a removed chip from the import", async () => {
		const unmount = mount();
		type("france");
		submitTag();
		type("urban");
		submitTag();
		removeTag("france");
		expect(pills()).toEqual(["urban"]);
		await clickImport();
		expect(confirmImport).toHaveBeenCalledWith([], ["urban"], []);
		unmount();
	});
});

describe("file tag selection", () => {
	beforeEach(() => {
		staging = {
			preview: {
				...preview,
				tags: [
					{ name: "France", color: "#123456" },
					{ name: "Urban", color: "#654321" },
				],
				fields: [{ key: "tags", count: 3 }],
			},
			source: "file",
		};
	});

	function fileTag(name: string) {
		return [...container.querySelectorAll<HTMLButtonElement>(".tag__button--toggle")].find(
			(button) => button.getAttribute("aria-label") === name,
		)!;
	}

	it("includes all file tags by default", async () => {
		mount();
		expect(fileTag("France").getAttribute("aria-pressed")).toBe("true");
		expect(fileTag("Urban").getAttribute("aria-pressed")).toBe("true");
		expect(fileTag("France").parentElement?.classList.contains("tag")).toBe(true);
		expect(container.querySelectorAll('.tag-list input[type="checkbox"]')).toHaveLength(0);
		await clickImport();
		expect(confirmImport).toHaveBeenCalledWith([], [], []);
	});

	it("excludes a tag while keeping it visible and preserves bulk tags", async () => {
		mount();
		act(() => fileTag("France").click());
		expect(fileTag("France").getAttribute("aria-pressed")).toBe("false");
		expect(fileTag("Urban").getAttribute("aria-pressed")).toBe("true");
		expect(fileTag("France").title).toBe("Include");
		expect(fileTag("France").parentElement?.style.backgroundColor).toBe("var(--surface-3)");
		type("France");
		await clickImport();
		expect(confirmImport).toHaveBeenCalledWith([], ["France"], ["France"]);
	});

	it("can restore an excluded tag before importing", async () => {
		mount();
		act(() => fileTag("France").click());
		act(() => fileTag("France").click());
		expect(fileTag("France").getAttribute("aria-pressed")).toBe("true");
		expect(fileTag("France").title).toBe("Exclude");
		expect(fileTag("France").parentElement?.style.backgroundColor).toBe("rgb(18, 52, 86)");
		await clickImport();
		expect(confirmImport).toHaveBeenCalledWith([], [], []);
	});

	it("starts a replacement preview with every file tag included", () => {
		mount();
		act(() => fileTag("France").click());
		staging = { ...staging!, preview: { ...staging!.preview } };
		act(() => emit("import-markers:changed"));
		expect(fileTag("France").getAttribute("aria-pressed")).toBe("true");
	});

	it("the tags field controls the whole group and retains individual choices", () => {
		mount();
		act(() => fileTag("France").click());
		const field = container.querySelector<HTMLInputElement>(".importer__fields input")!;
		act(() => field.click());
		expect(fileTag("France").getAttribute("aria-pressed")).toBe("false");
		expect(fileTag("Urban").getAttribute("aria-pressed")).toBe("false");
		expect(fileTag("France").disabled).toBe(true);
		expect(fileTag("Urban").disabled).toBe(true);
		act(() => field.click());
		expect(fileTag("France").getAttribute("aria-pressed")).toBe("false");
		expect(fileTag("Urban").getAttribute("aria-pressed")).toBe("true");
		expect(fileTag("Urban").disabled).toBe(false);
	});
});
