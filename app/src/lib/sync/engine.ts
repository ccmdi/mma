import type { Location, Update, LocationPatch_Deserialize } from "@/bindings.gen";
import {
	changedLocalFields,
	normalizedToLocalFields,
	syncHash,
	type NormalizedSyncLocation,
	type TagId,
	type TagName,
} from "./normalized";
import { computeSyncPlan, summarize, type Conflict, type IdentityKey, type SyncPlan } from "./diff";
import { buildKeyedInputs, type KeyedInputs } from "./keying";
import type { DesiredEntry, PushBatch, SyncProvider } from "./provider";
import type { RemoteMappingRow, SyncStore } from "./syncStore";

export interface SyncOutcome {
	pushed: { create: number; update: number; delete: number };
	pulled: { create: number; update: number; delete: number };
	adopted: number;
	conflicts: Conflict[];
}

/**
 * First-sync seeding when both sides already have pins:
 *  - `merge`            keep everything (union); never deletes. The default.
 *  - `mirrorFromRemote` remote wins: pull remote-only in, DELETE local-only pins.
 *  - `mirrorFromLocal`  local wins: push local-only up, DELETE remote-only pins.
 * Only meaningful on the first sync (empty mapping); afterwards it's plain three-way.
 */
export type FirstSyncMode = "merge" | "mirrorFromRemote" | "mirrorFromLocal";

const parseLocalId = (key: IdentityKey): number | null =>
	key.startsWith("L:") ? Number(key.slice(2)) : null;

export interface ReconcileOptions {
	firstSync?: FirstSyncMode;
	signal?: AbortSignal;
	/** User-picked winner per conflicted key. Resolved keys leave `conflicts` and become applies. */
	resolutions?: ReadonlyMap<IdentityKey, "local" | "remote">;
}

/**
 * One reconcile pass for a linked, open map. Pulls the remote, reads local, three-way diffs, and
 * applies both directions: pulls through the store primitives, pushes through the provider, then
 * rewrites the mapping from what the push resolved and advances the base. Conflicts are collected
 * and returned, not applied (review policy). No location content is persisted - only the
 * `{localId, remoteId, hash}` index.
 */
export async function reconcile<R>(
	provider: SyncProvider<R>,
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
		const open = M.getCurrentMap();
		if (!open || open.meta.id !== link.localMapId) throw new Error("linked map is no longer open");
		return open;
	};

	// Both directions of the tag lookup are kept locally rather than read back off the map, so a
	// push later in this pass still sees tags that `createTags` added earlier in it.
	const map = assertStillOpen();
	const nameToId = new Map<string, number>();
	const idToName = new Map<number, string>();
	for (const t of Object.values(map.meta.tags)) {
		nameToId.set(t.name, t.id);
		idToName.set(t.id, t.name);
	}
	const tagName: TagName = (id) => idToName.get(id);

	const [localLocs, snapshot, mapping] = await Promise.all([
		M.fetchAllLocations(),
		provider.pull(link.remoteMapId, signal),
		store.getMapping(),
	]);

	const keyed = buildKeyedInputs(provider, localLocs, snapshot.locations, mapping, tagName);
	const plan = computeSyncPlan(keyed.base, keyed.local, keyed.remote);

	// Resolved conflicts become ordinary applies on the losing side, so the key advances its base
	// instead of re-conflicting on every subsequent poll.
	if (opts.resolutions?.size) {
		const resolved = new Set<IdentityKey>();
		for (const c of plan.conflicts) {
			const side = opts.resolutions.get(c.key);
			if (!side) continue;
			resolved.add(c.key);
			const [winner, loser] =
				side === "local" ? [keyed.local, keyed.remote] : [keyed.remote, keyed.local];
			const target = side === "local" ? plan.push : plan.pull;
			if (!winner.has(c.key)) target.delete.push(c.key);
			else target[loser.has(c.key) ? "update" : "create"].push(c.key);
		}
		plan.conflicts = plan.conflicts.filter((c) => !resolved.has(c.key));
	}

	// Mirror seeding (first sync only): reinterpret one side's create-on-the-other as a delete on
	// the loser side. `merge` leaves the plan untouched. Only when the base is empty.
	const mode = opts.firstSync ?? "merge";
	const mirrorLocalDeletes: number[] = []; // remote wins -> drop local-only pins locally
	const mirrorRemoteDeletes = new Set<IdentityKey>(); // local wins -> drop remote-only pins remotely
	if (mapping.length === 0 && mode === "mirrorFromRemote") {
		for (const key of plan.push.create) mirrorLocalDeletes.push(keyed.localById.get(key)!.id);
		plan.push.create = [];
	} else if (mapping.length === 0 && mode === "mirrorFromLocal") {
		for (const key of plan.pull.create) mirrorRemoteDeletes.add(key);
		plan.pull.create = [];
	}

	// Create any local tags the incoming pulls reference, then resolve names -> ids.
	if (provider.supportsTags) {
		const needed = new Set<string>();
		for (const key of [...plan.pull.create, ...plan.pull.update]) {
			for (const n of keyed.remote.get(key)?.tags ?? []) if (!nameToId.has(n)) needed.add(n);
		}
		if (needed.size) {
			assertStillOpen();
			for (const t of await M.createTags([...needed])) {
				nameToId.set(t.name, t.id);
				idToName.set(t.id, t.name);
			}
		}
	}
	const tagId: TagId = (name) => nameToId.get(name);

	/**
	 * Post-sync content per key. Seeded from the whole local side, not just the keys the plan
	 * touched: a location neither side changed still needs a mapping row, because a positional
	 * push reindexes it even though nothing about it moved.
	 */
	const settled = new Map<IdentityKey, NormalizedSyncLocation>(keyed.local);
	for (const key of [...plan.pull.create, ...plan.pull.update])
		settled.set(key, keyed.remote.get(key)!);
	// Anything about to disappear locally, or being held for review, gets no row here.
	for (const key of plan.pull.delete) settled.delete(key);
	for (const c of plan.conflicts) settled.delete(c.key);

	/** Key -> the durable local id, filled in as pulls materialize. */
	const localIdOf = new Map<IdentityKey, number>();
	for (const [key, loc] of keyed.localById) localIdOf.set(key, loc.id);

	const deletes: number[] = [];
	const upsertsExtra: RemoteMappingRow[] = [];

	// --- PULL: apply remote-originated changes to the local store ---
	const newLocals: Location[] = [];
	const newKeys: IdentityKey[] = [];
	for (const key of plan.pull.create) {
		newLocals.push(M.createLocation(normalizedToLocalFields(keyed.remote.get(key)!, tagId)));
		newKeys.push(key);
	}
	if (newLocals.length) {
		assertStillOpen();
		await M.addLocations(newLocals); // assigns real ids in place
		newKeys.forEach((key, i) => localIdOf.set(key, newLocals[i]!.id));
	}

	// Patch only what genuinely differs: a field this provider cannot represent shows up as empty
	// on the remote side, and must not overwrite the local value (see `SyncProvider.project`).
	const updates: Update<LocationPatch_Deserialize>[] = [];
	for (const key of plan.pull.update) {
		const patch = changedLocalFields(keyed.local.get(key)!, keyed.remote.get(key)!, tagId);
		if (Object.keys(patch).length) updates.push({ id: localIdOf.get(key)!, patch });
	}
	if (updates.length) {
		assertStillOpen();
		await M.updateLocations(updates);
	}

	const localRemovals = new Set<number>();
	for (const key of plan.pull.delete) {
		const localId = localIdOf.get(key)!;
		localRemovals.add(localId);
		deletes.push(localId);
	}
	for (const id of mirrorLocalDeletes) localRemovals.add(id); // unmapped, no index row to drop
	if (localRemovals.size) {
		assertStillOpen();
		await M.removeLocations(localRemovals);
	}

	// --- PUSH: send local-originated changes through the provider ---
	const batch = buildPushBatch(provider, keyed, plan, mirrorRemoteDeletes, localIdOf, tagName);
	// Remote handles, seeded from what we read and overridden by whatever the push resolved.
	const handleOf = new Map<IdentityKey, number>();
	for (const [key, index] of keyed.remoteIndex) handleOf.set(key, index);

	if (batch.create.length || batch.update.length || batch.delete.length) {
		const pushed = await provider.push(link.remoteMapId, batch, snapshot.token, signal);
		const keyOfLocalId = new Map<number, IdentityKey>();
		for (const [key, id] of localIdOf) keyOfLocalId.set(id, key);
		for (const { localId, remoteId } of pushed) {
			const key = keyOfLocalId.get(localId);
			if (key !== undefined) handleOf.set(key, remoteId);
		}
		// Persist what the push resolved BEFORE anything else can throw. The remote has already
		// moved; a mapping row we fail to write here would re-push and re-pull the same location
		// on every subsequent sync. This write is the commit point for the push half.
		const pushRows = rowsFor(
			pushed.map((p) => keyOfLocalId.get(p.localId)),
			settled,
			localIdOf,
			handleOf,
		);
		if (pushRows.length) await store.upsertMapping(pushRows);
	}

	for (const key of plan.push.delete) {
		const localId = parseLocalId(key);
		if (localId !== null) deletes.push(localId);
	}

	// --- Converged: both sides already agree; adopt/advance the base, no apply ---
	let adopted = 0;
	for (const key of plan.converged) {
		if (settled.has(key) && handleOf.has(key)) adopted++;
		else {
			const localId = parseLocalId(key); // both-deleted -> drop the row
			if (localId !== null) deletes.push(localId);
		}
	}

	// A held-back conflict keeps its BASE hash, so it still reads as a conflict next time -- but it
	// must still take the new remote handle. Otherwise an unrelated push that reindexes a positional
	// provider strands it, and the location we are deliberately holding for review loses its
	// identity entirely.
	for (const c of plan.conflicts) {
		const base = keyed.base.get(c.key);
		const localId = localIdOf.get(c.key);
		const remoteId = handleOf.get(c.key);
		if (base !== undefined && localId !== undefined && remoteId !== undefined)
			upsertsExtra.push({ localId, remoteId, hash: base });
	}

	// Everything the sync settled gets a row, so a positional push that reindexed untouched
	// locations is reflected too.
	const upserts = [...rowsFor([...settled.keys()], settled, localIdOf, handleOf), ...upsertsExtra];
	if (upserts.length) await store.upsertMapping(upserts);
	if (deletes.length) await store.deleteMapping(deletes);
	store.setLink({ ...link, lastSyncedAt: new Date().toISOString() });

	const c = summarize(plan);
	return {
		pushed: { ...c.push, delete: c.push.delete + mirrorRemoteDeletes.size },
		pulled: { ...c.pull, delete: c.pull.delete + mirrorLocalDeletes.length },
		adopted,
		conflicts: plan.conflicts,
	};
}

/** Mapping rows for the keys that have both a local id and a resolved remote handle. */
function rowsFor(
	keys: (IdentityKey | undefined)[],
	settled: Map<IdentityKey, NormalizedSyncLocation>,
	localIdOf: Map<IdentityKey, number>,
	handleOf: Map<IdentityKey, number>,
): RemoteMappingRow[] {
	const rows: RemoteMappingRow[] = [];
	for (const key of keys) {
		if (key === undefined) continue;
		const localId = localIdOf.get(key);
		const remoteId = handleOf.get(key);
		const content = settled.get(key);
		if (localId === undefined || remoteId === undefined || content === undefined) continue;
		rows.push({ localId, remoteId, hash: syncHash(content) });
	}
	return rows;
}

/**
 * Express the remote half of the plan both ways: as a delta, and as the full desired document.
 * Remote locations we aren't touching (unchanged, or held back as conflicts) are carried through
 * verbatim so provider fields we don't model survive a whole-document write.
 */
function buildPushBatch<R>(
	provider: SyncProvider<R>,
	keyed: KeyedInputs<R>,
	plan: SyncPlan,
	mirrorRemoteDeletes: Set<IdentityKey>,
	localIdOf: Map<IdentityKey, number>,
	tagName: TagName,
): PushBatch<R> {
	const create: PushBatch<R>["create"] = [];
	const update: PushBatch<R>["update"] = [];
	const del: R[] = [];
	const replaced = new Map<IdentityKey, R>();

	for (const key of plan.push.create) {
		const item = provider.materialize(keyed.local.get(key)!, tagName);
		create.push({ localId: localIdOf.get(key)!, item });
	}
	for (const key of plan.push.update) {
		const item = provider.materialize(keyed.local.get(key)!, tagName);
		update.push({ localId: localIdOf.get(key)!, item, replaces: keyed.remoteById.get(key)! });
		replaced.set(key, item);
	}

	const dropped = new Set<IdentityKey>([...mirrorRemoteDeletes, ...plan.push.delete]);
	for (const key of dropped) {
		const item = keyed.remoteById.get(key);
		if (item !== undefined) del.push(item);
	}

	const desired: DesiredEntry<R>[] = [];
	for (const [key, item] of keyed.remoteOrder) {
		if (dropped.has(key)) continue;
		desired.push({ item: replaced.get(key) ?? item, localId: localIdOf.get(key) ?? null });
	}
	for (const entry of create) desired.push({ item: entry.item, localId: entry.localId });

	return { create, update, delete: del, desired };
}
