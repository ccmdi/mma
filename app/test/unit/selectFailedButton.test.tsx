// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act } from "react";

const h = vi.hoisted(() => ({ editSelections: vi.fn() }));

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
vi.mock("@/lib/util/toast", () => ({ toast: vi.fn() }));
vi.mock("@/store/edit", async (orig) => ({
	Edit: {
		...(await orig<typeof import("@/store/edit")>()).Edit,
		selections: h.editSelections,
	},
}));

import { BulkProgress, startBulkRun } from "@/components/dialogs/BulkOperationModal";
import type { BatchOutcome } from "@/lib/data/procedure";
import { mount } from "./fixtures/harness";

beforeEach(() => h.editSelections.mockReset());

async function finishedRun(outcome: BatchOutcome) {
	startBulkRun("setField", async () => ({ outcome }), { type: "Everything" });
	const m = mount(<BulkProgress operation="setField" onClose={() => {}} />);
	await act(async () => {});
	return m;
}

const selectFailed = (root: HTMLElement) =>
	[...root.querySelectorAll("button")].find((b) => b.textContent === "Select failed");

describe("the Select failed button", () => {
	it("is absent when the outcome has no failures", async () => {
		const m = await finishedRun({ succeeded: 3, failed: [] });
		expect(selectFailed(m.container)).toBeUndefined();
		m.unmount();
	});

	it("selects exactly the failed ids", async () => {
		const m = await finishedRun({ succeeded: 1, failed: [4, 9] });
		act(() => selectFailed(m.container)!.click());

		expect(h.editSelections.mock.calls[0][0]).toEqual({
			kind: "add",
			selections: [{ selector: { type: "Manual", locations: [4, 9] } }],
		});
		m.unmount();
	});
});
