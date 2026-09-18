import type { ComponentPropsWithRef, ReactNode } from "react";
import clsx from "clsx";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";

/** A button showing only an icon, named by its label. @unstable */
export function IconButton({
	icon,
	label,
	size = 24,
	active,
	reveal,
	overlay,
	tooltip,
	tooltipSide,
	type,
	className,
	children,
	...props
}: Omit<ComponentPropsWithRef<"button">, "aria-label" | "title"> & {
	/** An icon path, or a drawn icon to show instead. */
	icon: string | ReactNode;
	/** What the button does, read aloud and shown as its tooltip. */
	label: string;
	/** The icon's size in pixels. */
	size?: number;
	/** Shows the button as pressed. */
	active?: boolean;
	/** Hides the button until its row is hovered or holds focus. */
	reveal?: boolean;
	/** Draws the button for use over map or street view imagery. */
	overlay?: boolean;
	/** The tooltip text, or false for none. Defaults to the label. */
	tooltip?: string | false;
	/** The side the tooltip opens on. */
	tooltipSide?: "top" | "bottom" | "left" | "right";
	/** Shown after the icon, such as a badge. */
	children?: ReactNode;
}) {
	const button = (
		<button
			{...props}
			type={type ?? "button"}
			aria-label={label}
			aria-pressed={active}
			data-reveal={reveal || undefined}
			className={clsx("icon-button", overlay && "icon-button--overlay", className)}
		>
			{typeof icon === "string" ? <Icon path={icon} size={size} /> : icon}
			{children}
		</button>
	);
	const content = tooltip ?? label;
	return content === false ? (
		button
	) : (
		<Tooltip content={content} side={tooltipSide}>
			{button}
		</Tooltip>
	);
}
