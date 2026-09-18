// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mount } from "./fixtures/harness";
import { Checkbox } from "@/components/primitives/Checkbox";
import { Radio } from "@/components/primitives/Radio";
import { Pill } from "@/components/primitives/Pill";
import { Section, SegmentedControl } from "@/components/primitives/Sidebar";

describe("Checkbox and Radio", () => {
	it("render a bare input without a label", () => {
		const html = renderToStaticMarkup(<Checkbox checked readOnly />);
		expect(html).toMatch(/^<input[^>]*class="checkbox"/);
		expect(html).not.toContain("<label");
	});

	it.each([
		["Checkbox", Checkbox, "checkbox"],
		["Radio", Radio, "radio"],
	] as const)("%s wraps its input and text in one choice label", (_, Control, type) => {
		const { container } = mount(<Control hint="More detail">Save zoom</Control>);
		const label = container.querySelector("label.choice")!;
		expect(label.querySelector(`input[type="${type}"]`)).not.toBeNull();
		expect(label.querySelector(".choice__text")?.textContent).toBe("Save zoomMore detail");
		expect(label.querySelector(".hint")?.textContent).toBe("More detail");
		expect(label.classList.contains("choice--hint")).toBe(true);
	});

	it("clicking the text toggles the box", () => {
		let checked = false;
		const { container } = mount(
			<Checkbox onChange={(e) => (checked = e.target.checked)}>Toggle me</Checkbox>,
		);
		act(() => container.querySelector<HTMLElement>(".choice__text")!.click());
		expect(checked).toBe(true);
	});

	it("marks the label disabled with the input", () => {
		const { container } = mount(
			<Radio disabled title="Nothing selected">
				Selection
			</Radio>,
		);
		const label = container.querySelector("label.choice")!;
		expect(label.getAttribute("aria-disabled")).toBe("true");
		expect(label.getAttribute("title")).toBe("Nothing selected");
		expect(label.querySelector("input")!.disabled).toBe(true);
	});
});

describe("Section", () => {
	it("toggles from a focusable button that reports aria-expanded", () => {
		const { container } = mount(<Section title="Options">body-text</Section>);
		const trigger = container.querySelector<HTMLButtonElement>(".plugin-section__trigger")!;
		expect(trigger.tagName).toBe("BUTTON");
		expect(trigger.tabIndex).toBe(0);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(container.textContent).toContain("body-text");

		act(() => trigger.click());
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
		expect(container.textContent).not.toContain("body-text");

		act(() => trigger.click());
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
	});

	it("keeps addons outside the trigger", () => {
		const { container } = mount(
			<Section title="T" addons={<button type="button">add</button>}>
				x
			</Section>,
		);
		expect(container.querySelector(".plugin-section__trigger button")).toBeNull();
		expect(container.querySelector(".plugin-section__addons button")).not.toBeNull();
	});
});

describe("SegmentedControl", () => {
	const options = [
		{ value: "a", label: "A" },
		{ value: "b", label: "B", disabled: true },
		{ value: "c", label: "C" },
	];

	it("is a radio group by default and a tab list when asked", () => {
		const radio = renderToStaticMarkup(
			<SegmentedControl value="a" onChange={() => {}} options={options} />,
		);
		expect(radio).toContain('role="radiogroup"');
		expect(radio).toContain('role="radio" aria-checked="true"');
		const tabs = renderToStaticMarkup(
			<SegmentedControl role="tabs" fill value="a" onChange={() => {}} options={options} />,
		);
		expect(tabs).toContain('role="tablist"');
		expect(tabs).toContain('role="tab" aria-selected="true"');
		expect(tabs).toContain("segmented--fill");
	});

	it("arrow keys skip disabled options", () => {
		let value = "a";
		const { container } = mount(
			<SegmentedControl value="a" onChange={(v) => (value = v)} options={options} />,
		);
		const group = container.querySelector(".segmented")!;
		act(() => {
			group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		});
		expect(value).toBe("c");
	});
});

describe("Pill", () => {
	it.each(["neutral", "accent", "warning", "destructive", "action"] as const)(
		"renders the %s tone",
		(tone) => {
			const html = renderToStaticMarkup(<Pill tone={tone}>label</Pill>);
			expect(html).toContain(`class="pill pill--${tone}"`);
		},
	);

	it("defaults to neutral and renders a count", () => {
		const html = renderToStaticMarkup(<Pill count={3} />);
		expect(html).toBe('<span class="pill pill--neutral"><span class="pill__count">3</span></span>');
	});
});
