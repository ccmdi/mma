// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";
import { mount } from "./fixtures/harness";
import { DatePicker } from "@/components/primitives/DatePicker";

function type(input: HTMLInputElement, text: string) {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	act(() => {
		setter.call(input, text);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("DatePicker", () => {
	function render() {
		const { container } = mount(<DatePicker mode="date" value="2019-06-03" onChange={() => {}} />);
		return container.querySelector("input") as HTMLInputElement;
	}

	it("flags typed text that isn't a date", () => {
		const input = render();
		act(() => input.focus());
		type(input, "asdfgh");
		expect(input.getAttribute("aria-invalid")).toBe("true");
		expect(input.className).toContain("is-invalid");
	});

	it("leaves valid text unflagged", () => {
		const input = render();
		act(() => input.focus());
		type(input, "Jun 3, 2019");
		expect(input.getAttribute("aria-invalid")).toBe(null);
		expect(input.className).not.toContain("is-invalid");
	});
});
