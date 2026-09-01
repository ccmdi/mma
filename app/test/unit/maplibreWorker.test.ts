// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

// Without a worker url MapLibre 6 requests no vector tiles at all, and it fails silently:
// the basemap is simply blank, no error, no console warning. The url is set once at module
// scope, so the only thing that can regress is the call disappearing or arriving after the
// first Map is constructed.
const h = vi.hoisted(() => ({
	order: [] as string[],
	workerUrl: null as unknown,
}));

vi.mock("maplibre-gl", () => {
	class Map {
		constructor() {
			h.order.push("Map");
		}
		on() {}
		once() {}
		remove() {}
		getCanvas() {
			return { style: {} };
		}
	}
	// `import * as maplibregl` reads named exports, so the mock must expose them flat.
	return {
		Map,
		setWorkerUrl: (u: unknown) => {
			h.order.push("setWorkerUrl");
			h.workerUrl = u;
		},
		setMaxParallelImageRequests: () => h.order.push("setMaxParallelImageRequests"),
	};
});
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));
vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url", () => ({
	default: "/assets/maplibre-worker.js",
}));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

describe("the maplibre host points the library at its worker", () => {
	it("calls setWorkerUrl with a real url when the module loads", async () => {
		await import("@/lib/map/maplibreHost");
		expect(h.order).toContain("setWorkerUrl");
		expect(typeof h.workerUrl).toBe("string");
		expect(h.workerUrl).not.toBe("");
	});

	it("sets it at module scope, before any Map could be constructed", async () => {
		await import("@/lib/map/maplibreHost");
		const worker = h.order.indexOf("setWorkerUrl");
		const firstMap = h.order.indexOf("Map");
		expect(worker).toBeGreaterThanOrEqual(0);
		// -1 means no Map was built by import alone, which is also correct.
		if (firstMap >= 0) expect(worker).toBeLessThan(firstMap);
	});

	it("raises the parallel image request cap, so vector tiles do not starve SV", async () => {
		await import("@/lib/map/maplibreHost");
		expect(h.order).toContain("setMaxParallelImageRequests");
	});
});
