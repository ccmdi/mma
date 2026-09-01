// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act } from "react";
import { Tooltip, TooltipProvider } from "@/components/primitives/Tooltip";
import { mount } from "./fixtures/harness";

function render() {
	const m = mount(
		<TooltipProvider>
			<Tooltip content="Undo">
				<button type="button">u</button>
			</Tooltip>
		</TooltipProvider>,
	);
	const trigger = m.container.querySelector("button")!;
	return { ...m, trigger };
}

const matcher = (keyboard: boolean) =>
	((sel: string) => sel === ":focus-visible" && keyboard) as unknown as HTMLElement["matches"];

const tip = () => document.body.querySelector('[role="tooltip"]');

function focus(trigger: HTMLElement, keyboard: boolean) {
	trigger.matches = matcher(keyboard);
	act(() => {
		trigger.focus();
		trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
	});
}

describe("a tooltip opens on keyboard focus only", () => {
	it("opens when focus is keyboard focus", () => {
		const m = render();
		focus(m.trigger, true);
		expect(tip()?.textContent).toContain("Undo");
		m.unmount();
	});

	it("stays closed when focus arrives without the keyboard", () => {
		const m = render();
		focus(m.trigger, false);
		expect(tip()).toBeNull();
		m.unmount();
	});

	it("still opens on hover, which never has keyboard focus", () => {
		const m = render();
		m.trigger.matches = matcher(false);
		act(() => {
			m.trigger.dispatchEvent(new Event("pointerover", { bubbles: true }));
		});
		expect(tip()?.textContent).toContain("Undo");
		m.unmount();
	});
});
