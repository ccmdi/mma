import type { Pano } from "@/bindings.gen";

/** Pano ids outside the official and `F:` collections are a base64url-encoded binary
 *  `ImageKey` in their own right: `{1: varint frontend, 2: string id}`, the only two
 *  protobuf fields this module writes. */
const KEY_FRONTEND = 0x08;
const KEY_ID = 0x12;

function varint(value: number): number[] {
	const out: number[] = [];
	for (let v = value; ; v >>>= 7) {
		out.push(v < 0x80 ? v : (v & 0x7f) | 0x80);
		if (v < 0x80) return out;
	}
}

const OFFICIAL_PANO_RE = /^[-_A-Za-z0-9]{21}[AQgw]$/;

export function isOfficialPano(panoId: string): boolean {
	if (panoId.startsWith("F:")) return false;
	return OFFICIAL_PANO_RE.test(panoId);
}

/** Newest official pano in a capture timeline, or null if it holds none. Timelines from
 *  `svMetadata` are sorted ascending by date, so "newest" is the last official entry -
 *  scanning backwards rather than indexing keeps that assumption in one place. */
export function newestOfficialPano<T extends { pano: string }>(time: readonly T[]): T | null {
	return time.findLast((t) => isOfficialPano(t.pano)) ?? null;
}

/** Heuristic: a user-uploaded pano, by id length or attribution. Both attribution texts are
 *  searched: a user photo can carry a place description as well as its "Photo by" line. */
export function isUnofficial(p: Pano): boolean {
	if (!p.pano) return false;
	if (p.pano.length > 22) return true;
	return /photo by|user[- ]uploaded/i.test(`${p.shortDescription} ${p.copyright}`);
}

/** Protobuf `ImageKey` [frontend, id] -> pano ID string. */
export function imageKeyToPanoId(key: unknown[]): string {
	if (!key || !key[1]) return "";
	const type = (key[0] as number) ?? 2;
	const id = key[1] as string;
	if (type === 2 || type === 0) return id;
	if (type === 3) return `F:${id}`;
	// Other types (e.g. 10 = USER_UPLOADED): binary protobuf ImageKey, web-safe base64 with
	// Google's "." padding -- the exact string the Maps JS API reports for the same pano.
	const utf8 = new TextEncoder().encode(id);
	const encoded = [KEY_FRONTEND, ...varint(type), KEY_ID, ...varint(utf8.length), ...utf8];
	// Spreading into fromCharCode blows the argument limit on a long id.
	let bin = "";
	for (const byte of encoded) bin += String.fromCharCode(byte);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, ".");
}

/** The capture history to show for a pano: its own stack merged with the stacks of the panos
 *  beside it, since a partly-official stack carries only part of the history. Entries are
 *  keyed by pano id and later sources win, so pass the pano itself last. */
export function mergeTimelines(sources: (Pano | null)[]): Pano["time"] {
	const merged = new Map<string, Pano["time"][number]>();
	for (const p of sources) for (const t of p?.time ?? []) merged.set(t.pano, t);
	return [...merged.values()];
}

/** True when nothing in the timeline is official coverage, so the multi-year history lives
 *  on official coverage nearby rather than on these panos. */
export function allUnofficial(time: Pano["time"]): boolean {
	return time.length > 0 && time.every((t) => !isOfficialPano(t.pano));
}
