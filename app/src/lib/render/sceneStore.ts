import { CellManager } from "@/lib/render/CellManager";
import { cmd } from "@/lib/commands";
import { mmaBufUrl } from "@/lib/util/util";
import type { RGB, RGBA } from "@/lib/util/color";
import { log } from "@/lib/util/log";
import { trace } from "@/lib/util/debug";
import { getMapState, mapOpen, setSelectedLocationIds } from "@/store/useMapStore";
import { emit as emitEvent, subscribe as subscribeEvent } from "@/lib/events";
import type { MarkerStyle } from "@/types";

// Owns marker/scene data for every map surface. The editor map drives the
// engine (fetch + lifecycle); both it and the minimap render from the same `CellManager`.
// There can be exactly one producer — `store_fill_render_file` is unsafe for a second caller
// (ignores bounds, rebuilds the picking index, shared file path).

let markerDefault: RGBA = [42, 42, 42, 255];

const scene = new CellManager();
let lastMarkerStyle: MarkerStyle = "pin";
let loadToken = 0;

/** The shared scene that all map surfaces render from. */
export function getScene(): CellManager {
	return scene;
}

/** Snapshot of every rendered location's id and position (`[lng, lat, ...]`). */
export function getScenePositions(): { ids: Uint32Array; positions: Float32Array } {
	const ids = new Uint32Array(scene.totalCount);
	const positions = new Float32Array(scene.totalCount * 2);
	let n = 0;
	scene.forEachPosition((id, lng, lat) => {
		ids[n] = id;
		positions[n * 2] = lng;
		positions[n * 2 + 1] = lat;
		n++;
	});
	return { ids, positions };
}

function syncActive(): boolean {
	return scene.setActive(getMapState().activeLocation?.id ?? null);
}

/** Set the default marker color (RGB bytes). @unstable */
export function setMarkerDefaultColor(r: number, g: number, b: number) {
	markerDefault = [r, g, b, 255];
}

/** Change the default marker color and repaint. @unstable */
export function recolorScene(mc: RGB) {
	if (markerDefault.every((c, i) => c === mc[i])) return;
	setMarkerDefaultColor(...mc);
	void cmd.storeSetMarkerColor(mc);
	scene.version++;
	emitEvent("scene:changed");
}

/** Current default marker color as RGBA. */
export function getMarkerDefaultColor(): RGBA {
	return markerDefault;
}

let sceneSettled: Promise<void> = Promise.resolve();
let loadRequested = 0;

/** Resolves when the most recently started full scene load has finished (or immediately if none is in flight). @unstable */
export function whenSceneSettled(): Promise<void> {
	return sceneSettled;
}

/** Rebuild the full scene for all locations. @unstable */
export function loadScene(markerStyle: MarkerStyle, mc?: RGB): Promise<void> {
	const seq = ++loadRequested;
	return (sceneSettled = sceneSettled
		.catch(() => {})
		.then(() => {
			if (seq !== loadRequested) return;
			return doLoadScene(markerStyle, mc);
		}));
}

async function doLoadScene(markerStyle: MarkerStyle, mc?: RGB): Promise<void> {
	lastMarkerStyle = markerStyle;
	if (mc) setMarkerDefaultColor(...mc);
	const token = ++loadToken;
	const t = trace("render", { summary: true });
	try {
		const filePath = await cmd.storeFillRenderFile({
			west: -180,
			south: -90,
			east: 180,
			north: 90,
			markerStyle,
			markerColor: mc,
		});
		t.step("fill");
		const resp = await fetch(mmaBufUrl(filePath));
		if (!resp.ok) throw new Error(`render fetch ${resp.status}: ${await resp.text()}`);
		t.step("fetch-headers");
		const buf = await resp.arrayBuffer();
		t.step("arraybuffer");
		if (token !== loadToken) return; // superseded by a newer load
		scene.initFromBinary(buf);
		t.step("parse");
		mapOpen.mark("markers");
		syncActive();
		// The reloaded binary carries the selection overlay; re-derive the id set from it,
		// since any bitmask decode in `mutate` ran against the pre-reload scene.
		setSelectedLocationIds(scene.selectedIds());
		t.end({ cells: scene.cells.size, total: scene.totalCount, bytes: buf.byteLength });
		emitEvent("scene:changed");
	} catch (e) {
		log.error("[scene] loadScene failed:", e);
	}
}

/** Clear all marker data from the scene. @unstable */
export function clearScene() {
	scene.clear();
	emitEvent("scene:changed");
}

/** Start listening for deltas, selections, and active-location changes. Returns a stop function. @unstable */
export function startSceneEngine(): () => void {
	const unsubDelta = subscribeEvent("render:delta", (delta) => {
		if (delta.fullReset) {
			void loadScene(lastMarkerStyle);
			return;
		}
		const t = trace("delta", { summary: true });
		const before = scene.overlay.version;
		const affected = scene.applyDelta(delta);
		// No bitmask follows an incremental mutation; applyDelta already folded membership in.
		if (scene.overlay.version !== before) setSelectedLocationIds(scene.selectedIds());
		t.end({ affected: affected.size, added: delta.added.length, removed: delta.removed.length });
		if (affected.size > 0 || scene.overlay.version !== before) emitEvent("scene:changed");
	});

	const unsubSel = subscribeEvent("render:selection", ({ selColors, cellEntries, setIds }) => {
		const t = trace("selection", { summary: true });
		const ids = scene.applySelectionBitmasks(selColors, cellEntries);
		setIds(ids);
		t.end({ cells: cellEntries.length, sels: selColors.length, ids: ids.size });
		emitEvent("scene:changed");
	});

	// Active-location switch fires a plain store mutation (store_set_active is fire-and-forget,
	// no delta). `setActive` is a no-op when the id hasn't moved.
	const unsubStore = subscribeEvent("store:changed", () => {
		if (syncActive()) emitEvent("scene:changed");
	});

	return () => {
		unsubDelta();
		unsubSel();
		unsubStore();
		clearScene();
	};
}
