import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapMeta } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { getMapState } from "@/store/useMapStore";
import * as edit from "@/store/edit";
import * as autosave from "@/store/autosave";
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
	await autosave.flush();
	const s = getMapState() as Record<string, unknown>;
	s.mapId = null;
	s.map = null;
	vi.clearAllMocks();
});

describe("map metadata writes", () => {
	it("fire immediately and whole; ordering is the store's", async () => {
		const settle = holdWrites();
		void edit.meta({ id: "a", name: "first" });
		void edit.meta({ id: "b", name: "second" });
		await new Promise((r) => setTimeout(r));
		expect(vi.mocked(cmd.storeUpdateMapMeta).mock.calls.map(([patch]) => patch.id)).toEqual([
			"a",
			"b",
		]);
		await settle();
		await settle();
	});

	it("schedule the save that persists them", async () => {
		vi.useFakeTimers();
		await edit.meta({ id: "a", name: "first" });
		expect(cmd.storeSaveDirty).not.toHaveBeenCalled();
		await vi.runAllTimersAsync();
		expect(cmd.storeSaveDirty).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
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
