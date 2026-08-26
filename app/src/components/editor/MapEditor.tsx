import { useEffect, useEffectEvent, useRef, useState } from "react";
import { events } from "@/bindings.gen";
import {
	useMapState,
	getMapState,
	mutate,
	removeLocations,
	discardOpenMap,
} from "@/store/useMapStore";
import { beginImportPaste, beginImportFromPath } from "@/store/importStaging";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { goTo } from "@/store/router";
import { activatePlugins, deactivatePlugins } from "@/plugins/registry";
import { getMapHost, waitForMapHost } from "@/lib/map/mapState";
import { addParsedLocations } from "@/lib/map/mapClick";
import { pluginsReady } from "@/plugins";
import { MapEmbed } from "@/components/editor/map/MapEmbed";
import { MapMetaBar } from "@/components/editor/map/MapMetaBar";
import { MapOverview } from "@/components/editor/map/MapOverview";
import { ImportSidebar } from "@/components/editor/ImportSidebar";
import { DiffSidebar } from "@/components/editor/DiffSidebar";
import { LocationPreview } from "@/components/editor/location/LocationPreview";
import { PanoViewerProvider } from "@/components/editor/location/PanoViewerContext";
import {
	exitFullscreenMap,
	toggleFullscreenMap,
} from "@/components/editor/location/fullscreenModeState";
import { ChipHostContext } from "@/components/editor/location/FullscreenMiniLocationPreview";
import { CommandPalette } from "@/components/editor/CommandPalette";
import { MapRenameForm } from "@/components/editor/MapRenameForm";
import { EnrichmentButton } from "@/components/editor/map/EnrichmentDialog";
import { Dialog, DialogTrigger, DialogContent } from "@/components/primitives/Dialog";
import {
	useHotkey,
	useCommandHotkeys,
	isActivationElement,
	isEditableElement,
	pluginOverlayOwnsInput,
} from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { usePointerDrag } from "@/lib/hooks/usePointerDrag";
import { useSettings, getSettings } from "@/store/settings";
import {
	parseMapsUrl,
	parseCoordinates,
	parseUrlList,
	parsedLocationsToImportJson,
} from "@/lib/data/importExport";
import { Icon } from "@/components/primitives/Icon";
import { Tooltip } from "@/components/primitives/Tooltip";
import { mdiBackburger, mdiPencil, mdiFileDocumentOutline } from "@mdi/js";
import { DoclinkPanel } from "@/components/editor/doclink/DoclinkPanel";
import { DoclinkAssignDialog } from "@/components/editor/doclink/DoclinkAssignDialog";
import { useDialogState } from "@/store/dialogBus";
import { doclinkedTags, prefetchDoclinks } from "@/lib/doclink";
import { PluginSidebarHost } from "@/components/editor/PluginSidebarHost";
import SameLocation from "@/components/editor/SameLocation";
import { log } from "@/lib/util/log";
import { useCountrySelect } from "@/lib/map/useCountrySelect";
import { useDeletePolygon } from "@/lib/map/useDeletePolygon";
import { useMapKeyBindings, mergedKeyBindings } from "@/lib/map/mapKeyBindings";
import { range, clamp } from "@/types/util";
import { t } from "@/lib/i18n";

function usePasteHandler() {
	useEffect(() => {
		async function onPaste(e: ClipboardEvent) {
			if ((e.target as Element)?.closest("input, textarea")) return;
			const text = e.clipboardData?.getData("text") ?? "";
			if (!text.trim()) return;

			// Single line -> direct add + open; anything multi-line (JSON, CSV,
			// URL lists) -> staged import flow
			if (!text.trim().includes("\n")) {
				const parsed = (await parseMapsUrl(text)) ?? parseCoordinates(text);
				if (parsed) {
					await addParsedLocations([parsed]);
					return;
				}
			}

			// list of urls overwrites the payload with a "proxy JSON"
			let payload = text;
			const urlLocs = await parseUrlList(text);
			if (urlLocs.length > 0) payload = parsedLocationsToImportJson(urlLocs, t("Pasted URLs"));

			try {
				await beginImportPaste(payload);
			} catch {
				log.warn("Couldn't import locations via paste.");
			}
		}
		const handlePaste = (e: ClipboardEvent) => void onPaste(e);
		document.body.addEventListener("paste", handlePaste);
		return () => document.body.removeEventListener("paste", handlePaste);
	}, []);
}

const IMPORT_EXTENSIONS = new Set(["json", "csv"]);

function useFileDrop() {
	const [dragging, setDragging] = useState(false);

	useEffect(() => {
		let cancelled = false;
		const webview = getCurrentWebview();
		const unlistenPromise = webview.onDragDropEvent((event) => {
			if (cancelled) return;
			if (event.payload.type === "enter" || event.payload.type === "over") {
				setDragging(true);
			} else if (event.payload.type === "leave") {
				setDragging(false);
			} else if (event.payload.type === "drop") {
				setDragging(false);
				const path = event.payload.paths[0];
				if (!path) return;
				const ext = path.split(".").pop()?.toLowerCase() ?? "";
				if (!IMPORT_EXTENSIONS.has(ext)) {
					log.warn(`Unsupported file type: .${ext}`);
					return;
				}
				beginImportFromPath(path).catch((e) => {
					log.error("File drop import failed:", e);
				});
			}
		});
		return () => {
			cancelled = true;
			void unlistenPromise.then((unlisten) => unlisten());
		};
	}, []);

	return dragging;
}

const SPLITHANDLE_RANGE = range([15, 85]);

function SplitHandle({ onSplitChange }: { onSplitChange: (v: number) => void }) {
	const onPointerDown = usePointerDrag((e) => {
		const grid = (e.currentTarget as HTMLElement).parentElement;
		if (!grid) return null;

		const panoEl = grid.querySelector<HTMLElement>(".location-preview__panorama");
		const embedEl = panoEl?.querySelector<HTMLElement>(".location-preview__embed");
		if (panoEl && embedEl) {
			embedEl.style.position = "absolute";
			embedEl.style.width = `${panoEl.offsetWidth}px`;
			embedEl.style.height = `${panoEl.offsetHeight}px`;
		}

		const pctAt = (ev: PointerEvent) => {
			const rect = grid.getBoundingClientRect();
			const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
			const pct = ((ev.clientX - rect.left - gap / 2) / (rect.width - gap)) * 100;
			return clamp(pct, SPLITHANDLE_RANGE);
		};
		return {
			onMove: (ev) => {
				const clamped = pctAt(ev);
				grid.style.gridTemplateColumns = `minmax(0, ${clamped}fr) minmax(0, ${100 - clamped}fr)`;
				if (embedEl && panoEl) {
					embedEl.style.width = `${panoEl.offsetWidth}px`;
					embedEl.style.height = `${panoEl.offsetHeight}px`;
				}
			},
			onEnd: (ev) => {
				if (embedEl) {
					embedEl.style.width = "";
					embedEl.style.height = "";
				}
				onSplitChange(pctAt(ev));
			},
		};
	});

	return (
		<div
			className="split-handle"
			onPointerDown={onPointerDown}
			onDoubleClick={() => onSplitChange(50)}
		/>
	);
}

export function MapEditor() {
	const map = useMapState((s) => s.map);
	const hasDoclinks = useMapState((s) => doclinkedTags(s.tags).length > 0);
	// Warm the doclink HTML cache once per map open, so the panel is instant.
	const prefetchDocs = useEffectEvent(() => {
		if (map) prefetchDoclinks(getMapState().tags);
	});
	useEffect(() => prefetchDocs(), [map?.meta.id]);
	const workArea = useMapState((s) => s.workArea);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [split, setSplit] = useLocalStorage("editorSplit", 50);
	const [docPanelOpen, setDocPanelOpen] = useLocalStorage("doclinkPanelOpen", false);
	const [docPanelWidth, setDocPanelWidth] = useLocalStorage("doclinkPanelWidth", 420);
	const [docAssignOpen, setDocAssignOpen] = useDialogState("doclink-assign");

	useEffect(() => {
		let cancelled = false;
		void Promise.all([pluginsReady, waitForMapHost()]).then(() => {
			if (cancelled) return;
			activatePlugins();
		});
		return () => {
			cancelled = true;
			deactivatePlugins();
		};
	}, [map?.meta.id]);

	// Another window mutated this map
	useEffect(() => {
		const unlisten = events.storeExternalMutation.listen((e) => {
			if (e.payload.mapId === getMapState().mapId) void mutate(() => Promise.resolve(e.payload));
		});
		return () => {
			void unlisten.then((f) => f());
		};
	}, []);

	// This map was deleted (here or in another window): drop it without flushing
	// and back out to the list, which self-destructs the editor window on Tauri.
	useEffect(() => {
		const unlisten = listen<string>("map-deleted", (e) => {
			if (e.payload === getMapState().mapId) {
				discardOpenMap();
				goTo({ type: "list" });
			}
		});
		return () => {
			void unlisten.then((f) => f());
		};
	}, []);

	const appSettings = useSettings();
	usePasteHandler();
	const fileDragging = useFileDrop();
	useCommandHotkeys();
	useMapKeyBindings(() =>
		mergedKeyBindings(
			getMapState().map?.meta.settings.keyBindings ?? [],
			getSettings().globalCopyBindings,
			getMapState().mapId,
		),
	);
	useCountrySelect();
	useDeletePolygon();
	useHotkey(
		"escape",
		() => {
			exitFullscreenMap();
		},
		{ bubble: true },
	);
	useHotkey(useBinding("toggleFullscreenMap"), toggleFullscreenMap);
	useHotkey(
		useBinding("locationDelete"),
		() => {
			const ids = getMapState().selectedLocationIds;
			if (ids.size > 0) void removeLocations(ids);
		},
		{ bubble: true },
	);
	const [showMapCursor, setShowMapCursor] = useState(false);
	const showMapCursorRef = useRef(false);
	const [chipHost, setChipHost] = useState<HTMLElement | null>(null);

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key !== "Enter" || e.repeat) return;
			if (pluginOverlayOwnsInput()) return;
			if (isEditableElement(e.target)) return;
			if (isActivationElement(document.activeElement)) return;
			if (!getSettings().enterOpensCenter) return;
			if (getMapState().activeLocation) return;
			showMapCursorRef.current = true;
			setShowMapCursor(true);
		}
		function onKeyUp(e: KeyboardEvent) {
			if (e.key !== "Enter") return;
			const wasShowing = showMapCursorRef.current;
			showMapCursorRef.current = false;
			setShowMapCursor(false);
			if (!wasShowing) return;
			const host = getMapHost();
			const center = host?.getCenter();
			if (!host || !center) return;
			host.triggerClickAt(center);
		}
		function onBlur() {
			setShowMapCursor(false);
		}

		const ac = new AbortController();
		const { signal } = ac;
		document.addEventListener("keydown", onKeyDown, { capture: true, signal });
		document.addEventListener("keyup", onKeyUp, { capture: true, signal });
		window.addEventListener("blur", onBlur, { signal });
		return () => ac.abort();
	}, []);

	if (!map) return null;

	const editorClasses = `page-map-editor${appSettings.fullscreenMap ? " fullscreen-map" : ""}`;

	return (
		<PanoViewerProvider>
			<ChipHostContext.Provider value={chipHost}>
				<div className="editor-shell">
					<div
						className={editorClasses}
						style={{
							gridTemplateColumns: appSettings.fullscreenMap
								? undefined
								: `minmax(0, ${split}fr) minmax(0, ${100 - split}fr)`,
						}}
					>
						{!appSettings.fullscreenMap && <SplitHandle onSplitChange={setSplit} />}
						<header>
							<Tooltip content={t("Back to map list")} side="bottom" align="start">
								<a
									href="#"
									style={{ textDecoration: "none" }}
									aria-label={t("Back to map list")}
									onClick={(e) => {
										e.preventDefault();
										goTo({ type: "list" });
									}}
								>
									<Icon path={mdiBackburger} />
								</a>
							</Tooltip>
							<h1>{map.meta.name}</h1>
							<Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
								<Tooltip content={t("Edit map")} side="bottom">
									<DialogTrigger asChild>
										<button className="icon-button" type="button" aria-label={t("Edit map")}>
											<Icon path={mdiPencil} />
										</button>
									</DialogTrigger>
								</Tooltip>
								<DialogContent title={t("Map settings")} className="edit-map-modal">
									<MapRenameForm mapId={map.meta.id} currentName={map.meta.name} />
								</DialogContent>
							</Dialog>
							<EnrichmentButton />
						</header>
						<div className="side-header">
							{hasDoclinks && (
								<Tooltip content={t("Doclinks")} side="bottom">
									<button
										className="icon-button"
										type="button"
										aria-label={t("Toggle doclink panel")}
										onClick={() => setDocPanelOpen(!docPanelOpen)}
									>
										<Icon path={mdiFileDocumentOutline} />
									</button>
								</Tooltip>
							)}
						</div>
						<section
							ref={setChipHost}
							className="map-embed"
							style={{ background: "var(--surface-0)" }}
						>
							<MapEmbed onAddLocation={(p) => addParsedLocations([p])} />
							{showMapCursor && <div className="map-cursor-crosshair" />}
						</section>
						{(!appSettings.fullscreenMap || appSettings.showFullscreenMapMeta) && (
							<section className="map-meta">
								<MapMetaBar />
							</section>
						)}
						<MapOverview hidden={workArea !== "overview"} />
						{workArea === "location" && <LocationPreview />}
						{workArea === "duplicates" && <SameLocation />}
						{workArea === "import" && <ImportSidebar />}
						{workArea === "diff" && <DiffSidebar />}
						<PluginSidebarHost />
						<CommandPalette />
						{fileDragging && (
							<div className="file-drop-overlay">
								<div className="file-drop-overlay__content">{t("Drop file to import")}</div>
							</div>
						)}
					</div>
					{hasDoclinks && docPanelOpen && (
						<DoclinkPanel
							width={docPanelWidth}
							onWidthChange={setDocPanelWidth}
							onClose={() => setDocPanelOpen(false)}
						/>
					)}
					<DoclinkAssignDialog open={docAssignOpen} onOpenChange={setDocAssignOpen} />
				</div>
			</ChipHostContext.Provider>
		</PanoViewerProvider>
	);
}
