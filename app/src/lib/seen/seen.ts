import { cmd } from "@/lib/commands";
import { getSettings } from "@/store/settings";
import { getCurrentMapId } from "@/store/useMapStore";
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
let canvasGetter: (() => HTMLCanvasElement | null) | null = null;
let skipNextPanoId: string | null = null;
let latestGeo: GeoDisplay | null = null;

export function seenSetCanvas(getter: (() => HTMLCanvasElement | null) | null) {
	canvasGetter = getter;
}

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
		mapId: getCurrentMapId(),
		countryCode: geo?.countryCode || latestGeo?.countryCode || null,
		address: geo?.address || latestGeo?.address || null,
	};
}

function flushStaged(getPov: () => LocationPOV) {
	if (!staged) return;
	const entry = staged;
	staged = null;

	let thumbnail: string | null = null;
	if (getSettings().enableSeenThumbnails && canvasGetter) {
		const canvas = canvasGetter();
		if (canvas && canvas.width > 0 && canvas.height > 0) {
			thumbnail = captureThumbnail(canvas);
		}
	}

	writeEntry(entry, getPov(), thumbnail);
}

export function seenFlush(getPov: () => LocationPOV) {
	flushStaged(getPov);
}

const RESOLUTIONS = { low: [160, 90], medium: [320, 180], high: [640, 360] } as const;

function captureThumbnail(canvas: HTMLCanvasElement): string | null {
	try {
		const [w, h] = RESOLUTIONS[getSettings().seenResolution] ?? RESOLUTIONS.medium;
		const offscreen = document.createElement("canvas");
		offscreen.width = w;
		offscreen.height = h;
		const ctx = offscreen.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(canvas, 0, 0, w, h);
		const dataUrl = offscreen.toDataURL("image/jpeg", 0.6);
		const base64 = dataUrl.split(",")[1];
		if (!base64 || base64.length < 100) return null;
		return base64;
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

export async function getSeenEntries(
	limit = 100,
	offset = 0,
	filter?: SeenFilter,
	thumbnails = true,
): Promise<SeenEntry[]> {
	const result = await cmd.storeSeenList(limit, offset, filter ?? null, thumbnails);
	return result;
}

export async function getSeenCount(filter?: SeenFilter): Promise<number> {
	return cmd.storeSeenCount(filter ?? null);
}

export async function getSeenCountries(): Promise<string[]> {
	return cmd.storeSeenCountries();
}

export async function getSeenMaps(): Promise<{ id: string; name: string }[]> {
	return cmd.storeSeenMaps();
}

export async function clearSeen(): Promise<void> {
	await cmd.storeSeenClear();
}
