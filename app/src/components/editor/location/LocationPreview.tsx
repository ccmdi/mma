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
import { Button } from "@/components/primitives/Button";
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
	subscribeStore,
} from "@/store/useMapStore";
import { sortTagsByMode, tagChipStyle, appendTagName } from "@/lib/util/util";
import { log } from "@/lib/util/log";
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
import { usePanoViewer, setPanoAltitude } from "./PanoViewerContext";
import { togglePanoFullscreenState } from "./useFullscreenModeHotkeys";
import { resumeFullscreenMapAfterPano, exitFullscreenMap } from "./fullscreenModeState";
import { providerEntriesToPanoDates } from "./panoDate";
import {
	applyViewportLock,
	getViewportLockInfo,
	subscribeViewportLock,
	getViewportLockSnapshot,
} from "@/lib/sv/viewportLock";
import { resetTrail, pushTrail, clearTrail } from "@/lib/sv/svTrail";
import { singletonPano, singletonDiv, getPanorama, applyResolved } from "@/lib/sv/panoSingleton";
import {
	findPanoProvider,
	subscribePanoProviders,
	getPanoProvidersSnapshot,
	setActivePanoViewport,
	getActivePanoViewport,
	subscribeActivePanoViewport,
	getActivePanoViewportSnapshot,
	type PanoProviderSession,
} from "@/lib/sv/panoProvider";
import { getLocationProvider } from "@/lib/sv/providers/types";
import { ensureProviderEnabled } from "@/lib/sv/providers/settings";
import { stripBaidu, isBaiduPanoId } from "@/lib/sv/baidu/prefix";
import { buildBaiduExtra } from "@/lib/sv/baidu/panoExtra";
import {
	baiduSaveExtra,
	baiduSpawnPanoId,
	loadBaiduDateEntries,
} from "@/lib/sv/baidu/session";
import { stripTencent, isTencentPanoId } from "@/lib/sv/tencent/prefix";
import { buildTencentExtra } from "@/lib/sv/tencent/panoExtra";
import {
	tencentSaveExtra,
	tencentSpawnPanoId,
	loadTencentDateEntries,
} from "@/lib/sv/tencent/session";
import { installGoogleInjectBridge } from "@/lib/sv/providers/googleInject";
import {
	injectAlternatesAsDateEntries,
	subscribeInjectAlternates,
} from "@/lib/sv/providers/alternates";
import { patchLocationExtra } from "@/lib/sv/lookaround/patchExtra";
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
		coverageDefaultPanoId,
		setCoverageDefaultPanoId,
	} = usePanoViewer();
	const providerEpoch = useSyncExternalStore(
		subscribePanoProviders,
		getPanoProvidersSnapshot,
		getPanoProvidersSnapshot,
	);
	const activeProvider = location ? findPanoProvider(location) : null;
	const [providerSession, setProviderSession] = useState<PanoProviderSession | null>(null);
	const effectivePano = providerSession?.panorama ?? singletonPano;
	const [pendingTags, setPendingTags] = useState<string[]>(() => idsToNames(location?.tags ?? []));
	const visibleTags = useVisibleTags();
	const [panoGeo, setPanoGeo] = useState<GeoDisplay | null>(null);
	const geoResult = useReverseGeocode(location?.lat ?? 0, location?.lng ?? 0, panoGeo);
	const cancelTweenRef = useRef<(() => void) | null>(null);
	const getGeoResult = useEffectEvent(() => geoResult);
	useEffect(() => {
		document.body.classList.toggle("pano-fullscreen", isFullscreen);
		return () => document.body.classList.remove("pano-fullscreen");
	}, [isFullscreen]);

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
	const yieldPanoToMini =
		appSettings.fullscreenMap && appSettings.showFullscreenMiniLocationPreview;
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
		yieldPanoToMini,
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

	const altViewportEpoch = useSyncExternalStore(
		subscribeActivePanoViewport,
		getActivePanoViewportSnapshot,
		getActivePanoViewportSnapshot,
	);

	// Mount/unmount Google singleton. Look Around (and other alt providers) replace the host.
	// Baidu uses the same singleton via BAIDU: inject — it is not an MMA PanoProvider.
	// Yield to FullscreenMiniLocationPreview while fullscreen-map mode owns the chip.
	useLayoutEffect(() => {
		if (yieldPanoToMini) return;
		const container = panoContainerRef.current;
		if (!container) return;
		if (activeProvider) {
			if (singletonPano) singletonPano.setVisible(false);
			if (container.contains(singletonDiv)) container.removeChild(singletonDiv);
			const vp = getActivePanoViewport();
			if (vp && !container.contains(vp)) container.appendChild(vp);
			return;
		}
		container.appendChild(singletonDiv);
		const pano = getPanorama();
		if (pano) {
			pano.setVisible(true);
			google.maps.event.trigger(pano, "resize");
		}
		return () => {
			if (container.contains(singletonDiv)) container.removeChild(singletonDiv);
		};
	}, [yieldPanoToMini, activeProvider?.id, location?.id, altViewportEpoch]);

	useEffect(() => {
		if (!location || !panoContainerRef.current) return;
		let cancelled = false;
		let statusListener: google.maps.MapsEventListener | null = null;
		let lockListener: google.maps.MapsEventListener | null = null;
		let session: PanoProviderSession | null = null;

		const provider = findPanoProvider(location);
		if (provider) {
			ensureProviderEnabled(getLocationProvider(location));
			setPanoReady(false);
			setProviderSession(null);
			setCurrentPano(null);
			setPanoDates([]);
			// Seed altitude from location.extra before the async open() resolves —
			// coordinate-control reads the module store, not React state.
			const seedAlt = location.extra?.altitude;
			setPanoAltitude(
				typeof seedAlt === "number" && Number.isFinite(seedAlt) ? seedAlt : null,
			);
			if (singletonPano) singletonPano.setVisible(false);
			const host = panoContainerRef.current;
			const toastHost = fullscreenContainerRef.current ?? host;
			host.replaceChildren();
			resetTrail(location.lng, location.lat);

			setActivePanoViewport(null);
			void provider
				.open(host, location)
				.then((s) => {
					if (cancelled) {
						s.destroy();
						return;
					}
					session = s;
					setProviderSession(s);
					setActivePanoViewport(s.viewport ?? null, s.resize);
					const pano = s.panorama;

					/** Seed controls immediately. Proxy emits `status_changed` in a
					 *  microtask scheduled during `open()`, which can run BEFORE this
					 *  `then` attaches listeners — waiting on that event alone leaves
					 *  date/altitude/cameraType empty forever. */
					const syncProviderUi = () => {
						if (cancelled) return;
						const panoId = pano.getPano();
						const pos = pano.getPosition();
						const entries = s.getAlternateDates?.() ?? [];
						if (entries.length > 0) {
							setPanoDates(providerEntriesToPanoDates(entries, panoId));
						}
						if (!panoId || !pos) return;
						const active = getActiveLocation();
						// Google SV: YYYY-MM string. Look Around: capture timestamp (ms)
						// — derive YYYY-MM in the pano timezone for date-state fallbacks.
						let imageDate: string | undefined;
						if (typeof active?.extra?.imageDate === "string") {
							imageDate = active.extra.imageDate;
						} else if (typeof active?.extra?.datetime === "number") {
							const tz =
								typeof active.extra.timezone === "string"
									? active.extra.timezone
									: "UTC";
							try {
								imageDate = new Intl.DateTimeFormat("en-CA", {
									timeZone: tz,
									year: "numeric",
									month: "2-digit",
								})
									.format(new Date(active.extra.datetime * 1000))
									.slice(0, 7);
							} catch {
								const d = new Date(active.extra.datetime * 1000);
								imageDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
							}
						} else if (typeof active?.extra?.imageDate === "number") {
							const d = new Date(active.extra.imageDate);
							imageDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
						}
						setCurrentPano({
							location: { pano: panoId, latLng: pos },
							imageDate,
						});
						if (entries.length === 0) {
							setPanoDates([]);
						}
						const alt = s.getAltitude?.();
						if (typeof alt === "number" && Number.isFinite(alt)) {
							setPanoAltitude(alt);
						} else if (typeof active?.extra?.altitude === "number") {
							setPanoAltitude(active.extra.altitude);
						} else {
							setPanoAltitude(null);
						}
					};

					syncProviderUi();
					statusListener = pano.addListener("status_changed", () => {
						if (cancelled || pano.getStatus() !== "OK") return;
						syncProviderUi();
						const panoId = pano.getPano();
						const pos = pano.getPosition();
						if (!panoId || !pos) return;
						pushTrail(pos.lng(), pos.lat());
						const activeForSeen = getActiveLocation();
						const geo = getGeoResult();
						seenPanoChanged(
							{
								locationId:
									activeForSeen && !isVirtualLocation(activeForSeen)
										? activeForSeen.id
										: null,
								panoId,
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
					});
					setPanoReady(true);
				})
				.catch((err) => {
					if (cancelled) return;
					log.warn("[LocationPreview] pano provider failed:", err);
					if (toastHost) {
						showToast(
							toastHost,
							err instanceof Error ? err.message : "Failed to open panorama provider",
							4000,
						);
					}
					setPanoReady(false);
				});

			return () => {
				cancelled = true;
				clearTrail();
				if (statusListener) {
					try {
						statusListener.remove();
					} catch {
						/* ignore */
					}
				}
				setActivePanoViewport(null);
				session?.destroy();
				setProviderSession(null);
			};
		}

		setProviderSession(null);
		setActivePanoViewport(null);

		loadOpenSV().then(async () => {
			if (cancelled) return;
			if (!google?.maps) return;
			// Baidu / Tencent pins share the Google singleton; install inject before setPano.
			const injectProvider = getLocationProvider(location);
			if (injectProvider === "baidu" || injectProvider === "tencent") {
				ensureProviderEnabled(injectProvider);
				await installGoogleInjectBridge();
			}
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
	}, [location?.id, providerEpoch]);

	// Reactive: fetch dates + metadata whenever the current pano changes.
	// Alt providers own their own metadata — skip Google SV lookups.
	useEffect(() => {
		// Apply/subscribe alt-provider dates as soon as the session exists — do not
		// wait for currentPano (getPosition can lag on custom panos, which previously
		// left the date picker empty forever).
		if (providerSession) {
			const applyAltDates = () => {
				const entries = providerSession.getAlternateDates?.() ?? [];
				const currentPanoId =
					providerSession.panorama.getPano() ?? currentPano?.location?.pano ?? null;
				if (entries.length > 0) {
					setPanoDates(providerEntriesToPanoDates(entries, currentPanoId));
					return;
				}
				setPanoDates([]);
			};
			const syncAltitude = () => {
				const fromProvider = providerSession.getAltitude?.();
				if (typeof fromProvider === "number" && Number.isFinite(fromProvider)) {
					setPanoAltitude(fromProvider);
					return;
				}
				const active = getActiveLocation();
				const alt = active?.extra?.altitude;
				setPanoAltitude(typeof alt === "number" && Number.isFinite(alt) ? alt : null);
			};
			applyAltDates();
			syncAltitude();
			const unsubDates = providerSession.subscribeAlternateDates?.(applyAltDates);
			const unsubStore = subscribeStore(() => {
				const alt = getActiveLocation()?.extra?.altitude;
				if (typeof alt === "number" && Number.isFinite(alt)) setPanoAltitude(alt);
			});
			const panoListener = providerSession.panorama.addListener("pano_changed", () => {
				syncAltitude();
				applyAltDates();
				const active = getActiveLocation();
				const panoId = providerSession.panorama.getPano();
				const pos = providerSession.panorama.getPosition();
				if (panoId && pos) {
					let imageDate: string | undefined;
					if (typeof active?.extra?.imageDate === "string") {
						imageDate = active.extra.imageDate;
					} else if (typeof active?.extra?.datetime === "number") {
						const tz =
							typeof active.extra.timezone === "string"
								? active.extra.timezone
								: "UTC";
						try {
							imageDate = new Intl.DateTimeFormat("en-CA", {
								timeZone: tz,
								year: "numeric",
								month: "2-digit",
							})
								.format(new Date(active.extra.datetime * 1000))
								.slice(0, 7);
						} catch {
							const d = new Date(active.extra.datetime * 1000);
							imageDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
						}
					} else if (typeof active?.extra?.imageDate === "number") {
						const d = new Date(active.extra.imageDate);
						imageDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
					}
					setCurrentPano({
						location: { pano: panoId, latLng: pos },
						imageDate,
					});
				}
			});
			const statusListener = providerSession.panorama.addListener(
				"status_changed",
				syncAltitude,
			);
			return () => {
				unsubDates?.();
				unsubStore();
				try {
					panoListener.remove();
					statusListener.remove();
				} catch {
					/* ignore */
				}
			};
		}

		if (!currentPano) {
			setPanoDates([]);
			return;
		}
		let cancelled = false;

		const loc = currentPano.location;
		if (!loc?.latLng) return;

		// Baidu / Tencent timeline via provider meta (native Google date RPC does not apply).
		// Sibling inject-provider hits from the parallel race are merged into the date picker.
		if (isBaiduPanoId(loc.pano) || isTencentPanoId(loc.pano)) {
			const lat = loc.latLng.lat();
			const lng = loc.latLng.lng();
			const applyChinaDates = (
				entries: { pano: string; timestamp: number; cameraType?: string }[],
			) => {
				if (cancelled) return;
				const merged = [
					...entries,
					...injectAlternatesAsDateEntries(lat, lng, loc.pano),
				];
				setPanoDates(providerEntriesToPanoDates(merged, loc.pano));
			};

			if (isBaiduPanoId(loc.pano)) {
				void loadBaiduDateEntries(loc.pano).then(({ entries, meta, defaultPanoId }) => {
					if (cancelled) return;
					applyChinaDates(entries);
					if (defaultPanoId) setCoverageDefaultPanoId(defaultPanoId);
					setPanoAltitude(meta?.altitude ?? null);
					const active = getActiveLocation();
					if (active && meta) void patchLocationExtra(active, buildBaiduExtra(meta));
				});
			} else {
				void loadTencentDateEntries(loc.pano).then(({ entries, meta, defaultPanoId }) => {
					if (cancelled) return;
					applyChinaDates(entries);
					if (defaultPanoId) setCoverageDefaultPanoId(defaultPanoId);
					setPanoAltitude(null);
					const active = getActiveLocation();
					if (active && meta) void patchLocationExtra(active, buildTencentExtra(meta));
				});
			}

			const unsubAlts = subscribeInjectAlternates(() => {
				if (cancelled) return;
				if (isBaiduPanoId(loc.pano)) {
					void loadBaiduDateEntries(loc.pano).then(({ entries }) => applyChinaDates(entries));
				} else {
					void loadTencentDateEntries(loc.pano).then(({ entries }) => applyChinaDates(entries));
				}
			});

			return () => {
				cancelled = true;
				unsubAlts();
			};
		}

		function extractTimes(data: google.maps.StreetViewPanoramaData | null): PanoReference[] {
			const raw = (data as unknown as { time?: { pano: string; AA?: Date }[] })?.time ?? [];
			return raw.flatMap((t) =>
				t.pano && t.AA instanceof Date ? [{ pano: t.pano, date: t.AA }] : [],
			);
		}

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
			setPanoAltitude(data.extra?.altitude ?? null);
			setPanoGeo({
				address: data.location.description || "",
				countryCode: data.extra?.countryCode?.toUpperCase() ?? null,
			});
			const active = getActiveLocation();
			if (active) enrich(active, data);
		});

		return () => {
			cancelled = true;
		};
	}, [location?.id, currentPano?.location?.pano, providerSession, setCoverageDefaultPanoId]);

	// Reads the active location at call time to stay referentially stable
	// (it is a memo'd PanoDatePicker prop).
	const handleDateChange = useCallback(
		(panoId: string | null) => {
			const loc = getActiveLocation();
			if (!loc) return;
			// Alt providers (e.g. Look Around) own their own pano graph — no Google
			// LoadAsPanoId flag. null = return to the spawn / default capture.
			if (providerSession) {
				if (panoId != null) {
					providerSession.panorama.setPano(panoId);
				} else {
					const spawnId = activeProvider?.getSpawnPanoId?.(loc) ?? null;
					if (spawnId) providerSession.panorama.setPano(spawnId);
				}
				return;
			}
			if (!singletonPano) return;
			// updateLocation no-ops for staged (virtual) locations at the store level.
			if (panoId == null) {
				updateLocations([{ id: loc.id, patch: { flags: loc.flags & ~LocationFlag.LoadAsPanoId } }]);
				// Inject providers: Default = coverage default / spawn pin (not Google RPC).
				const live = singletonPano.getPano();
				const injectProv = isBaiduPanoId(live)
					? "baidu"
					: isTencentPanoId(live)
						? "tencent"
						: getLocationProvider(loc);
				const def =
					injectProv === "baidu"
						? (coverageDefaultPanoId ?? baiduSpawnPanoId(loc))
						: injectProv === "tencent"
							? (coverageDefaultPanoId ?? tencentSpawnPanoId(loc))
							: loc.panoId;
				if (def) singletonPano.setPano(def);
			} else {
				updateLocations([{ id: loc.id, patch: { flags: loc.flags | LocationFlag.LoadAsPanoId } }]);
				singletonPano.setPano(panoId);
			}
		},
		[providerSession, activeProvider, coverageDefaultPanoId],
	);

	const handleSave = useCallback(async () => {
		if (!location || !effectivePano) return;
		// Staged (virtual) location: updateLocation no-ops, cursorId can't match a
		// negative id, so this falls through to setActiveLocation(null) = close.
		const pov = effectivePano.getPov();
		const zoom = effectivePano.getZoom();
		const pano = effectivePano.getPano();
		const pos = effectivePano.getPosition();

		const provider = findPanoProvider(location);
		// Prefer the live viewer pano prefix when switching Baidu ↔ Tencent dates.
		const liveProvider = isBaiduPanoId(pano)
			? "baidu"
			: isTencentPanoId(pano)
				? "tencent"
				: getLocationProvider(location);
		const isBaidu = liveProvider === "baidu";
		const isTencent = liveProvider === "tencent";
		const isInjectAlt = isBaidu || isTencent;
		const providerId =
			isBaidu || isTencent
				? liveProvider
				: (provider?.id ?? location.provider ?? "google");
		let savedPanoId = selectedPanoId ?? pano ?? location.panoId;
		// Inject viewers use PREFIX: ids; store raw svid/sid on the location.
		if (isBaidu && typeof savedPanoId === "string") {
			savedPanoId = stripBaidu(savedPanoId);
		} else if (isTencent && typeof savedPanoId === "string") {
			savedPanoId = stripTencent(savedPanoId);
		}
		const isAltProvider = Boolean(providerSession);
		const saveExtra =
			pano && isBaidu
				? baiduSaveExtra(pano)
				: pano && isTencent
					? tencentSaveExtra(pano)
					: pano && provider?.buildSaveExtra
						? provider.buildSaveExtra(location, pano)
						: {};

		if (isSeenPreview(location)) {
			await addLocations([
				createLocation({
					lat: pos?.lat() ?? location.lat,
					lng: pos?.lng() ?? location.lng,
					heading: pov.heading,
					pitch: pov.pitch,
					zoom,
					panoId: savedPanoId,
					provider: isAltProvider || isInjectAlt ? providerId : (location.provider ?? "google"),
					flags: location.flags & ~VIRTUAL_FLAGS, // keep LoadAsPanoId; drop the preview-kind bits
					tags: (await createTags(pendingTags)).map((t) => t.id),
					extra: {
						...location.extra,
						...saveExtra,
					},
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
					lat: pos?.lat() ?? location.lat,
					lng: pos?.lng() ?? location.lng,
					tags: (await createTags(pendingTags)).map((t) => t.id),
					panoId: savedPanoId,
					provider: isAltProvider || isInjectAlt ? providerId : (location.provider ?? "google"),
					extra: {
						...(panoChanged && !isAltProvider && !isInjectAlt ? {} : (location.extra ?? {})),
						...saveExtra,
					},
				},
			},
		]);
		if (isReviewMode && reviewSession?.cursorId === location.id) {
			reviewNext();
		} else {
			setActiveLocation(null);
		}
	}, [
		location,
		selectedPanoId,
		isReviewMode,
		reviewSession,
		pendingTags,
		effectivePano,
		providerSession,
	]);

	const handleClose = useCallback(() => {
		if (isFullscreen) {
			setIsFullscreen(false);
			resumeFullscreenMapAfterPano();
			return;
		}
		if (getSettings().fullscreenMap) {
			exitFullscreenMap(setIsFullscreen);
			return;
		}
		if (isReviewMode) {
			reviewNext();
		} else {
			setActiveLocation(null);
		}
	}, [isReviewMode, isFullscreen, setIsFullscreen]);

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
		if (!loc) return;
		if (providerSession) {
			const spawnId = findPanoProvider(loc)?.getSpawnPanoId?.(loc) ?? null;
			const current = providerSession.panorama.getPano();
			if (spawnId && current !== spawnId) {
				providerSession.panorama.setPano(spawnId);
			}
			providerSession.panorama.setPov({ heading: loc.heading, pitch: loc.pitch });
			providerSession.panorama.setZoom(loc.zoom);
			return;
		}
		if (!singletonPano || !google) return;
		const result = await resolvePano(loc);
		applyResolved(singletonPano, result, loc);
		google.maps.event.trigger(singletonPano, "resize");
		updateLocations([{ id: loc.id, patch: { flags: loc.flags & ~LocationFlag.LoadAsPanoId } }]);
	}, [providerSession]);

	const handleFullscreen = useCallback(() => {
		togglePanoFullscreenState(location, isFullscreen, setIsFullscreen);
	}, [location, isFullscreen, setIsFullscreen]);

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
		handleDateChange,
		panorama: effectivePano,
	});

	usePanoNavigation(appSettings, effectivePano);

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
						<div className="location-preview__pano-host" ref={panoContainerRef} />
						{appSettings.defaultMovementMode === "nmpz" && (
							<div className="location-preview__nmpz-shield" />
						)}
					</div>
					{panoReady && effectivePano && (
						<PanoControls
							panorama={effectivePano}
							isFullscreen={isFullscreen}
							onFullscreen={handleFullscreen}
							onReturnToSpawn={handleReturnToSpawn}
							altProvider={Boolean(providerSession)}
						/>
					)}
					{lockInfo && (
						<div className="viewport-lock-badge">
							VIEWPORT LOCK h <span className="mono">{lockInfo.relHeading.toFixed(1)}</span> p{" "}
							<span className="mono">{lockInfo.relPitch.toFixed(1)}</span> z{" "}
							<span className="mono">{lockInfo.lockedZoom.toFixed(1)}</span>
						</div>
					)}
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
						<Button variant="primary" onClick={handleSave} data-qa="location-save">
							{isSeenPreview(location) ? "Add to map" : "Save"}
						</Button>
						{isReviewMode ? (
							<div style={{ display: "flex", justifyContent: "space-around" }}>
								<Tooltip content="Go to previous location (Control+Left)">
									<Button
										onClick={() => reviewPrev()}
										disabled={reviewSession ? isAtStart(reviewSession) : true}
										aria-label="Go to previous location (Control+Left)"
										data-qa="review-prev"
									>
										<Icon path={mdiChevronLeft} />
									</Button>
								</Tooltip>
								<Tooltip content="Go to next location (Control+Right)">
									<Button
										onClick={handleClose}
										aria-label="Go to next location (Control+Right)"
										data-qa="review-next"
									>
										<Icon path={mdiChevronRight} />
									</Button>
								</Tooltip>
							</div>
						) : (
							<Button onClick={handleClose} data-qa="location-close">
								Close
							</Button>
						)}
						<Button variant="destructive" onClick={handleDelete} data-qa="location-delete">
							Delete
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
