// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { MapMeta } from "@/bindings.gen";
import { getMapState, setMap } from "@/store/useMapStore";
import * as autosave from "@/store/autosave";
import { getLocal, setLocal } from "@/lib/hooks/useLocalStorage";
import { normalizeGeneratorSettings } from "@/plugins/generator/engine/types";
import { mount, type Mounted } from "./fixtures/harness";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/lib/sv/opensv", () => ({ google: {} }));
vi.mock("@/store/mapList", () => ({
	setCachedMapList: vi.fn(),
	invalidateMapList: vi.fn(async () => {}),
	reloadMapList: vi.fn(async () => {}),
}));
vi.mock("@/lib/commands", () => ({
	cmd: {
		storeSetDerived: async () => null,
		storeUpdateMapMeta: vi.fn(async (patch: Partial<MapMeta>) => {
			const state = getMapState();
			if (state.map && state.mapId === patch.id) setMap({ ...state.map, ...patch });
			return null;
		}),
		storeSaveDirty: vi.fn(async () => null),
	},
}));
vi.mock("@/plugins/generator/ui/SettingsPanel", () => ({ SettingsPanel: () => null }));
vi.mock("@/plugins/generator/ui/RegionSelector", () => ({ RegionSelector: () => null }));

const { GeneratorSidebar } = await import("@/plugins/generator/ui/GeneratorSidebar");

const SHARED_KEY = "mma_plugin:map-generator";

function openMap(id: string, settings: MapMeta["settings"] = {}) {
	const s = getMapState() as Record<string, unknown>;
	s.mapId = id;
	s.map = { id, settings };
}

const ownProject = () => getMapState().map?.settings.pluginData?.["map-generator"];

function sidebar(): Mounted {
	return mount(<GeneratorSidebar onClose={() => {}} />);
}

const tagInput = (m: Mounted) => m.container.querySelector("input") as HTMLInputElement;

function type(input: HTMLInputElement, value: string) {
	act(() => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

beforeEach(() => {
	localStorage.clear();
	setLocal(SHARED_KEY, { tagName: "Shared", settings: { defaultTarget: 7 } });
	openMap("a");
});

afterEach(async () => {
	await autosave.flush();
	const s = getMapState() as Record<string, unknown>;
	s.mapId = null;
	s.map = null;
});

describe("generator setup per map", () => {
	it("reads the shared setup until the map saves its own", () => {
		expect(tagInput(sidebar()).value).toBe("Shared");
		expect(ownProject()).toBeUndefined();
	});

	it("saves changes with the map, leaving the shared setup and other maps alone", () => {
		type(tagInput(sidebar()), "Mine");
		expect(ownProject()).toEqual({ tagName: "Mine" });
		expect(getLocal(SHARED_KEY, {})).toEqual({ tagName: "Shared", settings: { defaultTarget: 7 } });

		openMap("b");
		expect(tagInput(sidebar()).value).toBe("Shared");
	});

	it("resumes the map's own setup", () => {
		openMap("a", { pluginData: { "map-generator": { tagName: "Mine" } } });
		expect(tagInput(sidebar()).value).toBe("Mine");
	});

	it("resets to the factory setup, not the shared one", () => {
		const m = sidebar();
		const reset = [...m.container.querySelectorAll("button")].find(
			(b) => b.textContent === "Reset",
		);
		act(() => reset!.click());
		act(() => reset!.click());
		expect(tagInput(m).value).toBe("");
		expect(ownProject()).toEqual({ settings: normalizeGeneratorSettings(undefined), tagName: "" });
	});
});
