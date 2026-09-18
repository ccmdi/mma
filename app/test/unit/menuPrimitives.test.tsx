// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";
import { Menu } from "@base-ui-components/react/menu";
import { ContextMenu } from "@base-ui-components/react/context-menu";
import { mount } from "./fixtures/harness";
import { MenuItem, MenuPopup, MenuSeparator } from "@/components/primitives/Menu";

const items = () => [
	<MenuItem key="a">Rename</MenuItem>,
	<MenuSeparator key="s" />,
	<MenuItem key="b" tone="destructive">
		Delete
	</MenuItem>,
];

function expectMenu() {
	const popup = document.querySelector(".menu-positioner > .context-menu.popover-surface");
	expect(popup).not.toBeNull();
	const rows = [...popup!.querySelectorAll(".context-menu__item")];
	expect(rows.map((r) => r.textContent)).toEqual(["Rename", "Delete"]);
	expect(rows[0].classList.contains("context-menu__item--destructive")).toBe(false);
	expect(rows[1].classList.contains("context-menu__item--destructive")).toBe(true);
	expect(popup!.querySelector(".context-menu__separator[role='separator']")).not.toBeNull();
}

describe("Menu primitives", () => {
	it("build a dropdown menu", async () => {
		mount(
			<Menu.Root open>
				<Menu.Trigger>Open</Menu.Trigger>
				<MenuPopup align="end">{items()}</MenuPopup>
			</Menu.Root>,
		);
		await act(async () => {});
		expectMenu();
	});

	it("build a context menu from the same parts", async () => {
		mount(
			<ContextMenu.Root open>
				<ContextMenu.Trigger>Area</ContextMenu.Trigger>
				<MenuPopup>{items()}</MenuPopup>
			</ContextMenu.Root>,
		);
		await act(async () => {});
		expectMenu();
	});
});
