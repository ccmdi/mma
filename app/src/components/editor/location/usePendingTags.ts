import { useEffect, useState } from "react";
import { Tag } from "@/store/tag";
import type { Location } from "@/bindings.gen";

/** The tag names staged for the open location, reset when another location opens. */
export function usePendingTags(location: Location | null) {
	const [pendingTags, setPendingTags] = useState<string[]>(() => Tag.names(location?.tags ?? []));
	useEffect(() => {
		setPendingTags((prev) => {
			const next = Tag.names(location?.tags ?? []);
			return prev.length === next.length && prev.every((n, i) => n === next[i]) ? prev : next;
		});
	}, [location?.id]);
	return [pendingTags, setPendingTags] as const;
}
