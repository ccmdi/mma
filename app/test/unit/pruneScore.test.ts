import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Selector } from "@/bindings.gen";

// Prune destroys rows, so which one survives is the whole contract. The ranking itself is
// Rust's; what nothing covered is whether the JS side hands it the map's own formula at
// all. A typo here silently reverts every prune to the built-in default.
const h = vi.hoisted(() => ({
	calls: [] as { selector: Selector; distance: number; score: string | null }[],
	duplicateScore: null as string | null,
}));

vi.mock("@/lib/commands", async () => {
	const { cmdProxy, testMap, openMapResult } = await import("./fixtures/mocks");
	return cmdProxy({
		storeGetMap: async () => ({
			...testMap(),
			settings: h.duplicateScore === null ? {} : { duplicateScore: h.duplicateScore },
		}),
		storeOpenMap: async () => openMapResult(),
		storePruneDuplicates: async (selector: Selector, distance: number, score: string | null) => {
			h.calls.push({ selector, distance, score });
			return {
				version: 0,
				delta: { added: [], updated: [], removed: [1, 2], fullReset: false },
				selectionSync: null,
				locationCount: null,
				canUndo: null,
				canRedo: null,
				tagCounts: null,
				tags: null,
				fieldDefs: null,
			};
		},
	});
});
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
// closeMap announces itself to the other windows; there is no Tauri to announce to here.
vi.mock("@tauri-apps/api/event", () => ({ emit: async () => {}, listen: async () => () => {} }));

import { openMap, closeMap, pruneDuplicates } from "@/store/useMapStore";

beforeEach(() => {
	h.calls.length = 0;
});

describe("pruneDuplicates hands Rust the map's duplicate preference", () => {
	it("forwards the map's formula when it states one", async () => {
		h.duplicateScore = "tagCount * 2";
		await openMap("m1");
		await pruneDuplicates({ type: "Everything" }, 25);
		expect(h.calls[0].score).toBe("tagCount * 2");
	});

	it("forwards null when the map states none, so Rust applies its own default", async () => {
		h.duplicateScore = null;
		await openMap("m1");
		await pruneDuplicates({ type: "Everything" }, 25);
		expect(h.calls[0].score).toBeNull();
	});

	it("passes the caller's selector and distance through untouched", async () => {
		h.duplicateScore = "heading";
		await openMap("m1");
		const selector: Selector = { type: "Locations", locations: [7, 9], name: null };
		await pruneDuplicates(selector, 120);
		expect(h.calls[0].selector).toEqual(selector);
		expect(h.calls[0].distance).toBe(120);
	});

	it("reports the rows Rust removed", async () => {
		h.duplicateScore = null;
		await openMap("m1");
		expect(await pruneDuplicates({ type: "Everything" }, 25)).toBe(2);
	});

	it("does nothing with no map open", async () => {
		await closeMap();
		expect(await pruneDuplicates({ type: "Everything" }, 25)).toBe(0);
		expect(h.calls).toHaveLength(0);
	});
});
