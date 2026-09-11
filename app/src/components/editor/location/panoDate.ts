import { isPinned } from "@/types";
import type { Pano } from "@/bindings.gen";
import type { Location } from "@/bindings.gen";

export interface PanoDateState {
	defaultEntry: Pano["time"][number] | undefined;
	currentEntry: Pano["time"][number] | undefined;
	isDefault: boolean;
}

/** The date picker's decision: "Default" is the pano Google resolves for the position, a
 *  pinned draft's pano is its choice. The current pano is the sticky answer's own, so it,
 *  the timeline and the default come from one fetch and never disagree mid-walk. */
export function panoDates(
	currentPano: Pano | null,
	timeline: Pano["time"] | null,
	defaultPano: Pano | null,
	draft: Location | null,
): PanoDateState {
	const entries = timeline ?? [];
	const current = currentPano?.id ?? null;
	const chosen = draft && isPinned(draft) ? current : null;
	// Dated from its own stack; the default need not be in the draft's timeline.
	const defaultEntry = defaultPano?.time.find((d) => d.panoId === defaultPano.id);
	const currentEntry =
		chosen == null
			? (defaultEntry ?? entries.find((d) => d.panoId === current))
			: entries.find((d) => d.panoId === chosen);
	return { defaultEntry, currentEntry, isDefault: chosen == null };
}
