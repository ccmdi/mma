// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount } from "./fixtures/harness";
import { SearchInput } from "@/components/primitives/SearchInput";
import { setInputValue } from "@/lib/util/dom";

const reachedDocument = vi.fn();
beforeEach(() => {
	reachedDocument.mockReset();
	document.addEventListener("keydown", reachedDocument);
});
afterEach(() => document.removeEventListener("keydown", reachedDocument));

const input = (c: HTMLElement) => c.querySelector("input")!;
const clearButton = (c: HTMLElement) => c.querySelector<HTMLButtonElement>(".search-input__clear");
const pressEscape = (el: HTMLElement) =>
	act(() => {
		el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	});
const type = (el: HTMLInputElement, value: string) => act(() => setInputValue(el, value));

function Controlled({ onKeyDown }: { onKeyDown?: () => void }) {
	const [value, setValue] = useState("");
	return (
		<SearchInput value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown} />
	);
}

describe("SearchInput", () => {
	it("clears on Escape while it has text and keeps the key from reaching a dialog", () => {
		const { container } = mount(<Controlled />);
		type(input(container), "tag");
		expect(clearButton(container)).not.toBeNull();

		pressEscape(input(container));
		expect(input(container).value).toBe("");
		expect(clearButton(container)).toBeNull();
		expect(reachedDocument).not.toHaveBeenCalled();
	});

	it("passes Escape through when empty", () => {
		const onKeyDown = vi.fn();
		const { container } = mount(<Controlled onKeyDown={onKeyDown} />);
		pressEscape(input(container));
		expect(onKeyDown).toHaveBeenCalledOnce();
		expect(reachedDocument).toHaveBeenCalledOnce();
	});

	it("works uncontrolled and clears from the button, handing focus back", () => {
		const onChange = vi.fn();
		const { container } = mount(<SearchInput defaultValue="" onChange={onChange} />);
		expect(clearButton(container)).toBeNull();

		type(input(container), "map");
		expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ type: "change" }));
		const button = clearButton(container)!;
		expect(button.getAttribute("aria-label")).toBe("Clear search");

		act(() => button.click());
		expect(input(container).value).toBe("");
		expect(clearButton(container)).toBeNull();
		expect(document.activeElement).toBe(input(container));
	});

	it("shows the clear button for a starting value", () => {
		const { container } = mount(<SearchInput defaultValue="seed" />);
		expect(clearButton(container)).not.toBeNull();
	});
});
