//! Review sessions (frontend). Owns the active review session and all navigation,
//! persisting to the Rust `review_sessions` store. The cursor is an id (never a
//! positional index), so deleting any non-cursor location can't desync it.
//!
//! Extracted out of useMapStore/LocationPreview: this module is the single seam.
//! LocationPreview renders <ReviewBar> and calls reviewNext/Prev/Delete/onSaved.

import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { emit, useEventValue, subscribe as onEvent } from "@/lib/events";
import {
	getMapState,
	setActiveLocation,
	addSelections,
	removeSelections,
	removeLocations,
	fetchLocations,
} from "@/store/useMapStore";
import { selectionDisplayName } from "@/store/selections";

import type { ReviewSession, Selection } from "@/bindings.gen";
import { t } from "@/lib/i18n";

// --- Pure helpers (unit-tested; no side effects) ---

export interface PruneResult {
	session: ReviewSession | null;
	cursorMoved: boolean;
}

/** Remove `removed` ids from a session's worklist + reviewed set. The cursor only
 *  moves if the cursor id itself was removed (advancing to the next survivor by old
 *  position). Returns the same session reference untouched if nothing overlapped. */
export function pruneSession(s: ReviewSession, removed: Set<number>): PruneResult {
	if (!s.order.some((id) => removed.has(id))) return { session: s, cursorMoved: false };
	const order = s.order.filter((id) => !removed.has(id));
	const reviewed = s.reviewed.filter((id) => !removed.has(id));
	if (order.length === 0) return { session: null, cursorMoved: true };
	let cursorId = s.cursorId;
	if (removed.has(cursorId)) {
		const oldIdx = s.order.indexOf(cursorId);
		cursorId = order[Math.min(oldIdx, order.length - 1)];
	}
	return { session: { ...s, order, reviewed, cursorId }, cursorMoved: cursorId !== s.cursorId };
}

/** Mark the current cursor reviewed and step forward. `done` when the cursor was the
 *  last item (status flips to "done"). */
export function advance(s: ReviewSession): { session: ReviewSession; done: boolean } {
	const idx = s.order.indexOf(s.cursorId);
	const reviewed = s.reviewed.includes(s.cursorId) ? s.reviewed : [...s.reviewed, s.cursorId];
	if (idx < 0 || idx >= s.order.length - 1) {
		return { session: { ...s, reviewed, status: "done" }, done: true };
	}
	return { session: { ...s, reviewed, cursorId: s.order[idx + 1] }, done: false };
}

/** Step backward without marking anything reviewed. Null when already at the start. */
export function retreat(s: ReviewSession): ReviewSession | null {
	const idx = s.order.indexOf(s.cursorId);
	if (idx <= 0) return null;
	return { ...s, cursorId: s.order[idx - 1] };
}

/** Position of the session cursor within its review order. */
export function reviewIndex(s: ReviewSession): number {
	return s.order.indexOf(s.cursorId);
}

/** Union of reviewed ids across sessions, de-duplicated. Pure (unit-tested). */
export function reviewedHistoryIds(sessions: ReviewSession[]): number[] {
	const ids = new Set<number>();
	for (const s of sessions) for (const id of s.reviewed) ids.add(id);
	return [...ids];
}

/** True when the cursor is on the session's first location. */
export function isAtStart(s: ReviewSession): boolean {
	return reviewIndex(s) <= 0;
}

/** Current cursor location is in the reviewed set. */
export function isCurrentReviewed(s: ReviewSession): boolean {
	return s.reviewed.includes(s.cursorId);
}

// --- Module state + reactivity ---

let session: ReviewSession | null = null;

/** Reactive active review session, or null. */
export function useReviewSession(): ReviewSession | null {
	return useEventValue("review:changed", () => session);
}

/** The active review session, or null. */
export function getReviewSession(): ReviewSession | null {
	return session;
}

// --- Persistence (debounced; review stepping is a hot path) ---

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist(s: ReviewSession) {
	cmd
		.storeReviewUpdate({
			id: s.id,
			cursorId: s.cursorId,
			reviewed: s.reviewed,
			ordering: s.order,
			status: s.status,
		})
		.catch((e) => log.error("[review] persist failed:", e));
}

function scheduleSave() {
	if (!session) return;
	const s = session;
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		saveTimer = null;
		persist(s);
	}, 400);
}

function flushSave() {
	if (saveTimer) {
		clearTimeout(saveTimer);
		saveTimer = null;
	}
	if (session) persist(session);
}

/** Navigate the pano to the cursor. `checkDuplicates: false` — during a review pass we
 *  show every queued location rather than diverting to the duplicates panel. */
async function gotoCursor(s: ReviewSession): Promise<void> {
	await setActiveLocation(s.cursorId, false);
}

// --- Public API ---

/** Start (or resume) a review over `ids`. When `source` is a real selection, the session
 *  is keyed by it so re-reviewing that selection resumes the in-progress session. */
export async function beginReview(ids: number[], source?: Selection): Promise<void> {
	const mapId = getMapState().mapId;
	const map = getMapState().map;
	if (!mapId || !map || ids.length === 0) return;

	const sourceKey = source?.key ?? "manual";
	if (source && source.selector.type !== "Manual") {
		try {
			const existing = await cmd.storeReviewGet(mapId, sourceKey);
			if (existing) {
				await adopt(existing);
				return;
			}
		} catch (e) {
			log.error("[review] resume lookup failed:", e);
		}
	}

	// Freeze the worklist to ids that still exist, preserving the given order.
	const live = await fetchLocations({ type: "Locations", locations: ids, name: null });
	const liveSet = new Set(live.map((l) => l.id));
	const order = ids.filter((id) => liveSet.has(id));
	if (order.length === 0) return;

	const name = source ? selectionDisplayName(source) : t("Selected locations");
	const sourceProps = source?.selector ?? { type: "Manual", locations: order };
	try {
		session = await cmd.storeReviewCreate({ mapId, name, sourceKey, sourceProps, order });
		emit("review:changed");
		refreshProjection();
		await gotoCursor(session);
	} catch (e) {
		log.error("[review] create failed:", e);
	}
}

/** Resume a session picked from the resume modal. */
export async function resumeReview(s: ReviewSession): Promise<void> {
	await adopt(s);
}

/** Mark the current location reviewed and step to the next one. */
export async function reviewNext(): Promise<void> {
	if (!session) return;
	const { session: next, done } = advance(session);
	session = next;
	emit("review:changed");
	if (done) {
		const id = next.id;
		flushSave();
		session = null;
		emit("review:changed");
		clearProjection(id);
		await setActiveLocation(null);
		return;
	}
	scheduleSave();
	scheduleProjection();
	await gotoCursor(next);
}

/** Step back to the previous location in the session. */
export async function reviewPrev(): Promise<void> {
	if (!session) return;
	const prev = retreat(session);
	if (!prev) return;
	session = prev;
	emit("review:changed");
	scheduleSave();
	await gotoCursor(prev);
}

/** Delete the current location and advance FORWARD (like reviewNext) — to the item that
 *  followed it, or exit the pass if it was the last one. We navigate off the doomed location
 *  first so the shared `removeLocations` doesn't bounce us to the overview; its emitted
 *  `location:remove` is then a no-op for our reconcile listener (already pruned). */
export async function reviewDelete(): Promise<void> {
	if (!session) return;
	const s = session;
	const curId = s.cursorId;
	const idx = s.order.indexOf(curId);
	const order = s.order.filter((id) => id !== curId);
	const reviewed = s.reviewed.filter((id) => id !== curId);

	if (idx >= 0 && idx < order.length) {
		// an item took curId's slot — advance to it
		session = { ...s, order, reviewed, cursorId: order[idx] };
		emit("review:changed");
		await gotoCursor(session);
		flushSave();
		scheduleProjection();
		await removeLocations(new Set([curId]));
		return;
	}

	// curId was the last item (or the only one) — end the pass
	if (order.length > 0) {
		persist({ ...s, order, reviewed, status: "done" }); // survivors remain, resumable as done
	} else {
		cmd.storeReviewDelete(s.id).catch(() => {});
	}
	session = null;
	emit("review:changed");
	clearProjection(s.id);
	await setActiveLocation(null);
	await removeLocations(new Set([curId]));
}

/** Exit the review UI but keep the session resumable (persisted as active). */
export function cancelReview(): void {
	if (!session) return;
	const id = session.id;
	flushSave();
	session = null;
	emit("review:changed");
	clearProjection(id);
	void setActiveLocation(null);
}

/** Rename a session (custom label over the auto-derived selection name). Persists immediately;
 *  also patches the live session if it's the one being renamed. */
export async function renameReview(id: string, name: string): Promise<void> {
	const trimmed = name.trim();
	if (!trimmed) return;
	try {
		await cmd.storeReviewUpdate({
			id,
			name: trimmed,
			cursorId: null,
			reviewed: null,
			ordering: null,
			status: null,
		});
	} catch (e) {
		log.error("[review] rename failed:", e);
		return;
	}
	if (session?.id === id) {
		session = { ...session, name: trimmed };
		emit("review:changed");
	}
}

/** Delete a review session (its progress, not the locations). */
export async function deleteSession(id: string): Promise<void> {
	try {
		await cmd.storeReviewDelete(id);
	} catch (e) {
		log.error("[review] session delete failed:", e);
	}
	if (session?.id === id) cancelReview();
}

/** Review sessions for the open map, optionally filtered by status. */
export function listSessions(status?: "active" | "done"): Promise<ReviewSession[]> {
	const mapId = getMapState().mapId;
	if (!mapId) return Promise.resolve([]);
	return cmd.storeReviewList(mapId, status ?? null);
}

// Sentinel session id for the cross-session "everything reviewed on this map" selection.
// Real sessions are UUID-keyed, so this never collides with a live projection's keys.
const HISTORY_SESSION_ID = "history";

/** Select every location marked reviewed across all review sessions on this map (active + done).
 *  A snapshot; re-running refreshes it in place (deterministic key). */
export async function selectReviewedHistory(): Promise<void> {
	const ids = reviewedHistoryIds(await listSessions());
	if (ids.length === 0) return;
	await addSelections([
		{ type: "Reviewed", locations: ids, sessionId: HISTORY_SESSION_ID, mode: "reviewed" },
	]);
}

/** Add a reviewed/unreviewed overlay selection for an arbitrary session (resume modal). Mirrors
 *  refreshProjection's selector so the key and color match an in-progress projection. */
export function selectReviewSet(s: ReviewSession, mode: "reviewed" | "unreviewed") {
	const reviewedSet = new Set(s.reviewed);
	const locations =
		mode === "reviewed" ? [...s.reviewed] : s.order.filter((id) => !reviewedSet.has(id));
	return addSelections([{ type: "Reviewed", locations, sessionId: s.id, mode }]);
}

// --- Selection projection (auto, debounced) ---
//
// While a review is active, two overlay selections mirror its progress: "reviewed" and
// "unreviewed". They're re-added by their deterministic keys (dedupe replaces the prior
// pair), so refreshing just updates the membership. Debounced so mashing next doesn't
// re-resolve the whole selection list on every step.

const reviewKeys = (id: string): string[] => [`review:${id}:reviewed`, `review:${id}:unreviewed`];

let projectTimer: ReturnType<typeof setTimeout> | null = null;

function clearProjectTimer() {
	if (projectTimer) {
		clearTimeout(projectTimer);
		projectTimer = null;
	}
}

function refreshProjection(): void {
	if (!session) return;
	const reviewedSet = new Set(session.reviewed);
	const unreviewed = session.order.filter((id) => !reviewedSet.has(id));
	void addSelections([
		{ type: "Reviewed", locations: [...session.reviewed], sessionId: session.id, mode: "reviewed" },
		{ type: "Reviewed", locations: unreviewed, sessionId: session.id, mode: "unreviewed" },
	]);
}

function scheduleProjection(): void {
	clearProjectTimer();
	projectTimer = setTimeout(() => {
		projectTimer = null;
		refreshProjection();
	}, 40);
}

function clearProjection(id: string): void {
	clearProjectTimer();
	void removeSelections(reviewKeys(id));
}

/** Adopt a persisted session as active, pruning ids whose locations no longer exist
 *  (deletions from a prior run). Deletes the session if nothing survives. */
async function adopt(s: ReviewSession): Promise<void> {
	let { order, reviewed, cursorId } = s;
	try {
		const live = await fetchLocations({ type: "Locations", locations: s.order, name: null });
		const liveIds = new Set(live.map((l) => l.id));
		order = s.order.filter((id) => liveIds.has(id));
		if (order.length === 0) {
			await cmd.storeReviewDelete(s.id).catch(() => {});
			return;
		}
		reviewed = s.reviewed.filter((id) => liveIds.has(id));
		cursorId = liveIds.has(s.cursorId) ? s.cursorId : order[0];
	} catch (e) {
		log.error("[review] validate failed:", e);
	}
	const changed = order.length !== s.order.length || reviewed.length !== s.reviewed.length;
	const v: ReviewSession = { ...s, order, reviewed, cursorId };
	session = v;
	emit("review:changed");
	if (changed) persist(v);
	refreshProjection();
	await gotoCursor(v);
}

// --- Reconciliation (event-bus) ---

function reconcile(removed: number[]): void {
	if (!session) return;
	const prev = session;
	const { session: next, cursorMoved } = pruneSession(prev, new Set(removed));
	if (next === prev) return; // nothing overlapped
	session = next;
	emit("review:changed");
	if (!next) {
		cmd.storeReviewDelete(prev.id).catch(() => {});
		clearProjection(prev.id);
		void setActiveLocation(null);
		return;
	}
	scheduleSave();
	scheduleProjection();
	if (cursorMoved && getMapState().activeLocation?.id !== next.cursorId) {
		void gotoCursor(next);
	}
}

/** Keep the cursor in step with the active location. Clicking an in-queue marker jumps the
 *  cursor there (counter/next/prev/delete stay aligned); clicking off-queue is a harmless
 *  peek — the session is left untouched and you can resume from where you were. */
function onActiveChange(id: number | null): void {
	if (!session || id == null || id === session.cursorId) return;
	if (!session.order.includes(id)) return; // off-queue peek: leave the cursor parked
	session = { ...session, cursorId: id };
	emit("review:changed");
	scheduleSave();
}

onEvent("active:change", (id) => onActiveChange(id));
onEvent("location:remove", (ids) => reconcile(ids));
onEvent("map:close", () => {
	clearProjectTimer();
	flushSave();
	session = null;
	emit("review:changed");
});
onEvent("map:open", () => {
	clearProjectTimer();
	session = null;
	emit("review:changed");
});
