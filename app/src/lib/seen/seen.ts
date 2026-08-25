import { cmd } from "@/lib/commands";
import { captureLivePano } from "@/lib/sv/panoCapture";
import { getSettings } from "@/store/settings";
import { getMapState } from "@/store/useMapStore";
import { log } from "@/lib/util/log";
import type { LocationPOV } from "@/types";
import type { SeenFilter } from "@/bindings.gen";
import type { Nullable, Rename, RequireNonNull } from "@/types/util";
import type { GeoDisplay } from "@/components/editor/location/useReverseGeocode";

import type { Location, SeenEntry } from "@/bindings.gen";

type PendingEntryLocation = RequireNonNull<Pick<Location, "lat" | "lng" | "panoId">> &
	Nullable<Rename<Pick<Location, "id">, { id: "locationId" }>>;
type PendingEntry = PendingEntryLocation &
	Nullable<GeoDisplay> & {
		enteredAt: number;
		mapId: string | null;
	};

let staged: PendingEntry | null = null;
let skipNextPanoId: string | null = null;
let latestGeo: GeoDisplay | null = null;

export function seenSkipNext(panoId: string) {
	skipNextPanoId = panoId;
}

export function seenUpdateGeo(geo: GeoDisplay) {
	latestGeo = geo;
	if (staged) {
		if (geo.countryCode) staged.countryCode = geo.countryCode;
		if (geo.address) staged.address = geo.address;
	}
}

export function seenPanoChanged(
	location: PendingEntryLocation,
	geo: GeoDisplay | null,
	getPov: () => LocationPOV,
) {
	const settings = getSettings();
	if (!settings.enableSeen) return;

	if (skipNextPanoId === location.panoId) {
		skipNextPanoId = null;
		return;
	}

	if (staged) {
		flushStaged(getPov);
	}

	staged = {
		...location,
		enteredAt: Date.now(),
		mapId: getMapState().mapId,
		countryCode: geo?.countryCode || latestGeo?.countryCode || null,
		address: geo?.address || latestGeo?.address || null,
	};
}

function flushStaged(getPov: () => LocationPOV) {
	if (!staged) return;
	const entry = staged;
	staged = null;

	const thumbnail = getSettings().enableSeenThumbnails ? captureThumbnail() : null;
	void writeEntry(entry, getPov(), thumbnail);
}

export function seenFlush(getPov: () => LocationPOV) {
	flushStaged(getPov);
}

const RESOLUTIONS = { low: [160, 90], medium: [320, 180], high: [640, 360] } as const;

function captureThumbnail(): string | null {
	try {
		const [w, h] = RESOLUTIONS[getSettings().seenResolution] ?? RESOLUTIONS.medium;
		const dataUrl = captureLivePano(w, h)?.toDataURL("image/jpeg", 0.6);
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

/** Fetch a page of the seen (visited-panorama) history. */
export async function getSeenEntries(
	limit = 100,
	offset = 0,
	filter?: SeenFilter,
	thumbnails = true,
): Promise<SeenEntry[]> {
	const result = await cmd.storeSeenList(limit, offset, filter ?? null, thumbnails);
	return result;
}

/** Number of seen entries matching the filter (all when omitted). */
export async function getSeenCount(filter?: SeenFilter): Promise<number> {
	return cmd.storeSeenCount(filter ?? null);
}

export async function getSeenCountries(): Promise<string[]> {
	return cmd.storeSeenCountries();
}

export async function getSeenMaps(): Promise<{ id: string; name: string }[]> {
	return cmd.storeSeenMaps();
}

/** Delete the entire seen history. Not undoable. */
export async function clearSeen(): Promise<void> {
	await cmd.storeSeenClear();
}
