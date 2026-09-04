import type { PickingInfo } from "@deck.gl/core";
import type { CellManager } from "@/lib/render/CellManager";
import { boundsOfCoords, type MapHost } from "@/lib/map/host";
import { LOCATION_LAYER_ID } from "@/lib/render/buildSceneLayers";
import { cmd } from "@/lib/commands";
import { lookupStreetView } from "@/lib/sv/lookup";
import { toast } from "@/lib/util/toast";
import { t } from "@/lib/i18n";
import { tryInterceptClick, fitMapToBounds } from "@/lib/map/mapState";
import { getSettings } from "@/store/settings";
import { parseMapsUrl, type ParsedLocation } from "@/lib/data/importExport";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { openSeenEntry } from "@/lib/seen/seenOverlay";
import { openContextMenuLatLng, openContextMenuLocation } from "@/lib/map/contextMenu";
import { trace } from "@/lib/util/debug";
import {
	addLocations,
	createTags,
	getMapState,
	openStagedLocation,
	resolveLocation,
	setActiveLocation,
	applySelectionUpdate,
} from "@/store/useMapStore";
import { toggleManualSelection } from "@/store/selections";
import { isVirtualLocation, isImportPreview, locId, createLocation } from "@/types";
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
	await setActiveLocation(locs[locs.length - 1].id);
	zoomToPasted(boundsOfCoords(locs));
}

/** Open a clicked href map-aware: an href that parses as a location route opens
 *  the existing location if the map already has it (same pano, else within 2m --
 *  the duplicate-detection radius), otherwise adds it as if pasted. Everything
 *  else opens externally. */
export async function openHref(href: string) {
	const parsed = await parseMapsUrl(href);
	if (!parsed) {
		await openExternal(href);
		return;
	}
	const nearby = await cmd.storeFindNearby(parsed.lat, parsed.lng, 2.0);
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
	const active = getMapState().activeLocation;
	if (active != null && isImportPreview(active)) return null;

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
	selectOnly?: boolean;
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
			if (isVirtualLocation({ id: locId(picked) })) return; // staged location's active pin: already open
			if (domEvent instanceof MouseEvent && domEvent.ctrlKey)
				void applySelectionUpdate(toggleManualSelection, locId(picked));
			else void setActiveLocation(picked);
			return;
		}
	}

	if (info.coordinate) {
		const container = ctx.host?.container ?? null;
		if (ctx.selectOnly) {
			if (container) toast(t("Select-only mode is on."), 1500, container);
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
