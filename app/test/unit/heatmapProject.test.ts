// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "@/store/store";
import { Autosave } from "@/store/autosave";
import type { MapMeta } from "@/bindings.gen";
import { pluginSetting } from "@/plugins/pluginStorage";
import { getLocal, setLocal } from "@/lib/hooks/useLocalStorage";
import { emit } from "@/lib/events";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/store/maps", () => ({
	Maps: { setList: vi.fn(), invalidate: vi.fn(async () => {}), reload: vi.fn(async () => {}) },
}));
vi.mock("@/lib/commands", () => ({
	cmd: {
		storeUpdateMapMeta: vi.fn(async (patch: unknown) =>
			(await import("./fixtures/mocks")).metadataWritten(patch),
		),
		storeSaveDirty: vi.fn(async () => null),
	},
}));

type Heatmap = typeof import("../../../plugins/heatmap/src/heatmap");
let heatmap: Heatmap;
let cleanup: (() => void) | null = null;
let drawn: { id: string; opacity: number }[] = [];

const SHARED_KEY = "mma_plugin:heatmap";

function setOpenMap(id: string, settings: MapMeta["settings"]) {
	const s = Store.get() as Record<string, unknown>;
	s.mapId = id;
	s.map = { id, settings };
}

function openMap(id: string, settings: MapMeta["settings"] = {}) {
	setOpenMap(id, settings);
	cleanup = heatmap.init();
}

const drawnIds = () => drawn.map((l) => l.id.replace("mma-heatmap-", ""));

const ownProject = () => Store.get().map?.settings.pluginData?.heatmap;

beforeAll(async () => {
	vi.stubGlobal("MMA", {
		pluginSetting,
		Scene: {
			selected: () => new Set(),
			positions: () => ({ ids: new Uint32Array(), positions: new Float32Array() }),
		},
		Query: { read: async () => [] },
		selectorForPick: () => ({ type: "Everything" }),
		MapHost: {
			get: () => ({
				createDeckOverlay: () => ({
					setProps: ({ layers }: { layers: { props: { id: string; opacity: number } }[] }) => {
						drawn = layers.map((l) => l.props);
					},
					finalize: () => {},
				}),
			}),
		},
		on: () => () => {},
	});
	heatmap = await import("../../../plugins/heatmap/src/heatmap");
});

beforeEach(() => {
	localStorage.clear();
	drawn = [];
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
	it("reads the shared layers until the map saves its own", async () => {
		openMap("a");
		await vi.waitFor(() => expect(drawn.map((l) => l.opacity)).toEqual([0.2]));
		expect(drawnIds()).toEqual(["shared"]);
		expect(ownProject()).toBeUndefined();
	});

	it("saves edits with the map and leaves the shared layers alone", async () => {
		openMap("a");
		heatmap.updateLayer("shared", { opacity: 0.9 });
		await vi.waitFor(() =>
			expect(ownProject()?.layers).toEqual([
				expect.objectContaining({ id: "shared", opacity: 0.9 }),
			]),
		);
		expect(getLocal(SHARED_KEY, {})).toEqual({ layers: [{ id: "shared", opacity: 0.2 }] });
	});

	it("resumes the map's own layers", async () => {
		openMap("a", { pluginData: { heatmap: { layers: [{ id: "mine", opacity: 0.5 }] } } });
		await vi.waitFor(() => expect(drawnIds()).toEqual(["mine"]));
	});

	it("follows layers another window saves, and edits on top of them", async () => {
		openMap("a", { pluginData: { heatmap: { layers: [{ id: "mine" }] } } });
		await vi.waitFor(() => expect(drawnIds()).toEqual(["mine"]));
		setOpenMap("a", { pluginData: { heatmap: { layers: [{ id: "theirs" }] } } });
		emit("snapshot:changed");
		await vi.waitFor(() => expect(drawnIds()).toEqual(["theirs"]));
		heatmap.updateLayer("theirs", { opacity: 0.9 });
		await vi.waitFor(() =>
			expect(ownProject()?.layers).toEqual([
				expect.objectContaining({ id: "theirs", opacity: 0.9 }),
			]),
		);
	});

	it("resets to one default layer and no custom gradients, not to the shared setup", async () => {
		openMap("a", { pluginData: { heatmap: { gradients: [{ id: "g", stops: [] }] } } });
		heatmap.resetProject();
		await vi.waitFor(() => expect(ownProject()).toEqual({ layers: [], gradients: [] }));
		await vi.waitFor(() => expect(drawnIds()).toEqual(["first"]));
	});
});
