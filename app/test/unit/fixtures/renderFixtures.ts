import { FrameKind, NO_SEL } from "@/bindings.consts";
import type {
	CellManager,
	FrameSummary,
	SelCellEntry,
	SelectedIds,
} from "@/lib/render/CellManager";
import type { RGB } from "@/bindings.gen";

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** The selection painting a row: its index in the palette, and that palette colour. `idx`
 *  is the drawing selection's position in the selection list, which the overlay orders by. */
export interface Paint {
	idx: number;
	color: RGB;
}

export interface Removal {
	cell: string;
	cellIndex: number;
	id: number;
}

/** A row an edit appends to `cell`. */
export interface Entry {
	cell: string;
	id: number;
	lng: number;
	lat: number;
	heading: number;
	sel: Paint | null;
	/** The slot the row left when it crossed cells, which the frame removes first. */
	movedFrom?: Removal;
}

/** A row an edit restates in place. Fields left null keep what the scene holds. */
export interface Patch {
	cell: string;
	cellIndex: number;
	lng: number | null;
	lat: number | null;
	heading: number | null;
	sel: Paint | null;
}

/** One edit in the shape a case reads naturally: what was added, restated and removed. */
export interface Delta {
	added: Entry[];
	updated: Patch[];
	removed: Removal[];
}

export function entry(
	cell: string,
	id: number,
	lng: number,
	lat: number,
	heading = 0,
	sel: Paint | null = null,
): Entry {
	return { cell, id, lng, lat, heading, sel };
}

export function paint(color: RGB, idx = 0): Paint {
	return { idx, color };
}

/** An edit with everything defaulted, so a case names only what it exercises. */
export function delta(parts: Partial<Delta> = {}): Delta {
	return { added: [], updated: [], removed: [], ...parts };
}

/** A patch that restates only the selection: the shape a pure membership change takes. */
export function selPatch(cell: string, cellIndex: number, sel: Paint | null): Patch {
	return { cell, cellIndex, lng: null, lat: null, heading: null, sel };
}

/** A row of a frame as the encoder takes it: an id for an add, a slot for a patch. */
export interface Row {
	key: number;
	lng: number;
	lat: number;
	angle?: number;
	sel?: number;
}

export interface CellSpec {
	cell: string;
	remove?: number[];
	add?: Row[];
	patch?: Row[];
}

export interface FrameSpec {
	replace?: boolean;
	version?: number;
	palette?: RGB[];
	cells?: CellSpec[];
	selection?: Uint8Array;
	/** Polygons by key with their meshes as the store encodes them, and keys gone. */
	polygons?: { added?: [string, Uint8Array][]; removed?: string[] };
}

/** Encode a render frame the way Rust's `Frame::encode` does. Cells go out in cell order. */
export function frame(spec: FrameSpec): ArrayBuffer {
	const out: number[] = [];
	const u32 = (v: number) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24);
	const f32 = (v: number) => out.push(...new Uint8Array(new Float32Array([v]).buffer));
	const pad = () => {
		while (out.length % 4) out.push(0);
	};
	const version = spec.version ?? 1;
	const palette = spec.palette ?? [];
	u32(spec.replace ? FrameKind.Replace : FrameKind.Patch);
	u32(version % 2 ** 32);
	u32(Math.floor(version / 2 ** 32));
	u32(palette.length);
	for (const rgb of palette) out.push(...rgb);
	pad();
	const cells = [...(spec.cells ?? [])].sort(
		(a, b) => BASE32.indexOf(a.cell) - BASE32.indexOf(b.cell),
	);
	const rows = (rs: Row[]) => {
		for (const r of rs) u32(r.key);
		for (const r of rs) {
			f32(r.lng);
			f32(r.lat);
		}
		for (const r of rs) f32(r.angle ?? 0);
		for (const r of rs) u32(r.sel ?? NO_SEL);
	};
	u32(cells.length);
	for (const c of cells) {
		const remove = c.remove ?? [];
		u32(BASE32.indexOf(c.cell));
		u32(remove.length);
		u32(c.add?.length ?? 0);
		u32(c.patch?.length ?? 0);
		for (const i of remove) u32(i);
		rows(c.add ?? []);
		rows(c.patch ?? []);
	}
	u32(spec.selection?.length ?? 0);
	if (spec.selection) {
		out.push(...spec.selection);
		pad();
	}
	const added = spec.polygons?.added ?? [];
	const removed = spec.polygons?.removed ?? [];
	u32(added.length);
	u32(removed.length);
	const key = (k: string) => {
		const bytes = new TextEncoder().encode(k);
		u32(bytes.length);
		out.push(...bytes);
		pad();
	};
	removed.forEach(key);
	for (const [k, mesh] of added) {
		key(k);
		u32(mesh.length);
		while (out.length % 8) out.push(0);
		out.push(...mesh);
	}
	return new Uint8Array(out).buffer;
}

/** The palette the paints name, gaps filled with black. */
function paletteOf(paints: (Paint | null)[]): RGB[] {
	const palette: RGB[] = [];
	for (const p of paints) {
		if (!p) continue;
		while (palette.length <= p.idx) palette.push([0, 0, 0]);
		palette[p.idx] = p.color;
	}
	return palette;
}

/** The cells an edit's removals and adds touch, in the order a frame applies them. */
function cellsOf(added: Entry[], removed: Removal[]) {
	const cells = new Map<string, Required<CellSpec>>();
	const at = (cell: string) => {
		let c = cells.get(cell);
		if (!c) cells.set(cell, (c = { cell, remove: [], add: [], patch: [] }));
		return c;
	};
	for (const r of removed) at(r.cell).remove.push(r.cellIndex);
	for (const e of added) if (e.movedFrom) at(e.movedFrom.cell).remove.push(e.movedFrom.cellIndex);
	for (const e of added) {
		at(e.cell).add.push({ key: e.id, lng: e.lng, lat: e.lat, angle: e.heading, sel: e.sel?.idx });
	}
	return { cells, at };
}

/** A replace frame holding `entries`: the whole scene from scratch. */
export function scene(entries: Entry[], version = 1): ArrayBuffer {
	const { cells } = cellsOf(entries, []);
	return frame({
		replace: true,
		version,
		palette: paletteOf(entries.map((e) => e.sel)),
		cells: [...cells.values()],
	});
}

/** What `cb`'s slot `i` holds once `spec`'s removals and adds are in. */
function heldAfter(mgr: CellManager, spec: Required<CellSpec>, i: number) {
	const cb = mgr.cells.get(spec.cell);
	const rows = Array.from({ length: cb?.count ?? 0 }, (_, k) => ({
		lng: cb!.positions[k * 2],
		lat: cb!.positions[k * 2 + 1],
		angle: cb!.angles[k],
	}));
	for (const r of spec.remove) {
		rows[r] = rows[rows.length - 1];
		rows.pop();
	}
	for (const a of spec.add) rows.push({ lng: a.lng, lat: a.lat, angle: a.angle ?? 0 });
	return rows[i] ?? { lng: 0, lat: 0, angle: 0 };
}

/**
 * Apply `d` to `mgr` as one patch frame. A frame restates a patched row in full, so a
 * patch field left null is filled from what `mgr` holds at that slot after the frame's
 * removals and adds.
 */
export function applyDelta(mgr: CellManager, d: Delta): FrameSummary {
	const { cells, at } = cellsOf(d.added, d.removed);
	for (const p of d.updated) {
		const spec = at(p.cell);
		const held = heldAfter(mgr, spec, p.cellIndex);
		spec.patch.push({
			key: p.cellIndex,
			lng: p.lng ?? held.lng,
			lat: p.lat ?? held.lat,
			angle: p.heading ?? held.angle,
			sel: p.sel?.idx,
		});
	}
	const palette = paletteOf([...d.added.map((e) => e.sel), ...d.updated.map((p) => p.sel)]);
	return mgr.apply(frame({ palette, cells: [...cells.values()] }));
}

/** Encode a selection section the way Rust's `assemble_selection_bitmask` does. */
export function selectionSection(colors: RGB[], cellEntries: SelCellEntry[]): Uint8Array {
	const out: number[] = [];
	const u32 = (v: number) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24);
	u32(colors.length);
	for (const c of colors) out.push(...c);
	out.push(cellEntries.length);
	for (const e of cellEntries) {
		out.push(e.cellChar.charCodeAt(0));
		u32(e.locCount);
		for (const s of e.sels) {
			if (s.kind === "idx") {
				out.push(1);
				u32(s.indices.length);
				for (const i of s.indices) u32(i);
			} else {
				out.push(0);
				for (let b = 0; b < Math.ceil(e.locCount / 8); b++) out.push(s.mask[b] ?? 0);
			}
		}
	}
	return new Uint8Array(out);
}

/** Restate `mgr`'s selections from per-cell membership, as a selection-only frame does. */
export function applySelections(
	mgr: CellManager,
	colors: RGB[],
	cellEntries: SelCellEntry[],
): SelectedIds {
	mgr.apply(frame({ palette: colors, selection: selectionSection(colors, cellEntries) }));
	return mgr.selectedIds();
}
