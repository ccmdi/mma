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
		storeOpenMap: async () => {
			const opened = openMapResult();
			opened.values.locationCount = 5;
			return opened;
		},
		storeWork: async (...args: unknown[]) => {
			const [selector, work] = args as [
				Selector,
				{ kind: string; distance: number; score: string | null },
			];
			h.calls.push({ selector, distance: work.distance, score: work.score });
			return {
				mutation: {
					version: 1,
					selectionSync: null,
					step: null,
					active: null,
					firstId: null,
					values: { locationCount: 3 },
				},
				changed: 0,
				failed: [],
			};
		},
	});
});
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/lib/render/sceneStore", () => ({
	clearScene: () => {},
	loadScene: async () => {},
	whenSceneSettled: async () => {},
	sceneReached: async (version: number) => ({
		version,
		replace: false,
		added: new Uint32Array(0),
		removed: new Uint32Array(0),
	}),
}));
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

	it("reports how many rows the prune took off the map", async () => {
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
