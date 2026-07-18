import { useMemo } from "react";
import { resolveExactTimestamp } from "@/lib/sv/exactDate";
import { findPanoProvider } from "@/lib/sv/panoProvider";
import { getLocationProvider } from "@/lib/sv/providers/types";
import { baiduSpawnPanoId } from "@/lib/sv/baidu/session";
import { isBaiduPanoId } from "@/lib/sv/baidu/prefix";
import { tencentSpawnPanoId } from "@/lib/sv/tencent/session";
import { isTencentPanoId } from "@/lib/sv/tencent/prefix";
import { useActiveLocation } from "@/store/useMapStore";
import { useAsync } from "@/lib/hooks/useAsync";

export function useExactDate(
	panoId: string | null,
	lat: number,
	lng: number,
	yearMonth: string | null,
	enabled: boolean,
	/** Capture time from the selected panoDates entry (alt-provider alternate dates). */
	captureDate: Date | null = null,
) {
	const location = useActiveLocation();
	const existingDatetime = location?.extra?.datetime as number | undefined;
	const provider = location ? findPanoProvider(location) : null;
	const isBaidu =
		(location != null && getLocationProvider(location) === "baidu") || isBaiduPanoId(panoId);
	const isTencent =
		(location != null && getLocationProvider(location) === "tencent") || isTencentPanoId(panoId);
	const spawnId = location
		? isBaidu
			? baiduSpawnPanoId(location)
			: isTencent
				? tencentSpawnPanoId(location)
				: provider?.getSpawnPanoId
					? provider.getSpawnPanoId(location)
					: null
		: null;
	const ownsExactDate = Boolean(provider?.ownsExactDate) || isBaidu || isTencent;
	const panoMatchesLocation =
		panoId != null && (panoId === location?.panoId || (spawnId != null && panoId === spawnId));
	const captureTs =
		captureDate != null && Number.isFinite(captureDate.getTime())
			? Math.floor(captureDate.getTime() / 1000)
			: null;

	const { data, loading, error } = useAsync<number | null>(() => {
		// Alt / Baidu own their timestamps — never hit Google exact-date RPC.
		if (ownsExactDate) {
			if (captureTs != null) return captureTs;
			if (panoMatchesLocation || (spawnId != null && panoId === spawnId)) {
				return existingDatetime ?? null;
			}
			return null;
		}
		if (existingDatetime != null && panoMatchesLocation) return existingDatetime;
		if (!enabled || !panoId || !yearMonth) return null;
		return resolveExactTimestamp(lat, lng, yearMonth);
	}, [
		panoId,
		lat,
		lng,
		yearMonth,
		enabled,
		existingDatetime,
		panoMatchesLocation,
		ownsExactDate,
		spawnId,
		captureTs,
	]);

	const hasError = error != null;
	return useMemo(() => ({ ts: data, loading, error: hasError }), [data, loading, hasError]);
}
