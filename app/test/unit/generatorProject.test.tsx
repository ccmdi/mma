// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { Store } from "@/store/store";
import { Autosave } from "@/store/autosave";
import type { MapMeta } from "@/bindings.gen";
import { getLocal, setLocal } from "@/lib/hooks/useLocalStorage";
import { normalizeGeneratorSettings } from "@/plugins/generator/engine/types";
import { mount, typeInto, type Mounted } from "./fixtures/harness";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/lib/sv/opensv", () => ({ google: {} }));
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
vi.mock("@/plugins/generator/ui/SettingsPanel", () => ({ SettingsPanel: () => null }));
vi.mock("@/plugins/generator/ui/RegionSelector", () => ({ RegionSelector: () => null }));

const { GeneratorSidebar } = await import("@/plugins/generator/ui/GeneratorSidebar");

const SHARED_KEY = "mma_plugin:map-generator";

function openMap(id: string, settings: MapMeta["settings"] = {}) {
	const s = Store.get() as Record<string, unknown>;
	s.mapId = id;
	s.map = { id, settings };
}

const ownProject = () => Store.get().map?.settings.pluginData?.["map-generator"];

function sidebar(): Mounted {
	return mount(<GeneratorSidebar onClose={() => {}} />);
}

const tagInput = (m: Mounted) => m.container.querySelector("input") as HTMLInputElement;

beforeEach(() => {
	localStorage.clear();
	setLocal(SHARED_KEY, { tagName: "Shared", settings: { defaultTarget: 7 } });
	openMap("a");
});

afterEach(async () => {
	await Autosave.flush();
	const s = Store.get() as Record<string, unknown>;
	s.mapId = null;
	s.map = null;
});

describe("generator setup per map", () => {
	it("reads the shared setup until the map saves its own", () => {
		expect(tagInput(sidebar()).value).toBe("Shared");
		expect(ownProject()).toBeUndefined();
	});

	it("saves changes with the map, leaving the shared setup and other maps alone", async () => {
		typeInto(tagInput(sidebar()), "Mine");
		await act(async () => {});
		expect(ownProject()).toEqual({ tagName: "Mine" });
		expect(getLocal(SHARED_KEY, {})).toEqual({ tagName: "Shared", settings: { defaultTarget: 7 } });

		openMap("b");
		expect(tagInput(sidebar()).value).toBe("Shared");
	});

	it("resumes the map's own setup", () => {
		openMap("a", { pluginData: { "map-generator": { tagName: "Mine" } } });
		expect(tagInput(sidebar()).value).toBe("Mine");
	});

	it("resets to the factory setup, not the shared one", async () => {
		const m = sidebar();
		const button = (match: (b: HTMLButtonElement) => boolean) =>
			[...m.container.querySelectorAll("button")].find(match)!;
		await act(async () => button((b) => b.getAttribute("aria-label") === "Reset").click());
		await act(async () => button((b) => b.textContent === "Are you sure?").click());
		expect(tagInput(m).value).toBe("");
		expect(ownProject()).toEqual({ settings: normalizeGeneratorSettings(undefined), tagName: "" });
	});
});
