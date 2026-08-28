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
		constructor(
			public w: number,
			public h: number,
		) {}
	}
	class ImageMapType {
		constructor(public opts: { getTileUrl(c: { x: number; y: number }, z: number): string }) {}
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
		constructor(
			public container: HTMLElement,
			public opts: unknown,
		) {}
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
				event: { trigger: () => {}, clearInstanceListeners: () => {} },
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

export function openMapResult(over: { tagCounts?: Record<string, number> } = {}) {
	return {
		version: 0,
		locationCount: 0,
		tagCounts: over.tagCounts ?? {},
		canUndo: false,
		canRedo: false,
	};
}

export function cmdProxy(handlers: Handlers) {
	return {
		cmd: new Proxy({}, { get: (_t, name: string) => handlers[name] ?? (async () => null) }),
	};
}
