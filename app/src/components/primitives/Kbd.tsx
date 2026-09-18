import type { ReactNode } from "react";
import { formatBinding } from "@/lib/hooks/useHotkey";

/** A key or shortcut, from a stored binding or written out. */
export function Kbd(props: { binding: string } | { children: ReactNode }) {
	return (
		<kbd className="kbd">{"binding" in props ? formatBinding(props.binding) : props.children}</kbd>
	);
}
