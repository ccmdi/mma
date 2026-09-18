// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { mdiClose } from "@mdi/js";
import { mount } from "./fixtures/harness";
import { IconButton } from "@/components/primitives/IconButton";

const button = (container: HTMLElement) => container.querySelector("button")!;

describe("IconButton", () => {
	it("names the button from its label and shows the label as the tooltip", () => {
		const { container } = mount(<IconButton icon={mdiClose} label="Close" />);
		const b = button(container);
		expect(b.getAttribute("aria-label")).toBe("Close");
		expect(b.dataset.tooltip).toBe("Close");
		expect(b.getAttribute("title")).toBeNull();
		expect(b.type).toBe("button");
		expect(b.classList.contains("icon-button")).toBe(true);
		expect(b.querySelector("svg path")?.getAttribute("d")).toBe(mdiClose);
	});

	it("shows a separate tooltip text while keeping the label as the name", () => {
		const { container } = mount(
			<IconButton icon={mdiClose} label="Ghost" tooltip="Ghost (Alt-click to isolate)" />,
		);
		const b = button(container);
		expect(b.getAttribute("aria-label")).toBe("Ghost");
		expect(b.dataset.tooltip).toBe("Ghost (Alt-click to isolate)");
	});

	it("has no tooltip when opted out", () => {
		const { container } = mount(<IconButton icon={mdiClose} label="Close" tooltip={false} />);
		const b = button(container);
		expect(b.getAttribute("aria-label")).toBe("Close");
		expect(b.hasAttribute("data-tooltip")).toBe(false);
	});

	it("reports pressed only when active is given, and marks reveal and overlay", () => {
		const plain = button(mount(<IconButton icon={mdiClose} label="A" />).container);
		expect(plain.hasAttribute("aria-pressed")).toBe(false);
		expect(plain.hasAttribute("data-reveal")).toBe(false);

		const on = button(
			mount(<IconButton icon={mdiClose} label="B" active reveal overlay />).container,
		);
		expect(on.getAttribute("aria-pressed")).toBe("true");
		expect(on.hasAttribute("data-reveal")).toBe(true);
		expect(on.classList.contains("icon-button--overlay")).toBe(true);

		const off = button(mount(<IconButton icon={mdiClose} label="C" active={false} />).container);
		expect(off.getAttribute("aria-pressed")).toBe("false");
	});

	it("passes button props and children through", () => {
		const onClick = vi.fn();
		const { container } = mount(
			<IconButton icon={mdiClose} label="Go" type="submit" disabled={false} onClick={onClick}>
				<span className="badge-dot" />
			</IconButton>,
		);
		const b = button(container);
		expect(b.type).toBe("submit");
		expect(b.querySelector(".badge-dot")).not.toBeNull();
		b.click();
		expect(onClick).toHaveBeenCalledOnce();
	});
});
