import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

import { applyCounts } from "@/components/editor/tags/applyCounts";

describe("the apply preview counts what Apply creates", () => {
	it("makes one tag per group, empty bins included", () => {
		expect(applyCounts({ total: 12, have: 10, groupSizes: [3, 0, 7] }, false)).toEqual({
			tags: 3,
			locations: 10,
		});
	});

	it("adds one tag for the ungrouped rest only when they are tagged and exist", () => {
		expect(applyCounts({ total: 12, have: 10, groupSizes: [3, 7] }, true)).toEqual({
			tags: 3,
			locations: 12,
		});
		expect(applyCounts({ total: 10, have: 10, groupSizes: [3, 7] }, true)).toEqual({
			tags: 2,
			locations: 10,
		});
	});

	it("is nothing when no location has the field", () => {
		expect(applyCounts({ total: 5, have: 0, groupSizes: [] }, false)).toEqual({
			tags: 0,
			locations: 0,
		});
	});
});
