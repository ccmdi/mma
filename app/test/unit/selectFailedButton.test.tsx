// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";
import type { Selector } from "@/bindings.gen";

const h = vi.hoisted(() => ({ addSelections: vi.fn() }));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/lib/util/toast", () => ({ toast: vi.fn() }));
vi.mock("@/store/useMapStore", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	addSelections: h.addSelections,
}));

import { SelectFailedButton } from "@/components/dialogs/BulkOperationModal";
import { mount } from "./fixtures/harness";

beforeEach(() => h.addSelections.mockReset());

describe("the Select failed button", () => {
	it("renders nothing when the outcome has no failures", () => {
		const m = mount(<SelectFailedButton outcome={{ succeeded: 3, failed: [] }} />);
		expect(m.container.querySelector("button")).toBeNull();
		m.unmount();
	});

	it("selects exactly the failed ids", () => {
		const m = mount(<SelectFailedButton outcome={{ succeeded: 1, failed: [4, 9] }} />);
		act(() => m.container.querySelector("button")!.click());

		expect(h.addSelections).toHaveBeenCalledTimes(1);
		const selectors = h.addSelections.mock.calls[0][0] as Selector[];
		expect(selectors).toEqual([{ type: "Manual", locations: [4, 9] }]);
		m.unmount();
	});
});
