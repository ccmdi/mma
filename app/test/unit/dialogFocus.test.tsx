// @vitest-environment jsdom
import { act, useState } from "react";
import type React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dialog, DialogTrigger, DialogContent } from "@/components/primitives/Dialog";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

function Harness({ body = "body" }: { body?: React.ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger>open me</DialogTrigger>
			<DialogContent title="Test">{body}</DialogContent>
		</Dialog>
	);
}

function openDialog() {
	const trigger = container.querySelector("button") as HTMLButtonElement;
	act(() => {
		trigger.focus();
		trigger.click();
	});
	return trigger;
}

describe("Dialog focus", () => {
	it("opens with focus parked on the content, not a ring on the close button", () => {
		act(() => root.render(<Harness />));
		openDialog();
		expect(document.activeElement).toBe(document.querySelector(".modal"));
	});

	it("lets a child that asks for focus keep it", () => {
		act(() => root.render(<Harness body={<input autoFocus data-qa="first" />} />));
		openDialog();
		expect(document.activeElement).toBe(document.querySelector('[data-qa="first"]'));
	});

	it("returns focus to the trigger on close", async () => {
		act(() => root.render(<Harness />));
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
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(document.activeElement).toBe(trigger);
	});
});
