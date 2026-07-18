/**
 * Register Look Around as a location-preview pano provider.
 */
import type { Location } from "@/bindings.gen";
import { registerPanoProvider } from "@/lib/sv/panoProvider";
import { getLocationPanoId, getLocationProvider } from "@/lib/sv/providers/types";
import { getActiveLocation } from "@/store/useMapStore";
import { getApi, META_OPEN } from "./api";
import { resolvePanoForLocation } from "./tile";
import { buildPanoExtra, type LookAroundCameraType } from "./panoExtra";
import { createLookAroundPanoramaProxy } from "./panoramaProxy";
import { patchLocationExtra } from "./patchExtra";
import { setHotPano, takeHotPano } from "./sessionStore";
import { openPano, type PanoViewerHandle } from "./viewer";

let unregister: (() => void) | null = null;

const CAMERA_BADGES: Record<
	LookAroundCameraType | "apple",
	{ id: string; label: string; className: string }
> = {
	apple: { id: "apple", label: "apple", className: "badge--apple" },
	bigcam: { id: "apple-bigcam", label: "Big Cam", className: "badge--apple" },
	smallcam: { id: "apple-smallcam", label: "Small Cam", className: "badge--apple-small" },
	lowcam: { id: "apple-lowcam", label: "Low Cam", className: "badge--apple-low" },
	backpack: { id: "apple-backpack", label: "Backpack", className: "badge--apple-backpack" },
};

function spawnPanoId(location: Location): string | null {
	return getLocationPanoId(location);
}

function cameraBadgeFromLabel(
	raw: string | undefined,
): (typeof CAMERA_BADGES)[LookAroundCameraType] | null {
	if (!raw) return null;
	switch (raw) {
		case "bigcam":
		case "apple-bigcam":
			return CAMERA_BADGES.bigcam;
		case "smallcam":
		case "apple-smallcam":
			return CAMERA_BADGES.smallcam;
		case "lowcam":
		case "apple-lowcam":
			return CAMERA_BADGES.lowcam;
		case "backpack":
		case "apple-backpack":
			return CAMERA_BADGES.backpack;
		case "apple":
			return CAMERA_BADGES.apple;
		default:
			return null;
	}
}

export function registerLookAroundPanoProvider(): () => void {
	unregister?.();
	unregister = registerPanoProvider({
		id: "apple",
		priority: 10,
		dateGranularity: "day",
		ownsExactDate: true,
		canHandle(location: Location) {
			// Viewing is not gated on coverage-enabled — saved Apple pins always open here.
			return getLocationProvider(location) === "apple";
		},
		getSpawnPanoId: spawnPanoId,
		buildSaveExtra(_location, _panoId) {
			// Provider identity lives on location.provider / location.panoId (set by save path).
			return {};
		},
		resolveCameraBadge(panoId, location, entryCameraType) {
			const fromEntry = cameraBadgeFromLabel(entryCameraType);
			if (fromEntry) return fromEntry;
			const spawn = spawnPanoId(location);
			if (spawn && panoId === spawn) {
				const cam = location.extra?.cameraType;
				return (
					cameraBadgeFromLabel(typeof cam === "string" ? cam : undefined) ??
					CAMERA_BADGES.apple
				);
			}
			return null;
		},
		async open(host, location) {
			host.replaceChildren();
			const container = document.createElement("div");
			Object.assign(container.style, {
				position: "absolute",
				inset: "0",
				width: "100%",
				height: "100%",
				background: "#000",
			});
			host.appendChild(container);

			const savedId = spawnPanoId(location);

			let pano = takeHotPano(savedId);
			if (!pano) {
				pano = await resolvePanoForLocation(location.lat, location.lng, savedId, META_OPEN);
			}
			if (!pano) {
				throw new Error("No Apple Look Around coverage near this location");
			}
			setHotPano(pano);

			const api = getApi();
			const handle: PanoViewerHandle = await openPano(
				container,
				{ lookmapBaseUrl: api.getLookmapBaseUrl() },
				pano,
			);
			const full = handle.currentPano ?? pano;
			const proxy = createLookAroundPanoramaProxy(handle, full);
			const panorama = proxy.panorama;

			if (location.heading != null || location.pitch != null) {
				panorama.setPov({
					heading: location.heading ?? 0,
					pitch: location.pitch ?? 0,
				});
			}
			if (location.zoom != null) panorama.setZoom(location.zoom);

			const active = getActiveLocation();
			if (active) void patchLocationExtra(active, buildPanoExtra(full));

			const resize = () => {
				const v = handle as unknown as {
					autoSize?: () => void;
					needsUpdate?: () => void;
				};
				try {
					v.autoSize?.();
					v.needsUpdate?.();
				} catch {
					/* ignore */
				}
			};

			return {
				panorama,
				viewport: container,
				resize,
				getAlternateDates: proxy.getAlternateDates,
				subscribeAlternateDates: proxy.subscribeAlternateDates,
				getAltitude: proxy.getAltitude,
				destroy() {
					proxy.destroy();
					try {
						handle.destroy();
					} catch {
						/* ignore */
					}
					container.remove();
				},
			};
		},
	});

	return () => {
		unregister?.();
		unregister = null;
	};
}
