import { Store } from "@/store/store";
import { Editor } from "@/store/editor";
import type { LatLng } from "@/types";
import type { CommitInfo, Counts } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { MapHost } from "@/lib/map/host";
import { boundsOfCoords } from "@/lib/geo/geo";
import { emit as emitEvent } from "@/lib/events";

const changed = (pending: Counts) =>
	pending.added > 0 || pending.removed > 0 || pending.updated > 0;

/** Commit-diff preview state shown while `workArea === "diff"`. Position arrays are
 *  interleaved `[lng, lat]` Float32Arrays. */
export interface CommitDiffPreview {
	hash: string;
	counts: Counts;
	added: Float32Array;
	removed: Float32Array;
	updated: Float32Array;
}

let commitDiffPreview: CommitDiffPreview | null = null;
/** Uncommitted changes and their preview on the map. @api @unstable */
export const CommitDiff = {
	/** Whether there are uncommitted changes (adds, removes, or updates). */
	has: (): boolean => {
		return changed(Store.get().pending);
	},
	/** React hook: the uncommitted add/remove/modify counts. */
	use: (): Counts => {
		return Store.use((s) => s.pending);
	},
	/** The current commit-diff preview, or null when not previewing. */
	preview: () => {
		return commitDiffPreview;
	},
	/** Clear commit-diff preview state. */
	reset: () => {
		commitDiffPreview = null;
	},
	/** Pack `[lng, lat]` pairs into an interleaved Float32Array. */
	positions: (locs: LatLng[]): Float32Array => {
		const a = new Float32Array(locs.length * 2);
		for (let i = 0; i < locs.length; i++) {
			a[i * 2] = locs[i].lng;
			a[i * 2 + 1] = locs[i].lat;
		}
		return a;
	},
	/** Fetch a commit's change and overlay its added/removed/updated locations on the map,
	 *  temporarily replacing the regular markers. */
	begin: async (commit: CommitInfo) => {
		if (!Store.get().map) return;
		const change = await cmd.storeGetCommitDelta(commit.mapId, commit.id);
		const updated = change.updated.map(([, next]) => next);
		commitDiffPreview = {
			hash: commit.id.slice(0, 7),
			counts: {
				added: change.added.length,
				removed: change.removed.length,
				updated: updated.length,
			},
			added: CommitDiff.positions(change.added),
			removed: CommitDiff.positions(change.removed),
			updated: CommitDiff.positions(updated),
		};
		emitEvent("diff-markers:changed");
		Editor.setArea("diff");
		const bounds = boundsOfCoords([...change.added, ...change.removed, ...updated]);
		if (bounds) MapHost.fitToBounds(bounds, 100);
	},
	/** Leave commit-diff preview and restore the regular markers. */
	end: () => {
		commitDiffPreview = null;
		emitEvent("diff-markers:changed");
		if (Editor.get().workArea === "diff") Editor.setArea("overview");
	},
};
