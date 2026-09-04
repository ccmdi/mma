import { useCallback } from "react";
import { applySelectionUpdate } from "@/store/useMapStore";
import { addSelection, batch } from "@/store/selections";
import { getSettings } from "@/store/settings";
import { cmd } from "@/lib/commands";
import { useHeldHotkeyClick } from "@/lib/map/useHeldHotkeyClick";
import { toast } from "@/lib/util/toast";
import { t } from "@/lib/i18n";

/** Select the country (or subdivision) containing a point, fetching the border file on
 *  first use. Shared by the hold-key gesture and the map context menu. */
export async function selectBorderAt(lat: number, lng: number, subdivision: boolean) {
	const { borderDetail, subdivisionDetail } = getSettings();
	if (subdivision && subdivisionDetail === "off") {
		toast(t("Subdivision borders are off -- enable them in Settings"));
		return;
	}
	const level = subdivision ? subdivisionDetail : borderDetail;
	const lookup = () => cmd.borderLookup(lat, lng, level);
	let geometry;
	try {
		geometry = await lookup();
	} catch (e) {
		if (level === "light" || (await cmd.checkBorderFile(level))) throw e;
		toast(t("Border data missing -- downloading..."));
		try {
			await cmd.downloadBorderFile(level);
		} catch {
			toast(t("Couldn't download border data -- check your connection"));
			return;
		}
		geometry = await lookup();
	}
	if (geometry)
		await applySelectionUpdate(batch(addSelection)([{ type: "Polygon", polygon: geometry }]));
}

export function useCountrySelect() {
	useHeldHotkeyClick(
		"countrySelect",
		useCallback((lat, lng, shiftKey) => void selectBorderAt(lat, lng, shiftKey), []),
		{ ignoreShift: true },
	);
}
