import { LocationFlag } from "@/types";
import { createSyncController } from "@/lib/sync/controller";
import type { NormalizedSyncLocation } from "@/lib/sync/normalized";
import type { PushedId, RemoteMapSummary, RemoteSnapshot, SyncProvider } from "@/lib/sync/provider";
import { getDraft, listDrafts, putDraftCoordinates } from "./api";
import type { GgCoordinate } from "./remote-types";

export const PLUGIN_ID = "geoguessr";

/** GeoGuessr reads heading 0 as "unset, pick at random", so a genuine north must be nudged. */
const NORTH = 1e-4;

/** A draft refuses to save past this many locations. */
export const MAX_LOCATIONS = 110_000;

const loadsAsPano = (flags: number): boolean => (flags & LocationFlag.LoadAsPanoId) !== 0;

/** Erase the distinctions GeoGuessr's wire format cannot hold. Applied to both sides. */
function project(loc: NormalizedSyncLocation): NormalizedSyncLocation {
	const panoId = loadsAsPano(loc.flags) ? loc.panoId : null;
	return {
		...loc,
		panoId,
		flags: panoId ? LocationFlag.LoadAsPanoId : LocationFlag.None,
		tags: [],
	};
}

/**
 * GeoGuessr sync.
 *
 * Two things make this different from a conventional REST sync, and they drive every decision
 * below:
 *  - **Locations have no ids.** A draft is an ordered array that is replaced wholesale. Since we
 *    write that array, its index is the closest thing to a handle, so `identity` is `positional`
 *    and the core realigns by content hash whenever an index no longer holds.
 *  - **The wire format is lossy.** No tags, and no way to say "keep the panoId but don't load by
 *    it". {@link project} erases exactly those distinctions on the local side too, so they never
 *    read as a difference.
 */
export const geoguessrProvider: SyncProvider<GgCoordinate> = {
	id: "geoguessr",
	label: "GeoGuessr",
	identity: "positional",
	supportsTags: false,

	remoteIdOf: (_item, index) => index,

	async listMaps(signal) {
		const drafts = await listDrafts(signal);
		return drafts.map(
			(m): RemoteMapSummary => ({
				id: m.id,
				name: m.name,
				locationCount: m.coordinateCount ?? null,
				// Polygonal maps have regions instead of a coordinate list; there is nothing to sync.
				unsupported: m.mode === "regions" ? "Polygonal map" : undefined,
			}),
		);
	},

	async pull(remoteMapId, signal): Promise<RemoteSnapshot<GgCoordinate>> {
		const draft = await getDraft(remoteMapId, signal);
		if (draft.mode === "regions")
			throw new Error("This GeoGuessr map is polygonal and cannot be synced.");
		return { locations: draft.coordinates ?? [], token: draft.version };
	},

	async push(remoteMapId, batch, token, signal): Promise<PushedId[]> {
		if (batch.desired.length > MAX_LOCATIONS)
			throw new Error(
				`GeoGuessr maps cap at ${MAX_LOCATIONS.toLocaleString()} locations; this sync would write ${batch.desired.length.toLocaleString()}.`,
			);
		if (typeof token !== "number") throw new Error("missing draft version");

		await putDraftCoordinates(
			remoteMapId,
			{
				mode: "coordinates",
				version: token + 1,
				customCoordinates: batch.desired.map((d) => d.item),
			},
			signal,
		);

		// Rewriting the document reindexes everything, so report a handle for every entry we wrote,
		// not just the ones that changed.
		const pushed: PushedId[] = [];
		batch.desired.forEach((d, index) => {
			if (d.localId !== null) pushed.push({ localId: d.localId, remoteId: index });
		});
		return pushed;
	},

	normalize(item) {
		return project({
			lat: item.lat,
			lng: item.lng,
			// Undo the north nudge so a round trip is stable. 1e-4 degrees is ~1cm of bearing,
			// far below anything a user set deliberately.
			heading: item.heading === NORTH ? 0 : item.heading,
			pitch: item.pitch,
			zoom: item.zoom,
			panoId: item.panoId,
			flags: item.panoId ? LocationFlag.LoadAsPanoId : LocationFlag.None,
			tags: [],
		});
	},

	project,

	// Informational pins are editor annotations, not places to guess.
	includeLocal: (loc) => (loc.flags & LocationFlag.Informational) === 0,

	materialize(loc): GgCoordinate {
		return {
			lat: loc.lat,
			lng: loc.lng,
			heading: loc.heading === 0 ? NORTH : loc.heading,
			pitch: loc.pitch,
			zoom: loc.zoom,
			panoId: loadsAsPano(loc.flags) ? loc.panoId : null,
		};
	},
};

export const controller = createSyncController(geoguessrProvider, PLUGIN_ID);
