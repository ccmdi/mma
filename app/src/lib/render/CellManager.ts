import type {
	RenderDelta_Serialize,
	RenderEntry,
	CellRemoval as _CellRemoval,
	ColorPatchEntry,
} from "@/bindings.gen";

export type RenderDelta = RenderDelta_Serialize;

const MIN_CAPACITY = 256;

/**
 * Typed-array backed buffer for one geohash cell's marker data.
 * Grows by doubling. Removals use swap-remove (O(1), order not preserved).
 * Versioned per-attribute so deck.gl can skip unchanged layers.
 */
export class CellBuffer {
	ids: number[] = [];
	idToIndex = new Map<number, number>();
	positions: Float32Array;
	colors: Uint8Array;
	angles: Float32Array;
	count = 0;
	capacity: number;
	positionVersion = 0;
	colorVersion = 0;

	constructor(capacity = MIN_CAPACITY) {
		this.capacity = capacity;
		this.positions = new Float32Array(capacity * 2);
		this.colors = new Uint8Array(capacity * 4);
		this.angles = new Float32Array(capacity);
	}

	/** Append a marker, growing the buffer if needed. */
	append(entry: RenderEntry) {
		this.ensureCapacity(this.count + 1);
		const i = this.count;
		this.positions[i * 2] = entry.lng;
		this.positions[i * 2 + 1] = entry.lat;
		this.colors[i * 4] = entry.r;
		this.colors[i * 4 + 1] = entry.g;
		this.colors[i * 4 + 2] = entry.b;
		this.colors[i * 4 + 3] = entry.a;
		this.angles[i] = entry.heading;
		this.ids[i] = entry.id;
		this.idToIndex.set(entry.id, i);
		this.count++;
		this.positionVersion++;
		this.colorVersion++;
	}

	/** O(1) removal by swapping with the last element. Mirrors Rust's cell_remove_render. */
	swapRemove(index: number) {
		const last = this.count - 1;
		if (last < 0) return;
		const removedId = this.ids[index];

		if (index !== last) {
			this.positions[index * 2] = this.positions[last * 2];
			this.positions[index * 2 + 1] = this.positions[last * 2 + 1];
			this.colors[index * 4] = this.colors[last * 4];
			this.colors[index * 4 + 1] = this.colors[last * 4 + 1];
			this.colors[index * 4 + 2] = this.colors[last * 4 + 2];
			this.colors[index * 4 + 3] = this.colors[last * 4 + 3];
			this.angles[index] = this.angles[last];

			const movedId = this.ids[last];
			this.ids[index] = movedId;
			this.idToIndex.set(movedId, index);
		}

		this.idToIndex.delete(removedId);
		this.count--;
		this.positionVersion++;
		this.colorVersion++;
	}

	patchPosition(index: number, lng?: number, lat?: number, heading?: number) {
		if (index < 0 || index >= this.count) return;
		if (lng != null) this.positions[index * 2] = lng;
		if (lat != null) this.positions[index * 2 + 1] = lat;
		if (heading != null) this.angles[index] = heading;
		this.positionVersion++;
	}

	patchColor(index: number, r: number, g: number, b: number, a: number) {
		if (index < 0 || index >= this.count) return;
		this.colors[index * 4] = r;
		this.colors[index * 4 + 1] = g;
		this.colors[index * 4 + 2] = b;
		this.colors[index * 4 + 3] = a;
		this.colorVersion++;
	}

	private ensureCapacity(needed: number) {
		if (needed <= this.capacity) return;
		const newCap = Math.max(needed, this.capacity * 2, MIN_CAPACITY);
		const newPos = new Float32Array(newCap * 2);
		const newCol = new Uint8Array(newCap * 4);
		const newAng = new Float32Array(newCap);
		newPos.set(this.positions.subarray(0, this.count * 2));
		newCol.set(this.colors.subarray(0, this.count * 4));
		newAng.set(this.angles.subarray(0, this.count));
		this.positions = newPos;
		this.colors = newCol;
		this.angles = newAng;
		this.capacity = newCap;
	}
}

/**
 * Owns all marker render data as 32 geohash-cell CellBuffers plus a selection overlay.
 * Initialized from a binary blob built by Rust (`initFromBinary`), then kept in sync
 * via incremental deltas (`applyDelta`) and selection bitmasks (`applySelectionBitmasks`).
 * deck.gl layers read the typed arrays directly — no JSON serialization in the render loop.
 */
export class CellManager {
	cells = new Map<string, CellBuffer>();
	totalCount = 0;
	version = 0;

	/** Parse the full render binary from Rust. Replaces all cells and the selection overlay. */
	initFromBinary(buf: ArrayBuffer) {
		this.cells.clear();
		this.totalCount = 0;
		this.selOverlayCount = 0;
		this.selOverlayIds = [];
		this.selOverlayVersion++;

		const dv = new DataView(buf);
		if (buf.byteLength < 4) return;
		const cellCount = dv.getUint32(0, true);
		let offset = 4;

		for (let c = 0; c < cellCount; c++) {
			const gh0 = dv.getUint8(offset);
			const cellKey = String.fromCharCode(gh0);
			const count = dv.getUint32(offset + 1, true);
			offset += 5;

			const cb = new CellBuffer(count);
			cb.count = count;

			const idBytes = count * 4;
			const posBytes = count * 2 * 4;
			const colBytes = count * 4;
			const angBytes = count * 4;

			const idBuf = new Uint32Array(buf.slice(offset, offset + idBytes));
			offset += idBytes;
			cb.ids = Array.from(idBuf);
			cb.idToIndex.clear();
			for (let i = 0; i < count; i++) cb.idToIndex.set(cb.ids[i], i);

			cb.positions = new Float32Array(buf.slice(offset, offset + posBytes));
			offset += posBytes;
			cb.colors = new Uint8Array(buf.slice(offset, offset + colBytes));
			offset += colBytes;
			cb.angles = new Float32Array(buf.slice(offset, offset + angBytes));
			offset += angBytes;

			cb.capacity = count;

			this.cells.set(cellKey, cb);
			this.totalCount += count;
		}

		// Selection overlay: [u32 count][f32[] positions][u8[] colors][f32[] angles][u32[] ids]
		if (offset + 4 <= buf.byteLength) {
			const selCount = dv.getUint32(offset, true);
			offset += 4;
			if (selCount > 0) {
				const selPosBytes = selCount * 2 * 4;
				const selColBytes = selCount * 4;
				const selAngBytes = selCount * 4;
				const selIdBytes = selCount * 4;
				this.selOverlayPositions = new Float32Array(buf.slice(offset, offset + selPosBytes));
				offset += selPosBytes;
				this.selOverlayColors = new Uint8Array(buf.slice(offset, offset + selColBytes));
				offset += selColBytes;
				this.selOverlayAngles = new Float32Array(buf.slice(offset, offset + selAngBytes));
				offset += selAngBytes;
				const selIds = new Uint32Array(buf.slice(offset, offset + selIdBytes));
				this.selOverlayIds = Array.from(selIds);
				this.selOverlayCount = selCount;
			}
		}

		this.version++;
	}

	/** Apply an incremental delta (adds, swap-removes, position patches, color patches). Returns affected cell keys. */
	applyDelta(delta: RenderDelta): Set<string> {
		const affected = new Set<string>();

		for (const rem of delta.removed) {
			const cb = this.cells.get(rem.cell);
			if (cb) {
				cb.swapRemove(rem.cellIndex);
				this.totalCount--;
				affected.add(rem.cell);
			}
		}

		for (const entry of delta.added) {
			let cb = this.cells.get(entry.cell);
			if (!cb) {
				cb = new CellBuffer();
				this.cells.set(entry.cell, cb);
			}
			cb.append(entry);
			this.totalCount++;
			affected.add(entry.cell);
		}

		for (const patch of delta.updated) {
			const cb = this.cells.get(patch.cell);
			if (cb) {
				cb.patchPosition(
					patch.cellIndex,
					patch.lng ?? undefined,
					patch.lat ?? undefined,
					patch.heading ?? undefined,
				);
				affected.add(patch.cell);
			}
		}

		for (const cp of delta.colorPatches) {
			const cb = this.cells.get(cp.cell);
			if (cb) {
				cb.patchColor(cp.cellIndex, cp.r, cp.g, cp.b, cp.a);
				affected.add(cp.cell);
			}
		}

		this.version++;
		return affected;
	}

	/** Map a deck.gl pick (cell + index) back to a location ID. */
	resolvePickFromCell(cellKey: string, cellIndex: number): number | null {
		const cb = this.cells.get(cellKey);
		if (!cb || cellIndex < 0 || cellIndex >= cb.count) return null;
		return cb.ids[cellIndex] ?? null;
	}

	selOverlayPositions = new Float32Array(0);
	selOverlayColors = new Uint8Array(0);
	selOverlayAngles = new Float32Array(0);
	selOverlayIds: number[] = [];
	selOverlayCount = 0;
	selOverlayVersion = 0;

	/** Build a selection overlay from explicit color patches (used by non-bitmask code paths). */
	buildSelectionOverlay(colorPatches: ColorPatchEntry[], _angles?: boolean) {
		this.selOverlayCount = colorPatches.length;
		if (colorPatches.length === 0) {
			this.selOverlayIds = [];
			this.selOverlayVersion++;
			return;
		}
		const n = colorPatches.length;
		this.selOverlayPositions = new Float32Array(n * 2);
		this.selOverlayColors = new Uint8Array(n * 4);
		this.selOverlayAngles = new Float32Array(n);
		this.selOverlayIds = new Array(n);
		for (let i = 0; i < n; i++) {
			const cp = colorPatches[i];
			const cb = this.cells.get(cp.cell);
			if (!cb || cp.cellIndex >= cb.count) continue;
			this.selOverlayPositions[i * 2] = cb.positions[cp.cellIndex * 2];
			this.selOverlayPositions[i * 2 + 1] = cb.positions[cp.cellIndex * 2 + 1];
			this.selOverlayColors[i * 4] = cp.r;
			this.selOverlayColors[i * 4 + 1] = cp.g;
			this.selOverlayColors[i * 4 + 2] = cp.b;
			this.selOverlayColors[i * 4 + 3] = cp.a;
			this.selOverlayAngles[i] = cb.angles[cp.cellIndex];
			this.selOverlayIds[i] = cb.ids[cp.cellIndex];
		}
		this.selOverlayVersion++;
	}

	/** Append color patches to the existing selection overlay without replacing it. */
	appendToSelectionOverlay(colorPatches: ColorPatchEntry[]) {
		if (colorPatches.length === 0) return;
		const oldCount = this.selOverlayCount;
		const newCount = oldCount + colorPatches.length;
		const pos = new Float32Array(newCount * 2);
		const col = new Uint8Array(newCount * 4);
		const ang = new Float32Array(newCount);
		const ids: number[] = new Array(newCount);
		pos.set(this.selOverlayPositions.subarray(0, oldCount * 2));
		col.set(this.selOverlayColors.subarray(0, oldCount * 4));
		ang.set(this.selOverlayAngles.subarray(0, oldCount));
		for (let i = 0; i < oldCount; i++) ids[i] = this.selOverlayIds[i];

		for (let i = 0; i < colorPatches.length; i++) {
			const cp = colorPatches[i];
			const cb = this.cells.get(cp.cell);
			if (!cb || cp.cellIndex >= cb.count) continue;
			const oi = oldCount + i;
			pos[oi * 2] = cb.positions[cp.cellIndex * 2];
			pos[oi * 2 + 1] = cb.positions[cp.cellIndex * 2 + 1];
			col[oi * 4] = cp.r;
			col[oi * 4 + 1] = cp.g;
			col[oi * 4 + 2] = cp.b;
			col[oi * 4 + 3] = cp.a;
			ang[oi] = cb.angles[cp.cellIndex];
			ids[oi] = cb.ids[cp.cellIndex];
		}
		this.selOverlayPositions = pos;
		this.selOverlayColors = col;
		this.selOverlayAngles = ang;
		this.selOverlayIds = ids;
		this.selOverlayCount = newCount;
		this.selOverlayVersion++;
	}

	/**
	 * Decode per-cell bitmasks from Rust into a colored selection overlay.
	 * Selected locations are hidden in their main cell (alpha=0) and drawn in the overlay with
	 * the selection's color. Later selections overdraw earlier ones. Returns the set of selected IDs.
	 */
	applySelectionBitmasks(
		selColors: [number, number, number][],
		cellEntries: { cellChar: string; locCount: number; masks: Uint8Array[] }[],
	): Set<number> {
		const numSels = selColors.length;
		let totalEntries = 0;
		const selectedIds = new Set<number>();

		// Count total overlay entries — one per (location, selection) membership
		for (const entry of cellEntries) {
			const cb = this.cells.get(entry.cellChar);
			const n = cb ? Math.min(entry.locCount, cb.count) : 0;
			for (let li = 0; li < n; li++) {
				const byteIdx = li >> 3;
				const bitIdx = li & 7;
				for (let si = 0; si < numSels; si++) {
					if (entry.masks[si][byteIdx] & (1 << bitIdx)) {
						totalEntries++;
					}
				}
			}
		}

		this.selOverlayPositions = new Float32Array(totalEntries * 2);
		this.selOverlayColors = new Uint8Array(totalEntries * 4);
		this.selOverlayAngles = new Float32Array(totalEntries);
		this.selOverlayIds = new Array(totalEntries);
		let oi = 0;

		// Reset all colors to default, then hide selected locations
		for (const entry of cellEntries) {
			const cb = this.cells.get(entry.cellChar);
			if (!cb) continue;
			const n = Math.min(entry.locCount, cb.count);
			for (let li = 0; li < n; li++) {
				const c4 = li * 4;
				cb.colors[c4] = 42;
				cb.colors[c4 + 1] = 42;
				cb.colors[c4 + 2] = 42;
				cb.colors[c4 + 3] = 255;
			}
		}

		// Append per-selection in order — later selections overdraw earlier ones
		for (let si = 0; si < numSels; si++) {
			const [r, g, b] = selColors[si];
			for (const entry of cellEntries) {
				const cb = this.cells.get(entry.cellChar);
				if (!cb) continue;
				const n = Math.min(entry.locCount, cb.count);

				for (let li = 0; li < n; li++) {
					const byteIdx = li >> 3;
					const bitIdx = li & 7;
					if (!(entry.masks[si][byteIdx] & (1 << bitIdx))) continue;

					const locId = cb.ids[li];
					if (locId != null) selectedIds.add(locId);

					const c4 = li * 4;
					cb.colors[c4] = 0;
					cb.colors[c4 + 1] = 0;
					cb.colors[c4 + 2] = 0;
					cb.colors[c4 + 3] = 0;

					this.selOverlayPositions[oi * 2] = cb.positions[li * 2];
					this.selOverlayPositions[oi * 2 + 1] = cb.positions[li * 2 + 1];
					this.selOverlayColors[oi * 4] = r;
					this.selOverlayColors[oi * 4 + 1] = g;
					this.selOverlayColors[oi * 4 + 2] = b;
					this.selOverlayColors[oi * 4 + 3] = 255;
					this.selOverlayAngles[oi] = cb.angles[li];
					this.selOverlayIds[oi] = locId!;
					oi++;
				}
			}
		}

		for (const entry of cellEntries) {
			const cb = this.cells.get(entry.cellChar);
			if (cb) cb.colorVersion++;
		}

		this.selOverlayCount = oi;
		this.selOverlayVersion++;
		this.version++;
		return selectedIds;
	}

	clear() {
		this.cells.clear();
		this.totalCount = 0;
		this.selOverlayCount = 0;
		this.selOverlayVersion++;
		this.version++;
	}
}
