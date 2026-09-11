import { isAuthPrefixed, type RemoteMapSummary, type SyncProvider } from "@/lib/sync/provider";

export const PLUGIN_ID = "map-making-sync";

export const mapMakingProvider: SyncProvider = {
	id: "map-making.app",
	label: "map-making.app",

	isAuthError: isAuthPrefixed,

	remoteMapUrl: (id) => `https://map-making.app/maps/${id}`,

	listMaps: (): Promise<RemoteMapSummary[]> => window.MMA.cmd.mapMakingMaps(),
};
