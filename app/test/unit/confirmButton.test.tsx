// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mdiRestore } from "@mdi/js";
import { mount } from "./fixtures/harness";
import { ConfirmButton } from "@/components/primitives/ConfirmButton";

const button = (container: HTMLElement) => container.querySelector("button")!;
const click = (el: HTMLElement) => act(() => el.click());

describe("ConfirmButton", () => {
	it("acts only on the second click", () => {
		const onConfirm = vi.fn();
		const { container } = mount(<ConfirmButton onConfirm={onConfirm}>Reset</ConfirmButton>);
		click(button(container));
		expect(onConfirm).not.toHaveBeenCalled();
		expect(button(container).textContent).toBe("Are you sure?");
		click(button(container));
		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it("with an icon, shows it labelled by its text until armed, then asks with focus", () => {
		const onConfirm = vi.fn();
		const { container } = mount(
			<ConfirmButton icon={mdiRestore} onConfirm={onConfirm}>
				Reset
			</ConfirmButton>,
			{ attach: true },
		);
		const idle = button(container);
		expect(idle.getAttribute("aria-label")).toBe("Reset");
		expect(idle.querySelector("svg path")?.getAttribute("d")).toBe(mdiRestore);

		click(idle);
		const armed = button(container);
		expect(armed.textContent).toBe("Are you sure?");
		expect(document.activeElement).toBe(armed);

		act(() => armed.blur());
		expect(button(container).getAttribute("aria-label")).toBe("Reset");
		expect(onConfirm).not.toHaveBeenCalled();
	});
});
