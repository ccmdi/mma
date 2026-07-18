import { useCallback } from "react";
import type { Location } from "@/bindings.gen";
import { getSettings } from "@/store/settings";
import { useHotkey } from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys";
import { useActiveLocation } from "@/store/useMapStore";
import { usePanoViewer } from "./PanoViewerContext";
import {
	enterFullscreenMapFromPano,
	exitFullscreenMapToggle,
	resumeFullscreenMapAfterPano,
	suspendFullscreenMapForPano,
} from "./fullscreenModeState";

export function togglePanoFullscreenState(
	location: Location | null,
	isFullscreen: boolean,
	setIsFullscreen: (value: boolean) => void,
): void {
	if (!location) return;
	const next = !isFullscreen;
	if (next) suspendFullscreenMapForPano();
	else resumeFullscreenMapAfterPano();
	setIsFullscreen(next);
}

export function toggleMapFullscreenState(
	isFullscreen: boolean,
	setIsFullscreen: (value: boolean) => void,
): void {
	const next = !getSettings().fullscreenMap;
	if (next) enterFullscreenMapFromPano(isFullscreen, setIsFullscreen);
	else exitFullscreenMapToggle(setIsFullscreen);
}

/** Keeps fullscreen-map and pano-fullscreen shortcuts in sync (entering one exits the other). */
export function useFullscreenModeHotkeys() {
	const location = useActiveLocation();
	const { isFullscreen, setIsFullscreen } = usePanoViewer();

	const togglePanoFullscreen = useCallback(
		() => togglePanoFullscreenState(location, isFullscreen, setIsFullscreen),
		[location, isFullscreen, setIsFullscreen],
	);

	const toggleMapFullscreen = useCallback(
		() => toggleMapFullscreenState(isFullscreen, setIsFullscreen),
		[isFullscreen, setIsFullscreen],
	);

	useHotkey(useBinding("toggleFullscreen"), togglePanoFullscreen);
	useHotkey(useBinding("toggleFullscreenMap"), toggleMapFullscreen);

	return { togglePanoFullscreen, toggleMapFullscreen };
}
