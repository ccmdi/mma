import {
	useEffect,
	useEffectEvent,
	type Dispatch,
	type RefObject,
	type SetStateAction,
} from "react";
import type { Location } from "@/bindings.gen";
import {
	getMapState,
	getVisibleTags,
	addLocations,
	createTags,
	useMapState,
} from "@/store/useMapStore";
import { sortTagsByMode } from "@/lib/util/util";
import { useHotkey } from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys";
import { getSettings, setSetting, MOVEMENT_CYCLE, MOVEMENT_MODES } from "@/store/settings";
import { followLinkedPanos } from "@/lib/sv/lookup";
import { toast } from "@/lib/util/toast";
import { cmd } from "@/lib/commands";
import { t } from "@/lib/i18n";
import { downloadPano } from "@/lib/sv/panoDownload";
import { isVirtualLocation, dropLocation } from "@/types";
import { cycle } from "@/types/util";
import { reviewNext, reviewPrev, useReviewSession } from "@/lib/review/review";
import { registerMapKeyActionHandler } from "@/lib/map/mapKeyBindings";
import { log } from "@/lib/util/log";
import { toggleViewportLock } from "@/lib/sv/viewportLock";
import { sendHideCar } from "./PanoControls";
import { usePanoViewer } from "./PanoViewerContext";
import { usePano } from "@/lib/hooks/usePano";

interface LocationHotkeyDeps {
	pendingTags: string[];
	setPendingTags: Dispatch<SetStateAction<string[]>>;
	fullscreenContainerRef: RefObject<HTMLDivElement | null>;
	panoContainerRef: RefObject<HTMLDivElement | null>;
	handleSave: () => void | Promise<void>;
	handleClose: () => void | Promise<void>;
	handleDelete: () => void | Promise<void>;
	handleReturnToSpawn: () => void | Promise<void>;
	handleDateChange: (panoId: string | null) => void | Promise<void>;
}

export function useLocationHotkeys(deps: LocationHotkeyDeps) {
	const { draft, timeline } = usePanoViewer();
	const pano = usePano();
	const location = useMapState((s) => s.activeLocation);
	const isReviewMode = useReviewSession() !== null;
	const {
		pendingTags,
		setPendingTags,
		fullscreenContainerRef,
		panoContainerRef,
		handleSave,
		handleClose,
		handleDelete,
		handleReturnToSpawn,
		handleDateChange,
	} = deps;

	useHotkey(useBinding("locationSave"), () => {
		if (location) void Promise.resolve(handleSave());
	});
	useHotkey(useBinding("locationClose"), () => {
		void Promise.resolve(handleClose());
	});
	useHotkey(useBinding("locationDelete"), () => {
		if (location) void Promise.resolve(handleDelete());
	});
	useHotkey(useBinding("reviewNext"), () => {
		if (isReviewMode) void reviewNext();
	});
	useHotkey(useBinding("reviewPrev"), () => {
		if (isReviewMode) void reviewPrev();
	});
	useHotkey(useBinding("returnToSpawn"), () => {
		void Promise.resolve(handleReturnToSpawn());
	});
	useHotkey(useBinding("pointNorth"), () => pano.pointNorth());
	useHotkey(useBinding("centerRoad"), () => pano.faceRoad());
	useHotkey(useBinding("spin180"), () => pano.turnAround());
	const canZoom = () => getSettings().defaultMovementMode !== "nmpz";
	useHotkey(useBinding("zoomIn"), () => {
		if (canZoom()) pano.zoomIn();
	});
	useHotkey(useBinding("zoomOut"), () => {
		if (canZoom()) pano.zoomOut();
	});
	useHotkey(useBinding("panoZoomReset"), () => {
		if (canZoom()) pano.resetZoom();
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
	useHotkey(useBinding("cycleMovementMode"), () => {
		const mode = cycle(MOVEMENT_CYCLE, getSettings().defaultMovementMode);
		setSetting("defaultMovementMode", mode);
		const container = fullscreenContainerRef.current ?? panoContainerRef.current?.parentElement;
		if (container) toast(t(MOVEMENT_MODES[mode]), 1200, container);
	});
	/** The open location as it is right now: live camera, staged tags. */
	const buildDrop = async (): Promise<Location | null> => {
		if (!location || isVirtualLocation(location)) return null;
		const live = pano.capture();
		if (!live) return null;
		const tags = (await createTags(pendingTags)).map((tag) => tag.id);
		return dropLocation(location, live, live.panoId ?? location.panoId, tags);
	};

	useHotkey(useBinding("duplicateLocation"), () => {
		void buildDrop().then(async (drop) => {
			if (!drop) return;
			await addLocations([drop]);
			const container = fullscreenContainerRef.current ?? panoContainerRef.current?.parentElement;
			if (container) toast(t("Marker dropped"), 1200, container);
		});
	});

	useHotkey(useBinding("downloadPanoTile"), () => {
		const panoId = pano.panoId();
		if (panoId) void downloadPano(panoId);
	});
	const stepPanoDate = (step: 1 | -1) => {
		const panoDates = timeline ?? [];
		if (!panoDates.length) return;
		const current = draft?.panoId ?? location?.panoId ?? null;
		void handleDateChange(
			cycle(
				panoDates.map((d) => d.panoId),
				current,
				step,
			),
		);
	};
	useHotkey(useBinding("nextPanoDate"), () => stepPanoDate(1));
	useHotkey(useBinding("prevPanoDate"), () => stepPanoDate(-1));
	useHotkey(useBinding("followRoad"), () => {
		const panoId = pano.panoId();
		const heading = pano.pov().heading;
		if (!panoId) return;
		const container = fullscreenContainerRef.current ?? panoContainerRef.current?.parentElement;
		if (container) toast(t("Following road..."), 1500, container);
		followLinkedPanos(panoId, heading)
			.then((locs) => {
				if (locs.length > 0) void addLocations(locs);
				if (container)
					toast(
						t({ one: "Added {n} location", other: "Added {n} locations" }, { n: locs.length }),
						1500,
						container,
					);
			})
			.catch(() => {
				if (container) toast(t("Follow road failed"), 1500, container);
			});
	});

	useHotkey(useBinding("refreshPano"), () => {
		if (!pano.exists() || !location) return;
		pano.reload({ lat: location.lat, lng: location.lng });
		sendHideCar(!getSettings().showCar);
	});

	useHotkey(useBinding("viewportLock"), () => {
		void toggleViewportLock(pano);
	});

	const quicktagSlot = (idx: number) => {
		if (!location || !getMapState().map) return;
		const tags = sortTagsByMode(
			getVisibleTags(),
			getSettings().tagSortMode,
			getMapState().tagCounts,
		);
		if (idx >= tags.length) return;
		const tag = tags[idx];
		const has = pendingTags.includes(tag.name);
		setPendingTags(has ? pendingTags.filter((t) => t !== tag.name) : [...pendingTags, tag.name]);
	};

	const onApplyTag = useEffectEvent(({ tagId }: { tagId: number }) => {
		const active = getMapState().activeLocation;
		if (!active || isVirtualLocation(active)) return false;
		const tag = getVisibleTags().find((t) => t.id === tagId);
		if (!tag) return false;
		setPendingTags((cur) =>
			cur.includes(tag.name) ? cur.filter((t) => t !== tag.name) : [...cur, tag.name],
		);
	});

	const onDropToMap = useEffectEvent(async (mapId: string) => {
		const drop = await buildDrop();
		return drop && cmd.storeAddLocationsToMap(mapId, [drop]);
	});

	const hasLocation = location != null;
	useEffect(() => {
		if (!hasLocation) return;
		const unregisterApply = registerMapKeyActionHandler("applyTag", (action) => onApplyTag(action));
		const unregisterCopy = registerMapKeyActionHandler("copyToMap", ({ mapId }) => {
			const loc = getMapState().activeLocation;
			if (!loc || isVirtualLocation(loc)) return false;
			const container = fullscreenContainerRef.current ?? panoContainerRef.current?.parentElement;
			const t0 = performance.now();
			onDropToMap(mapId)
				.then((res) => {
					log.debug(`[copyToMap] ipc=${Math.round(performance.now() - t0)}ms`);
					if (!res || !container) return;
					toast(
						res.copied > 0
							? t('Copied to "{name}"', { name: res.targetName })
							: t('Already in "{name}"', { name: res.targetName }),
						1500,
						container,
					);
				})
				.catch((e) => {
					log.error("[copyToMap] failed:", e);
					if (container) toast(t("Copy failed"), 1500, container);
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
