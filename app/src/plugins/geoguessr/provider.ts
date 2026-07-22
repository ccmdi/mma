import { createSyncController } from "@/lib/sync/controller";
import { isAuthPrefixed, type SyncProvider } from "@/lib/sync/provider";
import { listDrafts, listPublished } from "./api";

export const PLUGIN_ID = "geoguessr";

export const geoguessrProvider: SyncProvider = {
	id: "geoguessr",
	label: "GeoGuessr",

	isAuthError: isAuthPrefixed,

	remoteMapUrl: (id) => `https://www.geoguessr.com/map-maker/${id}`,

	async listMaps(signal) {
		const [drafts, published] = await Promise.all([listDrafts(signal), listPublished(signal)]);
		const linkable = drafts.map((m) => ({
			id: m.slug,
			name: m.name,
			// The drafts list omits coordinates entirely, so a count would cost one request per map.
			locationCount: null,
			// Polygonal maps have regions instead of a coordinate list; there is nothing to sync.
			unsupported: m.mode === "regions" ? "Polygonal map" : undefined,
		}));

		// Sync writes the draft, so a map without one has nothing to write to. Surface those as
		// visibly unlinkable rather than omitting them, or an older map just looks missing.
		const haveDrafts = new Set(drafts.map((d) => d.slug));
		const draftless = published
			.filter((m) => !haveDrafts.has(m.slug))
			.map((m) => ({
				id: m.slug,
				name: m.name,
				locationCount: null,
				unsupported: "No draft yet - open it once in GeoGuessr's map maker",
			}));

		return [...linkable, ...draftless];
	},
};

export const controller = createSyncController(geoguessrProvider, PLUGIN_ID);
