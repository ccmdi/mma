import { describe, expect, it, vi } from "vitest";
import type { SeenEntry } from "@/bindings.gen";

const h = vi.hoisted(() => ({ release: null as ((rows: SeenEntry[]) => void) | null }));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/store/query", () => ({ Query: { read: async () => [] } }));
vi.mock("@/store/editor", () => ({ Editor: {} }));
vi.mock("@/lib/seen/seen", () => ({
	Seen: {
		count: async () => 1,
		entries: () => new Promise<SeenEntry[]>((resolve) => (h.release = resolve)),
	},
}));

import { subscribe } from "@/lib/events";
import {
	getSeenOverlayEntries,
	isSeenOverlayActive,
	toggleSeenOverlay,
} from "@/lib/seen/seenOverlay";

describe("seen overlay", () => {
	it("a load still pending when the overlay turns off never fills it", async () => {
		toggleSeenOverlay();
		await vi.waitUntil(() => h.release);
		toggleSeenOverlay();
		const changes = vi.fn();
		const off = subscribe("seen:changed", changes);
		h.release!([{ id: 1, locationId: null, panoId: "p" } as SeenEntry]);
		await new Promise((resolve) => setTimeout(resolve));
		off();
		expect(isSeenOverlayActive()).toBe(false);
		expect(getSeenOverlayEntries()).toEqual([]);
		expect(changes).not.toHaveBeenCalled();
	});
});
