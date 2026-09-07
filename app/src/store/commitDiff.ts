import { useEffect } from "react";
import type { LatLng } from "@/types";
import type { CommitDelta, CommitDiff, CommitInfo, Location } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { fitMapToBounds } from "@/lib/map/mapState";
import { boundsOfCoords } from "@/lib/map/host";
import { emit as emitEvent, subscribe, useEventValue } from "@/lib/events";
import { getMapState, setWorkArea } from "./useMapStore";

// --- Uncommitted-diff counts (drives the Commit button + palette enablement) ---

const ZERO_DIFF: CommitDiff = { added: 0, removed: 0, modified: 0 };
let cachedCommitDiff = ZERO_DIFF;

/** Whether there are uncommitted changes (adds, removes, or modifications). */
export function hasCommitDiff(): boolean {
	return (
		cachedCommitDiff.added > 0 || cachedCommitDiff.removed > 0 || cachedCommitDiff.modified > 0
	);
}

function publishCommitDiff(next: CommitDiff) {
	if (
		next.added === cachedCommitDiff.added &&
		next.removed === cachedCommitDiff.removed &&
		next.modified === cachedCommitDiff.modified
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
	if (!getMapState().map) return;
	const [added, removed, modified] = await cmd.storeCommitDiff();
	publishCommitDiff({ added, removed, modified });
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
	commitId: string;
	hash: string;
	counts: CommitDiff;
	added: Float32Array;
	removed: Float32Array;
	modified: Float32Array;
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

/** Split a commit delta into added / removed / modified. An updated location appears in
 *  both `created` (new) and `removed` (old), keyed by id. */
export function categorizeCommitDelta(delta: CommitDelta): {
	added: Location[];
	removed: Location[];
	modified: Location[];
} {
	const removedIds = new Set(delta.removed.map((l) => l.id));
	const createdIds = new Set(delta.created.map((l) => l.id));
	return {
		added: delta.created.filter((l) => !removedIds.has(l.id)),
		removed: delta.removed.filter((l) => !createdIds.has(l.id)),
		modified: delta.created.filter((l) => removedIds.has(l.id)),
	};
}

/** Fetch a commit's delta and overlay its added/removed/modified locations on the map,
 *  temporarily replacing the regular markers. */
export async function beginCommitDiffPreview(commit: CommitInfo) {
	if (!getMapState().map) return;
	const { added, removed, modified } = categorizeCommitDelta(
		await cmd.storeGetCommitDelta(commit.mapId, commit.id),
	);
	commitDiffPreview = {
		commitId: commit.id,
		hash: commit.id.slice(0, 7),
		counts: { added: added.length, removed: removed.length, modified: modified.length },
		added: diffPositions(added),
		removed: diffPositions(removed),
		modified: diffPositions(modified),
	};
	emitEvent("diff-markers:changed");
	setWorkArea("diff");
	const bounds = boundsOfCoords([...added, ...removed, ...modified]);
	if (bounds) fitMapToBounds(bounds, 100);
}

/** Leave commit-diff preview and restore the regular markers. */
export function endCommitDiffPreview() {
	commitDiffPreview = null;
	emitEvent("diff-markers:changed");
	if (getMapState().workArea === "diff") setWorkArea("overview");
	else emitEvent("store:changed");
}
