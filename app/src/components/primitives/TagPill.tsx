import type { ComponentPropsWithRef, ElementType, ReactNode } from "react";
import clsx from "clsx";
import { mdiClose, mdiMinus, mdiPencil, mdiPlus } from "@mdi/js";
import { Icon } from "@/components/primitives/Icon";
import { textColorFor } from "@/lib/util/color";
import { fmt } from "@/lib/util/format";

type TagPillButtonVariant = "add" | "delete" | "edit" | "toggle";

const BUTTON_ICON: Record<TagPillButtonVariant, string> = {
	add: mdiPlus,
	delete: mdiClose,
	edit: mdiPencil,
	toggle: mdiMinus,
};

/** A leading button that adds, removes, edits, or toggles a tag. @unstable */
export function TagPillButton({
	variant,
	className,
	...props
}: ComponentPropsWithRef<"button"> & { variant: TagPillButtonVariant }) {
	return (
		<button
			{...props}
			type="button"
			className={clsx("button", "tag__button", `tag__button--${variant}`, className)}
		>
			{variant === "toggle" ? (
				<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
					<path d={mdiMinus} />
					<path className="tag__toggle-stroke" d="M11 5H13V19H11Z" />
				</svg>
			) : (
				<Icon path={BUTTON_ICON[variant]} size={variant === "edit" ? undefined : 16} />
			)}
		</button>
	);
}

type TagPillOwnProps = {
	color: string;
	label: ReactNode;
	count?: number;
	small?: boolean;
	button?: ReactNode;
	children?: ReactNode;
};

type TagPillProps<E extends ElementType> = TagPillOwnProps & {
	as?: E;
} & Omit<ComponentPropsWithRef<E>, keyof TagPillOwnProps | "as">;

/** A tag shown as a pill in its color. @unstable */
export function TagPill<E extends ElementType = "span">({
	as,
	color,
	label,
	count,
	small,
	button,
	children,
	...rest
}: TagPillProps<E>) {
	const Comp = (as ?? "span") as ElementType;
	const { className, style, ...props } = rest as ComponentPropsWithRef<"span">;
	return (
		<Comp
			{...props}
			className={clsx("tag", small && "is-small", className)}
			style={{ backgroundColor: color, color: textColorFor(color), ...style }}
		>
			{button}
			<span className="tag__text">
				{label}
				{count !== undefined && <small className="mono tag__count">{fmt.format(count)}</small>}
			</span>
			{children}
		</Comp>
	);
}
