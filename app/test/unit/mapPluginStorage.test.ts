import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapMeta } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { flushSave, getMapState, patchMapMeta } from "@/store/useMapStore";
import { mapStorage } from "@/plugins/pluginStorage";

vi.mock("@/store/mapList", () => ({
	setCachedMapList: vi.fn(),
	invalidateMapList: vi.fn(async () => {}),
	reloadMapList: vi.fn(async () => {}),
}));

vi.mock("@/lib/commands", () => ({
	cmd: {
		storeUpdateMapMeta: vi.fn(async () => null),
		storeSaveDirty: vi.fn(async () => null),
	},
}));

function openMap(id: string, settings: MapMeta["settings"] = {}) {
	const s = getMapState() as Record<string, unknown>;
	s.mapId = id;
	s.map = { id, settings };
}

/** Each write waits on a promise the test settles, so it can watch the order they arrive in. */
function holdWrites() {
	const pending: (() => void)[] = [];
	vi.mocked(cmd.storeUpdateMapMeta).mockImplementation(
		() => new Promise((resolve) => pending.push(() => resolve(null))),
	);
	return async () => {
		pending.shift()?.();
		await new Promise((r) => setTimeout(r));
	};
}

const sentSettings = () =>
	vi.mocked(cmd.storeUpdateMapMeta).mock.calls.map(([patch]) => patch.settings);

beforeEach(() => openMap("a"));

afterEach(async () => {
	vi.mocked(cmd.storeUpdateMapMeta).mockImplementation(async () => null);
	await flushSave();
	const s = getMapState() as Record<string, unknown>;
	s.mapId = null;
	s.map = null;
	vi.clearAllMocks();
});

describe("map metadata writes", () => {
	it("start one at a time, in the order they were made", async () => {
		const settle = holdWrites();
		void patchMapMeta({ id: "a", name: "first" });
		void patchMapMeta({ id: "b", name: "second" });
		await new Promise((r) => setTimeout(r));
		expect(cmd.storeUpdateMapMeta).toHaveBeenCalledTimes(1);

		await settle();
		expect(vi.mocked(cmd.storeUpdateMapMeta).mock.calls.map(([patch]) => patch.id)).toEqual([
			"a",
			"b",
		]);
		await settle();
	});

	it("fold a burst to one map into a single write of its last state", async () => {
		const settle = holdWrites();
		void patchMapMeta({ id: "a", settings: { exportZoom: true } });
		await new Promise((r) => setTimeout(r));
		void patchMapMeta({ id: "a", settings: { exportZoom: false } });
		void patchMapMeta({ id: "a", settings: { exportZoom: true, pinResolve: false } });
		await settle();
		await settle();
		expect(sentSettings()).toEqual([{ exportZoom: true }, { exportZoom: true, pinResolve: false }]);
	});

	it("are all saved once flushSave resolves", async () => {
		const settle = holdWrites();
		void patchMapMeta({ id: "a", name: "first" });
		void patchMapMeta({ id: "a", name: "second" });
		let flushed = false;
		void flushSave().then(() => (flushed = true));
		await settle();
		expect(flushed).toBe(false);
		await settle();
		expect(flushed).toBe(true);
	});
});

describe("mapStorage", () => {
	it("keeps each plugin's values in the open map's settings", async () => {
		openMap("a", { pointAlongRoad: false });
		await mapStorage("gen").set("tag", "Europe");
		await mapStorage("heat").set("layers", [1]);

		expect(mapStorage("gen").get("tag")).toBe("Europe");
		expect(mapStorage("gen").keys()).toEqual(["tag"]);
		expect(sentSettings().at(-1)).toEqual({
			pointAlongRoad: false,
			pluginData: { gen: { tag: "Europe" }, heat: { layers: [1] } },
		});
	});

	it("gives every map its own values", async () => {
		await mapStorage("gen").set("tag", "Europe");
		openMap("b");
		expect(mapStorage("gen").get("tag", "none")).toBe("none");
	});

	it("drops a plugin's entry once its last key is removed", async () => {
		await mapStorage("gen").set("tag", "Europe");
		await mapStorage("gen").remove("tag");
		expect(sentSettings().at(-1)).toEqual({ pluginData: {} });
	});

	it("throws with no map open", () => {
		const s = getMapState() as Record<string, unknown>;
		s.mapId = null;
		s.map = null;
		expect(() => mapStorage("gen").get("tag")).toThrow("No map is open");
		expect(() => mapStorage("gen").set("tag", 1)).toThrow("No map is open");
	});
});
