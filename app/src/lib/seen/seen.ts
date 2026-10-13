import { Store } from "@/store/store";
import { Location } from "@/store/location";
import { Query } from "@/store/query";
import { Editor } from "@/store/editor";
import { cmd } from "@/lib/commands";
import type { PanoViewer } from "@/lib/sv/pano";
import { getSettings } from "@/store/settings";
import { log } from "@/lib/util/log";
import { wrapDeg } from "@/lib/geo/geo";
import { createLocation, type LocationPOV } from "@/types";
import type { Nullable, Rename, RequireNonNull } from "@/types/util";
import type { GeoDisplay } from "@/lib/geo/reverseGeocode";
import type { SeenEntry, SeenFilter, SeenMapInfo } from "@/bindings.gen";

type PendingEntryLocation = RequireNonNull<Pick<Location, "lat" | "lng" | "panoId">> &
	Nullable<Rename<Pick<Location, "id">, { id: "locationId" }>>;
type SeenPano = Pick<
	SeenEntry,
	"locationId" | "lat" | "lng" | "heading" | "pitch" | "zoom" | "countryCode"
> &
	Pick<Location, "panoId">;
type PendingEntry = PendingEntryLocation &
	Nullable<GeoDisplay> & {
		enteredAt: number;
		mapId: string | null;
	};

let staged: PendingEntry | null = null;
let skipNextPanoId: string | null = null;

function flushStaged(viewer: PanoViewer) {
	if (!staged) return;
	const entry = staged;
	staged = null;

	const thumbnail = getSettings().enableSeenThumbnails ? captureThumbnail(viewer) : null;
	void writeEntry(entry, viewer.captureView(), thumbnail);
}

const STARTING_THUMBNAIL_WAIT_MS = 3_000;
const STARTING_THUMBNAIL_POLL_MS = 100;
const STARTING_VIEW_TOLERANCE_DEG = 0.5;

async function startingThumbnail(
	location: PendingEntryLocation & LocationPOV,
	viewer: PanoViewer,
): Promise<string | null> {
	const deadline = Date.now() + STARTING_THUMBNAIL_WAIT_MS;
	while (Date.now() < deadline) {
		if (!onStartingView(location, viewer)) return null;
		const thumbnail = captureThumbnail(viewer);
		if (thumbnail) return thumbnail;
		await new Promise((resolve) => setTimeout(resolve, STARTING_THUMBNAIL_POLL_MS));
	}
	return null;
}

function onStartingView(location: PendingEntryLocation & LocationPOV, viewer: PanoViewer): boolean {
	const { heading, pitch } = viewer.captureView();
	return (
		viewer.panoId() === location.panoId &&
		Math.abs(wrapDeg(heading - location.heading, -180)) < STARTING_VIEW_TOLERANCE_DEG &&
		Math.abs(pitch - location.pitch) < STARTING_VIEW_TOLERANCE_DEG
	);
}

const RESOLUTIONS = { low: [160, 90], medium: [320, 180], high: [640, 360] } as const;

function captureThumbnail(viewer: PanoViewer): string | null {
	try {
		const [w, h] = RESOLUTIONS[getSettings().seenResolution] ?? RESOLUTIONS.medium;
		const dataUrl = viewer.captureImage(w, h)?.toDataURL("image/jpeg", 0.6);
		const base64 = dataUrl?.split(",")[1];
		return base64 && base64.length >= 100 ? base64 : null;
	} catch {
		return null;
	}
}

async function writeEntry(entry: PendingEntry, pov: LocationPOV, thumbnail: string | null) {
	try {
		await cmd.storeSeenWrite({
			...entry,
			...pov,
			thumbnail,
		});
	} catch (e) {
		log.warn("[seen] failed to write entry:", e);
	}
}

export const Seen = {
	/** Fetch a page of the seen (visited-panorama) history. */
	entries: async (
		limit = 100,
		offset = 0,
		filter?: SeenFilter,
		thumbnails = true,
	): Promise<SeenEntry[]> => {
		return cmd.storeSeenList(limit, offset, filter ?? null, thumbnails);
	},
	/** Number of seen entries matching the filter (all when omitted). */
	count: async (filter?: SeenFilter): Promise<number> => {
		return cmd.storeSeenCount(filter ?? null);
	},
	/** Distinct country codes that appear in the seen history. */
	countries: async (): Promise<string[]> => {
		return cmd.storeSeenCountries();
	},
	/** Maps that have seen-history entries. */
	maps: async (): Promise<SeenMapInfo[]> => {
		return cmd.storeSeenMaps();
	},
	/** Delete the entire seen history. Not undoable. */
	clear: async (): Promise<void> => {
		await cmd.storeSeenClear();
	},
	/** Suppress the next seen-history entry for `panoId`. */
	skipNext: (panoId: string) => {
		skipNextPanoId = panoId;
	},
	/** Update the pending seen entry's geocode info (country, address). */
	updateGeo: (geo: GeoDisplay) => {
		if (staged) {
			if (geo.countryCode) staged.countryCode = geo.countryCode;
			if (geo.address) staged.address = geo.address;
		}
	},
	/** Record a panorama change for the seen history. Flushes the previous entry and stages the new one. */
	panoChanged: (location: PendingEntryLocation, geo: GeoDisplay | null, viewer: PanoViewer) => {
		const settings = getSettings();
		if (!settings.enableSeen) return;

		if (skipNextPanoId === location.panoId) {
			skipNextPanoId = null;
			return;
		}

		if (staged) {
			flushStaged(viewer);
		}

		staged = {
			...location,
			enteredAt: Date.now(),
			mapId: Store.get().mapId,
			countryCode: geo?.countryCode || null,
			address: geo?.address || null,
		};
	},
	/** Write the pending seen entry to disk, if any. */
	flush: (viewer: PanoViewer) => {
		flushStaged(viewer);
	},
	/** Record a pano visit now at its starting view, with a thumbnail if that view is still on screen once imagery arrives. */
	record: async (location: PendingEntryLocation & LocationPOV, viewer: PanoViewer) => {
		const settings = getSettings();
		if (!settings.enableSeen) return;
		const { heading, pitch, zoom, ...at } = location;
		const entry: PendingEntry = {
			...at,
			enteredAt: Date.now(),
			mapId: Store.get().mapId,
			countryCode: null,
			address: null,
		};
		const thumbnail = settings.enableSeenThumbnails
			? await startingThumbnail(location, viewer)
			: null;
		await writeEntry(entry, { heading, pitch, zoom }, thumbnail);
	},
	/** Open a seen entry's panorama in the Street View viewer. */
	loadPano: async (entry: SeenPano, viewer: PanoViewer) => {
		if (entry.panoId) Seen.skipNext(entry.panoId);

		const [fetched] =
			entry.locationId != null
				? await Query.read(
						{ type: "Locations", locations: [entry.locationId], name: null },
						{ kind: "locations" },
					)
				: [];
		const existing = fetched && fetched.panoId === entry.panoId ? fetched : null;

		if (existing) {
			const active = Editor.get().open?.location;
			if (active?.id !== existing.id) {
				await Editor.open(existing.id);
				return;
			}
		} else {
			const loc = createLocation({
				lat: entry.lat,
				lng: entry.lng,
				heading: entry.heading,
				pitch: entry.pitch,
				zoom: entry.zoom,
				panoId: entry.panoId,
				extra: entry.countryCode ? { countryCode: entry.countryCode } : undefined,
			});
			await Location.add([loc]);
			await Editor.open(loc.id, false);
			return;
		}

		if (!viewer.exists()) return;
		viewer.jump(entry.panoId ?? { lat: entry.lat, lng: entry.lng }, {
			heading: entry.heading,
			pitch: entry.pitch,
			zoom: entry.zoom,
		});
	},
};
