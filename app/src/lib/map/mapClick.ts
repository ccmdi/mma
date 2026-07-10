import type { PickingInfo } from "@deck.gl/core";
import type { CellManager } from "@/lib/render/CellManager";
import type { MapHost } from "@/lib/map/host";
import { LOCATION_LAYER_ID } from "@/lib/render/buildSceneLayers";
import { cmd } from "@/lib/commands";
import { lookupStreetView, showToast } from "@/lib/sv/lookup";
import { tryInterceptClick } from "@/lib/map/mapState";
import { openSeenEntry } from "@/lib/seen/seenOverlay";
import { openContextMenuLatLng, openContextMenuLocation } from "@/lib/sv/measure";
import { trace } from "@/lib/util/debug";
import {
	addLocations,
	getActiveLocation,
	getCurrentMap,
	getWorkArea,
	openStagedLocation,
	resolveLocation,
	setActiveLocation,
	toggleManualSelection,
} from "@/store/useMapStore";
import { isVirtualLocation, isImportPreview, locId } from "@/types";
import type { MaybeLocation } from "@/types";
import type { Location } from "@/bindings.gen";

export const isLocationLayer = (id?: string) =>
	id?.startsWith(LOCATION_LAYER_ID) ||
	id?.startsWith("cell:") ||
	id?.startsWith("sel-overlay:") ||
	id === "import-preview";

// Resolve a deck.gl pick to a location id from the shared cell/selection buffers.
// Index-based (the SDF cell and selection-overlay layers carry no per-feature object);
// falls back to Rust for cells the JS buffer hasn't materialized yet.
export async function resolvePickedId(cm: CellManager, info: PickingInfo): Promise<number | null> {
	if (typeof info.index !== "number" || info.index < 0) return null;
	const layerId = info.layer?.id ?? "";
	if (layerId.startsWith("sel-overlay:")) return cm.selOverlayIds[info.index] ?? null;
	if (layerId.startsWith("cell:")) {
		const cellKey = layerId.split(":")[1];
		const local = cm.resolvePickFromCell(cellKey, info.index);
		if (local != null) return local;
		return await cmd.storeResolvePick(cellKey, info.index);
	}
	return null;
}

// Create a location from a map click: snap to nearest SV coverage under the active
// map's settings, add it, make it active. Shared by the editor map and the minimap.
// Work-area guards live here so neither call site has to repeat them.
export async function createLocationAtLatLng(
	lat: number,
	lng: number,
	zoom: number,
	opts?: { container?: HTMLElement | null },
): Promise<Location | null> {
	const area = getWorkArea();
	if (area === "plugin" || area === "import" || area === "diff") return null;
	const active = getActiveLocation();
	if (active != null && isImportPreview(active)) return null;

	const t = trace("add");
	const ms = getCurrentMap()?.meta.settings;
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
		if (opts?.container) showToast(opts.container, "No coverage found at this location.");
		return null;
	}
	t.step("lookup");
	await addLocations([loc], { hideInDelta: true });
	t.step("addLocations");
	setActiveLocation(loc);
	t.step("setActive");
	t.end();
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

	if (ctx.measuring) return;

	if (
		info.coordinate &&
		tryInterceptClick(
			info.coordinate[1],
			info.coordinate[0],
			domEvent instanceof MouseEvent && domEvent.shiftKey,
		)
	)
		return;

	if (isLocationLayer(info.layer?.id)) {
		const picked = await resolvePicked();
		if (picked != null) {
			if (isVirtualLocation({ id: locId(picked) })) return; // staged location's active pin: already open
			if (domEvent instanceof MouseEvent && domEvent.ctrlKey) toggleManualSelection(locId(picked));
			else setActiveLocation(picked); // fetches once iff lazy; free if materialized
			return;
		}
	}

	if (info.coordinate) {
		const container = ctx.host?.container ?? null;
		if (ctx.selectOnly) {
			if (container) showToast(container, "Select-only mode is on.");
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
