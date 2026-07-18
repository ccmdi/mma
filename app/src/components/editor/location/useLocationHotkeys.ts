import {
	useEffect,
	useEffectEvent,
	useRef,
	type Dispatch,
	type RefObject,
	type SetStateAction,
} from "react";
import type { Location } from "@/bindings.gen";
import {
	getActiveLocation,
	getCurrentMap,
	getVisibleTags,
	getTagCounts,
	duplicateLocation,
	addLocations,
} from "@/store/useMapStore";
import { sortTagsByMode } from "@/lib/util/util";
import { useHotkey } from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys";
import { getSettings, setSetting } from "@/store/settings";
import { PANO_ZOOM } from "@/lib/sv/constants";
import { tweenPov } from "@/lib/sv/tweenPov";
import {
	type PanoReference,
	nearestLinkHeading,
	followLinkedPanos,
	showToast,
} from "@/lib/sv/lookup";
import { downloadPano } from "@/lib/sv/panoDownload";
import { isVirtualLocation } from "@/types";
import { reviewNext, reviewPrev } from "@/lib/review/review";
import { registerMapKeyActionHandler } from "@/lib/map/mapKeyBindings";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { toggleViewportLock } from "@/lib/sv/viewportLock";
import { sendHideCar } from "./PanoControls";
import { singletonPano, getPanorama, clearSingletonPano } from "@/lib/sv/panoSingleton";
import { google } from "@/lib/sv/opensv";

interface LocationHotkeyDeps {
	location: Location | null;
	isReviewMode: boolean;
	panoDates: PanoReference[];
	selectedPanoId: string | null;
	currentPano: Pick<google.maps.StreetViewPanoramaData, "location" | "imageDate"> | null;
	cancelTweenRef: RefObject<(() => void) | null>;
	pendingTags: string[];
	setPendingTags: Dispatch<SetStateAction<string[]>>;
	fullscreenContainerRef: RefObject<HTMLDivElement | null>;
	panoContainerRef: RefObject<HTMLDivElement | null>;
	handleSave: () => void;
	handleClose: () => void;
	handleDelete: () => void;
	handleReturnToSpawn: () => void;
	handleDateChange: (panoId: string | null) => void;
	/** Active panorama (Google singleton or alt provider proxy). */
	panorama?: google.maps.StreetViewPanorama | null;
}

export function useLocationHotkeys(deps: LocationHotkeyDeps) {
	const {
		location,
		isReviewMode,
		panoDates,
		selectedPanoId,
		currentPano,
		cancelTweenRef,
		pendingTags,
		setPendingTags,
		fullscreenContainerRef,
		panoContainerRef,
		handleSave,
		handleClose,
		handleDelete,
		handleReturnToSpawn,
		handleDateChange,
		panorama: panoramaProp,
	} = deps;

	const panoramaRef = useRef(panoramaProp);
	panoramaRef.current = panoramaProp;
	const pano = () => panoramaRef.current ?? singletonPano;

	useHotkey(useBinding("locationSave"), () => {
		if (location) handleSave();
	});
	useHotkey(useBinding("locationClose"), () => {
		handleClose();
	});
	useHotkey(useBinding("locationDelete"), () => {
		if (location) handleDelete();
	});
	useHotkey(useBinding("reviewNext"), () => {
		if (isReviewMode) reviewNext();
	});
	useHotkey(useBinding("reviewPrev"), () => {
		if (isReviewMode) reviewPrev();
	});
	useHotkey(useBinding("returnToSpawn"), () => {
		handleReturnToSpawn();
	});
	useHotkey(useBinding("pointNorth"), () => {
		const panorama = pano();
		if (panorama) {
			cancelTweenRef.current?.();
			const h = panorama.getPov().heading;
			if (Math.abs(h) < 1 && Math.abs(panorama.getPov().pitch) < 1) {
				cancelTweenRef.current = tweenPov(panorama, { heading: 0, pitch: -90 });
			} else {
				cancelTweenRef.current = tweenPov(panorama, { heading: 0, pitch: 0 });
			}
		}
	});
	useHotkey(useBinding("centerRoad"), () => {
		const panorama = pano();
		if (!panorama) return;
		const headings = (panorama.getLinks() ?? [])
			.map((l) => l?.heading)
			.filter((h): h is number => h != null);
		const nearest = nearestLinkHeading(headings, panorama.getPov().heading);
		if (nearest == null) return;
		cancelTweenRef.current?.();
		cancelTweenRef.current = tweenPov(panorama, { heading: nearest, pitch: 0 });
	});
	useHotkey(useBinding("spin180"), () => {
		const panorama = pano();
		if (panorama) {
			cancelTweenRef.current?.();
			const pov = panorama.getPov();
			cancelTweenRef.current = tweenPov(panorama, {
				heading: (pov.heading + 180) % 360,
				pitch: pov.pitch,
			});
		}
	});
	useHotkey(useBinding("zoomIn"), () => {
		const panorama = pano();
		if (panorama) {
			panorama.setZoom(Math.min(PANO_ZOOM.max, Math.max(0, panorama.getZoom()) + 1));
		}
	});
	useHotkey(useBinding("zoomOut"), () => {
		const panorama = pano();
		if (panorama) {
			panorama.setZoom(Math.max(0, panorama.getZoom() - 1));
		}
	});
	useHotkey(useBinding("panoZoomReset"), () => {
		const panorama = pano();
		if (panorama) panorama.setZoom(PANO_ZOOM.min);
	});
	useHotkey(
		useBinding("copyLink"),
		(e) => {
			if (!location) return;
			const btn = document.querySelector<HTMLButtonElement>('button[aria-label^="Copy link"]');
			btn?.dispatchEvent(
				new MouseEvent("click", {
					bubbles: true,
					cancelable: true,
					shiftKey: e.shiftKey,
					altKey: e.altKey,
				}),
			);
		},
		{ ignoreAlt: true, ignoreShift: true },
	);
	useHotkey(useBinding("toggleCrosshair"), () => {
		setSetting("showCrosshair", !getSettings().showCrosshair);
	});
	useHotkey(useBinding("toggleHideCar"), () => {
		setSetting("showCar", !getSettings().showCar);
	});
	useHotkey(useBinding("togglePanoUI"), () => {
		setSetting("hidePanoUI", !getSettings().hidePanoUI);
	});
	useHotkey(useBinding("duplicateLocation"), () => {
		if (location) duplicateLocation(location.id);
	});

	useHotkey(useBinding("downloadPanoTile"), () => {
		const panoId = pano()?.getPano();
		if (panoId) void downloadPano(panoId, { location, zoom: 5 });
	});
	useHotkey(useBinding("nextPanoDate"), () => {
		if (!panoDates.length) return;
		const currentPanoId = selectedPanoId ?? currentPano?.location?.pano ?? location?.panoId;
		const raw = currentPanoId ? panoDates.findIndex((d) => d.pano === currentPanoId) : -1;
		const idx = raw === -1 ? panoDates.length - 1 : raw;
		const next = idx < panoDates.length - 1 ? idx + 1 : 0;
		handleDateChange(panoDates[next].pano);
	});
	useHotkey(useBinding("prevPanoDate"), () => {
		if (!panoDates.length) return;
		const currentPanoId = selectedPanoId ?? currentPano?.location?.pano ?? location?.panoId;
		const raw = currentPanoId ? panoDates.findIndex((d) => d.pano === currentPanoId) : -1;
		const idx = raw === -1 ? panoDates.length - 1 : raw;
		const prev = idx > 0 ? idx - 1 : panoDates.length - 1;
		handleDateChange(panoDates[prev].pano);
	});
	useHotkey(useBinding("followRoad"), () => {
		const panorama = pano();
		if (!panorama) return;
		const panoId = panorama.getPano();
		const heading = panorama.getPov().heading;
		if (!panoId) return;
		const container = fullscreenContainerRef.current ?? panoContainerRef.current?.parentElement;
		if (container) showToast(container, "Following road...");
		followLinkedPanos(panoId, heading)
			.then((locs) => {
				if (locs.length > 0) addLocations(locs);
				if (container) showToast(container, `Added ${locs.length} locations`);
			})
			.catch(() => {
				if (container) showToast(container, "Follow road failed");
			});
	});

	useHotkey(useBinding("refreshPano"), () => {
		if (!singletonPano || !location || panoramaRef.current) return;
		const panoId = singletonPano.getPano();
		const pov = singletonPano.getPov();
		const zoom = singletonPano.getZoom();
		clearSingletonPano();
		const fresh = getPanorama();
		if (!fresh) return;
		if (panoId) fresh.setPano(panoId);
		else fresh.setPosition({ lat: location.lat, lng: location.lng });
		fresh.setPov(pov);
		fresh.setZoom(zoom);
		fresh.setVisible(true);
		google.maps.event.trigger(fresh, "resize");
		sendHideCar(!getSettings().showCar);
	});

	useHotkey(useBinding("viewportLock"), () => {
		const panorama = pano();
		if (panorama) toggleViewportLock(panorama);
	});

	const quicktagSlot = (idx: number) => {
		if (!location || !getCurrentMap()) return;
		const tags = sortTagsByMode(getVisibleTags(), getSettings().tagSortMode, getTagCounts());
		if (idx >= tags.length) return;
		const tag = tags[idx];
		const has = pendingTags.includes(tag.name);
		setPendingTags(has ? pendingTags.filter((t) => t !== tag.name) : [...pendingTags, tag.name]);
	};

	const onApplyTag = useEffectEvent(({ tagId }: { tagId: number }) => {
		const active = getActiveLocation();
		if (!active || isVirtualLocation(active)) return false;
		const tag = getVisibleTags().find((t) => t.id === tagId);
		if (!tag) return false;
		setPendingTags((cur) =>
			cur.includes(tag.name) ? cur.filter((t) => t !== tag.name) : [...cur, tag.name],
		);
	});

	const hasLocation = location != null;
	useEffect(() => {
		if (!hasLocation) return;
		const unregisterApply = registerMapKeyActionHandler("applyTag", (action) => onApplyTag(action));
		const unregisterCopy = registerMapKeyActionHandler("copyToMap", ({ mapId }) => {
			const loc = getActiveLocation();
			if (!loc || isVirtualLocation(loc)) return false;
			const container = fullscreenContainerRef.current ?? panoContainerRef.current?.parentElement;
			const t0 = performance.now();
			cmd
				.storeCopyLocationsToMap(mapId, [loc.id])
				.then((res) => {
					log.debug(`[copyToMap] ipc=${Math.round(performance.now() - t0)}ms`);
					if (!container) return;
					showToast(
						container,
						res.copied > 0 ? `Copied to "${res.targetName}"` : `Already in "${res.targetName}"`,
					);
				})
				.catch((e) => {
					log.error("[copyToMap] failed:", e);
					if (container) showToast(container, "Copy failed");
				});
		});
		return () => {
			unregisterApply();
			unregisterCopy();
		};
	}, [hasLocation, fullscreenContainerRef, panoContainerRef]);

	useHotkey(useBinding("quicktag1"), () => quicktagSlot(0));
	useHotkey(useBinding("quicktag2"), () => quicktagSlot(1));
	useHotkey(useBinding("quicktag3"), () => quicktagSlot(2));
	useHotkey(useBinding("quicktag4"), () => quicktagSlot(3));
	useHotkey(useBinding("quicktag5"), () => quicktagSlot(4));
	useHotkey(useBinding("quicktag6"), () => quicktagSlot(5));
	useHotkey(useBinding("quicktag7"), () => quicktagSlot(6));
	useHotkey(useBinding("quicktag8"), () => quicktagSlot(7));
	useHotkey(useBinding("quicktag9"), () => quicktagSlot(8));
}
