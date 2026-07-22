import { canonTags, remoteFlags, type NormalizedSyncLocation } from "@/lib/sync/normalized";
import type {
	PushBatch,
	PushContext,
	PushedId,
	RemoteMapSummary,
	RemoteSnapshot,
	SyncProvider,
} from "@/lib/sync/provider";
import { MapMakingWebApi, MapMakingWebApiError } from "./map-making-web-api";
import * as Remote from "./remote-types";

export const PLUGIN_ID = "map-making-sync";

const kv = () => window.MMA.storage(PLUGIN_ID);

export const getApiKey = (): string => kv().get<string>("apiKey", "");
export const setApiKey = (key: string): void => kv().set("apiKey", key.trim());

export const createApi = (apiKey?: string): MapMakingWebApi =>
	new MapMakingWebApi({ apiKey: apiKey ?? getApiKey() });

/** Ops per edit request; not a server limit. */
const PUSH_CHUNK = 200_000;

/** Write shape from the read shape. `id` is assigned by the caller (negative placeholder). */
const toInput = (item: Remote.Location, id: number): Remote.LocationInput => ({
	id,
	location: item.location,
	panoId: item.panoId,
	heading: item.heading,
	pitch: item.pitch,
	zoom: item.zoom,
	flags: item.flags,
	tags: item.tags,
});

export const mapMakingProvider: SyncProvider<Remote.Location> = {
	id: "map-making.app",
	label: "map-making.app",
	identity: "stable",
	supportsTags: true,

	isAuthError: (e) => e instanceof MapMakingWebApiError && e.status === 401,

	remoteIdOf: (item) => item.id,

	normalize: (item): NormalizedSyncLocation => ({
		lat: item.location.lat,
		lng: item.location.lng,
		heading: item.heading,
		pitch: item.pitch,
		zoom: item.zoom ?? 0,
		panoId: item.panoId,
		flags: remoteFlags(item.flags),
		tags: canonTags(item.tags),
	}),

	// id/createdAt are server-owned: push overwrites the id and never sends createdAt.
	// id 0 means "not yet assigned by the server"; `push` swaps in a negative placeholder.
	materialize: (loc): Remote.Location => ({
		id: 0,
		location: { lat: loc.lat, lng: loc.lng },
		panoId: loc.panoId,
		heading: loc.heading,
		pitch: loc.pitch,
		zoom: loc.zoom,
		flags: loc.flags,
		tags: loc.tags,
	}),

	async listMaps(signal?: AbortSignal): Promise<RemoteMapSummary[]> {
		const maps = await createApi().getMaps(signal);
		return maps
			.filter((m) => m.archivedAt == null)
			.map((m) => ({ id: String(m.id), name: m.name, locationCount: m.locationCount }));
	},

	async pull(remoteMapId: string, signal?: AbortSignal): Promise<RemoteSnapshot<Remote.Location>> {
		return { locations: await createApi().getLocationsProtobuf(Number(remoteMapId), signal) };
	},

	async push(
		remoteMapId: string,
		batch: PushBatch<Remote.Location>,
		ctx: PushContext,
	): Promise<PushedId[]> {
		const api = createApi();
		const mapId = Number(remoteMapId);
		const all: PushedId[] = [];

		for (const part of splitPush(batch, PUSH_CHUNK)) {
			const remap = await api.editLocations(
				mapId,
				{
					edits: [
						{
							action: { type: Remote.EditActionType.Bulk },
							create: part.create,
							remove: part.remove,
						},
					],
				},
				ctx.signal,
			);

			const pushed: PushedId[] = [];
			for (const { localId, negId } of part.staged) {
				const remoteId = remap[String(negId)];
				if (remoteId !== undefined) pushed.push({ localId, remoteId });
			}
			all.push(...pushed);
			// Let the engine persist this chunk before the next one can fail.
			if (pushed.length) await ctx.onProgress?.(pushed);
		}
		return all;
	},
};

export interface PushPart {
	create: Remote.LocationInput[];
	remove: number[];
	staged: { localId: number; negId: number }[];
}

/**
 * Split a push into edit requests of at most `chunk` operations.
 *
 * An update is remove-old + create-new (a remote id churns on edit), and both halves must stay in
 * the SAME request: splitting them would leave the location duplicated on the remote in between.
 * So chunking counts logical operations, not the two arrays independently.
 */
export function splitPush(batch: PushBatch<Remote.Location>, chunk: number): PushPart[] {
	let neg = -1;
	const ops = [
		...batch.create.map((e) => ({ localId: e.localId, item: e.item, remove: undefined })),
		...batch.update.map((e) => ({ localId: e.localId, item: e.item, remove: e.replaces.id })),
		...batch.delete.map((item) => ({ localId: undefined, item: undefined, remove: item.id })),
	];

	const parts: PushPart[] = [];
	for (let i = 0; i < ops.length; i += chunk) {
		const part: PushPart = { create: [], remove: [], staged: [] };
		for (const op of ops.slice(i, i + chunk)) {
			if (op.remove !== undefined) part.remove.push(op.remove);
			if (op.item !== undefined && op.localId !== undefined) {
				const negId = neg--;
				part.create.push(toInput(op.item, negId));
				part.staged.push({ localId: op.localId, negId });
			}
		}
		parts.push(part);
	}
	return parts;
}
