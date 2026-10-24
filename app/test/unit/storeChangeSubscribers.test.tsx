// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

const reads = vi.hoisted(() => ({ query: vi.fn(), bounds: vi.fn() }));

const NO_FIELDS = vi.hoisted(() => [] as never[]);
const NO_KEYS = vi.hoisted(() => new Set<string>());

vi.mock("@/store/query", () => ({
	Query: {
		read: async (_selector: unknown, request: { kind: string }) => {
			if (request.kind === "bounds") {
				reads.bounds();
				return null;
			}
			reads.query();
			if (request.kind === "countBy") return [{ counts: [], total: 0 }];
			return 1;
		},
	},
}));
vi.mock("@/store/store", () => {
	const state = {
		map: { id: "m", scoreBounds: "auto" },
		locationCount: 0,
		fieldDefs: {},
		selectionList: [],
	};
	return { Store: { get: () => state, use: (sel: (s: typeof state) => unknown) => sel(state) } };
});
vi.mock("@/lib/commands", () => ({
	cmd: {
		storeCountryDistribution: async () => {
			reads.query();
			return [];
		},
	},
}));
vi.mock("@/store/settings", () => ({ getSettings: () => ({ borderDetail: 0 }) }));
vi.mock("@/plugins/pluginStorage", () => ({
	pluginSetting: (_plugin: string, key: string, fallback: unknown) => ({
		use: () => useState(key === "rows" || key === "cols" ? { kind: "all" } : fallback),
	}),
	storage: () => ({ keys: () => ["source"] }),
}));
vi.mock("@/store/selectionList", () => ({ SelectionList: { active: () => [], listed: () => [] } }));
vi.mock("@/store/tag", () => ({ Tag: { all: () => ({}) } }));
const EVERYTHING = vi.hoisted(() => ({ type: "Everything" }));
vi.mock("@/store/selectorPick", () => ({
	useSelectorPick: () => ({
		selector: EVERYTHING,
		choice: "all",
		setChoice: () => {},
		allCount: 0,
		selectionCount: 0,
	}),
}));
vi.mock("@/components/editor/map/FilterBuilder", () => ({ useExtraFieldKeys: () => NO_FIELDS }));
vi.mock("@/components/primitives/SelectorPicker", () => ({ SelectorPicker: () => null }));
vi.mock("@/lib/data/fieldDefRegistry", () => ({
	getFieldDef: () => undefined,
	getKnownFieldKeys: () => NO_KEYS,
}));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { emit } from "@/lib/events";
import { Store } from "@/store/store";
import type { ChangeEvent } from "@/bindings.gen";
import { changeEvent, replace } from "./fixtures/patch";
import { DistributionSidebar } from "@/plugins/distribution/DistributionSidebar";
import { PivotSidebar } from "@/plugins/pivot/PivotSidebar";
import { useScoreMaxError } from "@/lib/geo/scoring";

const NON_LOCATION = changeEvent(
	[
		replace("/selectionOrder", []),
		replace("/selectionCounts", {}),
		replace("/writingLayers", []),
		replace("/unsaved", true),
	],
	1,
);
const LOCATION = changeEvent([], 1, { updated: [3] });

function ScoreProbe() {
	useScoreMaxError();
	return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	(globalThis as unknown as { MMA: unknown }).MMA = { Store };
	vi.useFakeTimers();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	reads.query.mockClear();
	reads.bounds.mockClear();
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
});

const settle = () => act(() => vi.advanceTimersByTimeAsync(500));

async function readsAfter(spy: typeof reads.query, element: React.ReactElement, e: ChangeEvent) {
	await act(async () => root.render(element));
	await settle();
	spy.mockClear();
	await act(async () => emit("store:change", e));
	await settle();
	return spy.mock.calls.length;
}

describe.each([
	["DistributionSidebar", () => <DistributionSidebar onClose={() => {}} />, reads.query],
	["PivotSidebar", () => <PivotSidebar onClose={() => {}} />, reads.query],
	["useScoreMaxError", () => <ScoreProbe />, reads.bounds],
])("%s", (_name, element, spy) => {
	it("ignores a change that moved no locations", async () => {
		expect(await readsAfter(spy, element(), NON_LOCATION)).toBe(0);
	});

	it("re-reads when locations changed", async () => {
		expect(await readsAfter(spy, element(), LOCATION)).toBeGreaterThan(0);
	});
});
