import { useEffect, useEffectEvent, useMemo } from "react";
import { useMapState } from "@/store/useMapStore";
import { seenPanoChanged, seenUpdateGeo, seenFlush } from "@/lib/seen/seenRecorder";
import { usePano } from "@/lib/hooks/usePano";
import { usePanoViewer } from "./PanoViewerContext";

/** Record viewed panos, add geocoding when ready, and flush on close.
 *  The location's stored countryCode takes precedence over geocoding. */
export function useSeenFeed() {
	const location = useMapState((s) => s.open?.row ?? null);
	const origin = useMapState((s) => s.open?.origin);
	const { draft, geo } = usePanoViewer();
	const pano = usePano();
	const storedCountry =
		typeof location?.extra?.countryCode === "string" ? location.extra.countryCode : null;
	const effectiveGeo = useMemo(
		() => geo && { address: geo.address, countryCode: storedCountry ?? geo.countryCode },
		[geo, storedCountry],
	);
	const getSeed = useEffectEvent(() => ({ draft, location, origin, effectiveGeo }));

	useEffect(() => {
		const { draft, location, origin, effectiveGeo } = getSeed();
		if (!draft?.panoId || !location) return;
		seenPanoChanged(
			{
				locationId: origin === "map" ? location.id : null,
				panoId: draft.panoId,
				lat: draft.lat,
				lng: draft.lng,
			},
			effectiveGeo,
			pano,
		);
	}, [pano, draft?.panoId]);

	useEffect(() => {
		if (effectiveGeo) seenUpdateGeo(effectiveGeo);
	}, [effectiveGeo]);

	useEffect(() => {
		if (!location) return;
		return () => {
			if (pano.exists()) seenFlush(pano);
		};
	}, [pano, location?.id]);
}
