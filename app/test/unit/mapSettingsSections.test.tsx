// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import type { MapMeta } from "@/bindings.gen";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/store/useMapStore", () => ({ patchMapMeta: vi.fn() }));
vi.mock("@/store/mapList", () => ({ deleteMap: vi.fn() }));
vi.mock("@/store/settings", () => ({
	useSetting: () => ({}),
	setSetting: vi.fn(),
	getSettings: () => ({ labelColors: {} }),
}));
vi.mock("@/components/primitives/Dialog", () => ({ useCloseDialog: () => () => {} }));
vi.mock("@/components/dialogs/ScoreBoundsEditor", () => ({
	ScoreBoundsEditor: () => <div data-testid="scoring" />,
}));
vi.mock("@/lib/commands", () => ({
	cmd: { fieldExprError: async (expr: string) => (expr === "bad(" ? "unexpected token" : null) },
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
	tags: {},
	labels: [],
	locationCount: 0,
	createdAt: "2026-01-01",
	updatedAt: "2026-01-01",
	lastOpenedAt: null,
};

function render(context: MapFormContext) {
	const m = mount(<MapSettingsForm map={map} context={context} />);
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
