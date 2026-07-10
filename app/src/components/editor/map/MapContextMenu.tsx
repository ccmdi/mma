import { forwardRef } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
	useMeasureState,
	startMeasure,
	endMeasure,
	useLatLngAnchor,
	setLatLngAnchor,
	getContextMenuTarget,
} from "@/lib/sv/measure";
import { hostInstance, type MapHost } from "@/lib/map/host";

interface MapContextMenuProps {
	host: MapHost | null;
}

export const MapContextMenuContent = forwardRef<HTMLDivElement, MapContextMenuProps>(
	({ host }, ref) => {
		const { isMeasuring } = useMeasureState();
		const anchor = useLatLngAnchor();
		// The measure tool is Google-only (measuretool-googlemaps-v3).
		const gMap = hostInstance(host, "google");

		return (
			<ContextMenu.Content className="context-menu" ref={ref}>
				{isMeasuring ? (
					<ContextMenu.Item className="context-menu__item" onSelect={endMeasure}>
						End measurement
					</ContextMenu.Item>
				) : (
					gMap && (
						<ContextMenu.Item
							className="context-menu__item"
							onSelect={() => {
								startMeasure(gMap, getContextMenuTarget().latLng);
							}}
						>
							Start measurement
						</ContextMenu.Item>
					)
				)}
				<ContextMenu.Item
					className="context-menu__item"
					onSelect={() => {
						const { lat, lng } = getContextMenuTarget().latLng;
						navigator.clipboard.writeText(`${lat.toFixed(6)}, ${lng.toFixed(6)}`);
					}}
				>
					Copy coordinates
				</ContextMenu.Item>
				<ContextMenu.Item
					className="context-menu__item"
					onSelect={() => setLatLngAnchor(getContextMenuTarget().latLng)}
				>
					Set latitude/longitude anchors
				</ContextMenu.Item>
				<ContextMenu.Item
					className="context-menu__item"
					disabled={!anchor}
					onSelect={() => setLatLngAnchor(null)}
				>
					Clear latitude/longitude anchors
				</ContextMenu.Item>
			</ContextMenu.Content>
		);
	},
);
