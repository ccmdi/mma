import { describe, it, expect } from "vitest";
import { emitBitmask, selBitmaskBus } from "@/store/useMapStore";
import type { SelCellEntry } from "@/lib/render/CellManager";

const le32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255];

/** Capture the cellEntries emitBitmask emits for a crafted wire message. */
function decode(bytes: number[]): SelCellEntry[] {
	let captured: SelCellEntry[] = [];
	const unsub = selBitmaskBus.on((_colors, cellEntries) => {
		captured = cellEntries;
	});
	emitBitmask(bytes);
	unsub();
	return captured;
}

describe("emitBitmask wire decode", () => {
	it("decodes the index-list (fmt=1) and bitmask (fmt=0) branches", () => {
		// Wire format: [u32 numSels][numSels*RGB][u8 numCells]
		//   per cell: [u8 char][u32 locCount] then per sel [u8 fmt] + (idx: u32 count + u32[]) | (mask: bytes)
		const bytes = [
			...le32(1), // numSels
			255,
			0,
			0, // selColors[0] = red
			2, // numCells
			"a".charCodeAt(0),
			...le32(3), // cell 'a', locCount 3
			1,
			...le32(2),
			...le32(0),
			...le32(2), // fmt=1 index-list: count 2, indices [0,2]
			"b".charCodeAt(0),
			...le32(3), // cell 'b', locCount 3
			0,
			0b101, // fmt=0 bitmask: ceil(3/8)=1 byte, bits 0 and 2 set
		];

		const entries = decode(bytes);
		expect(entries).toHaveLength(2);

		const a = entries.find((e) => e.cellChar === "a")!;
		expect(a.locCount).toBe(3);
		const sa = a.sels[0];
		expect(sa.kind).toBe("idx");
		if (sa.kind === "idx") expect(Array.from(sa.indices)).toEqual([0, 2]);

		const b = entries.find((e) => e.cellChar === "b")!;
		const sb = b.sels[0];
		expect(sb.kind).toBe("mask");
		if (sb.kind === "mask") expect(Array.from(sb.mask)).toEqual([0b101]);
	});

	it("survives more than 255 selections (u32 header, regression)", () => {
		// 300 selections used to wrap the old u8 numSels header (300 % 256 = 44) and
		// desync every following offset -- shift-selecting thousands of tags threw
		// "Invalid typed array length".
		const numSels = 300;
		const bytes = [
			...le32(numSels),
			...Array.from({ length: numSels }, (_, i) => [i % 256, 0, 0]).flat(), // colors
			1, // numCells
			"a".charCodeAt(0),
			...le32(2), // cell 'a', locCount 2
			// per selection: fmt=1 index-list selecting index 0
			...Array.from({ length: numSels }, () => [1, ...le32(1), ...le32(0)]).flat(),
		];

		const entries = decode(bytes);
		expect(entries).toHaveLength(1);
		expect(entries[0].sels).toHaveLength(numSels);
		const last = entries[0].sels[numSels - 1];
		expect(last.kind).toBe("idx");
		if (last.kind === "idx") expect(Array.from(last.indices)).toEqual([0]);
	});
});
