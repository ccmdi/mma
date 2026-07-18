import { type PanoReference, parsePanoDate } from "@/lib/sv/lookup";
import { panoDayFmt } from "@/lib/util/format";

type CurrentPano = Pick<google.maps.StreetViewPanoramaData, "location" | "imageDate"> | null;

export interface PanoDateState {
	defaultEntry: PanoReference | undefined;
	sorted: PanoReference[];
	currentEntry: PanoReference | undefined;
	isDefault: boolean;
	displayDate: Date | null;
	triggerPanoId: string | null;
	yearMonth: string | null;
}

/** One entry per displayed day; `preferPanoId` wins when multiple panos share a day. */
export function dedupePanoReferencesByDay(
	refs: PanoReference[],
	preferPanoId: string | null,
): PanoReference[] {
	const byDay = new Map<string, PanoReference>();
	for (const ref of refs) {
		const day = panoDayFmt.format(ref.date);
		const prev = byDay.get(day);
		if (!prev) {
			byDay.set(day, ref);
			continue;
		}
		if (preferPanoId && ref.pano === preferPanoId) {
			byDay.set(day, ref);
		} else if (preferPanoId && prev.pano === preferPanoId) {
			continue;
		} else if (ref.date.getTime() < prev.date.getTime()) {
			byDay.set(day, ref);
		}
	}
	return [...byDay.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Map provider alternate-date entries into history list refs, deduped once by day. */
export function providerEntriesToPanoDates(
	entries: { pano: string; timestamp: number; cameraType?: string }[],
	preferPanoId: string | null,
): PanoReference[] {
	return dedupePanoReferencesByDay(
		entries.map((e) => ({
			pano: e.pano,
			date: new Date(e.timestamp),
			cameraType: e.cameraType,
		})),
		preferPanoId,
	);
}

/** Derive a date picker's view labels and exact-date resolution inputs from pano-viewer
 *  state. Pure, so the resolution can be hoisted to a single owner and every picker reads
 *  the same result instead of each running the expensive lookup.
 *
 *  `defaultDate` supplies a day-level capture time when the default pano is not in
 *  `panoDates`. The currently viewed pano is always kept in the Specific list. */
export function derivePanoDateState(
	panoDates: PanoReference[],
	selectedPanoId: string | null,
	currentPano: CurrentPano,
	defaultPanoId: string | null,
	defaultDate: Date | null = null,
): PanoDateState {
	const currentId = currentPano?.location?.pano ?? null;
	const defaultEntry =
		panoDates.find((d) => d.pano === defaultPanoId) ??
		(defaultPanoId && defaultDate
			? { pano: defaultPanoId, date: defaultDate }
			: undefined);
	const resolvedEntry = currentId
		? panoDates.find((d) => d.pano === currentId)
		: undefined;

	// Specific = non-default dates, plus the default pano when we know the
	// current view (so it stays selectable while browsing historical captures).
	const sorted = panoDates
		.filter((d) => {
			if (d.pano !== defaultPanoId) return true;
			return currentId != null;
		})
		.sort((a, b) => a.date.getTime() - b.date.getTime());

	const currentEntry =
		selectedPanoId == null
			? (defaultEntry ?? resolvedEntry)
			: sorted.find((d) => d.pano === selectedPanoId) ??
				panoDates.find((d) => d.pano === selectedPanoId);
	const isDefault = selectedPanoId == null;
	const displayDate =
		currentEntry?.date ??
		defaultDate ??
		(isDefault && currentPano?.imageDate ? parsePanoDate(currentPano.imageDate) : null);
	const triggerPanoId =
		currentEntry?.pano ??
		currentId ??
		defaultPanoId ??
		sorted[sorted.length - 1]?.pano ??
		null;
	const yearMonth = displayDate
		? `${displayDate.getFullYear()}-${String(displayDate.getMonth() + 1).padStart(2, "0")}`
		: null;
	return { defaultEntry, sorted, currentEntry, isDefault, displayDate, triggerPanoId, yearMonth };
}
