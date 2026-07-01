import type { Location, Update, LocationPatch_Deserialize } from "@/bindings.gen";
import {
	localToRemoteInput,
	remoteToLocalFields,
	remoteToNormalized,
	syncHash,
	type TagId,
	type TagName,
} from "./adapter";
import { computeSyncPlan, summarize, type Conflict, type IdentityKey } from "./diff";
import { buildKeyedInputs } from "./keying";
import { EditActionType } from "./remote-types";
import type { MapMakingWebApi } from "./map-making-web-api";
import type { RemoteMappingRow, SyncStore } from "./syncStore";

export interface SyncOutcome {
	pushed: { create: number; update: number; delete: number };
	pulled: { create: number; update: number; delete: number };
	adopted: number;
	conflicts: Conflict[];
}

const parseLocalId = (key: IdentityKey): number | null =>
	key.startsWith("L:") ? Number(key.slice(2)) : null;

/**
 * One reconcile pass for a linked, open map. Pulls remote, reads local, three-way diffs, and
 * applies both directions: pulls through the store primitives, pushes through the edits endpoint
 * (updates = remove-old + create-new, since a remote id churns on edit), then rewrites the mapping
 * from the id-remap and advances the base. Conflicts are collected and returned, not applied
 * (review policy). No location content is persisted - only the `{localId, remoteId, hash}` index.
 */
export async function reconcile(api: MapMakingWebApi, store: SyncStore): Promise<SyncOutcome> {
	const M = window.MMA;
	const link = store.getLink();
	if (!link) throw new Error("map is not linked");
	const map = M.getCurrentMap();
	if (!map || map.meta.id !== link.localMapId) throw new Error("linked map is not the open map");

	const tags = map.meta.tags;
	const tagName: TagName = (id) => tags[id]?.name;
	const nameToId = new Map<string, number>();
	for (const t of Object.values(tags)) nameToId.set(t.name, t.id);

	const [localLocs, remoteLocs, mapping] = await Promise.all([
		M.fetchAllLocations(),
		api.getLocationsJson(link.remoteMapId),
		store.getMapping(),
	]);
	const mappingByLocal = new Map<number, number>(mapping.map((r) => [r.localId, r.remoteId]));

	const keyed = buildKeyedInputs(localLocs, remoteLocs, mapping, tagName);
	const plan = computeSyncPlan(keyed.base, keyed.local, keyed.remote);

	// Create any local tags the incoming pulls reference, then resolve names -> ids.
	const needed = new Set<string>();
	for (const key of [...plan.pull.create, ...plan.pull.update]) {
		for (const n of keyed.remoteById.get(key)?.tags ?? []) if (!nameToId.has(n)) needed.add(n);
	}
	if (needed.size) for (const t of await M.createTags([...needed])) nameToId.set(t.name, t.id);
	const tagId: TagId = (name) => nameToId.get(name);

	const upserts: RemoteMappingRow[] = [];
	const deletes: number[] = [];

	// --- PULL: apply remote-originated changes to the local store ---
	const newLocals: Location[] = [];
	const newKeys: IdentityKey[] = [];
	for (const key of plan.pull.create) {
		const r = keyed.remoteById.get(key)!;
		newLocals.push(M.createLocation(remoteToLocalFields(r, tagId)));
		newKeys.push(key);
	}
	if (newLocals.length) await M.addLocations(newLocals); // assigns real ids in place
	newKeys.forEach((key, i) => {
		const r = keyed.remoteById.get(key)!;
		upserts.push({
			localId: newLocals[i]!.id,
			remoteId: r.id,
			hash: syncHash(remoteToNormalized(r)),
		});
	});

	const updates: Update<LocationPatch_Deserialize>[] = [];
	for (const key of plan.pull.update) {
		const r = keyed.remoteById.get(key)!;
		const localId = keyed.localById.get(key)!.id;
		updates.push({ id: localId, patch: remoteToLocalFields(r, tagId) });
		upserts.push({ localId, remoteId: r.id, hash: syncHash(remoteToNormalized(r)) });
	}
	if (updates.length) await M.updateLocations(updates);

	const localRemovals = new Set<number>();
	for (const key of plan.pull.delete) {
		const localId = keyed.localById.get(key)!.id;
		localRemovals.add(localId);
		deletes.push(localId);
	}
	if (localRemovals.size) await M.removeLocations(localRemovals);

	// --- PUSH: send local-originated changes to the remote via one edit batch ---
	const create: ReturnType<typeof localToRemoteInput>[] = [];
	const remove: number[] = [];
	const createdMeta: { key: IdentityKey; localId: number; negId: number }[] = [];
	let neg = -1;
	for (const key of plan.push.create) {
		const loc = keyed.localById.get(key)!;
		const negId = neg--;
		create.push(localToRemoteInput(loc, negId, tagName));
		createdMeta.push({ key, localId: loc.id, negId });
	}
	for (const key of plan.push.update) {
		const loc = keyed.localById.get(key)!;
		const oldRemoteId = mappingByLocal.get(loc.id);
		if (oldRemoteId !== undefined) remove.push(oldRemoteId);
		const negId = neg--;
		create.push(localToRemoteInput(loc, negId, tagName));
		createdMeta.push({ key, localId: loc.id, negId });
	}
	for (const key of plan.push.delete) {
		const localId = parseLocalId(key);
		const remoteId = localId !== null ? mappingByLocal.get(localId) : undefined;
		if (localId !== null && remoteId !== undefined) {
			remove.push(remoteId);
			deletes.push(localId);
		}
	}
	if (create.length || remove.length) {
		const remap = await api.editLocations(link.remoteMapId, {
			edits: [{ action: { type: EditActionType.Bulk }, create, remove }],
		});
		for (const m of createdMeta) {
			const remoteId = remap[String(m.negId)];
			if (remoteId !== undefined)
				upserts.push({ localId: m.localId, remoteId, hash: syncHash(keyed.local.get(m.key)!) });
		}
	}

	// --- Converged: both sides already agree; adopt/advance the base, no apply ---
	let adopted = 0;
	for (const key of plan.converged) {
		const loc = keyed.localById.get(key);
		const rem = keyed.remoteById.get(key);
		if (loc && rem) {
			upserts.push({ localId: loc.id, remoteId: rem.id, hash: syncHash(keyed.local.get(key)!) });
			adopted++;
		} else {
			const localId = parseLocalId(key); // both-deleted -> drop the row
			if (localId !== null) deletes.push(localId);
		}
	}

	if (upserts.length) await store.upsertMapping(upserts);
	if (deletes.length) await store.deleteMapping(deletes);
	store.setLink({ ...link, lastSyncedAt: new Date().toISOString() });

	const c = summarize(plan);
	return { pushed: c.push, pulled: c.pull, adopted, conflicts: plan.conflicts };
}
