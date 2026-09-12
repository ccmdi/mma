import { createContext, useContext, useEffect, useRef } from "react";
import { pano, type PanoEvent, type PanoViewer } from "@/lib/sv/pano";

export const PanoContext = createContext<PanoViewer>(pano);

export function usePano(): PanoViewer {
	return useContext(PanoContext);
}

export function usePanoEvent(
	event: PanoEvent,
	handler: () => void,
	deps: React.DependencyList = [],
) {
	const viewer = usePano();
	const ref = useRef(handler);
	ref.current = handler;
	useEffect(() => {
		const fn = () => ref.current();
		const off = viewer.on(event, fn);
		fn();
		return off;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [viewer, event, ...deps]);
}
