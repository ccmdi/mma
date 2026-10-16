import { useCallback } from "react";
import { Store } from "@/store/store";
import { SelectionList } from "@/store/selectionList";
import { cmd } from "@/lib/commands";
import { useHeldHotkeyClick } from "@/lib/map/useHeldHotkeyClick";

/** Keys of the polygon selections covering a point. */
export async function polygonsAt(lat: number, lng: number): Promise<string[]> {
	const polygons = Store.get().selectionList.flatMap(({ selection: s }) =>
		s.selector.type === "Polygon" ? [{ key: s.key, polygon: s.selector.polygon }] : [],
	);
	const hits = await Promise.all(
		polygons.map((p) => cmd.polygonContainsPoints(p.polygon, [lat], [lng])),
	);
	return polygons.filter((_, i) => hits[i][0]).map((p) => p.key);
}

/** Drop every polygon selection covering a point. Shared by the hold-key gesture and the
 *  map context menu. */
export async function deletePolygonsAt(lat: number, lng: number): Promise<void> {
	const keys = await polygonsAt(lat, lng);
	if (keys.length) void SelectionList.update({ kind: "remove", keys });
}

export function useDeletePolygon() {
	useHeldHotkeyClick(
		"deletePolygon",
		useCallback((lat, lng) => void deletePolygonsAt(lat, lng), []),
	);
}
