// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, useEffect, useState } from "react";
import { mount } from "./fixtures/harness";
import { createLocation } from "@/types";
import type { Location } from "@/bindings.gen";

// The viewer's draft is a pending layer in the store: these tests pin the wire protocol
// the context speaks (seed, put, read, land, drop) and its state plumbing. What the layer
// itself guarantees (derived clearing, the landed rule, stale answers dropped) is pinned
// by the store's own tests.
const h = vi.hoisted(() => ({
	/** Pending reverse-geocode answers, in request order. */
	geocodes: [] as (() => void)[],
	openLocation: null as unknown,
	opened: null as { id: number; origin: string; session: number } | null,
	sessions: 0,
	listeners: new Set<() => void>(),
	origin: "map",
	/** The mock layer: rows by id, naive field merge, never the map. */
	layer: new Map<number, Location>(),
	nextId: 100,
	/** Every storeEdit call: its edits and opts, in order. */
	edits: [] as { edits: unknown[]; opts: { land?: boolean } | null }[],
	drops: 0,
	/** Each enrich run: its target and abort signal. */
	runs: [] as { target: { name: string }; signal: AbortSignal | undefined }[],
	/** When set, enrich never settles, as a slow provider mid-run. */
	enrichHangs: false,
	/** When set, enrich rejects instead of answering. */
	enrichFails: false,
	onPartials: [] as ((rows: Location[]) => void)[],
	settleEnrich: [] as (() => void)[],
	openLocationPushes: [] as unknown[],
}));

type Put = { put: Partial<Location> & { id: number } };
const applyPut = (row: Location, p: Put["put"]): Location => {
	const { extra, ...fields } = p;
	const merged = { ...(row.extra ?? {}), ...(extra ?? {}) };
	for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
	return {
		...row,
		...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
		extra: extra === null ? null : Object.keys(merged).length > 0 ? merged : (row.extra ?? null),
	};
};

vi.mock("@/lib/commands", () => ({
	cmd: {
		storeEdit: async (
			_target: { name: string },
			edits: ({ set?: Location } | Put)[],
			opts: { land?: boolean } | null,
		) => {
			h.edits.push({ edits, opts });
			let firstId: number | null = null;
			for (const e of edits) {
				if ("set" in e && e.set) {
					const id = h.nextId++;
					firstId ??= id;
					h.layer.set(id, { ...e.set, id });
				} else if ("put" in e && e.put) {
					const row = h.layer.get(e.put.id);
					if (row) h.layer.set(e.put.id, applyPut(row, e.put));
					else h.layer.set(e.put.id, applyPut({ ...(h.openLocation as Location) }, e.put));
				}
			}
			return { mutation: { version: 0, keys: firstId == null ? [] : [firstId] } };
		},

		storeDrop: async () => {
			h.drops++;
			h.layer.clear();
		},
	},
}));
vi.mock("@/store/store", async () => {
	const { useEffect, useState } = await import("react");
	const state = () => {
		const location = h.openLocation as Location | null;
		if (!location) h.opened = null;
		else if (h.opened?.id !== location.id || h.opened.origin !== h.origin)
			h.opened = { id: location.id, origin: h.origin, session: ++h.sessions };
		return {
			open: h.opened && { ...h.opened, location },
			map: { settings: { enrichMetadata: true } },
		};
	};
	return {
		Store: {
			use: (sel: (s: ReturnType<typeof state>) => unknown) => {
				const [, tick] = useState(0);
				useEffect(() => {
					const changed = () => tick((n) => n + 1);
					h.listeners.add(changed);
					return () => {
						h.listeners.delete(changed);
					};
				}, []);
				return sel(state());
			},
			get: state,
		},
	};
});
vi.mock("@/store/mutation", () => ({ Mutation: { run: (fn: () => Promise<unknown>) => fn() } }));
vi.mock("@/store/query", () => ({
	Query: {
		read: async (selector: { locations: number[] }) =>
			selector.locations.flatMap((id) => (h.layer.has(id) ? [h.layer.get(id)] : [])),
	},
}));
vi.mock("@/store/editor", async () => {
	const state = () => {
		const location = h.openLocation as Location | null;
		if (!location) h.opened = null;
		else if (h.opened?.id !== location.id || h.opened.origin !== h.origin)
			h.opened = { id: location.id, origin: h.origin, session: ++h.sessions };
		return {
			open: h.opened && { ...h.opened, location },
			map: { settings: { enrichMetadata: true } },
		};
	};
	return {
		Editor: {
			setLocation: (location: unknown, session: number) => {
				if (state().open?.session !== session) return;
				h.openLocationPushes.push(location);
				h.openLocation = location;
				for (const changed of h.listeners) changed();
			},
			VIEWER: { kind: "pending", name: "viewer" },
		},
	};
});

vi.mock("@/lib/sv/enrich", () => ({
	enrich: (
		_selector: unknown,
		opts?: { on: { name: string }; signal?: AbortSignal; onPartial?: (rows: Location[]) => void },
	) => {
		h.runs.push({ target: opts!.on, signal: opts?.signal });
		if (opts?.onPartial) h.onPartials.push(opts.onPartial);
		if (h.enrichFails) return Promise.reject(new Error("network"));
		if (h.enrichHangs) return new Promise<void>(() => {});
		return new Promise<void>((resolve) => {
			h.settleEnrich.push(resolve);
		});
	},
}));
vi.mock("@/lib/sv/query", () => ({
	svMetadata: async (panos: string[]) => panos.map((id) => ({ id, lat: 1, lng: 2, time: [] })),
	// Google's default at every position is "pDefault", whatever pano is on screen.
	panosAt: async () => [{ id: "pDefault", lat: 1, lng: 2, time: [] }],
}));
vi.mock("@/lib/hooks/usePano", () => {
	const viewer = { hide: () => {} };
	return { usePano: () => viewer };
});
vi.mock("@/lib/geo/reverseGeocode", () => ({
	reverseGeocode: (lat: number, lng: number) =>
		new Promise((resolve) => h.geocodes.push(() => resolve({ address: `${lat},${lng}` }))),
	geocodeGoogle: () => null,
}));
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
	useEffect(() => {
		refresh = () => tick((n) => n + 1);
	}, []);
	return (
		<PanoViewerProvider>
			<Probe report={(v) => (viewer = v)} />
		</PanoViewerProvider>
	);
}

const mountHost = () => mount(<Host />);

const location = () => h.openLocation as Location;
const open = (resolved: string) =>
	act(async () => {
		viewer.open(location(), resolved);
	});
const walk = (pano: string) =>
	act(async () => {
		viewer.edit({ panoId: pano, lat: 5, lng: 6 });
	});
const settleRun = () =>
	act(async () => {
		h.settleEnrich.shift()?.();
	});
const puts = () => h.edits.flatMap((e) => e.edits.filter((x): x is Put => "put" in (x as object)));

beforeEach(() => {
	h.geocodes = [];
	h.opened = null;
	h.listeners.clear();
	h.layer = new Map();
	h.nextId = 100;
	h.edits = [];
	h.drops = 0;
	h.runs = [];
	h.onPartials = [];
	h.settleEnrich = [];
	h.enrichHangs = false;
	h.enrichFails = false;
	h.openLocationPushes = [];
	h.origin = "map";
	h.openLocation = {
		...createLocation({ lat: 1, lng: 2 }),
		id: 7,
		panoId: "pA",
		extra: { custom: "kept" },
	} satisfies Location;
});

describe("the draft is the viewer's layer row", () => {
	it("opening seeds the layer with the resolved pano and reads the draft from it", async () => {
		const m = mountHost();
		await open("pResolved");
		expect(h.drops).toBe(1);
		expect(puts()[0].put).toEqual({ id: 7, panoId: "pResolved" });
		expect(viewer.draft).toMatchObject({ id: 7, panoId: "pResolved" });
		expect(h.edits.every((e) => !e.opts?.land)).toBe(true);
		m.unmount();
	});

	it("walking puts the new pano and position to the layer and persists nothing", async () => {
		const m = mountHost();
		await open("pA");
		await walk("pB");
		expect(puts().at(-1)!.put).toEqual({ id: 7, panoId: "pB", lat: 5, lng: 6 });
		expect(viewer.draft).toMatchObject({ panoId: "pB", lat: 5, lng: 6 });
		expect(h.edits.every((e) => !e.opts?.land)).toBe(true);
		m.unmount();
	});

	it("the default is the position's resolved pano, not the pano on screen", async () => {
		const m = mountHost();
		await open("pA");
		await walk("pB");
		await act(async () => {});
		expect(viewer.currentPano?.id).toBe("pB");
		expect(viewer.defaultPano?.id).toBe("pDefault");
		m.unmount();
	});

	it("a preview opens on its pre-seeded layer row without reseeding", async () => {
		// The store seeded the preview copy into the layer before opening it.
		h.origin = "seen";
		h.openLocation = { ...location(), id: 100 } satisfies Location;
		h.layer.set(100, h.openLocation as Location);
		const m = mountHost();
		await open("pA");
		expect(h.drops).toBe(0);
		expect(puts()[0].put).toEqual({ id: 100, panoId: "pA" });
		expect(viewer.draft).toMatchObject({ id: 100, panoId: "pA" });
		m.unmount();
	});

	it("edits before a location is open are dropped", async () => {
		const m = mountHost();
		await walk("pB");
		expect(h.edits).toEqual([]);
		m.unmount();
	});

	it("closing drops the layer, so reopening starts from the stored row", async () => {
		const m = mountHost();
		await open("pA");
		await walk("pB");
		h.openLocation = null;
		await act(async () => refresh());
		expect(viewer.draft).toBeNull();
		expect(h.drops).toBe(2);
		m.unmount();
	});

	it("a new location starts with no draft, so the old pano cannot reach it", async () => {
		const m = mountHost();
		await open("pA");
		h.openLocation = { ...createLocation({ lat: 3, lng: 4 }), id: 8 } satisfies Location;
		await act(async () => refresh());
		expect(viewer.draft).toBeNull();
		expect(viewer.currentPano).toBeNull();
		m.unmount();
	});
});

describe("enrichment runs at the viewer's layer", () => {
	it("runs once per pano shown, and a partial updates the draft", async () => {
		const m = mountHost();
		await open("pA");
		expect(h.runs).toHaveLength(1);
		expect(h.runs[0].target).toEqual({ kind: "pending", name: "viewer" });
		expect(viewer.enriching).toBe(true);
		await act(async () => {
			h.onPartials[0]([{ ...viewer.draft!, extra: { custom: "kept", enriched: "pA" } }]);
		});
		expect(viewer.draft!.extra).toEqual({ custom: "kept", enriched: "pA" });
		await settleRun();
		expect(viewer.enriching).toBe(false);
		m.unmount();
	});

	it("another row's partial does not touch the draft", async () => {
		const m = mountHost();
		await open("pA");
		await act(async () => {
			h.onPartials[0]([{ ...viewer.draft!, id: 999, extra: { enriched: "other" } }]);
		});
		expect(viewer.draft!.extra).toEqual({ custom: "kept" });
		m.unmount();
	});

	it("walking aborts the old run and starts one on the new pano", async () => {
		h.enrichHangs = true;
		const m = mountHost();
		await open("pA");
		expect(h.runs).toHaveLength(1);
		await walk("pB");
		expect(h.runs).toHaveLength(2);
		expect(h.runs[0].signal?.aborted).toBe(true);
		expect(h.runs[1].signal?.aborted).toBe(false);
		m.unmount();
	});

	it("a failed run leaves the draft as the layer holds it", async () => {
		h.enrichFails = true;
		const m = mountHost();
		await open("pA");
		expect(viewer.draft).toMatchObject({ id: 7, panoId: "pA" });
		m.unmount();
	});

	it("closing without saving aborts the run", async () => {
		h.enrichHangs = true;
		const m = mountHost();
		await open("pA");
		h.openLocation = null;
		await act(async () => refresh());
		expect(h.runs[0].signal?.aborted).toBe(true);
		m.unmount();
	});
});

describe("saving lands the layer", () => {
	it("one land call carries the save patch; the run keeps going and the layer drops after it", async () => {
		const m = mountHost();
		await open("pA");
		await act(async () => {
			await viewer.land({ heading: 30, tags: [1] });
		});
		const landed = h.edits.find((e) => e.opts?.land);
		expect(landed).toBeTruthy();
		expect((landed!.edits[0] as Put).put).toEqual({ id: 7, heading: 30, tags: [1] });
		// The in-flight run was not aborted by the save; its answers follow the row.
		h.openLocation = null;
		await act(async () => refresh());
		expect(h.runs[0].signal?.aborted).toBe(false);
		const dropsBefore = h.drops;
		await settleRun();
		expect(h.drops).toBe(dropsBefore + 1);
		m.unmount();
	});

	it("landing answers the layer row's id, so a preview save knows its map row", async () => {
		h.origin = "seen";
		h.openLocation = { ...location(), id: 100 } satisfies Location;
		h.layer.set(100, h.openLocation as Location);
		const m = mountHost();
		await open("pA");
		let saved: number | null = null;
		await act(async () => {
			saved = await viewer.land({});
		});
		expect(saved).toBe(100);
		m.unmount();
	});

	it("every layer read is pushed into the store's open-row projection", async () => {
		const m = mountHost();
		await open("pA");
		expect(h.openLocationPushes.at(-1)).toMatchObject({ id: 7, panoId: "pA" });
		await walk("pB");
		expect(h.openLocationPushes.at(-1)).toMatchObject({ panoId: "pB" });
		m.unmount();
	});

	it("the geocode holds through a walk and starts empty on another location", async () => {
		mountHost();
		await open("pA");
		await act(async () => h.geocodes.shift()?.());
		expect(viewer.geo?.address).toBe("1,2");

		await walk("pB");
		expect(viewer.geo?.address).toBe("1,2");
		await act(async () => h.geocodes.pop()?.());
		expect(viewer.geo?.address).toBe("5,6");

		await act(async () => {
			h.openLocation = { ...location(), id: 8, lat: 9, lng: 9 };
			refresh();
		});
		expect(viewer.geo).toBeNull();
	});
});
