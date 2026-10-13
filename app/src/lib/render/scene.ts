import { Channel } from "@tauri-apps/api/core";
import { Store } from "@/store/store";
import { CellManager, type FrameSummary } from "@/lib/render/CellManager";
import { cmd } from "@/lib/commands";
import type { RGBA } from "@/lib/util/color";
import type { RGB } from "@/bindings.gen";
import { log } from "@/lib/util/log";
import { trace } from "@/lib/util/debug";
import { mapOpen } from "@/lib/util/debug";
import { emit as emitEvent, subscribe as subscribeEvent } from "@/lib/events";
import type { MarkerStyle } from "@/types";
import { Editor } from "@/store/editor";
import { watermark } from "@/lib/util/watermark";

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
const drawnUpTo = watermark<FrameSummary>(
	(version) => applied.find((s) => s.version >= version) ?? nothingApplied(version),
);

function syncOpen(): boolean {
	return scene.setOpen(Editor.get().open?.location?.id ?? null);
}

function nothingApplied(version: number): FrameSummary {
	return { version, replace: false, added: new Uint32Array(0), removed: new Uint32Array(0) };
}

/** Follow `channel` from here on, releasing every wait on the one before. */
function follow(channel: Channel<ArrayBuffer> | null) {
	following = channel;
	applied = [];
	drawnUpTo.reset(0, nothingApplied);
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
	if (scene.overlay.version !== before) Store.setSelected(scene.selectedIds());
	applied.push(s);
	if (applied.length > APPLIED_KEPT) applied.shift();
	// A replace frame draws the store as it stands, which answers every wait on it.
	if (s.replace) drawnUpTo.reset(s.version, () => s);
	else drawnUpTo.pass(s.version, s);
	t.end({ added: s.added.length, removed: s.removed.length, bytes: buf.byteLength });
	if (scene.version !== drawn) emitEvent("scene:changed");
	return s;
}

let sceneSettled: Promise<void> = Promise.resolve();
let loadRequested = 0;

async function doLoadScene(markerStyle: MarkerStyle, mc?: RGB): Promise<void> {
	lastMarkerStyle = markerStyle;
	if (mc) Scene.setDefaultColor(...mc);
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
		log.error("[scene] load failed:", e);
	}
}

export const Scene = {
	/** The shared scene that all map surfaces render from. */
	get: (): CellManager => {
		return scene;
	},
	/** Set the default marker color (RGB bytes). */
	setDefaultColor: (r: number, g: number, b: number) => {
		markerDefault = [r, g, b, 255];
	},
	/** Change the default marker color and repaint. */
	recolor: (mc: RGB) => {
		if (markerDefault.every((c, i) => c === mc[i])) return;
		Scene.setDefaultColor(...mc);
		void cmd.storeSetMarkerColor(mc);
		scene.version++;
		emitEvent("scene:changed");
	},
	/** Current default marker color as RGBA. */
	defaultColor: (): RGBA => {
		return markerDefault;
	},
	/**
	 * Resolves once the scene has applied the frame for map version `version`, with what that
	 * frame did. Resolves at once, with nothing applied, when the scene follows no map.
	 * @unstable
	 */
	reached: (version: number): Promise<FrameSummary> => {
		if (!following) return Promise.resolve(nothingApplied(version));
		return drawnUpTo.reached(version);
	},
	/** Resolves when the most recently started full scene load has finished (or immediately if none is in flight). */
	settled: (): Promise<void> => {
		return sceneSettled;
	},
	/** Load the whole scene again and follow every change to it from there. */
	load: (markerStyle: MarkerStyle = lastMarkerStyle, mc?: RGB): Promise<void> => {
		const seq = ++loadRequested;
		return (sceneSettled = sceneSettled
			.catch(() => {})
			.then(() => {
				if (seq !== loadRequested) return;
				return doLoadScene(markerStyle, mc);
			}));
	},
	/** Clear all marker data from the scene and stop following the map. */
	clear: () => {
		follow(null);
		scene.clear();
		emitEvent("scene:changed");
	},
	/** Start following open-location changes. Returns a stop function. */
	start: (): (() => void) => {
		// Opening a location sends no frame, so the scene follows the editor; `setOpen` is a
		// no-op when the id hasn't moved.
		const unsubEditor = subscribeEvent("editor:changed", () => {
			if (syncOpen()) emitEvent("scene:changed");
		});

		return () => {
			unsubEditor();
			Scene.clear();
		};
	},
};
