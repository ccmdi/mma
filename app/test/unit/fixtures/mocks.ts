import { vi } from "vitest";

/**
 * Shared `vi.mock` factories.
 *
 * `vi.mock` is hoisted above imports, so these cannot be imported normally and referenced
 * inside a factory. Call them through a dynamic import instead, which is lazy enough that
 * hoisting never sees them:
 *
 *     vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
 */

export function logMock() {
	return {
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			trace: vi.fn(),
		},
		fireAndForget: (p: Promise<unknown> | undefined) => void p?.catch(() => {}),
		asyncHandler:
			<A extends unknown[]>(fn: (...args: A) => Promise<unknown>, _label: string) =>
			(...args: A) =>
				void fn(...args).catch(() => {}),
		initLogging: async () => {},
	};
}

export function googleMapsMock() {
	class Size {
		w: number;
		h: number;
		constructor(w: number, h: number) {
			this.w = w;
			this.h = h;
		}
	}
	class ImageMapType {
		opts: { getTileUrl(c: { x: number; y: number }, z: number): string };
		constructor(opts: { getTileUrl(c: { x: number; y: number }, z: number): string }) {
			this.opts = opts;
		}
		getTile(_coord: unknown, _zoom: number, doc: Document) {
			return doc.createElement("div");
		}
	}
	class MapMock {
		stack: { layers: google.maps.ImageMapType[] } | null = null;
		mapTypes = {
			set: (_id: string, stack: { layers: google.maps.ImageMapType[] }) => {
				this.stack = stack;
			},
		};
		private div = document.createElement("div");
		container: HTMLElement;
		opts: unknown;
		constructor(container: HTMLElement, opts: unknown) {
			this.container = container;
			this.opts = opts;
		}
		setOptions() {}
		setMapTypeId() {}
		getDiv() {
			return this.div;
		}
		addListener() {
			return {};
		}
	}
	return {
		google: {
			maps: {
				Size,
				ImageMapType,
				Map: MapMock,
				event: { trigger: vi.fn(), clearInstanceListeners: vi.fn() },
			},
		},
	};
}

export function stackedMapTypeMock() {
	return { createCompositeMapType: (layers: unknown[]) => ({ layers }) };
}

type Handlers = Record<string, (...args: unknown[]) => unknown>;

export function testMap(
	over: { locationCount?: number; tags?: Record<string, unknown>; extra?: unknown } = {},
) {
	return {
		id: "m1",
		name: "test",
		description: "",
		folder: null,
		locationCount: over.locationCount ?? 1,
		tags: over.tags ?? {},
		settings: {},
		scoreBounds: null,
		createdAt: "",
		updatedAt: "",
		extra: over.extra ?? null,
	};
}

export function openMapResult(
	over: { tagCounts?: Record<string, number>; fieldDefs?: Record<string, unknown> } = {},
) {
	return {
		version: 1,
		derived: {
			locationCount: 0,
			history: {},
			fieldValues: {
				tags: Object.fromEntries(
					Object.entries(over.tagCounts ?? {}).map(([k, count]) => [k, { record: null, count }]),
				),
			},
			fieldDefs: over.fieldDefs ?? {},
			selectionCounts: {},
			selectionList: [],
		},
	};
}

export async function selectionsHeld(value: unknown) {
	const { Store } = await import("@/store/store");
	const { selectionFixture } = await import("./selection");
	const op = value as import("@/bindings.gen").SelectionOp;
	type Row = import("@/bindings.gen").ListedSelection;
	const apply = (op: import("@/bindings.gen").SelectionOp, rows: Row[]): Row[] => {
		switch (op.kind) {
			case "set":
				return op.selections.map((s) => ({
					selection: selectionFixture(s.selector, s.color ?? [128, 128, 128]),
					ghosted: false,
				}));
			case "add":
				return [
					...rows,
					...op.selections.map((s) => ({
						selection: selectionFixture(s.selector, s.color ?? [128, 128, 128]),
						ghosted: false,
					})),
				];
			case "ghost":
				return rows.map((r, i) => ({ ...r, ghosted: r.ghosted !== (i === op.index) }));
			case "remove":
				return rows.filter((r) => !op.keys.includes(r.selection.key));
			case "active": {
				const next = apply(
					op.op,
					rows.filter((r) => !r.ghosted),
				);
				return rows
					.flatMap((row) => (row.ghosted ? [row] : next.length ? [next.shift()!] : []))
					.concat(next);
			}
			default:
				throw new Error(`Unsupported test operation: ${op.kind}`);
		}
	};
	const state = Store.get();
	Object.assign(state, { selectionList: apply(op, state.selectionList) });
	if (state.map) Store.setMeta(state.map);
	return { mutation: { version: 0, keys: [] } };
}

export async function metadataWritten(patch: unknown) {
	const { Store } = await import("@/store/store");
	const state = Store.get();
	const change = patch as Partial<import("@/bindings.gen").MapMeta>;
	if (state.map && state.mapId === change.id) Store.setMeta({ ...state.map, ...change });
	return null;
}

export function cmdProxy(handlers: Handlers) {
	return {
		cmd: new Proxy({}, { get: (_t, name: string) => handlers[name] ?? (async () => null) }),
	};
}
