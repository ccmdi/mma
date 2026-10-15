// @vitest-environment jsdom
import { act, useState } from "react";
import { describe, expect, it } from "vitest";
import { mount } from "./fixtures/harness";
import { NumberInput } from "@/components/primitives/NumberInput";

function type(input: HTMLInputElement, text: string) {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
	act(() => {
		setter.call(input, text);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function render(initial: number, range: { min?: number; max?: number } = {}) {
	const committed: number[] = [];
	function Field() {
		const [value, setValue] = useState(initial);
		return (
			<NumberInput
				{...range}
				value={value}
				onChange={(v) => {
					committed.push(v);
					setValue(v);
				}}
			/>
		);
	}
	const { container } = mount(<Field />);
	const input = container.querySelector("input") as HTMLInputElement;
	act(() => input.focus());
	return { input, committed };
}

describe("NumberInput", () => {
	it("keeps a half-typed negative instead of snapping it to 0", () => {
		const { input, committed } = render(10, { min: -90, max: 90 });
		type(input, "-");
		expect(committed).toEqual([]);
		expect(input.value).not.toBe("0");
		type(input, "-15");
		expect(committed).toEqual([-15]);
	});

	it("waits for a number inside the range before committing it", () => {
		const { input, committed } = render(20, { min: 10 });
		type(input, "1");
		type(input, "15");
		expect(committed).toEqual([15]);
	});

	it("clamps an out-of-range number when the field is left", () => {
		const { input, committed } = render(10, { min: -90, max: 90 });
		type(input, "120");
		act(() => input.blur());
		expect(committed).toEqual([90]);
		expect(input.value).toBe("90");
	});

	it("restores the last value when the field is left empty", () => {
		const { input, committed } = render(10);
		type(input, "");
		act(() => input.blur());
		expect(committed).toEqual([]);
		expect(input.value).toBe("10");
	});
});
