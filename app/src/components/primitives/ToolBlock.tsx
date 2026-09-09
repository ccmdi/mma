import type { ReactNode } from "react";
import { Collapsible } from "@base-ui-components/react/collapsible";
import { Icon } from "@/components/primitives/Icon";
import { mdiChevronDown, mdiChevronRight } from "@mdi/js";

interface ToolBlockProps {
	title: string;
	className?: string;
	addons?: ReactNode;
	children?: ReactNode;
	isCollapsed?: boolean;
	onCollapse?: (collapsed: boolean) => void;
	collapsedAddons?: ReactNode;
}

function CollapsibleToolBlock({
	title,
	className,
	addons,
	children,
	isCollapsed,
	onCollapse,
	collapsedAddons,
}: ToolBlockProps & { onCollapse: (collapsed: boolean) => void }) {
	return (
		<Collapsible.Root
			open={!isCollapsed}
			onOpenChange={(open) => onCollapse(!open)}
			className={`tool-block${className ? ` ${className}` : ""}${isCollapsed ? " is-collapsed" : ""}`}
		>
			<header className="tool-block__header">
				<Collapsible.Trigger className="tool-block__title tool-block__title--collapsible">
					{isCollapsed ? <Icon path={mdiChevronRight} /> : <Icon path={mdiChevronDown} />} {title}
				</Collapsible.Trigger>
				{isCollapsed ? collapsedAddons : addons}
			</header>
			<Collapsible.Panel className="tool-block__content">{children}</Collapsible.Panel>
		</Collapsible.Root>
	);
}

function StaticToolBlock({ title, className, addons, children }: ToolBlockProps) {
	return (
		<div className={`tool-block${className ? ` ${className}` : ""}`}>
			<header className="tool-block__header">
				<h2 className="tool-block__title">{title}</h2>
				{addons}
			</header>
			{children}
		</div>
	);
}

export function ToolBlock(props: ToolBlockProps) {
	if (props.onCollapse) {
		return <CollapsibleToolBlock {...props} onCollapse={props.onCollapse} />;
	}
	return <StaticToolBlock {...props} />;
}
