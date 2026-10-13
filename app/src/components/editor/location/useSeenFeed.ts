import { useEffect, useEffectEvent, useMemo } from "react";
import { Seen } from "@/lib/seen/seen";
import { usePano } from "@/lib/hooks/usePano";
import { usePanoViewer } from "./PanoViewerContext";
import { Editor } from "@/store/editor";

/** Record viewed panos, add geocoding when ready, and flush on close.
 *  The location's stored countryCode takes precedence over geocoding. */
export function useSeenFeed() {
	const location = Editor.use((s) => s.open?.location ?? null);
	const origin = Editor.use((s) => s.open?.origin);
	const { geo } = usePanoViewer();
	const pano = usePano();
	const storedCountry =
		typeof location?.extra?.countryCode === "string" ? location.extra.countryCode : null;
	const effectiveGeo = useMemo(
		() => geo && { address: geo.address, countryCode: storedCountry ?? geo.countryCode },
		[geo, storedCountry],
	);
	const getSeed = useEffectEvent(() => ({ location, origin, effectiveGeo }));

	useEffect(() => {
		const { location, origin, effectiveGeo } = getSeed();
		if (!location?.panoId) return;
		Seen.panoChanged(
			{
				locationId: origin === "map" ? location.id : null,
				panoId: location.panoId,
				lat: location.lat,
				lng: location.lng,
			},
			effectiveGeo,
			pano,
		);
	}, [pano, location?.panoId]);

	useEffect(() => {
		if (effectiveGeo) Seen.updateGeo(effectiveGeo);
	}, [effectiveGeo]);

	useEffect(() => {
		if (location?.id == null) return;
		return () => {
			if (pano.exists()) Seen.flush(pano);
		};
	}, [pano, location?.id]);
}
