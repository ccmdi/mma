import { Channel } from "@tauri-apps/api/core";
import { CellManager, SelectedIds, type FrameSummary } from "@/lib/render/CellManager";
import { cmd } from "@/lib/commands";
import type { RGBA } from "@/lib/util/color";
import type { RGB } from "@/bindings.gen";
import { DEFAULT_MARKER_COLOR } from "@/bindings.consts";
import { log } from "@/lib/util/log";
import { trace } from "@/lib/util/debug";
import { mapOpen } from "@/lib/util/debug";
import { emit as emitEvent, subscribe as subscribeEvent, track, useEventValue } from "@/lib/events";
import type { MarkerStyle } from "@/types";
import { watermark } from "@/lib/util/watermark";
import { holds } from "@/lib/util/holds";
import { serial } from "@/lib/util/concurrent";

// Owns marker/scene data for every map surface. The editor map drives the engine (the
// frame subscription and its lifecycle); both it and the minimap render from the same
// `CellManager`. Rust sends every change to the scene as a render frame on one channel.

let markerDefault: RGBA = [...DEFAULT_MARKER_COLOR, 255];

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
/** The map row open in the editor, which a clear forgets and the next load hides again. */
let openRow: number | null = null;
let selected = SelectedIds.EMPTY;
const loading = holds(() => emitEvent("scene:changed"));
let undrawn: (() => void) | null = loading.hold();

subscribeEvent("open:change", (id) => {
	openRow = id;
	scene.setOpen(id);
	emitEvent("scene:changed");
});

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
		scene.setOpen(openRow);
		applied = [];
	}
	if (scene.overlay.version !== before) selected = scene.selectedIds();
	applied.push(s);
	if (applied.length > APPLIED_KEPT) applied.shift();
	// A replace frame draws the store as it stands, which answers every wait on it.
	if (s.replace) drawnUpTo.reset(s.version, () => s);
	else drawnUpTo.pass(s.version, s);
	t.end({ added: s.added.length, removed: s.removed.length, bytes: buf.byteLength });
	if (s.replace && undrawn) {
		undrawn();
		undrawn = null;
	} else if (scene.version !== drawn) emitEvent("scene:changed");
	return s;
}

const loads = serial();
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
		await cmd.storeSubscribeFrames(channel, { markerStyle });
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

/** The marker scene the map surfaces render from, and its load lifecycle. @api @unstable */
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
		scene.version++;
		emitEvent("scene:changed");
	},
	/** Current default marker color as RGBA. */
	defaultColor: (): RGBA => {
		return markerDefault;
	},
	/** Snapshot of every rendered location's id and position (`[lng, lat, ...]`). */
	positions: (): { ids: Uint32Array; positions: Float32Array } => {
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
		return (sceneSettled = loads(() =>
			seq === loadRequested ? doLoadScene(markerStyle, mc) : undefined,
		));
	},
	/** Clear all marker data from the scene and stop following the map. */
	clear: () => {
		follow(null);
		scene.clear();
		selected = SelectedIds.EMPTY;
		if (undrawn) emitEvent("scene:changed");
		else undrawn = loading.hold();
	},
	/** What keeps the map showing as loading; the scene itself holds it until its markers are first drawn. */
	loading,
	/** The ids of the locations the listed selections select. */
	selected: (): SelectedIds => {
		track("scene:changed");
		return selected;
	},
	/** Reactive {@link Scene.selected}. */
	useSelected: (): SelectedIds => {
		return useEventValue("scene:changed", Scene.selected);
	},
};
