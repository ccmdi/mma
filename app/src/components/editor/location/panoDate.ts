import { civilToDate, ymFromDate } from "@/lib/util/date";
import { hasLoadAsPanoId, type Pano } from "@/types";
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
	meta: Pano | null,
	timeline: Pano["time"] | null,
	defaultPano: string | null,
	draft: Location | null,
): PanoDateState {
	const entries = timeline ?? [];
	const current = meta?.pano ?? null;
	const chosen = draft && hasLoadAsPanoId(draft) ? current : null;
	const defaultEntry = entries.find((d) => d.pano === defaultPano);
	const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	const currentEntry =
		chosen == null
			? (defaultEntry ?? entries.find((d) => d.pano === current))
			: sorted.find((d) => d.pano === chosen);
	const isDefault = chosen == null;
	const displayDate = currentEntry ? civilToDate(currentEntry.date) : null;
	const triggerPanoId = currentEntry?.pano ?? current ?? sorted[sorted.length - 1]?.pano ?? null;
	const yearMonth = displayDate ? ymFromDate(displayDate) : null;
	return { defaultEntry, sorted, currentEntry, isDefault, displayDate, triggerPanoId, yearMonth };
}
