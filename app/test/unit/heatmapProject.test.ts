// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "@/store/store";
import { Autosave } from "@/store/autosave";
import type { MapMeta } from "@/bindings.gen";
import { mapStorage, storage } from "@/plugins/pluginStorage";
import { getLocal, setLocal } from "@/lib/hooks/useLocalStorage";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/store/maps", () => ({
	Maps: { setList: vi.fn(), invalidate: vi.fn(async () => {}), reload: vi.fn(async () => {}) },
}));
vi.mock("@/lib/commands", () => ({
	cmd: {
		storeUpdateMapMeta: vi.fn(async (patch: Partial<MapMeta>) => {
			const state = Store.get();
			if (state.map && state.mapId === patch.id) Store.setMeta({ ...state.map, ...patch });
			return null;
		}),
		storeSaveDirty: vi.fn(async () => null),
	},
}));

type Heatmap = typeof import("../../../plugins/heatmap/src/heatmap");
let heatmap: Heatmap;
let cleanup: (() => void) | null = null;

const SHARED_KEY = "mma_plugin:heatmap";

function openMap(id: string, settings: MapMeta["settings"] = {}) {
	const s = Store.get() as Record<string, unknown>;
	s.mapId = id;
	s.map = { id, settings };
	cleanup = heatmap.init();
}

const ownProject = () => Store.get().map?.settings.pluginData?.heatmap;

beforeAll(async () => {
	vi.stubGlobal("MMA", {
		storage,
		mapStorage,
		getMapState: Store.get,
		resolveIds: async () => [],
		selectorForPick: () => ({ type: "Everything" }),
		getScenePositions: () => ({ ids: new Uint32Array(), positions: new Float32Array() }),
		getMapHost: () => ({
			createDeckOverlay: () => ({ setProps: () => {}, finalize: () => {} }),
		}),
		on: () => () => {},
	});
	heatmap = await import("../../../plugins/heatmap/src/heatmap");
});

beforeEach(() => {
	localStorage.clear();
	setLocal(SHARED_KEY, { layers: [{ id: "shared", opacity: 0.2 }] });
});

afterEach(async () => {
	cleanup?.();
	cleanup = null;
	await Autosave.flush();
	const s = Store.get() as Record<string, unknown>;
	s.mapId = null;
	s.map = null;
});

describe("heatmap setup per map", () => {
	it("reads the shared layers until the map saves its own", () => {
		openMap("a");
		expect(heatmap.getLayers().map((l) => [l.id, l.opacity])).toEqual([["shared", 0.2]]);
		expect(ownProject()).toBeUndefined();
	});

	it("saves edits with the map and leaves the shared layers alone", () => {
		openMap("a");
		heatmap.updateLayer("shared", { opacity: 0.9 });
		expect(ownProject()?.layers).toEqual([expect.objectContaining({ id: "shared", opacity: 0.9 })]);
		expect(getLocal(SHARED_KEY, {})).toEqual({ layers: [{ id: "shared", opacity: 0.2 }] });
	});

	it("resumes the map's own layers", () => {
		openMap("a", { pluginData: { heatmap: { layers: [{ id: "mine", opacity: 0.5 }] } } });
		expect(heatmap.getLayers().map((l) => l.id)).toEqual(["mine"]);
	});

	it("resets to one default layer and no custom gradients, not to the shared setup", () => {
		openMap("a", { pluginData: { heatmap: { gradients: [{ id: "g", stops: [] }] } } });
		heatmap.resetProject();
		const own = ownProject() as { layers: { id: string }[]; gradients: unknown[] };
		expect(own.gradients).toEqual([]);
		expect(own.layers).toHaveLength(1);
		expect(own.layers[0].id).not.toBe("shared");
		expect(heatmap.getCustomGradients()).toEqual([]);
	});
});
