// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, useState } from "react";
import { mount } from "./fixtures/harness";
import { createLocation } from "@/types";
import type { Location } from "@/bindings.gen";

const h = vi.hoisted(() => ({
	activeLocation: null as unknown,
	/** The map's per-save enrichment switch; off means `enrich` hands the row back untouched. */
	enrichOn: true,
	/** When set, `enrich` rejects instead of answering. */
	enrichFails: false,
	/** When set, `enrich` never answers, as a slow provider mid-run. */
	enrichHangs: false,
	/** Rows `enrich` was handed, in order. */
	enriched: [] as Location[],
	written: [] as { id: number; patch: { extra?: Record<string, unknown> } }[],
}));

vi.mock("@/store/useMapStore", () => ({
	useMapState: (sel: (s: { activeLocation: unknown; map: unknown }) => unknown) =>
		sel({ activeLocation: h.activeLocation, map: { settings: {} } }),
	updateLocations: async (updates: typeof h.written) => {
		h.written.push(...updates);
	},
}));
// Enrichment answers the row with one field derived from its pano.
vi.mock("@/lib/sv/enrich", () => ({
	enrich: async (loc: Location) => {
		h.enriched.push(loc);
		if (h.enrichHangs) return new Promise<Location>(() => {});
		if (h.enrichFails) throw new Error("network");
		if (!h.enrichOn) return loc;
		return { ...loc, extra: { ...loc.extra, enriched: loc.panoId } };
	},
}));
// The one provider field in this harness, `enriched`, derives from the pano.
vi.mock("@/lib/data/fieldDefs", () => ({
	withoutDerivedFrom: (extra: Record<string, unknown> | null, changed: string[]) =>
		extra && changed.includes("panoId")
			? Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "enriched"))
			: extra,
}));
vi.mock("@/lib/sv/query", () => ({
	svMetadata: async (panos: string[]) => panos.map((pano) => ({ pano, lat: 1, lng: 2, time: [] })),
	// Google's default at every position is "pDefault", whatever pano is on screen.
	panosAt: async () => [{ pano: "pDefault", lat: 1, lng: 2, time: [] }],
}));
vi.mock("@/lib/sv/panoSingleton", () => ({ singletonPano: null }));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

const { PanoViewerProvider, usePanoViewer } =
	await import("@/components/editor/location/PanoViewerContext");

type Viewer = ReturnType<typeof usePanoViewer>;
let viewer: Viewer;
let refresh: () => void;

function Probe({ report }: { report: (v: Viewer) => void }) {
	report(usePanoViewer());
	return null;
}

function Host() {
	const [, tick] = useState(0);
	refresh = () => tick((n) => n + 1);
	return (
		<PanoViewerProvider>
			<Probe report={(v) => (viewer = v)} />
		</PanoViewerProvider>
	);
}

const mountHost = () => mount(<Host />);

const location = () => h.activeLocation as Location;
const open = (resolved: string) =>
	act(async () => {
		viewer.open(location(), resolved);
	});
const walk = (pano: string) =>
	act(async () => {
		viewer.edit({ panoId: pano, lat: 5, lng: 6 });
	});

beforeEach(() => {
	h.enriched = [];
	h.written = [];
	h.enrichOn = true;
	h.enrichFails = false;
	h.enrichHangs = false;
	h.activeLocation = {
		...createLocation({ lat: 1, lng: 2 }),
		id: 7,
		panoId: "pA",
		extra: { custom: "kept", enriched: "old" },
	} satisfies Location;
});

describe("the draft is the location as a save would write it", () => {
	it("opens on the location's own pano, enriches the draft, and persists nothing", async () => {
		const m = mountHost();
		await open("pA");
		expect(viewer.draft).toMatchObject({ id: 7, panoId: "pA", extra: { enriched: "pA" } });
		expect(h.enriched.map((l) => l.panoId)).toEqual(["pA"]);
		expect(h.written).toEqual([]);
		m.unmount();
	});

	it("the default is the position's resolved pano, not the pano on screen", async () => {
		const m = mountHost();
		await open("pA");
		await walk("pB");
		await act(async () => {});
		expect(viewer.meta?.pano).toBe("pB");
		expect(viewer.defaultPano).toBe("pDefault");
		m.unmount();
	});

	it("pinning and unpinning move the flag on the draft only", async () => {
		const m = mountHost();
		await open("pA");
		await act(async () => viewer.edit((d) => ({ flags: d.flags | 1 })));
		expect(viewer.draft!.flags & 1).toBe(1);
		await act(async () => viewer.edit((d) => ({ flags: d.flags & ~1 })));
		expect(viewer.draft!.flags & 1).toBe(0);
		expect(h.written).toEqual([]);
		m.unmount();
	});

	it("walking moves the draft, re-derives every provider field, and persists nothing", async () => {
		const m = mountHost();
		await open("pA");
		h.written = [];
		await walk("pB");
		expect(h.enriched.at(-1)).toMatchObject({
			panoId: "pB",
			lat: 5,
			lng: 6,
			extra: { custom: "kept" },
		});
		expect(viewer.draft!.extra).toEqual({ custom: "kept", enriched: "pB" });
		m.unmount();
	});

	it("with per-save enrichment off, opening keeps the row's own fields", async () => {
		h.enrichOn = false;
		const m = mountHost();
		await open("pA");
		expect(viewer.draft!.extra).toEqual({ custom: "kept", enriched: "old" });
		expect(await viewer.settled()).toMatchObject({ extra: { custom: "kept", enriched: "old" } });
		m.unmount();
	});

	it("with per-save enrichment off, walking forgets the old pano's provider fields", async () => {
		h.enrichOn = false;
		const m = mountHost();
		await open("pA");
		await walk("pB");
		expect(h.enriched.at(-1)!.extra).toEqual({ custom: "kept" });
		expect(viewer.draft!.extra).toEqual({ custom: "kept" });
		expect(await viewer.settled()).toMatchObject({ panoId: "pB", extra: { custom: "kept" } });
		expect(h.written).toEqual([]);
		m.unmount();
	});

	it("a moved draft whose enrichment fails keeps nothing from the old pano", async () => {
		const m = mountHost();
		await open("pA");
		h.enrichFails = true;
		await walk("pB");
		expect(viewer.draft!.extra).toEqual({ custom: "kept" });
		expect(await viewer.settled()).toMatchObject({ panoId: "pB", extra: { custom: "kept" } });
		m.unmount();
	});

	it("a save mid-enrichment takes the draft as it stands instead of waiting", async () => {
		const m = mountHost();
		await open("pA");
		h.enrichHangs = true;
		await walk("pB");
		expect(await viewer.settled()).toMatchObject({ panoId: "pB", extra: { custom: "kept" } });
		expect(viewer.enriching).toBe(true);
		m.unmount();
	});

	it("a draft that did not move keeps its fields when enrichment fails", async () => {
		const m = mountHost();
		h.enrichFails = true;
		await open("pA");
		expect(viewer.draft!.extra).toEqual({ custom: "kept", enriched: "old" });
		m.unmount();
	});

	it("closing drops the draft, so reopening the same location starts from the stored row", async () => {
		const m = mountHost();
		await open("pA");
		await walk("pB");
		h.activeLocation = null;
		await act(async () => refresh());
		expect(viewer.draft).toBeNull();
		h.activeLocation = { ...location(), extra: { custom: "kept" } } satisfies Location;
		h.enriched = [];
		await act(async () => refresh());
		expect(viewer.draft).toBeNull();
		await open("pA");
		expect(h.enriched.map((l) => l.panoId)).toEqual(["pA"]);
		expect(h.enriched[0].extra).toEqual({ custom: "kept" });
		m.unmount();
	});

	it("a new location starts with no draft, so the old pano cannot reach it", async () => {
		const m = mountHost();
		await open("pA");
		h.activeLocation = { ...createLocation({ lat: 3, lng: 4 }), id: 8 } satisfies Location;
		await act(async () => refresh());
		expect(viewer.draft).toBeNull();
		expect(viewer.meta).toBeNull();
		expect(viewer.timeline).toBeNull();
		expect(h.enriched.map((l) => l.id)).toEqual([7]);
		m.unmount();
	});
});
