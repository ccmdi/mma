import { memo, useLayoutEffect, useMemo, useRef, useState, useCallback } from "react";
import { Store } from "@/store/store";
import { Location } from "@/store/location";
import { Editor } from "@/store/editor";
import { Tag } from "@/store/tag";
import { Edit } from "@/store/edit";
import { setPinned } from "@/types";
import { Tooltip } from "@/components/primitives/Tooltip";
import { Icon } from "@/components/primitives/Icon";
import { Button } from "@/components/primitives/Button";
import { AddTagForm } from "@/components/editor/tags/AddTagForm";
import { mdiChevronLeft, mdiChevronRight } from "@mdi/js";
import { sortTagsByMode, tagColorFor, appendTagName } from "@/lib/data/tags";
import { TagPill, TagPillButton } from "@/components/primitives/TagPill";
import { displayTagName } from "@/lib/data/tags";
import { ReviewBar } from "@/components/editor/location/ReviewBar";
import { Review } from "@/lib/review/review";
import {
	useSettings,
	useSetting,
	GEOCODE_PROVIDER_LABELS,
	type GeocodeProvider,
} from "@/store/settings";
import { useHotkey } from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys";
import { PluginLocationPanels } from "@/plugins/PluginPanels";
import { relativeTime } from "@/lib/util/format";
import { FullscreenMiniMap } from "@/components/editor/location/FullscreenMiniMap";
import { FullscreenTagBar } from "@/components/editor/location/FullscreenTagBar";
import { PanoControls } from "./PanoControls";
import type { GeoDisplay } from "@/lib/geo/reverseGeocode";
import { usePanoViewer } from "./PanoViewerContext";
import {
	usePanoFullscreen,
	togglePanoFullscreen,
	exitPanoFullscreen,
	exitFullscreenMap,
} from "./fullscreenModeState";
import { FullscreenMiniLocationPreview } from "./FullscreenMiniLocationPreview";
import { getViewportLockInfo } from "@/lib/sv/viewportLock";
import { useEvent } from "@/lib/events";
import { usePano } from "@/lib/hooks/usePano";
import { PanoDatePicker } from "./PanoDatePicker";
import { usePanoSession } from "./usePanoSession";
import { useSeenFeed } from "./useSeenFeed";
import { usePanoDisplay } from "./usePanoDisplay";
import { usePendingTags } from "./usePendingTags";
import { usePanoNavigation } from "./usePanoNavigation";
import { useLocationHotkeys } from "./useLocationHotkeys";
import { Flag } from "@/components/primitives/Flag";
import { t } from "@/lib/i18n";
import { search } from "@/lib/search";

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
	const visibleTags = Store.use(Tag.visible);
	const tagCounts = Store.use(() => Tag.counts());
	const tagSortMode = useSetting("tagSortMode");
	const suggestionLimit = useSetting("tagSuggestionLimit");

	const allTags = useMemo(
		() => sortTagsByMode(visibleTags, tagSortMode, tagCounts),
		[visibleTags, tagSortMode, tagCounts],
	);
	const suggestions = useMemo(() => {
		const pendingLower = new Set(pendingTags.map((n) => n.toLowerCase()));
		const available = search(allTags, tagInput, (t) => [t.name]).filter(
			(t) => !pendingLower.has(t.name.toLowerCase()),
		);
		return available.slice(0, suggestionLimit || available.length);
	}, [allTags, pendingTags, tagInput, suggestionLimit]);

	const addPendingTag = (name: string) =>
		onChangeTags((prev) => appendTagName(prev, name, Tag.visible()));

	const handleAddTag = () => {
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
					<AddTagForm value={tagInput} onChange={setTagInput} onAdd={handleAddTag} />
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

export function LocationPreview() {
	const location = Editor.use((s) => s.open?.location ?? null);
	const origin = Editor.use((s) => s.open?.origin);
	const map = Store.use((s) => s.map);
	const reviewSession = Review.useSession();
	const isReviewMode = reviewSession !== null;
	const panoContainerRef = useRef<HTMLDivElement>(null);
	const fullscreenContainerRef = useRef<HTMLDivElement>(null);
	const { defaultPano, geo } = usePanoViewer();
	const { edit, save } = Editor.draft();
	const writing = Editor.useWriting();
	const isFullscreen = usePanoFullscreen();
	const [pendingTags, setPendingTags] = usePendingTags(location);
	const visibleTags = Store.use(Tag.visible);
	const geocodeProvider = useSetting("geocodeProvider");
	const appSettings = useSettings();
	const chipMode = appSettings.fullscreenMap && appSettings.showFullscreenMiniLocationPreview;
	usePanoSession();
	useSeenFeed();
	const panoMount = usePanoDisplay(panoContainerRef);

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
	const pano = usePano();
	useEvent("viewport-lock:changed");
	const lockInfo = getViewportLockInfo();

	// A chosen date pins the draft to that pano; Default floats it on the pano Google resolves for the position.
	const handleDateChange = useCallback(
		(selectedPanoId: string | null) => {
			void edit((location) => setPinned(location, selectedPanoId != null));
			const target = selectedPanoId ?? defaultPano?.id;
			if (target) pano.jump(target);
		},
		[pano, edit, defaultPano],
	);

	const handleSave = useCallback(async () => {
		if (!location || !pano.exists()) return;
		if (origin === "import") {
			Editor.close();
			return;
		}

		// Save with the live camera. Pending enrichment joins the saved location
		// and its undo step when it finishes.
		const saved = await save({
			...pano.captureView(),
			tags: pendingTags.length
				? (
						await Edit.values(
							"tags",
							pendingTags.map((name) => ({ add: { id: 0, name } })),
						)
					).keys
				: [],
		});
		if (saved == null) return;

		if (isReviewMode && reviewSession?.cursorId === location.id) {
			void Review.next();
		} else {
			Editor.close();
		}
	}, [pano, location, origin, save, isReviewMode, reviewSession, pendingTags]);

	const handleClose = useCallback(() => {
		if (exitPanoFullscreen()) return;
		if (exitFullscreenMap()) return;
		if (isReviewMode) {
			void Review.next();
		} else {
			Editor.close();
		}
	}, [isReviewMode]);

	const handleDelete = useCallback(() => {
		if (!location) return;
		if (origin !== "map") {
			Editor.close();
			return;
		}
		if (isReviewMode && reviewSession?.cursorId === location.id) {
			void Review.deleteCurrent();
		} else {
			void Location.remove(new Set([location.id]));
		}
	}, [location, origin, isReviewMode, reviewSession]);

	// Reads the open location at call time so the callback stays referentially
	// stable (it is a memo'd PanoControls prop).
	const handleReturnToSpawn = useCallback(async () => {
		const loc = Editor.get().open?.spawn;
		if (!loc || !pano.exists()) return;
		if ((await pano.show(loc)).status === "superseded") return;
		await edit((location) => setPinned(location, false));
	}, [pano, edit]);

	const handleFullscreen = useCallback(() => {
		if (location) togglePanoFullscreen();
	}, [location]);

	useHotkey(useBinding("toggleFullscreen"), handleFullscreen);

	useLocationHotkeys({
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
					<div ref={panoMount} className="fullscreen-mini-location__pano" />
				</FullscreenMiniLocationPreview>
			</>
		);
	}

	return (
		<>
			<ReviewBar />
			<section
				className={`location-preview${appSettings.previewAspectRatio === "free" ? " free-resize" : ""}`}
				data-enriching={writing || undefined}
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
						<div style={{ position: "absolute", inset: 0 }} ref={panoMount} />
						{appSettings.defaultMovementMode === "nmpz" && (
							<div style={{ position: "absolute", inset: 0, zIndex: 1 }} />
						)}
						{location && pano.exists() && (
							<PanoControls
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
							{appSettings.showFullscreenGeocode && (geo?.countryCode || geo?.address) && (
								<div className="fullscreen-geocode">
									<GeoSummary geo={geo} provider={geocodeProvider} />
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
						<GeoSummary geo={geo} provider={geocodeProvider} />
						{(geo?.address || geo?.countryCode) && (
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
							{origin === "seen" ? t("Add to map") : t("Save")}
						</Button>
						{isReviewMode ? (
							<div style={{ display: "flex", justifyContent: "space-around" }}>
								<Tooltip content={t("Go to previous location (Control+Left)")}>
									<Button
										onClick={() => void Review.prev()}
										disabled={reviewSession ? Review.isAtStart(reviewSession) : true}
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
							isImport={origin === "import"}
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
