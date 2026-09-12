import { useEffect, useRef } from "react";
import { pano, type PanoEvent } from "@/lib/sv/pano";

export function usePanoEvent(
	event: PanoEvent,
	handler: () => void,
	deps: React.DependencyList = [],
) {
	const ref = useRef(handler);
	ref.current = handler;
	useEffect(() => {
		const fn = () => ref.current();
		const off = pano.on(event, fn);
		fn();
		return off;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [event, ...deps]);
}
