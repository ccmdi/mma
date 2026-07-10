import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/primitives/Icon";
import { mdiMinus, mdiPlus } from "@mdi/js";
import { CUSTOM_STYLES_KEY, type CustomStyle } from "@/lib/geo/mapStack";
import { useMapSurface } from "@/lib/render/useMapSurface";
import { useSetting, setSetting } from "@/store/settings";
import { range, clamp } from "@/types/util";
import { useLocalStorage, getLocal } from "@/lib/hooks/useLocalStorage";
import { type MapEmbedPrefs, DEFAULT_PREFS } from "@/store/mapEmbedPrefs";
import {
	createMapHost,
	hostKindForMapType,
	type MapHost,
	type DeckOverlayHandle,
} from "@/lib/map/host";
import { usePanoViewer } from "./PanoViewerContext";

const MINIMAP_SCALE = range([0.5, 2]);
const MINIMAP_SCALE_STEP = 0.5;
const MINIMAP_BASE_W = 800;
const MINIMAP_BASE_H = 600;
const MINIMAP_CLOSE_DELAY = 500;

// Singleton host + overlay reused across mounts (opening/closing the pano viewer),
// rebuilt only when the basemap kind changes.
let minimapHost: MapHost | null = null;
let minimapDiv: HTMLDivElement | null = null;
let minimapOverlay: DeckOverlayHandle | null = null;

async function ensureMinimapHost(
	prefs: MapEmbedPrefs,
	lat: number,
	lng: number,
): Promise<{ host: MapHost; div: HTMLDivElement; overlay: DeckOverlayHandle }> {
	const kind = hostKindForMapType(prefs.mapType);
	if (minimapHost && minimapHost.kind !== kind) {
		minimapOverlay?.finalize();
		minimapOverlay = null;
		minimapHost.destroy();
		minimapHost = null;
		minimapDiv = null;
	}
	if (!minimapDiv) {
		minimapDiv = document.createElement("div");
		minimapDiv.style.cssText = "width:100%;height:100%";
	}
	if (!minimapHost) {
		minimapHost = await createMapHost(kind, minimapDiv, prefs, {
			useBlobby: prefs.svBlobby,
			customStyles: getLocal<CustomStyle[]>(CUSTOM_STYLES_KEY, []),
			camera: { center: { lat, lng }, zoom: 14 },
			scaleControl: false,
		});
	}
	if (!minimapOverlay) {
		minimapOverlay = minimapHost.createDeckOverlay();
	}
	return { host: minimapHost, div: minimapDiv, overlay: minimapOverlay };
}

export function FullscreenMiniMap() {
	const { lat, lng } = usePanoViewer();
	const containerRef = useRef<HTMLDivElement>(null);
	const scale = useSetting("fullscreenMinimapScale");
	const [expanded, setExpanded] = useState(false);
	const closeTimer = useRef<number | null>(null);
	const [prefs] = useLocalStorage<MapEmbedPrefs>("mapEmbedPrefs", DEFAULT_PREFS);
	const [surface, setSurface] = useState<{
		host: MapHost;
		div: HTMLDivElement;
		overlay: DeckOverlayHandle;
	} | null>(null);

	useEffect(() => {
		let cancelled = false;
		ensureMinimapHost(prefs, lat, lng).then((s) => {
			if (!cancelled) setSurface(s);
		});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- kind is the only creation input
	}, [prefs.mapType]);

	useMapSurface(surface?.host ?? null, {
		prefs,
		followActive: true,
		overlay: surface?.overlay,
	});

	useEffect(() => {
		if (!containerRef.current || !surface) return;
		containerRef.current.appendChild(surface.div);
		surface.host.resize();
		return () => {
			surface.div.remove();
		};
	}, [surface]);

	useEffect(() => {
		if (!surface) return;
		const { host } = surface;
		const b = host.getBounds();
		if (!b) {
			host.panTo({ lat, lng });
			return;
		}
		// Deadzone: only follow once the pano nears the edge (outer 10%) or leaves the view,
		// so the camera holds still until you're about to walk off-frame.
		const cLat = (b.north + b.south) / 2;
		const cLng = (b.east + b.west) / 2;
		const latPad = (b.north - b.south) * 0.45;
		const lngPad = (b.east - b.west) * 0.45;
		const inside = Math.abs(lat - cLat) <= latPad && Math.abs(lng - cLng) <= lngPad;
		if (!inside) host.panTo({ lat, lng });
	}, [lat, lng, surface]);

	useEffect(() => {
		if (!surface) return;
		surface.host.applyPrefs(prefs, {
			useBlobby: prefs.svBlobby,
			customStyles: getLocal<CustomStyle[]>(CUSTOM_STYLES_KEY, []),
		});
	}, [prefs, surface]);

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
					<Icon path={mdiMinus} size={16} />
				</button>
				<button
					type="button"
					className="fullscreen-minimap__size-btn"
					aria-label="Larger minimap"
					disabled={scale >= MINIMAP_SCALE.max}
					onClick={() => setScale(scale + MINIMAP_SCALE_STEP)}
				>
					<Icon path={mdiPlus} size={16} />
				</button>
			</div>
		</div>
	);
}
