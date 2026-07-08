import { useSyncExternalStore } from "react";
import { CellManager } from "@/lib/render/CellManager";
import { cmd } from "@/lib/commands";
import { mmaBufUrl } from "@/lib/util/util";
import type { RGB } from "@/lib/util/color";
import { log } from "@/lib/util/log";
import { trace } from "@/lib/util/debug";
import {
	getActiveLocation,
	getSelectedLocationIds,
	mapOpen,
	renderDeltaBus,
	selBitmaskBus,
	setSelectedLocationIds,
	subscribeStore,
} from "@/store/useMapStore";
import type { MarkerStyle } from "@/types";

// Owns marker/scene data for every map surface. The editor map drives the
// engine (fetch + lifecycle); both it and the minimap render from the same `CellManager`.
// There can be exactly one producer — `store_fill_render_file` is unsafe for a second caller
// (ignores bounds, rebuilds the picking index, shared file path).

const ACTIVE_HIDDEN: [number, number, number, number] = [0, 0, 0, 0];
let markerDefault: [number, number, number, number] = [42, 42, 42, 255];

const scene = new CellManager();
let version = 0;
let prevActiveId: number | null = null;
let lastMarkerStyle: MarkerStyle = "pin";
let loadToken = 0;
let listeners: Array<() => void> = [];

function bumpScene() {
	version++;
	for (const l of listeners) l();
}

export function getScene(): CellManager {
	return scene;
}

function getSceneVersion() {
	return version;
}

export function subscribeScene(fn: () => void): () => void {
	listeners.push(fn);
	return () => {
		listeners = listeners.filter((l) => l !== fn);
	};
}

/** Reactive scene version. Bumps on load, delta, selection, and active-location change. */
export function useScene(): number {
	return useSyncExternalStore(subscribeScene, getSceneVersion);
}

function patchMarker(id: number, rgba: [number, number, number, number]) {
	for (const cb of scene.cells.values()) {
		const idx = cb.idToIndex.get(id);
		if (idx != null) {
			cb.patchColor(idx, rgba[0], rgba[1], rgba[2], rgba[3]);
			return;
		}
	}
}

// Reflect the active location in the scene: hide its base marker (the active overlay draws
// it) and restore the previously-active one — unless it's selected. Fast path: no refetch.
function applyActive() {
	const activeId = getActiveLocation()?.id ?? null;
	if (
		prevActiveId != null &&
		prevActiveId !== activeId &&
		!getSelectedLocationIds().has(prevActiveId)
	) {
		patchMarker(prevActiveId, markerDefault);
	}
	prevActiveId = activeId;
	if (activeId != null) patchMarker(activeId, ACTIVE_HIDDEN);
}

export function setMarkerDefaultColor(r: number, g: number, b: number) {
	markerDefault = [r, g, b, 255];
}

/** Repaint the default marker color in place: patches base cell colors and tells Rust
 *  (for future deltas). No render rebuild — safe to drive from an interactive picker. */
export function recolorScene(mc: RGB) {
	const [or, og, ob] = markerDefault;
	if (or === mc.r && og === mc.g && ob === mc.b) return;
	setMarkerDefaultColor(mc.r, mc.g, mc.b);
	for (const cb of scene.cells.values()) {
		const colors = cb.colors;
		for (let i = 0; i < cb.count; i++) {
			const o = i * 4;
			if (
				colors[o + 3] === 255 &&
				colors[o] === or &&
				colors[o + 1] === og &&
				colors[o + 2] === ob
			) {
				colors[o] = mc.r;
				colors[o + 1] = mc.g;
				colors[o + 2] = mc.b;
			}
		}
		cb.colorVersion++;
	}
	void cmd.storeSetMarkerColor([mc.r, mc.g, mc.b]);
	scene.version++;
	bumpScene();
}

export function getMarkerDefaultColor(): [number, number, number, number] {
	return markerDefault;
}

let sceneSettled: Promise<void> = Promise.resolve();

/** Resolves when the most recently started full scene load has finished (or immediately if none is in flight). */
export function whenSceneSettled(): Promise<void> {
	return sceneSettled;
}

/** Full (re)load from Rust for the whole world. Editor-driven on open / marker-style change. */
export function loadScene(markerStyle: MarkerStyle, mc?: RGB): Promise<void> {
	return (sceneSettled = doLoadScene(markerStyle, mc));
}

async function doLoadScene(markerStyle: MarkerStyle, mc?: RGB): Promise<void> {
	lastMarkerStyle = markerStyle;
	if (mc) setMarkerDefaultColor(mc.r, mc.g, mc.b);
	const token = ++loadToken;
	const t = trace("render", { summary: true });
	try {
		const filePath = await cmd.storeFillRenderFile({
			west: -180,
			south: -90,
			east: 180,
			north: 90,
			markerStyle,
			markerColor: mc ? [mc.r, mc.g, mc.b] : undefined,
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
		applyActive();
		// The reloaded binary carries the selection overlay; re-derive the id set from it,
		// since any bitmask decode in `mutate` ran against the pre-reload scene.
		setSelectedLocationIds(scene.selectedIds());
		t.end({ cells: scene.cells.size, total: scene.totalCount, bytes: buf.byteLength });
		bumpScene();
	} catch (e) {
		log.error("[scene] loadScene failed:", e);
	}
}

export function clearScene() {
	scene.clear();
	prevActiveId = null;
	bumpScene();
}

// Subscriptions live for the editor map's lifetime (one producer). Returns a stop fn.
export function startSceneEngine(): () => void {
	const unsubDelta = renderDeltaBus.on((delta) => {
		if (delta.fullReset) {
			void loadScene(lastMarkerStyle);
			return;
		}
		const t = trace("delta", { summary: true });
		const affected = scene.applyDelta(delta);
		const aid = getActiveLocation()?.id ?? null;
		if (aid != null) patchMarker(aid, ACTIVE_HIDDEN);
		if (delta.colorPatches.length > 0) {
			const selPatches = delta.colorPatches.filter(
				(cp) =>
					!(cp.r === markerDefault[0] && cp.g === markerDefault[1] && cp.b === markerDefault[2]),
			);
			scene.appendToSelectionOverlay(selPatches);
		}
		t.end({ affected: affected.size, added: delta.added.length, removed: delta.removed.length });
		if (affected.size > 0 || delta.colorPatches.length > 0) bumpScene();
	});

	const unsubSel = selBitmaskBus.on((selColors, cellEntries, setIds) => {
		const t = trace("selection", { summary: true });
		const [r, g, b] = markerDefault;
		const ids = scene.applySelectionBitmasks(selColors, cellEntries, [r, g, b]);
		setIds(ids);
		t.end({ cells: cellEntries.length, sels: selColors.length, ids: ids.size });
		bumpScene();
	});

	// Active-location switch fires a plain store mutation (store_set_active is fire-and-forget,
	// no delta). Re-derive the scene's active highlight when the id changes.
	const unsubStore = subscribeStore(() => {
		const activeId = getActiveLocation()?.id ?? null;
		if (activeId !== prevActiveId) {
			applyActive();
			bumpScene();
		}
	});

	return () => {
		unsubDelta();
		unsubSel();
		unsubStore();
		clearScene();
	};
}
