import { LocationFlag } from "@/types";
import { createSyncController } from "@/lib/sync/controller";
import type { NormalizedSyncLocation } from "@/lib/sync/normalized";
import type { PushedId, RemoteMapSummary, RemoteSnapshot, SyncProvider } from "@/lib/sync/provider";
import { getDraft, isUnauthorized, listDrafts, listPublished, putDraftCoordinates } from "./api";
import type { GgCoordinate } from "./remote-types";

export const PLUGIN_ID = "geoguessr";

/** GeoGuessr reads heading 0 as "unset, pick at random", so a genuine north must be nudged. */
const NORTH = 1e-4;

/**
 * A draft is stored as a single MongoDB document, so a write is accepted iff the STORED
 * document's BSON size fits Mongo's 16 MiB limit. Request body size and location count are
 * irrelevant (a 24.7 MiB JSON body of the same BSON size is accepted). Measured live at
 * single-pin precision on four payload shapes; `TooManyCoordinates` only fires above the
 * driver's 16 MiB + 16 KiB serialization allowance, and writes between the two limits fail
 * as bare 500s.
 */
const BSON_DOC_LIMIT = 16_777_216;

/** Headroom for the rest of the stored draft (name, description, avatar, tags, ~300B measured). */
const DRAFT_METADATA_MARGIN = 64 * 1024;

const utf8 = new TextEncoder();
// BSON string element: type + key + NUL + int32 length + bytes + NUL. Null is stored for
// panoId (type + key + NUL) but DROPPED for the geocode fields; both behaviors are measured.
const strElem = (key: string, v: string): number => key.length + 7 + utf8.encode(v).length;

/** BSON size of the coordinate array exactly as GeoGuessr stores it. */
export function storedBsonSize(coords: GgCoordinate[]): number {
	let size = 5;
	for (let i = 0; i < coords.length; i++) {
		const c = coords[i]!;
		// 77 = pin doc wrapper + the five always-present doubles with their keys
		let pin = 77 + (c.panoId == null ? 8 : strElem("panoId", c.panoId));
		if (c.countryCode != null) pin += strElem("countryCode", c.countryCode);
		if (c.stateCode != null) pin += strElem("stateCode", c.stateCode);
		if (c.cityCode != null) pin += strElem("cityCode", c.cityCode);
		size += 2 + String(i).length + pin;
	}
	return size;
}

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

	isAuthError: isUnauthorized,

	remoteMapUrl: (id) => `https://www.geoguessr.com/map-maker/${id}`,

	remoteIdOf: (_item, index) => index,

	async listMaps(signal) {
		const [drafts, published] = await Promise.all([listDrafts(signal), listPublished(signal)]);
		const linkable = drafts.map(
			(m): RemoteMapSummary => ({
				id: m.slug,
				name: m.name,
				// The drafts list omits coordinates entirely, so a count would cost one request per map.
				locationCount: null,
				// Polygonal maps have regions instead of a coordinate list; there is nothing to sync.
				unsupported: m.mode === "regions" ? "Polygonal map" : undefined,
			}),
		);

		// Sync writes the draft, so a map without one has nothing to write to. Surface those as
		// visibly unlinkable rather than omitting them, or an older map just looks missing.
		const haveDrafts = new Set(drafts.map((d) => d.slug));
		const draftless = published
			.filter((m) => !haveDrafts.has(m.slug))
			.map(
				(m): RemoteMapSummary => ({
					id: m.slug,
					name: m.name,
					locationCount: null,
					unsupported: "No draft yet - open it once in GeoGuessr's map maker",
				}),
			);

		return [...linkable, ...draftless];
	},

	async pull(remoteMapId, signal): Promise<RemoteSnapshot<GgCoordinate>> {
		const draft = await getDraft(remoteMapId, signal);
		if (draft.mode === "regions")
			throw new Error("This GeoGuessr map is polygonal and cannot be synced.");
		return { locations: draft.coordinates ?? [], token: draft.version };
	},

	async push(remoteMapId, batch, ctx): Promise<PushedId[]> {
		if (typeof ctx.token !== "number") throw new Error("missing draft version");

		// A draft is replaced whole, so there is no chunking available here: it either fits or the
		// map cannot be synced to GeoGuessr at all.
		const body = {
			mode: "coordinates" as const,
			version: ctx.token + 1,
			customCoordinates: batch.desired.map((d) => d.item),
		};
		const stored = storedBsonSize(body.customCoordinates);
		if (stored > BSON_DOC_LIMIT - DRAFT_METADATA_MARGIN)
			throw new Error(
				`Too large for a GeoGuessr draft (stores as ${(stored / 1048576).toFixed(1)} MiB; the limit is 16 MiB).`,
			);

		await putDraftCoordinates(remoteMapId, body, ctx.signal);

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
