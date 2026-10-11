import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
	nearby: [] as { id: number }[],
	held: new Map<number, Promise<void>>(),
	dropped: [] as string[],
}));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

vi.mock("@/lib/commands", () => ({
	cmd: {
		storeEdit: async () => ({ mutation: { version: 0, keys: [100] } }),
		storeDrop: async (name: string) => {
			h.dropped.push(name);
		},
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
import { Store } from "@/store/store";
import { Editor } from "@/store/editor";
import type { Location } from "@/bindings.gen";
import { subscribe } from "@/lib/events";

beforeEach(() => {
	h.nearby = [];
	h.held.clear();
	h.dropped = [];
});

describe("open location", () => {
	it("drops the open row when the duplicate panel takes over", async () => {
		h.nearby = [{ id: 7 }, { id: 8 }];
		await Editor.open(7);

		expect(Store.get().open).toBeNull();
	});

	it("drops the open row when leaving the location pane", async () => {
		await Editor.open(7);
		expect(Store.get().open?.location?.id).toBe(7);

		Editor.setArea("plugin");

		expect(Store.get().open).toBeNull();
	});

	it("a slow switch that lands after a newer one leaves the newer location active", async () => {
		let release!: () => void;
		h.held.set(7, new Promise((r) => (release = r)));
		const slow = Editor.open(7);
		await Editor.open(8);
		release();
		await slow;

		expect(Store.get().open?.id).toBe(8);
		expect(Store.get().open?.location?.id).toBe(8);
		Editor.setArea("overview");
	});

	it("a slow preview that lands after a newer opening drops its layer instead of opening", async () => {
		let release!: () => void;
		h.held.set(100, new Promise((r) => (release = r)));
		Editor.preview({ id: 0, lat: 0, lng: 0, tags: [] } as unknown as Location);
		await Editor.open(8);
		release();
		await vi.waitUntil(() => h.dropped.length > 0);

		expect(Store.get().open?.id).toBe(8);
		expect(h.dropped).toEqual([expect.stringMatching(/^viewer:/)]);
		Editor.setArea("overview");
	});

	it("opening a location from the duplicate panel announces it like any opening", () => {
		const seen: (number | null)[] = [];
		const unsub = subscribe("open:change", (id) => seen.push(id));
		Editor.openDuplicate({ id: 9, lat: 0, lng: 0, tags: [] } as unknown as Location);
		Editor.setArea("overview");
		unsub();
		expect(seen).toEqual([9, null]);
	});

	it("emits open:change exactly once per close, and not when nothing was open", async () => {
		const seen: (number | null)[] = [];
		const unsub = subscribe("open:change", (id) => seen.push(id));

		await Editor.open(7);
		Editor.setArea("plugin");
		Editor.setArea("overview");

		unsub();
		expect(seen).toEqual([7, null]);
	});

	it("a pending location read cannot reopen the editor after it is cleared", async () => {
		let release!: () => void;
		h.held.set(8, new Promise((resolve) => (release = resolve)));
		const switching = Editor.open(8);
		Editor.close();
		release();
		await switching;

		expect(Store.get().open).toBeNull();
		expect(Store.get().workArea).toBe("overview");
	});

	it("a row read for an earlier opening never lands on a reopening of the same location", async () => {
		await Editor.open(7);
		const earlier = Store.get().open!.session;
		await Editor.open(7);

		Editor.setLocation({ id: 7, lat: 99, lng: 0, tags: [] } as unknown as Location, earlier);

		expect(Store.get().open?.location?.lat).toBe(0);
		Editor.setArea("overview");
	});

	it("switching locations keeps the current one open until the next has its row", async () => {
		await Editor.open(7);
		const seen: { id: number; row: boolean }[] = [];
		const unsub = subscribe("store:changed", () => {
			const open = Store.get().open;
			if (open) seen.push({ id: open.id, row: open.location != null });
		});
		let release!: () => void;
		h.held.set(8, new Promise((r) => (release = r)));

		const switching = Editor.open(8);
		expect(Store.get().open?.id).toBe(7);
		release();
		await switching;
		unsub();

		expect(seen.every((s) => s.row)).toBe(true);
		expect(Store.get().open?.location?.id).toBe(8);
		Editor.setArea("overview");
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
		expect(Store.get().open).toBeNull();
	});
});
