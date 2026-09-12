import { useEffect, useEffectEvent, useMemo } from "react";
import { isVirtualLocation } from "@/types";
import { useMapState } from "@/store/useMapStore";
import { seenPanoChanged, seenUpdateGeo, seenFlush } from "@/lib/seen/seen";
import { singletonPano, capturePov } from "@/lib/sv/panoSingleton";
import { usePanoViewer } from "./PanoViewerContext";

/** Sole feeder of the seen ledger: stages an entry for each pano the viewer walks to,
 *  patches it when the geocode answer lands, flushes it when the location closes. The
 *  location's stored countryCode outranks the geocoder's. */
export function useSeenFeed() {
	const location = useMapState((s) => s.activeLocation);
	const { draft, geo } = usePanoViewer();
	const storedCountry =
		typeof location?.extra?.countryCode === "string" ? location.extra.countryCode : null;
	const effectiveGeo = useMemo(
		() => geo && { address: geo.address, countryCode: storedCountry ?? geo.countryCode },
		[geo, storedCountry],
	);
	const getSeed = useEffectEvent(() => ({ draft, location, effectiveGeo }));

	useEffect(() => {
		const { draft, location, effectiveGeo } = getSeed();
		if (!draft?.panoId || !location) return;
		seenPanoChanged(
			{
				locationId: isVirtualLocation(location) ? null : location.id,
				panoId: draft.panoId,
				lat: draft.lat,
				lng: draft.lng,
			},
			effectiveGeo,
			capturePov,
		);
	}, [draft?.panoId]);

	useEffect(() => {
		if (effectiveGeo) seenUpdateGeo(effectiveGeo);
	}, [effectiveGeo]);

	useEffect(() => {
		if (!location) return;
		return () => {
			if (singletonPano) seenFlush(capturePov);
		};
	}, [location?.id]);
}
