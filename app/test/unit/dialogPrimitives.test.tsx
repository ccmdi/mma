// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount } from "./fixtures/harness";
import {
	ConfirmDialog,
	Dialog,
	DialogActions,
	DialogContent,
	DialogForm,
	PromptDialog,
} from "@/components/primitives/Dialog";
import { ConfirmButton } from "@/components/primitives/ConfirmButton";

const footer = () => document.querySelector(".modal__actions") as HTMLElement;
const labels = () => [...footer().querySelectorAll("button")].map((b) => b.textContent);
const button = (label: string) =>
	[...document.querySelectorAll<HTMLButtonElement>(".modal button")].find(
		(b) => b.textContent === label,
	)!;

function InDialog({
	children,
	onOpenChange,
}: {
	children: ReactNode;
	onOpenChange?: (o: boolean) => void;
}) {
	return (
		<Dialog open onOpenChange={onOpenChange}>
			<DialogContent title="Test">{children}</DialogContent>
		</Dialog>
	);
}

describe("DialogActions", () => {
	it("renders destructive, then side content, then cancel, then primary, whatever the prop order", () => {
		mount(
			<InDialog>
				<DialogActions
					primary={{ label: "Save", onClick: () => {} }}
					cancel
					start={<button type="button">Extra</button>}
					destructive={{ label: "Delete", onClick: () => {} }}
				/>
			</InDialog>,
		);
		expect(labels()).toEqual(["Delete", "Extra", "Cancel", "Save"]);
		const start = footer().querySelector(".modal__actions-start")!;
		expect([...start.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
			"Delete",
			"Extra",
		]);
	});

	it("puts a lone primary on the right, outside the left group", () => {
		mount(
			<InDialog>
				<DialogActions primary={{ label: "Save" }} />
			</InDialog>,
		);
		expect(footer().querySelector(".modal__actions-start")).toBeNull();
		expect(footer().lastElementChild?.textContent).toBe("Save");
	});

	it("styles a destructive confirm as destructive in the primary slot", () => {
		mount(
			<InDialog>
				<DialogActions
					cancel
					primary={{ label: "Remove", tone: "destructive", onClick: () => {} }}
				/>
			</InDialog>,
		);
		expect(labels()).toEqual(["Cancel", "Remove"]);
		expect(button("Remove").className).toContain("button--destructive");
	});

	it("submits with a primary that has no handler and not with one that has", () => {
		mount(
			<InDialog>
				<DialogActions primary={{ label: "Go" }} />
				<DialogActions primary={{ label: "Run", onClick: () => {} }} />
			</InDialog>,
		);
		expect(button("Go").type).toBe("submit");
		expect(button("Run").type).toBe("button");
	});

	it("closes the dialog from cancel unless cancel has its own handler", () => {
		const onOpenChange = vi.fn();
		const onCancel = vi.fn();
		mount(
			<InDialog onOpenChange={onOpenChange}>
				<DialogActions cancel={{ label: "Close" }} />
				<DialogActions cancel={{ label: "Stop", onClick: onCancel }} />
			</InDialog>,
		);
		expect(button("Close").type).toBe("button");
		act(() => button("Close").click());
		expect(onOpenChange).toHaveBeenCalledWith(false);
		act(() => button("Stop").click());
		expect(onCancel).toHaveBeenCalledOnce();
		expect(onOpenChange).toHaveBeenCalledOnce();
	});

	it("asks before a destructive action marked confirm", () => {
		const onDelete = vi.fn();
		mount(
			<InDialog>
				<DialogActions destructive={{ label: "Clear", confirm: true, onClick: onDelete }} />
			</InDialog>,
		);
		act(() => button("Clear").click());
		expect(onDelete).not.toHaveBeenCalled();
		act(() => button("Are you sure?").click());
		expect(onDelete).toHaveBeenCalledOnce();
	});
});

describe("ConfirmButton", () => {
	function renderButton(onConfirm: () => void, onParentClick = () => {}) {
		const { container } = mount(
			<div onClick={onParentClick}>
				<ConfirmButton onConfirm={onConfirm}>Restore</ConfirmButton>
				<button type="button">elsewhere</button>
			</div>,
		);
		return {
			confirm: () => container.querySelector("button") as HTMLButtonElement,
			elsewhere: () => container.querySelectorAll("button")[1] as HTMLButtonElement,
		};
	}

	it("arms on the first click and acts on the second", () => {
		const onConfirm = vi.fn();
		const { confirm } = renderButton(onConfirm);
		act(() => confirm().click());
		expect(onConfirm).not.toHaveBeenCalled();
		expect(confirm().textContent).toBe("Are you sure?");
		expect(confirm().className).toContain("button--destructive");
		act(() => confirm().click());
		expect(onConfirm).toHaveBeenCalledOnce();
		expect(confirm().textContent).toBe("Restore");
	});

	it("disarms when focus leaves", () => {
		const onConfirm = vi.fn();
		const { confirm, elsewhere } = renderButton(onConfirm);
		act(() => {
			confirm().focus();
			confirm().click();
		});
		act(() => elsewhere().focus());
		expect(confirm().textContent).toBe("Restore");
		act(() => confirm().click());
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("keeps its clicks from reaching a clickable row", () => {
		const onRow = vi.fn();
		const { confirm } = renderButton(() => {}, onRow);
		act(() => confirm().click());
		expect(onRow).not.toHaveBeenCalled();
	});
});

describe("DialogForm", () => {
	it("prevents the page submit and runs onSubmit", () => {
		const onSubmit = vi.fn();
		mount(
			<InDialog>
				<DialogForm onSubmit={onSubmit}>
					<DialogActions primary={{ label: "Go" }} />
				</DialogForm>
			</InDialog>,
		);
		const event = new Event("submit", { bubbles: true, cancelable: true });
		act(() => {
			document.querySelector("form")!.dispatchEvent(event);
		});
		expect(event.defaultPrevented).toBe(true);
		expect(onSubmit).toHaveBeenCalledOnce();
	});
});

describe("PromptDialog", () => {
	function Prompt({ onSubmit, canSubmit }: { onSubmit: () => void; canSubmit?: boolean }) {
		const [value, setValue] = useState("");
		return (
			<>
				<button type="button" onClick={() => setValue("named")}>
					type
				</button>
				<PromptDialog
					open
					onOpenChange={() => {}}
					title="Name"
					value={value}
					onChange={setValue}
					submitLabel="Create"
					canSubmit={canSubmit}
					onSubmit={onSubmit}
				/>
			</>
		);
	}

	const submit = () =>
		act(() => {
			document
				.querySelector(".modal form")!
				.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});

	it("will not submit a blank value, from the button or from Enter", () => {
		const onSubmit = vi.fn();
		const { container } = mount(<Prompt onSubmit={onSubmit} />);
		expect(button("Create").disabled).toBe(true);
		submit();
		expect(onSubmit).not.toHaveBeenCalled();

		act(() => (container.querySelector("button") as HTMLButtonElement).click());
		expect(button("Create").disabled).toBe(false);
		submit();
		expect(onSubmit).toHaveBeenCalledOnce();
	});

	it("lets canSubmit override the blank check", () => {
		const onSubmit = vi.fn();
		mount(<Prompt onSubmit={onSubmit} canSubmit />);
		expect(button("Create").disabled).toBe(false);
		submit();
		expect(onSubmit).toHaveBeenCalledOnce();
	});
});

describe("ConfirmDialog", () => {
	it("confirms with the confirm button and disables both while busy", () => {
		const onConfirm = vi.fn();
		const { root } = mount(
			<ConfirmDialog
				open
				onOpenChange={() => {}}
				title="Delete"
				message="Sure?"
				confirmLabel="Delete it"
				tone="destructive"
				onConfirm={onConfirm}
			/>,
		);
		expect(labels()).toEqual(["Cancel", "Delete it"]);
		act(() => button("Delete it").click());
		expect(onConfirm).toHaveBeenCalledOnce();

		act(() =>
			root.render(
				<ConfirmDialog
					open
					onOpenChange={() => {}}
					title="Delete"
					message="Sure?"
					confirmLabel="Delete it"
					busy
					onConfirm={onConfirm}
				/>,
			),
		);
		expect(button("Delete it").disabled).toBe(true);
		expect(button("Cancel").disabled).toBe(true);
	});
});
