import { describe, it, expect, vi } from "vitest";

// review.ts pulls in the store graph for its side-effectful API; stub it so the
// pure helpers (the part under test) load in isolation.
vi.mock("@/store/useMapStore", () => ({
	getMapState: () => ({ mapId: null, map: null, activeLocation: null }),
	setActiveLocation: vi.fn(),
	addSelections: vi.fn(),
	mutate: vi.fn(),
}));
vi.mock("@/lib/commands", () => ({ cmd: {} }));
vi.mock("@/lib/events", () => ({ subscribe: () => () => {}, emit: vi.fn() }));
vi.mock("@/store/selections", () => ({ selectionDisplayName: () => "x" }));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import {
	pruneSession,
	advance,
	retreat,
	reviewIndex,
	isAtStart,
	isCurrentReviewed,
	reviewedHistoryIds,
	type ReviewSession,
} from "@/lib/review/review";

function mk(order: number[], cursorId: number, reviewed: number[] = []): ReviewSession {
	return {
		id: "s",
		mapId: "m",
		name: "n",
		sourceKey: "k",
		sourceProps: null,
		order,
		reviewed,
		cursorId,
		status: "active",
		createdAt: "",
		updatedAt: "",
	};
}

describe("pruneSession (the desync invariant)", () => {
	it("deleting any non-cursor location never moves the cursor", () => {
		const s = mk([1, 2, 3, 4, 5], 3, [1, 2]);
		const { session, cursorMoved } = pruneSession(s, new Set([2, 4]));
		expect(cursorMoved).toBe(false);
		expect(session?.cursorId).toBe(3);
		expect(session?.order).toEqual([1, 3, 5]);
		expect(session?.reviewed).toEqual([1]);
	});

	it("returns the same reference when nothing overlaps the worklist", () => {
		const s = mk([1, 2, 3], 2);
		const r = pruneSession(s, new Set([99]));
		expect(r.session).toBe(s);
		expect(r.cursorMoved).toBe(false);
	});

	it("advances cursor to the next survivor when the cursor itself is deleted", () => {
		const s = mk([1, 2, 3, 4, 5], 3);
		const { session, cursorMoved } = pruneSession(s, new Set([3]));
		expect(cursorMoved).toBe(true);
		expect(session?.cursorId).toBe(4);
		expect(session?.order).toEqual([1, 2, 4, 5]);
	});

	it("clamps to the last item when the deleted cursor was last", () => {
		const s = mk([1, 2, 3], 3);
		const { session } = pruneSession(s, new Set([3]));
		expect(session?.cursorId).toBe(2);
	});

	it("returns null when the worklist empties", () => {
		const s = mk([1], 1, [1]);
		const { session } = pruneSession(s, new Set([1]));
		expect(session).toBeNull();
	});
});

describe("reviewedHistoryIds (cross-session union)", () => {
	it("unions reviewed ids across sessions and de-duplicates", () => {
		const a = mk([1, 2, 3], 3, [1, 2]);
		const b = mk([2, 4, 5], 5, [2, 4]);
		expect(reviewedHistoryIds([a, b]).sort((x, y) => x - y)).toEqual([1, 2, 4]);
	});

	it("ignores the worklist; only reviewed ids count", () => {
		const s = mk([1, 2, 3], 1, []);
		expect(reviewedHistoryIds([s])).toEqual([]);
	});

	it("returns empty for no sessions", () => {
		expect(reviewedHistoryIds([])).toEqual([]);
	});
});

describe("advance / retreat", () => {
	it("advance marks the current location reviewed and steps to next", () => {
		const { session, done } = advance(mk([1, 2, 3], 1));
		expect(done).toBe(false);
		expect(session.cursorId).toBe(2);
		expect(session.reviewed).toContain(1);
	});

	it("advance on the last item marks reviewed and reports done", () => {
		const { session, done } = advance(mk([1, 2], 2, [1]));
		expect(done).toBe(true);
		expect(session.status).toBe("done");
		expect(session.reviewed).toContain(2);
	});

	it("advance does not duplicate an already-reviewed id", () => {
		const { session } = advance(mk([1, 2, 3], 1, [1]));
		expect(session.reviewed.filter((x) => x === 1)).toHaveLength(1);
	});

	it("retreat steps back without marking reviewed, and is null at the start", () => {
		const prev = retreat(mk([1, 2, 3], 2));
		expect(prev?.cursorId).toBe(1);
		expect(prev?.reviewed).toEqual([]);
		expect(retreat(mk([1, 2, 3], 1))).toBeNull();
	});
});

describe("helpers", () => {
	it("reviewIndex / isAtStart / isCurrentReviewed", () => {
		expect(reviewIndex(mk([1, 2, 3], 2))).toBe(1);
		expect(isAtStart(mk([1, 2, 3], 1))).toBe(true);
		expect(isAtStart(mk([1, 2, 3], 2))).toBe(false);
		expect(isCurrentReviewed(mk([1, 2, 3], 2, [2]))).toBe(true);
		expect(isCurrentReviewed(mk([1, 2, 3], 2, [1]))).toBe(false);
	});
});
