import { useMemo } from "react";
import { procedureEntry, queryProcedure } from "@/lib/data/procedures";
import { useMapState } from "@/store/useMapStore";
import { useAsync } from "@/lib/hooks/useAsync";

const EXACT_DATE_ENTRY = procedureEntry("exactDate");

/** The capture time in unix seconds for one point in a `YYYY-MM` month, or null when the
 *  point is not a candidate in it. The same narrowing an enrichment run does per row. */
function exactDatetime(lat: number, lng: number, imageDate: string): Promise<number | null> {
	return queryProcedure<number | null>(EXACT_DATE_ENTRY, { op: "resolve", lat, lng, imageDate });
}

export function useExactDate(
	panoId: string | null,
	lat: number,
	lng: number,
	yearMonth: string | null,
	enabled: boolean,
) {
	// Subscribe to the active location reactively so extra.datetime updates
	// when switching locations. The other deps (panoId, lat, lng, yearMonth)
	// come from viewer state — which pano in the time slider is being viewed.
	const location = useMapState((s) => s.activeLocation);
	const existingDatetime = location?.extra?.datetime as number | undefined;
	const panoMatchesLocation = panoId != null && panoId === location?.panoId;

	const { data, loading, error } = useAsync<number | null>(() => {
		if (existingDatetime != null && panoMatchesLocation) return existingDatetime;
		if (!enabled || !panoId || !yearMonth) return null;
		return exactDatetime(lat, lng, yearMonth);
	}, [panoId, lat, lng, yearMonth, enabled, existingDatetime, panoMatchesLocation]);

	// Stable identity: this feeds the PanoViewerContext value memo.
	const hasError = error != null;
	return useMemo(() => ({ ts: data, loading, error: hasError }), [data, loading, hasError]);
}
