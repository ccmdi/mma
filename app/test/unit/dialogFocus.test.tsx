// @vitest-environment jsdom
import { act, useState } from "react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";
import { mount } from "./fixtures/harness";
import { Dialog, DialogTrigger, DialogContent } from "@/components/primitives/Dialog";

function Harness({ body = "body" }: { body?: React.ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger>open me</DialogTrigger>
			<DialogContent title="Test">{body}</DialogContent>
		</Dialog>
	);
}

function openDialog(container: HTMLElement) {
	const trigger = container.querySelector("button") as HTMLButtonElement;
	act(() => {
		trigger.focus();
		trigger.click();
	});
	return trigger;
}

describe("Dialog focus", () => {
	it("opens with focus parked on the content, not a ring on the close button", async () => {
		openDialog(mount(<Harness />).container);

		await act(async () => {
			await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector(".modal")));
		});
		expect(document.activeElement).toBe(document.querySelector(".modal"));
	});

	it("lets a child that asks for focus keep it", () => {
		openDialog(mount(<Harness body={<input autoFocus data-qa="first" />} />).container);
		expect(document.activeElement).toBe(document.querySelector('[data-qa="first"]'));
	});

	it("returns focus to the trigger on close", async () => {
		const { container } = mount(<Harness />);
		const trigger = container.querySelector("button") as HTMLButtonElement;

		// jsdom's click() does not move focus the way a real one does
		act(() => {
			trigger.focus();
			trigger.click();
		});
		expect(document.querySelector(".modal")).toBeTruthy();

		const close = document.querySelector(".modal button") as HTMLButtonElement;
		await act(async () => {
			close.click();
			await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
		});

		expect(document.activeElement).toBe(trigger);
	});
});
