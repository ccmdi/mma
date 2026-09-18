import type { ComponentProps } from "react";
import { Menu } from "@base-ui-components/react/menu";

/** The floating list of a menu or context menu, placed beside what opened it. */
export function MenuPopup({
	align,
	side,
	...props
}: Omit<ComponentProps<typeof Menu.Popup>, "className"> &
	Pick<ComponentProps<typeof Menu.Positioner>, "align" | "side">) {
	return (
		<Menu.Portal>
			<Menu.Positioner className="menu-positioner" align={align} side={side}>
				<Menu.Popup {...props} className="context-menu popover-surface" />
			</Menu.Positioner>
		</Menu.Portal>
	);
}

/** One choice in a menu; a destructive one reads in red. */
export function MenuItem({
	tone,
	...props
}: Omit<ComponentProps<typeof Menu.Item>, "className"> & { tone?: "destructive" }) {
	return (
		<Menu.Item
			{...props}
			className={tone ? `context-menu__item context-menu__item--${tone}` : "context-menu__item"}
		/>
	);
}

export function MenuSeparator() {
	return <Menu.Separator className="context-menu__separator" />;
}
