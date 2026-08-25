import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
	setActiveCalls: [] as (number | null)[],
	nearby: [] as { id: number }[],
}));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

vi.mock("@/lib/commands", () => ({
	cmd: {
		storeSetActive: (id: number | null) => {
			h.setActiveCalls.push(id);
			return Promise.resolve(null);
		},
		storeQuery: (scope: { kind: string; ids?: number[] }) =>
			Promise.resolve({
				kind: "rows",
				locations: (scope.ids ?? []).map((id) => ({ id, lat: 0, lng: 0, tags: [] })),
			}),
		storeFindNearby: () => Promise.resolve(h.nearby),
	},
}));

import { setActiveLocation, setWorkArea, getMapState } from "@/store/useMapStore";
import { subscribe } from "@/lib/events";

beforeEach(() => {
	h.setActiveCalls = [];
	h.nearby = [];
});

describe("active location keeps Rust's active_id in step", () => {
	it("pushes null to Rust when the duplicate panel takes over", async () => {
		h.nearby = [{ id: 7 }, { id: 8 }];
		await setActiveLocation(7);

		expect(getMapState().activeLocation).toBeNull();
		expect(h.setActiveCalls).toEqual([7, null]);
	});

	it("pushes null to Rust when leaving the location pane", async () => {
		await setActiveLocation(7);
		expect(getMapState().activeLocation?.id).toBe(7);

		h.setActiveCalls = [];
		setWorkArea("plugin");

		expect(getMapState().activeLocation).toBeNull();
		expect(h.setActiveCalls).toEqual([null]);
	});

	it("does not push a redundant null when nothing was active", () => {
		setWorkArea("overview");
		expect(h.setActiveCalls).toEqual([]);
	});

	it("emits active:change exactly once per clear, and not when nothing was active", async () => {
		const seen: (number | null)[] = [];
		const unsub = subscribe("active:change", (id) => seen.push(id));

		await setActiveLocation(7);
		setWorkArea("plugin");
		setWorkArea("overview");

		unsub();
		expect(seen).toEqual([7, null]);
	});
});
