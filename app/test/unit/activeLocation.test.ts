import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
	nearby: [] as { id: number }[],
	held: new Map<number, Promise<void>>(),
}));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

vi.mock("@/lib/commands", () => ({
	cmd: {
		storeRead: async (selector: { locations?: number[] }, pick: { kind: string } | null) => {
			if (pick?.kind === "nearby") {
				return { kind: "rows", rows: { kind: "inline", locations: h.nearby } };
			}
			const ids = selector.locations ?? [];
			await Promise.all(ids.map((id) => h.held.get(id)));
			return {
				kind: "rows",
				rows: {
					kind: "inline",
					locations: ids.map((id) => ({ id, lat: 0, lng: 0, tags: [] })),
				},
			};
		},
	},
}));

import { setActiveLocation, setWorkArea, getMapState } from "@/store/useMapStore";
import { subscribe } from "@/lib/events";

beforeEach(() => {
	h.nearby = [];
	h.held.clear();
});

describe("active location", () => {
	it("drops the open row when the duplicate panel takes over", async () => {
		h.nearby = [{ id: 7 }, { id: 8 }];
		await setActiveLocation(7);

		expect(getMapState().openRow).toBeNull();
	});

	it("drops the open row when leaving the location pane", async () => {
		await setActiveLocation(7);
		expect(getMapState().openRow?.id).toBe(7);

		setWorkArea("plugin");

		expect(getMapState().openRow).toBeNull();
	});

	it("a slow switch that lands after a newer one leaves the newer location active", async () => {
		let release!: () => void;
		h.held.set(7, new Promise((r) => (release = r)));
		const slow = setActiveLocation(7);
		await setActiveLocation(8);
		release();
		await slow;

		expect(getMapState().openId).toBe(8);
		expect(getMapState().openRow?.id).toBe(8);
		setWorkArea("overview");
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
