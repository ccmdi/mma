import type { PickingInfo } from "@deck.gl/core";
import type { CellManager } from "@/lib/render/CellManager";
import type { ClickMode } from "@/store/mapEmbedPrefs";
import { boundsOfCoords, type MapHost } from "@/lib/map/host";
import { LOCATION_LAYER_ID } from "@/lib/render/buildSceneLayers";
import { cmd } from "@/lib/commands";
import { lookupStreetView } from "@/lib/sv/lookup";
import { toast } from "@/lib/util/toast";
import { t } from "@/lib/i18n";
import { tryInterceptClick, fitMapToBounds } from "@/lib/map/mapState";
import { getSettings } from "@/store/settings";
import type { ParsedLocation } from "@/bindings.gen";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { openSeenEntry } from "@/lib/seen/seenOverlay";
import { openContextMenuLatLng, openContextMenuLocation } from "@/lib/map/contextMenu";
import { trace } from "@/lib/util/debug";
import {
	addLocations,
	applySelectionUpdate,
	getMapState,
	openStagedLocation,
	resolveLocation,
	setActiveLocation,
	read,
	rowsOf,
} from "@/store/useMapStore";
import * as edit from "@/store/edit";
import { toggleManualSelection } from "@/store/selections";
import { locId, createLocation } from "@/types";
import type { MaybeLocation, Bounds } from "@/types";
import type { Location } from "@/bindings.gen";

export const isLocationLayer = (id?: string) =>
	id?.startsWith(LOCATION_LAYER_ID) ||
	id?.startsWith("cell:") ||
	id === "sel-overlay" ||
	id === "import-preview";

// Resolve a deck.gl pick to a location id from the shared cell/selection buffers.
// Index-based (the SDF cell and selection-overlay layers carry no per-feature object);
// falls back to Rust for cells the JS buffer hasn't materialized yet.
export async function resolvePickedId(cm: CellManager, info: PickingInfo): Promise<number | null> {
	if (typeof info.index !== "number" || info.index < 0) return null;
	const layerId = info.layer?.id ?? "";
	if (layerId === "sel-overlay") return cm.overlay.ids[info.index] ?? null;
	if (layerId.startsWith("cell:")) {
		const cellKey = layerId.split(":")[1];
		const local = cm.resolvePickFromCell(cellKey, info.index);
		if (local != null) return local;
		return await cmd.storeResolvePick(cellKey, info.index);
	}
	return null;
}

function zoomToPasted(bounds: Bounds | null, padding = 0) {
	if (!getSettings().panToImported) return;
	fitMapToBounds(bounds, padding, getSettings().pastePadding);
}

/** Add already-parsed locations (paste, URL lists, doc links): resolve tag
 *  names to tags, add, activate the last one, pan to fit. */
export async function addParsedLocations(parsed: ParsedLocation[]) {
	const tagNames = [...new Set(parsed.flatMap((p) => p.tags))];
	const ids = await edit.values("tags", { create: tagNames.map((name) => ({ name })) });
	const tagIdByName = new Map(tagNames.map((name, i) => [name.toLowerCase(), ids[i]]));
	const locs = parsed.map((p) =>
		createLocation({
			...p,
			tags: p.tags
				.map((n) => tagIdByName.get(n.toLowerCase()))
				.filter((id): id is number => id !== undefined),
		}),
	);
	await addLocations(locs);
	await setActiveLocation(locs[locs.length - 1].id);
	zoomToPasted(boundsOfCoords(locs));
}

/** Open a clicked href map-aware: an href that parses as a location route opens
 *  the existing location if the map already has it (same pano, else within 2m --
 *  the duplicate-detection radius), otherwise adds it as if pasted. Everything
 *  else opens externally. */
export async function openHref(href: string) {
	const parsed = await cmd.parseMapsUrl(href);
	if (!parsed) {
		await openExternal(href);
		return;
	}
	const nearby = await rowsOf(
		(
			await read(
				{ type: "Nearby", selection: null, lat: parsed.lat, lng: parsed.lng, radiusM: 2.0 },
				{ kind: "rows" },
				"rows",
			)
		).rows,
	);
	const match = nearby.find((l) => parsed.panoId && l.panoId === parsed.panoId) ?? nearby[0];
	if (match) {
		await setActiveLocation(match);
		return;
	}
	await addParsedLocations([parsed]);
}

// ---------------------------------------------------------------------------
// Click / hover pipeline
// ---------------------------------------------------------------------------

// Create a location from a map click: snap to nearest SV coverage under the active
// map's settings, add it, make it active. Shared by the editor map and the minimap.
// Work-area guards live here so neither call site has to repeat them.
export async function createLocationAtLatLng(
	lat: number,
	lng: number,
	zoom: number,
	opts?: { container?: HTMLElement | null },
): Promise<Location | null> {
	const area = getMapState().workArea;
	if (area === "plugin" || area === "import" || area === "diff") return null;
	if (getMapState().open?.origin === "import") return null;

	const tr = trace("add");
	const ms = getMapState().map?.settings;
	const loc = await lookupStreetView(lat, lng, zoom, {
		preferOfficial: ms?.preferOfficial,
		onlyOfficial: ms?.onlyOfficial,
		pointAlongRoad: ms?.pointAlongRoad,
		preferDirection: ms?.preferDirection,
		defaultPanoId: ms?.defaultPanoId,
		preferHigherQuality: ms?.preferHigherQuality,
		minRadius: ms?.searchRadius ?? undefined,
	});
	if (!loc) {
		if (opts?.container) toast(t("No coverage found at this location."), 1500, opts.container);
		return null;
	}
	tr.step("lookup");
	await addLocations([loc]);
	tr.step("addLocations");
	await setActiveLocation(loc);
	tr.step("setActive");
	tr.end();
	return loc;
}

// Capabilities a map surface grants its click pipeline. Behavior only — UI lives in the
// consumer. The editor map passes the full set; the minimap passes a reduced one.
export interface MapClickCtx {
	cm: CellManager;
	host: MapHost | null;
	clickMode?: ClickMode;
	measuring?: boolean;
	// Dispatch the surface's context menu at the given client coords. Absent => the
	// surface has no context menu and ignores right-click (the minimap).
	onContextMenu?: (clientX: number, clientY: number) => void;
}

export async function handleMapClick(
	info: PickingInfo,
	domEvent: Event | undefined,
	ctx: MapClickCtx,
): Promise<void> {
	// Staged import markers open a read-only preview; never fall through to SV lookup.
	if (info.layer?.id === "import-preview") {
		if (typeof info.index === "number" && info.index >= 0) void openStagedLocation(info.index);
		return;
	}

	// Seen-overlay dots open the visited pano; never fall through to a map-click create.
	if (info.layer?.id === "seen-overlay") {
		if (typeof info.index === "number" && info.index >= 0) void openSeenEntry(info.index);
		return;
	}

	const resolvePicked = async (): Promise<MaybeLocation | null> => {
		if (info.object) return info.object as Location;
		return await resolvePickedId(ctx.cm, info);
	};

	if (domEvent instanceof MouseEvent && domEvent.button === 2) {
		if (!ctx.onContextMenu) return;
		if (isLocationLayer(info.layer?.id)) {
			const picked = await resolvePicked();
			const loc = picked == null ? null : await resolveLocation(picked);
			if (loc) openContextMenuLocation(loc);
			else if (info.coordinate)
				openContextMenuLatLng({ lat: info.coordinate[1], lng: info.coordinate[0] });
		} else if (info.coordinate) {
			openContextMenuLatLng({ lat: info.coordinate[1], lng: info.coordinate[0] });
		}
		ctx.onContextMenu(domEvent.clientX, domEvent.clientY);
		return;
	}

	if (domEvent instanceof MouseEvent && domEvent.button !== 0) return;
	// The overlay replays the engine's double-click as one more click. The engine has already
	// clicked for that gesture, and the browser also pairs presses it took as pans into one.
	if (domEvent?.type === "dblclick") return;

	// Interceptors first: the measure tool consumes the click to place a node.
	if (
		info.coordinate &&
		tryInterceptClick(
			info.coordinate[1],
			info.coordinate[0],
			domEvent instanceof MouseEvent && domEvent.shiftKey,
		)
	)
		return;

	if (ctx.measuring) return;

	if (isLocationLayer(info.layer?.id)) {
		const picked = await resolvePicked();
		if (picked != null) {
			const open = getMapState().open;
			if (open && open.origin !== "map" && locId(picked) === open.id) return;
			if (domEvent instanceof MouseEvent && domEvent.ctrlKey)
				void applySelectionUpdate(toggleManualSelection(locId(picked)));
			else void setActiveLocation(picked);
			return;
		}
	}

	if (info.coordinate) {
		const container = ctx.host?.container ?? null;
		if (ctx.clickMode === "selectOnly") {
			if (container) toast(t("Select-only mode is on."), 1500, container);
			return;
		}
		if (ctx.clickMode === "nearest") {
			const nearest =
				(
					await rowsOf(
						(
							await read(
								{
									type: "Nearest",
									selection: null,
									lat: info.coordinate[1],
									lng: info.coordinate[0],
								},
								{ kind: "rows" },
								"rows",
							)
						).rows,
					)
				)[0] ?? null;
			if (!nearest) return;
			if (domEvent instanceof MouseEvent && domEvent.ctrlKey)
				void applySelectionUpdate(toggleManualSelection(nearest.id));
			else void setActiveLocation(nearest);
			return;
		}
		await createLocationAtLatLng(info.coordinate[1], info.coordinate[0], ctx.host?.getZoom() ?? 2, {
			container,
		});
	}
}

export function handleMapHover(info: PickingInfo, domEvent?: Event): void {
	const over =
		info.object != null ||
		(isLocationLayer(info.layer?.id) === true && typeof info.index === "number" && info.index >= 0);
	const target = (domEvent as MouseEvent | undefined)?.target as HTMLElement | null;
	if (target) target.style.cursor = over ? "pointer" : "";
}
