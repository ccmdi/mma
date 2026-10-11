// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { Store } from "@/store/store";
import { Autosave } from "@/store/autosave";
import type { MapMeta } from "@/bindings.gen";
import { mount, type Mounted } from "./fixtures/harness";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/store/maps", () => ({
	Maps: { setList: vi.fn(), invalidate: vi.fn(async () => {}), reload: vi.fn(async () => {}) },
}));
vi.mock("@/lib/commands", () => ({
	cmd: {
		valiDataStatus: vi.fn(async () => []),
		storeUpdateMapMeta: vi.fn(async (patch: Partial<MapMeta>) => {
			const state = Store.get();
			if (state.map && state.mapId === patch.id) Store.setMeta({ ...state.map, ...patch });
			return null;
		}),
		storeSaveDirty: vi.fn(async () => null),
	},
}));

const { ValiSidebar } = await import("@/plugins/vali/ui/ValiSidebar");

function openMap(settings: MapMeta["settings"] = {}) {
	const s = Store.get() as Record<string, unknown>;
	s.mapId = "a";
	s.map = { id: "a", settings };
}

const ownProject = () => Store.get().map?.settings.pluginData?.vali?.project;

let view: Mounted;
let toGui: ReturnType<typeof vi.fn>;

function sidebar() {
	view = mount(<ValiSidebar onClose={() => {}} />);
	const gui = view.container.querySelector("iframe")!.contentWindow!;
	toGui = vi.fn();
	gui.postMessage = toGui as typeof gui.postMessage;
	return gui;
}

async function fromGui(gui: Window, data: unknown) {
	await act(async () => {
		window.dispatchEvent(new MessageEvent("message", { data, source: gui }));
	});
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(async () => {
	await Autosave.flush();
	const s = Store.get() as Record<string, unknown>;
	s.mapId = null;
	s.map = null;
});

describe("Vali setup per map", () => {
	it("loads the map's own definition and tag into the GUI", async () => {
		openMap({
			pluginData: { vali: { project: { definition: { countryCodes: ["SE"] }, tag: "Sweden" } } },
		});
		await fromGui(sidebar(), { type: "vali:ready" });
		expect(toGui).toHaveBeenCalledWith(
			{ type: "vali:load", definition: { countryCodes: ["SE"] }, tag: "Sweden" },
			"*",
		);
	});

	it("loads the shared tag into a map that has no setup of its own", async () => {
		localStorage.setItem("vali-mma-tag", "Shared");
		openMap();
		await fromGui(sidebar(), { type: "vali:ready" });
		expect(toGui).toHaveBeenCalledWith({ type: "vali:load", tag: "Shared" }, "*");
	});

	it("keeps what the GUI reports with the map, leaving the shared tag alone", async () => {
		localStorage.setItem("vali-mma-tag", "Shared");
		openMap();
		await fromGui(sidebar(), {
			type: "vali:state",
			definition: { countryCodes: ["NO"] },
			tag: "Norway",
		});
		expect(ownProject()).toEqual({ definition: { countryCodes: ["NO"] }, tag: "Norway" });
		expect(localStorage.getItem("vali-mma-tag")).toBe("Shared");
	});

	it("ignores messages from anything but its own GUI", async () => {
		openMap();
		sidebar();
		await fromGui(window, { type: "vali:state", definition: {}, tag: "stray" });
		expect(ownProject()).toBeUndefined();
	});

	it("resets the map to the GUI's defaults, not to the shared tag", async () => {
		localStorage.setItem("vali-mma-tag", "Shared");
		openMap({ pluginData: { vali: { project: { tag: "Sweden" } } } });
		sidebar();
		const reset = [...view.container.querySelectorAll("button")].find(
			(b) => b.textContent === "Reset",
		)!;
		act(() => reset.click());
		act(() => reset.click());
		expect(ownProject()).toEqual({});
		expect(toGui).toHaveBeenCalledWith({ type: "vali:load" }, "*");
	});
});
