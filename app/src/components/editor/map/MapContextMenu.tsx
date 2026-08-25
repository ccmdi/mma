import { forwardRef } from "react";
import { ContextMenu } from "@base-ui-components/react/context-menu";
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
import { getMapState, duplicateLocation, removeLocations } from "@/store/useMapStore";
import { openDialog } from "@/store/dialogBus";
import { mapsPanoUrl, appendLinkTags, copyMapsLink } from "@/lib/sv/mapsLink";
import { downloadPano } from "@/lib/sv/panoDownload";
import { toast } from "@/lib/util/toast";
import { log } from "@/lib/util/log";
import type { Location } from "@/bindings.gen";
import { t } from "@/lib/i18n";

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
	appendLinkTags(url, loc, getMapState().tags);
	await copyMapsLink(url);
	toast(t("Link copied"), 1500);
}

export const MapContextMenuContent = forwardRef<HTMLDivElement>((_props, ref) => {
	const isMeasuring = useIsMeasuring();
	const anchor = useEventValue("anchor:changed", getLatLngAnchor);
	// Read during render: the popup unmounts on close, so this is the click just handled.
	const { location, latLng } = getContextMenuTarget();
	const polygonCount = polygonsAt(latLng.lat, latLng.lng).length;

	return (
		<ContextMenu.Positioner className="menu-positioner">
			<ContextMenu.Popup className="context-menu" ref={ref}>
				{location && (
					<>
						<ContextMenu.Item
							className="context-menu__item"
							onClick={() => void copyLocationLink(location)}
						>
							{t("Copy Street View link")}
						</ContextMenu.Item>
						<ContextMenu.Item
							className="context-menu__item"
							disabled={!location.panoId}
							onClick={() => void navigator.clipboard.writeText(location.panoId ?? "")}
						>
							{t("Copy pano ID")}
						</ContextMenu.Item>
						<ContextMenu.Item
							className="context-menu__item"
							disabled={!location.panoId}
							onClick={() => {
								if (location.panoId)
									downloadPano(location.panoId).catch((e) => log.error("[download] failed:", e));
							}}
						>
							{t("Download panorama")}
						</ContextMenu.Item>
						<ContextMenu.Item
							className="context-menu__item"
							onClick={() => openDialog("quick-copy-to-map", location.id)}
						>
							{t("Copy to map...")}
						</ContextMenu.Item>
						<ContextMenu.Item
							className="context-menu__item"
							onClick={() => void duplicateLocation(location.id)}
						>
							{t("Duplicate location")}
						</ContextMenu.Item>
						<ContextMenu.Item
							className="context-menu__item"
							onClick={() => void removeLocations(new Set([location.id]))}
						>
							{t("Delete location")}
						</ContextMenu.Item>
						<div className="context-menu__separator" />
					</>
				)}
				{isMeasuring ? (
					<ContextMenu.Item className="context-menu__item" onClick={endMeasure}>
						{t("End measurement")}
					</ContextMenu.Item>
				) : (
					<ContextMenu.Item className="context-menu__item" onClick={() => startMeasure(latLng)}>
						{t("Start measurement")}
					</ContextMenu.Item>
				)}
				<ContextMenu.Item
					className="context-menu__item"
					onClick={() =>
						void navigator.clipboard.writeText(`${latLng.lat.toFixed(6)}, ${latLng.lng.toFixed(6)}`)
					}
				>
					{t("Copy coordinates")}
				</ContextMenu.Item>
				<ContextMenu.Item
					className="context-menu__item"
					onClick={() => void selectBorderAt(latLng.lat, latLng.lng, false)}
				>
					{t("Select this country")}
				</ContextMenu.Item>
				<ContextMenu.Item
					className="context-menu__item"
					onClick={() => void selectBorderAt(latLng.lat, latLng.lng, true)}
				>
					{t("Select this subdivision")}
				</ContextMenu.Item>
				<ContextMenu.Item
					className="context-menu__item"
					disabled={polygonCount === 0}
					onClick={() => deletePolygonsAt(latLng.lat, latLng.lng)}
				>
					{polygonCount > 1
						? t(
								{ one: "Delete {n} polygon here", other: "Delete {n} polygons here" },
								{ n: polygonCount },
							)
						: t("Delete this polygon")}
				</ContextMenu.Item>
				<ContextMenu.Item className="context-menu__item" onClick={() => setLatLngAnchor(latLng)}>
					{t("Set latitude/longitude anchors")}
				</ContextMenu.Item>
				<ContextMenu.Item
					className="context-menu__item"
					disabled={!anchor}
					onClick={() => setLatLngAnchor(null)}
				>
					{t("Clear latitude/longitude anchors")}
				</ContextMenu.Item>
			</ContextMenu.Popup>
		</ContextMenu.Positioner>
	);
});
