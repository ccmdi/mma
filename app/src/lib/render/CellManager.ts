import { FrameKind, NO_SEL } from "@/bindings.consts";
import { applyPolygonFrame } from "@/lib/render/polygonMeshes";
import type { RGB } from "@/bindings.gen";

/** Render cells are keyed by the first character of a location's geohash. */
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

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

/** Decode a frame's selection section. */
export function decodeSelectionBitmask(bytes: Uint8Array): {
	selColors: RGB[];
	cellEntries: SelCellEntry[];
} {
	const buf = bytes.buffer;
	const dv = new DataView(buf, bytes.byteOffset, bytes.byteLength);
	let off = 0;
	const numSels = dv.getUint32(off, true);
	off += 4;
	const selColors: RGB[] = [];
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
				sels.push({ kind: "mask", mask: new Uint8Array(buf, bytes.byteOffset + off, maskBytes) });
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

	private readonly bits: Uint8Array;
	/** Count of distinct selected ids (not overlay entries - an id selected by N
	 *  overlapping selections still counts once). */
	readonly size: number;

	constructor(bits: Uint8Array, size: number) {
		this.bits = bits;
		this.size = size;
	}

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
 * Sole authority on "is this row drawn by the overlay rather than the base layer" - the
 * base cells hold no selection state, they derive their visibility byte from `has`.
 * Presence is a bit array and id -> slot is a plain `Uint32Array`, so nothing here
 * hashes: a bulk rebuild costs one extra store per marker over writing the draw arrays
 * alone, and every by-id operation is O(1).
 *
 * Writes swap-remove, so slots land unordered - but the overlay is one deck.gl layer and
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
	 *  CPU-side bookkeeping like `ids` - never an attribute, never uploaded. */
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
	 *  selection's index - the sort key `order()` needs, which no caller can recover from
	 *  the colour alone once two selections share one. */
	set(id: number, lng: number, lat: number, heading: number, color: Readonly<RGB>, selIdx: number) {
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
	 * work - already ordered, or one selection in play - a single pass with no allocation,
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
	 *  colour fact is whether a selection or the open-location highlight is covering it. */
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

	/** A cell holding `rows` as they are, viewing the frame's arrays rather than copying
	 *  them. Every row starts hidden until the caller paints it. */
	static of(rows: FrameRows): CellBuffer {
		const n = rows.key.length;
		const cb = new CellBuffer(0);
		cb.positions = rows.pos;
		cb.angles = rows.angle;
		cb.visible = new Uint8Array(n);
		cb.ids = Array.from(rows.key);
		for (let i = 0; i < n; i++) cb.idToIndex.set(cb.ids[i], i);
		cb.count = cb.capacity = n;
		return cb;
	}

	/** Append a marker, growing the buffer if needed. Visibility is set by the caller once
	 *  the overlay knows about the row. */
	append(id: number, lng: number, lat: number, angle: number) {
		this.ensureCapacity(this.count + 1);
		const i = this.count;
		this.positions[i * 2] = lng;
		this.positions[i * 2 + 1] = lat;
		this.visible[i] = 255;
		this.angles[i] = angle;
		this.ids[i] = id;
		this.idToIndex.set(id, i);
		this.count++;
		this.positionVersion++;
		this.colorVersion++;
	}

	/** O(1) removal by swapping with the last element. */
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

	patchPosition(index: number, lng: number, lat: number, angle: number) {
		if (index < 0 || index >= this.count) return;
		this.positions[index * 2] = lng;
		this.positions[index * 2 + 1] = lat;
		this.angles[index] = angle;
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

/** One cell's rows in a frame, viewed in place: ids for adds, slots for patches. */
interface FrameRows {
	key: Uint32Array<ArrayBuffer>;
	pos: Float32Array<ArrayBuffer>;
	angle: Float32Array<ArrayBuffer>;
	sel: Uint32Array<ArrayBuffer>;
}

function rowsAt(buf: ArrayBuffer, off: number, n: number): FrameRows {
	return {
		key: new Uint32Array(buf, off, n),
		pos: new Float32Array(buf, off + n * 4, n * 2),
		angle: new Float32Array(buf, off + n * 12, n),
		sel: new Uint32Array(buf, off + n * 16, n),
	};
}

/** What applying one frame did: the map version the scene reached, whether it started the
 *  scene over, and the ids it added and removed, ascending. A row that moved between cells
 *  is in neither; a replace lists nothing. */
export interface FrameSummary {
	version: number;
	replace: boolean;
	added: Uint32Array;
	removed: Uint32Array;
}

/**
 * Owns all marker render data as 32 geohash-cell CellBuffers plus a selection overlay,
 * kept in step with the map by applying its render frames in order (`apply`).
 * deck.gl layers read the typed arrays directly - no JSON serialization in the render loop.
 */
export class CellManager {
	cells = new Map<string, CellBuffer>();
	totalCount = 0;
	version = 0;
	/** Largest location id seen - sizes the selection bitset. Monotonic (never shrinks on
	 *  removal; an overestimate just over-allocates a few bytes). */
	maxId = 0;

	/** The rows the selection overlay draws, and the only record of which rows are selected. */
	readonly overlay = new SelectionOverlay();
	/** The location the open-location layer draws, hidden in its base cell. */
	private openId: number | null = null;

	/** Scratch for `restateSelections`: per-row winning selection index, reused across
	 *  cells so a full restate does not allocate one array per cell. */
	private selWinner = new Int32Array(0);

	/**
	 * Apply one render frame. Every cell's removals swap-remove their slots first; then per
	 * cell the adds append and the patches restate rows by their slot. Every added or patched row
	 * states the selection painting it, so the base cells and the overlay are written from
	 * one fact. A selection section, when present, then restates every cell's membership.
	 */
	apply(buf: ArrayBuffer): FrameSummary {
		const dv = new DataView(buf);
		const replace = dv.getUint32(0, true) === FrameKind.Replace;
		const version = dv.getUint32(4, true) + dv.getUint32(8, true) * 2 ** 32;
		const paletteLen = dv.getUint32(12, true);
		const palette: RGB[] = [];
		for (let i = 0, o = 16; i < paletteLen; i++, o += 3) {
			palette.push([dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2)]);
		}
		let off = (16 + paletteLen * 3 + 3) & ~3;
		if (replace) {
			this.cells.clear();
			this.totalCount = 0;
			this.maxId = 0;
			this.overlay.clear();
		}
		const overlayBefore = this.overlay.version;
		const added: number[] = [];
		const removed: number[] = [];

		const cellCount = dv.getUint32(off, true);
		off += 4;
		const writes: { key: string; add: FrameRows; patch: FrameRows }[] = [];
		for (let c = 0; c < cellCount; c++) {
			const key = BASE32[dv.getUint32(off, true)];
			const nRemove = dv.getUint32(off + 4, true);
			const nAdd = dv.getUint32(off + 8, true);
			const nPatch = dv.getUint32(off + 12, true);
			off += 16;
			const remove = new Uint32Array(buf, off, nRemove);
			off += nRemove * 4;
			writes.push({
				key,
				add: rowsAt(buf, off, nAdd),
				patch: rowsAt(buf, off + nAdd * 20, nPatch),
			});
			off += (nAdd + nPatch) * 20;

			const cb = this.cells.get(key);
			if (cb) {
				for (const i of remove) {
					const id = cb.ids[i];
					removed.push(id);
					this.overlay.delete(id);
					cb.swapRemove(i);
					this.totalCount--;
				}
			}
		}
		// All removals land before any write, so a row moved into an earlier cell keeps its overlay entry.
		for (const { key, add, patch } of writes) {
			const nAdd = add.key.length;
			const nPatch = patch.key.length;
			let cb = this.cells.get(key);
			if (nAdd > 0) {
				const from = cb?.count ?? 0;
				if (cb) {
					for (let k = 0; k < nAdd; k++) {
						cb.append(add.key[k], add.pos[k * 2], add.pos[k * 2 + 1], add.angle[k]);
					}
				} else {
					cb = CellBuffer.of(add);
					this.cells.set(key, cb);
				}
				for (let k = 0; k < nAdd; k++) {
					const id = add.key[k];
					if (id > this.maxId) this.maxId = id;
					if (!replace) added.push(id);
					this.paint(cb, from + k, add.sel[k], palette);
				}
				this.totalCount += nAdd;
			}
			if (cb && nPatch > 0) {
				for (let k = 0; k < nPatch; k++) {
					const i = patch.key[k];
					if (i >= cb.count) continue;
					cb.patchPosition(i, patch.pos[k * 2], patch.pos[k * 2 + 1], patch.angle[k]);
					this.paint(cb, i, patch.sel[k], palette);
				}
			}
			if (cb) cb.colorVersion++;
		}

		const selectionLen = dv.getUint32(off, true);
		const polygonsChanged = applyPolygonFrame(buf, (off + 4 + selectionLen + 3) & ~3, replace);
		if (selectionLen > 0) {
			this.restateSelections(decodeSelectionBitmask(new Uint8Array(buf, off + 4, selectionLen)));
		} else if (this.overlay.version !== overlayBefore) {
			// Adds land at the end of the overlay and deletes swap the tail into the hole, so
			// the slots go back in selection order before they are drawn - otherwise an edited
			// marker jumps in front of everything.
			this.overlay.order();
		}

		if (replace || cellCount > 0 || selectionLen > 0 || polygonsChanged) this.version++;
		return { version, replace, ...withoutMoves(added, removed) };
	}

	/** Put the row at `cb[i]` in or out of the selection overlay and set its base visibility.
	 *  Idempotent, so restating a row's current state costs nothing but is always safe.
	 *  The caller bumps the cell's colour version once for the whole frame. */
	private paint(cb: CellBuffer, i: number, sel: number, palette: RGB[]) {
		const id = cb.ids[i];
		if (sel !== NO_SEL) {
			const p = cb.positions;
			this.overlay.set(id, p[i * 2], p[i * 2 + 1], cb.angles[i], palette[sel], sel);
		} else {
			this.overlay.delete(id);
		}
		cb.visible[i] = sel !== NO_SEL || id === this.openId ? 0 : 255;
	}

	/** Set the open location, whose marker the open-location layer draws instead of the base cell. */
	setOpen(id: number | null) {
		const prev = this.openId;
		this.openId = id;
		if (prev != null) this.syncVisible(prev);
		if (id != null) this.syncVisible(id);
		this.version++;
	}

	/**
	 * A base row is hidden exactly when something else is drawing it: the selection overlay
	 * or the open-location layer. The only place `visible` is decided for a single row, so
	 * "selected" and "open" never have to negotiate over the byte.
	 */
	private syncVisible(id: number) {
		const hidden = this.overlay.has(id) || id === this.openId;
		for (const cb of this.cells.values()) {
			const i = cb.idToIndex.get(id);
			if (i == null) continue;
			cb.patchVisible(i, hidden ? 0 : 255);
			return;
		}
	}

	/** Visit every rendered location's position. The cells hold all alive rows (a `visible`
	 *  0 only means the overlay or open-location layer draws that row instead), so this is the
	 *  maintained full-map position set. */
	forEachPosition(f: (id: number, lng: number, lat: number) => void) {
		for (const cb of this.cells.values()) {
			for (let i = 0; i < cb.count; i++) {
				f(cb.ids[i], cb.positions[i * 2], cb.positions[i * 2 + 1]);
			}
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
	 * Restate the selection overlay from a frame's selection section. Selected rows are
	 * drawn by the overlay in their selection's color and hidden in their base cell.
	 *
	 * Partial updates are supported: only the cells named in `cellEntries` are restated,
	 * and overlay entries for every other cell survive untouched.
	 */
	private restateSelections({
		selColors,
		cellEntries,
	}: {
		selColors: RGB[];
		cellEntries: SelCellEntry[];
	}) {
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

		// The open location was shown again along with the rest of its cell.
		if (this.openId != null) this.syncVisible(this.openId);
	}

	clear() {
		this.cells.clear();
		this.totalCount = 0;
		this.openId = null;
		this.overlay.clear();
		this.version++;
	}
}

/** Ascending ids, minus the ones in both lists: a row that left one cell for another. */
function withoutMoves(added: number[], removed: number[]) {
	if (added.length > 0 && removed.length > 0) {
		const left = new Set(removed);
		const moved = new Set(added.filter((id) => left.has(id)));
		if (moved.size > 0) {
			added = added.filter((id) => !moved.has(id));
			removed = removed.filter((id) => !moved.has(id));
		}
	}
	return { added: Uint32Array.from(added).sort(), removed: Uint32Array.from(removed).sort() };
}
