import {
	memo,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useCallback,
	useEffectEvent,
	useSyncExternalStore,
} from "react";
import {
	LocationFlag,
	VIRTUAL_FLAGS,
	createLocation,
	isVirtualLocation,
	isImportPreview,
	isSeenPreview,
} from "@/types";
import { Tooltip } from "@/components/primitives/Tooltip";
import { Icon } from "@/components/primitives/Icon";
import { mdiChevronLeft, mdiChevronRight, mdiClose, mdiPlus } from "@mdi/js";
import { SV_SEARCH_RADIUS } from "@/lib/sv/constants";
import type { Tag } from "@/bindings.gen";
import {
	useActiveLocation,
	useCurrentMap,
	updateLocations,
	getActiveLocation,
	getCurrentMap,
	removeLocations,
	addLocations,
	createTags,
	setActiveLocation,
	getVisibleTags,
	useVisibleTags,
	useTagCounts,
} from "@/store/useMapStore";
import { sortTagsByMode, tagChipStyle, appendTagName } from "@/lib/util/util";
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
import { fetchSvMetadata } from "@/lib/sv/svMeta";

import { useSettings, useSetting, getSettings, GEOCODE_PROVIDER_LABELS } from "@/store/settings";
import { PluginLocationPanels } from "@/plugins/PluginPanels";
import { relativeTime } from "@/lib/util/format";
import { textColorFor } from "@/lib/util/color";
import { type PanoReference, resolvePano, fetchPanoData, showToast } from "@/lib/sv/lookup";
import { isOfficialPano } from "@/lib/sv/panoId";
import { enrich } from "@/lib/sv/enrich";
import { FullscreenMiniMap } from "@/components/editor/location/FullscreenMiniMap";
import { FullscreenTagBar } from "@/components/editor/location/FullscreenTagBar";
import { PanoControls, CrosshairOverlay, sendHideCar } from "./PanoControls";
import { seenPanoChanged, seenFlush, seenSetCanvas, seenUpdateGeo } from "@/lib/seen/seen";
import { useReverseGeocode, type GeoDisplay } from "@/components/editor/location/useReverseGeocode";
import { PanoViewerProvider, usePanoViewer, setPanoAltitude } from "./PanoViewerContext";
import {
	applyViewportLock,
	getViewportLockInfo,
	subscribeViewportLock,
	getViewportLockSnapshot,
} from "@/lib/sv/viewportLock";
import { resetTrail, pushTrail, clearTrail } from "@/lib/sv/svTrail";
import { singletonPano, singletonDiv, getPanorama, applyResolved } from "@/lib/sv/panoSingleton";
import { PanoDatePicker } from "./PanoDatePicker";
import { usePanoNavigation } from "./usePanoNavigation";
import { useLocationHotkeys } from "./useLocationHotkeys";

/** Tags are staged by name, not ID, because some tags do not exist yet. */
function idsToNames(ids: number[]): string[] {
	const tags = getCurrentMap()?.meta.tags ?? {};
	return ids.map((id) => tags[id]?.name).filter((n): n is string => n != null);
}

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
	const visibleTags = useVisibleTags();
	const tagCounts = useTagCounts();
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
				This location is still being imported and cannot be modified. Complete the import before
				making changes.
			</p>
		);
	}

	return (
		<>
			<ul className="tag-list">
				{pendingTags.map((name) => (
					<li key={name} className="tag is-small has-button" style={tagChipStyle(name, allTags)}>
						<button
							className="button tag__button tag__button--delete"
							onClick={() => handleRemoveTag(name)}
							type="button"
						>
							<Icon path={mdiClose} size={16} />
						</button>
						<span className="tag__text">{displayTagName(name)}</span>
					</li>
				))}
				<li>
					<form className="form-add-tag" onSubmit={handleAddTag}>
						<button className="button form-add-tag__button" type="submit">
							+
						</button>
						<input
							className="form-add-tag__input"
							type="text"
							placeholder="Add a tag…"
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
							<li
								key={t.id}
								className="tag is-small has-button"
								style={{
									backgroundColor: t.color,
									color: textColorFor(t.color),
								}}
							>
								<button
									className="button tag__button tag__button--add"
									onClick={() => handleSuggestionClick(t)}
									type="button"
								>
									<Icon path={mdiPlus} size={16} />
								</button>
								<span className="tag__text">{displayTagName(t.name)}</span>
							</li>
						))}
					</ol>
				</div>
			)}
		</>
	);
});

export function LocationPreview() {
	return (
		<PanoViewerProvider>
			<LocationPreviewInner />
		</PanoViewerProvider>
	);
}

function LocationPreviewInner() {
	const location = useActiveLocation();
	const map = useCurrentMap();
	const reviewSession = useReviewSession();
	const isReviewMode = reviewSession !== null;
	const panoContainerRef = useRef<HTMLDivElement>(null);
	const fullscreenContainerRef = useRef<HTMLDivElement>(null);
	const {
		currentPano,
		setCurrentPano,
		panoDates,
		setPanoDates,
		isFullscreen,
		setIsFullscreen,
		panoReady,
		setPanoReady,
		selectedPanoId,
	} = usePanoViewer();
	const [pendingTags, setPendingTags] = useState<string[]>(() => idsToNames(location?.tags ?? []));
	const visibleTags = useVisibleTags();
	const [panoGeo, setPanoGeo] = useState<GeoDisplay | null>(null);
	const geoResult = useReverseGeocode(location?.lat ?? 0, location?.lng ?? 0, panoGeo);
	const cancelTweenRef = useRef<(() => void) | null>(null);
	const getGeoResult = useEffectEvent(() => geoResult);
	useEffect(() => {
		setPendingTags((prev) => {
			const next = idsToNames(location?.tags ?? []);
			return prev.length === next.length && prev.every((n, i) => n === next[i]) ? prev : next;
		});
		setPanoGeo(null);
	}, [location?.id]);
	useEffect(() => {
		if (geoResult) seenUpdateGeo(geoResult);
	}, [geoResult]);
	const appSettings = useSettings();
	const bottomTrayRef = useRef<HTMLDivElement>(null);
	const [bottomTrayHeight, setBottomTrayHeight] = useState(0);
	useLayoutEffect(() => {
		const el = bottomTrayRef.current;
		if (!el) {
			setBottomTrayHeight(0);
			return;
		}
		const obs = new ResizeObserver(() => setBottomTrayHeight(el.offsetHeight));
		obs.observe(el);
		return () => obs.disconnect();
	}, [isFullscreen, appSettings.showFullscreenTagbar, appSettings.showFullscreenDatePicker]);
	useSyncExternalStore(subscribeViewportLock, getViewportLockSnapshot);
	const lockInfo = getViewportLockInfo();

	useEffect(() => {
		if (!singletonPano) return;
		const noMove = appSettings.defaultMovementMode !== "moving";
		singletonPano.setOptions({
			linksControl: noMove ? false : appSettings.showLinksControl,
			clickToGo: noMove ? false : appSettings.clickToGo,
			showRoadLabels: appSettings.showRoadLabels,
			scrollwheel: appSettings.defaultMovementMode !== "nmpz",
		});
	}, [
		appSettings.showLinksControl,
		appSettings.clickToGo,
		appSettings.showRoadLabels,
		appSettings.defaultMovementMode,
	]);

	useEffect(() => {
		if (!singletonPano) return;
		sendHideCar(!appSettings.showCar);
		const listener = singletonPano.addListener("status_changed", () => {
			if (singletonPano!.getStatus() === "OK") sendHideCar(!appSettings.showCar);
		});
		return () => {
			listener.remove();
		};
	}, [appSettings.showCar]);

	useEffect(() => {
		if (!singletonPano || !appSettings.showCrosshair) return;
		const overlay = new CrosshairOverlay(singletonPano);
		return () => overlay.dispose();
	}, [appSettings.showCrosshair]);

	// Mount/unmount: move the persistent div in/out of the container.
	// useLayoutEffect so setVisible(false) + appendChild run before paint.
	useLayoutEffect(() => {
		const container = panoContainerRef.current;
		if (!container) return;
		if (singletonPano) singletonPano.setVisible(false);
		container.appendChild(singletonDiv);
		return () => {
			if (container.contains(singletonDiv)) container.removeChild(singletonDiv);
		};
	}, []);

	useEffect(() => {
		if (!location || !panoContainerRef.current) return;
		let cancelled = false;
		let statusListener: google.maps.MapsEventListener | null = null;
		let lockListener: google.maps.MapsEventListener | null = null;

		loadOpenSV().then(async () => {
			if (cancelled) return;
			if (!google?.maps) return;
			const pano = getPanorama();
			if (!pano) return;

			// status_changed fires when the pano is fully loaded (getStatus() === "OK").
			// All data (panoId, position, POV) is consistent at this point.
			statusListener = pano.addListener("status_changed", () => {
				if (cancelled || pano.getStatus() !== "OK") return;
				const panoId = pano.getPano();
				if (!panoId) return; // ?
				const pos = pano.getPosition();
				setCurrentPano((prev) => {
					if (prev?.location?.pano === panoId) return prev;
					return {
						location: { pano: panoId, latLng: pos! },
						imageDate: prev?.imageDate,
					};
				});
				if (pos) {
					pushTrail(pos.lng(), pos.lat());
					const activeForSeen = getActiveLocation();
					const geo = getGeoResult();
					seenPanoChanged(
						{
							locationId:
								activeForSeen && !isVirtualLocation(activeForSeen) ? activeForSeen.id : null,
							panoId: panoId,
							lat: pos.lat(),
							lng: pos.lng(),
						},
						geo && {
							address: geo.address,
							countryCode: activeForSeen?.extra?.countryCode ?? geo.countryCode,
						},
						() => ({
							heading: pano.getPov().heading,
							pitch: pano.getPov().pitch,
							zoom: pano.getZoom(),
						}),
					);
				}
			});

			lockListener = pano.addListener("pano_changed", () => {
				applyViewportLock(pano);
			});

			sendHideCar(!getSettings().showCar);
			setCurrentPano(null);
			setPanoDates([]);
			resetTrail(location.lng, location.lat);

			const result = await resolvePano(location);
			if (cancelled) return;
			applyResolved(pano, result, location);
			google.maps.event.trigger(pano, "resize");
			if (result.isFallback) {
				const root = Object.values(pano).find((v) => v instanceof HTMLElement) as
					| HTMLElement
					| undefined;
				if (root)
					showToast(root, "Configured pano ID could not be found. Falling back to lat/lng.", 3000);
			}
			// Populate currentPano from the resolve result immediately.
			// Covers the case where setPano() with the same ID doesn't trigger status_changed.
			if (result.pano?.location) {
				setCurrentPano(result.pano);
			}
			setPanoReady(true);
			seenSetCanvas(() => singletonDiv.querySelector("canvas"));
		});

		return () => {
			cancelled = true;
			clearTrail();
			if (statusListener) google?.maps?.event?.removeListener(statusListener);
			if (lockListener) google?.maps?.event?.removeListener(lockListener);
			const pano = singletonPano;
			if (pano) {
				seenFlush(() => ({
					heading: pano.getPov().heading,
					pitch: pano.getPov().pitch,
					zoom: pano.getZoom(),
				}));
			}
		};
	}, [location?.id]);

	// Reactive: fetch dates + metadata whenever the current pano changes.
	useEffect(() => {
		if (!currentPano) {
			setPanoDates([]);
			return;
		}
		let cancelled = false;

		function extractTimes(data: google.maps.StreetViewPanoramaData | null): PanoReference[] {
			const raw = (data as unknown as { time?: { pano: string; AA?: Date }[] })?.time ?? [];
			return raw.flatMap((t) =>
				t.pano && t.AA instanceof Date ? [{ pano: t.pano, date: t.AA }] : [],
			);
		}

		const loc = currentPano.location;
		if (!loc?.latLng) return;
		const panoPos = { lat: loc.latLng.lat(), lng: loc.latLng.lng() };
		const byPano = fetchPanoData({ pano: loc.pano });
		const byLoc = fetchPanoData({ location: panoPos, radius: SV_SEARCH_RADIUS });

		Promise.all([byPano, byLoc]).then(([panoData, locData]) => {
			if (cancelled) return;
			const merged = new Map<string, PanoReference>();
			for (const t of extractTimes(locData)) merged.set(t.pano, t);
			for (const t of extractTimes(panoData)) merged.set(t.pano, t);

			// If all entries are unofficial, do an extra
			// official-only lookup to get the full multi-year coverage history.
			const allUnofficial = merged.size > 0 && [...merged.keys()].every((p) => !isOfficialPano(p));
			if (allUnofficial && !cancelled) {
				fetchPanoData({
					location: panoPos,
					radius: 25,
					sources: [google.maps.StreetViewSource.GOOGLE],
				}).then((officialData) => {
					if (cancelled) return;
					for (const t of extractTimes(officialData)) merged.set(t.pano, t);
					setPanoDates(Array.from(merged.values()));
				});
			} else {
				setPanoDates(Array.from(merged.values()));
			}
		});

		fetchSvMetadata([loc.pano]).then(([data]) => {
			if (cancelled || !data) return;
			setPanoAltitude(data.extra?.altitude ?? 0);
			setPanoGeo({
				address: data.location.description || "",
				countryCode: data.extra?.countryCode?.toUpperCase() ?? null,
			});
			const loc = getActiveLocation();
			if (loc) enrich(loc, data);
		});

		return () => {
			cancelled = true;
		};
	}, [location?.id, currentPano?.location?.pano]);

	// Reads the active location at call time to stay referentially stable
	// (it is a memo'd PanoDatePicker prop).
	const handleDateChange = useCallback((panoId: string | null) => {
		const loc = getActiveLocation();
		if (!singletonPano || !loc) return;
		// updateLocation no-ops for staged (virtual) locations at the store level.
		if (panoId == null) {
			updateLocations([{ id: loc.id, patch: { flags: loc.flags & ~LocationFlag.LoadAsPanoId } }]);
			if (loc.panoId) singletonPano.setPano(loc.panoId);
		} else {
			updateLocations([{ id: loc.id, patch: { flags: loc.flags | LocationFlag.LoadAsPanoId } }]);
			singletonPano.setPano(panoId);
		}
	}, []);

	const handleSave = useCallback(async () => {
		if (!location || !singletonPano) return;
		// Staged (virtual) location: updateLocation no-ops, cursorId can't match a
		// negative id, so this falls through to setActiveLocation(null) = close.
		const pov = singletonPano.getPov();
		const zoom = singletonPano.getZoom();
		const pano = singletonPano.getPano();
		const pos = singletonPano.getPosition();

		const savedPanoId = selectedPanoId ?? pano ?? location.panoId;

		if (isSeenPreview(location)) {
			await addLocations([
				createLocation({
					lat: pos?.lat() ?? location.lat,
					lng: pos?.lng() ?? location.lng,
					heading: pov.heading,
					pitch: pov.pitch,
					zoom,
					panoId: savedPanoId,
					flags: location.flags & ~VIRTUAL_FLAGS, // keep LoadAsPanoId; drop the preview-kind bits
					tags: (await createTags(pendingTags)).map((t) => t.id),
				}),
			]);
			setActiveLocation(null);
			return;
		}

		const panoChanged = savedPanoId !== location.panoId;
		updateLocations([
			{
				id: location.id,
				patch: {
					heading: pov.heading,
					pitch: pov.pitch,
					zoom: zoom,
					panoId: savedPanoId,
					lat: pos?.lat() ?? location.lat,
					lng: pos?.lng() ?? location.lng,
					tags: (await createTags(pendingTags)).map((t) => t.id),
					extra: panoChanged ? {} : location.extra,
				},
			},
		]);
		if (isReviewMode && reviewSession?.cursorId === location.id) {
			reviewNext();
		} else {
			setActiveLocation(null);
		}
	}, [location, selectedPanoId, isReviewMode, reviewSession, pendingTags]);

	const handleClose = useCallback(() => {
		if (isFullscreen) {
			setIsFullscreen(false);
			return;
		}
		if (isReviewMode) {
			reviewNext();
		} else {
			setActiveLocation(null);
		}
	}, [isReviewMode, isFullscreen]);

	const handleDelete = useCallback(() => {
		if (!location) return;
		if (isReviewMode && reviewSession?.cursorId === location.id) {
			reviewDelete();
		} else {
			removeLocations(new Set([location.id]));
		}
	}, [location, isReviewMode, reviewSession]);

	// Reads the active location at call time so the callback stays referentially
	// stable (it is a memo'd PanoControls prop).
	const handleReturnToSpawn = useCallback(async () => {
		const loc = getActiveLocation();
		if (!loc || !singletonPano) return;
		if (!google) return;
		const result = await resolvePano(loc);
		applyResolved(singletonPano, result, loc);
		google.maps.event.trigger(singletonPano, "resize");
		updateLocations([{ id: loc.id, patch: { flags: loc.flags & ~LocationFlag.LoadAsPanoId } }]);
	}, []);

	const handleFullscreen = useCallback(() => {
		setIsFullscreen((v) => !v);
	}, []);

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
		handleFullscreen,
		handleDateChange,
	});

	usePanoNavigation(appSettings);

	if (!location || !map) return null;

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
							? ({ "--fs-tray-h": `${bottomTrayHeight}px` } as React.CSSProperties)
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
						{panoReady && singletonPano && (
							<PanoControls
								panorama={singletonPano}
								isFullscreen={isFullscreen}
								onFullscreen={handleFullscreen}
								onReturnToSpawn={handleReturnToSpawn}
							/>
						)}
						{lockInfo && (
							<div className="viewport-lock-badge">
								VIEWPORT LOCK h {lockInfo.relHeading.toFixed(1)} p {lockInfo.relPitch.toFixed(1)} z{" "}
								{lockInfo.lockedZoom.toFixed(1)}
							</div>
						)}
					</div>
					{isFullscreen && appSettings.showFullscreenMinimap && <FullscreenMiniMap />}
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
						{geoResult?.countryCode && (
							<Tooltip content={GEOCODE_PROVIDER_LABELS[getSettings().geocodeProvider]}>
								<span>
									<img
										height={15}
										width={20}
										src={`/flags/${geoResult.countryCode.toUpperCase()}.svg`}
										alt={geoResult.countryCode}
										style={{ borderRadius: "2px", verticalAlign: "middle" }}
									/>
								</span>
							</Tooltip>
						)}
						{geoResult?.countryCode && geoResult.address && " "}
						{geoResult?.address && <span>{geoResult.address}</span>}
						{(geoResult?.address || geoResult?.countryCode) && (
							<span className="location-preview__timestamp-sep"> · </span>
						)}
						<span className="location-preview__timestamps">
							Created {relativeTime(location.createdAt)}
							{location.modifiedAt != null && (
								<>
									{" · "}Modified {relativeTime(location.modifiedAt)}
								</>
							)}
						</span>
					</span>
					<div className="location-preview__date">
						<PanoDatePicker onChange={handleDateChange} />
					</div>
					<div className="location-preview__actions">
						<button className="button button--primary" onClick={handleSave} data-qa="location-save">
							{isSeenPreview(location) ? "Add to map" : "Save"}
						</button>
						{isReviewMode ? (
							<div style={{ display: "flex", justifyContent: "space-around" }}>
								<Tooltip content="Go to previous location (Control+Left)">
									<button
										className="button"
										onClick={() => reviewPrev()}
										disabled={reviewSession ? isAtStart(reviewSession) : true}
										aria-label="Go to previous location (Control+Left)"
										data-qa="review-prev"
									>
										<Icon path={mdiChevronLeft} />
									</button>
								</Tooltip>
								<Tooltip content="Go to next location (Control+Right)">
									<button
										className="button"
										onClick={handleClose}
										aria-label="Go to next location (Control+Right)"
										data-qa="review-next"
									>
										<Icon path={mdiChevronRight} />
									</button>
								</Tooltip>
							</div>
						) : (
							<button className="button" onClick={handleClose} data-qa="location-close">
								Close
							</button>
						)}
						<button
							className="button button--destructive"
							onClick={handleDelete}
							data-qa="location-delete"
						>
							Delete
						</button>
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
