import { useCallback, useEffect, useRef, useState } from "react";
import type { Bounds } from "@/types";
import type { MutationResult } from "@/bindings.gen";
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
	mutate,
	removeLocations,
	discardOpenMap,
	createTags,
	beginImportPaste,
	beginImportFromPath,
} from "@/store/useMapStore";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { goToList } from "@/store/router";
import { activatePlugins, deactivatePlugins } from "@/plugins/registry";
import { getMapHost, waitForMapHost, fitMapToBounds } from "@/lib/map/mapState";
import { pluginsReady } from "@/plugins";
import { MapEmbed } from "@/components/editor/map/MapEmbed";
import { MapMetaBar } from "@/components/editor/map/MapMetaBar";
import { MapOverview } from "@/components/editor/map/MapOverview";
import { ImportSidebar } from "@/components/editor/ImportSidebar";
import { DiffSidebar } from "@/components/editor/DiffSidebar";
import { LocationPreview } from "@/components/editor/location/LocationPreview";
import { CommandPalette } from "@/components/editor/CommandPalette";
import { MapRenameForm } from "@/components/editor/MapRenameForm";
import { EnrichmentButton } from "@/components/editor/map/EnrichmentDialog";
import { Dialog, DialogTrigger, DialogContent } from "@/components/primitives/Dialog";
import { useHotkey, useCommandHotkeys, isEditableElement } from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { useSettings, setSetting, getSettings } from "@/store/settings";
import {
	parseMapsUrl,
	parseCoordinates,
	parseUrlList,
	parsedLocationsToImportJson,
	type ParsedLocation,
} from "@/lib/data/importExport";
import { Icon } from "@/components/primitives/Icon";
import { Tooltip } from "@/components/primitives/Tooltip";
import { mdiBackburger, mdiPencil } from "@mdi/js";
import { PluginSidebarHost } from "@/components/editor/PluginSidebarHost";
import SameLocation from "@/components/editor/SameLocation";
import { log } from "@/lib/util/log";
import { useCountrySelect } from "@/lib/map/useCountrySelect";
import { useDeletePolygon } from "@/lib/map/useDeletePolygon";
import { useMapKeyBindings } from "@/lib/map/mapKeyBindings";
import { range, clamp } from "@/types/util";

function zoomToPasted(bounds: Bounds | null, padding = 0) {
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
			tags: p.tags
				.map((n) => tagIdByName.get(n.toLowerCase()))
				.filter((id): id is number => id !== undefined),
		}),
	);
	await addLocations(locs);
	setActiveLocation(locs[locs.length - 1].id);
	const lats = locs.map((l) => l.lat);
	const lngs = locs.map((l) => l.lng);
	zoomToPasted({
		west: Math.min(...lngs),
		south: Math.min(...lats),
		east: Math.max(...lngs),
		north: Math.max(...lats),
	});
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

const SPLITHANDLE_RANGE = range([15, 85]);

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

			const panoEl = grid.querySelector<HTMLElement>(".location-preview__panorama");
			const embedEl = panoEl?.querySelector<HTMLElement>(".location-preview__embed");
			if (panoEl && embedEl) {
				embedEl.style.position = "absolute";
				embedEl.style.width = `${panoEl.offsetWidth}px`;
				embedEl.style.height = `${panoEl.offsetHeight}px`;
			}

			const onMove = (ev: PointerEvent) => {
				const rect = grid.getBoundingClientRect();
				const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
				const available = rect.width - gap;
				const pct = ((ev.clientX - rect.left - gap / 2) / available) * 100;
				const clamped = clamp(pct, SPLITHANDLE_RANGE);
				grid.style.gridTemplateColumns = `minmax(0, ${clamped}fr) minmax(0, ${100 - clamped}fr)`;
				if (embedEl && panoEl) {
					embedEl.style.width = `${panoEl.offsetWidth}px`;
					embedEl.style.height = `${panoEl.offsetHeight}px`;
				}
			};
			const onUp = (ev: PointerEvent) => {
				el.removeEventListener("pointermove", onMove);
				el.removeEventListener("pointerup", onUp);
				if (embedEl) {
					embedEl.style.width = "";
					embedEl.style.height = "";
				}
				const rect = grid.getBoundingClientRect();
				const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
				const available = rect.width - gap;
				const pct = ((ev.clientX - rect.left - gap / 2) / available) * 100;
				onSplitChange(clamp(pct, SPLITHANDLE_RANGE));
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
		Promise.all([pluginsReady, waitForMapHost()]).then(() => {
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
		const unlisten = listen<MutationResult & { mapId: string }>("store-external-mutation", (e) => {
			if (e.payload.mapId === getCurrentMapId()) void mutate(Promise.resolve(e.payload));
		});
		return () => {
			unlisten.then((f) => f());
		};
	}, []);

	// This map was deleted (here or in another window): drop it without flushing
	// and back out to the list, which self-destructs the editor window on Tauri.
	useEffect(() => {
		const unlisten = listen<string>("map-deleted", (e) => {
			if (e.payload === getCurrentMapId()) {
				discardOpenMap();
				goToList();
			}
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
	useDeletePolygon();
	useHotkey(useBinding("toggleFullscreenMap"), () => {
		setSetting("fullscreenMap", !getSettings().fullscreenMap);
	});
	useHotkey(
		useBinding("locationDelete"),
		() => {
			const ids = getSelectedLocationIds();
			if (ids.size > 0) removeLocations(ids);
		},
		{ bubble: true },
	);
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
			const host = getMapHost();
			const center = host?.getCenter();
			if (!host || !center) return;
			host.triggerClickAt(center);
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
				gridTemplateColumns: appSettings.fullscreenMap
					? undefined
					: `minmax(0, ${split}fr) minmax(0, ${100 - split}fr)`,
			}}
		>
			<SplitHandle onSplitChange={setSplit} />
			<header>
				<Tooltip content="Back to map list" side="bottom" align="start">
					<a
						href="#"
						style={{ textDecoration: "none" }}
						aria-label="Back to map list"
						onClick={(e) => {
							e.preventDefault();
							goToList();
						}}
					>
						<Icon path={mdiBackburger} />
					</a>
				</Tooltip>
				<h1>{map.meta.name}</h1>
				<Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
					<Tooltip content="Edit map" side="bottom">
						<DialogTrigger asChild>
							<button className="icon-button" type="button" aria-label="Edit map">
								<Icon path={mdiPencil} />
							</button>
						</DialogTrigger>
					</Tooltip>
					<DialogContent title="Map settings" className="edit-map-modal">
						<MapRenameForm mapId={map.meta.id} currentName={map.meta.name} />
					</DialogContent>
				</Dialog>
				<EnrichmentButton />
			</header>
			<div className="side-header"></div>
			<section className="map-embed" style={{ background: "#e5e3df" }}>
				<MapEmbed onAddLocation={(p) => addParsedLocations([p])} />
				{showMapCursor && <div className="map-cursor-crosshair" />}
			</section>
			<section className="map-meta">
				<MapMetaBar />
			</section>
			<MapOverview hidden={workArea !== "overview"} />
			{workArea === "location" && <LocationPreview />}
			{workArea === "duplicates" && <SameLocation />}
			{workArea === "import" && <ImportSidebar />}
			{workArea === "diff" && <DiffSidebar />}
			<PluginSidebarHost />
			<CommandPalette />
			{fileDragging && (
				<div className="file-drop-overlay">
					<div className="file-drop-overlay__content">Drop file to import</div>
				</div>
			)}
		</div>
	);
}
