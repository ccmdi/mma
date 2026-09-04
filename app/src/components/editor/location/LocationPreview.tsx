import {
	memo,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useCallback,
	useEffectEvent,
} from "react";
import {
	createLocation,
	extraPatch,
	isVirtualLocation,
	isImportPreview,
	isSeenPreview,
} from "@/types";
import { LocationFlag, VIRTUAL_FLAGS } from "@/bindings.consts";
import { Tooltip } from "@/components/primitives/Tooltip";
import { Icon } from "@/components/primitives/Icon";
import { Button } from "@/components/primitives/Button";
import { mdiChevronLeft, mdiChevronRight } from "@mdi/js";
import type { Tag } from "@/bindings.gen";
import {
	useMapState,
	updateLocations,
	getMapState,
	tagIdsToNames,
	removeLocations,
	addLocations,
	createTags,
	setActiveLocation,
	getVisibleTags,
} from "@/store/useMapStore";
import { sortTagsByMode, tagColorFor, appendTagName } from "@/lib/util/util";
import { TagPill, TagPillButton } from "@/components/primitives/TagPill";
import { displayTagName } from "@/store/selections";
import { ReviewBar } from "@/components/editor/location/ReviewBar";
import {
	useReviewSession,
	reviewNext,
	reviewPrev,
	reviewDelete,
	isAtStart,
} from "@/lib/review/review";
import { loadOpenSV, google } from "@/lib/sv/opensv";

import {
	useSettings,
	useSetting,
	getSettings,
	panoDisplayOptions,
	GEOCODE_PROVIDER_LABELS,
	type GeocodeProvider,
} from "@/store/settings";
import { useHotkey } from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys";
import { PluginLocationPanels } from "@/plugins/PluginPanels";
import { relativeTime } from "@/lib/util/format";
import { isPanoFallback, resolvePano } from "@/lib/sv/lookup";
import { usePanoEvent } from "@/lib/hooks/usePanoEvent";
import { toast } from "@/lib/util/toast";
import { FullscreenMiniMap } from "@/components/editor/location/FullscreenMiniMap";
import { FullscreenTagBar } from "@/components/editor/location/FullscreenTagBar";
import { PanoControls, CrosshairOverlay, sendHideCar } from "./PanoControls";
import { seenPanoChanged, seenFlush, seenUpdateGeo } from "@/lib/seen/seen";
import { useReverseGeocode, type GeoDisplay } from "@/components/editor/location/useReverseGeocode";
import { usePanoViewer } from "./PanoViewerContext";
import {
	usePanoFullscreen,
	togglePanoFullscreen,
	exitPanoFullscreen,
	exitFullscreenMap,
} from "./fullscreenModeState";
import { FullscreenMiniLocationPreview } from "./FullscreenMiniLocationPreview";
import { applyViewportLock, getViewportLockInfo } from "@/lib/sv/viewportLock";
import { useEvent } from "@/lib/events";
import { resetTrail, pushTrail, clearTrail } from "@/lib/sv/svTrail";
import {
	singletonPano,
	singletonDiv,
	getPanorama,
	applyResolved,
	capturePov,
} from "@/lib/sv/panoSingleton";
import { PanoDatePicker } from "./PanoDatePicker";
import { usePanoNavigation } from "./usePanoNavigation";
import { useLocationHotkeys } from "./useLocationHotkeys";
import { Flag } from "@/components/primitives/Flag";
import { t } from "@/lib/i18n";

/** Pending-tag chips + add form + suggestion pills. Memoized and self-subscribed
 *  so pano-switch churn in the parent doesn't re-render every pill. */
const TagEditor = memo(function TagEditor({
	pendingTags,
	onChangeTags,
	isImport,
}: {
	pendingTags: string[];
	onChangeTags: React.Dispatch<React.SetStateAction<string[]>>;
	isImport: boolean;
}) {
	const [tagInput, setTagInput] = useState("");
	const visibleTags = useMapState(getVisibleTags);
	const tagCounts = useMapState((s) => s.tagCounts);
	const tagSortMode = useSetting("tagSortMode");
	const suggestionLimit = useSetting("tagSuggestionLimit");

	const allTags = useMemo(
		() => sortTagsByMode(visibleTags, tagSortMode, tagCounts),
		[visibleTags, tagSortMode, tagCounts],
	);
	const suggestions = useMemo(() => {
		const pendingLower = new Set(pendingTags.map((n) => n.toLowerCase()));
		const available = allTags.filter((t) => !pendingLower.has(t.name.toLowerCase()));
		const cap = suggestionLimit || available.length;
		if (tagInput.trim()) {
			const lower = tagInput.toLowerCase();
			return available.filter((t) => t.name.toLowerCase().includes(lower)).slice(0, cap);
		}
		return available.slice(0, cap);
	}, [allTags, pendingTags, tagInput, suggestionLimit]);

	const addPendingTag = (name: string) =>
		onChangeTags((prev) => appendTagName(prev, name, getVisibleTags()));

	const handleAddTag = (e: React.FormEvent) => {
		e.preventDefault();
		const name = tagInput.trim();
		if (!name) return;
		addPendingTag(name);
		setTagInput("");
	};

	const handleRemoveTag = (name: string) => {
		onChangeTags((prev) => prev.filter((t) => t !== name));
	};

	const handleSuggestionClick = (t: Tag) => {
		addPendingTag(t.name);
		setTagInput("");
	};

	if (isImport) {
		return (
			<p>
				{t(
					"This location is still being imported and cannot be modified. Complete the import before\n\t\t\t\tmaking changes.",
				)}
			</p>
		);
	}

	return (
		<>
			<ul className="tag-list">
				{pendingTags.map((name) => (
					<TagPill
						as="li"
						key={name}
						small
						color={tagColorFor(name, allTags)}
						label={displayTagName(name)}
						button={<TagPillButton variant="delete" onClick={() => handleRemoveTag(name)} />}
					/>
				))}
				<li>
					<form className="form-add-tag" onSubmit={handleAddTag}>
						<Button className="form-add-tag__button" type="submit">
							+
						</Button>
						<input
							className="form-add-tag__input"
							type="text"
							placeholder={t("Add a tag…")}
							value={tagInput}
							onChange={(e) => setTagInput(e.target.value)}
						/>
					</form>
				</li>
			</ul>
			{suggestions.length > 0 && (
				<div
					style={{
						paddingTop: "0.5rem",
						maxHeight: "40vh",
						overflowY: "auto",
						scrollbarWidth: "none",
					}}
				>
					<ol className="tag-list">
						{suggestions.map((t) => (
							<TagPill
								as="li"
								key={t.id}
								small
								color={t.color}
								label={displayTagName(t.name)}
								button={<TagPillButton variant="add" onClick={() => handleSuggestionClick(t)} />}
							/>
						))}
					</ol>
				</div>
			)}
		</>
	);
});

const pinned = (flags: number, on: boolean) =>
	on ? flags | LocationFlag.LoadAsPanoId : flags & ~LocationFlag.LoadAsPanoId;

export function LocationPreview() {
	const location = useMapState((s) => s.activeLocation);
	const map = useMapState((s) => s.map);
	const reviewSession = useReviewSession();
	const isReviewMode = reviewSession !== null;
	const panoContainerRef = useRef<HTMLDivElement>(null);
	const fullscreenContainerRef = useRef<HTMLDivElement>(null);
	const { draft, meta, defaultPano, edit, settled, open } = usePanoViewer();
	const isFullscreen = usePanoFullscreen();
	const [pendingTags, setPendingTags] = useState<string[]>(() =>
		tagIdsToNames(location?.tags ?? []),
	);
	const visibleTags = useMapState(getVisibleTags);
	const geocodeProvider = useSetting("geocodeProvider");
	const geoResult = useReverseGeocode(location?.lat ?? 0, location?.lng ?? 0, meta);
	const cancelTweenRef = useRef<(() => void) | null>(null);
	const getGeoResult = useEffectEvent(() => geoResult);
	useEffect(() => {
		setPendingTags((prev) => {
			const next = tagIdsToNames(location?.tags ?? []);
			return prev.length === next.length && prev.every((n, i) => n === next[i]) ? prev : next;
		});
	}, [location?.id]);
	useEffect(() => {
		if (geoResult) seenUpdateGeo(geoResult);
	}, [geoResult]);
	const appSettings = useSettings();

	const chipMode = appSettings.fullscreenMap && appSettings.showFullscreenMiniLocationPreview;
	const bottomTrayRef = useRef<HTMLDivElement>(null);
	// Written straight to the CSS var, not through state: the tray animates its height, so
	// this fires every frame and a re-render per frame would leave the chrome lagging behind.
	useLayoutEffect(() => {
		const root = fullscreenContainerRef.current;
		const el = bottomTrayRef.current;
		if (!root) return;
		if (!el) {
			root.style.setProperty("--fs-tray-h", "0px");
			return;
		}
		const obs = new ResizeObserver(() =>
			root.style.setProperty("--fs-tray-h", `${el.offsetHeight}px`),
		);
		obs.observe(el);
		return () => obs.disconnect();
	}, [isFullscreen, appSettings.showFullscreenTagbar, appSettings.showFullscreenDatePicker]);
	useEvent("viewport-lock:changed");
	const lockInfo = getViewportLockInfo();

	useEffect(() => {
		if (!singletonPano) return;
		singletonPano.setOptions(panoDisplayOptions(getSettings()));
	}, [
		appSettings.showLinksControl,
		appSettings.clickToGo,
		appSettings.showRoadLabels,
		appSettings.defaultMovementMode,
		appSettings.hidePanoUI,
		appSettings.hideNavWithUI,
	]);

	usePanoEvent(singletonPano, "status_changed", () => sendHideCar(!appSettings.showCar), [
		appSettings.showCar,
	]);

	useEffect(() => {
		if (!singletonPano || !appSettings.showCrosshair) return;
		const overlay = new CrosshairOverlay(singletonPano);
		return () => overlay.dispose();
	}, [appSettings.showCrosshair]);

	// Mount/unmount: move the persistent div in/out of the container.
	// useLayoutEffect so appendChild runs before paint.
	useLayoutEffect(() => {
		const container = panoContainerRef.current;
		if (!container) return;
		container.appendChild(singletonDiv);
		if (singletonPano && google?.maps) google.maps.event.trigger(singletonPano, "resize");
		return () => {
			if (container.contains(singletonDiv)) container.removeChild(singletonDiv);
		};
	}, [chipMode]);

	useEffect(() => {
		if (!location) return;
		let cancelled = false;
		let statusListener: google.maps.MapsEventListener | null = null;
		let lockListener: google.maps.MapsEventListener | null = null;

		void loadOpenSV().then(async () => {
			if (cancelled) return;
			if (!google?.maps) return;
			const pano = getPanorama();
			if (!pano) return;

			statusListener = pano.addListener("status_changed", () => {
				if (cancelled || pano.getStatus() !== "OK") return;
				const panoId = pano.getPano();
				const pos = pano.getPosition();
				if (!panoId || !pos) return;
				edit({ panoId, lat: pos.lat(), lng: pos.lng() });

				pushTrail(pos.lng(), pos.lat());
				const geo = getGeoResult();
				seenPanoChanged(
					{
						locationId: isVirtualLocation(location) ? null : location.id,
						panoId,
						lat: pos.lat(),
						lng: pos.lng(),
					},
					geo && {
						address: geo.address,
						countryCode:
							typeof location.extra?.countryCode === "string"
								? location.extra.countryCode
								: geo.countryCode,
					},
					capturePov,
				);
			});

			lockListener = pano.addListener("pano_changed", () => {
				void applyViewportLock(pano);
			});

			sendHideCar(!getSettings().showCar);
			resetTrail(location.lng, location.lat);

			const result = await resolvePano(location);
			if (cancelled) return;
			applyResolved(pano, result, location);
			google.maps.event.trigger(pano, "resize");
			if (isPanoFallback(location, result)) {
				const root = Object.values(pano).find((v) => v instanceof HTMLElement) as
					HTMLElement | undefined;
				if (root)
					toast(t("Configured pano ID could not be found. Falling back to lat/lng."), 3000, root);
			}
			// From the resolve result directly: setPano() with the same id fires no status_changed.
			open(location, result?.pano ?? null);
		});

		return () => {
			cancelled = true;
			clearTrail();
			if (statusListener) google?.maps?.event?.removeListener(statusListener);
			if (lockListener) google?.maps?.event?.removeListener(lockListener);
			if (singletonPano) seenFlush(capturePov);
		};
	}, [location?.id]);

	// A chosen date pins the draft to that pano; Default floats it on the pano Google
	// resolves for the position.
	const handleDateChange = useCallback(
		(panoId: string | null) => {
			edit((d) => ({ flags: pinned(d.flags, panoId != null) }));
			const target = panoId ?? defaultPano;
			if (target) singletonPano?.setPano(target);
		},
		[edit, defaultPano],
	);

	const handleSave = useCallback(async () => {
		if (!location || !singletonPano) return;
		// Staged (virtual) location: updateLocation no-ops, cursorId can't match a
		// negative id, so this falls through to setActiveLocation(null) = close.
		// The draft once enrichment has answered; the camera is read live, it moves per frame.
		const draft = await settled();
		if (!draft) return;
		const pov = capturePov();

		if (isSeenPreview(location)) {
			await addLocations([
				createLocation({
					...draft,
					...pov,
					flags: location.flags & ~VIRTUAL_FLAGS, // keep LoadAsPanoId; drop the preview-kind bits
					tags: (await createTags(pendingTags)).map((t) => t.id),
				}),
			]);
			void setActiveLocation(null);
			return;
		}

		void updateLocations([
			{
				id: location.id,
				patch: {
					...pov,
					lat: draft.lat,
					lng: draft.lng,
					panoId: draft.panoId,
					flags: draft.flags,
					tags: (await createTags(pendingTags)).map((t) => t.id),
					extra: extraPatch(location.extra, draft.extra),
				},
			},
		]);
		if (isReviewMode && reviewSession?.cursorId === location.id) {
			void reviewNext();
		} else {
			void setActiveLocation(null);
		}
	}, [location, settled, isReviewMode, reviewSession, pendingTags]);

	const handleClose = useCallback(() => {
		if (exitPanoFullscreen()) return;
		if (exitFullscreenMap()) return;
		if (isReviewMode) {
			void reviewNext();
		} else {
			void setActiveLocation(null);
		}
	}, [isReviewMode]);

	const handleDelete = useCallback(() => {
		if (!location) return;
		if (isReviewMode && reviewSession?.cursorId === location.id) {
			void reviewDelete();
		} else {
			void removeLocations(new Set([location.id]));
		}
	}, [location, isReviewMode, reviewSession]);

	// Reads the active location at call time so the callback stays referentially
	// stable (it is a memo'd PanoControls prop).
	const handleReturnToSpawn = useCallback(async () => {
		const loc = getMapState().activeLocation;
		if (!loc || !singletonPano) return;
		if (!google) return;
		const result = await resolvePano(loc);
		applyResolved(singletonPano, result, loc);
		google.maps.event.trigger(singletonPano, "resize");
		edit((d) => ({ flags: pinned(d.flags, false) }));
	}, [edit]);

	const handleFullscreen = useCallback(() => {
		if (location) togglePanoFullscreen();
	}, [location]);

	useHotkey(useBinding("toggleFullscreen"), handleFullscreen);

	useEffect(() => {
		if (!chipMode) return;
		const el = panoContainerRef.current;
		if (!el) return;
		const obs = new ResizeObserver(() => {
			if (singletonPano && google?.maps) google.maps.event.trigger(singletonPano, "resize");
		});
		obs.observe(el);
		return () => obs.disconnect();
	}, [chipMode]);

	useEffect(() => {
		if (singletonPano && google?.maps) google.maps.event.trigger(singletonPano, "resize");
	}, [appSettings.previewAspectRatio]);

	useEffect(() => {
		if (!singletonPano || appSettings.previewAspectRatio !== "free") return;
		const el = fullscreenContainerRef.current;
		if (!el) return;
		let timer: ReturnType<typeof setTimeout>;
		const obs = new ResizeObserver(() => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				if (singletonPano && google?.maps) google.maps.event.trigger(singletonPano, "resize");
			}, 150);
		});
		obs.observe(el);
		return () => {
			obs.disconnect();
			clearTimeout(timer);
		};
	}, [singletonPano, appSettings.previewAspectRatio]);

	useLocationHotkeys({
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
	});

	usePanoNavigation(appSettings);

	if (!location || !map) return null;

	if (chipMode) {
		return (
			<>
				<ReviewBar />
				<FullscreenMiniLocationPreview>
					<div ref={panoContainerRef} className="fullscreen-mini-location__pano" />
				</FullscreenMiniLocationPreview>
			</>
		);
	}

	return (
		<>
			<ReviewBar />
			<section
				className={`location-preview${appSettings.previewAspectRatio === "free" ? " free-resize" : ""}`}
			>
				<div
					className={`location-preview__panorama${isFullscreen ? " is-fullscreen" : ""}${appSettings.hidePanoUI ? " hide-pano-ui" : ""}`}
					ref={fullscreenContainerRef}
					style={
						isFullscreen
							? undefined
							: appSettings.previewAspectRatio === "free"
								? undefined
								: { aspectRatio: appSettings.previewAspectRatio }
					}
				>
					<div className="location-preview__embed">
						<div style={{ position: "absolute", inset: 0 }} ref={panoContainerRef} />
						{appSettings.defaultMovementMode === "nmpz" && (
							<div style={{ position: "absolute", inset: 0, zIndex: 1 }} />
						)}
						{draft && singletonPano && (
							<PanoControls
								panorama={singletonPano}
								isFullscreen={isFullscreen}
								onFullscreen={handleFullscreen}
								onReturnToSpawn={handleReturnToSpawn}
							/>
						)}
						{lockInfo && (
							<div className="viewport-lock-badge">
								{t("VIEWPORT LOCK")} h{" "}
								<span className="mono">{lockInfo.relHeading.toFixed(1)}</span> p{" "}
								<span className="mono">{lockInfo.relPitch.toFixed(1)}</span> z{" "}
								<span className="mono">{lockInfo.lockedZoom.toFixed(1)}</span>
							</div>
						)}
					</div>
					{isFullscreen && appSettings.showFullscreenMinimap && <FullscreenMiniMap />}
					{isFullscreen && (
						<div className="fullscreen-topbar">
							{appSettings.showFullscreenReviewBar && <ReviewBar />}
							{appSettings.showFullscreenGeocode &&
								(geoResult?.countryCode || geoResult?.address) && (
									<div className="fullscreen-geocode">
										<GeoSummary geo={geoResult} provider={geocodeProvider} />
									</div>
								)}
						</div>
					)}
					{isFullscreen && (
						<div className="fullscreen-bottom-tray" ref={bottomTrayRef}>
							{appSettings.showFullscreenTagbar && (
								<FullscreenTagBar
									pendingTags={pendingTags}
									onChangeTags={setPendingTags}
									tags={visibleTags}
								/>
							)}
						</div>
					)}
					{isFullscreen && appSettings.showFullscreenDatePicker && (
						<div className="fullscreen-date-picker">
							<PanoDatePicker onChange={handleDateChange} />
						</div>
					)}
				</div>
				<div className="location-preview__meta">
					<span className="location-preview__description">
						<GeoSummary geo={geoResult} provider={geocodeProvider} />
						{(geoResult?.address || geoResult?.countryCode) && (
							<span className="location-preview__timestamp-sep"> · </span>
						)}
						<span className="location-preview__timestamps">
							{t("Created")} {relativeTime(location.createdAt)}
							{location.modifiedAt != null && (
								<>
									{" · "}
									{t("Modified")} {relativeTime(location.modifiedAt)}
								</>
							)}
						</span>
					</span>
					<div className="location-preview__date">
						<PanoDatePicker onChange={handleDateChange} />
					</div>
					<div className="location-preview__actions">
						<Button variant="primary" onClick={() => void handleSave()} data-qa="location-save">
							{isSeenPreview(location) ? t("Add to map") : t("Save")}
						</Button>
						{isReviewMode ? (
							<div style={{ display: "flex", justifyContent: "space-around" }}>
								<Tooltip content={t("Go to previous location (Control+Left)")}>
									<Button
										onClick={() => void reviewPrev()}
										disabled={reviewSession ? isAtStart(reviewSession) : true}
										aria-label={t("Go to previous location (Control+Left)")}
										data-qa="review-prev"
									>
										<Icon path={mdiChevronLeft} />
									</Button>
								</Tooltip>
								<Tooltip content={t("Go to next location (Control+Right)")}>
									<Button
										onClick={handleClose}
										aria-label={t("Go to next location (Control+Right)")}
										data-qa="review-next"
									>
										<Icon path={mdiChevronRight} />
									</Button>
								</Tooltip>
							</div>
						) : (
							<Button onClick={handleClose} data-qa="location-close">
								{t("Close")}
							</Button>
						)}
						<Button variant="destructive" onClick={handleDelete} data-qa="location-delete">
							{t("Delete")}
						</Button>
					</div>
					<div className="location-preview__tags">
						<TagEditor
							pendingTags={pendingTags}
							onChangeTags={setPendingTags}
							isImport={isImportPreview(location)}
						/>
					</div>
					<PluginLocationPanels />
				</div>
			</section>
		</>
	);
}

function GeoSummary({ geo, provider }: { geo: GeoDisplay | null; provider: GeocodeProvider }) {
	if (!geo?.countryCode && !geo?.address) return null;
	return (
		<>
			{geo.countryCode && (
				<Tooltip content={t(GEOCODE_PROVIDER_LABELS[provider])}>
					<span>
						<Flag code={geo.countryCode} />
					</span>
				</Tooltip>
			)}
			{geo.countryCode && geo.address && " "}
			{geo.address && <span>{geo.address}</span>}
		</>
	);
}
