import { canonTags, remoteFlags, type NormalizedSyncLocation } from "@/lib/sync/normalized";
import type {
	PushBatch,
	PushedId,
	RemoteMapSummary,
	RemoteSnapshot,
	SyncProvider,
} from "@/lib/sync/provider";
import { MapMakingWebApi } from "./map-making-web-api";
import * as Remote from "./remote-types";

export const PLUGIN_ID = "map-making-sync";

const kv = () => window.MMA.storage(PLUGIN_ID);

export const getApiKey = (): string => kv().get<string>("apiKey", "");
export const setApiKey = (key: string): void => kv().set("apiKey", key.trim());

export const createApi = (): MapMakingWebApi => new MapMakingWebApi({ apiKey: getApiKey() });

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
		_token: unknown,
		signal?: AbortSignal,
	): Promise<PushedId[]> {
		const create: Remote.LocationInput[] = [];
		const remove: number[] = [];
		const created: { localId: number; negId: number }[] = [];
		let neg = -1;

		const stage = (localId: number, item: Remote.Location) => {
			const negId = neg--;
			create.push(toInput(item, negId));
			created.push({ localId, negId });
		};

		for (const e of batch.create) stage(e.localId, e.item);
		// A remote id churns on edit, so an update is remove-old + create-new.
		for (const e of batch.update) {
			remove.push(e.replaces.id);
			stage(e.localId, e.item);
		}
		for (const item of batch.delete) remove.push(item.id);
		if (!create.length && !remove.length) return [];

		const remap = await createApi().editLocations(
			Number(remoteMapId),
			{ edits: [{ action: { type: Remote.EditActionType.Bulk }, create, remove }] },
			signal,
		);

		const pushed: PushedId[] = [];
		for (const { localId, negId } of created) {
			const remoteId = remap[String(negId)];
			if (remoteId !== undefined) pushed.push({ localId, remoteId });
		}
		return pushed;
	},
};
