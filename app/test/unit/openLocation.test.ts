import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
	nearby: [] as { id: number }[],
	held: new Map<number, Promise<void>>(),
	dropped: [] as string[],
	reads: [] as number[],
	missing: new Set<number>(),
	lat: 0,
	edits: 0,
	panoId: "A",
	editError: null as Error | null,
	invalidated: [] as string[],
	runs: [] as {
		target: unknown;
		signal: AbortSignal;
		onPartial?: (rows: Record<string, unknown>[]) => void;
	}[],
	readTargets: [] as unknown[],
	lands: 0,
	autosaving: Promise.resolve() as Promise<void>,
}));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/store/import", () => ({
	Import: {
		staging: () => ({
			preview: {
				keys: { first: 100, len: 2 },
				target: { kind: "pending", name: "staged-by-rust" },
			},
		}),
	},
}));

vi.mock("@/store/autosave", async (original) => {
	const { Autosave } = await original<typeof import("@/store/autosave")>();
	return { Autosave: { ...Autosave, waitForInflight: () => h.autosaving } };
});
vi.mock("@/lib/commands", () => ({
	cmd: {
		storeLandLayer: async () => {
			h.lands++;
			return { version: 5, keys: [] };
		},
		storeEdit: async () => {
			h.edits++;
			if (h.editError) throw h.editError;
			return { mutation: { version: 0, keys: [100] }, invalidated: h.invalidated };
		},
		storeCloseLayer: async (name: string) => {
			h.dropped.push(name);
		},
		storeRead: async (target: unknown, selector: { type: string; locations?: number[] }) => {
			h.readTargets.push(target);
			if (selector.type === "Nearby") {
				return { kind: "locations", locations: { kind: "inline", locations: h.nearby } };
			}
			const ids = selector.locations ?? [];
			h.reads.push(...ids);
			const lat = h.lat;
			await Promise.all(ids.map((id) => h.held.get(id)));
			return {
				kind: "locations",
				rows: {
					kind: "inline",
					locations: ids
						.filter((id) => !h.missing.has(id))
						.map((id) => ({ id, lat, lng: 0, tags: [], panoId: h.panoId })),
				},
			};
		},
	},
}));
vi.mock("@/lib/sv/providers", async (actual) => ({
	...(await actual<typeof import("@/lib/sv/providers")>()),
	enrich: (
		_selector: unknown,
		opts: {
			on: unknown;
			signal: AbortSignal;
			onPartial?: (rows: Record<string, unknown>[]) => void;
		},
	) => {
		h.runs.push({ target: opts.on, signal: opts.signal, onPartial: opts.onPartial });
		return new Promise(() => {});
	},
}));
import { Store } from "@/store/store";
import { Editor } from "@/store/editor";
import type { ChangeEvent, Location, MapMeta } from "@/bindings.gen";
import { emit, subscribe } from "@/lib/events";
import { buildSceneLayers, LOCATION_LAYER_ID } from "@/lib/render/buildSceneLayers";
import { CellManager } from "@/lib/render/CellManager";

const SCENE: Parameters<typeof buildSceneLayers>[1] = {
	markerStyle: "pin",
	markerOpacity: 1,
	selectedOpacity: 1,
	markerSize: 1,
	showPerfectScoreCircle: false,
	scoreMaxError: 0,
	svPanoramas: false,
	svTrail: false,
	svTrailColor: [0, 0, 0],
	svTrailPosition: false,
	panoDotColor: [0, 0, 0],
	panoDotScaled: false,
	openLocationColor: [0, 0, 0],
	importPreviewColor: [0, 0, 0],
	freehandPath: null,
	polygonVertices: null,
};

beforeEach(() => {
	Editor.close();
	h.nearby = [];
	h.held.clear();
	h.dropped = [];
	h.reads = [];
	h.missing.clear();
	h.lat = 0;
	h.edits = 0;
	h.invalidated = [];
	h.editError = null;
	h.panoId = "A";
	h.runs = [];
	h.readTargets = [];
	h.lands = 0;
	h.autosaving = Promise.resolve();
	Store.patch({ mapId: "test-map", map: null });
});

describe("open location", () => {
	it("drops the open row when the duplicate panel takes over", async () => {
		h.nearby = [{ id: 7 }, { id: 8 }];
		await Editor.open(7);

		expect(Editor.get().open).toBeNull();
	});

	it("opening an id with no row leaves the current opening in place", async () => {
		await Editor.open(7);
		const layers = h.dropped.length;
		h.missing.add(9);
		await Editor.open(9);
		expect(Editor.get().open?.id).toBe(7);
		expect(h.dropped).toHaveLength(layers);
		Editor.close();
	});

	it("a refresh that finds the open row deleted closes the opening", async () => {
		await Editor.open(7);
		h.missing.add(7);
		await Editor.refresh();
		expect(Editor.get().open).toBeNull();
		expect(Editor.get().workArea).toBe("overview");
	});

	it("a change that removes the open map location closes it, whatever made the change", async () => {
		await Editor.open(7);
		const change: Omit<ChangeEvent, "removed"> = {
			version: 1,
			patch: [],
			added: [],
			updated: [],
		};
		emit("store:change", { ...change, removed: [8] });
		expect(Editor.get().open?.id).toBe(7);
		emit("store:change", { ...change, removed: [7] });
		expect(Editor.get().open).toBeNull();
		expect(Editor.get().workArea).toBe("overview");
	});

	it("rereads the open location only for a change naming it or a writing-layer flip", async () => {
		await Editor.open(7);
		const change = {
			version: 1,
			patch: [],
			added: [],
			updated: [],
			removed: [],
		} satisfies ChangeEvent;
		const reads = () => h.reads.filter((id) => id === 7).length;
		const before = reads();
		emit("store:change", { ...change, updated: [8] });
		emit("store:change", change);
		await Promise.resolve();
		expect(reads()).toBe(before);
		emit("store:change", { ...change, updated: [7] });
		await vi.waitUntil(() => reads() === before + 1);
		emit("store:change", {
			...change,
			patch: [{ op: "replace", path: "/writingLayers", value: [] }],
		});
		await vi.waitUntil(() => reads() === before + 2);
		Editor.close();
	});

	it("a draft edit shows in the open location with no change from the map", async () => {
		await Editor.open(7);
		h.panoId = "B";
		await Editor.draft().edit({ panoId: "B" });
		expect(Editor.get().open?.location.panoId).toBe("B");
		Editor.close();
	});

	it("opening the location already open keeps its draft", async () => {
		await Editor.open(7);
		const open = Editor.get().open;
		const draft = Editor.draft();
		await Editor.open(7);
		expect(Editor.get().open).toBe(open);
		expect(Editor.draft()).toBe(draft);
		expect(h.dropped).toEqual([]);
		Editor.close();
	});

	it("a draft that walks away keeps where the opening began", async () => {
		await Editor.open(7);
		h.panoId = "B";
		h.lat = 5;
		await Editor.draft().edit({ panoId: "B", lat: 5 });
		expect(Editor.get().open?.location).toMatchObject({ panoId: "B", lat: 5 });
		expect(Editor.get().open?.spawn).toMatchObject({ id: 7, panoId: "A", lat: 0 });
		Editor.close();
	});

	it("the open-location pin stays where the opening began while the draft walks", async () => {
		Store.patch({ map: { id: "test-map" } as MapMeta });
		await Editor.open(7);
		h.lat = 5;
		await Editor.draft().edit({ panoId: "B", lat: 5 });
		const pin = buildSceneLayers(new CellManager(), SCENE).find(
			(layer) => layer.id === `${LOCATION_LAYER_ID}-current-sdf`,
		);
		expect(pin?.props.data).toEqual([expect.objectContaining({ id: 7, lat: 0 })]);
		Editor.close();
	});

	it("drops the open row when leaving the location pane", async () => {
		await Editor.open(7);
		expect(Editor.get().open?.location?.id).toBe(7);

		Editor.setArea("plugin");

		expect(Editor.get().open).toBeNull();
	});

	it("a slow switch that lands after a newer one leaves the newer location active", async () => {
		let release!: () => void;
		h.held.set(7, new Promise((r) => (release = r)));
		const slow = Editor.open(7);
		await Editor.open(8);
		release();
		await slow;

		expect(Editor.get().open?.id).toBe(8);
		expect(Editor.get().open?.location?.id).toBe(8);
		Editor.setArea("overview");
	});

	it("a slow preview that lands after a newer opening drops its layer instead of opening", async () => {
		let release!: () => void;
		h.held.set(100, new Promise((r) => (release = r)));
		Editor.preview({ id: 0, lat: 0, lng: 0, tags: [] } as unknown as Location);
		await Editor.open(8);
		release();
		await vi.waitUntil(() => h.dropped.length > 0);

		expect(Editor.get().open?.id).toBe(8);
		expect(h.dropped).toEqual([expect.stringMatching(/^layer:/)]);
		Editor.setArea("overview");
	});

	it("opening a location from the duplicate panel announces it like any opening", async () => {
		const seen: (number | null)[] = [];
		const unsub = subscribe("open:change", (id) => seen.push(id));
		await Editor.openDuplicate({ id: 9, lat: 0, lng: 0, tags: [] } as unknown as Location);
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

	it("a pending location read cannot reopen the editor after switching panes", async () => {
		let release!: () => void;
		h.held.set(7, new Promise((resolve) => (release = resolve)));
		const opening = Editor.open(7);
		Editor.setArea("overview");
		release();
		await opening;

		expect(Editor.get().open).toBeNull();
		expect(Editor.get().workArea).toBe("overview");
	});

	it("reads a staged import location through the layer the preview names", async () => {
		await Editor.openImport(0);

		expect(h.reads).toContain(100);
		expect(h.readTargets).toContainEqual({ kind: "pending", name: "staged-by-rust" });
		Editor.setArea("overview");
	});

	it("a slow import read cannot open a preview after a newer location opens", async () => {
		let release!: () => void;
		h.held.set(101, new Promise((resolve) => (release = resolve)));
		const preview = Editor.openImport(1);
		await Editor.open(8);
		release();
		await preview;

		expect(Editor.get().open?.id).toBe(8);
		expect(h.dropped).toEqual([expect.stringMatching(/^layer:/)]);
		Editor.setArea("overview");
	});

	it("a pending location read cannot reopen the editor after it is cleared", async () => {
		let release!: () => void;
		h.held.set(8, new Promise((resolve) => (release = resolve)));
		const switching = Editor.open(8);
		Editor.close();
		release();
		await switching;

		expect(Editor.get().open).toBeNull();
		expect(Editor.get().workArea).toBe("overview");
	});

	it("a read from an earlier opening cannot update a reopening of the same location", async () => {
		await Editor.open(7);
		h.lat = 99;
		let release!: () => void;
		h.held.set(
			7,
			new Promise((resolve) => {
				release = resolve;
			}),
		);
		const count = h.reads.length;
		const reading = Editor.refresh();
		await vi.waitUntil(() => h.reads.length > count);
		h.held.delete(7);
		h.lat = 0;
		Editor.close();
		await Editor.open(7);
		release();
		await reading;
		expect(Editor.get().open?.location?.lat).toBe(0);
		Editor.close();
	});

	it("callbacks retained from an earlier opening cannot edit or save a reopening", async () => {
		await Editor.open(7);
		const { edit, save } = Editor.draft();
		Editor.close();
		await Editor.open(7);
		const count = h.edits;
		await edit({ lat: 99 });
		expect(await save({ lat: 99 })).toBeNull();
		expect(h.edits).toBe(count);
		expect(Editor.get().open?.location?.lat).toBe(0);
		Editor.close();
	});

	it("a draft retained from one opening resolves null once another location opens", async () => {
		await Editor.open(7);
		const retained = Editor.draft();
		await Editor.open(8);
		const count = h.edits;
		expect(await retained.edit({ lat: 99 })).toBeNull();
		expect(await retained.save({ lat: 99 })).toBeNull();
		expect(h.edits).toBe(count);
		expect(Editor.draft()).not.toBe(retained);
		Editor.close();
	});

	it("callbacks stay stable through refreshes and become inert on close", async () => {
		await Editor.open(7);
		const { edit, save } = Editor.draft();
		await Editor.refresh();
		expect(Editor.draft().edit).toBe(edit);
		expect(Editor.draft().save).toBe(save);
		Editor.close();
		const count = h.edits;
		await edit({ lat: 99 });
		expect(await save({ lat: 99 })).toBeNull();
		expect(h.edits).toBe(count);
		expect(Editor.get().open).toBeNull();
	});

	it("switching locations keeps the current one open until the next has its row", async () => {
		await Editor.open(7);
		const seen: { id: number; row: boolean }[] = [];
		const unsub = subscribe("snapshot:changed", () => {
			const open = Editor.get().open;
			if (open) seen.push({ id: open.id, row: open.location != null });
		});
		let release!: () => void;
		h.held.set(8, new Promise((r) => (release = r)));

		const switching = Editor.open(8);
		expect(Editor.get().open?.id).toBe(7);
		release();
		await switching;
		unsub();

		expect(seen.every((s) => s.row)).toBe(true);
		expect(Editor.get().open?.location?.id).toBe(8);
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
		expect(Editor.get().open).toBeNull();
	});
});

afterEach(() => Editor.close());

describe("editor-owned enrichment", () => {
	function settings(enrichMetadata = true, enrichFields: string[] | null = null) {
		Store.patch({ map: { settings: { enrichMetadata, enrichFields } } as unknown as MapMeta });
	}
	it("starts without a viewer and ignores unrelated edits and settings changes", async () => {
		settings(true, ["datetime"]);
		await Editor.open(7);
		await vi.waitUntil(() => h.runs.length === 1);
		expect(h.runs[0].target).toEqual(Editor.get().open?.layer.target);
		h.lat = 5;
		await Editor.refresh();
		settings(true, ["countryCode"]);
		Editor.setArea("location");
		expect(h.runs).toHaveLength(1);
		expect(h.runs[0].signal.aborted).toBe(false);
	});
	it("supersedes a run when a draft edit makes derived fields stale", async () => {
		settings();
		await Editor.open(7);
		await vi.waitUntil(() => h.runs.length === 1);
		h.invalidated = ["imageDate"];
		await Editor.draft().edit({ panoId: "B" });
		await vi.waitUntil(() => h.runs.length === 2);
		expect(h.runs[0].signal.aborted).toBe(true);
		expect(h.runs[1].signal.aborted).toBe(false);
	});
	it("a draft edit that makes nothing stale starts no run", async () => {
		settings();
		await Editor.open(7);
		await vi.waitUntil(() => h.runs.length === 1);
		h.panoId = "B";
		await Editor.draft().edit({ flags: 1 });
		expect(h.runs).toHaveLength(1);
		expect(h.runs[0].signal.aborted).toBe(false);
	});
	it("reads the enabled setting when a stale draft would start a run", async () => {
		settings();
		await Editor.open(7);
		await vi.waitUntil(() => h.runs.length === 1);
		settings(false);
		expect(h.runs[0].signal.aborted).toBe(false);
		h.invalidated = ["imageDate"];
		await Editor.draft().edit({ panoId: "B" });
		expect(h.runs[0].signal.aborted).toBe(true);
		expect(h.runs).toHaveLength(1);
	});
	it("shows each provider's fields in the open location as they arrive, before the run ends", async () => {
		settings();
		await Editor.open(7);
		await vi.waitUntil(() => h.runs.length === 1);
		h.runs[0].onPartial?.([
			{ id: 7, lat: 0, lng: 0, tags: [], panoId: "A", extra: { imageDate: "2012-08" } },
		]);
		await vi.waitUntil(() => Editor.get().open?.location.extra?.imageDate === "2012-08");
		expect(h.runs[0].signal.aborted).toBe(false);
	});
	it("leaves saved writers to the engine when closing or switching openings", async () => {
		settings();
		await Editor.open(7);
		await vi.waitUntil(() => h.runs.length === 1);
		const first = h.runs[0];
		await Editor.draft().save({ heading: 30 });
		Editor.close();
		expect(first.signal.aborted).toBe(false);
		await Editor.open(8);
		await vi.waitUntil(() => h.runs.length === 2);
		expect(h.runs).toHaveLength(2);
		await Editor.open(9);
		await vi.waitUntil(() => h.runs.length === 3);
		expect(h.runs).toHaveLength(3);
		expect(h.runs[1].signal.aborted).toBe(false);
		expect(h.dropped.length).toBeGreaterThan(0);
	});
	it("a save resolves once the map accepts it, before an autosave in flight finishes", async () => {
		settings(false);
		await Editor.open(7);
		h.autosaving = new Promise(() => {});
		const edits = h.edits;
		const saving = Editor.draft().save({ heading: 30 });
		const later = new Promise((resolve) => setTimeout(() => resolve("pending"), 100));
		expect(await Promise.race([saving, later])).toBe(7);
		expect(h.edits - edits).toBe(1);
		expect(h.lands).toBe(1);
	});
	it("logs edit and save failures and resolves null", async () => {
		const { log } = await import("@/lib/util/log");
		settings(false);
		await Editor.open(7);
		h.editError = new Error("write failed");
		await expect(Editor.draft().edit({ heading: 30 })).resolves.toBeNull();
		expect(log.error).toHaveBeenCalledWith("[editor] edit failed:", h.editError);
		await expect(Editor.draft().save({ heading: 30 })).resolves.toBeNull();
		expect(log.error).toHaveBeenCalledWith("[editor] save failed:", h.editError);
	});
});

describe("editor-owned state", () => {
	it("lives on Editor, announces its changes, and is not part of Store", async () => {
		const changed: string[] = [];
		const off = subscribe("editor:changed", () => changed.push(Editor.get().workArea));
		Editor.setArea("diff");
		off();
		expect(changed).toContain("diff");
		expect(Editor.get().workArea).toBe("diff");
		expect("workArea" in Store.get()).toBe(false);
		expect("open" in Store.get()).toBe(false);
		// @ts-expect-error editor state is not writable through Store
		const writeThroughStore = () => Store.patch({ open: null });
		void writeThroughStore;
		Editor.setArea("overview");
	});
});
