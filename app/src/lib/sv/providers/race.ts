/**
 * Parallel inject-provider resolution: first success wins, losers become
 * date-picker alternates (no catalog priority between racers).
 */
import type { Location } from "@/bindings.gen";
import { log } from "@/lib/util/log";
import { addLocations, setActiveLocation } from "@/store/useMapStore";
import { rememberInjectAlternate } from "./alternates";
import {
	ensureBuiltinInjectAdapters,
	getRaceableInjectAdapters,
	type InjectRaceHit,
} from "./injectAdapters";

export { isInjectProviderId, isChinaProviderId } from "./injectAdapters";

async function resolveOne(
	adapterId: string,
	lat: number,
	lng: number,
	radiusM?: number,
): Promise<InjectRaceHit | null> {
	ensureBuiltinInjectAdapters();
	const adapter = getRaceableInjectAdapters().find((a) => a.id === adapterId);
	if (!adapter?.resolveNear) return null;
	try {
		return await adapter.resolveNear(lat, lng, radiusM);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		log.warn(`[${adapterId}] search failed:`, msg);
		return null;
	}
}

/**
 * Race enabled inject providers that expose resolveNear.
 * Returns the first hit that succeeds and schedules losers into alternates.
 */
export async function raceInjectProvidersNear(
	lat: number,
	lng: number,
	radiusM?: number,
): Promise<InjectRaceHit | null> {
	ensureBuiltinInjectAdapters();
	const adapters = getRaceableInjectAdapters().filter(
		(a) => !a.supportsAt || a.supportsAt(lng, lat),
	);
	if (adapters.length === 0) return null;
	if (adapters.length === 1) {
		return resolveOne(adapters[0]!.id, lat, lng, radiusM);
	}

	const tasks = adapters.map((a) => resolveOne(a.id, lat, lng, radiusM));
	const winner = await new Promise<InjectRaceHit | null>((resolve) => {
		let pending = tasks.length;
		let settled = false;
		for (const task of tasks) {
			void task.then((hit) => {
				pending -= 1;
				if (hit && !settled) {
					settled = true;
					resolve(hit);
				} else if (pending === 0 && !settled) {
					resolve(null);
				}
			});
		}
	});

	if (!winner) return null;

	void Promise.all(tasks).then((results) => {
		for (const hit of results) {
			if (!hit || hit.provider === winner.provider) continue;
			const alt = hit.toAlternate();
			rememberInjectAlternate({ ...alt, lat, lng });
			rememberInjectAlternate({
				...alt,
				lat: winner.lat,
				lng: winner.lng,
			});
		}
	});

	return winner;
}

/** @deprecated Use raceInjectProvidersNear */
export const raceChinaNear = raceInjectProvidersNear;

/** Blank-map click: race inject providers and create a location from the winner. */
export async function createInjectProviderLocationAtLatLng(
	lat: number,
	lng: number,
): Promise<Location | null> {
	const hit = await raceInjectProvidersNear(lat, lng);
	if (!hit) return null;
	const loc = hit.toLocation();
	await addLocations([loc], { hideInDelta: true });
	setActiveLocation(loc);
	return loc;
}

/** @deprecated Use createInjectProviderLocationAtLatLng */
export const createChinaLocationAtLatLng = createInjectProviderLocationAtLatLng;
