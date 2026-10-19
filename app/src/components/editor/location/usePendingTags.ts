import { useEffect, useState } from "react";
import type { PendingTags } from "@/lib/data/tags";
import type { Location } from "@/bindings.gen";

/** The tags staged for the open location, reset when another location opens. */
export function usePendingTags(location: Location | null) {
	const [pendingTags, setPendingTags] = useState<PendingTags>(() => ({
		ids: location?.tags ?? [],
		names: [],
	}));
	useEffect(() => {
		setPendingTags({ ids: location?.tags ?? [], names: [] });
	}, [location?.id]);
	return [pendingTags, setPendingTags] as const;
}
