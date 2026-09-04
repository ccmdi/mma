// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import type { Selector } from "@/bindings.gen";

const h = vi.hoisted(() => ({ applySelectionUpdate: vi.fn() }));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/lib/util/toast", () => ({ toast: vi.fn() }));
vi.mock("@/store/useMapStore", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	applySelectionUpdate: h.applySelectionUpdate,
}));

import { SelectFailedButton } from "@/components/dialogs/BulkOperationModal";
import { mount } from "./fixtures/harness";

beforeEach(() => h.applySelectionUpdate.mockReset());

describe("the Select failed button", () => {
	it("renders nothing when the outcome has no failures", () => {
		const m = mount(<SelectFailedButton outcome={{ succeeded: 3, failed: [] }} />);
		expect(m.container.querySelector("button")).toBeNull();
		m.unmount();
	});

	it("selects exactly the failed ids", () => {
		const m = mount(<SelectFailedButton outcome={{ succeeded: 1, failed: [4, 9] }} />);
		act(() => m.container.querySelector("button")!.click());

		expect(h.applySelectionUpdate).toHaveBeenCalledTimes(1);
		const op = h.applySelectionUpdate.mock.calls[0][0] as (sels: unknown[]) => { selector: Selector }[];
		const result = op([]);
		expect(result).toHaveLength(1);
		expect(result[0].selector).toEqual({ type: "Manual", locations: [4, 9] });
		m.unmount();
	});
});
