import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emitBitmask } from "@/store/useMapStore";
import { subscribe } from "@/lib/events";
import type { RGB } from "@/lib/util/color";
import type { SelCellEntry } from "@/lib/render/CellManager";

/** Capture what emitBitmask emits for a wire message. */
function decode(bytes: number[]): { selColors: RGB[]; cellEntries: SelCellEntry[] } {
	let captured: { selColors: RGB[]; cellEntries: SelCellEntry[] } = {
		selColors: [],
		cellEntries: [],
	};
	const unsub = subscribe("render:selection", ({ selColors, cellEntries }) => {
		captured = { selColors, cellEntries };
	});
	emitBitmask(bytes);
	unsub();
	return captured;
}

// `selection-bitmask.bin` is written by the Rust serializer (store/engine.test.rs,
// `emit_selection_bitmask_fixture`), which also describes the scene. Decoding the real
// producer's bytes keeps the layout stated once.
// Regenerate with: cargo test emit_selection_bitmask_fixture -- --ignored
// If either side drifts, one of the two suites goes red.
const fixturePath = fileURLToPath(new URL("./fixtures/selection-bitmask.bin", import.meta.url));

describe("emitBitmask wire decode", () => {
	// Skips until the generator has been run, so a checkout without the artifact stays green.
	it.skipIf(!existsSync(fixturePath))("decodes the bitmask binary Rust emits", () => {
		const { selColors, cellEntries } = decode(Array.from(readFileSync(fixturePath)));

		// 300 selections: the count is a u32, so it no longer wraps the way a u8 header did
		// (300 % 256 = 44) and desyncs every following offset.
		expect(selColors).toHaveLength(300);
		expect(selColors[0]).toEqual([255, 0, 0]);
		expect(selColors[1]).toEqual([0, 0, 255]);

		expect(cellEntries.map((e) => e.cellChar)).toEqual(["r", "u"]);

		// The wide cell: an index list is smaller than 200 bits of mask.
		const u = cellEntries.find((e) => e.cellChar === "u")!;
		expect(u.locCount).toBe(200);
		expect(u.sels).toHaveLength(300);
		const [uA, uB] = u.sels;
		expect(uA.kind).toBe("idx");
		if (uA.kind === "idx") expect(Array.from(uA.indices)).toEqual([0, 4, 8]);
		expect(uB.kind).toBe("idx");
		if (uB.kind === "idx") expect(Array.from(uB.indices)).toEqual([]);
		const uLast = u.sels[299];
		expect(uLast.kind).toBe("idx");
		if (uLast.kind === "idx") expect(Array.from(uLast.indices)).toEqual([0]);

		// The narrow cell: 3 locations fit in one mask byte, which beats any index list.
		const r = cellEntries.find((e) => e.cellChar === "r")!;
		expect(r.locCount).toBe(3);
		const [rA, rB] = r.sels;
		expect(rA.kind).toBe("mask");
		if (rA.kind === "mask") expect(Array.from(rA.mask)).toEqual([0]);
		expect(rB.kind).toBe("mask");
		if (rB.kind === "mask") expect(Array.from(rB.mask)).toEqual([0b101]);
	});

	it("emits nothing for a buffer holding no cells", () => {
		const { selColors, cellEntries } = decode([0, 0, 0, 0, 0]);
		expect(selColors).toEqual([]);
		expect(cellEntries).toEqual([]);
	});
});
