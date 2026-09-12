import { useEffect, useState } from "react";
import { tagIdsToNames } from "@/store/useMapStore";
import type { Location } from "@/bindings.gen";

/** The tag names staged for the open location, reset when another location opens. */
export function usePendingTags(location: Location | null) {
	const [pendingTags, setPendingTags] = useState<string[]>(() =>
		tagIdsToNames(location?.tags ?? []),
	);
	useEffect(() => {
		setPendingTags((prev) => {
			const next = tagIdsToNames(location?.tags ?? []);
			return prev.length === next.length && prev.every((n, i) => n === next[i]) ? prev : next;
		});
	}, [location?.id]);
	return [pendingTags, setPendingTags] as const;
}
