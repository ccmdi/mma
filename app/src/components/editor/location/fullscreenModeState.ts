import { getSettings, setSetting } from "@/store/settings";

/** Pano fullscreen temporarily replaced fullscreen-map mode. */
let suspendedFullscreenMap = false;
/** Fullscreen-map temporarily replaced pano fullscreen. */
let suspendedPanoFullscreen = false;

let setPanoFullscreenImpl: ((value: boolean) => void) | null = null;

export function registerPanoFullscreenSetter(setter: (value: boolean) => void): () => void {
	setPanoFullscreenImpl = setter;
	return () => {
		if (setPanoFullscreenImpl === setter) setPanoFullscreenImpl = null;
	};
}

export function restoreSuspendedFullscreenMap(): void {
	if (!suspendedFullscreenMap) return;
	suspendedFullscreenMap = false;
	setSetting("fullscreenMap", true);
}

export function clearSuspendedFullscreenMap(): void {
	suspendedFullscreenMap = false;
}

export function suspendFullscreenMapForPano(): void {
	if (getSettings().fullscreenMap) {
		suspendedFullscreenMap = true;
		setSetting("fullscreenMap", false);
	}
}

export function resumeFullscreenMapAfterPano(): void {
	restoreSuspendedFullscreenMap();
}

export function suspendPanoFullscreenForMap(): void {
	suspendedPanoFullscreen = true;
}

export function clearSuspendedPanoFullscreen(): void {
	suspendedPanoFullscreen = false;
}

export function resumePanoFullscreenAfterMap(setIsFullscreen?: (value: boolean) => void): void {
	if (!suspendedPanoFullscreen) return;
	suspendedPanoFullscreen = false;
	const apply = setIsFullscreen ?? setPanoFullscreenImpl;
	apply?.(true);
}

/** Exit fullscreen-map and restore suspended pano fullscreen when applicable. */
export function exitFullscreenMap(setIsFullscreen?: (value: boolean) => void): void {
	if (!getSettings().fullscreenMap) return;
	setSetting("fullscreenMap", false);
	resumePanoFullscreenAfterMap(setIsFullscreen);
}

export function enterFullscreenMapFromPano(isFullscreen: boolean, setIsFullscreen: (value: boolean) => void): void {
	if (isFullscreen) {
		suspendPanoFullscreenForMap();
		setIsFullscreen(false);
	}
	setSetting("fullscreenMap", true);
}

export function exitFullscreenMapToggle(setIsFullscreen?: (value: boolean) => void): void {
	setSetting("fullscreenMap", false);
	resumePanoFullscreenAfterMap(setIsFullscreen);
}

export function clearAllFullscreenSuspensions(): void {
	clearSuspendedFullscreenMap();
	clearSuspendedPanoFullscreen();
}
