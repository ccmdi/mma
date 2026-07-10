import { describe, it, expect, beforeEach } from "vitest";
import { CellBuffer, CellManager, type CellRenderEntry } from "@/lib/render/CellManager";

// Default marker color from the Rust render pipeline
const DEFAULT_R = 42,
	DEFAULT_G = 42,
	DEFAULT_B = 42,
	DEFAULT_A = 255;

function entry(
	cell: string,
	id: number,
	lng: number,
	lat: number,
	heading = 0,
	r = DEFAULT_R,
	g = DEFAULT_G,
	b = DEFAULT_B,
	a = DEFAULT_A,
): CellRenderEntry {
	return { cell, id, lng, lat, heading, r, g, b, a };
}

function coloredEntry(cell: string, id: number, r: number, g: number, b: number): CellRenderEntry {
	return entry(cell, id, id, id, 0, r, g, b, 255);
}

// Simulates the active-location logic from MapEmbed.buildLayers:
// - Restore old active to default color (unless selected)
// - Hide new active (alpha=0)
function simulateActiveSwitch(
	mgr: CellManager,
	prevActiveId: number | null,
	newActiveId: number | null,
	selectedIds: Set<number>,
): void {
	if (prevActiveId != null && prevActiveId !== newActiveId) {
		if (!selectedIds.has(prevActiveId)) {
			for (const cb of mgr.cells.values()) {
				const idx = cb.idToIndex.get(prevActiveId);
				if (idx != null) {
					cb.patchColor(idx, DEFAULT_R, DEFAULT_G, DEFAULT_B, DEFAULT_A);
					break;
				}
			}
		}
	}
	if (newActiveId != null) {
		for (const cb of mgr.cells.values()) {
			const idx = cb.idToIndex.get(newActiveId);
			if (idx != null) {
				cb.patchColor(idx, 0, 0, 0, 0);
				break;
			}
		}
	}
}

function getColor(mgr: CellManager, id: number): [number, number, number, number] | null {
	for (const cb of mgr.cells.values()) {
		const idx = cb.idToIndex.get(id);
		if (idx != null) {
			return [
				cb.colors[idx * 4],
				cb.colors[idx * 4 + 1],
				cb.colors[idx * 4 + 2],
				cb.colors[idx * 4 + 3],
			];
		}
	}
	return null;
}

function isVisible(mgr: CellManager, id: number): boolean {
	const c = getColor(mgr, id);
	return c != null && c[3] > 0;
}

function isHidden(mgr: CellManager, id: number): boolean {
	const c = getColor(mgr, id);
	return c != null && c[3] === 0;
}

function selectAll(mgr: CellManager, color: [number, number, number] = [255, 0, 0]): Set<number> {
	const cellEntries = [];
	for (const [cellChar, cb] of mgr.cells) {
		const n = cb.count;
		const byteLen = Math.ceil(n / 8);
		const mask = new Uint8Array(byteLen);
		for (let i = 0; i < n; i++) mask[i >> 3] |= 1 << (i & 7);
		cellEntries.push({ cellChar, locCount: n, sels: [{ kind: "mask" as const, mask }] });
	}
	return mgr.applySelectionBitmasks([color], cellEntries);
}

function selectIds(
	mgr: CellManager,
	ids: Set<number>,
	color: [number, number, number] = [255, 0, 0],
): Set<number> {
	const cellEntries = [];
	for (const [cellChar, cb] of mgr.cells) {
		const n = cb.count;
		const byteLen = Math.ceil(n / 8);
		const mask = new Uint8Array(byteLen);
		for (let i = 0; i < n; i++) {
			if (ids.has(cb.ids[i])) mask[i >> 3] |= 1 << (i & 7);
		}
		cellEntries.push({ cellChar, locCount: n, sels: [{ kind: "mask" as const, mask }] });
	}
	return mgr.applySelectionBitmasks([color], cellEntries);
}

function clearSelection(mgr: CellManager): Set<number> {
	const cellEntries = [];
	for (const [cellChar, cb] of mgr.cells) {
		cellEntries.push({ cellChar, locCount: cb.count, masks: [] as Uint8Array[] });
	}
	return mgr.applySelectionBitmasks([], cellEntries);
}

// ---------------------------------------------------------------------------
// Invariant checkers — reusable assertions that encode "what must always hold"
// ---------------------------------------------------------------------------

function assertNoDoubleMarkers(mgr: CellManager) {
	const overlayIds = new Set(mgr.selOverlayIds.slice(0, mgr.selOverlayCount));
	for (const cb of mgr.cells.values()) {
		for (let i = 0; i < cb.count; i++) {
			const id = cb.ids[i];
			if (overlayIds.has(id)) {
				expect(
					cb.colors[i * 4 + 3],
					`ID ${id} is in overlay but visible in main layer (double marker)`,
				).toBe(0);
			}
		}
	}
}

function assertNoVanishedMarkers(mgr: CellManager, activeId: number | null = null) {
	const overlayIdSet = new Set(mgr.selOverlayIds.slice(0, mgr.selOverlayCount));
	for (const cb of mgr.cells.values()) {
		for (let i = 0; i < cb.count; i++) {
			const id = cb.ids[i];
			if (id === activeId) continue; // active is intentionally hidden
			const mainAlpha = cb.colors[i * 4 + 3];
			if (mainAlpha === 0 && !overlayIdSet.has(id)) {
				throw new Error(
					`ID ${id} is hidden in main layer but missing from overlay (vanished marker)`,
				);
			}
		}
	}
}

function assertOverlayPositionsMatch(mgr: CellManager) {
	for (let i = 0; i < mgr.selOverlayCount; i++) {
		const id = mgr.selOverlayIds[i];
		const overlayLng = mgr.selOverlayPositions[i * 2];
		const overlayLat = mgr.selOverlayPositions[i * 2 + 1];
		for (const cb of mgr.cells.values()) {
			const idx = cb.idToIndex.get(id);
			if (idx != null) {
				expect(
					cb.positions[idx * 2],
					`Overlay lng for ID ${id} doesn't match main layer`,
				).toBeCloseTo(overlayLng, 5);
				expect(
					cb.positions[idx * 2 + 1],
					`Overlay lat for ID ${id} doesn't match main layer`,
				).toBeCloseTo(overlayLat, 5);
			}
		}
	}
}

function assertAllVisible(mgr: CellManager) {
	for (const cb of mgr.cells.values()) {
		for (let i = 0; i < cb.count; i++) {
			expect(
				cb.colors[i * 4 + 3],
				`ID ${cb.ids[i]} has alpha=${cb.colors[i * 4 + 3]}, expected 255`,
			).toBe(255);
		}
	}
}

function assertOverlayEmpty(mgr: CellManager) {
	expect(mgr.selOverlayCount).toBe(0);
}

/** idToIndex must be the exact inverse of ids[0..count]. */
function assertIdToIndexBijective(cb: CellBuffer, label = "") {
	const ctx = label ? ` (${label})` : "";
	expect(
		cb.idToIndex.size,
		`idToIndex.size (${cb.idToIndex.size}) != count (${cb.count})${ctx}`,
	).toBe(cb.count);
	for (let i = 0; i < cb.count; i++) {
		const id = cb.ids[i];
		expect(
			cb.idToIndex.get(id),
			`idToIndex[${id}] = ${cb.idToIndex.get(id)}, expected ${i}${ctx}`,
		).toBe(i);
	}
	// No stale keys pointing outside valid range
	for (const [id, idx] of cb.idToIndex) {
		expect(idx, `idToIndex[${id}] = ${idx} >= count (${cb.count})${ctx}`).toBeLessThan(cb.count);
		expect(cb.ids[idx], `ids[${idx}] = ${cb.ids[idx]}, expected ${id} (reverse check)${ctx}`).toBe(
			id,
		);
	}
}

/** totalCount must equal the sum of all cell counts. */
function assertTotalCountConsistent(mgr: CellManager, label = "") {
	const ctx = label ? ` (${label})` : "";
	let sum = 0;
	for (const cb of mgr.cells.values()) sum += cb.count;
	expect(
		mgr.totalCount,
		`totalCount (${mgr.totalCount}) != sum of cell counts (${sum})${ctx}`,
	).toBe(sum);
}

/** No location ID appears in more than one cell. */
function assertNoDuplicateIdsAcrossCells(mgr: CellManager, label = "") {
	const ctx = label ? ` (${label})` : "";
	const seen = new Map<number, string>();
	for (const [cellKey, cb] of mgr.cells) {
		for (let i = 0; i < cb.count; i++) {
			const id = cb.ids[i];
			const prev = seen.get(id);
			if (prev != null) {
				throw new Error(`ID ${id} in both cell "${prev}" and cell "${cellKey}"${ctx}`);
			}
			seen.set(id, cellKey);
		}
	}
}

/** Run all three structural invariants at once. */
function assertStructuralIntegrity(mgr: CellManager, label = "") {
	for (const [cellKey, cb] of mgr.cells) {
		assertIdToIndexBijective(cb, `${label} cell=${cellKey}`);
	}
	assertTotalCountConsistent(mgr, label);
	assertNoDuplicateIdsAcrossCells(mgr, label);
}

// ---------------------------------------------------------------------------

function seedLocations(mgr: CellManager, n: number, cell = "s"): void {
	const entries = [];
	for (let i = 1; i <= n; i++) {
		entries.push(entry(cell, i, i * 10, i * 20));
	}
	mgr.applyDelta({ added: entries, updated: [], removed: [], colorPatches: [] });
}

// ===========================================================================
// 1. Active location switch — the buildLayers pattern
// ===========================================================================

describe("Active location switch invariants", () => {
	let mgr: CellManager;

	beforeEach(() => {
		mgr = new CellManager();
		seedLocations(mgr, 5);
	});

	it("activating a location hides it in the main layer", () => {
		simulateActiveSwitch(mgr, null, 1, new Set());
		expect(isHidden(mgr, 1)).toBe(true);
	});

	it("deactivating a location restores default color", () => {
		simulateActiveSwitch(mgr, null, 1, new Set());
		simulateActiveSwitch(mgr, 1, null, new Set());
		expect(isVisible(mgr, 1)).toBe(true);
		expect(getColor(mgr, 1)).toEqual([DEFAULT_R, DEFAULT_G, DEFAULT_B, DEFAULT_A]);
	});

	it("switching active restores the previous and hides the new", () => {
		simulateActiveSwitch(mgr, null, 1, new Set());
		simulateActiveSwitch(mgr, 1, 2, new Set());
		expect(isVisible(mgr, 1)).toBe(true);
		expect(isHidden(mgr, 2)).toBe(true);
	});

	it("rapid switching through N locations leaves only the last hidden", () => {
		let prev: number | null = null;
		for (let id = 1; id <= 5; id++) {
			simulateActiveSwitch(mgr, prev, id, new Set());
			prev = id;
		}
		for (let id = 1; id <= 4; id++) {
			expect(isVisible(mgr, id)).toBe(true);
		}
		expect(isHidden(mgr, 5)).toBe(true);
	});

	it("activating the same location twice is idempotent", () => {
		simulateActiveSwitch(mgr, null, 3, new Set());
		simulateActiveSwitch(mgr, 3, 3, new Set());
		expect(isHidden(mgr, 3)).toBe(true);
		// All others still visible
		for (const id of [1, 2, 4, 5]) expect(isVisible(mgr, id)).toBe(true);
	});

	it("activating a nonexistent ID does not corrupt other entries", () => {
		simulateActiveSwitch(mgr, null, 999, new Set());
		for (let id = 1; id <= 5; id++) {
			expect(isVisible(mgr, id)).toBe(true);
		}
	});
});

// ===========================================================================
// 2. Selection + main layer consistency
// ===========================================================================

describe("Selection and main layer consistency", () => {
	let mgr: CellManager;

	beforeEach(() => {
		mgr = new CellManager();
		seedLocations(mgr, 10);
	});

	it("selecting all: every entry hidden in main, every entry in overlay", () => {
		selectAll(mgr);
		for (let id = 1; id <= 10; id++) {
			expect(isHidden(mgr, id)).toBe(true);
		}
		expect(mgr.selOverlayCount).toBe(10);
		assertNoDoubleMarkers(mgr);
	});

	it("selecting subset: selected hidden, unselected visible", () => {
		const sel = new Set([2, 5, 8]);
		selectIds(mgr, sel);
		for (let id = 1; id <= 10; id++) {
			if (sel.has(id)) {
				expect(isHidden(mgr, id)).toBe(true);
			} else {
				expect(isVisible(mgr, id)).toBe(true);
			}
		}
		expect(mgr.selOverlayCount).toBe(3);
		assertNoDoubleMarkers(mgr);
		assertNoVanishedMarkers(mgr);
	});

	it("clearing selection restores all entries", () => {
		selectAll(mgr);
		clearSelection(mgr);
		assertAllVisible(mgr);
		assertOverlayEmpty(mgr);
	});

	it("clearing selection restores default color, not stale selection color", () => {
		selectAll(mgr, [255, 0, 0]);
		clearSelection(mgr);
		for (let id = 1; id <= 10; id++) {
			expect(getColor(mgr, id)).toEqual([DEFAULT_R, DEFAULT_G, DEFAULT_B, DEFAULT_A]);
		}
	});

	it("re-selecting with different color replaces old overlay", () => {
		selectAll(mgr, [255, 0, 0]);
		selectAll(mgr, [0, 0, 255]);
		for (let i = 0; i < mgr.selOverlayCount; i++) {
			expect(mgr.selOverlayColors[i * 4]).toBe(0);
			expect(mgr.selOverlayColors[i * 4 + 2]).toBe(255);
		}
		assertNoDoubleMarkers(mgr);
	});

	it("overlay positions match main layer positions", () => {
		selectAll(mgr);
		assertOverlayPositionsMatch(mgr);
	});

	it("overlay angles match main layer angles", () => {
		mgr = new CellManager();
		mgr.applyDelta({
			added: [entry("s", 1, 10, 20, 45), entry("s", 2, 30, 40, 135), entry("s", 3, 50, 60, 270)],
			updated: [],
			removed: [],
			colorPatches: [],
		});
		selectAll(mgr);
		for (let i = 0; i < mgr.selOverlayCount; i++) {
			const id = mgr.selOverlayIds[i];
			const cb = mgr.cells.get("s")!;
			const idx = cb.idToIndex.get(id)!;
			expect(mgr.selOverlayAngles[i]).toBeCloseTo(cb.angles[idx]);
		}
	});

	it("overlay colors all have full alpha", () => {
		selectAll(mgr, [100, 200, 50]);
		for (let i = 0; i < mgr.selOverlayCount; i++) {
			expect(mgr.selOverlayColors[i * 4 + 3]).toBe(255);
		}
	});
});

// ===========================================================================
// 3. Active + selection interaction
// ===========================================================================

describe("Active location + selection interaction", () => {
	let mgr: CellManager;

	beforeEach(() => {
		mgr = new CellManager();
		seedLocations(mgr, 5);
	});

	it("selected location made active: stays hidden in main (no restore flash)", () => {
		const selectedIds = selectIds(mgr, new Set([3]));
		simulateActiveSwitch(mgr, null, 3, selectedIds);
		expect(isHidden(mgr, 3)).toBe(true);
		assertNoDoubleMarkers(mgr);
	});

	it("active location that gets selected: doesn't get restored to default", () => {
		simulateActiveSwitch(mgr, null, 2, new Set());
		expect(isHidden(mgr, 2)).toBe(true);

		const selectedIds = selectIds(mgr, new Set([2, 4]));
		// applySelectionBitmasks resets colors for all entries in the cell,
		// so id=2 is hidden from selection, not just from active
		expect(isHidden(mgr, 2)).toBe(true);
		expect(isHidden(mgr, 4)).toBe(true);

		// Now switch active away — the old active is still selected, so no restore
		simulateActiveSwitch(mgr, 2, 5, selectedIds);
		expect(isHidden(mgr, 2)).toBe(true); // still hidden (selected)
		expect(isHidden(mgr, 5)).toBe(true); // hidden (now active)
	});

	it("clearing selection while location is active keeps it hidden", () => {
		const selectedIds = selectIds(mgr, new Set([3]));
		simulateActiveSwitch(mgr, null, 3, selectedIds);

		clearSelection(mgr);
		// Active takes precedence — re-hide after clear restored it
		simulateActiveSwitch(mgr, 3, 3, new Set());
		expect(isHidden(mgr, 3)).toBe(true);
		assertOverlayEmpty(mgr);
	});

	it("deactivating an unselected location after selection clear restores it fully", () => {
		selectIds(mgr, new Set([3]));
		simulateActiveSwitch(mgr, null, 3, new Set([3]));
		clearSelection(mgr);
		simulateActiveSwitch(mgr, 3, null, new Set());
		expect(isVisible(mgr, 3)).toBe(true);
		expect(getColor(mgr, 3)).toEqual([DEFAULT_R, DEFAULT_G, DEFAULT_B, DEFAULT_A]);
	});
});

// ===========================================================================
// 4. Mutations during active selections
// ===========================================================================

describe("Deltas during active selections", () => {
	let mgr: CellManager;

	beforeEach(() => {
		mgr = new CellManager();
		seedLocations(mgr, 5);
	});

	it("adding entries during selection: new entries not in overlay", () => {
		selectIds(mgr, new Set([1, 2]));

		mgr.applyDelta({
			added: [entry("s", 6, 60, 70)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// New entry should be visible in main (selection bitmask hasn't been reapplied)
		expect(isVisible(mgr, 6)).toBe(true);
		// Old selected entries are still hidden
		expect(isHidden(mgr, 1)).toBe(true);
		expect(isHidden(mgr, 2)).toBe(true);
	});

	it("removing selected entry: overlay becomes stale, re-select fixes it", () => {
		selectIds(mgr, new Set([1, 2, 3]));
		expect(mgr.selOverlayCount).toBe(3);

		// Remove id=2 via swap-remove
		const cb = mgr.cells.get("s")!;
		const idx = cb.idToIndex.get(2)!;
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [{ cell: "s", cellIndex: idx, id: 2 }],
			colorPatches: [],
		});

		// Re-apply selection without id=2
		selectIds(mgr, new Set([1, 3]));
		expect(mgr.selOverlayCount).toBe(2);
		const overlayIds = new Set(mgr.selOverlayIds.slice(0, mgr.selOverlayCount));
		expect(overlayIds.has(2)).toBe(false);
		assertNoDoubleMarkers(mgr);
		assertNoVanishedMarkers(mgr);
	});

	it("position patch propagates to overlay on re-select", () => {
		selectAll(mgr);
		assertOverlayPositionsMatch(mgr);

		// Move id=3
		const cb = mgr.cells.get("s")!;
		const idx = cb.idToIndex.get(3)!;
		mgr.applyDelta({
			added: [],
			updated: [{ cell: "s", cellIndex: idx, lng: 999, lat: 888 }],
			removed: [],
			colorPatches: [],
		});

		// Re-select to rebuild overlay
		selectAll(mgr);
		assertOverlayPositionsMatch(mgr);
		const oi = mgr.selOverlayIds.indexOf(3);
		expect(mgr.selOverlayPositions[oi * 2]).toBeCloseTo(999);
		expect(mgr.selOverlayPositions[oi * 2 + 1]).toBeCloseTo(888);
	});

	it("color patch on non-selected entry doesn't affect selection overlay", () => {
		selectIds(mgr, new Set([1, 2]));
		const vBefore = mgr.selOverlayVersion;

		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [],
			colorPatches: [
				{
					cell: "s",
					cellIndex: mgr.cells.get("s")!.idToIndex.get(4)!,
					r: 200,
					g: 100,
					b: 50,
					a: 255,
				},
			],
		});

		// Overlay should not have changed
		expect(mgr.selOverlayVersion).toBe(vBefore);
		expect(mgr.selOverlayCount).toBe(2);
	});
});

// ===========================================================================
// 5. Tag color changes — the render pipeline's responsibility
// ===========================================================================

describe("Tag color propagation via colorPatches", () => {
	let mgr: CellManager;

	beforeEach(() => {
		mgr = new CellManager();
		// Simulate 3 entries with a "red tag" color
		mgr.applyDelta({
			added: [
				coloredEntry("s", 1, 200, 50, 50),
				coloredEntry("s", 2, 200, 50, 50),
				coloredEntry("s", 3, DEFAULT_R, DEFAULT_G, DEFAULT_B), // untagged
			],
			updated: [],
			removed: [],
			colorPatches: [],
		});
	});

	it("color patch updates specific entries without affecting others", () => {
		// "Change tag from red to green"
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [],
			colorPatches: [
				{ cell: "s", cellIndex: 0, r: 50, g: 200, b: 50, a: 255 },
				{ cell: "s", cellIndex: 1, r: 50, g: 200, b: 50, a: 255 },
			],
		});

		expect(getColor(mgr, 1)).toEqual([50, 200, 50, 255]);
		expect(getColor(mgr, 2)).toEqual([50, 200, 50, 255]);
		expect(getColor(mgr, 3)).toEqual([DEFAULT_R, DEFAULT_G, DEFAULT_B, DEFAULT_A]);
	});

	it("color patch after swap-remove targets correct entry", () => {
		const cb = mgr.cells.get("s")!;
		// Remove id=1 (index 0) — id=3 swaps to index 0
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [{ cell: "s", cellIndex: 0, id: 1 }],
			colorPatches: [],
		});

		// Now patch index 0 (which is id=3 after swap)
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [],
			colorPatches: [{ cell: "s", cellIndex: 0, r: 0, g: 255, b: 0, a: 255 }],
		});

		expect(getColor(mgr, 3)).toEqual([0, 255, 0, 255]);
		expect(cb.ids[0]).toBe(3);
	});
});

// ===========================================================================
// 6. No vanished or double markers after complex operation sequences
// ===========================================================================

describe("No ghost or double markers after complex sequences", () => {
	let mgr: CellManager;

	beforeEach(() => {
		mgr = new CellManager();
		seedLocations(mgr, 10);
	});

	it("select → remove selected → clear: all remaining visible", () => {
		selectIds(mgr, new Set([3, 7]));
		// Remove one selected entry
		const idx3 = mgr.cells.get("s")!.idToIndex.get(3)!;
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [{ cell: "s", cellIndex: idx3, id: 3 }],
			colorPatches: [],
		});
		clearSelection(mgr);
		assertAllVisible(mgr);
		assertOverlayEmpty(mgr);
	});

	it("select → add → re-select including new → clear: no ghosts", () => {
		selectIds(mgr, new Set([1, 2]));
		mgr.applyDelta({
			added: [entry("s", 11, 110, 220)],
			updated: [],
			removed: [],
			colorPatches: [],
		});
		selectIds(mgr, new Set([1, 2, 11]));
		assertNoDoubleMarkers(mgr);
		assertNoVanishedMarkers(mgr);

		clearSelection(mgr);
		assertAllVisible(mgr);
		assertOverlayEmpty(mgr);
	});

	it("repeated select/clear cycles leave no residual hidden entries", () => {
		for (let round = 0; round < 5; round++) {
			const ids = new Set([1 + round, 5 + round]);
			selectIds(mgr, ids);
			assertNoDoubleMarkers(mgr);
			clearSelection(mgr);
		}
		assertAllVisible(mgr);
		assertOverlayEmpty(mgr);
	});

	it("undo-redo cycle with interleaved selection: invariants hold", () => {
		// Add 3 locations
		mgr.applyDelta({
			added: [entry("s", 20, 200, 200), entry("s", 21, 210, 210), entry("s", 22, 220, 220)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// Select some
		selectIds(mgr, new Set([20, 21]));
		assertNoDoubleMarkers(mgr);

		// "Delete" id=20
		const idx20 = mgr.cells.get("s")!.idToIndex.get(20)!;
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [{ cell: "s", cellIndex: idx20, id: 20 }],
			colorPatches: [],
		});

		// Re-select without 20
		selectIds(mgr, new Set([21]));
		assertNoDoubleMarkers(mgr);
		assertNoVanishedMarkers(mgr);

		// "Undo" — re-add 20
		mgr.applyDelta({
			added: [entry("s", 20, 200, 200)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		// Re-select including 20
		selectIds(mgr, new Set([20, 21]));
		assertNoDoubleMarkers(mgr);
		assertNoVanishedMarkers(mgr);
		expect(mgr.selOverlayCount).toBe(2);
	});

	it("removing all entries clears overlay naturally", () => {
		selectAll(mgr);
		// Remove all, one by one (reverse order to avoid index shifting issues)
		for (let id = 10; id >= 1; id--) {
			const cb = mgr.cells.get("s")!;
			const idx = cb.idToIndex.get(id)!;
			mgr.applyDelta({
				added: [],
				updated: [],
				removed: [{ cell: "s", cellIndex: idx, id }],
				colorPatches: [],
			});
		}
		expect(mgr.totalCount).toBe(0);
		// Overlay is stale (not auto-cleared), but if we re-select on empty, it clears
		clearSelection(mgr);
		assertOverlayEmpty(mgr);
	});
});

// ===========================================================================
// 7. Multi-cell consistency
// ===========================================================================

describe("Multi-cell render consistency", () => {
	let mgr: CellManager;

	beforeEach(() => {
		mgr = new CellManager();
		mgr.applyDelta({
			added: [
				entry("s", 1, 10, 20),
				entry("s", 2, 30, 40),
				entry("t", 3, 50, 60),
				entry("t", 4, 70, 80),
				entry("u", 5, 90, 100),
			],
			updated: [],
			removed: [],
			colorPatches: [],
		});
	});

	it("selecting across cells: each cell's entries handled independently", () => {
		selectIds(mgr, new Set([2, 3, 5])); // one from each cell
		expect(isHidden(mgr, 2)).toBe(true);
		expect(isHidden(mgr, 3)).toBe(true);
		expect(isHidden(mgr, 5)).toBe(true);
		expect(isVisible(mgr, 1)).toBe(true);
		expect(isVisible(mgr, 4)).toBe(true);
		assertNoDoubleMarkers(mgr);
		assertNoVanishedMarkers(mgr);
	});

	it("clearing multi-cell selection restores all", () => {
		selectAll(mgr);
		clearSelection(mgr);
		assertAllVisible(mgr);
		assertOverlayEmpty(mgr);
	});

	it("removing from one cell doesn't affect overlay entries from another", () => {
		selectIds(mgr, new Set([1, 3])); // s:1 and t:3

		// Remove from cell "s"
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [{ cell: "s", cellIndex: mgr.cells.get("s")!.idToIndex.get(1)!, id: 1 }],
			colorPatches: [],
		});

		// id=3 in cell "t" should still be hidden from the stale overlay
		expect(isHidden(mgr, 3)).toBe(true);
	});
});

// ===========================================================================
// 8. Multiple overlapping selections — z-order and color correctness
// ===========================================================================

describe("Multiple overlapping selections", () => {
	let mgr: CellManager;

	beforeEach(() => {
		mgr = new CellManager();
		seedLocations(mgr, 5);
	});

	it("overlapping selections: last selection's color is on top", () => {
		const cb = mgr.cells.get("s")!;
		// Red selects [1,2,3], Blue selects [3,4,5] — overlap at 3
		const n = cb.count;
		const byteLen = Math.ceil(n / 8);
		const maskR = new Uint8Array(byteLen);
		const maskB = new Uint8Array(byteLen);
		for (let i = 0; i < n; i++) {
			const id = cb.ids[i];
			if ([1, 2, 3].includes(id)) maskR[i >> 3] |= 1 << (i & 7);
			if ([3, 4, 5].includes(id)) maskB[i >> 3] |= 1 << (i & 7);
		}
		mgr.applySelectionBitmasks(
			[
				[255, 0, 0],
				[0, 0, 255],
			],
			[
				{
					cellChar: "s",
					locCount: n,
					sels: [
						{ kind: "mask" as const, mask: maskR },
						{ kind: "mask" as const, mask: maskB },
					],
				},
			],
		);

		// ID=3 appears twice in overlay — last (blue) is drawn on top
		const indices3 = [];
		for (let i = 0; i < mgr.selOverlayCount; i++) {
			if (mgr.selOverlayIds[i] === 3) indices3.push(i);
		}
		expect(indices3.length).toBe(2);
		const lastIdx = indices3[indices3.length - 1];
		expect(mgr.selOverlayColors[lastIdx * 4]).toBe(0);
		expect(mgr.selOverlayColors[lastIdx * 4 + 2]).toBe(255);
	});

	it("all entries in all selections have alpha=0 in main (even overlapping)", () => {
		const cb = mgr.cells.get("s")!;
		const n = cb.count;
		const byteLen = Math.ceil(n / 8);
		const mask1 = new Uint8Array(byteLen);
		const mask2 = new Uint8Array(byteLen);
		// Both selections select everything
		for (let i = 0; i < n; i++) {
			mask1[i >> 3] |= 1 << (i & 7);
			mask2[i >> 3] |= 1 << (i & 7);
		}
		mgr.applySelectionBitmasks(
			[
				[255, 0, 0],
				[0, 255, 0],
			],
			[
				{
					cellChar: "s",
					locCount: n,
					sels: [
						{ kind: "mask" as const, mask: mask1 },
						{ kind: "mask" as const, mask: mask2 },
					],
				},
			],
		);
		for (let i = 0; i < cb.count; i++) {
			expect(cb.colors[i * 4 + 3]).toBe(0);
		}
	});
});

// ===========================================================================
// 9. Version tracking — deck.gl depends on these to know when to re-render
// ===========================================================================

describe("Version tracking for deck.gl update triggers", () => {
	let mgr: CellManager;

	beforeEach(() => {
		mgr = new CellManager();
		seedLocations(mgr, 3);
	});

	it("selOverlayVersion increments on each bitmask application", () => {
		const v0 = mgr.selOverlayVersion;
		selectAll(mgr);
		expect(mgr.selOverlayVersion).toBeGreaterThan(v0);
		const v1 = mgr.selOverlayVersion;
		clearSelection(mgr);
		expect(mgr.selOverlayVersion).toBeGreaterThan(v1);
	});

	it("colorVersion increments on color patch", () => {
		const cb = mgr.cells.get("s")!;
		const v0 = cb.colorVersion;
		cb.patchColor(0, 255, 0, 0, 255);
		expect(cb.colorVersion).toBeGreaterThan(v0);
	});

	it("colorVersion increments on selection apply (colors change)", () => {
		const cb = mgr.cells.get("s")!;
		const v0 = cb.colorVersion;
		selectAll(mgr);
		expect(cb.colorVersion).toBeGreaterThan(v0);
	});

	it("global version increments on selection apply", () => {
		const v0 = mgr.version;
		selectAll(mgr);
		expect(mgr.version).toBeGreaterThan(v0);
	});
});

// ===========================================================================
// 10. buildSelectionOverlay (explicit color patches path)
// ===========================================================================

describe("buildSelectionOverlay (explicit patches)", () => {
	let mgr: CellManager;

	beforeEach(() => {
		mgr = new CellManager();
		seedLocations(mgr, 5);
	});

	it("builds overlay with correct positions and colors", () => {
		const cb = mgr.cells.get("s")!;
		mgr.buildSelectionOverlay([
			{ cell: "s", cellIndex: 0, r: 255, g: 0, b: 0, a: 255 },
			{ cell: "s", cellIndex: 2, r: 0, g: 255, b: 0, a: 255 },
		]);
		expect(mgr.selOverlayCount).toBe(2);
		expect(mgr.selOverlayIds[0]).toBe(cb.ids[0]);
		expect(mgr.selOverlayIds[1]).toBe(cb.ids[2]);
		expect(mgr.selOverlayColors[0]).toBe(255); // red
		expect(mgr.selOverlayColors[4]).toBe(0); // green channel of second entry
		expect(mgr.selOverlayColors[5]).toBe(255);
	});

	it("empty patches produce empty overlay", () => {
		mgr.buildSelectionOverlay([]);
		assertOverlayEmpty(mgr);
	});

	it("out-of-bounds cellIndex is skipped safely", () => {
		mgr.buildSelectionOverlay([{ cell: "s", cellIndex: 999, r: 255, g: 0, b: 0, a: 255 }]);
		// The entry is "allocated" (count=1) but has zeroed data since the copy was skipped
		expect(mgr.selOverlayCount).toBe(1);
	});

	it("appendToSelectionOverlay adds without replacing", () => {
		mgr.buildSelectionOverlay([{ cell: "s", cellIndex: 0, r: 255, g: 0, b: 0, a: 255 }]);
		mgr.appendToSelectionOverlay([{ cell: "s", cellIndex: 1, r: 0, g: 0, b: 255, a: 255 }]);
		expect(mgr.selOverlayCount).toBe(2);
		// First entry still red
		expect(mgr.selOverlayColors[0]).toBe(255);
		expect(mgr.selOverlayColors[2]).toBe(0);
		// Second entry blue
		expect(mgr.selOverlayColors[4]).toBe(0);
		expect(mgr.selOverlayColors[6]).toBe(255);
	});
});

// ===========================================================================
// 11. initFromBinary + selection overlay round-trip
// ===========================================================================

describe("initFromBinary clears selection state", () => {
	it("replaces existing overlay on re-init", () => {
		const mgr = new CellManager();
		seedLocations(mgr, 5);
		selectAll(mgr);
		expect(mgr.selOverlayCount).toBe(5);

		// Re-init from a minimal binary (1 cell, 2 entries, 0 selection)
		const buf = buildMinimalBinary("s", [
			{ id: 100, lng: 1, lat: 2, heading: 0, r: 42, g: 42, b: 42, a: 255 },
			{ id: 101, lng: 3, lat: 4, heading: 0, r: 42, g: 42, b: 42, a: 255 },
		]);
		mgr.initFromBinary(buf);

		expect(mgr.totalCount).toBe(2);
		expect(mgr.selOverlayCount).toBe(0);
		assertAllVisible(mgr);
	});
});

// ===========================================================================
// 12. CellBuffer.idToIndex bijectivity
// ===========================================================================

describe("CellBuffer idToIndex bijectivity", () => {
	let buf: CellBuffer;

	beforeEach(() => {
		buf = new CellBuffer();
	});

	it("holds after sequential appends", () => {
		for (let i = 1; i <= 20; i++) {
			buf.append(entry("s", i, i, i));
			assertIdToIndexBijective(buf, `after append ${i}`);
		}
	});

	it("holds after swapRemove from middle", () => {
		for (let i = 1; i <= 5; i++) buf.append(entry("s", i, i, i));
		buf.swapRemove(2); // remove index 2 (middle)
		assertIdToIndexBijective(buf, "after middle remove");
	});

	it("holds after swapRemove of first element", () => {
		for (let i = 1; i <= 5; i++) buf.append(entry("s", i, i, i));
		buf.swapRemove(0);
		assertIdToIndexBijective(buf, "after first remove");
	});

	it("holds after swapRemove of last element", () => {
		for (let i = 1; i <= 5; i++) buf.append(entry("s", i, i, i));
		buf.swapRemove(4);
		assertIdToIndexBijective(buf, "after last remove");
	});

	it("holds after removing all elements one by one", () => {
		for (let i = 1; i <= 5; i++) buf.append(entry("s", i, i, i));
		while (buf.count > 0) {
			buf.swapRemove(0);
			assertIdToIndexBijective(buf, `count=${buf.count}`);
		}
		expect(buf.idToIndex.size).toBe(0);
	});

	it("holds through interleaved add/remove", () => {
		buf.append(entry("s", 10, 1, 1));
		buf.append(entry("s", 20, 2, 2));
		buf.append(entry("s", 30, 3, 3));
		assertIdToIndexBijective(buf, "initial");

		buf.swapRemove(1); // remove id=20
		assertIdToIndexBijective(buf, "after remove 20");

		buf.append(entry("s", 40, 4, 4));
		assertIdToIndexBijective(buf, "after add 40");

		buf.swapRemove(0); // remove whatever is at 0
		assertIdToIndexBijective(buf, "after remove index 0");

		buf.append(entry("s", 50, 5, 5));
		buf.append(entry("s", 60, 6, 6));
		assertIdToIndexBijective(buf, "after add 50,60");
	});

	it("holds after capacity growth", () => {
		for (let i = 0; i < 300; i++) {
			buf.append(entry("s", i, i, i));
		}
		assertIdToIndexBijective(buf, "after 300 appends");
	});

	it("holds after remove-then-re-add of same ID", () => {
		buf.append(entry("s", 1, 10, 20));
		buf.append(entry("s", 2, 30, 40));
		buf.swapRemove(0); // remove id=1
		assertIdToIndexBijective(buf, "after remove");

		buf.append(entry("s", 1, 50, 60)); // re-add id=1
		assertIdToIndexBijective(buf, "after re-add");
		expect(buf.idToIndex.get(1)).toBe(buf.count - 1);
	});
});

// ===========================================================================
// 13. CellManager.totalCount consistency
// ===========================================================================

describe("CellManager totalCount consistency", () => {
	let mgr: CellManager;

	beforeEach(() => {
		mgr = new CellManager();
	});

	it("stays correct through adds across multiple cells", () => {
		mgr.applyDelta({
			added: [entry("s", 1, 1, 1), entry("t", 2, 2, 2), entry("u", 3, 3, 3)],
			updated: [],
			removed: [],
			colorPatches: [],
		});
		assertTotalCountConsistent(mgr, "after add to 3 cells");
	});

	it("stays correct through mixed adds and removes", () => {
		mgr.applyDelta({
			added: [entry("s", 1, 1, 1), entry("s", 2, 2, 2), entry("t", 3, 3, 3)],
			updated: [],
			removed: [],
			colorPatches: [],
		});
		assertTotalCountConsistent(mgr, "after initial add");

		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [{ cell: "s", cellIndex: 0, id: 1 }],
			colorPatches: [],
		});
		assertTotalCountConsistent(mgr, "after remove from s");

		mgr.applyDelta({
			added: [entry("t", 4, 4, 4), entry("u", 5, 5, 5)],
			updated: [],
			removed: [{ cell: "t", cellIndex: 0, id: 3 }],
			colorPatches: [],
		});
		assertTotalCountConsistent(mgr, "after simultaneous add+remove");
	});

	it("stays correct through add-all then remove-all", () => {
		seedLocations(mgr, 50);
		assertTotalCountConsistent(mgr, "after seed");

		const cb = mgr.cells.get("s")!;
		for (let i = cb.count - 1; i >= 0; i--) {
			const id = cb.ids[i];
			mgr.applyDelta({
				added: [],
				updated: [],
				removed: [{ cell: "s", cellIndex: i, id }],
				colorPatches: [],
			});
		}
		assertTotalCountConsistent(mgr, "after remove all");
		expect(mgr.totalCount).toBe(0);
	});

	it("stays correct after clear", () => {
		seedLocations(mgr, 10);
		mgr.clear();
		assertTotalCountConsistent(mgr, "after clear");
		expect(mgr.totalCount).toBe(0);
	});

	it("stays correct after initFromBinary", () => {
		seedLocations(mgr, 5);
		const buf = buildMinimalBinary("s", [
			{ id: 100, lng: 1, lat: 2, heading: 0, r: 42, g: 42, b: 42, a: 255 },
		]);
		mgr.initFromBinary(buf);
		assertTotalCountConsistent(mgr, "after initFromBinary");
	});
});

// ===========================================================================
// 14. No duplicate IDs across cells
// ===========================================================================

describe("No duplicate IDs across cells", () => {
	let mgr: CellManager;

	beforeEach(() => {
		mgr = new CellManager();
	});

	it("normal multi-cell add has no duplicates", () => {
		mgr.applyDelta({
			added: [
				entry("s", 1, 1, 1),
				entry("t", 2, 2, 2),
				entry("u", 3, 3, 3),
				entry("s", 4, 4, 4),
				entry("t", 5, 5, 5),
			],
			updated: [],
			removed: [],
			colorPatches: [],
		});
		assertNoDuplicateIdsAcrossCells(mgr);
	});

	it("remove from one cell + add to another with different IDs: no duplicates", () => {
		mgr.applyDelta({
			added: [entry("s", 1, 1, 1), entry("t", 2, 2, 2)],
			updated: [],
			removed: [],
			colorPatches: [],
		});

		mgr.applyDelta({
			added: [entry("t", 3, 3, 3)],
			updated: [],
			removed: [{ cell: "s", cellIndex: 0, id: 1 }],
			colorPatches: [],
		});
		assertNoDuplicateIdsAcrossCells(mgr, "after cross-cell mutation");
	});

	it("large multi-cell dataset has no duplicates", () => {
		const cells = ["s", "t", "u", "v"];
		const entries = [];
		for (let i = 0; i < 200; i++) {
			entries.push(entry(cells[i % cells.length], i + 1, i, i));
		}
		mgr.applyDelta({ added: entries, updated: [], removed: [], colorPatches: [] });
		assertNoDuplicateIdsAcrossCells(mgr, "200 entries across 4 cells");
	});

	it("undo-redo sequence maintains no duplicates", () => {
		mgr.applyDelta({
			added: [entry("s", 1, 1, 1), entry("s", 2, 2, 2), entry("t", 3, 3, 3)],
			updated: [],
			removed: [],
			colorPatches: [],
		});
		assertNoDuplicateIdsAcrossCells(mgr, "initial");

		// "Delete" id=1 from cell s
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [{ cell: "s", cellIndex: mgr.cells.get("s")!.idToIndex.get(1)!, id: 1 }],
			colorPatches: [],
		});
		assertNoDuplicateIdsAcrossCells(mgr, "after delete");

		// "Undo" — re-add id=1 back to cell s
		mgr.applyDelta({
			added: [entry("s", 1, 1, 1)],
			updated: [],
			removed: [],
			colorPatches: [],
		});
		assertNoDuplicateIdsAcrossCells(mgr, "after undo");
	});
});

// ===========================================================================
// 15. Structural integrity through full operation sequences
// ===========================================================================

describe("Structural integrity (all three invariants) through operation sequences", () => {
	let mgr: CellManager;

	beforeEach(() => {
		mgr = new CellManager();
	});

	it("holds through a realistic editing session", () => {
		// User opens map — locations load across cells
		mgr.applyDelta({
			added: [
				entry("s", 1, 10, 20),
				entry("s", 2, 30, 40),
				entry("t", 3, 50, 60),
				entry("t", 4, 70, 80),
				entry("u", 5, 90, 100),
			],
			updated: [],
			removed: [],
			colorPatches: [],
		});
		assertStructuralIntegrity(mgr, "after open");

		// User selects some locations
		selectIds(mgr, new Set([1, 3, 5]));
		assertStructuralIntegrity(mgr, "after select");

		// User adds a new location
		mgr.applyDelta({
			added: [entry("s", 6, 110, 120)],
			updated: [],
			removed: [],
			colorPatches: [],
		});
		assertStructuralIntegrity(mgr, "after add during selection");

		// User deletes two locations
		const sIdx2 = mgr.cells.get("s")!.idToIndex.get(2)!;
		const tIdx4 = mgr.cells.get("t")!.idToIndex.get(4)!;
		mgr.applyDelta({
			added: [],
			updated: [],
			removed: [
				{ cell: "s", cellIndex: sIdx2, id: 2 },
				{ cell: "t", cellIndex: tIdx4, id: 4 },
			],
			colorPatches: [],
		});
		assertStructuralIntegrity(mgr, "after delete 2 locations");

		// User clears selection
		clearSelection(mgr);
		assertStructuralIntegrity(mgr, "after clear selection");

		// User updates a location (position patch)
		const uIdx5 = mgr.cells.get("u")!.idToIndex.get(5)!;
		mgr.applyDelta({
			added: [],
			updated: [{ cell: "u", cellIndex: uIdx5, lng: 999, lat: 888, heading: 45 }],
			removed: [],
			colorPatches: [],
		});
		assertStructuralIntegrity(mgr, "after position update");

		// User undoes the delete (re-add)
		mgr.applyDelta({
			added: [entry("s", 2, 30, 40), entry("t", 4, 70, 80)],
			updated: [],
			removed: [],
			colorPatches: [],
		});
		assertStructuralIntegrity(mgr, "after undo delete");

		// User selects everything and clears
		selectAll(mgr);
		assertStructuralIntegrity(mgr, "after select all");
		clearSelection(mgr);
		assertStructuralIntegrity(mgr, "after final clear");
	});

	it("holds through initFromBinary", () => {
		const buf = buildMinimalBinary("s", [
			{ id: 10, lng: 1, lat: 2, heading: 0, r: 42, g: 42, b: 42, a: 255 },
			{ id: 20, lng: 3, lat: 4, heading: 90, r: 42, g: 42, b: 42, a: 255 },
			{ id: 30, lng: 5, lat: 6, heading: 180, r: 42, g: 42, b: 42, a: 255 },
		]);
		mgr.initFromBinary(buf);
		assertStructuralIntegrity(mgr, "after initFromBinary");
	});

	it("holds through multi-cell initFromBinary", () => {
		const buf = buildMultiCellBinary([
			{
				cell: "s",
				entries: [
					{ id: 1, lng: 10, lat: 20, heading: 0, r: 42, g: 42, b: 42, a: 255 },
					{ id: 2, lng: 30, lat: 40, heading: 0, r: 42, g: 42, b: 42, a: 255 },
				],
			},
			{
				cell: "t",
				entries: [{ id: 3, lng: 50, lat: 60, heading: 0, r: 42, g: 42, b: 42, a: 255 }],
			},
		]);
		mgr.initFromBinary(buf);
		assertStructuralIntegrity(mgr, "after multi-cell initFromBinary");
		expect(mgr.totalCount).toBe(3);
		expect(mgr.cells.get("s")!.count).toBe(2);
		expect(mgr.cells.get("t")!.count).toBe(1);
	});

	it("holds after rapid add-remove churn", () => {
		const cells = ["s", "t", "u"];
		let nextId = 1;
		for (let round = 0; round < 10; round++) {
			// Add a batch
			const newEntries = [];
			for (let i = 0; i < 5; i++) {
				newEntries.push(entry(cells[i % 3], nextId++, nextId * 10, nextId * 20));
			}
			mgr.applyDelta({ added: newEntries, updated: [], removed: [], colorPatches: [] });
			assertStructuralIntegrity(mgr, `round ${round} after add`);

			// Remove the first entry from each cell that has one
			const removals = [];
			for (const [cellKey, cb] of mgr.cells) {
				if (cb.count > 0) {
					removals.push({ cell: cellKey, cellIndex: 0, id: cb.ids[0] });
				}
			}
			if (removals.length > 0) {
				mgr.applyDelta({ added: [], updated: [], removed: removals, colorPatches: [] });
				assertStructuralIntegrity(mgr, `round ${round} after remove`);
			}
		}
	});
});

// ===========================================================================
// Helpers — binary builders
// ===========================================================================

// Helper to build a minimal Rust-format binary
function buildMinimalBinary(
	cell: string,
	entries: {
		id: number;
		lng: number;
		lat: number;
		heading: number;
		r: number;
		g: number;
		b: number;
		a: number;
	}[],
): ArrayBuffer {
	const n = entries.length;
	const cellHeaderSize = 5; // u8 char + u32 count
	const size = 4 + cellHeaderSize + n * 4 + n * 2 * 4 + n * 4 + n * 4 + 4; // +4 for sel_count
	const buf = new ArrayBuffer(size);
	const dv = new DataView(buf);
	let off = 0;

	dv.setUint32(off, 1, true);
	off += 4; // 1 cell
	dv.setUint8(off, cell.charCodeAt(0));
	off += 1;
	dv.setUint32(off, n, true);
	off += 4;

	// IDs
	for (const e of entries) {
		dv.setUint32(off, e.id, true);
		off += 4;
	}
	// Positions
	for (const e of entries) {
		dv.setFloat32(off, e.lng, true);
		off += 4;
		dv.setFloat32(off, e.lat, true);
		off += 4;
	}
	// Colors
	for (const e of entries) {
		dv.setUint8(off, e.r);
		off += 1;
		dv.setUint8(off, e.g);
		off += 1;
		dv.setUint8(off, e.b);
		off += 1;
		dv.setUint8(off, e.a);
		off += 1;
	}
	// Angles
	for (const e of entries) {
		dv.setFloat32(off, e.heading, true);
		off += 4;
	}
	// Selection count = 0
	dv.setUint32(off, 0, true);

	return buf;
}

type BinaryEntry = {
	id: number;
	lng: number;
	lat: number;
	heading: number;
	r: number;
	g: number;
	b: number;
	a: number;
};

function buildMultiCellBinary(cells: { cell: string; entries: BinaryEntry[] }[]): ArrayBuffer {
	let size = 4; // u32 cell_count
	for (const c of cells) {
		const n = c.entries.length;
		size += 5 + n * 4 + n * 2 * 4 + n * 4 + n * 4; // header + ids + positions + colors + angles
	}
	size += 4; // sel_count

	const buf = new ArrayBuffer(size);
	const dv = new DataView(buf);
	let off = 0;

	dv.setUint32(off, cells.length, true);
	off += 4;

	for (const c of cells) {
		const n = c.entries.length;
		dv.setUint8(off, c.cell.charCodeAt(0));
		off += 1;
		dv.setUint32(off, n, true);
		off += 4;
		for (const e of c.entries) {
			dv.setUint32(off, e.id, true);
			off += 4;
		}
		for (const e of c.entries) {
			dv.setFloat32(off, e.lng, true);
			off += 4;
			dv.setFloat32(off, e.lat, true);
			off += 4;
		}
		for (const e of c.entries) {
			dv.setUint8(off, e.r);
			off += 1;
			dv.setUint8(off, e.g);
			off += 1;
			dv.setUint8(off, e.b);
			off += 1;
			dv.setUint8(off, e.a);
			off += 1;
		}
		for (const e of c.entries) {
			dv.setFloat32(off, e.heading, true);
			off += 4;
		}
	}

	dv.setUint32(off, 0, true); // sel_count = 0
	return buf;
}
