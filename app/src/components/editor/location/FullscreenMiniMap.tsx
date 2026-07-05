import { useEffect, useRef, useState } from "react";
import { GoogleMapsOverlay } from "@deck.gl/google-maps";
import { google } from "@/lib/sv/opensv";
import { resolveStackForPrefs, CUSTOM_STYLES_KEY, type CustomStyle } from "@/lib/geo/mapStack";
import { getStyleBackgroundColor } from "@/lib/geo/mapStyles";
import { useMapSurface } from "@/lib/render/useMapSurface";
import { useSetting, setSetting } from "@/store/settings";
import { range, clamp } from "@/types/util";
import { useLocalStorage, getLocal } from "@/lib/hooks/useLocalStorage";
import { type MapEmbedPrefs, DEFAULT_PREFS } from "@/store/mapEmbedPrefs";
import { usePanoViewer } from "./PanoViewerContext";

const MINIMAP_SCALE = range([0.5, 2]);
const MINIMAP_SCALE_STEP = 0.5;
const MINIMAP_BASE_W = 800;
const MINIMAP_BASE_H = 600;
const MINIMAP_CLOSE_DELAY = 500;

let minimapMap: google.maps.Map | null = null;
let minimapDiv: HTMLDivElement | null = null;
let minimapOverlay: GoogleMapsOverlay | null = null;

function ensureMinimapMap(
	prefs: MapEmbedPrefs,
	lat: number,
	lng: number,
): { map: google.maps.Map; div: HTMLDivElement; overlay: GoogleMapsOverlay } {
	if (!minimapDiv) {
		minimapDiv = document.createElement("div");
		minimapDiv.style.cssText = "width:100%;height:100%";
	}
	if (!minimapMap) {
		const customType = resolveStackForPrefs(prefs, {
			useBlobby: prefs.svBlobby,
			customStyles: getLocal<CustomStyle[]>(CUSTOM_STYLES_KEY, []),
		}).mapType;
		minimapMap = new google.maps.Map(minimapDiv, {
			center: { lat, lng },
			zoom: 14,
			disableDefaultUI: true,
			gestureHandling: "greedy",
			draggableCursor: "crosshair",
			backgroundColor: getStyleBackgroundColor(prefs.mapStyleName),
			mapTypeId: "custom",
			mapTypeControlOptions: { mapTypeIds: ["custom"] },
		});
		minimapMap.mapTypes.set("custom", customType);
	}
	if (!minimapOverlay) {
		minimapOverlay = new GoogleMapsOverlay({ layers: [], pickingRadius: 2 });
		minimapOverlay.setMap(minimapMap);
	}
	return { map: minimapMap, div: minimapDiv, overlay: minimapOverlay };
}

export function FullscreenMiniMap() {
	const { lat, lng } = usePanoViewer();
	const containerRef = useRef<HTMLDivElement>(null);
	const scale = useSetting("fullscreenMinimapScale");
	const [expanded, setExpanded] = useState(false);
	const closeTimer = useRef<number | null>(null);
	const [prefs] = useLocalStorage<MapEmbedPrefs>("mapEmbedPrefs", DEFAULT_PREFS);

	const { map, div, overlay } = ensureMinimapMap(prefs, lat, lng);

	useMapSurface(map, {
		prefs,
		followActive: true,
		overlay,
	});

	useEffect(() => {
		if (!containerRef.current) return;
		containerRef.current.appendChild(div);
		google.maps.event.trigger(map, "resize");
		return () => {
			div.remove();
		};
	}, [div, map]);

	useEffect(() => {
		const b = map.getBounds();
		if (!b) {
			map.panTo({ lat, lng });
			return;
		}
		// Deadzone: only follow once the pano nears the edge (outer 10%) or leaves the view,
		// so the camera holds still until you're about to walk off-frame.
		const ne = b.getNorthEast(),
			sw = b.getSouthWest(),
			c = b.getCenter();
		const latPad = (ne.lat() - sw.lat()) * 0.45;
		const lngPad = (ne.lng() - sw.lng()) * 0.45;
		const inside = Math.abs(lat - c.lat()) <= latPad && Math.abs(lng - c.lng()) <= lngPad;
		if (!inside) map.panTo({ lat, lng });
	}, [lat, lng, map]);

	useEffect(() => {
		const customType = resolveStackForPrefs(prefs, {
			useBlobby: prefs.svBlobby,
			customStyles: getLocal<CustomStyle[]>(CUSTOM_STYLES_KEY, []),
		}).mapType;
		map.mapTypes.set("custom", customType);
		map.setMapTypeId("custom");
		const bg = getStyleBackgroundColor(prefs.mapStyleName);
		map.setOptions({ backgroundColor: bg });
		const mapDiv = map.getDiv();
		mapDiv.style.backgroundColor = bg;
		const inner = mapDiv.querySelector<HTMLElement>("div[style*='background-color']");
		if (inner) inner.style.backgroundColor = bg;
	}, [prefs, map]);

	const setScale = (next: number) => {
		const clamped = clamp(next, MINIMAP_SCALE);
		setSetting("fullscreenMinimapScale", Math.round(clamped * 100) / 100);
	};

	const open = () => {
		if (closeTimer.current !== null) {
			clearTimeout(closeTimer.current);
			closeTimer.current = null;
		}
		setExpanded(true);
	};
	const scheduleClose = () => {
		if (closeTimer.current !== null) clearTimeout(closeTimer.current);
		closeTimer.current = window.setTimeout(() => {
			setExpanded(false);
			closeTimer.current = null;
		}, MINIMAP_CLOSE_DELAY);
	};

	useEffect(() => {
		return () => {
			if (closeTimer.current !== null) clearTimeout(closeTimer.current);
		};
	}, []);

	const sizeVars = {
		"--fs-minimap-w": `${Math.round(MINIMAP_BASE_W * scale)}px`,
		"--fs-minimap-h": `${Math.round(MINIMAP_BASE_H * scale)}px`,
	} as React.CSSProperties;

	return (
		<div
			className={`fullscreen-minimap${expanded ? " is-expanded" : ""}`}
			style={sizeVars}
			onPointerEnter={open}
			onPointerLeave={scheduleClose}
		>
			<div ref={containerRef} className="fullscreen-minimap__map" />
			<div className="fullscreen-minimap__size">
				<button
					type="button"
					className="fullscreen-minimap__size-btn"
					aria-label="Smaller minimap"
					disabled={scale <= MINIMAP_SCALE.min}
					onClick={() => setScale(scale - MINIMAP_SCALE_STEP)}
				>
					<svg height="16" width="16" viewBox="0 0 24 24" fill="currentColor">
						<path d="M19,13H5V11H19V13Z" />
					</svg>
				</button>
				<button
					type="button"
					className="fullscreen-minimap__size-btn"
					aria-label="Larger minimap"
					disabled={scale >= MINIMAP_SCALE.max}
					onClick={() => setScale(scale + MINIMAP_SCALE_STEP)}
				>
					<svg height="16" width="16" viewBox="0 0 24 24" fill="currentColor">
						<path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" />
					</svg>
				</button>
			</div>
		</div>
	);
}
