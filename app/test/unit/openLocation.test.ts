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
				return { kind: "locations", locations: { kind: "inline", locations: h.nearby } };
			}
			const ids = selector.locations ?? [];
			await Promise.all(ids.map((id) => h.held.get(id)));
			return {
				kind: "locations",
				rows: {
					kind: "inline",
					locations: ids.map((id) => ({ id, lat: 0, lng: 0, tags: [] })),
				},
			};
		},
	},
}));

import {
	closeLocation,
	openLocation,
	setWorkArea,
	getMapState,
	setOpenLocation,
} from "@/store/useMapStore";
import type { Location } from "@/bindings.gen";
import { subscribe } from "@/lib/events";

beforeEach(() => {
	h.nearby = [];
	h.held.clear();
});

describe("open location", () => {
	it("drops the open row when the duplicate panel takes over", async () => {
		h.nearby = [{ id: 7 }, { id: 8 }];
		await openLocation(7);

		expect(getMapState().open).toBeNull();
	});

	it("drops the open row when leaving the location pane", async () => {
		await openLocation(7);
		expect(getMapState().open?.location?.id).toBe(7);

		setWorkArea("plugin");

		expect(getMapState().open).toBeNull();
	});

	it("a slow switch that lands after a newer one leaves the newer location active", async () => {
		let release!: () => void;
		h.held.set(7, new Promise((r) => (release = r)));
		const slow = openLocation(7);
		await openLocation(8);
		release();
		await slow;

		expect(getMapState().open?.id).toBe(8);
		expect(getMapState().open?.location?.id).toBe(8);
		setWorkArea("overview");
	});

	it("emits open:change exactly once per close, and not when nothing was open", async () => {
		const seen: (number | null)[] = [];
		const unsub = subscribe("open:change", (id) => seen.push(id));

		await openLocation(7);
		setWorkArea("plugin");
		setWorkArea("overview");

		unsub();
		expect(seen).toEqual([7, null]);
	});

	it("a pending location read cannot reopen the editor after it is cleared", async () => {
		let release!: () => void;
		h.held.set(8, new Promise((resolve) => (release = resolve)));
		const switching = setActiveLocation(8);
		await setActiveLocation(null);
		release();
		await switching;

		expect(getMapState().open).toBeNull();
		expect(getMapState().workArea).toBe("overview");
	});

	it("a row read for an earlier opening never lands on a reopening of the same location", async () => {
		await openLocation(7);
		const earlier = getMapState().open!.session;
		await openLocation(7);

		setOpenLocation({ id: 7, lat: 99, lng: 0, tags: [] } as unknown as Location, earlier);

		expect(getMapState().open?.location?.lat).toBe(0);
		setWorkArea("overview");
	});

	it("switching locations keeps the current one open until the next has its row", async () => {
		await openLocation(7);
		const seen: { id: number; row: boolean }[] = [];
		const unsub = subscribe("store:changed", () => {
			const open = getMapState().open;
			if (open) seen.push({ id: open.id, row: open.location != null });
		});
		let release!: () => void;
		h.held.set(8, new Promise((r) => (release = r)));

		const switching = openLocation(8);
		expect(getMapState().open?.id).toBe(7);
		release();
		await switching;
		unsub();

		expect(seen.every((s) => s.row)).toBe(true);
		expect(getMapState().open?.location?.id).toBe(8);
		setWorkArea("overview");
	});
});

describe("closing the open location", () => {
	it("supersedes an opening still loading", async () => {
		let release!: () => void;
		h.held.set(
			7,
			new Promise<void>((r) => {
				release = r;
			}),
		);
		const opening = openLocation(7, false);
		closeLocation();
		release();
		await opening;

		expect(getMapState().open).toBeNull();
	});
});

describe("legacy open shims", () => {
	it("forwards open:change as active:change and maps null to close", async () => {
		const { setActiveLocation } = await import("@/legacy");
		const seen: (number | null)[] = [];
		const unsub = subscribe("active:change", (id) => seen.push(id));
		await setActiveLocation(7, false);
		await setActiveLocation(null);
		unsub();

		expect(seen).toEqual([7, null]);
		expect(getMapState().open).toBeNull();
	});
});
