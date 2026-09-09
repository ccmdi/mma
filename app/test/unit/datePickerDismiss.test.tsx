// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";
import { mount } from "./fixtures/harness";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { DatePicker } from "@/components/primitives/DatePicker";

function Harness() {
	return (
		<Dialog open onOpenChange={() => {}}>
			<DialogContent title="Test">
				<DatePicker mode="date" value="2019-06-03" onChange={() => {}} />
				<div data-qa="empty">empty space</div>
				<button data-qa="other">other</button>
			</DialogContent>
		</Dialog>
	);
}

const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

function press(target: Element, opts: { blur?: boolean } = {}) {
	return act(async () => {
		if (opts.blur !== false) (document.activeElement as HTMLElement | null)?.blur();
		for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
			target.dispatchEvent(new MouseEvent(type, { bubbles: true, composed: true }));
		}
		await new Promise((r) => setTimeout(r, 0));
	});
}

const popover = () => document.querySelector(".date-picker__popover");

describe("DatePicker dismissal", () => {
	async function open() {
		mount(<Harness />);
		await tick();
		const input = document.querySelector("input.date-picker__trigger") as HTMLInputElement;
		act(() => input.focus());
		await tick();
		expect(popover()).toBeTruthy();
		return input;
	}

	it("closes and blurs when pressing empty space", async () => {
		const input = await open();
		await press(document.querySelector('[data-qa="empty"]')!);
		expect(popover()).toBeNull();
		expect(document.activeElement).not.toBe(input);
	});

	it("closes when pressing another control", async () => {
		const input = await open();
		const other = document.querySelector('[data-qa="other"]') as HTMLButtonElement;
		await act(async () => {
			input.blur();
			other.focus();
			await new Promise((r) => setTimeout(r, 0));
		});
		await press(other, { blur: false });
		expect(popover()).toBeNull();
		expect(document.activeElement).not.toBe(input);
	});

	it("stays open when pressing inside the calendar", async () => {
		await open();
		const inside = document.querySelector(".date-picker__popover")!;
		await press(inside, { blur: false });
		expect(popover()).toBeTruthy();
	});

	it("stays open when pressing the input again", async () => {
		const input = await open();
		await press(input, { blur: false });
		expect(popover()).toBeTruthy();
	});

	it("closes when a day is picked", async () => {
		const input = await open();
		const day = document.querySelector(".rdp-day:not(.rdp-hidden) button") as HTMLButtonElement;
		await act(async () => {
			input.blur();
			day.focus();
			day.click();
			await new Promise((r) => setTimeout(r, 0));
		});
		expect(popover()).toBeNull();
	});
});
