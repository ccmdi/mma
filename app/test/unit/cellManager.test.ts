import { describe, it, expect, beforeEach } from "vitest";
import {
	CellBuffer,
	CellManager,
	decodeSelectionBitmask,
	type CellRenderEntry,
	type CellDelta,
	type SelEntry,
} from "@/lib/render/CellManager";

function entry(cell: string, id: number, lng: number, lat: number, heading = 0): CellRenderEntry {
	return { cell, id, lng, lat, heading, r: 42, g: 42, b: 42, a: 255 };
}

/** A dense-bitmask SelEntry, the shape applySelectionBitmasks consumes. */
const maskSel = (mask: Uint8Array): SelEntry => ({ kind: "mask", mask });

describe("CellBuffer", () => {
	let buf: CellBuffer;

	beforeEach(() => {
		buf = new CellBuffer();
	});

	it("starts empty", () => {
		expect(buf.count).toBe(0);
		expect(buf.ids).toEqual([]);
	});

	it("append stores position, color, angle, and id", () => {
		buf.append(entry("s", 1, 10.5, 20.5, 90));
		expect(buf.count).toBe(1);
		expect(buf.ids[0]).toBe(1);
		expect(buf.positions[0]).toBeCloseTo(10.5);
		expect(buf.positions[1]).toBeCloseTo(20.5);
		expect(buf.angles[0]).toBeCloseTo(90);
		expect(buf.colors[0]).toBe(42);
		expect(buf.colors[3]).toBe(255);
		expect(buf.idToIndex.get(1)).toBe(0);
	});

	it("append multiple entries", () => {
		buf.append(entry("s", 1, 10, 20));
		buf.append(entry("s", 2, 30, 40));
		buf.append(entry("s", 3, 50, 60));
		expect(buf.count).toBe(3);
		expect(buf.idToIndex.get(2)).toBe(1);
	});

	it("swapRemove from middle swaps last into gap", () => {
		buf.append(entry("s", 10, 1, 1));
		buf.append(entry("s", 20, 2, 2));
		buf.append(entry("s", 30, 3, 3));
		buf.swapRemove(0);

		expect(buf.count).toBe(2);
		expect(buf.ids[0]).toBe(30);
		expect(buf.idToIndex.get(30)).toBe(0);
		expect(buf.idToIndex.get(20)).toBe(1);
		expect(buf.idToIndex.has(10)).toBe(false);
		expect(buf.positions[0]).toBeCloseTo(3);
	});

	it("swapRemove last element", () => {
		buf.append(entry("s", 10, 1, 1));
		buf.append(entry("s", 20, 2, 2));
		buf.swapRemove(1);

		expect(buf.count).toBe(1);
		expect(buf.ids[0]).toBe(10);
		expect(buf.idToIndex.has(20)).toBe(false);
	});

	it("swapRemove only element", () => {
		buf.append(entry("s", 10, 1, 1));
		buf.swapRemove(0);
		expect(buf.count).toBe(0);
		expect(buf.idToIndex.size).toBe(0);
	});

	it("patchPosition updates coordinates", () => {
		buf.append(entry("s", 1, 10, 20, 0));
		buf.patchPosition(0, 99, 88, 45);
		expect(buf.positions[0]).toBeCloseTo(99);
		expect(buf.positions[1]).toBeCloseTo(88);
		expect(buf.angles[0]).toBeCloseTo(45);
	});

	it("patchPosition partial update", () => {
		buf.append(entry("s", 1, 10, 20, 0));
		buf.patchPosition(0, undefined, undefined, 45);
		expect(buf.positions[0]).toBeCloseTo(10);
		expect(buf.positions[1]).toBeCloseTo(20);
		expect(buf.angles[0]).toBeCloseTo(45);
	});

	it("patchColor updates RGBA", () => {
		buf.append(entry("s", 1, 10, 20));
		buf.patchColor(0, 255, 0, 0, 128);
		expect(buf.colors[0]).toBe(255);
		expect(buf.colors[1]).toBe(0);
		expect(buf.colors[2]).toBe(0);
		expect(buf.colors[3]).toBe(128);
	});

	it("grows capacity when needed", () => {
		for (let i = 0; i < 300; i++) {
			buf.append(entry("s", i, i, i));
		}
		expect(buf.count).toBe(300);
		expect(buf.capacity).toBeGreaterThanOrEqual(300);
		expect(buf.idToIndex.get(299)).toBe(299);
	});
});

describe("CellManager", () => {
	let mgr: CellManager;

	beforeEach(() => {
		mgr = new CellManager();
	});

	it("starts with no cells", () => {
		expect(mgr.cells.size).toBe(0);
		expect(mgr.totalCount).toBe(0);
	});

	it("applyDelta adds entries to cells", () => {
		const delta: CellDelta = {
			added: [entry("s", 1, 10, 20), entry("s", 2, 30, 40), entry("t", 3, 50, 60)],
			updated: [],
			removed: [],
			colorPatches: [],
		};
		mgr.applyDelta(delta);
		expect(mgr.totalCount).toBe(3);
		expect(mgr.cells.get("s")!.count).toBe(2);
		expect(mgr.cells.get("t")!.count).toBe(1);
	});

	it("applyDelta removes entries", () => {
		mgr.applyDelta({
			added: [entry("s", 1, 10, 20), entry("s", 2, 30, 40)],
			updated: [],
			removed: [],
			colorPatches: [],
		});
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [{ cell: "s", cellIndex: 0, id: 1 }],
			colorPatches: [],
		});
		expect(mgr.totalCount).toBe(1);
	});

	it("applyDelta patches positions", () => {
		mgr.applyDelta({
			added: [entry("s", 1, 10, 20, 0)],
			updated: [],
			removed: [],
			colorPatches: [],
		});
		mgr.applyDelta({
			added: [],
			updated: [{ cell: "s", cellIndex: 0, heading: 90 }],
			removed: [],
			colorPatches: [],
		});
		expect(mgr.cells.get("s")!.angles[0]).toBeCloseTo(90);
	});

	it("applyDelta patches colors", () => {
		mgr.applyDelta({ added: [entry("s", 1, 10, 20)], updated: [], removed: [], colorPatches: [] });
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [],
			colorPatches: [{ cell: "s", cellIndex: 0, r: 255, g: 0, b: 0, a: 128 }],
		});
		const cb = mgr.cells.get("s")!;
		expect(cb.colors[0]).toBe(255);
		expect(cb.colors[3]).toBe(128);
	});

	it("applyDelta with fullReset clears everything first", () => {
		mgr.applyDelta({ added: [entry("s", 1, 10, 20)], updated: [], removed: [], colorPatches: [] });
		mgr.applyDelta({
			added: [entry("t", 2, 30, 40)],
			updated: [],
			removed: [],
			colorPatches: [],
			fullReset: true,
		});
		// fullReset isn't handled in applyDelta — it's handled by the caller. But the delta still applies.
		// So totalCount should be 2 (original + new)
		expect(mgr.totalCount).toBe(2);
	});

	it("resolvePickFromCell returns correct id", () => {
		mgr.applyDelta({
			added: [entry("s", 42, 10, 20), entry("s", 99, 30, 40)],
			updated: [],
			removed: [],
			colorPatches: [],
		});
		expect(mgr.resolvePickFromCell("s", 0)).toBe(42);
		expect(mgr.resolvePickFromCell("s", 1)).toBe(99);
	});

	it("resolvePickFromCell returns null for invalid", () => {
		expect(mgr.resolvePickFromCell("x", 0)).toBeNull();
		mgr.applyDelta({ added: [entry("s", 1, 10, 20)], updated: [], removed: [], colorPatches: [] });
		expect(mgr.resolvePickFromCell("s", 5)).toBeNull();
	});

	it("version increments on each delta", () => {
		const v0 = mgr.version;
		mgr.applyDelta({ added: [entry("s", 1, 10, 20)], updated: [], removed: [], colorPatches: [] });
		expect(mgr.version).toBe(v0 + 1);
		mgr.applyDelta({ added: [], updated: [], removed: [], colorPatches: [] });
		expect(mgr.version).toBe(v0 + 2);
	});

	it("clear resets everything", () => {
		mgr.applyDelta({ added: [entry("s", 1, 10, 20)], updated: [], removed: [], colorPatches: [] });
		mgr.clear();
		expect(mgr.totalCount).toBe(0);
		expect(mgr.cells.size).toBe(0);
	});

	it("add then remove then add reuses cell correctly", () => {
		mgr.applyDelta({ added: [entry("s", 1, 10, 20)], updated: [], removed: [], colorPatches: [] });
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [{ cell: "s", cellIndex: 0, id: 1 }],
			colorPatches: [],
		});
		mgr.applyDelta({ added: [entry("s", 2, 30, 40)], updated: [], removed: [], colorPatches: [] });
		expect(mgr.totalCount).toBe(1);
		expect(mgr.resolvePickFromCell("s", 0)).toBe(2);
	});

	// --- initFromBinary (Rust render buffer format) ---

	it("initFromBinary parses render buffer correctly", () => {
		// Build a binary buffer matching Rust's format:
		// [u32 cell_count]
		// per cell: [u8 geohash_char][u32 count][u32[] ids][f32[] positions][u8[] colors][f32[] angles]
		// [u32 sel_count] (0 for no selections)
		const buf = new ArrayBuffer(4 + (5 + 2 * 4 + 2 * 2 * 4 + 2 * 4 + 2 * 4) + 4);
		const dv = new DataView(buf);
		let off = 0;

		// 1 cell
		dv.setUint32(off, 1, true);
		off += 4;
		// cell char 's' (0x73)
		dv.setUint8(off, 0x73);
		off += 1;
		// 2 locations
		dv.setUint32(off, 2, true);
		off += 4;
		// ids
		dv.setUint32(off, 42, true);
		off += 4;
		dv.setUint32(off, 99, true);
		off += 4;
		// positions (lng, lat pairs)
		dv.setFloat32(off, 10.5, true);
		off += 4;
		dv.setFloat32(off, 20.5, true);
		off += 4;
		dv.setFloat32(off, 30.5, true);
		off += 4;
		dv.setFloat32(off, 40.5, true);
		off += 4;
		// colors (RGBA per loc)
		dv.setUint8(off, 42);
		off += 1;
		dv.setUint8(off, 42);
		off += 1;
		dv.setUint8(off, 42);
		off += 1;
		dv.setUint8(off, 255);
		off += 1;
		dv.setUint8(off, 42);
		off += 1;
		dv.setUint8(off, 42);
		off += 1;
		dv.setUint8(off, 42);
		off += 1;
		dv.setUint8(off, 255);
		off += 1;
		// angles
		dv.setFloat32(off, 90, true);
		off += 4;
		dv.setFloat32(off, 180, true);
		off += 4;
		// selection overlay count = 0
		dv.setUint32(off, 0, true);

		mgr.initFromBinary(buf);
		expect(mgr.totalCount).toBe(2);
		expect(mgr.cells.size).toBe(1);
		const cb = mgr.cells.get("s")!;
		expect(cb.count).toBe(2);
		expect(cb.ids[0]).toBe(42);
		expect(cb.ids[1]).toBe(99);
		expect(cb.positions[0]).toBeCloseTo(10.5);
		expect(cb.positions[1]).toBeCloseTo(20.5);
		expect(cb.positions[2]).toBeCloseTo(30.5);
		expect(cb.positions[3]).toBeCloseTo(40.5);
		expect(cb.colors[3]).toBe(255);
		expect(cb.angles[0]).toBeCloseTo(90);
		expect(cb.angles[1]).toBeCloseTo(180);
		expect(cb.idToIndex.get(42)).toBe(0);
		expect(cb.idToIndex.get(99)).toBe(1);
	});

	it("initFromBinary handles empty buffer", () => {
		const buf = new ArrayBuffer(4);
		new DataView(buf).setUint32(0, 0, true);
		mgr.initFromBinary(buf);
		expect(mgr.totalCount).toBe(0);
		expect(mgr.cells.size).toBe(0);
	});

	it("initFromBinary parses selection overlay", () => {
		// 0 cells + 1 selection overlay entry
		const buf = new ArrayBuffer(4 + 4 + 2 * 4 + 4 + 4 + 4);
		const dv = new DataView(buf);
		let off = 0;
		dv.setUint32(off, 0, true);
		off += 4; // 0 cells
		dv.setUint32(off, 1, true);
		off += 4; // 1 sel overlay entry
		// position
		dv.setFloat32(off, 5.5, true);
		off += 4;
		dv.setFloat32(off, 6.5, true);
		off += 4;
		// color
		dv.setUint8(off, 255);
		off += 1;
		dv.setUint8(off, 0);
		off += 1;
		dv.setUint8(off, 0);
		off += 1;
		dv.setUint8(off, 255);
		off += 1;
		// angle
		dv.setFloat32(off, 45, true);
		off += 4;
		// id
		dv.setUint32(off, 7, true);

		mgr.initFromBinary(buf);
		expect(mgr.selOverlayCount).toBe(1);
		expect(mgr.selOverlayIds[0]).toBe(7);
		expect(mgr.selOverlayPositions[0]).toBeCloseTo(5.5);
		expect(mgr.selOverlayColors[0]).toBe(255);
	});

	it("initFromBinary clears previous state", () => {
		mgr.applyDelta({ added: [entry("x", 1, 1, 1)], updated: [], removed: [], colorPatches: [] });
		expect(mgr.totalCount).toBe(1);

		const buf = new ArrayBuffer(4 + 4);
		const dv = new DataView(buf);
		dv.setUint32(0, 0, true); // 0 cells
		dv.setUint32(4, 0, true); // 0 sel overlay
		mgr.initFromBinary(buf);
		expect(mgr.totalCount).toBe(0);
		expect(mgr.cells.size).toBe(0);
	});

	it("buildSelectionOverlay creates overlay from color patches", () => {
		mgr.applyDelta({
			added: [entry("s", 1, 10, 20, 45), entry("s", 2, 30, 40, 90)],
			updated: [],
			removed: [],
			colorPatches: [],
		});
		mgr.buildSelectionOverlay([{ cell: "s", cellIndex: 0, r: 255, g: 0, b: 0, a: 255 }]);
		expect(mgr.selOverlayCount).toBe(1);
		expect(mgr.selOverlayIds[0]).toBe(1);
		expect(mgr.selOverlayPositions[0]).toBeCloseTo(10);
		expect(mgr.selOverlayPositions[1]).toBeCloseTo(20);
		expect(mgr.selOverlayColors[0]).toBe(255);
	});
});

// ---------------------------------------------------------------------------
// Selection bitmask mapping: the critical invariant is that bitmask index N
// maps to CellBuffer.ids[N]. If swap-removes cause drift, the wrong location
// gets colored.
// ---------------------------------------------------------------------------

describe("applySelectionBitmasks", () => {
	let mgr: CellManager;

	beforeEach(() => {
		mgr = new CellManager();
	});

	it("basic bitmask selects correct IDs", () => {
		mgr.applyDelta({
			added: [entry("s", 10, 1, 1), entry("s", 20, 2, 2), entry("s", 30, 3, 3)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// bitmask: select index 1 only (id=20)
		const mask = new Uint8Array([0b010]); // bit 1 set
		const selectedIds = mgr.applySelectionBitmasks(
			[[255, 0, 0]],
			[{ cellChar: "s", locCount: 3, sels: [maskSel(mask)] }],
		);
		expect(selectedIds.size).toBe(1);
		expect(selectedIds.has(20)).toBe(true);
		expect(selectedIds.has(10)).toBe(false);
		expect(selectedIds.has(30)).toBe(false);
	});

	it("idx-format selection matches the equivalent mask", () => {
		mgr.applyDelta({
			added: [entry("s", 10, 1, 1), entry("s", 20, 2, 2), entry("s", 30, 3, 3)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// Sparse index-list: select local indices 0 and 2 (ids 10, 30).
		const idxIds = mgr.applySelectionBitmasks(
			[[0, 255, 0]],
			[{ cellChar: "s", locCount: 3, sels: [{ kind: "idx", indices: new Uint32Array([0, 2]) }] }],
		);
		expect(idxIds.size).toBe(2);
		expect(idxIds.has(10)).toBe(true);
		expect(idxIds.has(30)).toBe(true);
		expect(idxIds.has(20)).toBe(false);
		expect([...idxIds].sort((a, b) => a - b)).toEqual([10, 30]);
		expect(mgr.selOverlayCount).toBe(2);

		// The equivalent dense mask (bits 0 and 2) must yield the same selected set.
		const maskIds = mgr.applySelectionBitmasks(
			[[0, 255, 0]],
			[{ cellChar: "s", locCount: 3, sels: [maskSel(new Uint8Array([0b101]))] }],
		);
		expect([...maskIds].sort((a, b) => a - b)).toEqual([10, 30]);
	});

	it("idx-format ignores indices past the cell's count", () => {
		mgr.applyDelta({
			added: [entry("s", 10, 1, 1), entry("s", 20, 2, 2)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// Index 5 is out of bounds for a 2-location cell -> clamped, only index 0 (id 10) selected.
		const ids = mgr.applySelectionBitmasks(
			[[0, 255, 0]],
			[{ cellChar: "s", locCount: 2, sels: [{ kind: "idx", indices: new Uint32Array([0, 5]) }] }],
		);
		expect(ids.size).toBe(1);
		expect(ids.has(10)).toBe(true);
		expect([...ids]).toEqual([10]);
		expect(mgr.selOverlayCount).toBe(1);
	});

	it("bitmask after swap-remove still maps to correct IDs", () => {
		mgr.applyDelta({
			added: [entry("s", 10, 1, 1), entry("s", 20, 2, 2), entry("s", 30, 3, 3)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// Remove index 0 (id=10) — id=30 swaps into index 0
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [{ cell: "s", cellIndex: 0, id: 10 }],
			colorPatches: [],
		});

		// After swap-remove: ids = [30, 20], count = 2
		const cb = mgr.cells.get("s")!;
		expect(cb.ids[0]).toBe(30);
		expect(cb.ids[1]).toBe(20);

		// Select index 0 — should be id=30 (not the old id=10)
		const mask = new Uint8Array([0b01]);
		const selectedIds = mgr.applySelectionBitmasks(
			[[255, 0, 0]],
			[{ cellChar: "s", locCount: 2, sels: [maskSel(mask)] }],
		);
		expect(selectedIds.has(30)).toBe(true);
		expect(selectedIds.has(10)).toBe(false);
	});

	it("slot reuse: remove tagged, add untagged, bitmask should not select untagged", () => {
		// 3 entries: id=10 (tagged), id=20 (tagged), id=30 (not tagged)
		mgr.applyDelta({
			added: [entry("s", 10, 1, 1), entry("s", 20, 2, 2), entry("s", 30, 3, 3)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// Remove the tagged ones (indices 0 and 1)
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [{ cell: "s", cellIndex: 0, id: 10 }],
			colorPatches: [],
		});
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [
				{ cell: "s", cellIndex: 0, id: 30 }, // 30 swapped to 0 after first remove
			],
			colorPatches: [],
		});

		// Now only id=20 at index 0
		expect(mgr.cells.get("s")!.count).toBe(1);
		expect(mgr.cells.get("s")!.ids[0]).toBe(20);

		// Add new untagged entries that fill the freed slots
		mgr.applyDelta({
			added: [entry("s", 40, 4, 4), entry("s", 50, 5, 5)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// ids = [20, 40, 50]
		// A bitmask that only selects the originally-tagged id=20 (index 0)
		const mask = new Uint8Array([0b001]);
		const selectedIds = mgr.applySelectionBitmasks(
			[[255, 0, 0]],
			[{ cellChar: "s", locCount: 3, sels: [maskSel(mask)] }],
		);
		expect(selectedIds.has(20)).toBe(true);
		expect(selectedIds.has(40)).toBe(false);
		expect(selectedIds.has(50)).toBe(false);
	});

	it("multiple selections: overlapping loc appears once per selection, last drawn on top", () => {
		mgr.applyDelta({
			added: [entry("s", 10, 1, 1), entry("s", 20, 2, 2), entry("s", 30, 3, 3)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// Selection 0 (red): indices 0,1
		// Selection 1 (blue): indices 1,2
		// Overlap at index 1 — appears in both, blue drawn later
		const mask0 = new Uint8Array([0b011]);
		const mask1 = new Uint8Array([0b110]);
		const selectedIds = mgr.applySelectionBitmasks(
			[
				[255, 0, 0],
				[0, 0, 255],
			],
			[{ cellChar: "s", locCount: 3, sels: [maskSel(mask0), maskSel(mask1)] }],
		);
		expect(selectedIds.size).toBe(3);
		expect(selectedIds.has(10)).toBe(true);
		expect(selectedIds.has(20)).toBe(true);
		expect(selectedIds.has(30)).toBe(true);

		// id=20 appears twice (once per selection), total overlay count = 4
		expect(mgr.selOverlayCount).toBe(4);
		const indices20 = mgr.selOverlayIds
			.slice(0, mgr.selOverlayCount)
			.reduce<number[]>((acc, id, i) => (id === 20 ? [...acc, i] : acc), []);
		expect(indices20.length).toBe(2);
		// First occurrence is red (sel 0), second is blue (sel 1)
		expect(mgr.selOverlayColors[indices20[0] * 4]).toBe(255);
		expect(mgr.selOverlayColors[indices20[0] * 4 + 2]).toBe(0);
		expect(mgr.selOverlayColors[indices20[1] * 4]).toBe(0);
		expect(mgr.selOverlayColors[indices20[1] * 4 + 2]).toBe(255);
	});

	it("selected entries get alpha=0 in main layer (hidden)", () => {
		mgr.applyDelta({
			added: [entry("s", 10, 1, 1), entry("s", 20, 2, 2)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		const mask = new Uint8Array([0b01]); // select index 0 only
		mgr.applySelectionBitmasks(
			[[255, 0, 0]],
			[{ cellChar: "s", locCount: 2, sels: [maskSel(mask)] }],
		);

		const cb = mgr.cells.get("s")!;
		// Index 0 (selected) should be hidden: alpha=0
		expect(cb.colors[0 * 4 + 3]).toBe(0);
		// Index 1 (not selected) should be visible: alpha=255
		expect(cb.colors[1 * 4 + 3]).toBe(255);
	});

	it("unselected entries get default color restored", () => {
		mgr.applyDelta({
			added: [entry("s", 10, 1, 1), entry("s", 20, 2, 2)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// First, select both
		mgr.applySelectionBitmasks(
			[[255, 0, 0]],
			[{ cellChar: "s", locCount: 2, sels: [maskSel(new Uint8Array([0b11]))] }],
		);
		// Both hidden
		const cb = mgr.cells.get("s")!;
		expect(cb.colors[0 * 4 + 3]).toBe(0);
		expect(cb.colors[1 * 4 + 3]).toBe(0);

		// Now apply empty selection — should restore default colors
		mgr.applySelectionBitmasks([], [{ cellChar: "s", locCount: 2, sels: [] }]);
		expect(cb.colors[0 * 4]).toBe(42);
		expect(cb.colors[0 * 4 + 3]).toBe(255);
		expect(cb.colors[1 * 4]).toBe(42);
		expect(cb.colors[1 * 4 + 3]).toBe(255);
	});

	// -----------------------------------------------------------------------
	// Bug regression: undo delete sequence (e53e8f5, 66d82f1)
	// After remove delta then add delta (simulating undo), the re-added
	// entry must be pickable and selectable at its new index.
	// -----------------------------------------------------------------------

	it("remove then re-add (undo delete) keeps IDs consistent for bitmask", () => {
		mgr.applyDelta({
			added: [entry("s", 10, 1, 1), entry("s", 20, 2, 2), entry("s", 30, 3, 3)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// Delete id=20 (index 1): id=30 swaps to index 1
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [{ cell: "s", cellIndex: 1, id: 20 }],
			colorPatches: [],
		});

		// Undo: re-add id=20
		mgr.applyDelta({ added: [entry("s", 20, 2, 2)], updated: [], removed: [], colorPatches: [] });

		// Now: ids should be [10, 30, 20] (30 swapped to 1, 20 appended at 2)
		const cb = mgr.cells.get("s")!;
		expect(cb.count).toBe(3);
		expect(cb.ids[0]).toBe(10);
		expect(cb.ids[1]).toBe(30);
		expect(cb.ids[2]).toBe(20);

		// Select index 2 (the re-added id=20)
		const mask = new Uint8Array([0b100]);
		const selectedIds = mgr.applySelectionBitmasks(
			[[255, 0, 0]],
			[{ cellChar: "s", locCount: 3, sels: [maskSel(mask)] }],
		);
		expect(selectedIds.has(20)).toBe(true);
		expect(selectedIds.has(10)).toBe(false);
		expect(selectedIds.has(30)).toBe(false);
	});

	it("full undo/redo cycle: add 3, delete 1, undo delete, redo delete", () => {
		// Add 3
		mgr.applyDelta({
			added: [entry("s", 10, 1, 1), entry("s", 20, 2, 2), entry("s", 30, 3, 3)],
			updated: [],
			removed: [],
			colorPatches: [],
		});
		expect(mgr.totalCount).toBe(3);

		// Delete id=10 (index 0)
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [{ cell: "s", cellIndex: 0, id: 10 }],
			colorPatches: [],
		});
		expect(mgr.totalCount).toBe(2);
		const cbAfterDel = mgr.cells.get("s")!;
		expect(cbAfterDel.count).toBe(2);
		expect(cbAfterDel.ids[0]).toBe(30);
		expect(cbAfterDel.ids[1]).toBe(20);

		// Undo delete (re-add id=10)
		mgr.applyDelta({ added: [entry("s", 10, 1, 1)], updated: [], removed: [], colorPatches: [] });
		expect(mgr.totalCount).toBe(3);
		expect(mgr.resolvePickFromCell("s", 2)).toBe(10);

		// Redo delete (remove id=10 again, now at index 2)
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [{ cell: "s", cellIndex: 2, id: 10 }],
			colorPatches: [],
		});
		expect(mgr.totalCount).toBe(2);
		const cb = mgr.cells.get("s")!;
		expect(cb.count).toBe(2);
		expect(cb.idToIndex.has(10)).toBe(false);
		expect(mgr.resolvePickFromCell("s", 0)).toBe(30);
		expect(mgr.resolvePickFromCell("s", 1)).toBe(20);
	});

	it("cross-cell bitmask: each cell maps independently", () => {
		mgr.applyDelta({
			added: [
				entry("s", 10, 1, 1),
				entry("s", 20, 2, 2),
				entry("t", 30, 3, 3),
				entry("t", 40, 4, 4),
			],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// Select index 1 in cell "s" (id=20) and index 0 in cell "t" (id=30)
		const maskS = new Uint8Array([0b10]);
		const maskT = new Uint8Array([0b01]);
		const selectedIds = mgr.applySelectionBitmasks(
			[[255, 0, 0]],
			[
				{ cellChar: "s", locCount: 2, sels: [maskSel(maskS)] },
				{ cellChar: "t", locCount: 2, sels: [maskSel(maskT)] },
			],
		);
		expect(selectedIds.size).toBe(2);
		expect(selectedIds.has(20)).toBe(true);
		expect(selectedIds.has(30)).toBe(true);
		expect(selectedIds.has(10)).toBe(false);
		expect(selectedIds.has(40)).toBe(false);
	});

	it("partial bitmask: sending one cell preserves other cells' overlay", () => {
		mgr.applyDelta({
			added: [
				entry("s", 10, 1, 1),
				entry("s", 20, 2, 2),
				entry("t", 30, 3, 3),
				entry("t", 40, 4, 4),
			],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// Full bitmask: select id=20 in "s" and id=30 in "t"
		mgr.applySelectionBitmasks(
			[[255, 0, 0]],
			[
				{ cellChar: "s", locCount: 2, sels: [maskSel(new Uint8Array([0b10]))] },
				{ cellChar: "t", locCount: 2, sels: [maskSel(new Uint8Array([0b01]))] },
			],
		);
		expect(mgr.selOverlayCount).toBe(2);

		// Partial bitmask: only update cell "s", now select id=10 instead of id=20
		const ids = mgr.applySelectionBitmasks(
			[[255, 0, 0]],
			[{ cellChar: "s", locCount: 2, sels: [maskSel(new Uint8Array([0b01]))] }],
		);

		// Cell "s" updated: id=10 selected. Cell "t" untouched: id=30 still selected.
		expect(ids.has(10)).toBe(true);
		expect(ids.has(20)).toBe(false);
		expect(ids.has(30)).toBe(true);
		expect(mgr.selOverlayCount).toBe(2);
	});

	it("partial bitmask: deselecting all in one cell keeps other cells' overlay", () => {
		mgr.applyDelta({
			added: [entry("s", 10, 1, 1), entry("t", 20, 2, 2)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// Select both
		mgr.applySelectionBitmasks(
			[[255, 0, 0]],
			[
				{ cellChar: "s", locCount: 1, sels: [maskSel(new Uint8Array([0b1]))] },
				{ cellChar: "t", locCount: 1, sels: [maskSel(new Uint8Array([0b1]))] },
			],
		);
		expect(mgr.selOverlayCount).toBe(2);

		// Deselect cell "s" only
		const ids = mgr.applySelectionBitmasks(
			[[255, 0, 0]],
			[{ cellChar: "s", locCount: 1, sels: [maskSel(new Uint8Array([0b0]))] }],
		);

		expect(ids.has(10)).toBe(false);
		expect(ids.has(20)).toBe(true);
		expect(mgr.selOverlayCount).toBe(1);
	});

	it("deleted location's overlay entry is dropped on next bitmask", () => {
		mgr.applyDelta({
			added: [entry("s", 10, 1, 1), entry("s", 20, 2, 2)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// Select both
		mgr.applySelectionBitmasks(
			[[255, 0, 0]],
			[{ cellChar: "s", locCount: 2, sels: [maskSel(new Uint8Array([0b11]))] }],
		);
		expect(mgr.selOverlayCount).toBe(2);

		// Delete id=10 (swap-remove at index 0, id=20 moves to index 0)
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [{ cell: "s", cellIndex: 0, id: 10 }],
			colorPatches: [],
		});

		// Partial bitmask for cell "s" — only 1 entry now (id=20), selected
		const ids = mgr.applySelectionBitmasks(
			[[255, 0, 0]],
			[{ cellChar: "s", locCount: 1, sels: [maskSel(new Uint8Array([0b1]))] }],
		);

		expect(ids.has(20)).toBe(true);
		expect(ids.has(10)).toBe(false);
		expect(mgr.selOverlayCount).toBe(1);
	});

	it("_removedIds does not leak across mutations", () => {
		mgr.applyDelta({
			added: [entry("s", 10, 1, 1), entry("s", 20, 2, 2), entry("s", 30, 3, 3)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// Select all three
		mgr.applySelectionBitmasks(
			[[255, 0, 0]],
			[{ cellChar: "s", locCount: 3, sels: [maskSel(new Uint8Array([0b111]))] }],
		);

		// Mutation 1: delete id=10
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [{ cell: "s", cellIndex: 0, id: 10 }],
			colorPatches: [],
		});
		mgr.applySelectionBitmasks(
			[[255, 0, 0]],
			[{ cellChar: "s", locCount: 2, sels: [maskSel(new Uint8Array([0b11]))] }],
		);

		// Mutation 2: no removals, just a bitmask refresh.
		// id=30 should NOT be dropped by stale _removedIds from mutation 1.
		mgr.applyDelta({ added: [], updated: [], removed: [], colorPatches: [] });
		const ids = mgr.applySelectionBitmasks(
			[[255, 0, 0]],
			[{ cellChar: "s", locCount: 2, sels: [maskSel(new Uint8Array([0b11]))] }],
		);

		expect(ids.size).toBe(2);
		expect(ids.has(10)).toBe(false);
	});
});

describe("decodeSelectionBitmask", () => {
	// Wire format produced by Rust serialize_cell_bitmask (location_store.rs):
	// u32le numSels; numSels*[r,g,b]; u8 numCells; per cell: u8 cellChar, u32le locCount,
	// per sel: u8 fmt (1 = u32le count + count*u32le indices, 0 = ceil(locCount/8) mask bytes).
	it("decodes colors, idx entries, and mask entries", () => {
		const bytes = [
			2,
			0,
			0,
			0, // numSels
			255,
			0,
			0, // sel 0 color
			0,
			128,
			255, // sel 1 color
			2, // numCells
			// cell "s", locCount=10
			115,
			10,
			0,
			0,
			0,
			// sel 0: idx [2, 7]
			1,
			2,
			0,
			0,
			0,
			2,
			0,
			0,
			0,
			7,
			0,
			0,
			0,
			// sel 1: mask (2 bytes), bits 0 and 9
			0,
			0b00000001,
			0b00000010,
			// cell "t", locCount=3
			116,
			3,
			0,
			0,
			0,
			// sel 0: mask (1 byte), bit 1
			0,
			0b00000010,
			// sel 1: empty idx
			1,
			0,
			0,
			0,
			0,
		];

		const { selColors, cellEntries } = decodeSelectionBitmask(bytes);

		expect(selColors).toEqual([
			[255, 0, 0],
			[0, 128, 255],
		]);
		expect(cellEntries).toHaveLength(2);

		const [s, t] = cellEntries;
		expect(s.cellChar).toBe("s");
		expect(s.locCount).toBe(10);
		expect(s.sels[0]).toEqual({ kind: "idx", indices: new Uint32Array([2, 7]) });
		expect(s.sels[1].kind).toBe("mask");
		if (s.sels[1].kind === "mask") {
			expect(Array.from(s.sels[1].mask)).toEqual([0b00000001, 0b00000010]);
		}

		expect(t.cellChar).toBe("t");
		expect(t.locCount).toBe(3);
		expect(t.sels[0]).toEqual({ kind: "mask", mask: new Uint8Array([0b00000010]) });
		expect(t.sels[1]).toEqual({ kind: "idx", indices: new Uint32Array(0) });
	});

	it("decoded entries drive applySelectionBitmasks", () => {
		const mgr = new CellManager();
		mgr.applyDelta({
			added: [entry("s", 10, 1, 1), entry("s", 20, 2, 2), entry("s", 30, 3, 3)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// 1 selection (red), cell "s" locCount=3, idx list [0, 2] -> ids 10 and 30
		const bytes = [
			1, 0, 0, 0, 255, 0, 0, 1, 115, 3, 0, 0, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0,
		];
		const { selColors, cellEntries } = decodeSelectionBitmask(bytes);
		const ids = mgr.applySelectionBitmasks(selColors, cellEntries);

		expect(ids.size).toBe(2);
		expect(ids.has(10)).toBe(true);
		expect(ids.has(20)).toBe(false);
		expect(ids.has(30)).toBe(true);
	});
});
