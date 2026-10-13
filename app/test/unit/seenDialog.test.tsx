// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { mount } from "./fixtures/harness";
import type { SeenEntry, SeenFilter } from "@/bindings.gen";

const h = vi.hoisted(() => ({
	loads: [] as { offset: number; filter?: SeenFilter; resolve: (rows: SeenEntry[]) => void }[],
}));

vi.mock("@/lib/seen/seen", () => ({
	Seen: {
		entries: (_limit: number, offset: number, filter?: SeenFilter) =>
			new Promise<SeenEntry[]>((resolve) => h.loads.push({ offset, filter, resolve })),
		count: async () => 30,
		countries: async () => ["fr"],
		maps: async () => [],
		clear: async () => {},
	},
}));

import { SeenDialog } from "@/components/dialogs/SeenDialog";

const entry = (address: string) =>
	({ id: address.length, address, lat: 0, lng: 0, enteredAt: 0, thumbnail: null }) as never;
const shown = () =>
	[...document.querySelectorAll(".seen-entry__location")].map((e) => e.textContent);

describe("Seen dialog", () => {
	it("shows the newest page or filter even when an older load answers last", async () => {
		mount(<SeenDialog open onOpenChange={() => {}} onLoadPano={() => {}} />);
		await act(async () => h.loads[0].resolve([entry("first page")]));
		expect(shown()).toEqual(["first page"]);

		const next = [...document.querySelectorAll("button")].find((b) => b.textContent === "Next")!;
		await act(async () => next.click());
		expect(h.loads[1].offset).toBe(9);

		const country = document.querySelector("select") as HTMLSelectElement;
		await act(async () => {
			country.value = "fr";
			country.dispatchEvent(new Event("change", { bubbles: true }));
		});
		const filtered = h.loads.at(-1)!;
		expect(filtered).toMatchObject({ offset: 0, filter: { country: "fr" } });

		await act(async () => filtered.resolve([entry("filtered")]));
		await act(async () => h.loads[1].resolve([entry("second page")]));
		expect(shown()).toEqual(["filtered"]);
		expect(document.querySelector(".seen-dialog__pagination .mono")?.textContent).toBe("1 / 4");
	});
});
