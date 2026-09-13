// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import type { Selection } from "@/bindings.gen";
import { Work, describeJobContract } from "./fixtures/jobContract";

const h = vi.hoisted(() => ({
	work: null as unknown as Work,
	panos: new Map<string, unknown>(),
	nextPano: 0,
	key: "",
	saved: {} as Record<string, unknown>,
	writes: 0,
	square: [
		[-60, -5],
		[-40, -5],
		[-40, 5],
		[-60, 5],
		[-60, -5],
	],
}));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/lib/sv/opensv", () => ({ google: {} }));
vi.mock("@/lib/sv/query", () => ({
	panosAt: (
		points: { lat: number; lng: number }[],
		_r: number,
		_o: unknown,
		signal?: AbortSignal,
	) =>
		h.work.park(
			() =>
				points.map(({ lat, lng }) => {
					const id = `p${String(h.nextPano++).padStart(21, "0")}`;
					const pano = {
						id,
						description: "Main Street",
						shortDescription: "Main Street",
						lat,
						lng,
						links: [{ heading: 90, panoId: "l".repeat(22) }],
						date: { year: 2020, month: 6, day: 1 },
						imageDate: "2020-06",
						time: [],
						worldSize: { height: 6656 },
						pov: { heading: 0, tilt: 90, roll: 0 },
					};
					h.panos.set(id, pano);
					return pano;
				}),
			signal,
		),
	svMetadata: (ids: string[], signal?: AbortSignal) =>
		h.work.park(() => ids.map((id) => h.panos.get(id) ?? null), signal),
}));
vi.mock("@/store/useMapStore", () => ({
	getActiveSelections: () => [
		{
			key: h.key,
			color: "#fff",
			selector: {
				type: "Polygon",
				polygon: { properties: { name: "A" }, coordinates: [h.square] },
			},
		} as unknown as Selection,
	],
	useMapState: (sel: (s: unknown) => unknown) => sel(undefined),
	getMapState: () => ({ fieldDefs: {} }),
	createTags: (names: string[]) => Promise.resolve(names.map((name, i) => ({ id: i + 1, name }))),
	setPluginMode: () => {},
}));
vi.mock("@/plugins/registry", () => ({
	createPluginStorage: () => ({
		get: (key: string, fallback: unknown) => (key in h.saved ? h.saved[key] : fallback),
		set: () => {},
	}),
}));
vi.mock("@/plugins/generator/ui/SettingsPanel", () => ({ SettingsPanel: () => null }));

import { GeneratorSidebar } from "@/plugins/generator/ui/GeneratorSidebar";
import { startGeneration } from "@/plugins/generator/session";
import { DEFAULT_SETTINGS, type GeneratorRegion } from "@/plugins/generator/engine/types";
import { getJobs } from "@/lib/jobs";
import { mount, type Mounted } from "./fixtures/harness";

const PERMISSIVE = {
	rejectUnofficial: false,
	rejectDateless: false,
	rejectNoDescription: false,
	defaultTarget: 100_000,
};

function countWrites(): void {
	h.writes = 0;
	vi.stubGlobal("MMA", {
		addLocations: async (locs: unknown[]) => {
			h.writes += locs.length;
		},
	});
}

function sidebar(): Mounted {
	return mount(<GeneratorSidebar onClose={() => {}} />);
}

function button(m: Mounted, label: string): HTMLButtonElement | undefined {
	return [...m.container.querySelectorAll("button")].find((b) => b.textContent === label);
}

async function click(m: Mounted, label: string): Promise<void> {
	const b = button(m, label);
	if (!b) throw new Error(`no ${label} button`);
	await act(async () => {
		b.click();
	});
}

async function answer(opts?: { honorAbort?: boolean }): Promise<void> {
	await act(() => h.work.answer(opts));
}

/** Everything a user has to stop generation with: the Stop button and every tray cancel. */
async function stopEverything(m: Mounted): Promise<void> {
	if (button(m, "Stop")) await click(m, "Stop");
	await act(async () => {
		for (const j of getJobs()) j.cancel?.();
	});
}

/** However the lookups still in flight answer, nothing is written and nothing new is asked. */
async function expectSilence(): Promise<void> {
	const writes = h.writes;
	const issued = h.work.issued;
	for (let i = 0; i < 4; i++) await answer({ honorAbort: false });
	expect(h.writes).toBe(writes);
	expect(h.work.issued).toBe(issued);
}

describe("stopping the generator", () => {
	let testIndex = 0;

	beforeEach(() => {
		vi.useFakeTimers({
			toFake: [
				"setTimeout",
				"clearTimeout",
				"setInterval",
				"clearInterval",
				"requestAnimationFrame",
				"cancelAnimationFrame",
			],
		});
		h.work = new Work();
		h.key = `poly:${testIndex++}`;
		h.saved = { settings: PERMISSIVE };
		countWrites();
	});

	afterEach(async () => {
		await act(async () => {
			for (const j of getJobs()) j.cancel?.();
		});
		for (let i = 0; i < 3; i++) await act(() => h.work.answer());
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("Stop ends generation: nothing is written or looked up afterwards", async () => {
		const m = sidebar();
		await click(m, "Start");
		await answer();
		await answer();
		expect(h.writes).toBeGreaterThan(0);

		await click(m, "Stop");
		await expectSilence();
		expect(getJobs()).toHaveLength(0);
	});

	it("a run started right after Stop stays stoppable while the stopped run's lookups land", async () => {
		const m = sidebar();
		await click(m, "Start");
		await answer();
		await click(m, "Stop");
		await click(m, "Start");

		await answer({ honorAbort: false });
		expect(button(m, "Stop")).toBeDefined();
		expect(getJobs()).toHaveLength(1);

		await stopEverything(m);
		await expectSilence();
	});

	it("a double-clicked Start leaves nothing generating after Stop", async () => {
		h.saved = { settings: PERMISSIVE, tagName: "generated" };
		const m = sidebar();
		const start = button(m, "Start")!;
		await act(async () => {
			start.click();
			start.click();
		});
		await answer();

		await stopEverything(m);
		await expectSilence();
	});

	it("a run that finishes while the sidebar is closed does not reopen as running", async () => {
		h.saved = { settings: { ...PERMISSIVE, defaultTarget: 5 } };
		const m = sidebar();
		await click(m, "Start");
		m.unmount();
		await answer();
		await answer();
		expect(getJobs()).toHaveLength(0);

		const again = sidebar();
		expect(button(again, "Start")).toBeDefined();
	});
});

function contractRegion(): GeneratorRegion {
	return {
		id: "contract",
		name: "contract",
		feature: {
			type: "Feature",
			properties: { name: "contract" },
			geometry: { type: "Polygon", coordinates: [h.square] },
		},
		found: [],
		target: 100_000,
		checkedPanos: new Set(),
		isProcessing: false,
	};
}

describeJobContract("the map generator", "src/plugins/generator/session.ts", (work) => {
	h.work = work;
	countWrites();
	return {
		singleRun: true,
		start: () => {
			startGeneration({ ...DEFAULT_SETTINGS, ...PERMISSIVE }, [contractRegion()], "");
		},
		effects: () => h.writes,
	};
});
