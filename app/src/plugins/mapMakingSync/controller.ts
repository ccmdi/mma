import { createSyncController } from "@/lib/sync/controller";
import type { MmUser } from "@/bindings.gen";
import type { RemoteMapSummary } from "@/lib/sync/provider";
import { mapMakingProvider, PLUGIN_ID } from "./provider";

/** Link, sync and the live loop. Everything below is the API-key auth surface, which is ours. */
export const controller = createSyncController(mapMakingProvider, PLUGIN_ID);

// Cache the validated identity so reopening the sidebar is instant. The map list is not cached
// here -- the shared sidebar fetches it on demand.
let cachedUser: MmUser | null = null;
export const getCachedUser = (): MmUser | null => cachedUser;

// The key itself lives in the OS credential store and never reaches JS; only its presence does,
// tracked here so the sidebar can decide what to show without an await.
let keyPresent = false;
export const hasKey = (): boolean => keyPresent;

/** Drop the cached identity (on key change). */
export const forgetAuth = (): void => {
	cachedUser = null;
};

/** Validate `key` without persisting it; caller stores on success. */
export async function validate(key: string): Promise<MmUser> {
	cachedUser = await window.MMA.cmd.mapMakingValidate(key.trim());
	return cachedUser;
}

/** The signed-in account for the stored key, or `null` when no key is stored. */
export async function me(): Promise<MmUser | null> {
	cachedUser = await window.MMA.cmd.mapMakingMe();
	return cachedUser;
}

export async function setKey(key: string): Promise<void> {
	const trimmed = key.trim();
	await window.MMA.cmd.mapMakingSetKey(trimmed || null);
	keyPresent = !!trimmed;
}

/**
 * Adopt a key left in plugin storage by an older build, then forget it there. One-way and
 * silent: the credential store wins whenever it already holds one.
 */
export async function adoptStoredKey(): Promise<void> {
	const kv = window.MMA.storage(PLUGIN_ID);
	const legacy = kv.get<string>("apiKey", "").trim();
	keyPresent = await window.MMA.cmd.mapMakingHasKey();
	if (!keyPresent && legacy) await setKey(legacy);
	if (kv.get<string>("apiKey", "")) kv.remove("apiKey");
}

export const listMaps = (): Promise<RemoteMapSummary[]> => mapMakingProvider.listMaps();
