import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
	nearby: [] as { id: number }[],
	held: new Map<number, Promise<void>>(),
}));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

vi.mock("@/lib/commands", () => ({
	cmd: {
		storeRead: async (_target: unknown, selector: { type: string; locations?: number[] }) => {
			if (selector.type === "Nearby") {
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

import { setActiveLocation, setWorkArea, getMapState, setOpenRow } from "@/store/useMapStore";
import type { Location } from "@/bindings.gen";
import { subscribe } from "@/lib/events";

beforeEach(() => {
	h.nearby = [];
	h.held.clear();
});

describe("active location", () => {
	it("drops the open row when the duplicate panel takes over", async () => {
		h.nearby = [{ id: 7 }, { id: 8 }];
		await setActiveLocation(7);

		expect(getMapState().open).toBeNull();
	});

	it("drops the open row when leaving the location pane", async () => {
		await setActiveLocation(7);
		expect(getMapState().open?.row?.id).toBe(7);

		setWorkArea("plugin");

		expect(getMapState().open).toBeNull();
	});

	it("a slow switch that lands after a newer one leaves the newer location active", async () => {
		let release!: () => void;
		h.held.set(7, new Promise((r) => (release = r)));
		const slow = setActiveLocation(7);
		await setActiveLocation(8);
		release();
		await slow;

		expect(getMapState().open?.id).toBe(8);
		expect(getMapState().open?.row?.id).toBe(8);
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

	it("a row read for an earlier opening never lands on a reopening of the same location", async () => {
		await setActiveLocation(7);
		const earlier = getMapState().open!.session;
		await setActiveLocation(7);

		setOpenRow({ id: 7, lat: 99, lng: 0, tags: [] } as unknown as Location, earlier);

		expect(getMapState().open?.row?.lat).toBe(0);
		setWorkArea("overview");
	});

	it("switching locations keeps the current one open until the next has its row", async () => {
		await setActiveLocation(7);
		const seen: { id: number; row: boolean }[] = [];
		const unsub = subscribe("store:changed", () => {
			const open = getMapState().open;
			if (open) seen.push({ id: open.id, row: open.row != null });
		});
		let release!: () => void;
		h.held.set(8, new Promise((r) => (release = r)));

		const switching = setActiveLocation(8);
		expect(getMapState().open?.id).toBe(7);
		release();
		await switching;
		unsub();

		expect(seen.every((s) => s.row)).toBe(true);
		expect(getMapState().open?.row?.id).toBe(8);
		setWorkArea("overview");
	});
});
