// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PickingInfo } from "@deck.gl/core";
import type { CellManager } from "@/lib/render/CellManager";

const storeResolvePick = vi.fn();
vi.mock("@/lib/commands", () => ({
	cmd: { storeResolvePick: (...a: unknown[]) => storeResolvePick(...a) },
}));

import { resolvePickedId } from "@/lib/map/mapClick";

const pick = (id: string | undefined, index: number): PickingInfo =>
	({ index, layer: id == null ? null : { id } }) as unknown as PickingInfo;

const fakeCm = (over: Partial<CellManager>): CellManager =>
	({
		selOverlayIds: new Uint32Array(0),
		resolvePickFromCell: () => null,
		...over,
	}) as unknown as CellManager;

beforeEach(() => storeResolvePick.mockReset());

describe("resolvePickedId (shared pick resolution)", () => {
	it("returns null for a non-pick (negative index)", async () => {
		expect(await resolvePickedId(fakeCm({}), pick("cell:abc", -1))).toBeNull();
	});

	it("reads a selection-overlay pick from selOverlayIds", async () => {
		const cm = fakeCm({ selOverlayIds: new Uint32Array([10, 20, 30]) });
		expect(await resolvePickedId(cm, pick("sel-overlay:red", 1))).toBe(20);
	});

	it("resolves a cell pick locally without hitting Rust", async () => {
		const cm = fakeCm({ resolvePickFromCell: (key, i) => (key === "abc" && i === 2 ? 99 : null) });
		expect(await resolvePickedId(cm, pick("cell:abc:0", 2))).toBe(99);
		expect(storeResolvePick).not.toHaveBeenCalled();
	});

	it("falls back to Rust when the cell is not materialized in JS", async () => {
		storeResolvePick.mockResolvedValue(777);
		const cm = fakeCm({ resolvePickFromCell: () => null });
		expect(await resolvePickedId(cm, pick("cell:xyz:1", 5))).toBe(777);
		expect(storeResolvePick).toHaveBeenCalledWith("xyz", 5);
	});

	it("returns null for an unrelated layer", async () => {
		expect(await resolvePickedId(fakeCm({}), pick("import-preview", 0))).toBeNull();
	});
});
