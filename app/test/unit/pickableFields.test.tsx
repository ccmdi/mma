// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { createFieldDef } from "@/types";

const h = vi.hoisted(() => ({
	fieldDefs: {} as Record<string, unknown>,
	held: [] as [string, number][],
}));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/store/useMapStore", () => {
	const state = () => ({ fieldDefs: h.fieldDefs });
	return {
		getMapState: state,
		useMapState: (sel: (s: unknown) => unknown) => sel(state()),
		coverage: async () => h.held,
		applySelectionUpdate: async () => {},
		fieldValues: async () => [],
	};
});

import { usePickableFields, useExtraFieldKeys } from "@/components/editor/map/FilterBuilder";
import { mount } from "./fixtures/harness";

function Keys({ pickable }: { pickable: boolean }) {
	const offered = usePickableFields();
	const defined = useExtraFieldKeys();
	const fields = pickable ? offered : defined;
	return (
		<ul>
			{fields.map((f) => (
				<li key={f.key}>{f.key}</li>
			))}
		</ul>
	);
}

async function keysOf(pickable: boolean) {
	const m = mount(<Keys pickable={pickable} />);
	await act(async () => {});
	return [...m.container.querySelectorAll("li")].map((li) => li.textContent);
}

describe("pickable fields", () => {
	it("offer the built-ins and only the map's own fields some location holds", async () => {
		h.fieldDefs = { elevation: createFieldDef("number"), region: createFieldDef("string") };
		h.held = [["elevation", 3]];
		const keys = await keysOf(true);
		expect(keys).toContain("elevation");
		expect(keys).toContain("panoId");
		expect(keys).not.toContain("region");
	});

	it("leave the lookup table holding every defined field", async () => {
		h.fieldDefs = { elevation: createFieldDef("number"), region: createFieldDef("string") };
		h.held = [["elevation", 3]];
		expect(await keysOf(false)).toContain("region");
	});
});
