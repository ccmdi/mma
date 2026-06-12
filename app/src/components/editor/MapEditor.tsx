import { useCallback, useEffect, useRef, useState } from "react";
import { createLocation } from "@/types";
import {
	useCurrentMap,
	useWorkArea,
	addLocations,
	setActiveLocation,
	getActiveLocation,
	getCurrentMap,
	getCurrentMapId,
	getSelectedLocationIds,
	refreshFromExternalMutation,
	removeLocations,
	createTags,
	beginImportPaste,
	beginImportFromPath,
} from "@/store/useMapStore";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { goToList } from "@/store/router";
import { activatePlugins, deactivatePlugins } from "@/plugins/registry";
import { getGoogleMap as getGoogleMapInstance, waitForGoogleMap, fitMapToBounds } from "@/lib/map/mapState";
import { pluginsReady } from "@/plugins";
import { subscribe } from "@/lib/events";
import { getReviewSession } from "@/lib/review/review";
import { MapEmbed } from "@/components/editor/map/MapEmbed";
import { MapMetaBar } from "@/components/editor/map/MapMetaBar";
import { MapOverview } from "@/components/editor/map/MapOverview";
import { ImportSidebar } from "@/components/editor/ImportSidebar";
import { DiffSidebar } from "@/components/editor/DiffSidebar";
import { LocationPreview } from "@/components/editor/location/LocationPreview";
import { CommandPalette } from "@/components/editor/CommandPalette";
import { MapRenameForm } from "@/components/editor/MapRenameForm";
import { Dialog, DialogTrigger, DialogContent } from "@/components/primitives/Dialog";
import { useHotkey, useCommandHotkeys, isEditableElement } from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { useSettings, setSetting, getSettings } from "@/store/settings";
import { parseMapsUrl, parseCoordinates, parseUrlList, parsedLocationsToImportJson, type ParsedLocation } from "@/lib/data/importExport";
import { Icon } from "@/components/primitives/Icon";
import { mdiBackburger, mdiPencil } from "@mdi/js";
import { PluginSidebarHost } from "@/components/editor/PluginSidebarHost";
import SameLocation from "@/components/editor/SameLocation";
import { log } from "@/lib/util/log"
import { useCountrySelect } from "@/lib/map/useCountrySelect";
import { useMapKeyBindings } from "@/lib/map/mapKeyBindings";

function zoomToPasted(bounds: [number, number, number, number] | null, padding = 0) {
	if (!getSettings().panToImported) return;
	fitMapToBounds(bounds, padding);
}

async function addParsedLocations(parsed: ParsedLocation[]) {
	const tagNames = [...new Set(parsed.flatMap((p) => p.tags))];
	const resolved = await createTags(tagNames);
	const tagIdByName = new Map(resolved.map((t) => [t.name.toLowerCase(), t.id]));
	const locs = parsed.map((p) =>
		createLocation({
			...p,
			tags: p.tags.map((n) => tagIdByName.get(n.toLowerCase())).filter((id): id is number => id !== undefined),
		}),
	);
	await addLocations(locs);
	setActiveLocation(locs[locs.length - 1].id);
	const lats = locs.map((l) => l.lat);
	const lngs = locs.map((l) => l.lng);
	zoomToPasted([Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)]);
}

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
			if (urlLocs.length > 0) payload = parsedLocationsToImportJson(urlLocs, "Pasted URLs");

			try {
				await beginImportPaste(payload);
			} catch {
				log.warn("Couldn't import locations via paste.");
			}
		}
		document.body.addEventListener("paste", onPaste);
		return () => document.body.removeEventListener("paste", onPaste);
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
			unlistenPromise.then((unlisten) => unlisten());
		};
	}, []);

	return dragging;
}

function SplitHandle({ onSplitChange }: { onSplitChange: (v: number) => void }) {
	const handleRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const handle = handleRef.current;
		const grid = handle?.parentElement;
		if (!grid || !handle) return;
		const embed = grid.querySelector(".map-embed");
		if (!embed) return;
		const sync = () => {
			const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
			handle.style.left = `${embed.getBoundingClientRect().right - grid.getBoundingClientRect().left + gap / 2}px`;
		};
		const obs = new ResizeObserver(sync);
		obs.observe(embed);
		sync();
		return () => obs.disconnect();
	}, []);

	const onPointerDown = useCallback(
		(e: React.PointerEvent) => {
			e.preventDefault();
			const el = e.currentTarget as HTMLElement;
			el.setPointerCapture(e.pointerId);
			const grid = el.parentElement;
			if (!grid) return;

			const onMove = (ev: PointerEvent) => {
				const rect = grid.getBoundingClientRect();
				const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
				const available = rect.width - gap;
				const pct = ((ev.clientX - rect.left - gap / 2) / available) * 100;
				const clamped = Math.min(70, Math.max(30, pct));
				grid.style.gridTemplateColumns = `minmax(0, ${clamped}fr) minmax(0, ${100 - clamped}fr)`;
			};
			const onUp = (ev: PointerEvent) => {
				el.removeEventListener("pointermove", onMove);
				el.removeEventListener("pointerup", onUp);
				const rect = grid.getBoundingClientRect();
				const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
				const available = rect.width - gap;
				const pct = ((ev.clientX - rect.left - gap / 2) / available) * 100;
				onSplitChange(Math.min(70, Math.max(30, pct)));
			};
			el.addEventListener("pointermove", onMove);
			el.addEventListener("pointerup", onUp);
		},
		[onSplitChange],
	);

	return (
		<div
			ref={handleRef}
			className="split-handle"
			onPointerDown={onPointerDown}
			onDoubleClick={() => onSplitChange(50)}
		/>
	);
}

export function MapEditor() {
	const map = useCurrentMap();
	const workArea = useWorkArea();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [split, setSplit] = useLocalStorage("editorSplit", 50);

	useEffect(() => {
		let cancelled = false;
		Promise.all([pluginsReady, waitForGoogleMap()]).then(() => {
			if (cancelled) return;
			activatePlugins();
		});
		return () => {
			cancelled = true;
			deactivatePlugins();
		};
	}, [map?.meta.id]);

	// Another window copied locations into this map: resync from the store.
	useEffect(() => {
		const unlisten = listen<string>("store-external-mutation", (e) => {
			if (e.payload === getCurrentMapId()) void refreshFromExternalMutation();
		});
		return () => {
			unlisten.then((f) => f());
		};
	}, []);

	const appSettings = useSettings();
	usePasteHandler();
	const fileDragging = useFileDrop();
	useCommandHotkeys();
	useMapKeyBindings(() => getCurrentMap()?.meta.settings.keyBindings ?? []);
	useCountrySelect();
	useHotkey(useBinding("toggleFullscreenMap"), () => {
		setSetting("fullscreenMap", !getSettings().fullscreenMap);
	});
	useHotkey(useBinding("locationDelete"), () => {
		const ids = getSelectedLocationIds();
		if (ids.size > 0) removeLocations(ids);
	}, { bubble: true });
	useHotkey(useBinding("panToLocation"), () => {
		const loc = getActiveLocation();
		const map = getGoogleMapInstance();
		if (loc && map) map.panTo({ lat: loc.lat, lng: loc.lng });
	});

	useEffect(() => {
		return subscribe("active:change", (id) => {
			if (id == null || !getReviewSession() || !getSettings().followActiveInReview) return;
			const loc = getActiveLocation();
			const map = getGoogleMapInstance();
			if (loc && map && loc.id === id) map.panTo({ lat: loc.lat, lng: loc.lng });
		});
	}, []);

	const [showMapCursor, setShowMapCursor] = useState(false);
	const showMapCursorRef = useRef(false);

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key !== "Enter" || e.repeat) return;
			if (isEditableElement(e.target)) return;
			if (getActiveLocation()) return;
			showMapCursorRef.current = true;
			setShowMapCursor(true);
		}
		function onKeyUp(e: KeyboardEvent) {
			if (e.key !== "Enter") return;
			const wasShowing = showMapCursorRef.current;
			showMapCursorRef.current = false;
			setShowMapCursor(false);
			if (!wasShowing) return;
			const gmap = getGoogleMapInstance();
			const center = gmap?.getCenter();
			if (!gmap || !center) return;
			// deck.gl/google-maps picks off the Maps 'click' event (latLng), not DOM events.
			google.maps.event.trigger(gmap, "click", { latLng: center });
		}
		function onBlur() {
			setShowMapCursor(false);
		}

		document.addEventListener("keydown", onKeyDown, true);
		document.addEventListener("keyup", onKeyUp, true);
		window.addEventListener("blur", onBlur);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			document.removeEventListener("keyup", onKeyUp, true);
			window.removeEventListener("blur", onBlur);
		};
	}, []);

	if (!map) return null;

	const editorClasses = `page-map-editor${appSettings.fullscreenMap ? " fullscreen-map" : ""}`;

	return (
		<div
			className={editorClasses}
			style={{
				gridTemplateColumns: appSettings.fullscreenMap ? undefined : `minmax(0, ${split}fr) minmax(0, ${100 - split}fr)`,
			}}
		>
			<SplitHandle onSplitChange={setSplit} />
			<header>
				<a
					href="#"
					style={{ textDecoration: "none" }}
					role="tooltip"
					data-microtip-position="bottom-right"
					aria-label="Back to map list"
					onClick={(e) => {
						e.preventDefault();
						goToList();
					}}
				>
					<Icon path={mdiBackburger} />
				</a>
				<h1>{map.meta.name}</h1>
				<Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
					<DialogTrigger asChild>
						<button
							className="icon-button"
							type="button"
							role="tooltip"
							aria-label="Edit map"
							data-microtip-position="bottom"
						>
							<Icon path={mdiPencil} />
						</button>
					</DialogTrigger>
					<DialogContent title="Map settings" className="edit-map-modal">
						<MapRenameForm currentName={map.meta.name} />
					</DialogContent>
				</Dialog>
			</header>
			<div className="side-header"></div>
			<section className="map-embed" style={{ background: "#e5e3df" }}>
				<MapEmbed />
				{showMapCursor && <div className="map-cursor-crosshair" />}
			</section>
			<section className="map-meta">
				<MapMetaBar />
			</section>
			{workArea === "overview" && <MapOverview />}
			{workArea === "location" && <LocationPreview />}
			{workArea === "duplicates" && <SameLocation />}
			{workArea === "import" && <ImportSidebar />}
			{workArea === "diff" && <DiffSidebar />}
			{workArea === "plugin" && <PluginSidebarHost />}
			<CommandPalette />
			{fileDragging && (
				<div className="file-drop-overlay">
					<div className="file-drop-overlay__content">Drop file to import</div>
				</div>
			)}
		</div>
	);
}
