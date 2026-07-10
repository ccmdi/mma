import { useMemo } from "react";
import { resolveExactTimestamp } from "@/lib/sv/exactDate";
import { useActiveLocation } from "@/store/useMapStore";
import { useAsync } from "@/lib/hooks/useAsync";

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
	const location = useActiveLocation();
	const existingDatetime = location?.extra?.datetime as number | undefined;
	const panoMatchesLocation = panoId != null && panoId === location?.panoId;

	const { data, loading, error } = useAsync<number | null>(() => {
		if (existingDatetime != null && panoMatchesLocation) return existingDatetime;
		if (!enabled || !panoId || !yearMonth) return null;
		return resolveExactTimestamp(lat, lng, yearMonth);
	}, [panoId, lat, lng, yearMonth, enabled, existingDatetime, panoMatchesLocation]);

	// Stable identity: this feeds the PanoViewerContext value memo.
	const hasError = error != null;
	return useMemo(() => ({ ts: data, loading, error: hasError }), [data, loading, hasError]);
}
