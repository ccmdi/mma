import { useEffect } from "react";
import { Store } from "@/store/store";
import { Editor } from "@/store/editor";
import type { LatLng } from "@/types";
import type { CommitInfo, Counts } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { fitMapToBounds } from "@/lib/map/mapState";
import { boundsOfCoords } from "@/lib/map/host";
import { emit as emitEvent, subscribe, useEventValue } from "@/lib/events";

// --- Uncommitted-diff counts (drives the Commit button + palette enablement) ---

const ZERO_DIFF: Counts = { added: 0, removed: 0, updated: 0 };
let cachedCommitDiff = ZERO_DIFF;

/** Whether there are uncommitted changes (adds, removes, or updates). */
export function hasCommitDiff(): boolean {
	return cachedCommitDiff.added > 0 || cachedCommitDiff.removed > 0 || cachedCommitDiff.updated > 0;
}

function publishCommitDiff(next: Counts) {
	if (
		next.added === cachedCommitDiff.added &&
		next.removed === cachedCommitDiff.removed &&
		next.updated === cachedCommitDiff.updated
	) {
		return;
	}
	cachedCommitDiff = next;
	emitEvent("commit-diff:changed");
}

/** Reset the uncommitted-change counts to zero. */
export function resetCommitDiffCounts() {
	publishCommitDiff(ZERO_DIFF);
}

async function refreshCommitDiff() {
	if (!Store.get().map) return;
	publishCommitDiff(await cmd.storeCommitDiff());
}

/** React hook: the uncommitted add/remove/modify counts, kept in sync with the store. */
export function useCommitDiff() {
	const diff = useEventValue("commit-diff:changed", () => cachedCommitDiff);
	useEffect(() => {
		void refreshCommitDiff();
		return subscribe("store:changed", () => void refreshCommitDiff());
	}, []);
	return diff;
}

// --- Commit-diff preview overlay ---

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
/** The current commit-diff preview, or null when not previewing. */
export function getCommitDiffPreview() {
	return commitDiffPreview;
}

/** Clear commit-diff preview state. */
export function resetCommitDiffState() {
	commitDiffPreview = null;
}

/** Pack `[lng, lat]` pairs into an interleaved Float32Array. */
export function diffPositions(locs: LatLng[]): Float32Array {
	const a = new Float32Array(locs.length * 2);
	for (let i = 0; i < locs.length; i++) {
		a[i * 2] = locs[i].lng;
		a[i * 2 + 1] = locs[i].lat;
	}
	return a;
}

/** Fetch a commit's change and overlay its added/removed/updated locations on the map,
 *  temporarily replacing the regular markers. */
export async function beginCommitDiffPreview(commit: CommitInfo) {
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
		added: diffPositions(change.added),
		removed: diffPositions(change.removed),
		updated: diffPositions(updated),
	};
	emitEvent("diff-markers:changed");
	Editor.setArea("diff");
	const bounds = boundsOfCoords([...change.added, ...change.removed, ...updated]);
	if (bounds) fitMapToBounds(bounds, 100);
}

/** Leave commit-diff preview and restore the regular markers. */
export function endCommitDiffPreview() {
	commitDiffPreview = null;
	emitEvent("diff-markers:changed");
	if (Store.get().workArea === "diff") Editor.setArea("overview");
	else emitEvent("store:changed");
}
