import { cmd } from "@/lib/commands";
import type { PanoViewer } from "@/lib/sv/pano";
import { getSettings } from "@/store/settings";
import { addLocations, fetchLocations, getMapState, setActiveLocation } from "@/store/useMapStore";
import { log } from "@/lib/util/log";
import { wrapDeg } from "@/lib/geo/geo";
import { createLocation, type LocationPOV } from "@/types";
import type { Nullable, Rename, RequireNonNull } from "@/types/util";
import type { GeoDisplay } from "@/lib/geo/reverseGeocode";

import type { Location, SeenEntry } from "@/bindings.gen";

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

/** Suppress the next seen-history entry for `panoId`. */
export function seenSkipNext(panoId: string) {
	skipNextPanoId = panoId;
}

/** Update the pending seen entry's geocode info (country, address). */
export function seenUpdateGeo(geo: GeoDisplay) {
	if (staged) {
		if (geo.countryCode) staged.countryCode = geo.countryCode;
		if (geo.address) staged.address = geo.address;
	}
}

/** Record a panorama change for the seen history. Flushes the previous entry and stages the new one. */
export function seenPanoChanged(
	location: PendingEntryLocation,
	geo: GeoDisplay | null,
	viewer: PanoViewer,
) {
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
		mapId: getMapState().mapId,
		countryCode: geo?.countryCode || null,
		address: geo?.address || null,
	};
}

function flushStaged(viewer: PanoViewer) {
	if (!staged) return;
	const entry = staged;
	staged = null;

	const thumbnail = getSettings().enableSeenThumbnails ? captureThumbnail(viewer) : null;
	void writeEntry(entry, viewer.captureView(), thumbnail);
}

/** Write the pending seen entry to disk, if any. */
export function seenFlush(viewer: PanoViewer) {
	flushStaged(viewer);
}

const STARTING_THUMBNAIL_WAIT_MS = 3_000;
const STARTING_THUMBNAIL_POLL_MS = 100;
const STARTING_VIEW_TOLERANCE_DEG = 0.5;

/** Record a pano visit now at its starting view, with a thumbnail if that view is still on screen once imagery arrives. */
export async function seenRecord(location: PendingEntryLocation & LocationPOV, viewer: PanoViewer) {
	const settings = getSettings();
	if (!settings.enableSeen) return;
	const { heading, pitch, zoom, ...at } = location;
	const entry: PendingEntry = {
		...at,
		enteredAt: Date.now(),
		mapId: getMapState().mapId,
		countryCode: null,
		address: null,
	};
	const thumbnail = settings.enableSeenThumbnails
		? await startingThumbnail(location, viewer)
		: null;
	await writeEntry(entry, { heading, pitch, zoom }, thumbnail);
}

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

/** Open a seen entry's panorama in the Street View viewer. */
export async function loadSeenPano(entry: SeenPano, viewer: PanoViewer) {
	if (entry.panoId) seenSkipNext(entry.panoId);

	const [fetched] =
		entry.locationId != null
			? await fetchLocations({ type: "Locations", locations: [entry.locationId], name: null })
			: [];
	const existing = fetched && fetched.panoId === entry.panoId ? fetched : null;

	if (existing) {
		const active = getMapState().activeLocation;
		if (active?.id !== existing.id) {
			await setActiveLocation(existing.id);
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
		await addLocations([loc]);
		await setActiveLocation(loc.id, false);
		return;
	}

	if (!viewer.exists()) return;
	viewer.jump(entry.panoId ?? { lat: entry.lat, lng: entry.lng }, {
		heading: entry.heading,
		pitch: entry.pitch,
		zoom: entry.zoom,
	});
}
