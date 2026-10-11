import { Channel } from "@tauri-apps/api/core";
import { CellManager, type FrameSummary } from "@/lib/render/CellManager";
import { cmd } from "@/lib/commands";
import type { RGBA } from "@/lib/util/color";
import type { RGB } from "@/bindings.gen";
import { log } from "@/lib/util/log";
import { trace } from "@/lib/util/debug";
import { getMapState, setSelectedLocationIds } from "@/store/useMapStore";
import { mapOpen } from "@/lib/util/debug";
import { emit as emitEvent, subscribe as subscribeEvent } from "@/lib/events";
import type { MarkerStyle } from "@/types";

// Owns marker/scene data for every map surface. The editor map drives the engine (the
// frame subscription and its lifecycle); both it and the minimap render from the same
// `CellManager`. Rust sends every change to the scene as a render frame on one channel.

let markerDefault: RGBA = [42, 42, 42, 255];

const scene = new CellManager();
let lastMarkerStyle: MarkerStyle = "pin";

/** The channel the scene is following, or null when it follows none. */
let following: Channel<ArrayBuffer> | null = null;
/** The last few frames applied, for a wait that starts after its frame landed. */
let applied: FrameSummary[] = [];
const APPLIED_KEPT = 16;
let waiters: { version: number; resolve: (s: FrameSummary) => void }[] = [];

/** The shared scene that all map surfaces render from. */
export function getScene(): CellManager {
	return scene;
}

function syncOpen(): boolean {
	return scene.setOpen(getMapState().open?.row?.id ?? null);
}

/** Set the default marker color (RGB bytes). */
export function setMarkerDefaultColor(r: number, g: number, b: number) {
	markerDefault = [r, g, b, 255];
}

/** Change the default marker color and repaint. */
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

function nothingApplied(version: number): FrameSummary {
	return { version, replace: false, added: new Uint32Array(0), removed: new Uint32Array(0) };
}

/** Follow `channel` from here on, releasing every wait on the one before. */
function follow(channel: Channel<ArrayBuffer> | null) {
	following = channel;
	applied = [];
	for (const w of waiters) w.resolve(nothingApplied(w.version));
	waiters = [];
}

/**
 * Resolves once the scene has applied the frame for map version `version`, with what that
 * frame did. Resolves at once, with nothing applied, when the scene follows no map.
 * @unstable
 */
export function sceneReached(version: number): Promise<FrameSummary> {
	if (!following) return Promise.resolve(nothingApplied(version));
	const hit = applied.find((s) => s.version >= version);
	if (hit) return Promise.resolve(hit);
	return new Promise((resolve) => waiters.push({ version, resolve }));
}

function onFrame(channel: Channel<ArrayBuffer>, buf: ArrayBuffer): FrameSummary | null {
	if (channel !== following) return null;
	const t = trace("frame", { summary: true });
	const before = scene.overlay.version;
	const drawn = scene.version;
	const s = scene.apply(buf);
	if (s.replace) {
		syncOpen();
		applied = [];
	}
	if (scene.overlay.version !== before) setSelectedLocationIds(scene.selectedIds());
	applied.push(s);
	if (applied.length > APPLIED_KEPT) applied.shift();
	// A replace frame draws the store as it stands, which answers every wait on it.
	waiters = waiters.filter((w) => {
		if (!s.replace && w.version > s.version) return true;
		w.resolve(s);
		return false;
	});
	t.end({ added: s.added.length, removed: s.removed.length, bytes: buf.byteLength });
	if (scene.version !== drawn) emitEvent("scene:changed");
	return s;
}

let sceneSettled: Promise<void> = Promise.resolve();
let loadRequested = 0;

/** Resolves when the most recently started full scene load has finished (or immediately if none is in flight). */
export function whenSceneSettled(): Promise<void> {
	return sceneSettled;
}

/** Load the whole scene again and follow every change to it from there. */
export function loadScene(markerStyle: MarkerStyle = lastMarkerStyle, mc?: RGB): Promise<void> {
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
	const t = trace("render", { summary: true });
	const channel = new Channel<ArrayBuffer>();
	const loaded = new Promise<void>((resolve) => {
		channel.onmessage = (buf) => {
			if (onFrame(channel, buf)?.replace) resolve();
		};
	});
	follow(channel);
	try {
		await cmd.storeSubscribeFrames(channel, {
			west: -180,
			south: -90,
			east: 180,
			north: 90,
			markerStyle,
			markerColor: mc,
		});
		t.step("subscribe");
		await loaded;
		t.step("apply");
		mapOpen.mark("markers");
		t.end({ cells: scene.cells.size, total: scene.totalCount });
	} catch (e) {
		if (following === channel) follow(null);
		log.error("[scene] loadScene failed:", e);
	}
}

/** Clear all marker data from the scene and stop following the map. */
export function clearScene() {
	follow(null);
	scene.clear();
	emitEvent("scene:changed");
}

/** Start following open-location changes. Returns a stop function. */
export function startSceneEngine(): () => void {
	// Opening a location sends no frame, so the scene follows the store state; `setOpen` is a
	// no-op when the id hasn't moved.
	const unsubStore = subscribeEvent("store:changed", () => {
		if (syncOpen()) emitEvent("scene:changed");
	});

	return () => {
		unsubStore();
		clearScene();
	};
}
