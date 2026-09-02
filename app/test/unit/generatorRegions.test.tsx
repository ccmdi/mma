// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import type { Selection } from "@/bindings.gen";
import type { GeneratorRegionMeta } from "@/plugins/generator/engine/types";

const h = vi.hoisted(() => ({ selections: [] as Selection[] }));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/store/useMapStore", () => ({
	getActiveSelections: () => h.selections,
	useMapState: (sel: (s: unknown) => unknown) => sel(undefined),
}));

import { RegionSelector } from "@/plugins/generator/ui/RegionSelector";
import { mount } from "./fixtures/harness";

function polygon(key: string, name: string, code?: string): Selection {
	return {
		key,
		color: "#fff",
		selector: {
			type: "Polygon",
			polygon: { properties: { name, code }, coordinates: [] },
		},
	} as unknown as Selection;
}

function region(target: number, found: number, isProcessing = false): GeneratorRegionMeta {
	return {
		target,
		found: Array.from({ length: found }, () => ({}) as never),
		checkedPanos: new Set<string>(),
		isProcessing,
	};
}

function render(selections: Selection[], meta: Map<string, GeneratorRegionMeta>) {
	h.selections = selections;
	return mount(
		<RegionSelector
			defaultTarget={10}
			onDefaultTargetChange={() => {}}
			meta={meta}
			onMetaChange={() => {}}
		/>,
	);
}

describe("the generator region list", () => {
	it("shows a flag for a two-letter country code and none for a subdivision code", () => {
		const m = render(
			[polygon("a", "France", "FR"), polygon("b", "Kabul", "AFG")],
			new Map([
				["a", region(10, 0)],
				["b", region(10, 0)],
			]),
		);

		const rows = [...m.container.querySelectorAll(".generator-regions__item-name")];
		expect(rows).toHaveLength(2);
		expect(rows[0].querySelector("img")?.getAttribute("src")).toBe("/flags/FR.svg");
		expect(rows[1].querySelector("img")).toBeNull();
	});

	it("totals found and target across every region", () => {
		const m = render(
			[polygon("a", "France", "FR"), polygon("b", "Spain", "ES")],
			new Map([
				["a", region(10, 3)],
				["b", region(25, 7)],
			]),
		);

		expect(m.container.querySelector(".generator-regions__total")?.textContent).toBe(
			"Total: 10 / 35",
		);
	});

	it("spins only on the region being processed", () => {
		const m = render(
			[polygon("a", "France", "FR"), polygon("b", "Spain", "ES")],
			new Map([
				["a", region(10, 3, true)],
				["b", region(25, 7, false)],
			]),
		);

		const rows = [...m.container.querySelectorAll(".generator-regions__item-name")];
		expect(rows[0].querySelector(".generator-regions__spinner")).not.toBeNull();
		expect(rows[1].querySelector(".generator-regions__spinner")).toBeNull();
	});
});
