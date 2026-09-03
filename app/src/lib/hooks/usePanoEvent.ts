import { useEffect, useRef } from "react";
import { google } from "@/lib/sv/opensv";

export function usePanoEvent(
	panorama: google.maps.StreetViewPanorama | null,
	event: string,
	handler: () => void,
	deps: React.DependencyList = [],
) {
	const ref = useRef(handler);
	ref.current = handler;
	useEffect(() => {
		if (!panorama) return;
		const fn = () => ref.current();
		const listener = panorama.addListener(event, fn);
		fn();
		return () => {
			google?.maps?.event?.removeListener(listener);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [panorama, event, ...deps]);
}
