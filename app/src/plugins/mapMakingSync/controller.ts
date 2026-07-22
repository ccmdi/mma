import { createSyncController } from "@/lib/sync/controller";
import type { RemoteMapSummary } from "@/lib/sync/provider";
import type { Remote } from "./map-making-web-api";
import { createApi, mapMakingProvider, PLUGIN_ID } from "./provider";

export { getApiKey, setApiKey } from "./provider";

/** Link, sync and the live loop. Everything below is the API-key auth surface, which is ours. */
export const controller = createSyncController(mapMakingProvider, PLUGIN_ID);

// Cache the validated identity so reopening the sidebar is instant. The map list is not cached
// here -- the shared sidebar fetches it on demand.
let cachedUser: Remote.User | null = null;
export const getCachedUser = (): Remote.User | null => cachedUser;

/** Drop the cached identity (on key change). */
export const forgetAuth = (): void => {
	cachedUser = null;
};

/** Validate `key` (default: the stored one) without persisting it; caller stores on success. */
export async function validate(key?: string): Promise<Remote.User> {
	cachedUser = await createApi(key).getUser();
	return cachedUser;
}

export const listMaps = (): Promise<RemoteMapSummary[]> => mapMakingProvider.listMaps();
