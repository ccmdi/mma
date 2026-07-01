import type { NormalizedSyncLocation } from "./adapter";
import { syncEqual, syncHash } from "./adapter";

/**
 * Stable identity for a synced location across runs. Comes from the persisted local<->remote
 * id mapping; items not yet mapped get a side-scoped key (e.g. `"L:<localId>"` / `"R:<remoteId>"`)
 * so they can't collide. The diff is identity-keyed and never matches by content on its own.
 */
export type IdentityKey = string;

export type SyncState = ReadonlyMap<IdentityKey, NormalizedSyncLocation>;

/** Base side: only a fingerprint per identity is persisted, never location content. */
export type BaseHashes = ReadonlyMap<IdentityKey, string>;

/** Changes to apply to one side, as identity keys (caller resolves key -> location). */
export interface SidePlan {
	create: IdentityKey[];
	update: IdentityKey[];
	delete: IdentityKey[];
}

export type ConflictKind =
	/** Both sides modified the same location differently. */
	| "update-update"
	/** One side deleted while the other modified. */
	| "delete-update"
	/** Both sides independently added the same identity with different content. */
	| "add-add";

export interface Conflict {
	key: IdentityKey;
	kind: ConflictKind;
	/** Base value is not persisted (only its hash), so conflicts surface local vs remote. */
	local: NormalizedSyncLocation | null;
	remote: NormalizedSyncLocation | null;
}

export interface SyncPlan {
	/** Apply to REMOTE (local-originated changes). */
	push: SidePlan;
	/** Apply to LOCAL (remote-originated changes). */
	pull: SidePlan;
	conflicts: Conflict[];
	/** Both sides already agree but differ from base: no apply, just advance the base snapshot. */
	converged: IdentityKey[];
}

type Change = "none" | "added" | "removed" | "modified";

function classify(baseHash: string | undefined, cur: NormalizedSyncLocation | undefined): Change {
	if (baseHash === undefined && cur === undefined) return "none";
	if (baseHash === undefined) return "added";
	if (cur === undefined) return "removed";
	return syncHash(cur) === baseHash ? "none" : "modified";
}

const emptySide = (): SidePlan => ({ create: [], update: [], delete: [] });

function record(side: SidePlan, change: Change, key: IdentityKey): void {
	if (change === "added") side.create.push(key);
	else if (change === "modified") side.update.push(key);
	else if (change === "removed") side.delete.push(key);
}

/**
 * Three-way merge over identity keys. For each key in base ∪ local ∪ remote, compares each side
 * against the base snapshot and routes it: only-local-changed -> push, only-remote-changed -> pull,
 * both-changed-and-equal -> converged, both-changed-and-different -> conflict.
 */
export function computeSyncPlan(base: BaseHashes, local: SyncState, remote: SyncState): SyncPlan {
	const plan: SyncPlan = { push: emptySide(), pull: emptySide(), conflicts: [], converged: [] };
	const keys = new Set<IdentityKey>([...base.keys(), ...local.keys(), ...remote.keys()]);

	for (const key of keys) {
		const b = base.get(key);
		const l = local.get(key);
		const r = remote.get(key);
		const lc = classify(b, l);
		const rc = classify(b, r);

		if (lc === "none" && rc === "none") continue;
		if (rc === "none") {
			record(plan.push, lc, key); // only local moved
			continue;
		}
		if (lc === "none") {
			record(plan.pull, rc, key); // only remote moved
			continue;
		}

		// Both sides moved since base.
		if (lc === "removed" && rc === "removed") {
			plan.converged.push(key); // both deleted -> agree
			continue;
		}
		if (lc === "removed" || rc === "removed") {
			plan.conflicts.push({ key, kind: "delete-update", local: l ?? null, remote: r ?? null });
			continue;
		}
		if (l !== undefined && r !== undefined && syncEqual(l, r)) {
			plan.converged.push(key); // both moved to the same value
			continue;
		}
		plan.conflicts.push({
			key,
			kind: lc === "added" && rc === "added" ? "add-add" : "update-update",
			local: l ?? null,
			remote: r ?? null,
		});
	}
	return plan;
}

export interface SyncPlanCounts {
	push: { create: number; update: number; delete: number };
	pull: { create: number; update: number; delete: number };
	conflicts: number;
	converged: number;
	/** Actionable items (push + pull + conflicts); excludes converged base-only advances. */
	actionable: number;
}

export function summarize(plan: SyncPlan): SyncPlanCounts {
	const side = (s: SidePlan) => ({
		create: s.create.length,
		update: s.update.length,
		delete: s.delete.length,
	});
	const push = side(plan.push);
	const pull = side(plan.pull);
	const actionable =
		push.create +
		push.update +
		push.delete +
		pull.create +
		pull.update +
		pull.delete +
		plan.conflicts.length;
	return {
		push,
		pull,
		conflicts: plan.conflicts.length,
		converged: plan.converged.length,
		actionable,
	};
}

/** True when there is nothing to push, pull, or resolve (converged base advances are not actionable). */
export const isNoop = (plan: SyncPlan): boolean => summarize(plan).actionable === 0;
