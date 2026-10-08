import type { Conflict, SideCounts } from "@/bindings.gen";
import type { FirstSyncMode } from "@/bindings.consts";
import type { SyncProvider } from "./provider";
import type { IdentityKey, SyncStore } from "./syncStore";
import { cmd } from "@/lib/commands";
import { getMapState, mutate } from "@/store/useMapStore";
import { emit as emitEvent } from "@/lib/events";

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

/**
 * One reconcile pass for a linked, open map. The whole merge runs in Rust: push, the pull
 * half landed as one undo step with its tags interned and its mapping rows written beside
 * it. This applies the landed change to this window and advances the link.
 */
export async function reconcile(
	provider: SyncProvider,
	store: SyncStore,
	opts: ReconcileOptions = {},
): Promise<SyncOutcome> {
	const { signal } = opts;
	const link = store.getLink();
	if (!link) throw new Error("map is not linked");
	if (signal?.aborted) throw new DOMException("sync aborted", "AbortError");
	const open = getMapState().map;
	if (!open || open.id !== link.localMapId) throw new Error("linked map is no longer open");

	const result = await cmd.syncReconcile(
		provider.id,
		link.localMapId,
		link.remoteMapId,
		opts.firstSync ?? null,
		opts.resolutions ? [...opts.resolutions.entries()] : null,
	);

	// The merge is already settled in the store either way; an abort or unlink that landed
	// while it ran only stops this window's apply and keeps the pass out of the history.
	if (signal?.aborted) throw new DOMException("sync aborted", "AbortError");
	if (!store.getLink()) throw new Error("map was unlinked during sync");

	if (result.mutation) {
		const mutation = result.mutation;
		await mutate(() => Promise.resolve(mutation));
	}
	if (result.removedIds.length) emitEvent("location:remove", result.removedIds);

	store.setLink({ ...link, lastSyncedAt: new Date().toISOString() });

	return {
		pushed: result.pushed,
		pulled: result.pulled,
		adopted: result.adopted,
		conflicts: result.conflicts,
	};
}
