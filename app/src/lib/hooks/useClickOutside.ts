import { useEffect, type RefObject } from "react";
import { useStableHandler } from "@/lib/hooks/useStableHandler";

/* Overlay content portaled to <body> (outside every container's DOM); clicks
 * inside it must never count as "outside". Single source for that exemption. */
const PORTAL_SELECTOR = ".picker-positioner, .suggest-portal";

export function useClickOutside(
	ref: RefObject<HTMLElement | null>,
	onOutside: () => void,
	enabled = true,
) {
	const handleOutside = useStableHandler(onOutside);
	useEffect(() => {
		if (!enabled) return;
		const handler = (e: MouseEvent) => {
			const t = e.target as Element;
			if (t.closest?.(PORTAL_SELECTOR)) return;
			if (ref.current && !ref.current.contains(t)) handleOutside();
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [ref, handleOutside, enabled]);
}
