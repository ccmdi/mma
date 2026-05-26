import { useCallback, useEffect, useRef, useState } from "react";
import { createLocation } from "@/types";
import {
	useCurrentMap,
	useWorkArea,
	closeMap,
	addLocations,
	setActiveLocation,
	getActiveLocation,
	createTags,
	importPaste,
} from "@/store/useMapStore";
import { activatePlugins, deactivatePlugins } from "@/plugins/registry";
import { getGoogleMap as getGoogleMapInstance } from "@/lib/map/mapState";
import { pluginsReady } from "@/plugins";
import { MapEmbed } from "@/components/editor/map/MapEmbed";
import { MapMetaBar } from "@/components/editor/map/MapMetaBar";
import { MapOverview } from "@/components/editor/map/MapOverview";
import { LocationPreview } from "@/components/editor/location/LocationPreview";
import { CommandPalette } from "@/components/editor/CommandPalette";
import { MapRenameForm } from "@/components/editor/MapRenameForm";
import { Dialog, DialogTrigger, DialogContent } from "@/components/primitives/Dialog";
import { useHotkey, useCommandHotkeys, isEditableElement } from "@/lib/hooks/useHotkey";
import { useBinding } from "@/lib/util/hotkeys.add";
import { useLocalStorage } from "@/lib/hooks/useLocalStorage";
import { useSettings, setSetting, getSettings } from "@/store/settings.add";
import { parseMapsUrl } from "@/lib/data/importExport";
import { Icon } from "@/components/primitives/Icon";
import { mdiBackburger, mdiPencil } from "@mdi/js";
import { PluginSidebarHost } from "@/components/editor/PluginSidebarHost";
import SameLocation from "@/components/editor/SameLocation.add";
import { log } from "@/lib/util/log"
import { useCountrySelect } from "@/lib/map/useCountrySelect.add";

function usePasteHandler() {
	useEffect(() => {
		async function onPaste(e: ClipboardEvent) {
			if ((e.target as Element)?.closest("input, textarea")) return;
			const text = e.clipboardData?.getData("text") ?? "";
			if (!text.trim()) return;

			const isSingleLine = !text.trim().includes("\n");
			if (isSingleLine) {
				const parsed = await parseMapsUrl(text);
				if (parsed) {
					let tagIds: number[] = [];
					if (parsed.tags.length > 0) {
						const resolved = await createTags(parsed.tags);
						tagIds = resolved.map((t) => t.id);
					}
					const loc = createLocation({
						...parsed,
						tags: tagIds,
					});
					await addLocations([loc]);
					setActiveLocation(loc.id);
					return;
				}
			}

			try {
				const [r, singleId] = await importPaste(text);
				if (r.importedCount > 0 && singleId != null) setActiveLocation(singleId);
			} catch {
				log.warn('Couldn\'t import locations via paste.')
			}
		}
		document.body.addEventListener("paste", onPaste);
		return () => document.body.removeEventListener("paste", onPaste);
	}, []);
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
				onSplitChange(Math.min(70, Math.max(30, pct)));
			};
			const onUp = () => {
				el.removeEventListener("pointermove", onMove);
				el.removeEventListener("pointerup", onUp);
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
		pluginsReady.then(() => {
			if (cancelled) return;
			activatePlugins();
		});
		return () => {
			cancelled = true;
			deactivatePlugins();
		};
	}, [map?.meta.id]);

	const appSettings = useSettings();
	usePasteHandler();
	useCommandHotkeys();
	useCountrySelect();
	useHotkey(useBinding("toggleFullscreenMap"), () => {
		setSetting("fullscreenMap", !getSettings().fullscreenMap);
	});
	useHotkey(useBinding("panToLocation"), () => {
		const loc = getActiveLocation();
		const map = getGoogleMapInstance();
		if (loc && map) map.panTo({ lat: loc.lat, lng: loc.lng });
	});

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
			const mapEl = document.querySelector<HTMLElement>(".map-embed");
			if (!mapEl) return;
			const rect = mapEl.getBoundingClientRect();
			const cx = rect.left + rect.width / 2;
			const cy = rect.top + rect.height / 2;
			const el = document.elementFromPoint(cx, cy) ?? mapEl;
			const opts: MouseEventInit = {
				clientX: cx,
				clientY: cy,
				bubbles: true,
				cancelable: true,
				view: window,
				button: 0,
			};
			el.dispatchEvent(new PointerEvent("pointerdown", opts));
			el.dispatchEvent(new PointerEvent("pointerup", opts));
			el.dispatchEvent(new MouseEvent("click", opts));
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
				gridTemplateColumns: appSettings.fullscreenMap ? undefined : `${split}fr ${100 - split}fr`,
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
						closeMap();
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
			{workArea === "plugin" && <PluginSidebarHost />}
			<CommandPalette />
		</div>
	);
}
