import {
	useEffect,
	useEffectEvent,
	type Dispatch,
	type RefObject,
	type SetStateAction,
} from "react";
import { Maps } from "@/store/maps";
import { Store } from "@/store/store";
import { Tag } from "@/store/tag";
import { Location } from "@/store/location";
import { Edit } from "@/store/edit";
import { sortTagsByMode, togglePendingTag, type PendingTags } from "@/lib/data/tags";
import { useHotkey } from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys";
import { getSettings, setSetting, MOVEMENT_CYCLE, MOVEMENT_MODES } from "@/store/settings";
import { followLinkedPanos } from "@/lib/sv/lookup";
import { toast } from "@/lib/util/toast";
import { t } from "@/lib/i18n";
import { downloadPano } from "@/lib/sv/panoDownload";
import { dropLocation } from "@/types";
import { cycle } from "@/types/util";
import { Review } from "@/lib/review/review";
import { registerMapKeyActionHandler } from "@/lib/map/mapKeyBindings";
import { log } from "@/lib/util/log";
import { toggleViewportLock } from "@/lib/sv/viewportLock";
import { sendHideCar } from "./PanoControls";
import { usePanoViewer } from "./PanoViewerContext";
import { usePano } from "@/lib/hooks/usePano";
import { Editor } from "@/store/editor";

interface LocationHotkeyDeps {
	pendingTags: PendingTags;
	setPendingTags: Dispatch<SetStateAction<PendingTags>>;
	fullscreenContainerRef: RefObject<HTMLDivElement | null>;
	panoContainerRef: RefObject<HTMLDivElement | null>;
	handleSave: () => void | Promise<void>;
	handleClose: () => void | Promise<void>;
	handleDelete: () => void | Promise<void>;
	handleReturnToSpawn: () => void | Promise<void>;
	handleDateChange: (panoId: string | null) => void | Promise<void>;
}

export function useLocationHotkeys(deps: LocationHotkeyDeps) {
	const { onScreen } = usePanoViewer();
	const pano = usePano();
	const location = Editor.use((s) => s.open?.location ?? null);
	const onMap = Editor.use((s) => s.open?.origin === "map");
	const isReviewMode = Review.useSession() !== null;
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
		if (isReviewMode) void Review.next();
	});
	useHotkey(useBinding("reviewPrev"), () => {
		if (isReviewMode) void Review.prev();
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
	const dropped = () => {
		const live = onMap && location && pano.capture();
		return live
			? dropLocation(location, live, live.panoId ?? location.panoId, [
					...Tag.names(pendingTags.ids),
					...pendingTags.names,
				])
			: null;
	};

	useHotkey(useBinding("duplicateLocation"), () => {
		const drop = dropped();
		if (!drop) return;
		void Edit.locations({ kind: "map" }, [{ add: drop.location }], drop.records).then(() => {
			const container = fullscreenContainerRef.current ?? panoContainerRef.current?.parentElement;
			if (container) toast(t("Marker dropped"), 1200, container);
		});
	});

	useHotkey(useBinding("downloadPanoTile"), () => {
		const panoId = pano.panoId();
		if (panoId) void downloadPano(panoId);
	});
	const stepPanoDate = (step: 1 | -1) => {
		const panoDates = onScreen.ok()?.timeline;
		if (!panoDates?.length) return;
		const current = location?.panoId ?? null;
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
				if (locs.length > 0) void Location.add(locs);
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
		if (!location || !Store.get().map) return;
		const tags = sortTagsByMode(Tag.visible(), getSettings().tagSortMode, Tag.counts());
		if (idx >= tags.length) return;
		const tag = tags[idx];
		setPendingTags(togglePendingTag(pendingTags, tag.id));
	};

	const onApplyTag = useEffectEvent(({ tagId }: { tagId: number }) => {
		const active = Editor.get().open?.location;
		if (!active) return false;
		const tag = Tag.visible().find((t) => t.id === tagId);
		if (!tag) return false;
		setPendingTags((cur) => togglePendingTag(cur, tag.id));
	});

	const onDropToMap = useEffectEvent(async (mapId: string) => {
		const drop = dropped();
		return drop && Location.addTo(mapId, drop.location, drop.records);
	});

	useEffect(() => {
		if (!onMap) return;
		const unregisterApply = registerMapKeyActionHandler("applyTag", (action) => onApplyTag(action));
		const unregisterCopy = registerMapKeyActionHandler("copyToMap", ({ mapId }) => {
			const loc = Editor.get().open?.location;
			if (!loc) return false;
			const container = fullscreenContainerRef.current ?? panoContainerRef.current?.parentElement;
			const t0 = performance.now();
			onDropToMap(mapId)
				.then((added) => {
					log.debug(`[copyToMap] ipc=${Math.round(performance.now() - t0)}ms`);
					if (added == null || !container) return;
					const name = Maps.list().find((m) => m.id === mapId)?.name ?? "";
					toast(
						added ? t('Copied to "{name}"', { name }) : t('Already in "{name}"', { name }),
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
	}, [onMap, fullscreenContainerRef, panoContainerRef]);

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
