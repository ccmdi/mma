import { useCallback } from "react";
import type { MapSettings } from "@/bindings.gen";
import { useCurrentMap, getCurrentMap, updateMapMeta } from "@/store/useMapStore";

/**
 * Reactive accessor for a single per-map setting. The setter is identity-stable
 * (reads the live settings at call time) so it can be a memo'd component prop.
 */
export function useMapSetting<K extends keyof MapSettings>(
	key: K,
): [Exclude<MapSettings[K], undefined>, (v: MapSettings[K]) => void] {
	const map = useCurrentMap();
	const set = useCallback(
		(v: MapSettings[K]) => {
			const settings = getCurrentMap()?.meta.settings;
			if (settings) updateMapMeta({ settings: { ...settings, [key]: v } });
		},
		[key],
	);
	// Rust always materializes complete settings, so the value is present
	// whenever a map is open (the only context this hook is used). `Exclude`
	// strips the `undefined` from the optional binding while keeping `| null`.
	return [map?.meta.settings?.[key] as Exclude<MapSettings[K], undefined>, set];
}
