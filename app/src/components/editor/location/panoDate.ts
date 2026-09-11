import { civilToDate, ymFromDate } from "@/lib/util/date";
import { isPinned } from "@/types";
import type { Pano } from "@/bindings.gen";
import type { Location } from "@/bindings.gen";

export interface PanoDateState {
	defaultEntry: Pano["time"][number] | undefined;
	sorted: Pano["time"];
	currentEntry: Pano["time"][number] | undefined;
	isDefault: boolean;
	displayDate: Date | null;
	triggerPanoId: string | null;
	yearMonth: string | null;
}

/** The date picker's view of the viewer: "Default" is the pano Google resolves for the
 *  position, a pinned draft's pano is its choice. The current pano is the sticky answer's
 *  own, so it, the timeline and the default come from one fetch and never disagree mid-walk. */
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
	const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	const currentEntry =
		chosen == null
			? (defaultEntry ?? entries.find((d) => d.panoId === current))
			: sorted.find((d) => d.panoId === chosen);
	const isDefault = chosen == null;
	const displayDate = currentEntry ? civilToDate(currentEntry.date) : null;
	const triggerPanoId = currentEntry?.panoId ?? current ?? sorted[sorted.length - 1]?.panoId ?? null;
	const yearMonth = displayDate ? ymFromDate(displayDate) : null;
	return { defaultEntry, sorted, currentEntry, isDefault, displayDate, triggerPanoId, yearMonth };
}
