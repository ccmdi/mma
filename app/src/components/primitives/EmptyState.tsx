import type { ReactNode } from "react";
import clsx from "clsx";
import { Icon } from "@/components/primitives/Icon";

/** A message for a panel or list with nothing to show, with an optional icon. `compact` fits it
 *  inline in a list. */
export function EmptyState({
	icon,
	compact,
	children,
}: {
	icon?: string;
	compact?: boolean;
	children: ReactNode;
}) {
	return (
		<div className={clsx("empty-state", compact && "empty-state--compact")}>
			{icon && <Icon path={icon} size={compact ? 18 : 28} className="empty-state__icon" />}
			<div>{children}</div>
		</div>
	);
}
