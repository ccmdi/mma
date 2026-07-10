// Toggleable overlay of every Street View pano ever seen (across all maps). The dots are
// rendered as a layer *inside the core scene* (buildSceneLayers), exactly like the staged
// import preview — so picking, hover cursor, and clicks flow through the one deck pass with
// no second overlay or interceptors. This module just owns the toggle + data + reactivity.

import { useSyncExternalStore } from "react";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { subscribe as onEvent } from "@/lib/events";
import { fetchLocation, setActiveLocation, previewVirtualLocation } from "@/store/useMapStore";
import { createLocation, LocationFlag } from "@/types";
import { getSeenCount, getSeenEntries, seenSkipNext } from "./seen";
import type { SeenEntry } from "@/bindings.gen";

// Dot colors: a pano already on the current map (clicking opens that location) vs one that's
// only in history (clicking previews it, with "Add to map").
const COLOR_ON_MAP: [number, number, number, number] = [64, 165, 255, 220]; // blue
const COLOR_OFF_MAP: [number, number, number, number] = [255, 176, 0, 220]; // orange

let entries: SeenEntry[] = [];
/** Seen-entry ids whose pano resolves to an existing location on the current map. */
let onMapIds = new Set<number>();
let active = false;
let version = 0;
const listeners = new Set<() => void>();

function notify() {
	version++;
	for (const l of listeners) l();
}

export function subscribeSeenOverlay(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

/** Repaint signal for the scene; include in the surface's rebuild deps. */
export function useSeenOverlayVersion(): number {
	return useSyncExternalStore(subscribeSeenOverlay, () => version);
}

export function isSeenOverlayActive(): boolean {
	return active;
}

export function getSeenOverlayEntries(): SeenEntry[] {
	return entries;
}

/** Fill color for a seen dot: distinct when the pano already exists on the current map.
 *  Changes identity (`onMapIds`) on each load — use it as the layer's updateTrigger. */
export function seenEntryColor(entry: SeenEntry): [number, number, number, number] {
	return onMapIds.has(entry.id) ? COLOR_ON_MAP : COLOR_OFF_MAP;
}

export function getSeenOnMapIds(): ReadonlySet<number> {
	return onMapIds;
}

/** Which seen entries map to a still-existing location on the current map (matching pano).
 *  Mirrors openSeenEntry's "open the real one" check, batched into a single lookup. */
async function computeOnMap(list: SeenEntry[]): Promise<Set<number>> {
	const locIds = [...new Set(list.map((e) => e.locationId).filter((x): x is number => x != null))];
	if (locIds.length === 0) return new Set();
	const panoById = new Map((await cmd.storeGetLocationsByIds(locIds)).map((l) => [l.id, l.panoId]));
	const out = new Set<number>();
	for (const e of list) {
		if (e.locationId != null && panoById.get(e.locationId) === e.panoId) out.add(e.id);
	}
	return out;
}

export function toggleSeenOverlay(): void {
	active = !active;
	if (!active) {
		entries = [];
		onMapIds = new Set();
	}
	notify();
	if (active) void load();
}

async function load() {
	try {
		const count = await getSeenCount();
		entries = count > 0 ? await getSeenEntries(count, 0, undefined, false) : [];
		onMapIds = await computeOnMap(entries);
	} catch (e) {
		log.error("[seen-overlay] load failed:", e);
		entries = [];
		onMapIds = new Set();
	}
	if (active) notify();
}

/** Open the seen entry at `index` (deck pick index): select its real location if present on
 *  this map, else a read-only virtual preview that loads the exact pano. Nothing is added. */
export async function openSeenEntry(index: number): Promise<void> {
	const entry = entries[index];
	if (!entry) return;
	seenSkipNext(entry.panoId);
	if (entry.locationId != null) {
		const existing = await fetchLocation(entry.locationId);
		if (existing && existing.panoId === entry.panoId) {
			void setActiveLocation(existing.id);
			return;
		}
	}
	const preview = createLocation({
		lat: entry.lat,
		lng: entry.lng,
		heading: entry.heading,
		pitch: entry.pitch,
		zoom: entry.zoom,
		panoId: entry.panoId,
		extra: entry.countryCode ? { countryCode: entry.countryCode } : undefined,
	});
	preview.flags = LocationFlag.LoadAsPanoId; // resolve the exact pano, not nearest coverage
	previewVirtualLocation(preview);
}

onEvent("map:close", () => {
	if (!active && entries.length === 0) return;
	active = false;
	entries = [];
	onMapIds = new Set();
	notify();
});
