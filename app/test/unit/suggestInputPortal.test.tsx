// @vitest-environment jsdom
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount } from "./fixtures/harness";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { SuggestInput } from "@/components/primitives/SuggestInput";

const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

function press(target: Element) {
	return act(async () => {
		for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
			target.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true }));
		}
		await new Promise((r) => setTimeout(r, 0));
	});
}

function Harness({ onPick }: { onPick: (s: string) => void }) {
	const [value, setValue] = useState("");
	const suggestions = ["Europe", "Asia"].filter((s) => value && s.toLowerCase().includes(value));
	return (
		<Dialog open onOpenChange={() => {}}>
			<DialogContent title="Test">
				<SuggestInput
					value={value}
					onChange={setValue}
					suggestions={suggestions}
					onPick={onPick}
					renderItem={(s) => s}
					getKey={(s) => s}
					portal
				/>
				<div data-qa="empty">empty space</div>
			</DialogContent>
		</Dialog>
	);
}

async function type(text: string) {
	const input = document.querySelector<HTMLInputElement>(".modal__content input, input")!;
	await act(async () => {
		input.focus();
		const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
		set.call(input, text);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await tick();
	return input;
}

const list = () => document.querySelector<HTMLOListElement>(".suggest-portal ol:not([hidden])");

describe("SuggestInput in a portal", () => {
	it("anchors the list in a positioner outside the dialog", async () => {
		mount(<Harness onPick={() => {}} />);
		await tick();
		await type("e");
		expect(list()).toBeTruthy();
		expect(list()!.closest(".modal__content")).toBeNull();
	});

	it("stays open when pressing the input and closes on empty space", async () => {
		mount(<Harness onPick={() => {}} />);
		await tick();
		const input = await type("e");
		await press(input);
		expect(list()).toBeTruthy();
		await press(document.querySelector('[data-qa="empty"]')!);
		expect(list()).toBeNull();
	});

	it("picks a suggestion without closing the dialog", async () => {
		const onPick = vi.fn();
		mount(<Harness onPick={onPick} />);
		await tick();
		await type("as");
		await press(list()!.querySelector("button")!);
		expect(onPick).toHaveBeenCalledWith("Asia");
		expect(document.querySelector('[data-qa="empty"]')).toBeTruthy();
	});
});
