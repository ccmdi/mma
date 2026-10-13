// Toggle the seen-pano overlay and keep its data current.
// The shared map scene renders its dots and handles picking.
import { Query } from "@/store/query";
import { Editor } from "@/store/editor";
import { log } from "@/lib/util/log";
import { latest } from "@/lib/util/latest";
import { emit as emitEvent, subscribe as onEvent } from "@/lib/events";
import { createLocation } from "@/types";
import { LocationFlag } from "@/bindings.consts";
import { Seen } from "./seen";
import type { SeenEntry } from "@/bindings.gen";
import type { RGBA } from "@/lib/util/color";

// Dot colors: a pano already on the current map (clicking opens that location) vs one that's
// only in history (clicking previews it, with "Add to map").
const COLOR_ON_MAP: RGBA = [64, 165, 255, 220]; // blue
const COLOR_OFF_MAP: RGBA = [255, 176, 0, 220]; // orange

let entries: SeenEntry[] = [];
/** Seen-entry ids whose pano resolves to an existing location on the current map. */
let onMapIds = new Set<number>();
let active = false;

export function isSeenOverlayActive(): boolean {
	return active;
}

export function getSeenOverlayEntries(): SeenEntry[] {
	return entries;
}

/** Fill color for a seen dot: distinct when the pano already exists on the current map.
 *  Changes identity (`onMapIds`) on each load — use it as the layer's updateTrigger. */
export function seenEntryColor(entry: SeenEntry): RGBA {
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
	const onMap = await Query.read(
		{ type: "Locations", locations: locIds, name: null },
		{ kind: "locations" },
	);
	const panoById = new Map(onMap.map((l) => [l.id, l.panoId]));
	const out = new Set<number>();
	for (const e of list) {
		if (e.locationId != null && panoById.get(e.locationId) === e.panoId) out.add(e.id);
	}
	return out;
}

const loads = latest<{ entries: SeenEntry[]; onMapIds: Set<number> }>({
	publish: (loaded) => {
		({ entries, onMapIds } = loaded);
		emitEvent("seen:changed");
	},
	failed: (e) => {
		log.error("[seen-overlay] load failed:", e);
		clear();
		emitEvent("seen:changed");
	},
});

function clear(): void {
	loads.cancel();
	entries = [];
	onMapIds = new Set();
}

export function toggleSeenOverlay(): void {
	active = !active;
	if (!active) clear();
	emitEvent("seen:changed");
	if (active)
		void loads.replace(async () => {
			const count = await Seen.count();
			const loaded = count > 0 ? await Seen.entries(count, 0, undefined, false) : [];
			return { entries: loaded, onMapIds: await computeOnMap(loaded) };
		});
}

/** Open the seen entry at `index` (deck pick index): select its real location if present on
 *  this map, else a read-only virtual preview that loads the exact pano. Nothing is added. */
export async function openSeenEntry(index: number): Promise<void> {
	const entry = entries[index];
	if (!entry) return;
	Seen.skipNext(entry.panoId);
	if (entry.locationId != null) {
		const [existing] = await Query.read(
			{ type: "Locations", locations: [entry.locationId], name: null },
			{ kind: "locations" },
		);
		if (existing && existing.panoId === entry.panoId) {
			void Editor.open(existing.id);
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
	Editor.preview(preview);
}

onEvent("map:close", () => {
	if (!active && entries.length === 0) return;
	active = false;
	clear();
	emitEvent("seen:changed");
});
