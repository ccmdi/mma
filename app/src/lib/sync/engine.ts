import { Store } from "@/store/store";
import { Mutation } from "@/store/mutation";
import type { Conflict, SideCounts } from "@/bindings.gen";
import type { FirstSyncMode } from "@/bindings.consts";
import type { SyncProvider } from "./provider";
import type { IdentityKey, SyncStore } from "./syncStore";
import { cmd } from "@/lib/commands";

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

/** Sync a linked, open map. Rust applies the merge; wait for the local change feed
 * before updating the link's sync timestamp. */
export async function reconcile(
	provider: SyncProvider,
	store: SyncStore,
	opts: ReconcileOptions = {},
): Promise<SyncOutcome> {
	const { signal } = opts;
	const link = store.getLink();
	if (!link) throw new Error("map is not linked");
	if (signal?.aborted) throw new DOMException("sync aborted", "AbortError");
	const open = Store.get().map;
	if (!open || open.id !== link.localMapId) throw new Error("linked map is no longer open");

	const result = await cmd.syncReconcile(
		provider.id,
		link.localMapId,
		link.remoteMapId,
		opts.firstSync ?? null,
		opts.resolutions ? [...opts.resolutions.entries()] : null,
	);

	// Rust has already applied the merge. Abort or unlink stops completion reporting,
	// without rolling back those changes.
	if (signal?.aborted) throw new DOMException("sync aborted", "AbortError");
	if (!store.getLink()) throw new Error("map was unlinked during sync");

	if (result.mutation) await Mutation.settle(result.mutation);
	store.setLink({ ...link, lastSyncedAt: new Date().toISOString() });

	return {
		pushed: result.pushed,
		pulled: result.pulled,
		adopted: result.adopted,
		conflicts: result.conflicts,
	};
}
