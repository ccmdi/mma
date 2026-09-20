import { forwardRef, useEffect, useState } from "react";
import {
	useIsMeasuring,
	startMeasure,
	endMeasure,
	getLatLngAnchor,
	setLatLngAnchor,
} from "@/lib/sv/measure";
import { useEventValue } from "@/lib/events";
import { getContextMenuTarget } from "@/lib/map/contextMenu";
import { selectBorderAt } from "@/lib/map/useCountrySelect";
import { polygonsAt, deletePolygonsAt } from "@/lib/map/useDeletePolygon";
import { duplicateLocation, removeLocations, getTags } from "@/store/useMapStore";
import { openDialog } from "@/store/dialogBus";
import { mapsPanoUrl, appendLinkTags, copyMapsLink } from "@/lib/sv/mapsLink";
import { downloadPano } from "@/lib/sv/panoDownload";
import { toast } from "@/lib/util/toast";
import { log } from "@/lib/util/log";
import type { Location } from "@/bindings.gen";
import { t } from "@/lib/i18n";
import { MenuPopup, MenuItem, MenuSeparator } from "@/components/primitives/Menu";

/** Copy a google.com/maps link aimed at the location's saved camera. Shortened when the
 *  service answers, long URL otherwise -- both open the same view. */
async function copyLocationLink(loc: Location) {
	const url = mapsPanoUrl({
		lat: loc.lat,
		lng: loc.lng,
		heading: loc.heading,
		pitch: loc.pitch,
		zoom: loc.zoom,
		panoId: loc.panoId ?? "",
	});
	appendLinkTags(url, loc, getTags());
	await copyMapsLink(url);
	toast(t("Link copied"), 1500);
}

export const MapContextMenuContent = forwardRef<HTMLDivElement>((_props, ref) => {
	const isMeasuring = useIsMeasuring();
	const anchor = useEventValue("anchor:changed", getLatLngAnchor);
	// Read during render: the popup unmounts on close, so this is the click just handled.
	const { location, latLng } = getContextMenuTarget();
	const [polygonCount, setPolygonCount] = useState(0);
	useEffect(() => {
		let live = true;
		void polygonsAt(latLng.lat, latLng.lng).then((keys) => {
			if (live) setPolygonCount(keys.length);
		});
		return () => {
			live = false;
		};
	}, [latLng.lat, latLng.lng]);

	return (
		<MenuPopup ref={ref}>
			{location && (
				<>
					<MenuItem onClick={() => void copyLocationLink(location)}>
						{t("Copy Street View link")}
					</MenuItem>
					<MenuItem
						disabled={!location.panoId}
						onClick={() => void navigator.clipboard.writeText(location.panoId ?? "")}
					>
						{t("Copy pano ID")}
					</MenuItem>
					<MenuItem
						disabled={!location.panoId}
						onClick={() => {
							if (location.panoId)
								downloadPano(location.panoId).catch((e) => log.error("[download] failed:", e));
						}}
					>
						{t("Download panorama")}
					</MenuItem>
					<MenuItem onClick={() => openDialog("quick-copy-to-map", location.id)}>
						{t("Copy to map...")}
					</MenuItem>
					<MenuItem onClick={() => void duplicateLocation(location.id)}>
						{t("Duplicate location")}
					</MenuItem>
					<MenuItem tone="destructive" onClick={() => void removeLocations(new Set([location.id]))}>
						{t("Delete location")}
					</MenuItem>
					<MenuSeparator />
				</>
			)}
			{isMeasuring ? (
				<MenuItem onClick={endMeasure}>{t("End measurement")}</MenuItem>
			) : (
				<MenuItem onClick={() => startMeasure(latLng)}>{t("Start measurement")}</MenuItem>
			)}
			<MenuItem
				onClick={() =>
					void navigator.clipboard.writeText(`${latLng.lat.toFixed(6)}, ${latLng.lng.toFixed(6)}`)
				}
			>
				{t("Copy coordinates")}
			</MenuItem>
			<MenuItem onClick={() => void selectBorderAt(latLng.lat, latLng.lng, false)}>
				{t("Select this country")}
			</MenuItem>
			<MenuItem onClick={() => void selectBorderAt(latLng.lat, latLng.lng, true)}>
				{t("Select this subdivision")}
			</MenuItem>
			<MenuItem
				tone="destructive"
				disabled={polygonCount === 0}
				onClick={() => void deletePolygonsAt(latLng.lat, latLng.lng)}
			>
				{polygonCount > 1
					? t(
							{ one: "Delete {n} polygon here", other: "Delete {n} polygons here" },
							{ n: polygonCount },
						)
					: t("Delete this polygon")}
			</MenuItem>
			<MenuItem onClick={() => setLatLngAnchor(latLng)}>
				{t("Set latitude/longitude anchors")}
			</MenuItem>
			<MenuItem disabled={!anchor} onClick={() => setLatLngAnchor(null)}>
				{t("Clear latitude/longitude anchors")}
			</MenuItem>
		</MenuPopup>
	);
});
