// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { Edit } from "@/store/edit";
import type { MapMeta } from "@/bindings.gen";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

vi.mock("@/store/edit", () => ({ Edit: { meta: vi.fn(async () => {}) } }));

vi.mock("@/store/maps", () => ({ Maps: { remove: vi.fn() } }));
vi.mock("@/store/settings", () => ({
	useSetting: () => ({}),
	setSetting: vi.fn(),
	getSettings: () => ({ labelColors: {} }),
}));
vi.mock("@/components/primitives/Dialog", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/primitives/Dialog")>()),
	useCloseDialog: () => () => {},
}));
vi.mock("@/components/dialogs/ScoreBoundsEditor", () => ({
	ScoreBoundsEditor: () => <div data-testid="scoring" />,
}));
vi.mock("@/lib/commands", () => ({
	cmd: {
		fieldExprError: async (expr: string) =>
			expr === "bad(" ? { kind: "unexpectedEnd" as const } : null,
	},
}));

import { MapSettingsForm, type MapFormContext } from "@/components/dialogs/MapSettingsForm";
import { mount } from "./fixtures/harness";

const map: MapMeta = {
	id: "m1",
	name: "Sweden",
	description: "",
	folder: null,
	settings: {},
	scoreBounds: "auto",
	extra: {},
	labels: [],
	locationCount: 0,
	pending: { added: 0, removed: 0, updated: 0 },
	createdAt: "2026-01-01",
	updatedAt: "2026-01-01",
	lastOpenedAt: null,
};

function render(context: MapFormContext, current = map) {
	const m = mount(<MapSettingsForm map={current} context={context} />);
	const save = () =>
		[...m.container.querySelectorAll("button")].find(
			(b) => b.getAttribute("type") === "submit",
		) as HTMLButtonElement;
	const inputs = () => [...m.container.querySelectorAll<HTMLInputElement>("input")];
	return { ...m, save, inputs };
}

function type(input: HTMLInputElement, text: string) {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	act(() => {
		setter.call(input, text);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

const nameInput = (inputs: HTMLInputElement[]) => inputs[0];
const exprInput = (inputs: HTMLInputElement[]) => inputs.find((i) => i.className.includes("mono"))!;

describe("MapSettingsForm is composed from SECTIONS", () => {
	it("leaves out a section the current context is not listed on", () => {
		const list = render("list");
		expect(list.container.querySelector('[data-testid="scoring"]')).toBeNull();
		expect(exprInput(list.inputs())).toBeUndefined();
		list.unmount();

		const editor = render("editor");
		expect(editor.container.querySelector('[data-testid="scoring"]')).not.toBeNull();
		expect(exprInput(editor.inputs())).toBeDefined();
		editor.unmount();
	});

	it("submits only edited settings while keeping each section's draft", async () => {
		const m = render("editor", {
			...map,
			settings: { searchRadius: 50, duplicateScore: "year", reviewOrder: "year" },
		});
		const expressions = m.inputs().filter((input) => input.className.includes("mono"));
		type(expressions[0], "");
		type(expressions[1], "-year");
		await act(async () => {});
		act(() => m.save().click());
		expect(Edit.meta).toHaveBeenLastCalledWith({
			id: map.id,
			settings: { duplicateScore: null, reviewOrder: "-year" },
		});
		m.unmount();
	});

	it("disables Save while a section blocks and enables it again when the section clears", () => {
		const m = render("editor");
		expect(m.save().disabled).toBe(false);

		type(nameInput(m.inputs()), "");
		expect(m.save().disabled).toBe(true);

		type(nameInput(m.inputs()), "Sweden");
		expect(m.save().disabled).toBe(false);
		m.unmount();
	});

	it("keeps Save disabled when one of two blocking sections clears", async () => {
		const m = render("editor");

		type(nameInput(m.inputs()), "");
		type(exprInput(m.inputs()), "bad(");
		await act(async () => {});
		expect(m.save().disabled).toBe(true);

		type(nameInput(m.inputs()), "Sweden");
		await act(async () => {});
		expect(m.save().disabled).toBe(true);

		type(exprInput(m.inputs()), "1");
		await act(async () => {});
		expect(m.save().disabled).toBe(false);
		m.unmount();
	});
});
