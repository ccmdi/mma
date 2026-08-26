import type {
	Conflict,
	FirstSyncMode,
	Location,
	LocationPatch_Deserialize,
	NormalizedSyncLocation,
	SideCounts,
	SyncPatch,
	Update,
} from "@/bindings.gen";
import type { SyncProvider } from "./provider";
import type { IdentityKey, RemoteMappingRow, SyncStore } from "./syncStore";

export type { FirstSyncMode } from "@/bindings.gen";

export interface SyncOutcome {
	pushed: SideCounts;
	pulled: SideCounts;
	adopted: number;
	conflicts: Conflict[];
}

export interface ReconcileOptions {
	firstSync?: FirstSyncMode;
	signal?: AbortSignal;
	/** User-picked winner per conflicted key. Resolved keys leave `conflicts` and become applies. */
	resolutions?: ReadonlyMap<IdentityKey, "local" | "remote">;
}

/** Resolve a remote tag name to a local tag id, or `undefined` when the map has no such tag. */
type TagId = (name: string) => number | undefined;

/** Project a normalized location onto our local columns, resolving tag names to local ids. */
function fieldsToLocal(
	n: NormalizedSyncLocation,
	tagId: TagId,
): Partial<Location> & { lat: number; lng: number } {
	return {
		lat: n.lat,
		lng: n.lng,
		heading: n.heading,
		pitch: n.pitch,
		zoom: n.zoom,
		panoId: n.panoId,
		flags: n.flags,
		tags: n.tags.map(tagId).filter((id): id is number => id != null),
	};
}

/** Build a local patch from a remote-originated `SyncPatch`, resolving tag names to ids. */
function patchToLocal(p: SyncPatch, tagId: TagId): LocationPatch_Deserialize {
	const patch: LocationPatch_Deserialize = {};
	if (p.lat !== null) patch.lat = p.lat;
	if (p.lng !== null) patch.lng = p.lng;
	if (p.heading !== null) patch.heading = p.heading;
	if (p.pitch !== null) patch.pitch = p.pitch;
	if (p.zoom !== null) patch.zoom = p.zoom;
	if (p.panoIdSet) patch.panoId = p.panoId;
	if (p.flags !== null) patch.flags = p.flags;
	if (p.tags !== null) patch.tags = p.tags.map(tagId).filter((id): id is number => id != null);
	return patch;
}

/**
 * One reconcile pass for a linked, open map. The whole merge (pull, normalize, three-way diff,
 * push, and the push half's mapping rows) runs in Rust via `syncReconcile`; this applies the
 * pull half to the local store and advances the link.
 */
export async function reconcile(
	provider: SyncProvider,
	store: SyncStore,
	opts: ReconcileOptions = {},
): Promise<SyncOutcome> {
	const M = window.MMA;
	const { signal } = opts;
	const link = store.getLink();
	if (!link) throw new Error("map is not linked");

	/** The linked map must still be the open one everywhere we touch the local store. */
	const assertStillOpen = () => {
		if (signal?.aborted) throw new DOMException("sync aborted", "AbortError");
		const open = M.getMapState().map;
		if (!open || open.id !== link.localMapId) throw new Error("linked map is no longer open");
		return open;
	};

	assertStillOpen();

	const result = await M.cmd.syncReconcile(
		provider.id,
		link.localMapId,
		link.remoteMapId,
		provider.credential?.() ?? null,
		opts.firstSync ?? null,
		opts.resolutions ? [...opts.resolutions.entries()] : null,
	);

	// The command is not abortable; it has already pushed and written the push half's mapping rows.
	// An abort now just skips the pull applies - the persisted mapping stays consistent regardless.
	assertStillOpen();
	const nameToId = new Map<string, number>();
	for (const t of Object.values(M.getMapState().tags)) nameToId.set(t.name, t.id);

	// Create any local tags the incoming pulls reference, then resolve names -> ids.
	if (result.neededTags.length) {
		assertStillOpen();
		for (const t of await M.createTags(result.neededTags)) nameToId.set(t.name, t.id);
	}
	const tagId: TagId = (name) => nameToId.get(name);

	if (result.pullCreates.length) {
		assertStillOpen();
		const newLocals: Location[] = result.pullCreates.map((c) =>
			M.createLocation(fieldsToLocal(c.fields, tagId)),
		);
		await M.addLocations(newLocals); // assigns real ids in place
		const rows: RemoteMappingRow[] = result.pullCreates.map((c, i) => ({
			localId: newLocals[i]!.id,
			remoteId: c.remoteId,
			hash: c.hash,
		}));
		await store.upsertMapping(rows);
	}

	const updates: Update<LocationPatch_Deserialize>[] = [];
	for (const u of result.pullUpdates) {
		const patch = patchToLocal(u.patch, tagId);
		if (Object.keys(patch).length) updates.push({ id: u.localId, patch });
	}
	if (updates.length) {
		assertStillOpen();
		await M.updateLocations(updates);
	}

	const removals = new Set<number>([...result.pullDeleteIds, ...result.mirrorLocalDeleteIds]);
	if (removals.size) {
		assertStillOpen();
		await M.removeLocations(removals);
	}

	store.setLink({ ...link, lastSyncedAt: new Date().toISOString() });

	return {
		pushed: result.pushed,
		pulled: result.pulled,
		adopted: result.adopted,
		conflicts: result.conflicts,
	};
}
