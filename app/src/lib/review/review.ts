//! Review sessions. Owns the active session, cursor navigation, and persistence.
import { Store } from "@/store/store";
import { Scene } from "@/lib/render/scene";
import { SelectionList } from "@/store/selectionList";
import { Query } from "@/store/query";
import { Location } from "@/store/location";
import { Editor } from "@/store/editor";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { debounce } from "@/lib/util/concurrent";
import { emit, useEventValue, subscribe as onEvent } from "@/lib/events";
import { addSelection, selection, removeSelection, selectionDisplayName } from "@/store/selections";
import type { Selector } from "@/types";
import type { ReviewSession, Selection } from "@/bindings.gen";
import { ReviewMode } from "@/bindings.consts";
import { t } from "@/lib/i18n";

export interface PruneResult {
	session: ReviewSession | null;
	cursorMoved: boolean;
}

// One id->index map per worklist, built on first lookup. Every worklist change builds a
// new array, so a map can never index an order it no longer describes.
const worklistIndexes = new WeakMap<number[], Map<number, number>>();

const REVIEW_MODES = Object.values(ReviewMode);

function reviewSelector(sessionId: string, mode: ReviewMode, locations: number[] = []): Selector {
	return { type: "Reviewed", locations, sessionId, mode };
}

let session: ReviewSession | null = null;

function setSession(next: ReviewSession | null): void {
	if (session && session.id !== next?.id) saves.flush();
	session = next;
	emit("review:changed");
	if (next) {
		saves.schedule(next);
		projections.schedule();
	} else projections.cancel();
}

/** Deactivate the session, clear its overlay selections, and leave review. */
function closeSession(): void {
	const s = session;
	setSession(null);
	if (s) clearProjection(s.id);
	Editor.close();
}

/** Forget a session's progress; a save still pending for it is dropped. */
async function deleteSession(id: string): Promise<void> {
	if (session?.id === id) saves.cancel();
	await cmd
		.storeReviewEdit([{ remove: id }])
		.catch((e) => log.error("[review] session delete failed:", e));
}

function persist(s: ReviewSession) {
	cmd
		.storeReviewEdit([
			{
				put: {
					id: s.id,
					cursorId: s.cursorId,
					reviewed: s.reviewed,
					order: s.order,
					status: s.status,
				},
			},
		])
		.catch((e) => log.error("[review] persist failed:", e));
}

const saves = debounce(persist, 400);

/** Navigate to the cursor location. */
async function gotoCursor(s: ReviewSession): Promise<void> {
	await Editor.open(s.cursorId, false);
}

/** The map's review order over `worklist`. */
function reviewOrdering(worklist: Selector, expr: string | null | undefined): Selector {
	const order = expr?.trim();
	if (!order) return worklist;
	return {
		type: "Ranked",
		selection: selection(worklist),
		expr: order,
		k: null,
		ascending: false,
	};
}

// Sentinel session id for the cross-session "everything reviewed on this map" selection.
// Real sessions are UUID-keyed, so this never collides with a live projection's keys.
const HISTORY_SESSION_ID = "history";

//
// While a review is active, two overlay selections mirror its progress: "reviewed" and
// "unreviewed". They're re-added by their deterministic keys (dedupe replaces the prior
// pair), so refreshing just updates the membership. Debounced so mashing next doesn't
// re-resolve the whole selection list on every step.

function refreshProjection(): void {
	const s = session;
	if (!s) return;
	void SelectionList.update(addSelection(...REVIEW_MODES.map((mode) => Review.selector(s, mode))));
}

const projections = debounce(refreshProjection, 40);

function clearProjection(id: string): void {
	const keys = Store.get()
		.selectionList.filter(
			({ selection: s }) => s.selector.type === "Reviewed" && s.selector.sessionId === id,
		)
		.map(({ selection: s }) => s.key);
	void SelectionList.update(removeSelection(...keys));
}

/** Adopt a persisted session as active, pruning locations that no longer exist. */
async function adopt(s: ReviewSession): Promise<void> {
	let v: ReviewSession | null = s;
	try {
		const liveIds = new Set(
			await Query.read({ type: "Locations", locations: s.order, name: null }, { kind: "ids" }),
		);
		v = Review.prune(s, new Set(s.order.filter((id) => !liveIds.has(id)))).session;
	} catch (e) {
		log.error("[review] validate failed:", e);
	}
	if (!v) {
		await deleteSession(s.id);
		return;
	}
	setSession(v);
	await gotoCursor(v);
}

function reconcile(removed: number[]): void {
	if (!session) return;
	const prev = session;
	const { session: next, cursorMoved } = Review.prune(prev, new Set(removed));
	if (next === prev) return; // nothing overlapped
	if (!next) {
		void deleteSession(prev.id);
		closeSession();
		return;
	}
	setSession(next);
	if (cursorMoved && Editor.get().open?.location?.id !== next.cursorId) {
		void gotoCursor(next);
	}
}

/** Keep the cursor in step with the open location. Clicking an in-queue marker
 *  jumps the cursor there; clicking off-queue leaves the session untouched. */
function onOpenChange(id: number | null): void {
	if (!session || id == null || id === session.cursorId) return;
	if (Review.positionOf(session, id) < 0) return; // off-queue peek: leave the cursor parked
	setSession({ ...session, cursorId: id });
}

onEvent("open:change", (id) => onOpenChange(id));
onEvent("store:change", (e) => {
	if (e.removed.length) reconcile(e.removed);
});
onEvent("map:close", () => {
	setSession(null);
});
onEvent("map:open", () => {
	setSession(null);
});

export const Review = {
	/** Position of `id` in the session's worklist, or -1. O(1) per step. */
	positionOf: (s: ReviewSession, id: number): number => {
		let index = worklistIndexes.get(s.order);
		if (!index) {
			index = new Map(s.order.map((locId, i) => [locId, i]));
			worklistIndexes.set(s.order, index);
		}
		return index.get(id) ?? -1;
	},
	/** Remove `removed` ids from a session's worklist and reviewed set. Advances the
	 *  cursor when the cursor id itself was removed. */
	prune: (s: ReviewSession, removed: Set<number>): PruneResult => {
		if (!s.order.some((id) => removed.has(id))) return { session: s, cursorMoved: false };
		const order = s.order.filter((id) => !removed.has(id));
		const reviewed = s.reviewed.filter((id) => !removed.has(id));
		if (order.length === 0) return { session: null, cursorMoved: true };
		let cursorId = s.cursorId;
		if (removed.has(cursorId)) {
			const oldIdx = Review.positionOf(s, cursorId);
			cursorId = order[Math.min(oldIdx, order.length - 1)];
		}
		return { session: { ...s, order, reviewed, cursorId }, cursorMoved: cursorId !== s.cursorId };
	},
	/** Mark the current cursor reviewed and step forward. `done` is true when the
	 *  session has no remaining items. */
	advance: (s: ReviewSession): { session: ReviewSession; done: boolean } => {
		const reviewed = Review.isCurrentReviewed(s) ? s.reviewed : [...s.reviewed, s.cursorId];
		if (Review.isAtEnd(s)) return { session: { ...s, reviewed, status: "done" }, done: true };
		return { session: { ...s, reviewed, cursorId: s.order[Review.index(s) + 1] }, done: false };
	},
	/** Step backward without marking anything reviewed. Null when already at the start. */
	retreat: (s: ReviewSession): ReviewSession | null => {
		if (Review.isAtStart(s)) return null;
		return { ...s, cursorId: s.order[Review.index(s) - 1] };
	},
	/** Position of the session cursor within its review order. */
	index: (s: ReviewSession): number => {
		return Review.positionOf(s, s.cursorId);
	},
	/** The session's locations in `mode`: those reviewed, or those still to review. */
	ids: (s: ReviewSession, mode: ReviewMode): number[] => {
		if (mode === "reviewed") return s.reviewed;
		const reviewed = new Set(s.reviewed);
		return s.order.filter((id) => !reviewed.has(id));
	},
	/** Union of reviewed ids across sessions, de-duplicated. */
	reviewedIds: (sessions: ReviewSession[]): number[] => {
		const ids = new Set<number>();
		for (const s of sessions) for (const id of s.reviewed) ids.add(id);
		return [...ids];
	},
	/** True when the cursor is on the session's first location. */
	isAtStart: (s: ReviewSession): boolean => {
		return Review.index(s) <= 0;
	},
	/** True when the cursor is on the session's last location. */
	isAtEnd: (s: ReviewSession): boolean => {
		const i = Review.index(s);
		return i < 0 || i >= s.order.length - 1;
	},
	/** Current cursor location is in the reviewed set. */
	isCurrentReviewed: (s: ReviewSession): boolean => {
		return s.reviewed.includes(s.cursorId);
	},
	/** Reactive active review session, or null. */
	useSession: (): ReviewSession | null => {
		return useEventValue("review:changed", () => session);
	},
	/** The active review session, or null. */
	session: (): ReviewSession | null => {
		return session;
	},
	/** Start or resume a review over `ids`. When `source` is a selection, re-reviewing
	 *  that selection resumes any in-progress session for it. */
	begin: async (ids: number[], source?: Selection): Promise<void> => {
		const mapId = Store.get().mapId;
		const map = Store.get().map;
		if (!mapId || !map || ids.length === 0) return;

		const sourceKey = source?.key ?? "manual";
		if (source && source.selector.type !== "Manual") {
			try {
				const [existing] = await cmd.storeReviewList(mapId, "active", sourceKey);
				if (existing) {
					await adopt(existing);
					return;
				}
			} catch (e) {
				log.error("[review] resume lookup failed:", e);
			}
		}

		// Freeze the worklist to ids that still exist, in the map's review order.
		const worklist: Selector = { type: "Locations", locations: ids, name: null };
		const order = await Query.read(reviewOrdering(worklist, map.settings.reviewOrder), {
			kind: "ids",
		});
		if (order.length === 0) return;

		const name = source ? selectionDisplayName(source) : t("Selected locations");
		const sourceProps = source?.selector ?? { type: "Manual", locations: order };
		try {
			const [created] = await cmd.storeReviewEdit([
				{
					add: {
						id: "",
						mapId,
						name,
						sourceKey,
						sourceProps,
						order,
						reviewed: [],
						cursorId: order[0],
						status: "active",
						createdAt: "",
						updatedAt: "",
					},
				},
			]);
			setSession(created);
			await gotoCursor(created);
		} catch (e) {
			log.error("[review] create failed:", e);
		}
	},
	/** Review the selected locations. With one active selection, the review belongs to it and
	 *  resumes with it. */
	beginSelected: (): Promise<void> => {
		const active = SelectionList.active();
		const ids = [...Scene.selected()];
		return Review.begin(ids, active.length === 1 ? active[0] : undefined);
	},
	/** Resume a session picked from the resume modal. */
	resume: async (s: ReviewSession): Promise<void> => {
		await adopt(s);
	},
	/** Mark the current location reviewed and step to the next one. */
	next: async (): Promise<void> => {
		if (!session) return;
		const { session: next, done } = Review.advance(session);
		setSession(next);
		if (done) {
			closeSession();
			return;
		}
		await gotoCursor(next);
	},
	/** Step back to the previous location in the session. */
	prev: async (): Promise<void> => {
		if (!session) return;
		const prev = Review.retreat(session);
		if (!prev) return;
		setSession(prev);
		await gotoCursor(prev);
	},
	/** Delete the current location and advance to the next one. Exits the pass if it
	 *  was the last item. */
	deleteCurrent: async (): Promise<void> => {
		if (!session) return;
		const s = session;
		const deleted = s.cursorId;
		const next = Review.prune(s, new Set([deleted])).session;
		if (next && !Review.isAtEnd(s)) {
			setSession(next);
			await gotoCursor(next);
		} else {
			if (next) setSession({ ...next, status: "done" });
			else void deleteSession(s.id);
			closeSession();
		}
		await Location.remove(new Set([deleted]));
	},
	/** Exit the review UI but keep the session resumable (persisted as active). */
	cancel: (): void => {
		if (!session) return;
		closeSession();
	},
	/** Rename a review session. */
	rename: async (id: string, name: string): Promise<void> => {
		const trimmed = name.trim();
		if (!trimmed) return;
		try {
			await cmd.storeReviewEdit([{ put: { id, name: trimmed } }]);
		} catch (e) {
			log.error("[review] rename failed:", e);
			return;
		}
		if (session?.id === id) {
			setSession({ ...session, name: trimmed });
		}
	},
	/** Delete a review session (its progress, not the locations). */
	removeSession: async (id: string): Promise<void> => {
		await deleteSession(id);
		if (session?.id === id) Review.cancel();
	},
	/** Review sessions for the open map, optionally filtered by status. */
	sessions: (status?: "active" | "done"): Promise<ReviewSession[]> => {
		const mapId = Store.get().mapId;
		if (!mapId) return Promise.resolve([]);
		return cmd.storeReviewList(mapId, status ?? null, null);
	},
	/** Select every location marked reviewed across all sessions on this map. */
	selectReviewed: async (): Promise<void> => {
		const ids = Review.reviewedIds(await Review.sessions());
		if (ids.length === 0) return;
		await SelectionList.update(addSelection(reviewSelector(HISTORY_SESSION_ID, "reviewed", ids)));
	},
	/** The locations of review session `s` that are reviewed, or still to review. */
	selector: (s: ReviewSession, mode: ReviewMode): Selector => {
		return reviewSelector(s.id, mode, Review.ids(s, mode));
	},
};
