import { useCallback } from "react";
import type { MapSettings } from "@/bindings.gen";
import { useMapState, getMapState, updateMapMeta } from "@/store/useMapStore";

export function useMapSetting<K extends keyof MapSettings>(
	key: K,
	defaultValue: NonNullable<MapSettings[K]>,
): [NonNullable<MapSettings[K]>, (v: MapSettings[K]) => void];
export function useMapSetting<K extends keyof MapSettings>(
	key: K,
): [Exclude<MapSettings[K], undefined>, (v: MapSettings[K]) => void];
export function useMapSetting<K extends keyof MapSettings>(
	key: K,
	defaultValue?: NonNullable<MapSettings[K]>,
): [Exclude<MapSettings[K], undefined>, (v: MapSettings[K]) => void] {
	const map = useMapState((s) => s.map);
	const set = useCallback(
		(v: MapSettings[K]) => {
			const settings = getMapState().map?.settings;
			if (settings) {
				void updateMapMeta({ settings: { ...settings, [key]: v } });
			}
		},
		[key],
	);
	const raw = map?.settings?.[key] as Exclude<MapSettings[K], undefined>;
	return [defaultValue !== undefined ? (raw ?? defaultValue) : raw, set] as [
		Exclude<MapSettings[K], undefined>,
		(v: MapSettings[K]) => void,
	];
}
