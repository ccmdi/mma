import { createSyncStore } from "@/lib/util/syncStore";
import { getLocal, setLocal, subscribeLocal } from "@/lib/hooks/useLocalStorage";
import { type MapEmbedPrefs, DEFAULT_PREFS } from "@/store/mapEmbedPrefs";

const MAP_EMBED_PREFS_KEY = "mapEmbedPrefs";

const suppressStore = createSyncStore();
let svCoverageSuppressed = false;

/** When true, Google SV blue-line coverage is forced to opacity 0 and GSV pano dots are omitted. */
export function setSvCoverageSuppressed(suppressed: boolean) {
	if (svCoverageSuppressed === suppressed) return;
	svCoverageSuppressed = suppressed;
	suppressStore.notify();
}

export function isSvCoverageSuppressed(): boolean {
	return svCoverageSuppressed;
}

export function subscribeSvCoverageSuppressed(cb: () => void): () => void {
	return suppressStore.subscribe(cb);
}

export function getMapEmbedPrefs(): MapEmbedPrefs {
	return getLocal(MAP_EMBED_PREFS_KEY, DEFAULT_PREFS);
}

export function patchMapEmbedPrefs(patch: Partial<MapEmbedPrefs>): void {
	setLocal(MAP_EMBED_PREFS_KEY, { ...getMapEmbedPrefs(), ...patch });
}

export function subscribeMapEmbedPrefs(cb: () => void): () => void {
	return subscribeLocal(MAP_EMBED_PREFS_KEY, cb);
}
