import { imageDateOf } from "@/lib/sv/getMetadata";
import { civilToDate, ymFromDate, ymToDate } from "@/lib/util/date";
import type { Pano } from "@/types";
import type { ViewerPano } from "./PanoViewerContext";

export interface PanoDateState {
	defaultEntry: Pano["time"][number] | undefined;
	sorted: Pano["time"];
	currentEntry: Pano["time"][number] | undefined;
	isDefault: boolean;
	displayDate: Date | null;
	triggerPanoId: string | null;
	yearMonth: string | null;
}

/** Derive a date picker's view labels and exact-date resolution inputs from pano-viewer
 *  state. Pure, so the resolution can be hoisted to a single owner and every picker reads
 *  the same result instead of each running the expensive lookup. */
export function derivePanoDateState(
	panoDates: Pano["time"],
	selectedPanoId: string | null,
	currentPano: ViewerPano | null,
	defaultPanoId: string | null,
): PanoDateState {
	const defaultEntry = panoDates.find((d) => d.pano === defaultPanoId);
	const resolvedEntry = currentPano
		? panoDates.find((d) => d.pano === currentPano.pano)
		: undefined;
	const sorted = [...panoDates].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	const currentEntry =
		selectedPanoId == null
			? (defaultEntry ?? resolvedEntry)
			: sorted.find((d) => d.pano === selectedPanoId);
	const isDefault = selectedPanoId == null;
	const displayDate = currentEntry
		? civilToDate(currentEntry.date)
		: isDefault && currentPano
			? ymToDate(imageDateOf(currentPano))
			: null;
	const triggerPanoId =
		currentEntry?.pano ??
		currentPano?.pano ??
		sorted[sorted.length - 1]?.pano ??
		defaultPanoId;
	const yearMonth = displayDate ? ymFromDate(displayDate) : null;
	return { defaultEntry, sorted, currentEntry, isDefault, displayDate, triggerPanoId, yearMonth };
}
