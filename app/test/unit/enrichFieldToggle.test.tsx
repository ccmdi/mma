// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";

// The Enrich tab writes the map's `enrichFields`, which decides what enrichment actually
// fetches. Its rule is not obvious: null means "the defaults", so a selection that happens
// to equal the defaults must collapse back to null rather than freeze today's default set
// into the map. Nothing mounted this tab, so none of that was covered.
const h = vi.hoisted(() => ({ locationCount: 0 }));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/store/useMapStore", () => ({
	getMapState: () => ({ locationCount: h.locationCount }),
	coverage: async () => [],
	useMapState: (sel: (s: unknown) => unknown) => sel({ locationCount: h.locationCount }),
}));

import { EnrichTab } from "@/components/editor/map/EnrichmentDialog";
import { getDefaultEnrichKeys, getEnrichFieldOptions } from "@/lib/data/fieldDefs";
import { mount } from "./fixtures/harness";

function renderTab(enrichFields: string[] | null) {
	const setEnrichFields = vi.fn();
	const m = mount(
		<EnrichTab
			enrichMetadata={true}
			setEnrichMetadata={() => {}}
			enrichFields={enrichFields}
			setEnrichFields={setEnrichFields}
			onOpenManual={() => {}}
		/>,
	);
	const rows = [...m.container.querySelectorAll<HTMLElement>(".enrich-field")];
	const boxes = rows.map((r) => r.querySelector<HTMLElement>('[role="switch"]')!);
	return { m, rows, boxes, setEnrichFields };
}

const click = async (el: HTMLElement) => {
	await act(async () => {
		el.click();
	});
};

beforeEach(() => {
	h.locationCount = 0;
});

describe("the Enrich tab writes enrichFields", () => {
	it("offers a row per enrichable field", () => {
		const { rows, m } = renderTab(null);
		expect(rows).toHaveLength(getEnrichFieldOptions().length);
		m.unmount();
	});

	it("a null value shows the default set as on, and defaultOff fields as off", () => {
		const { boxes, m } = renderTab(null);
		const defaults = new Set(getDefaultEnrichKeys());
		getEnrichFieldOptions().forEach((f, i) => {
			expect(boxes[i].getAttribute("aria-checked")).toBe(String(defaults.has(f.key)));
		});
		m.unmount();
	});

	it("turning a default field off writes the remaining set, not null", async () => {
		const { boxes, setEnrichFields, m } = renderTab(null);
		const defaults = getDefaultEnrichKeys();
		const firstDefault = getEnrichFieldOptions().findIndex((f) => f.key === defaults[0]);

		await click(boxes[firstDefault]);

		expect(setEnrichFields).toHaveBeenCalledTimes(1);
		const written = setEnrichFields.mock.calls[0][0] as string[] | null;
		expect(written).not.toBeNull();
		expect(written).not.toContain(defaults[0]);
		expect(written).toHaveLength(defaults.length - 1);
		m.unmount();
	});

	it("returning to exactly the default set collapses back to null", async () => {
		const defaults = getDefaultEnrichKeys();
		// One short of the defaults; switching the missing one back on restores them.
		const { boxes, setEnrichFields, m } = renderTab(defaults.slice(1));
		const missing = getEnrichFieldOptions().findIndex((f) => f.key === defaults[0]);

		await click(boxes[missing]);

		expect(setEnrichFields).toHaveBeenCalledWith(null);
		m.unmount();
	});

	it("adding a defaultOff field writes a set, since it is not the default", async () => {
		const off = getEnrichFieldOptions().findIndex((f) => f.defaultOff);
		if (off < 0) return;
		const { boxes, setEnrichFields, m } = renderTab(null);

		await click(boxes[off]);

		const written = setEnrichFields.mock.calls[0][0] as string[] | null;
		expect(written).not.toBeNull();
		expect(written).toContain(getEnrichFieldOptions()[off].key);
		m.unmount();
	});
});
