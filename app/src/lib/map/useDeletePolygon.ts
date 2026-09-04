import { useCallback } from "react";
import { getMapState, applySelectionUpdate } from "@/store/useMapStore";
import { batch, polygonSelectionsContaining, removeSelection } from "@/store/selections";
import { useHeldHotkeyClick } from "@/lib/map/useHeldHotkeyClick";

/** Keys of the polygon selections covering a point. */
export function polygonsAt(lat: number, lng: number): string[] {
	return polygonSelectionsContaining(getMapState().selections, lat, lng);
}

/** Drop every polygon selection covering a point. Shared by the hold-key gesture and the
 *  map context menu. */
export function deletePolygonsAt(lat: number, lng: number): void {
	const keys = polygonsAt(lat, lng);
	if (keys.length) void applySelectionUpdate(batch(removeSelection)(keys));
}

export function useDeletePolygon() {
	useHeldHotkeyClick(
		"deletePolygon",
		useCallback((lat, lng) => deletePolygonsAt(lat, lng), []),
	);
}
