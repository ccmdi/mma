import { isAuthPrefixed, type RemoteMapSummary, type SyncProvider } from "@/lib/sync/provider";
import { MapMakingWebApi } from "./map-making-web-api";

export const PLUGIN_ID = "map-making-sync";

const kv = () => window.MMA.storage(PLUGIN_ID);

export const getApiKey = (): string => kv().get<string>("apiKey", "");
export const setApiKey = (key: string): void => kv().set("apiKey", key.trim());

export const createApi = (apiKey?: string): MapMakingWebApi =>
	new MapMakingWebApi({ apiKey: apiKey ?? getApiKey() });

export const mapMakingProvider: SyncProvider = {
	id: "map-making.app",
	label: "map-making.app",

	credential: getApiKey,
	isAuthError: isAuthPrefixed,

	remoteMapUrl: (id) => `https://map-making.app/maps/${id}`,

	async listMaps(signal?: AbortSignal): Promise<RemoteMapSummary[]> {
		const maps = await createApi().getMaps(signal);
		return maps
			.filter((m) => m.archivedAt == null)
			.map((m) => ({ id: String(m.id), name: m.name, locationCount: m.locationCount }));
	},
};
