import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "@/store/store";
import { Edit } from "@/store/edit";
import { Autosave } from "@/store/autosave";
import type { MapMeta } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { mapStorage } from "@/plugins/pluginStorage";

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

function openMap(id: string, settings: MapMeta["settings"] = {}) {
	const s = Store.get() as Record<string, unknown>;
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
	vi.mocked(cmd.storeUpdateMapMeta).mockImplementation(async (patch) =>
		(await import("./fixtures/mocks")).metadataWritten(patch),
	);
	await Autosave.flush();
	const s = Store.get() as Record<string, unknown>;
	s.mapId = null;
	s.map = null;
	vi.clearAllMocks();
});

describe("map metadata writes", () => {
	it("fire immediately and whole; ordering is the store's", async () => {
		const settle = holdWrites();
		void Edit.meta({ id: "a", name: "first" });
		void Edit.meta({ id: "b", name: "second" });
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
		await Edit.meta({ id: "a", name: "first" });
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
		const s = Store.get() as Record<string, unknown>;
		s.mapId = null;
		s.map = null;
		expect(() => mapStorage("gen").get("tag")).toThrow("No map is open");
		expect(() => mapStorage("gen").set("tag", 1)).toThrow("No map is open");
	});
});
