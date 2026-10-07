import type { Conflict, Location, NormalizedSyncLocation, SideCounts } from "@/bindings.gen";
import type { Patch } from "@/types";
import type { FirstSyncMode } from "@/bindings.consts";
import type { SyncProvider } from "./provider";
import type { IdentityKey, RemoteMappingRow, SyncStore } from "./syncStore";

export type { FirstSyncMode } from "@/bindings.consts";

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
		extra: n.extra,
	};
}

/** A remote-originated patch as a local one, its tag names resolved to ids. */
function patchToLocal(
	{ tags, ...patch }: Partial<NormalizedSyncLocation>,
	tagId: TagId,
): Partial<Location> {
	return tags
		? { ...patch, tags: tags.map(tagId).filter((id): id is number => id != null) }
		: patch;
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
		opts.firstSync ?? null,
		opts.resolutions ? [...opts.resolutions.entries()] : null,
	);

	// The command is not abortable; it has already pushed and written the push half's mapping rows.
	// Each pull's mapping row is written only after that pull applies, so an abort leaves it pending.
	assertStillOpen();
	const nameToId = new Map<string, number>();
	for (const t of Object.values(M.getTags())) nameToId.set(t.name, t.id);

	// Create any local tags the incoming pulls reference, then resolve names -> ids.
	// A tag the sync creates adopts the source's color; an existing tag keeps its own.
	if (result.neededTags.length) {
		assertStillOpen();
		const existing = new Set(nameToId.values());
		const created = await M.createTags(result.neededTags.map((t) => t.name));
		for (const t of created) nameToId.set(t.name, t.id);
		const color = new Map(result.neededTags.map((t) => [t.name, t.color]));
		const recolors = created
			.filter((t) => !existing.has(t.id) && color.get(t.name) != null)
			.map((t) => ({ id: t.id, color: color.get(t.name)! }));
		if (recolors.length) await M.updateTags(recolors);
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

	const updates: Patch<Location>[] = [];
	for (const u of result.pullUpdates) {
		const patch = patchToLocal(u.patch, tagId);
		if (Object.keys(patch).length) updates.push({ ...patch, id: u.localId });
	}
	if (updates.length) {
		assertStillOpen();
		await M.updateLocations(updates);
	}
	if (result.pullUpdates.length) {
		await store.upsertMapping(
			result.pullUpdates.map((u) => ({ localId: u.localId, remoteId: u.remoteId, hash: u.hash })),
		);
	}

	const removals = new Set<number>([...result.pullDeleteIds, ...result.mirrorLocalDeleteIds]);
	if (removals.size) {
		assertStillOpen();
		await M.removeLocations(removals);
	}
	if (result.pullDeleteIds.length) await store.deleteMapping(result.pullDeleteIds);

	store.setLink({ ...link, lastSyncedAt: new Date().toISOString() });

	return {
		pushed: result.pushed,
		pulled: result.pulled,
		adopted: result.adopted,
		conflicts: result.conflicts,
	};
}
