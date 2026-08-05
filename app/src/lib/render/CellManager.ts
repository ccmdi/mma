import type { RenderDelta, RenderEntry, SelPaint } from "@/bindings.gen";

/** A marker's selection state: `null` = the base layer draws it, a paint = the overlay does. */
export type SelColor = SelPaint | null;

function bitHas(bits: Uint8Array, id: number): boolean {
	return (bits[id >>> 3] & (1 << (id & 7))) !== 0;
}

/** Per-cell, per-selection membership: a dense bitmask or a sparse selected-index list. */
export type SelEntry = { kind: "mask"; mask: Uint8Array } | { kind: "idx"; indices: Uint32Array };
export interface SelCellEntry {
	cellChar: string;
	locCount: number;
	sels: SelEntry[];
}

/**
 * Decode the inline selection-bitmask bytes written by Rust's `serialize_cell_bitmask`
 * (location_store.rs). Sole reader of that wire format — all format knowledge lives here
 * and in `applySelectionBitmasks`, which consumes the decoded entries.
 */
export function decodeSelectionBitmask(bytes: number[]): {
	selColors: [number, number, number][];
	cellEntries: SelCellEntry[];
} {
	const buf = new Uint8Array(bytes).buffer;
	const dv = new DataView(buf);
	let off = 0;
	const numSels = dv.getUint32(off, true);
	off += 4;
	const selColors: [number, number, number][] = [];
	for (let i = 0; i < numSels; i++) {
		selColors.push([dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2)]);
		off += 3;
	}
	const numCells = dv.getUint8(off);
	off += 1;
	const cellEntries: SelCellEntry[] = [];
	for (let ci = 0; ci < numCells; ci++) {
		const cellChar = String.fromCharCode(dv.getUint8(off));
		off += 1;
		const locCount = dv.getUint32(off, true);
		off += 4;
		const maskBytes = Math.ceil(locCount / 8);
		const sels: SelEntry[] = [];
		for (let si = 0; si < numSels; si++) {
			const fmt = dv.getUint8(off);
			off += 1;
			if (fmt === 1) {
				const count = dv.getUint32(off, true);
				off += 4;
				const indices = new Uint32Array(count);
				for (let k = 0; k < count; k++) {
					indices[k] = dv.getUint32(off, true);
					off += 4;
				}
				sels.push({ kind: "idx", indices });
			} else {
				sels.push({ kind: "mask", mask: new Uint8Array(buf, off, maskBytes) });
				off += maskBytes;
			}
		}
		cellEntries.push({ cellChar, locCount, sels });
	}
	return { selColors, cellEntries };
}

/** The read-only id-membership surface shared by `Set<number>` and `SelectedIds`, for code
 *  that only needs `size` / `has` / iteration over either. */
export interface ReadonlyIdSet extends Iterable<number> {
	readonly size: number;
	has(id: number): boolean;
}

/**
 * Membership set of selected location ids, backed by a bit array indexed by id rather than a
 * hash `Set`. Location ids are dense u32s, so a bitset makes the build ~10x cheaper than 1M
 * `Set.add`s (a typed-array OR vs hashing), with O(1) `has`/`size`. Iteration yields the
 * selected ids from the overlay's id array. Exposes the Set-like surface its consumers use.
 */
export class SelectedIds {
	/** Shared empty selection (no map open / cleared). */
	static readonly EMPTY = new SelectedIds(new Uint8Array(0), 0);

	constructor(
		private readonly bits: Uint8Array,
		/** Count of distinct selected ids (not overlay entries — an id selected by N
		 *  overlapping selections still counts once). */
		readonly size: number,
	) {}

	has(id: number): boolean {
		const w = id >>> 3;
		return w < this.bits.length && (this.bits[w] & (1 << (id & 7))) !== 0;
	}

	/** Yields each selected id once, ascending. Scans the bit array, so it's O(maxId/8);
	 *  used by deliberate bulk consumers (export, bulk-tag, delete), not the per-frame path. */
	*[Symbol.iterator](): Iterator<number> {
		const bits = this.bits;
		for (let w = 0; w < bits.length; w++) {
			const byte = bits[w];
			if (byte === 0) continue;
			const base = w << 3;
			for (let b = 0; b < 8; b++) {
				if (byte & (1 << b)) yield base + b;
			}
		}
	}
}

const MIN_CAPACITY = 256;

/**
 * The markers drawn by the selection overlay, keyed by location id.
 *
 * Sole authority on "is this row drawn by the overlay rather than the base layer" — the
 * base cells hold no selection state, they derive their visibility byte from `has`.
 * Presence is a bit array and id -> slot is a plain `Uint32Array`, so nothing here
 * hashes: a bulk rebuild costs one extra store per marker over writing the draw arrays
 * alone, and every by-id operation is O(1).
 *
 * Writes swap-remove, so slots land unordered — but the overlay is one deck.gl layer and
 * every marker sits at z=0, which makes slot order the only z-stacking there is. `order()`
 * puts the slots back in selection order, and the batch entry points call it once they
 * settle. Nothing else may hand these arrays to a layer.
 */
export class SelectionOverlay {
	positions = new Float32Array(0);
	colors = new Uint8Array(0);
	angles = new Float32Array(0);
	ids = new Uint32Array(0);
	/** Per-entry index of the selection drawing it, and the sort key `order()` uses.
	 *  CPU-side bookkeeping like `ids` — never an attribute, never uploaded. */
	sel = new Uint32Array(0);
	count = 0;
	version = 0;

	private capacity = 0;
	private bits = new Uint8Array(0);
	/** id -> slot. Only meaningful where `bits` is set, so it needs no empty sentinel. */
	private slot = new Uint32Array(0);
	/** Scratch for `order()`: entry -> destination slot. Reused across calls. */
	private dest = new Uint32Array(0);

	has(id: number): boolean {
		const w = id >>> 3;
		return w < this.bits.length && (this.bits[w] & (1 << (id & 7))) !== 0;
	}

	/** Add `id` to the overlay, or restate an existing entry. `selIdx` is the drawing
	 *  selection's index — the sort key `order()` needs, which no caller can recover from
	 *  the colour alone once two selections share one. */
	set(
		id: number,
		lng: number,
		lat: number,
		heading: number,
		color: readonly [number, number, number],
		selIdx: number,
	) {
		let i: number;
		if (this.has(id)) {
			i = this.slot[id];
		} else {
			this.ensure(this.count + 1, id);
			i = this.count++;
			this.bits[id >>> 3] |= 1 << (id & 7);
			this.slot[id] = i;
			this.ids[i] = id;
		}
		this.positions[i * 2] = lng;
		this.positions[i * 2 + 1] = lat;
		this.angles[i] = heading;
		this.sel[i] = selIdx;
		const o = i * 4;
		this.colors[o] = color[0];
		this.colors[o + 1] = color[1];
		this.colors[o + 2] = color[2];
		this.colors[o + 3] = 255;
		this.version++;
	}

	/** Follow a row that moved. No-op when the row isn't in the overlay. */
	move(id: number, lng?: number, lat?: number, heading?: number) {
		if (!this.has(id)) return;
		const i = this.slot[id];
		if (lng != null) this.positions[i * 2] = lng;
		if (lat != null) this.positions[i * 2 + 1] = lat;
		if (heading != null) this.angles[i] = heading;
		this.version++;
	}

	delete(id: number) {
		if (!this.has(id)) return;
		const i = this.slot[id];
		const last = --this.count;
		if (i !== last) {
			this.positions.copyWithin(i * 2, last * 2, last * 2 + 2);
			this.colors.copyWithin(i * 4, last * 4, last * 4 + 4);
			this.angles[i] = this.angles[last];
			this.sel[i] = this.sel[last];
			const moved = this.ids[last];
			this.ids[i] = moved;
			this.slot[moved] = i;
		}
		this.bits[id >>> 3] &= ~(1 << (id & 7));
		this.version++;
	}

	clear() {
		this.count = 0;
		this.bits.fill(0);
		this.version++;
	}

	/**
	 * Sort the entries by selection index, so a later selection's markers overdraw an
	 * earlier one's everywhere rather than wherever slot order happens to favour them.
	 *
	 * Counting sort: the key is a small dense integer, so it is two O(n) passes and an
	 * array sized by the selection count. The leading scan makes the cases that need no
	 * work — already ordered, or one selection in play — a single pass with no allocation,
	 * which covers a plain single-selection map entirely.
	 */
	order() {
		const n = this.count;
		if (n < 2) return;
		const sel = this.sel;
		let lo = sel[0];
		let hi = sel[0];
		let sorted = true;
		for (let i = 1; i < n; i++) {
			const s = sel[i];
			if (s < sel[i - 1]) sorted = false;
			if (s < lo) lo = s;
			if (s > hi) hi = s;
		}
		if (sorted || lo === hi) return;

		// Bucket starts, then `dest[i]` = the slot entry `i` belongs in. Stable, so entries
		// within one selection keep the order they were written in.
		const at = new Uint32Array(hi - lo + 2);
		for (let i = 0; i < n; i++) at[sel[i] - lo + 1]++;
		for (let k = 1; k < at.length; k++) at[k] += at[k - 1];
		if (this.dest.length < n) this.dest = new Uint32Array(n);
		const dest = this.dest;
		for (let i = 0; i < n; i++) dest[i] = at[sel[i] - lo]++;

		// Apply the permutation in place by swapping each entry towards its slot. Every swap
		// lands at least one entry for good, so this is O(n) with no second set of arrays.
		for (let i = 0; i < n; i++) {
			while (dest[i] !== i) {
				const j = dest[i];
				this.swap(i, j);
				dest[i] = dest[j];
				dest[j] = j;
			}
		}
		this.version++;
	}

	/** Exchange two slots, keeping `slot` pointing at where each id actually lives. */
	private swap(i: number, j: number) {
		for (let k = 0; k < 2; k++) {
			const t = this.positions[i * 2 + k];
			this.positions[i * 2 + k] = this.positions[j * 2 + k];
			this.positions[j * 2 + k] = t;
		}
		for (let k = 0; k < 4; k++) {
			const t = this.colors[i * 4 + k];
			this.colors[i * 4 + k] = this.colors[j * 4 + k];
			this.colors[j * 4 + k] = t;
		}
		const a = this.angles[i];
		this.angles[i] = this.angles[j];
		this.angles[j] = a;
		const s = this.sel[i];
		this.sel[i] = this.sel[j];
		this.sel[j] = s;
		const id = this.ids[i];
		this.ids[i] = this.ids[j];
		this.ids[j] = id;
		this.slot[this.ids[i]] = i;
		this.slot[this.ids[j]] = j;
	}

	/** Snapshot of the selected ids. Copies the bit array so later edits can't mutate it. */
	selectedIds(): SelectedIds {
		if (this.count === 0) return SelectedIds.EMPTY;
		return new SelectedIds(this.bits.slice(), this.count);
	}

	/** Replace every entry with arrays sliced straight out of Rust's render binary, which
	 *  ships them already in selection order. */
	load(
		positions: Float32Array<ArrayBuffer>,
		colors: Uint8Array<ArrayBuffer>,
		angles: Float32Array<ArrayBuffer>,
		ids: Uint32Array<ArrayBuffer>,
		sel: Uint32Array<ArrayBuffer>,
		maxId: number,
	) {
		this.positions = positions;
		this.colors = colors;
		this.angles = angles;
		this.ids = ids;
		this.sel = sel;
		this.count = this.capacity = ids.length;
		this.bits = new Uint8Array((maxId >>> 3) + 1);
		this.slot = new Uint32Array(maxId + 1);
		for (let i = 0; i < ids.length; i++) {
			const id = ids[i];
			this.bits[id >>> 3] |= 1 << (id & 7);
			this.slot[id] = i;
		}
		this.version++;
	}

	/** Size up front for a rebuild of known size, so `set` never reallocates mid-loop. */
	reserve(n: number, maxId: number) {
		if (n > 0) this.ensure(n, maxId);
	}

	/** Grow the draw arrays to hold `n` entries and the id-keyed arrays to cover `maxId`. */
	private ensure(n: number, maxId: number) {
		if (n > this.capacity) {
			const cap = Math.max(n, this.capacity * 2, MIN_CAPACITY);
			this.positions = grow(this.positions, cap * 2, Float32Array);
			this.colors = grow(this.colors, cap * 4, Uint8Array);
			this.angles = grow(this.angles, cap, Float32Array);
			this.ids = grow(this.ids, cap, Uint32Array);
			this.sel = grow(this.sel, cap, Uint32Array);
			this.capacity = cap;
		}
		// `bits` and `slot` are both indexed by id, so they grow together off one id capacity.
		// Sizing them independently lets `slot` fall short of an id `bits` already covers.
		if (maxId >= this.slot.length) {
			const ids = Math.max(maxId + 1, this.slot.length * 2, MIN_CAPACITY);
			this.slot = grow(this.slot, ids, Uint32Array);
			this.bits = grow(this.bits, (ids >>> 3) + 1, Uint8Array);
		}
	}
}

type TypedArray = Float32Array | Uint32Array | Uint8Array;

function grow<T extends TypedArray>(src: T, len: number, Ctor: new (n: number) => T): T {
	const out = new Ctor(len);
	out.set(src as unknown as ArrayLike<number>);
	return out;
}

/**
 * Typed-array backed buffer for one geohash cell's marker data.
 * Grows by doubling. Removals use swap-remove (O(1), order not preserved).
 * Versioned per-attribute so deck.gl can skip unchanged layers.
 */
export class CellBuffer {
	ids: number[] = [];
	idToIndex = new Map<number, number>();
	positions: Float32Array;
	/** Per-marker visibility, 255 draws and 0 hides. Every base marker is drawn in the one
	 *  global marker colour, which the layer supplies as a constant, so the only per-marker
	 *  colour fact is whether a selection or the active highlight is covering it. */
	visible: Uint8Array;
	angles: Float32Array;
	count = 0;
	capacity: number;
	positionVersion = 0;
	colorVersion = 0;

	constructor(capacity = MIN_CAPACITY) {
		this.capacity = capacity;
		this.positions = new Float32Array(capacity * 2);
		this.visible = new Uint8Array(capacity);
		this.angles = new Float32Array(capacity);
	}

	/** Append a marker, growing the buffer if needed. Visibility is corrected by the
	 *  caller's `syncVisible` once the overlay knows about the row. */
	append(entry: RenderEntry) {
		this.ensureCapacity(this.count + 1);
		const i = this.count;
		this.positions[i * 2] = entry.lng;
		this.positions[i * 2 + 1] = entry.lat;
		this.visible[i] = 255;
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
			this.visible[index] = this.visible[last];
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

	/** Show (255) or hide (0) one marker in the base layer. */
	patchVisible(index: number, visible: number) {
		if (index < 0 || index >= this.count) return;
		this.visible[index] = visible;
		this.colorVersion++;
	}

	private ensureCapacity(needed: number) {
		if (needed <= this.capacity) return;
		const newCap = Math.max(needed, this.capacity * 2, MIN_CAPACITY);
		const newPos = new Float32Array(newCap * 2);
		const newVis = new Uint8Array(newCap);
		const newAng = new Float32Array(newCap);
		newPos.set(this.positions.subarray(0, this.count * 2));
		newVis.set(this.visible.subarray(0, this.count));
		newAng.set(this.angles.subarray(0, this.count));
		this.positions = newPos;
		this.visible = newVis;
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
	/** Largest location id seen — sizes the selection bitset. Monotonic (never shrinks on
	 *  removal; an overestimate just over-allocates a few bytes). */
	maxId = 0;

	/** The rows the selection overlay draws, and the only record of which rows are selected. */
	readonly overlay = new SelectionOverlay();
	/** The row the active-location layer draws, hidden in its base cell. */
	private activeId: number | null = null;

	/** Parse the full render binary from Rust. Replaces all cells and the selection overlay. */
	initFromBinary(buf: ArrayBuffer) {
		this.cells.clear();
		this.totalCount = 0;
		this.maxId = 0;
		this.overlay.clear();

		const dv = new DataView(buf);
		if (buf.byteLength < 4) return;
		const cellCount = dv.getUint32(0, true);
		let offset = 4;

		for (let c = 0; c < cellCount; c++) {
			const gh0 = dv.getUint8(offset);
			const cellKey = String.fromCharCode(gh0);
			const count = dv.getUint32(offset + 1, true);
			// 5-byte header + 3 pad; the arrays sit 4-byte aligned so the views below are legal.
			offset += 8;

			const cb = new CellBuffer(count);
			cb.count = count;

			const idView = new Uint32Array(buf, offset, count);
			offset += count * 4;
			cb.ids = Array.from(idView);
			cb.idToIndex.clear();
			for (let i = 0; i < count; i++) {
				const id = cb.ids[i];
				cb.idToIndex.set(id, i);
				if (id > this.maxId) this.maxId = id;
			}

			cb.positions = new Float32Array(buf, offset, count * 2);
			offset += count * 8;
			cb.visible = new Uint8Array(buf, offset, count);
			offset += count + ((4 - (count & 3)) & 3);
			cb.angles = new Float32Array(buf, offset, count);
			offset += count * 4;

			cb.capacity = count;

			this.cells.set(cellKey, cb);
			this.totalCount += count;
		}

		// Selection overlay, in selection order:
		// [u32 count][f32[] positions][u8[] colors][f32[] angles][u32[] ids][u32[] selIdx]
		if (offset + 4 <= buf.byteLength) {
			const selCount = dv.getUint32(offset, true);
			offset += 4;
			if (selCount > 0) {
				const pos = new Float32Array(buf, offset, selCount * 2);
				offset += selCount * 8;
				const col = new Uint8Array(buf, offset, selCount * 4);
				offset += selCount * 4;
				const ang = new Float32Array(buf, offset, selCount);
				offset += selCount * 4;
				const ids = new Uint32Array(buf, offset, selCount);
				offset += selCount * 4;
				const sel = new Uint32Array(buf, offset, selCount);
				this.overlay.load(pos, col, ang, ids, sel, this.maxId);
			}
		}

		this.version++;
	}

	/** Scratch for `applySelectionBitmasks`: per-row winning selection index, reused across
	 *  cells so a full sync does not allocate one array per cell. */
	private selWinner = new Int32Array(0);

	/**
	 * Apply an incremental delta. Every entry states the row's resulting selection state,
	 * so the base cells and the overlay are written from one fact rather than inferred
	 * from each other. Returns the affected cell keys.
	 */
	applyDelta(delta: RenderDelta): Set<string> {
		const affected = new Set<string>();
		const overlayBefore = this.overlay.version;

		for (const rem of delta.removed) {
			const cb = this.cells.get(rem.cell);
			if (cb) {
				cb.swapRemove(rem.cellIndex);
				this.totalCount--;
				affected.add(rem.cell);
			}
			this.overlay.delete(rem.id);
		}

		for (const entry of delta.added) {
			// A row that crossed cells vacates its old slot here, so its overlay entry is
			// restated below rather than dropped by an unrelated-looking removal.
			if (entry.movedFrom) {
				const from = this.cells.get(entry.movedFrom.cell);
				if (from) {
					from.swapRemove(entry.movedFrom.cellIndex);
					this.totalCount--;
					affected.add(entry.movedFrom.cell);
				}
			}
			let cb = this.cells.get(entry.cell);
			if (!cb) {
				cb = new CellBuffer();
				this.cells.set(entry.cell, cb);
			}
			cb.append(entry);
			if (entry.id > this.maxId) this.maxId = entry.id;
			this.totalCount++;
			affected.add(entry.cell);
			this.setSelection(cb, cb.count - 1, entry.sel);
		}

		for (const patch of delta.updated) {
			const cb = this.cells.get(patch.cell);
			if (!cb || patch.cellIndex >= cb.count) continue;
			const i = patch.cellIndex;
			cb.patchPosition(
				i,
				patch.lng ?? undefined,
				patch.lat ?? undefined,
				patch.heading ?? undefined,
			);
			affected.add(patch.cell);
			this.setSelection(cb, i, patch.sel);
		}

		// Entries just added landed at the end of the overlay and deletes swapped the tail
		// into the hole, so the slots have to be put back in selection order before they
		// are drawn — otherwise an edited marker jumps in front of everything. Guarded on
		// the overlay having moved at all, so a delta that touches no selected row doesn't
		// pay a scan over every selected marker on the map.
		if (this.overlay.version !== overlayBefore) this.overlay.order();

		this.version++;
		return affected;
	}

	/** Put the row at `cb[i]` in or out of the selection overlay and set its base visibility.
	 *  Idempotent, so restating a row's current state costs nothing but is always safe.
	 *  Takes the buffer and index the caller already has — `syncVisible` is for the
	 *  active-location path, which only knows an id. */
	private setSelection(cb: CellBuffer, i: number, sel: SelColor) {
		const id = cb.ids[i];
		if (sel) {
			const p = cb.positions;
			this.overlay.set(id, p[i * 2], p[i * 2 + 1], cb.angles[i], sel.color, sel.idx);
		} else {
			this.overlay.delete(id);
		}
		cb.patchVisible(i, sel || id === this.activeId ? 0 : 255);
	}

	/** Set the active location, whose marker the active layer draws instead of the base cell.
	 *  Returns whether the active row actually moved. */
	setActive(id: number | null): boolean {
		if (id === this.activeId) return false;
		const prev = this.activeId;
		this.activeId = id;
		if (prev != null) this.syncVisible(prev);
		if (id != null) this.syncVisible(id);
		this.version++;
		return true;
	}

	/**
	 * A base row is hidden exactly when something else is drawing it: the selection overlay
	 * or the active-location layer. The only place `visible` is decided for a single row, so
	 * "selected" and "active" never have to negotiate over the byte.
	 */
	private syncVisible(id: number) {
		const hidden = this.overlay.has(id) || id === this.activeId;
		for (const cb of this.cells.values()) {
			const i = cb.idToIndex.get(id);
			if (i == null) continue;
			cb.patchVisible(i, hidden ? 0 : 255);
			return;
		}
	}

	/** Map a deck.gl pick (cell + index) back to a location ID. */
	resolvePickFromCell(cellKey: string, cellIndex: number): number | null {
		const cb = this.cells.get(cellKey);
		if (!cb || cellIndex < 0 || cellIndex >= cb.count) return null;
		return cb.ids[cellIndex] ?? null;
	}

	/** Selected-id set, snapshotted from the overlay. */
	selectedIds(): SelectedIds {
		return this.overlay.selectedIds();
	}

	/**
	 * Decode per-cell bitmasks from Rust into the selection overlay. Selected rows are drawn
	 * by the overlay in their selection's color and hidden in their base cell.
	 *
	 * Partial updates are supported: only the cells named in `cellEntries` are restated,
	 * and overlay entries for every other cell survive untouched.
	 */
	applySelectionBitmasks(
		selColors: [number, number, number][],
		cellEntries: SelCellEntry[],
	): SelectedIds {
		const numSels = selColors.length;
		const incoming: { cb: CellBuffer; n: number; entry: SelCellEntry }[] = [];
		for (const entry of cellEntries) {
			const cb = this.cells.get(entry.cellChar);
			if (cb) incoming.push({ cb, n: Math.min(entry.locCount, cb.count), entry });
		}

		// Clear the incoming cells' share of the overlay. A full sync (every cell present)
		// drops the lot in one fill instead of a swap-remove per row.
		if (cellEntries.length === this.cells.size) {
			this.overlay.clear();
		} else {
			for (const { cb, n } of incoming) {
				for (let i = 0; i < n; i++) this.overlay.delete(cb.ids[i]);
			}
		}

		// Upper bound on the entries about to be written, so the overlay sizes once. A row in
		// several selections yields one entry, not several, so the writes finish under it.
		let bound = this.overlay.count;
		for (const { n, entry } of incoming) {
			for (let si = 0; si < numSels; si++) {
				const sel = entry.sels[si];
				if (sel.kind === "idx") {
					const idx = sel.indices;
					for (let k = 0; k < idx.length; k++) if (idx[k] < n) bound++;
				} else {
					for (let li = 0; li < n; li++) if (bitHas(sel.mask, li)) bound++;
				}
			}
		}
		this.overlay.reserve(bound, this.maxId);

		for (const { cb, n, entry } of incoming) {
			// Every row in the cell is shown again; the winners below hide themselves.
			cb.visible.fill(255, 0, n);
			cb.colorVersion++;
			if (n === 0) continue;

			// `winner` records which selection owns each row: later selections overdraw
			// earlier ones, so the highest matching index is the colour. Resolving it here
			// rather than by stacking quads keeps overlapping selections from uploading
			// entries that are drawn and immediately covered.
			if (this.selWinner.length < n) this.selWinner = new Int32Array(n);
			const winner = this.selWinner;
			winner.fill(-1, 0, n);
			for (let si = 0; si < numSels; si++) {
				const sel = entry.sels[si];
				if (sel.kind === "idx") {
					const idx = sel.indices;
					for (let k = 0; k < idx.length; k++) if (idx[k] < n) winner[idx[k]] = si;
				} else {
					for (let li = 0; li < n; li++) if (bitHas(sel.mask, li)) winner[li] = si;
				}
			}

			for (let li = 0; li < n; li++) {
				const si = winner[li];
				if (si < 0) continue;
				this.overlay.set(
					cb.ids[li],
					cb.positions[li * 2],
					cb.positions[li * 2 + 1],
					cb.angles[li],
					selColors[si],
					si,
				);
				cb.visible[li] = 0;
			}
		}

		// Written cell by cell, so the slots come out in row order. Sorting them by selection
		// is what makes the winner above hold between neighbouring markers too, not just
		// between two selections covering the same row.
		this.overlay.order();

		// The active row was shown again along with the rest of its cell.
		if (this.activeId != null) this.syncVisible(this.activeId);

		this.version++;
		return this.overlay.selectedIds();
	}

	clear() {
		this.cells.clear();
		this.totalCount = 0;
		this.activeId = null;
		this.overlay.clear();
		this.version++;
	}
}
